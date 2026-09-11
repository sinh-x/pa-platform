export interface SafetyPatterns {
  destructiveCommands: string[];
  blockedFilePatterns: string[];
}

export const PA_SAFETY_PATTERNS: SafetyPatterns = {
  destructiveCommands: [
    String.raw`\brm\b`, String.raw`\brmdir\b`, String.raw`\bunlink\b`, String.raw`\bshred\b`,
    String.raw`\bdd\b`, String.raw`\btruncate\b`, String.raw`\bfind\b.*\b-delete\b`,
    String.raw`\bfind\b.*\b-exec\b.*\brm\b`, String.raw`\bxargs\b.*\brm\b`,
    String.raw`\bgit\s+clean\b.*-f`, String.raw`\bgit\s+push\b.*--force`,
    // Block pathname overwrite/truncation while allowing descriptor duplication and closure.
    String.raw`(?:^|[^>])(?:\d*)>(?:>|[:|])\s*\S`,
    String.raw`(?:^|[^\d>])\d+>\s*(?!(?:&(?:\d+|-)|\d+|-)(?:$|[\s;&|()]))\S`,
    String.raw`(?:^|[^\d>])>\s*(?!(?:&(?:\d+|-)|-)(?:$|[\s;&|()]))\S`,
  ],
  blockedFilePatterns: [
    String.raw`(^|[\\/])\.env(\.|$)`, String.raw`(^|[\\/])\.ssh[\\/]id_`, String.raw`credentials`,
    String.raw`secrets?.*\.(json|ya?ml)$`, String.raw`[-_]token\.json$`, String.raw`[-_]api[-_]?key\.json$`,
    String.raw`(^|[\\/])\.netrc$`, String.raw`(^|[\\/])\.npmrc$`, String.raw`(^|[\\/])\.pypirc$`,
  ],
};

export function isDestructiveCommand(command: string): boolean {
  return matches(maskQuotedMarkup(command), PA_SAFETY_PATTERNS.destructiveCommands);
}

export function isBlockedFilePath(filePath: string): boolean {
  return matches(filePath, PA_SAFETY_PATTERNS.blockedFilePatterns);
}

const QUOTED_MARKUP = /<\/?[A-Za-z][A-Za-z0-9:_-]*>/g;
const SHELL_COMMAND_PAYLOAD = /(?:^|[\s;&|()])(?:[^\s;&|()]+\/)?(?:ba|da|z)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*(?:\s+--)?\s*$/;

/** Mask only complete tag-like markup inside shell quotes before redirect matching. */
function maskQuotedMarkup(command: string): string {
  let masked = "";
  let copiedThrough = 0;
  let quoteStart = -1;
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (!quote) {
      if (character === "'" || character === '"') {
        quote = character;
        quoteStart = index;
      }
      continue;
    }

    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if (character !== quote) continue;

    const quotedContent = command.slice(quoteStart + 1, index);
    const shellPayload = SHELL_COMMAND_PAYLOAD.test(command.slice(0, quoteStart));
    masked += command.slice(copiedThrough, quoteStart + 1);
    masked += shellPayload
      ? maskQuotedMarkup(quotedContent)
      : quotedContent.replace(QUOTED_MARKUP, (markup) => `${markup.slice(0, -1)} `);
    masked += quote;
    copiedThrough = index + 1;
    quote = undefined;
  }

  return masked + command.slice(copiedThrough);
}

function matches(value: string, patterns: string[]): boolean {
  if (!value) return false;
  return patterns.some((pattern) => {
    try { return new RegExp(pattern, "i").test(value); } catch { return false; }
  });
}
