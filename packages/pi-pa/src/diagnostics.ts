import { closeSync, fchmodSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;

const MAX_MATCHED_TEXT = 2_000;
const MAX_RECORD_BYTES = 16_384;
const MAX_IDENTIFIER = 256;
const AUDIT_FILE = "pi-redaction-audit.jsonl";
const warnedAuditSinks = new Set<string>();

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
  private carry = "";

  constructor(
    private readonly audit: PiRedactionAudit,
    private readonly surfaceId: string,
    private readonly configured: readonly string[] = [],
  ) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.carry += chunk;
    const lines = this.carry.split("\n");
    this.carry = lines.pop() ?? "";
    for (const line of lines) this.audit.observe(this.surfaceId, `${line}\n`, this.configured);
  }

  flush(): void {
    if (this.carry) this.audit.observe(this.surfaceId, this.carry, this.configured);
    this.carry = "";
  }
}

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
  const descriptor = openSync(path, "a", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, line, { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}
