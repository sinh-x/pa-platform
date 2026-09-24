import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;

const MAX_MATCHED_TEXT = 2_000;
const MAX_RECORD_BYTES = 16_384;
const MAX_IDENTIFIER = 256;
const MAX_STREAM_LINE = 8_192;
const AUDIT_FILE = "pi-redaction-audit.jsonl";
const warnedAuditSinks = new Set<string>();
const auditSinkIdentities = new Map<string, { dev: number; ino: number }>();

export type PiRedactionRuleId =
  | "configured-value"
  | "credential-shaped-text"
  | "credential-named-key"
  | "bearer"
  | "sk-value"
  | "reasoning-signature"
  | "encrypted-content";

export interface PiRedactionMatch {
  ruleId: PiRedactionRuleId;
  matchedText: string;
  originalLength: number;
  truncated: boolean;
}

export interface PiRedactionAuditRecord extends PiRedactionMatch {
  schemaVersion: 1;
  timestamp: string;
  deploymentId: string;
  surfaceId: string;
}

interface PiRedactionAuditOptions {
  append?: (path: string, line: string) => void;
  warn?: (warning: string) => void;
  now?: () => Date;
}

const TEXT_RULES: ReadonlyArray<{ ruleId: PiRedactionRuleId; pattern: RegExp }> = [
  { ruleId: "reasoning-signature", pattern: /thinking[_-]?signature["']?\s*(?::|=)\s*(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\S+)/gi },
  { ruleId: "encrypted-content", pattern: /encrypted[_-]?content["']?\s*(?::|=)\s*(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\S+)/gi },
  { ruleId: "credential-shaped-text", pattern: /(?:token|secret|password|api[_-]?key|authorization)\s*(?::|=|\s)\s*\S+/gi },
  { ruleId: "bearer", pattern: /bearer\s+\S+/gi },
  { ruleId: "sk-value", pattern: /sk-[\w-]+/gi },
];
const REASONING_KEY = /^thinking[_-]?signature$/i;
const ENCRYPTED_KEY = /^encrypted[_-]?content$/i;

/**
 * Pi diagnostics intentionally preserve their original content. Callers remain
 * responsible for applying the existing numeric bounds at their output seam.
 */
export function redactDiagnostic(value: string, _secrets: string[] = []): string {
  return value;
}

/**
 * Retained for interface compatibility while Pi-owned output filtering is
 * disabled. Collected values are not transformed by this package.
 */
export function environmentSecrets(env: NodeJS.ProcessEnv, configured: string[] = []): string[] {
  return [...new Set([
    ...configured,
    ...Object.entries(env)
      .filter(([key, value]) => SECRET_KEY.test(key) && value !== undefined && value.length >= 8)
      .map(([, value]) => value!),
  ])];
}

/** Evaluates the seven frozen pre-PAP-214 rule families without changing input. */
export function detectPiRedactionMatches(value: unknown, configured: readonly string[] = []): PiRedactionMatch[] {
  const matches: PiRedactionMatch[] = [];
  const activeConfigured = configured.filter(Boolean);
  if (typeof value === "string") {
    let structured: unknown;
    try { structured = JSON.parse(value) as unknown; } catch { /* Non-JSON diagnostics use the frozen text rules directly. */ }
    if (structured && typeof structured === "object") visitDetectorValue(structured, activeConfigured, matches, new Set<object>(), sensitiveReasoningValues(structured, activeConfigured));
    else detectText(value, activeConfigured, matches);
  } else {
    visitDetectorValue(value, activeConfigured, matches, new Set<object>(), sensitiveReasoningValues(value, activeConfigured));
  }
  return matches;
}

/** Best-effort deployment-local JSONL persistence for shadow detector matches. */
export class PiRedactionAudit {
  readonly path: string;
  private readonly append: (path: string, line: string) => void;
  private readonly warn: (warning: string) => void;
  private readonly now: () => Date;

  constructor(
    private readonly deploymentId: string,
    private readonly deploymentDir: string,
    options: PiRedactionAuditOptions = {},
  ) {
    this.path = resolve(deploymentDir, AUDIT_FILE);
    this.append = options.append ?? appendAuditLine;
    this.warn = options.warn ?? ((warning) => process.stderr.write(`${warning}\n`));
    this.now = options.now ?? (() => new Date());
  }

  observe(surfaceId: string, value: unknown, configured: readonly string[] = []): number {
    let matches: PiRedactionMatch[];
    try { matches = detectPiRedactionMatches(value, configured); }
    catch { this.warnOnce(); return 0; }
    for (const match of matches) this.persist(surfaceId, match);
    return matches.length;
  }

  recordMatch(surfaceId: string, match: PiRedactionMatch): void {
    this.persist(surfaceId, match);
  }

  private persist(surfaceId: string, match: PiRedactionMatch): void {
    try {
      const record = boundedAuditRecord({
        schemaVersion: 1,
        timestamp: this.now().toISOString(),
        deploymentId: boundedIdentifier(this.deploymentId),
        surfaceId: boundedIdentifier(surfaceId),
        ...match,
      });
      mkdirSync(this.deploymentDir, { recursive: true, mode: 0o700 });
      this.append(this.path, `${JSON.stringify(record)}\n`);
    } catch { this.warnOnce(); }
  }

  private warnOnce(): void {
    const sink = `${this.deploymentId}\u0000${this.path}`;
    if (warnedAuditSinks.has(sink)) return;
    warnedAuditSinks.add(sink);
    try { this.warn("Pi redaction audit persistence failed; original content was preserved and audit evidence may be incomplete.".slice(0, 2_000)); }
    catch { /* Warning delivery is also best-effort and is never observed. */ }
  }
}

/** Observes one Pi-owned value when deployment context is available in the environment. */
export function auditPiValueFromEnvironment(
  env: NodeJS.ProcessEnv,
  surfaceId: string,
  value: unknown,
  configured: readonly string[] = [],
): number {
  const deploymentId = env["PA_DEPLOYMENT_ID"]?.trim();
  const deploymentDir = env["PA_DEPLOYMENT_DIR"]?.trim();
  if (!deploymentId || !deploymentDir) return 0;
  return new PiRedactionAudit(deploymentId, deploymentDir).observe(surfaceId, value, environmentSecrets(env, [...configured]));
}

/** Collects arbitrary chunks while leaving delivery timing and bytes to the caller. */
export class StreamingPiRedactionAuditor {
  private line = "";
  private incremental = false;
  private readonly matchers: IncrementalRuleMatcher[];

  constructor(
    private readonly audit: PiRedactionAudit,
    private readonly surfaceId: string,
    private readonly configured: readonly string[] = [],
  ) {
    const emit = (match: PiRedactionMatch): void => this.audit.recordMatch(this.surfaceId, match);
    const shapedKeys = ["to" + "ken", "se" + "cret", "pass" + "word", "api_key", "api-key", "apikey", "author" + "ization"];
    this.matchers = [
      ...configured.filter(Boolean).map((value) => new LiteralStreamMatcher(value, emit)),
      new TokenRuleStreamMatcher("credential-shaped-text", shapedKeys, "credential", emit),
      new TokenRuleStreamMatcher("bearer", ["bearer"], "bearer", emit),
      new TokenRuleStreamMatcher("sk-value", ["sk-"], "sk", emit),
      new TokenRuleStreamMatcher("reasoning-signature", ["thinking_signature", "thinking-signature", "thinkingsignature"], "reasoning", emit),
      new TokenRuleStreamMatcher("encrypted-content", ["encrypted_content", "encrypted-content", "encryptedcontent"], "reasoning", emit),
      new TokenRuleStreamMatcher("credential-named-key", shapedKeys.map((key) => `"${key}"`), "json", emit),
    ];
  }

  /** Number of characters retained by the auditor, excluding caller-owned input chunks. */
  get bufferedCharacterCount(): number {
    return this.line.length + this.matchers.reduce((total, matcher) => total + matcher.bufferedCharacterCount, 0);
  }

  push(chunk: string): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      this.pushLinePart(chunk.slice(offset, end));
      if (newline < 0) return;
      if (this.incremental) {
        this.pushIncremental("\n");
        for (const matcher of this.matchers) matcher.flush();
        this.resetIncremental();
      } else {
        this.audit.observe(this.surfaceId, `${this.line}\n`, this.configured);
        this.line = "";
      }
      offset = newline + 1;
    }
  }

  flush(): void {
    if (this.incremental) {
      for (const matcher of this.matchers) matcher.flush();
      this.resetIncremental();
    } else if (this.line) {
      this.audit.observe(this.surfaceId, this.line, this.configured);
      this.line = "";
    }
  }

  private pushLinePart(part: string): void {
    if (!part) return;
    if (this.incremental) {
      this.pushIncremental(part);
      return;
    }
    const available = MAX_STREAM_LINE - this.line.length;
    if (part.length <= available) {
      this.line += part;
      return;
    }
    this.incremental = true;
    this.pushIncremental(this.line);
    this.line = "";
    this.pushIncremental(part);
  }

  private pushIncremental(value: string): void {
    for (const matcher of this.matchers) matcher.push(value);
  }

  private resetIncremental(): void {
    for (const matcher of this.matchers) matcher.reset();
    this.incremental = false;
    this.line = "";
  }
}

interface IncrementalRuleMatcher {
  readonly bufferedCharacterCount: number;
  push(value: string): void;
  flush(): void;
  reset(): void;
}

class MatchCapture {
  private text = "";
  private length = 0;

  get bufferedCharacterCount(): number { return this.text.length; }

  append(value: string): void {
    this.length += value.length;
    if (this.text.length < MAX_MATCHED_TEXT) this.text += value.slice(0, MAX_MATCHED_TEXT - this.text.length);
  }

  match(ruleId: PiRedactionRuleId): PiRedactionMatch {
    return { ruleId, matchedText: this.text, originalLength: this.length, truncated: this.length > MAX_MATCHED_TEXT };
  }
}

class LiteralStreamMatcher implements IncrementalRuleMatcher {
  private tail = "";

  constructor(private readonly literal: string, private readonly emit: (match: PiRedactionMatch) => void) {}

  get bufferedCharacterCount(): number { return this.tail.length; }

  push(value: string): void {
    for (const character of value) {
      this.tail += character;
      while (this.tail && !this.literal.startsWith(this.tail)) this.tail = this.tail.slice(1);
      if (this.tail === this.literal) {
        this.emit(toMatch("configured-value", this.literal));
        this.tail = "";
      }
    }
  }

  flush(): void { this.tail = ""; }
  reset(): void { this.tail = ""; }
}

type TokenRuleKind = "credential" | "bearer" | "sk" | "reasoning" | "json";
type TokenRuleState = "prefix" | "after-key" | "spacing" | "after-delimiter" | "value" | "quoted-value";

class TokenRuleStreamMatcher implements IncrementalRuleMatcher {
  private candidate = "";
  private state: TokenRuleState = "prefix";
  private capture: MatchCapture | undefined;
  private quote = "";
  private escaped = false;

  constructor(
    private readonly ruleId: PiRedactionRuleId,
    private readonly keywords: readonly string[],
    private readonly kind: TokenRuleKind,
    private readonly emit: (match: PiRedactionMatch) => void,
  ) {}

  get bufferedCharacterCount(): number {
    return this.candidate.length + (this.capture?.bufferedCharacterCount ?? 0);
  }

  push(value: string): void {
    for (const character of value) this.consume(character);
  }

  flush(): void {
    if (this.capture && (this.state === "value" || this.state === "quoted-value")) this.finish();
    this.reset();
  }

  reset(): void {
    this.candidate = "";
    this.state = "prefix";
    this.capture = undefined;
    this.quote = "";
    this.escaped = false;
  }

  private consume(character: string): void {
    let reprocess = true;
    while (reprocess) {
      reprocess = false;
      if (this.state === "prefix") {
        this.consumePrefix(character);
      } else if (this.state === "after-key") {
        if (this.kind === "sk") {
          if (isWordOrHyphen(character)) { this.capture!.append(character); this.state = "value"; }
          else { this.abandon(); reprocess = true; }
        } else if (this.kind === "bearer") {
          if (isWhitespace(character)) { this.capture!.append(character); this.state = "spacing"; }
          else { this.abandon(); reprocess = true; }
        } else if (this.kind === "credential" || this.kind === "json") {
          if (isWhitespace(character)) { this.capture!.append(character); this.state = "spacing"; }
          else if (character === ":" || (this.kind === "credential" && character === "=")) { this.capture!.append(character); this.state = "after-delimiter"; }
          else { this.abandon(); reprocess = true; }
        } else if (character === "\"" || character === "'") {
          this.capture!.append(character);
          this.state = "spacing";
        } else {
          this.state = "spacing";
          reprocess = true;
        }
      } else if (this.state === "spacing") {
        if (this.kind === "reasoning" || this.kind === "json") {
          if (isWhitespace(character)) this.capture!.append(character);
          else if (character === ":" || (this.kind === "reasoning" && character === "=")) { this.capture!.append(character); this.state = "after-delimiter"; }
          else { this.abandon(); reprocess = true; }
        } else if (isWhitespace(character)) {
          this.capture!.append(character);
        } else if (this.kind === "credential" && (character === ":" || character === "=")) {
          this.capture!.append(character);
          this.state = "after-delimiter";
        } else {
          this.capture!.append(character);
          this.state = "value";
        }
      } else if (this.state === "after-delimiter") {
        if (isWhitespace(character)) this.capture!.append(character);
        else if ((this.kind === "reasoning" || this.kind === "json") && (character === "\"" || character === "'")) {
          this.capture!.append(character);
          this.quote = character;
          this.state = "quoted-value";
        } else {
          this.capture!.append(character);
          this.state = "value";
        }
      } else if (this.state === "value") {
        const continues = this.kind === "sk" ? isWordOrHyphen(character) : !isWhitespace(character);
        if (continues) this.capture!.append(character);
        else { this.finish(); reprocess = true; }
      } else if (this.state === "quoted-value") {
        this.capture!.append(character);
        if (this.escaped) this.escaped = false;
        else if (character === "\\") this.escaped = true;
        else if (character === this.quote) this.finish();
      }
    }
  }

  private consumePrefix(character: string): void {
    this.candidate += character;
    while (this.candidate && !this.keywords.some((keyword) => keyword.startsWith(this.candidate.toLowerCase()))) this.candidate = this.candidate.slice(1);
    if (!this.keywords.includes(this.candidate.toLowerCase())) return;
    this.capture = new MatchCapture();
    this.capture.append(this.candidate);
    this.candidate = "";
    this.state = "after-key";
  }

  private finish(): void {
    if (this.capture) this.emit(this.capture.match(this.ruleId));
    this.capture = undefined;
    this.state = "prefix";
    this.quote = "";
    this.escaped = false;
  }

  private abandon(): void {
    this.capture = undefined;
    this.state = "prefix";
    this.quote = "";
    this.escaped = false;
  }
}

function isWhitespace(value: string): boolean { return /\s/u.test(value); }
function isWordOrHyphen(value: string): boolean { return /[\w-]/u.test(value); }

/** Streams Pi output unchanged across arbitrary callback boundaries. */
export class StreamingRedactor {
  constructor(
    _secrets: string[],
    private readonly write: (value: string) => void,
    _redactValue?: (value: string) => string,
    _sensitiveMarker?: RegExp,
  ) {}

  push(chunk: string): void {
    if (chunk) this.write(chunk);
  }

  flush(): void {}
}

function visitDetectorValue(
  value: unknown,
  configured: readonly string[],
  matches: PiRedactionMatch[],
  seen: Set<object>,
  reasoningValues: ReadonlyArray<{ ruleId: "reasoning-signature" | "encrypted-content"; value: string }>,
): void {
  if (typeof value === "string") {
    detectText(value, configured, matches, reasoningValues);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitDetectorValue(item, configured, matches, seen, reasoningValues);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (REASONING_KEY.test(key)) {
      matches.push(toMatch("reasoning-signature", structuredMatchText(key, item)));
    } else if (ENCRYPTED_KEY.test(key)) {
      matches.push(toMatch("encrypted-content", structuredMatchText(key, item)));
    } else if (SECRET_KEY.test(key)) {
      matches.push(toMatch("credential-named-key", structuredMatchText(key, item)));
    } else {
      visitDetectorValue(item, configured, matches, seen, reasoningValues);
    }
  }
}

function detectText(
  value: string,
  configured: readonly string[],
  matches: PiRedactionMatch[],
  reasoningValues: ReadonlyArray<{ ruleId: "reasoning-signature" | "encrypted-content"; value: string }> = [],
): void {
  for (const secret of configured) {
    let index = value.indexOf(secret);
    while (index >= 0) {
      matches.push(toMatch("configured-value", secret));
      index = value.indexOf(secret, index + secret.length);
    }
  }
  for (const reasoning of reasoningValues) {
    let index = value.indexOf(reasoning.value);
    while (index >= 0) {
      matches.push(toMatch(reasoning.ruleId, reasoning.value));
      index = value.indexOf(reasoning.value, index + reasoning.value.length);
    }
  }
  for (const rule of TEXT_RULES) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(value); match; match = rule.pattern.exec(value)) {
      matches.push(toMatch(rule.ruleId, match[0]));
    }
    rule.pattern.lastIndex = 0;
  }
}

