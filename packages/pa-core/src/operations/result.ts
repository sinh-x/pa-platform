import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { findSensitiveMatch, loadSensitivePatterns } from "../sensitive-patterns.js";

export const OPERATION_RESULT_VERSION = "pa-operation-result/v1" as const;
export const MAX_OPERATION_RESULT_BYTES = 64 * 1024;
export const MAX_OPERATION_TEXT_BYTES = 50 * 1024;
export const MAX_OPERATION_TEXT_LINES = 2000;
export type OperationCompletion = "completed" | "cancelled" | "timed-out" | "error";
export type OperationOutcome = "passed" | "failed" | "warning" | "unknown" | "skipped";
export interface OperationEvidence {
  owner: string;
  ref: string;
  version: string | null;
  sha256: string | null;
  freshness: "current" | "stale" | "unverified";
  scope: string;
}
export interface OperationFinding {
  code: string;
  severity: "info" | "minor" | "major" | "critical";
  explanation: string;
  correctionOwner: string;
  nextAction: string;
}
export interface OperationProcess {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  cleanup: "settled" | "unknown" | "not-applicable";
}
export type OperationJson = null | boolean | number | string | OperationJson[] | { [key: string]: OperationJson };
export interface OperationResult {
  schemaVersion: typeof OPERATION_RESULT_VERSION;
  operationId: string;
  kind: string;
  observedAt: string;
  scope: { source: string; inputSha256: string | null; description: string };
  completion: OperationCompletion;
  outcome: OperationOutcome;
  enforcement: "allowed" | "denied";
  capability: "available" | "unavailable";
  /** Policy's requirement for THIS observation, not permission or acceptance. */
  required: boolean;
  findings: OperationFinding[];
  process: OperationProcess | null;
  evidence: OperationEvidence[];
  output: { text: string; truncated: boolean; fullEvidenceRef: OperationEvidence | null };
  payload: { kind: "inline"; value: OperationJson } | { kind: "reference"; evidence: OperationEvidence } | null;
}
export type OperationResultErrorCode = "OPERATION_RESULT_JSON" | "OPERATION_RESULT_UTF8" | "OPERATION_RESULT_SIZE" | "OPERATION_RESULT_FIELD" | "OPERATION_RESULT_INVARIANT" | "OPERATION_RESULT_SENSITIVE" | "OPERATION_REDACTION_UNAVAILABLE" | "OPERATION_OUTPUT_REFERENCE_REQUIRED";
export class OperationResultError extends Error {
  constructor(readonly code: OperationResultErrorCode) {
    // Never echo rejected bytes, keys, paths or underlying exception messages.
    super(`Operation result rejected: ${code}. Correct this operation's observation; unrelated safe operations remain available.`);
    this.name = "OperationResultError";
  }
}
const reject = (code: OperationResultErrorCode = "OPERATION_RESULT_FIELD"): never => { throw new OperationResultError(code); };
const SHA = /^[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;
const INVALID_UNICODE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
type Row = Record<string, unknown>;
function row(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
  const r = value as Row;
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key))) return reject();
  return r;
}
function text(value: unknown, max = 4096, multiline = false): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || INVALID_UNICODE.test(value)
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\p{Cc}\p{Cf}]/u).test(value)) return reject();
  if (!multiline && (!value.length || value !== value.trim())) return reject();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) return reject();
  return value as T;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") return reject(); return value; }
function digest(value: unknown): string | null { if (value === null) return null; const s = text(value, 64); if (!SHA.test(s)) return reject(); return s; }
function list<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 128) return reject();
  return value.map(parse);
}
function evidence(value: unknown): OperationEvidence {
  const r = row(value, ["owner", "ref", "version", "sha256", "freshness", "scope"]);
  const result: OperationEvidence = { owner: text(r.owner, 128), ref: text(r.ref, 2048), version: r.version === null ? null : text(r.version, 128),
    sha256: digest(r.sha256), freshness: choice(r.freshness, ["current", "stale", "unverified"]), scope: text(r.scope, 2048) };
  if (result.freshness !== "unverified" && result.sha256 === null) reject("OPERATION_RESULT_INVARIANT");
  return result;
}
function finding(value: unknown): OperationFinding {
  const r = row(value, ["code", "severity", "explanation", "correctionOwner", "nextAction"]);
  const code = text(r.code, 128); if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(code)) return reject();
  return { code, severity: choice(r.severity, ["info", "minor", "major", "critical"]), explanation: text(r.explanation), correctionOwner: text(r.correctionOwner, 128), nextAction: text(r.nextAction) };
}
function processFacts(value: unknown): OperationProcess | null {
  if (value === null) return null;
  const r = row(value, ["exitCode", "signal", "timedOut", "aborted", "cleanup"]);
  if (r.exitCode !== null && (!Number.isSafeInteger(r.exitCode) || Number(r.exitCode) < 0 || Number(r.exitCode) > 2_147_483_647)) return reject();
  const signal = r.signal === null ? null : text(r.signal, 32);
  if (signal !== null && !/^SIG[A-Z0-9]+$/.test(signal)) return reject();
  if (r.exitCode !== null && signal !== null) return reject("OPERATION_RESULT_INVARIANT");
  return { exitCode: r.exitCode as number | null, signal, timedOut: bool(r.timedOut), aborted: bool(r.aborted), cleanup: choice(r.cleanup, ["settled", "unknown", "not-applicable"]) };
}
/** Data-only snapshot: no getters, toJSON, prototypes, symbols, cycles, lossy
 * values or unbounded object graphs. This is NOT authentication of observations. */
