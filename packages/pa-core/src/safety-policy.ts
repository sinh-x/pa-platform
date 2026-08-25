export interface SafetyPatterns {
  destructiveCommands: string[];
  blockedFilePatterns: string[];
}

export const PA_SAFETY_PATTERNS: SafetyPatterns = {
  destructiveCommands: [
    String.raw`\brm\b`, String.raw`\brmdir\b`, String.raw`\bunlink\b`, String.raw`\bshred\b`,
    String.raw`\bdd\b`, String.raw`\btruncate\b`, String.raw`\bfind\b.*\b-delete\b`,
    String.raw`\bfind\b.*\b-exec\b.*\brm\b`, String.raw`\bxargs\b.*\brm\b`,
    String.raw`\bgit\s+clean\b.*-f`, String.raw`\bgit\s+push\b.*--force`, String.raw`[^>]\s*>:?\s*\S`,
  ],
  blockedFilePatterns: [
    String.raw`(^|[\\/])\.env(\.|$)`, String.raw`(^|[\\/])\.ssh[\\/]id_`, String.raw`credentials`,
    String.raw`secrets?.*\.(json|ya?ml)$`, String.raw`[-_]token\.json$`, String.raw`[-_]api[-_]?key\.json$`,
    String.raw`(^|[\\/])\.netrc$`, String.raw`(^|[\\/])\.npmrc$`, String.raw`(^|[\\/])\.pypirc$`,
  ],
};

export function isDestructiveCommand(command: string): boolean {
  return matches(command, PA_SAFETY_PATTERNS.destructiveCommands);
}

export function isBlockedFilePath(filePath: string): boolean {
  return matches(filePath, PA_SAFETY_PATTERNS.blockedFilePatterns);
}

function matches(value: string, patterns: string[]): boolean {
  if (!value) return false;
  return patterns.some((pattern) => {
    try { return new RegExp(pattern, "i").test(value); } catch { return false; }
  });
}