function sensitiveReasoningValues(
  value: unknown,
  configured: readonly string[],
  seen = new Set<object>(),
): Array<{ ruleId: "reasoning-signature" | "encrypted-content"; value: string }> {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => sensitiveReasoningValues(item, configured, seen));
  const found: Array<{ ruleId: "reasoning-signature" | "encrypted-content"; value: string }> = [];
  for (const [key, item] of Object.entries(value)) {
    const ruleId = REASONING_KEY.test(key) ? "reasoning-signature" as const : ENCRYPTED_KEY.test(key) ? "encrypted-content" as const : undefined;
    if (ruleId) {
      for (const text of stringValues(item)) if (text && !configured.includes(text) && !found.some((entry) => entry.value === text)) found.push({ ruleId, value: text });
    } else {
      for (const entry of sensitiveReasoningValues(item, configured, seen)) if (!found.some((candidate) => candidate.value === entry.value)) found.push(entry);
    }
  }
  return found;
}

function stringValues(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => stringValues(item, seen));
  return Object.values(value).flatMap((item) => stringValues(item, seen));
}

function structuredMatchText(key: string, value: unknown): string {
  try {
    const serialized = JSON.stringify({ [key]: value });
    return serialized === undefined ? `${key}:${String(value)}` : serialized.slice(1, -1);
  } catch {
    return `${key}:[unserializable]`;
  }
}