function snapshot(value: unknown): OperationJson {
  let budget = 1024 * 1024;
  const visit = (v: unknown, depth: number): OperationJson => {
    if (depth > 64 || --budget < 0) return reject("OPERATION_RESULT_SIZE");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) return reject(); return v; }
    if (typeof v === "string") {
      budget -= Buffer.byteLength(v); if (budget < 0) return reject("OPERATION_RESULT_SIZE");
      if (INVALID_UNICODE.test(v)) return reject("OPERATION_RESULT_UTF8");
      return v;
    }
    if (!v || typeof v !== "object" || (!Array.isArray(v) && ![null, Object.prototype].includes(Object.getPrototypeOf(v)))) return reject();
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(v).some(key => typeof key !== "string")) return reject();
    if (Array.isArray(v)) {
      if (v.length > 65536 || Object.keys(descriptors).length !== v.length + 1) return reject();
      return Array.from({ length: v.length }, (_, i) => {
        const d = descriptors[String(i)]; if (!d || !("value" in d)) return reject(); return visit(d.value, depth + 1);
      });
    }
    const result: { [key: string]: OperationJson } = Object.create(null);
    for (const [key, d] of Object.entries(descriptors)) {
      if (!("value" in d) || !d.enumerable || INVALID_UNICODE.test(key)) return reject();
      budget -= Buffer.byteLength(key); if (budget < 0) return reject("OPERATION_RESULT_SIZE");
      result[key] = visit(d.value, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}
function sensitive(value: unknown): void {
  let patterns: ReturnType<typeof loadSensitivePatterns>;
  try { patterns = loadSensitivePatterns(); } catch { return reject("OPERATION_REDACTION_UNAVAILABLE"); }
  const visit = (v: unknown): void => {
    if (typeof v === "string" && findSensitiveMatch("content", v, patterns)) reject("OPERATION_RESULT_SENSITIVE");
    if (v && typeof v === "object") for (const [key, item] of Object.entries(v)) { visit(key); visit(item); }
  };
  visit(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function validate(value: unknown): OperationResult {
  const r = row(value, ["schemaVersion", "operationId", "kind", "observedAt", "scope", "completion", "outcome", "enforcement", "capability", "required", "findings", "process", "evidence", "output", "payload"]);
  if (r.schemaVersion !== OPERATION_RESULT_VERSION) return reject();
  const operationId = text(r.operationId, 256), kind = text(r.kind, 256); if (!ID.test(operationId) || !ID.test(kind)) return reject();
  const observedAt = text(r.observedAt, 32);
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) return reject();
  const s = row(r.scope, ["source", "inputSha256", "description"]), o = row(r.output, ["text", "truncated", "fullEvidenceRef"]);
  const output: OperationResult["output"] = { text: text(o.text, MAX_OPERATION_TEXT_BYTES, true), truncated: bool(o.truncated), fullEvidenceRef: o.fullEvidenceRef === null ? null : evidence(o.fullEvidenceRef) };
  if (output.text.split("\n").length > MAX_OPERATION_TEXT_LINES) reject("OPERATION_RESULT_SIZE");
  if (output.truncated && output.fullEvidenceRef === null) reject("OPERATION_OUTPUT_REFERENCE_REQUIRED");
  let payload: OperationResult["payload"] = null;
  if (r.payload !== null) {
    const p = row(r.payload, (r.payload as Row)?.kind === "inline" ? ["kind", "value"] : ["kind", "evidence"]);
    if (p.kind === "inline") payload = { kind: "inline", value: snapshot(p.value) };
    else if (p.kind === "reference") payload = { kind: "reference", evidence: evidence(p.evidence) };
    else return reject();
  }
  const result: OperationResult = { schemaVersion: OPERATION_RESULT_VERSION, operationId, kind, observedAt,
    scope: { source: text(s.source, 2048), inputSha256: digest(s.inputSha256), description: text(s.description) },
    completion: choice(r.completion, ["completed", "cancelled", "timed-out", "error"]), outcome: choice(r.outcome, ["passed", "failed", "warning", "unknown", "skipped"]),
    enforcement: choice(r.enforcement, ["allowed", "denied"]), capability: choice(r.capability, ["available", "unavailable"]), required: bool(r.required),
    findings: list(r.findings, finding), process: processFacts(r.process), evidence: list(r.evidence, evidence), output, payload };
  const p = result.process;
  if ((p?.aborted && result.completion !== "cancelled") || (p?.timedOut && !["timed-out", "cancelled"].includes(result.completion))) reject("OPERATION_RESULT_INVARIANT");
  const incompleteProcess = p !== null && (p.exitCode === null || p.signal !== null || p.timedOut || p.aborted || p.cleanup === "unknown");
  if (result.outcome === "passed" && (result.completion !== "completed" || result.enforcement !== "allowed" || result.capability !== "available"
    || incompleteProcess || (p && p.exitCode !== 0) || !result.evidence.some(e => e.scope === result.scope.source && e.freshness === "current"))) reject("OPERATION_RESULT_INVARIANT");
  if ((result.outcome !== "passed" || result.enforcement === "denied" || result.capability === "unavailable" || result.completion !== "completed") && !result.findings.length) reject("OPERATION_RESULT_INVARIANT");
  sensitive(result);
  return freeze(result);
}
/** Validate a bounded transport envelope. Shape/digest strings never mint native
 * facts, human approval, freshness, resource ownership or operation permission. */
export function parseOperationResult(input: string | Uint8Array): OperationResult {
  if (typeof input === "string" && INVALID_UNICODE.test(input)) return reject("OPERATION_RESULT_UTF8");
  if ((typeof input === "string" ? Buffer.byteLength(input) : input.byteLength) > MAX_OPERATION_RESULT_BYTES) return reject("OPERATION_RESULT_SIZE");
  let value: unknown;
  try { value = parseReviewEvidenceJson(typeof input === "string" ? Buffer.from(input) : input, "operation-result"); }
  catch { return reject("OPERATION_RESULT_JSON"); }
  return validate(value);
}
/** No publication, ledger or automatic result import. Oversized payloads must be
 * published/referenced by their EXISTING owner, not silently dropped here. */
export function serializeOperationResult(result: OperationResult): string {
  const encoded = JSON.stringify(validate(snapshot(result)));
  if (Buffer.byteLength(encoded) > MAX_OPERATION_RESULT_BYTES) return reject("OPERATION_RESULT_SIZE");
  return encoded;
}
/** Bound already-redacted public output without splitting Unicode scalars or
 * JSON. Complete raw evidence remains with its authorized existing owner. */
export function boundOperationOutput(redactedText: string, fullEvidenceRef: OperationEvidence | null): OperationResult["output"] {
  if (INVALID_UNICODE.test(redactedText)) return reject("OPERATION_RESULT_UTF8");
  let bytes = 2, lines = 1, end = 0;
  for (const character of redactedText) {
    const nextBytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + nextBytes > MAX_OPERATION_TEXT_BYTES || (character === "\n" && lines === MAX_OPERATION_TEXT_LINES)) break;
    bytes += nextBytes; if (character === "\n") lines++; end += character.length;
  }
  const truncated = end < redactedText.length;
  if (truncated && fullEvidenceRef === null) return reject("OPERATION_OUTPUT_REFERENCE_REQUIRED");
  return { text: redactedText.slice(0, end), truncated, fullEvidenceRef };
}
/** Wrapper exit, never a replacement for the child's actual exit/signal. */
export function operationExitCode(result: OperationResult): number {
  const r = parseOperationResult(serializeOperationResult(result)), p = r.process;
  if (r.enforcement === "denied") return 3;
  if (r.completion === "cancelled") return 130;
  if (r.completion === "timed-out") return 124;
  if (r.completion === "error" || r.capability === "unavailable" || (p && (p.cleanup === "unknown" || p.exitCode === null || p.signal !== null))) return 2;
  if (r.outcome === "unknown" || r.outcome === "skipped") return r.required ? 2 : 0;
  if (r.outcome === "failed" || (p && p.exitCode !== 0)) return 1;
  return 0;
}
/** Domain failure/denial/cancellation remains inspectable data. Hosts reserve
 * isError/throws for invocation errors, not a completed failing check. */
export function operationNativeIsError(result: OperationResult): boolean {
  return parseOperationResult(serializeOperationResult(result)).completion === "error";
}
