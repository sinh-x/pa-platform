import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

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
    String.raw`(^|[\\/])pa-repository-mutation\.(?:lease|borrower)\.json$`,
    String.raw`(^|[\\/])repository-dirty-borrow\.approval\.json$`, String.raw`(^|[\\/])pi-repository-handoff\.json$`,
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

export type SafetyEffect = "none" | "read" | "write" | "delete";
export type SafetyDecisionCode =
  | "allowed"
  | "protected-path"
  | "direct-deletion"
  | "destructive-command"
  | "arbitrary-output"
  | "ambiguous-output"
  | "path-traversal"
  | "symlink-escape";

export interface SafetyDecision {
  allowed: boolean;
  code: SafetyDecisionCode;
  effect: SafetyEffect;
  reason?: string;
  target?: string;
  guidance?: string;
}

export type SafetyPolicyInput =
  | { kind: "prose"; value: string }
  | { kind: "path"; value: string }
  | { kind: "shell"; value: string };

export interface SafetyPolicyOptions {
  cwd?: string;
  env?: Pick<NodeJS.ProcessEnv, "TMPDIR">;
  trashExecutable?: string;
}

const ALLOWED: SafetyDecision = { allowed: true, code: "allowed", effect: "none" };
const BASIC_DELETE_COMMAND = /(?:^|[\s;&|()'"])(?:command\s+|sudo\s+)*(rm|rmdir|unlink|shred)\b/gi;
const OTHER_DELETE_COMMANDS = [
  /(?:^|[\s;&|()])dd(?:\s|$)/i,
  /(?:^|[\s;&|()])truncate(?:\s|$)/i,
  /(?:^|[\s;&|()])find\b[^\n;]*\s-delete(?:\s|$)/i,
  /(?:^|[\s;&|()])find\b[^\n;]*\s-exec\b[^\n;]*\brm\b/i,
  /(?:^|[\s;&|()])xargs\b[^\n;]*\brm\b/i,
  /(?:^|[\s;&|()])git\s+clean\b[^\n;]*-[A-Za-z]*f/i,
];
const FORCE_PUSH = /(?:^|[\s;&|()])git\s+push\b[^\n;]*--force(?:-with-lease)?\b/i;
const DYNAMIC_TARGET = /[$`*?\[\]{}]/;

interface ShellWord {
  raw: string;
  value: string;
  operator: boolean;
}

interface OutputOperand {
  target?: string;
  rawTarget?: string;
  descriptor: boolean;
  end?: number;
}

interface TempRoot {
  lexical: string;
  resolved: string;
}

/** Evaluate a value according to its declared semantic context. */
export function evaluateSafetyPolicy(input: SafetyPolicyInput, options: SafetyPolicyOptions = {}): SafetyDecision {
  if (input.kind === "prose") return ALLOWED;
  if (input.kind === "path") return classifyPathOperand(input.value);
  return classifyShellCommand(input.value, options);
}

/** Classify a value already identified as a path-bearing field or operand. */
export function classifyPathOperand(filePath: string): SafetyDecision {
  if (!filePath || !isBlockedFilePath(filePath)) return { ...ALLOWED, effect: "read" };
  return deny("protected-path", "read", `Protected path access is not allowed: ${filePath}`, filePath);
}

/**
 * Classify bounded shell effects without treating quoted program text or
 * non-shell here-document bodies as path operands.
 */
export function classifyShellCommand(command: string, options: SafetyPolicyOptions = {}): SafetyDecision {
  if (!command) return ALLOWED;
  const sources = collectShellSources(command);
  let hasOutput = false;

  for (const source of sources) {
    const deletion = classifyDeletion(source, options.trashExecutable ?? "pa");
    if (deletion) return deletion;
    if (FORCE_PUSH.test(source)) {
      return deny("destructive-command", "write", "Force-pushing is not allowed by PA safety policy.");
    }

    const protectedPath = findProtectedShellPath(source);
    if (protectedPath) {
      return deny("protected-path", "read", `Protected path access is not allowed: ${protectedPath}`, protectedPath);
    }

    for (const output of [...scanRedirects(source), ...scanCurlOutputs(source)]) {
      if (output.descriptor) continue;
      hasOutput = true;
      if (!output.target) {
        return deny("ambiguous-output", "write", "Output target is missing or uses an unsupported ambiguous shell form.");
      }
      const outputDecision = classifyOutputTarget(output.target, options);
      if (!outputDecision.allowed) return outputDecision;
    }
  }

  return { ...ALLOWED, effect: hasOutput ? "write" : "read" };
}

/** Classify one explicit output target against the null sink and verified system-temp roots. */
export function classifyOutputTarget(target: string, options: SafetyPolicyOptions = {}): SafetyDecision {
  const envTmpdir = options.env ? options.env.TMPDIR : process.env.TMPDIR;
  const expanded = expandTmpdirTarget(target, envTmpdir);
  if (!expanded) {
    return deny("ambiguous-output", "write", `Output target is dynamic or ambiguous: ${target}`, target);
  }
  if (expanded === "/dev/null") return { ...ALLOWED, effect: "write", target };
  if (isBlockedFilePath(expanded)) {
    return deny("protected-path", "write", `Protected output path is not allowed: ${target}`, target);
  }
  if (hasTraversal(expanded)) {
    return deny("path-traversal", "write", `Output target contains a traversal segment: ${target}`, target);
  }
  if (DYNAMIC_TARGET.test(expanded) || expanded.includes("\0")) {
    return deny("ambiguous-output", "write", `Output target is dynamic or ambiguous: ${target}`, target);
  }

  const cwd = options.cwd ?? process.cwd();
  if (!isAbsolute(cwd)) {
    return deny("ambiguous-output", "write", `Working directory is not absolute: ${cwd}`, target);
  }
  const absoluteTarget = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const roots = resolveTempRoots(envTmpdir);
  const lexicalRoot = roots.find((root) => isWithin(root.lexical, absoluteTarget));
  if (!lexicalRoot) {
    return deny("arbitrary-output", "write", `Output is allowed only for /dev/null or a verified system-temp target: ${target}`, target);
  }

  const nearest = resolveNearestExisting(absoluteTarget);
  if (!nearest) {
    return deny("ambiguous-output", "write", `Output target boundary could not be verified: ${target}`, target);
  }
  const resolvedTarget = resolve(nearest.resolved, nearest.suffix);
  if (!isWithin(lexicalRoot.resolved, resolvedTarget)) {
    return deny("symlink-escape", "write", `Output target escapes its verified system-temp root through a symlink: ${target}`, target);
  }
  return { ...ALLOWED, effect: "write", target };
}

/** Render a complete reversible alternative for a denied deletion. */
export function formatTrashMoveGuidance(target: string, executable = "pa"): string {
  const safeExecutable = /^[A-Za-z0-9_./-]+$/.test(executable) ? executable : shellQuote(executable);
  const targetOperand = preserveOrQuoteShellOperand(target);
  return `${safeExecutable} trash move ${targetOperand} --reason 'Replace direct deletion denied by PA safety policy' --yes`;
}

function classifyDeletion(source: string, executable: string): SafetyDecision | undefined {
  BASIC_DELETE_COMMAND.lastIndex = 0;
  const basic = BASIC_DELETE_COMMAND.exec(source);
  if (basic) {
    const target = extractBasicDeletionTarget(source.slice(BASIC_DELETE_COMMAND.lastIndex)) ?? "<target>";
    return {
      ...deny("direct-deletion", "delete", `Direct deletion is not allowed: ${basic[1]} ${target}`, target),
      guidance: formatTrashMoveGuidance(target, executable),
    };
  }
  if (OTHER_DELETE_COMMANDS.some((pattern) => pattern.test(source))) {
    const target = extractOtherDeletionTarget(source) ?? "<target>";
    return {
      ...deny("direct-deletion", "delete", `Direct deletion is not allowed for target ${target}`, target),
      guidance: formatTrashMoveGuidance(target, executable),
    };
  }
  return undefined;
}

function extractBasicDeletionTarget(remainder: string): string | undefined {
  let cursor = 0;
  while (cursor < remainder.length) {
    while (/\s/.test(remainder[cursor] ?? "")) cursor += 1;
    if (remainder.startsWith("--", cursor) && /\s/.test(remainder[cursor + 2] ?? "")) {
      cursor += 2;
      while (/\s/.test(remainder[cursor] ?? "")) cursor += 1;
      break;
    }
    if (remainder[cursor] !== "-") break;
    while (cursor < remainder.length && !/\s/.test(remainder[cursor] ?? "")) cursor += 1;
  }
  if (cursor >= remainder.length || /[;&|()<>]/.test(remainder[cursor] ?? "")) return undefined;
  const quote = remainder[cursor];
  if (quote === "'" || quote === '"') {
    const end = quotedEnd(remainder, cursor, quote);
    return end < remainder.length ? remainder.slice(cursor, end + 1) : undefined;
  }
  let end = cursor;
  while (end < remainder.length && !/[\s;&|()<>]/.test(remainder[end] ?? "")) end += 1;
  return remainder.slice(cursor, end) || undefined;
}

function extractOtherDeletionTarget(source: string): string | undefined {
  const ddOutput = /(?:^|\s)of=("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(source)?.[1];
  if (ddOutput) return ddOutput;
  const truncate = /(?:^|[;&|]\s*)truncate\b([^;|\n]*)/i.exec(source)?.[1];
  if (truncate) {
    const operands = tokenizeShell(truncate).filter((word) => !word.operator && !word.value.startsWith("-"));
    return operands.at(-1)?.raw;
  }
  return /(?:^|[;&|]\s*)find\s+("[^"]+"|'[^']+'|[^\s;&|]+)/i.exec(source)?.[1];
}

function findProtectedShellPath(source: string): string | undefined {
  for (const word of tokenizeShell(source)) {
    if (word.operator || !looksLikePathOperand(word.value)) continue;
    if (isBlockedFilePath(word.value)) return word.raw;
  }
  return undefined;
}

function looksLikePathOperand(value: string): boolean {
  if (!value || /\s/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  return value.includes("/")
    || value.includes("\\")
    || value.startsWith(".")
    || value.startsWith("~")
    || value.startsWith("$HOME")
    || /\.(?:json|ya?ml|env|netrc|npmrc|pypirc)$/i.test(value);
}

function scanRedirects(source: string): OutputOperand[] {
  const outputs: OutputOperand[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'" || character === '"') {
      index = quotedEnd(source, index, character);
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character !== ">") continue;

    let cursor = index + 1;
    if (source[cursor] === ">" || source[cursor] === "|") cursor += 1;
    let descriptorPrefix = false;
    if (source[cursor] === "&") {
      descriptorPrefix = true;
      cursor += 1;
    }
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    const operand = readShellOperand(source, cursor);
    let descriptorOwner = index - 1;
    while (descriptorOwner >= 0 && /\d/.test(source[descriptorOwner] ?? "")) descriptorOwner -= 1;
    const hasDescriptorPrefix = descriptorOwner < index - 1
      && (descriptorOwner < 0 || /[\s;&|()]/.test(source[descriptorOwner] ?? ""));
    const descriptor = (descriptorPrefix || hasDescriptorPrefix || operand.target === "-")
      && /^(?:\d+|-)$/.test(operand.target ?? "");
    outputs.push({ ...operand, descriptor });
    if (operand.end !== undefined) index = Math.max(index, operand.end - 1);
  }
  return outputs;
}

function scanCurlOutputs(source: string): OutputOperand[] {
  const words = tokenizeShell(source);
  const outputs: OutputOperand[] = [];
  for (let index = 0; index < words.length; index += 1) {
    if (words[index]?.operator || basename(words[index]?.value ?? "") !== "curl") continue;
    for (let cursor = index + 1; cursor < words.length && !isCommandBoundary(words[cursor]); cursor += 1) {
      const word = words[cursor];
      if (!word || word.operator) continue;
      if (word.value === "-o" || word.value === "--output") {
        const target = words[cursor + 1];
        outputs.push(target && !target.operator
          ? { target: target.value, rawTarget: target.raw, descriptor: false }
          : { descriptor: false });
        cursor += 1;
      } else if (word.value.startsWith("--output=")) {
        const target = word.value.slice("--output=".length);
        outputs.push({ target: target || undefined, rawTarget: word.raw, descriptor: false });
      }
    }
  }
  return outputs;
}

function isCommandBoundary(word: ShellWord | undefined): boolean {
  return Boolean(word?.operator && /^(?:;|\||&&)$/.test(word.value));
}

function readShellOperand(source: string, start: number): OutputOperand {
  if (start >= source.length) return { descriptor: false };
  const quote = source[start];
  if (quote === "'" || quote === '"') {
    const end = quotedEnd(source, start, quote);
    if (end >= source.length || source[end] !== quote) return { descriptor: false, end };
    return {
      target: source.slice(start + 1, end),
      rawTarget: source.slice(start, end + 1),
      descriptor: false,
      end: end + 1,
    };
  }
  let end = start;
  while (end < source.length && !/[\s;|()<>]/.test(source[end] ?? "")) end += 1;
  const rawTarget = source.slice(start, end);
  return { target: rawTarget || undefined, rawTarget, descriptor: false, end };
}

function tokenizeShell(source: string): ShellWord[] {
  const words: ShellWord[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index] ?? "")) {
      index += 1;
      continue;
    }
    if (/[;&|()<>]/.test(source[index] ?? "")) {
      const start = index;
      const character = source[index];
      index += 1;
      if ((character === "&" || character === "|") && source[index] === character) index += 1;
      words.push({ raw: source.slice(start, index), value: source.slice(start, index), operator: true });
      continue;
    }

    const start = index;
    let value = "";
    while (index < source.length && !/\s|[;&|()<>]/.test(source[index] ?? "")) {
      const character = source[index];
      if (character === "'" || character === '"') {
        const end = quotedEnd(source, index, character);
        value += source.slice(index + 1, end);
        index = end < source.length ? end + 1 : end;
      } else if (character === "\\" && index + 1 < source.length) {
        value += source[index + 1];
        index += 2;
      } else {
        value += character;
        index += 1;
      }
    }
    words.push({ raw: source.slice(start, index), value, operator: false });
  }
  return words;
}

function quotedEnd(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (quote === '"' && source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index;
  }
  return source.length;
}

function collectShellSources(command: string, depth = 0): string[] {
  if (depth > 3) return [command];
  const { visible, shellBodies } = extractHereDocuments(command);
  const sources = [visible];
  for (const body of shellBodies) sources.push(...collectShellSources(body, depth + 1));

  const words = tokenizeShell(visible);
  for (let index = 0; index < words.length - 2; index += 1) {
    const shell = words[index];
    if (shell.operator || !/^(?:(?:ba|da|z)?sh)$/.test(basename(shell.value))) continue;
    for (let cursor = index + 1; cursor < words.length && !isCommandBoundary(words[cursor]); cursor += 1) {
      if (!words[cursor].operator && /^-[A-Za-z]*c[A-Za-z]*$/.test(words[cursor].value)) {
        const payload = words[cursor + 1];
        if (payload && !payload.operator) sources.push(...collectShellSources(payload.value, depth + 1));
        break;
      }
    }
  }
  return sources;
}

function extractHereDocuments(command: string): { visible: string; shellBodies: string[] } {
  const lines = command.split("\n");
  const visible: string[] = [];
  const shellBodies: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    visible.push(line);
    const marker = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!marker) continue;
    const delimiter = marker[2] ?? "";
    const body: string[] = [];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").replace(/^\t+/, "") !== delimiter) {
      body.push(lines[index] ?? "");
      visible.push("");
      index += 1;
    }
    if (index < lines.length) visible.push(lines[index] ?? "");
    const launcher = line.slice(0, marker.index);
    if (/(?:^|[;&|]\s*)(?:[^\s;&|]+\/)?(?:ba|da|z)?sh(?:\s|$)/.test(launcher)) shellBodies.push(body.join("\n"));
  }
  return { visible: visible.join("\n"), shellBodies };
}

function expandTmpdirTarget(target: string, tmpdir: string | undefined): string | undefined {
  const match = /^(?:\$TMPDIR|\$\{TMPDIR\})(\/.*)?$/.exec(target);
  if (!match) return DYNAMIC_TARGET.test(target) ? undefined : target;
  if (!tmpdir || !isAbsolute(tmpdir) || hasTraversal(tmpdir)) return undefined;
  return `${tmpdir}${match[1] ?? ""}`;
}

function resolveTempRoots(tmpdir: string | undefined): TempRoot[] {
  const candidates = ["/tmp"];
  if (tmpdir && isAbsolute(tmpdir) && !hasTraversal(tmpdir)) candidates.push(tmpdir);
  const roots: TempRoot[] = [];
  for (const candidate of candidates) {
    try {
      const lexical = resolve(candidate);
      const resolvedRoot = realpathSync(lexical);
      if (!statSync(resolvedRoot).isDirectory()) continue;
      if (!roots.some((root) => root.lexical === lexical && root.resolved === resolvedRoot)) {
        roots.push({ lexical, resolved: resolvedRoot });
      }
    } catch {
      // An absent, inaccessible, or non-directory TMPDIR is not an allowed boundary.
    }
  }
  return roots;
}

function resolveNearestExisting(target: string): { resolved: string; suffix: string } | undefined {
  let cursor = target;
  for (;;) {
    try {
      lstatSync(cursor);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      cursor = parent;
      continue;
    }
    try {
      return { resolved: realpathSync(cursor), suffix: relative(cursor, target) };
    } catch {
      // A broken or inaccessible link is not a verifiable output boundary.
      return undefined;
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function hasTraversal(filePath: string): boolean {
  return filePath.split(/[\\/]+/).includes("..");
}

function preserveOrQuoteShellOperand(target: string): string {
  if (target === "<target>") return target;
  if ((target.startsWith("'") && target.endsWith("'")) || (target.startsWith('"') && target.endsWith('"'))) return target;
  if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(target)) return `"${target}"`;
  return shellQuote(target);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function deny(code: SafetyDecisionCode, effect: SafetyEffect, reason: string, target?: string): SafetyDecision {
  return { allowed: false, code, effect, reason, target };
}