function toMatch(ruleId: PiRedactionRuleId, matchedText: string): PiRedactionMatch {
  return {
    ruleId,
    matchedText: matchedText.slice(0, MAX_MATCHED_TEXT),
    originalLength: matchedText.length,
    truncated: matchedText.length > MAX_MATCHED_TEXT,
  };
}

function boundedAuditRecord(record: PiRedactionAuditRecord): PiRedactionAuditRecord {
  if (Buffer.byteLength(`${JSON.stringify(record)}\n`) <= MAX_RECORD_BYTES) return record;
  let low = 0;
  let high = record.matchedText.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...record, matchedText: record.matchedText.slice(0, middle), truncated: true };
    if (Buffer.byteLength(`${JSON.stringify(candidate)}\n`) <= MAX_RECORD_BYTES) low = middle;
    else high = middle - 1;
  }
  return { ...record, matchedText: record.matchedText.slice(0, low), truncated: true };
}

function boundedIdentifier(value: string): string {
  return value.slice(0, MAX_IDENTIFIER);
}

function appendAuditLine(path: string, line: string): void {
  const descriptor = openAuditDescriptor(path);
  try {
    const identity = validateAuditDescriptor(path, descriptor);
    auditSinkIdentities.set(path, identity);
    fchmodSync(descriptor, 0o600);
    validateAuditDescriptor(path, descriptor, true);
    writeFileSync(descriptor, line, { encoding: "utf8" });
    validateAuditDescriptor(path, descriptor, true);
  } finally {
    closeSync(descriptor);
  }
}

function openAuditDescriptor(path: string): number {
  const expected = auditSinkIdentities.get(path);
  if (expected) {
    let pathStat;
    try { pathStat = lstatSync(path); }
    catch { throw new Error("audit path disappeared after first append"); }
    if (pathStat.dev !== expected.dev || pathStat.ino !== expected.ino) throw new Error("audit path identity changed after first append");
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("no-follow audit append is unavailable");
  const common = fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow | fsConstants.O_NONBLOCK;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return openSync(path, common | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (code === "ENOENT") continue;
        throw error;
      }
    }
    const pathStat = lstatSync(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1) throw new Error("audit path is not a single-link regular file");
    try {
      return openSync(path, common);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error("audit path changed during open");
}

function validateAuditDescriptor(path: string, descriptor: number, requireMode = false): { dev: number; ino: number } {
  const descriptorStat = fstatSync(descriptor);
  if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) throw new Error("audit descriptor is not a single-link regular file");
  if (requireMode && (descriptorStat.mode & 0o777) !== 0o600) throw new Error("audit descriptor mode is not 0600");
  const pathStat = lstatSync(path);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 || pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    throw new Error("audit path was replaced during append");
  }
  const expected = auditSinkIdentities.get(path);
  if (expected && (expected.dev !== descriptorStat.dev || expected.ino !== descriptorStat.ino)) throw new Error("audit descriptor identity changed after first append");
  return { dev: descriptorStat.dev, ino: descriptorStat.ino };
}
