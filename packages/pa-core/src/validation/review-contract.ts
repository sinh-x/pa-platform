import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  MAX_OUTPUT_BYTES, MAX_TIMEOUT_SECONDS, MIN_OUTPUT_BYTES, MIN_TIMEOUT_SECONDS,
  ValidationPreflightError, type ValidationDiagnostic,
} from "./schema.js";

export const REVIEW_OBJECTIVE_SCHEMA_VERSION = "pa-review-objective/v1" as const;
export const REVIEW_MATRIX_SCHEMA_VERSION = "pa-review-matrix/v1" as const;
export const MAX_REVIEW_OBJECTIVE_BYTES = 65_536;
export const MAX_REVIEW_ARTIFACT_BYTES = 1_048_576;
export const MAX_REVIEW_COMMANDS = 1_000;
export const REVIEW_SOURCE_PREFIX = "requirements:agent-teams/requirements/artifacts/";
export const REVIEW_PROFILES = ["node-pnpm/v1", "npm-subprojects/v1", "non-node-nix/v1"] as const;
export const REVIEW_TOOLS = ["node", "npm", "pnpm", "corepack", "pi", "git", "bash", "nix"] as const;
export const REVIEW_ENVIRONMENT_BINDINGS = {
  PA_REPO: "worktreeRoot", PA_FEATURE_SHA: "featureSha", PA_MATRIX_SOURCE: "matrixSource",
  PA_MATRIX_AUTHORITY_SHA256: "matrixAuthoritySha256", PA_MATRIX_APPROVAL_EVIDENCE: "matrixApprovalEvidence",
  PATH: "trustedPath",
} as const;
export const REVIEW_LITERAL_ENVIRONMENT_NAMES = ["PA_TICKET_ID", "CI", "HOME", "LANG", "TZ"] as const;

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TICKET = /^(?=.{1,64}$)[A-Z][A-Z0-9]*-[0-9]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMENT = /^c-[0-9]{17}$/;
const TOOL_VERSION: Record<ReviewTool, RegExp> = {
  node: /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/,
  npm: /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/,
  pnpm: /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/,
  corepack: /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/,
  pi: /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/,
  git: /^git version [0-9]+\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9.-]+)?$/,
  bash: /^GNU bash, version [0-9]+\.[0-9]+\.[0-9]+[^\r\n]*$/,
  nix: /^nix \(Nix\) [0-9]+\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9.-]+)?$/,
};
const AUTHORIZATION = /^review-auth:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JSON_FIELDS = new Set([
  "schemaVersion", "ticket", "branch", "featureSha", "matrixSource", "matrixAuthoritySha256",
  "matrixApprovalEvidence", "reviewAuthorizationId", "prerequisiteEvidence", "source", "repository",
  "key", "root", "baseSha", "profile", "prerequisites", "kind", "os", "arch", "name", "version",
  "id", "environment", "binding", "literal", "commands", "command", "cwd", "timeoutSeconds",
  "maxOutputBytes", "commandCount", "outputs", "passCriteria", "completionPercent", "exitCode",
  "critical", "major", "minorRationaleRequired", "gateId", "installedRuntime", "binary",
  "packageName", "packageVersion", "sourceSha", "mergedConfigSha", "pap232Evidence", "pap235Evidence",
  ...Object.keys(REVIEW_ENVIRONMENT_BINDINGS), ...REVIEW_LITERAL_ENVIRONMENT_NAMES,
]);

type Row = Record<string, unknown>;
export type ReviewProfile = typeof REVIEW_PROFILES[number];
export type ReviewTool = typeof REVIEW_TOOLS[number];
export type ReviewEnvironmentBinding = typeof REVIEW_ENVIRONMENT_BINDINGS[keyof typeof REVIEW_ENVIRONMENT_BINDINGS];
export type ReviewPrerequisite =
  | { kind: "platform"; os: string; arch: string }
  | { kind: "tool"; name: ReviewTool; version: string }
  | { kind: "dependency"; root: string; name: string; version: string }
  | { kind: "operatorGate"; id: string; ticket: string };
export interface ReviewObjective {
  schemaVersion: typeof REVIEW_OBJECTIVE_SCHEMA_VERSION;
  ticket: string;
  branch: string;
  featureSha: string;
  matrixSource: string;
  matrixAuthoritySha256: string;
  matrixApprovalEvidence: string;
  reviewAuthorizationId: string;
  prerequisiteEvidence: Record<string, string>;
}
export interface ReviewRepository { key: string; root: string; baseSha: string; branch: string }
export interface ReviewCommand { id: string; command: string; cwd: string; timeoutSeconds: number; maxOutputBytes: number }
export interface ReviewPassCriteria {
  completionPercent: 100; exitCode: 0; critical: 0; major: 0; minorRationaleRequired: true;
}
export interface ReviewMatrix {
  schemaVersion: typeof REVIEW_MATRIX_SCHEMA_VERSION;
  source: string;
  repository: ReviewRepository;
  profile: ReviewProfile;
  prerequisites: ReviewPrerequisite[];
  environment: Record<string, { literal: string } | { binding: ReviewEnvironmentBinding }>;
  commands: ReviewCommand[];
  commandCount: number;
  outputs: string[];
  passCriteria: ReviewPassCriteria;
}
/** Values extracted from a durable comment by a read-only trusted adapter; not authentication by this module. */
export interface ReviewMatrixApproval {
  commentId: string; author: "sinh"; ticket: string; branch: string;
  matrixSource: string; matrixAuthoritySha256: string;
}
/** Static shape only. Store/package provenance and integration references must be authenticated at launch. */
export interface ReviewReadinessBinding {
  gateId: string; ticket: string; branch: string; featureSha: string;
  matrixSource: string; matrixAuthoritySha256: string;
  installedRuntime: { binary: string; packageName: string; packageVersion: string; sourceSha: string };
  mergedConfigSha: string; pap232Evidence: string; pap235Evidence: string;
}
export interface ReviewArtifactHeader {
  ticket: string; repositoryKey: string; repositoryRoot: string; approvedBaseSha: string;
  featureBranch: string; matrixAuthoritySha256: string; matrixApprovalEvidence: string;
}
export interface ReviewMatrixArtifact {
  source: string; authorityBytes: Uint8Array; digest: string; matrix: ReviewMatrix; header: ReviewArtifactHeader;
}
export type ReviewContractErrorCode =
  | "REVIEW_SIZE" | "REVIEW_UTF8" | "REVIEW_JSON" | "REVIEW_DUPLICATE_KEY" | "REVIEW_FIELD"
  | "REVIEW_VERSION" | "REVIEW_LEGACY_MIGRATION" | "REVIEW_SOURCE" | "REVIEW_IO"
  | "REVIEW_BOUNDARY" | "REVIEW_FENCE" | "REVIEW_BINDING" | "REVIEW_PROFILE" | "REVIEW_SENSITIVE";

export class ReviewContractError extends ValidationPreflightError {
  readonly code: ReviewContractErrorCode;
  /** Additional independent schema defects for observational preflight, never partial executable authority. */
  relatedErrors?: readonly ReviewContractError[];
  constructor(code: ReviewContractErrorCode, source: string, reason: string) {
    const diagnostic: ValidationDiagnostic = {
      condition: "protected review contract rejected", source, reason,
      correction: code === "REVIEW_LEGACY_MIGRATION"
        ? "Publish a new versioned requirements artifact and obtain durable approval of its exact source and raw digest; preserve historical artifacts and accounting."
        : "Provide the exact supported v1 field grammar and matching durable evidence; do not normalize or repair authority.",
      resumeAction: "Rerun observational preflight. Static compatibility is not launch authorization or a review-cap extension.",
    };
    super(diagnostic);
    this.name = "ReviewContractError";
    this.code = code;
    this.message = formatReviewContractDiagnostic(this);
  }
}
export function formatReviewContractDiagnostic(error: ReviewContractError): string {
  const d = error.diagnostic;
  return `Condition: ${d.condition}\nSource: ${d.source}\nReason: ${d.reason}\nCorrection: ${d.correction}\nResume Action: ${d.resumeAction}`;
}
function fail(code: ReviewContractErrorCode, path: string, reason: string): never {
  // Paths/reasons are schema-owned, never raw values, unknown keys, tokens or I/O error messages.
  throw new ReviewContractError(code, path, reason);
}
function text(input: string | Uint8Array, limit: number, path: string): string {
  const size = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (size > limit) fail("REVIEW_SIZE", path, `must not exceed ${limit} bytes`);
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("REVIEW_UTF8", path, "UTF-8 BOM is not supported; authority must not be normalized");
  if (typeof input === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) {
    fail("REVIEW_UTF8", path, "must not contain unpaired Unicode surrogates");
  }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail("REVIEW_UTF8", path, "must be valid UTF-8"); }
}

/** Bounded JSON reader: duplicate keys (including escaped equivalents) are rejected before object construction. */
function json(input: string | Uint8Array, limit: number, path: string): unknown {
  const s = text(input, limit, path);
  if (!s.trimStart().startsWith("{")) fail("REVIEW_LEGACY_MIGRATION", path, "requires one versioned JSON object, not legacy prose or Markdown");
  let p = 0;
  const ws = (): void => { while (/[\t\r\n ]/.test(s[p] ?? "!") && p < s.length) p++; };
  const malformed = (): never => fail("REVIEW_JSON", path, "contains malformed JSON or excessive nesting");
  const string = (): string => {
    const start = p++;
    while (p < s.length) {
      const c = s[p++];
      if (c === "\\") { p++; continue; }
      if (c === '"') {
        let value: unknown;
        try { value = JSON.parse(s.slice(start, p)); } catch { return malformed(); }
        if (typeof value !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return malformed();
        return value;
      }
    }
    return malformed();
  };
  const value = (depth: number, location: string): unknown => {
    if (depth > 64) return malformed();
    ws();
    if (s[p] === '"') return string();
    if (s[p] === "{") {
      p++; ws();
      const row: Row = Object.create(null) as Row;
      if (s[p] === "}") { p++; return row; }
      while (p < s.length) {
        ws(); if (s[p] !== '"') return malformed();
        const key = string(); ws();
        if (s[p++] !== ":") return malformed();
        const child = `${location}.${JSON_FIELDS.has(key) ? key : "fields"}`;
        const safeChild = child.length <= 256 ? child : `${path}.nestedFields`;
        if (Object.hasOwn(row, key)) fail("REVIEW_DUPLICATE_KEY", safeChild, "contains a duplicate JSON object key");
        row[key] = value(depth + 1, safeChild); ws();
        const end = s[p++];
        if (end === "}") return row;
        if (end !== ",") return malformed();
      }
      return malformed();
    }
    if (s[p] === "[") {
      p++; ws(); const values: unknown[] = [];
      if (s[p] === "]") { p++; return values; }
      while (p < s.length) {
        values.push(value(depth + 1, `${location}[${values.length}]`)); ws(); const end = s[p++];
        if (end === "]") return values;
        if (end !== ",") return malformed();
      }
      return malformed();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(s.slice(p))?.[0];
    if (!token) return malformed();
    p += token.length;
    return JSON.parse(token) as unknown;
  };
  const result = value(0, path); ws(); if (p !== s.length) return malformed();
  return result;
}
/** Existing evidence only; strict duplicate/UTF-8/bounds checks without initialization. */
export function parseReviewEvidenceJson(input: Uint8Array, source: string): unknown {
  return json(input, MAX_REVIEW_ARTIFACT_BYTES, source);
}
function object(input: unknown, path: string, keys?: readonly string[]): Row {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail("REVIEW_FIELD", path, "must be an object");
  const row = input as Row;
  if (keys) {
    for (const key of keys) if (!Object.hasOwn(row, key)) fail("REVIEW_FIELD", `${path}.${key}`, "required field is missing");
    if (Object.keys(row).some((key) => !keys.includes(key))) fail("REVIEW_FIELD", path, "contains an unknown field");
  }
  return row;
}
function str(input: unknown, path: string, pattern?: RegExp, max = 4096): string {
  if (typeof input !== "string" || input.length < 1 || input.length > max || input.includes("\0")) fail("REVIEW_FIELD", path, "must be a nonempty bounded string without NUL");
  if (input !== input.trim() || (pattern && !pattern.test(input))) fail("REVIEW_FIELD", path, "does not match the exact field grammar");
  return input;
}
function integer(input: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < min || (input as number) > max) fail("REVIEW_FIELD", path, `must be an integer in [${min},${max}]`);
  return input as number;
}
function literal<T extends string | number | boolean>(input: unknown, path: string, expected: T): T {
  if (input !== expected) fail("REVIEW_FIELD", path, "must equal the required contract literal");
  return expected;
}
function version(input: unknown, path: string, expected: string): void {
  if (input === undefined) fail("REVIEW_LEGACY_MIGRATION", path, "legacy unversioned authority requires explicit migration");
  if (input !== expected) fail("REVIEW_VERSION", path, "schema version is unsupported");
}
function relativePath(input: unknown, path: string): string {
  const s = str(input, path);
  if (s === ".") return s;
  if (isAbsolute(s) || s.includes("\\") || s.includes(":") || s.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("REVIEW_SOURCE", path, "must be one contained relative path without aliases or traversal");
  }
  return s;
}
function absolutePath(input: unknown, path: string): string {
  const s = str(input, path);
  if (!s.startsWith("/") || s.includes("\\") || resolve(s) !== s) fail("REVIEW_SOURCE", path, "must be an exact absolute path without aliases");
  return s;
}
function branch(input: unknown, path: string, ticket?: string): string {
  const s = str(input, path, undefined, 512);
  if (!/^feature\/[A-Z][A-Z0-9]*-[0-9]+-[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s)
    || s.includes("..") || s.includes("//") || s.endsWith("/") || s.split("/").some((part) => part.endsWith(".") || part.endsWith(".lock"))
    || (ticket !== undefined && !s.startsWith(`feature/${ticket}-`))) fail("REVIEW_FIELD", path, "must be an exact ticket-linked feature branch");
  return s;
}
export function parseReviewMatrixSource(input: unknown): string {
  return matrixSourceAt(input, "matrixSource");
}
function matrixSourceAt(input: unknown, path: string): string {
  const s = str(input, path, undefined, 2048);
  if (!s.startsWith("requirements:")) fail("REVIEW_LEGACY_MIGRATION", path, "bare or generic doc-ref sources are not protected requirements authority");
  if (!s.startsWith(REVIEW_SOURCE_PREFIX) || !s.endsWith(".md")) fail("REVIEW_SOURCE", path, "requires the exact requirements artifact prefix and Markdown extension");
  relativePath(s.slice("requirements:".length), path);
  return s;
}
export function parseReviewObjective(input: string | Uint8Array): ReviewObjective {
  const p = "objective";
  const r = object(json(input, MAX_REVIEW_OBJECTIVE_BYTES, p), p);
  version(r.schemaVersion, `${p}.schemaVersion`, REVIEW_OBJECTIVE_SCHEMA_VERSION);
  object(r, p, ["schemaVersion", "ticket", "branch", "featureSha", "matrixSource", "matrixAuthoritySha256", "matrixApprovalEvidence", "reviewAuthorizationId", "prerequisiteEvidence"]);
  const ticket = str(r.ticket, `${p}.ticket`, TICKET);
  const evidence = object(r.prerequisiteEvidence, `${p}.prerequisiteEvidence`);
  const prerequisiteEvidence: Record<string, string> = Object.create(null) as Record<string, string>;
  Object.entries(evidence).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).forEach(([key, v], index) => {
    str(key, `${p}.prerequisiteEvidence[${index}].id`, ID);
    prerequisiteEvidence[key] = str(v, `${p}.prerequisiteEvidence[${index}].commentId`, COMMENT);
  });
  return {
    schemaVersion: REVIEW_OBJECTIVE_SCHEMA_VERSION, ticket, branch: branch(r.branch, `${p}.branch`, ticket),
    featureSha: str(r.featureSha, `${p}.featureSha`, SHA), matrixSource: matrixSourceAt(r.matrixSource, `${p}.matrixSource`),
    matrixAuthoritySha256: str(r.matrixAuthoritySha256, `${p}.matrixAuthoritySha256`, DIGEST),
    matrixApprovalEvidence: str(r.matrixApprovalEvidence, `${p}.matrixApprovalEvidence`, COMMENT),
    reviewAuthorizationId: str(r.reviewAuthorizationId, `${p}.reviewAuthorizationId`, AUTHORIZATION), prerequisiteEvidence,
  };
}
/** Collect independent objective field defects; malformed JSON blocks all dependent checks. */
export function inspectReviewObjective(input: string | Uint8Array): { objective?: ReviewObjective; errors: ReviewContractError[] } {
  const errors: ReviewContractError[] = [];
  const check = (run: () => unknown): void => {
    try { run(); } catch (error) { if (error instanceof ReviewContractError) errors.push(error); else throw error; }
  };
  let row: Row | undefined;
  check(() => { row = object(json(input, MAX_REVIEW_OBJECTIVE_BYTES, "objective"), "objective"); });
  if (!row) return { errors };
  const r = row;
  check(() => version(r.schemaVersion, "objective.schemaVersion", REVIEW_OBJECTIVE_SCHEMA_VERSION));
  const fields = ["schemaVersion", "ticket", "branch", "featureSha", "matrixSource", "matrixAuthoritySha256", "matrixApprovalEvidence", "reviewAuthorizationId", "prerequisiteEvidence"];
  if (Object.keys(r).some((key) => !fields.includes(key))) check(() => fail("REVIEW_FIELD", "objective", "contains an unknown field"));
  check(() => str(r.ticket, "objective.ticket", TICKET));
  check(() => branch(r.branch, "objective.branch", typeof r.ticket === "string" && TICKET.test(r.ticket) ? r.ticket : undefined));
  check(() => str(r.featureSha, "objective.featureSha", SHA));
  check(() => matrixSourceAt(r.matrixSource, "objective.matrixSource"));
  check(() => str(r.matrixAuthoritySha256, "objective.matrixAuthoritySha256", DIGEST));
  check(() => str(r.matrixApprovalEvidence, "objective.matrixApprovalEvidence", COMMENT));
  check(() => str(r.reviewAuthorizationId, "objective.reviewAuthorizationId", AUTHORIZATION));
  check(() => {
    const evidence = object(r.prerequisiteEvidence, "objective.prerequisiteEvidence");
    Object.entries(evidence).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).forEach(([id, comment], index) => {
      check(() => str(id, `objective.prerequisiteEvidence[${index}].id`, ID));
      check(() => str(comment, `objective.prerequisiteEvidence[${index}].commentId`, COMMENT));
    });
  });
  return errors.length ? { errors } : { errors, objective: parseReviewObjective(input) };
}
function list(input: unknown, path: string, max = 1000): unknown[] {
  if (!Array.isArray(input) || input.length > max) fail("REVIEW_FIELD", path, `must be an array of at most ${max} entries`);
  return input;
}
export function parseReviewPrerequisite(input: unknown, index: number): ReviewPrerequisite {
  const p = `matrix.prerequisites[${index}]`; const r = object(input, p);
  switch (r.kind) {
    case "platform":
      object(r, p, ["kind", "os", "arch"]);
      return { kind: "platform", os: str(r.os, `${p}.os`, /^[a-z][a-z0-9-]*$/), arch: str(r.arch, `${p}.arch`, /^[a-z][a-z0-9-]*$/) };
    case "tool": {
      object(r, p, ["kind", "name", "version"]);
      if (!REVIEW_TOOLS.includes(r.name as ReviewTool)) fail("REVIEW_PROFILE", `${p}.name`, "tool is unsupported; no probe may be guessed");
      return { kind: "tool", name: r.name as ReviewTool, version: str(r.version, `${p}.version`, TOOL_VERSION[r.name as ReviewTool]) };
    }
    case "dependency":
      object(r, p, ["kind", "root", "name", "version"]);
      return { kind: "dependency", root: relativePath(r.root, `${p}.root`), name: str(r.name, `${p}.name`, /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/), version: str(r.version, `${p}.version`, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/) };
    case "operatorGate":
      object(r, p, ["kind", "id", "ticket"]);
      return { kind: "operatorGate", id: str(r.id, `${p}.id`, ID), ticket: str(r.ticket, `${p}.ticket`, TICKET) };
    default: return fail("REVIEW_PROFILE", `${p}.kind`, "prerequisite kind is unsupported");
  }
}
export function parseReviewMatrix(input: string | Uint8Array): ReviewMatrix {
  const p = "matrix"; const r = object(json(input, MAX_REVIEW_ARTIFACT_BYTES, p), p);
  version(r.schemaVersion, `${p}.schemaVersion`, REVIEW_MATRIX_SCHEMA_VERSION);
  object(r, p, ["schemaVersion", "source", "repository", "profile", "prerequisites", "environment", "commands", "commandCount", "outputs", "passCriteria"]);
  const source = matrixSourceAt(r.source, `${p}.source`);
  const repo = object(r.repository, `${p}.repository`, ["key", "root", "baseSha", "branch"]);
  const repository = { key: str(repo.key, `${p}.repository.key`, /^[a-z0-9][a-z0-9-]*$/), root: absolutePath(repo.root, `${p}.repository.root`), baseSha: str(repo.baseSha, `${p}.repository.baseSha`, SHA), branch: branch(repo.branch, `${p}.repository.branch`) };
  if (!REVIEW_PROFILES.includes(r.profile as ReviewProfile)) fail("REVIEW_PROFILE", `${p}.profile`, "profile version is unsupported");
  const profile = r.profile as ReviewProfile;
  const prerequisites = list(r.prerequisites, `${p}.prerequisites`).map(parseReviewPrerequisite);
  const identities = prerequisites.map((v) => v.kind === "tool" ? `tool:${v.name}` : v.kind === "dependency" ? `dependency:${v.root}:${v.name}` : v.kind === "operatorGate" ? `gate:${v.id}` : "platform");
  if (new Set(identities).size !== identities.length) fail("REVIEW_FIELD", `${p}.prerequisites`, "prerequisite identities must be unique");
  const tools = new Set(prerequisites.flatMap((v) => v.kind === "tool" ? [v.name] : []));
  const required: ReviewTool[] = profile === "node-pnpm/v1" ? ["node", "corepack", "pnpm"] : profile === "npm-subprojects/v1" ? ["node", "npm"] : ["nix"];
  if (!identities.includes("platform") || required.some((tool) => !tools.has(tool))) fail("REVIEW_PROFILE", `${p}.prerequisites`, "profile requires one platform and its declared exact tool versions");
  if (profile === "non-node-nix/v1" && prerequisites.some((v) => v.kind === "dependency" || (v.kind === "tool" && ["node", "corepack", "pnpm", "npm"].includes(v.name)))) fail("REVIEW_PROFILE", `${p}.prerequisites`, "non-Node profile must not invent Node dependencies or tool requirements");
  const envKeys = [...Object.keys(REVIEW_ENVIRONMENT_BINDINGS), ...REVIEW_LITERAL_ENVIRONMENT_NAMES];
  const env = object(r.environment, `${p}.environment`, envKeys);
  const environment: ReviewMatrix["environment"] = {};
  for (const [name, binding] of Object.entries(REVIEW_ENVIRONMENT_BINDINGS)) {
    const v = object(env[name], `${p}.environment.${name}`, ["binding"]);
    environment[name] = { binding: literal(v.binding, `${p}.environment.${name}.binding`, binding) };
  }
  for (const name of REVIEW_LITERAL_ENVIRONMENT_NAMES) {
    const v = object(env[name], `${p}.environment.${name}`, ["literal"]);
    environment[name] = { literal: str(v.literal, `${p}.environment.${name}.literal`) };
  }
  str((environment.PA_TICKET_ID as { literal: string }).literal, `${p}.environment.PA_TICKET_ID.literal`, TICKET);
  const commands = list(r.commands, `${p}.commands`, MAX_REVIEW_COMMANDS).map((v, i): ReviewCommand => {
    const cp = `${p}.commands[${i}]`; const c = object(v, cp, ["id", "command", "cwd", "timeoutSeconds", "maxOutputBytes"]);
    // Shell bytes are opaque: preserve whitespace and inline assignments; never infer extra launcher variables.
    if (typeof c.command !== "string" || !c.command.trim() || c.command.includes("\0") || c.command.includes("review-auth:")) fail("REVIEW_FIELD", `${cp}.command`, "must be nonempty shell text without NUL or protected review authorization");
    return { id: str(c.id, `${cp}.id`, ID), command: c.command, cwd: relativePath(c.cwd, `${cp}.cwd`), timeoutSeconds: integer(c.timeoutSeconds, `${cp}.timeoutSeconds`, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS), maxOutputBytes: integer(c.maxOutputBytes, `${cp}.maxOutputBytes`, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES) };
  });
  if (!commands.length || new Set(commands.map((c) => c.id)).size !== commands.length) fail("REVIEW_FIELD", `${p}.commands`, "requires 1–1000 commands with unique ordered IDs");
  const commandCount = integer(r.commandCount, `${p}.commandCount`, 1, MAX_REVIEW_COMMANDS);
  if (commandCount !== commands.length) fail("REVIEW_FIELD", `${p}.commandCount`, "must equal the complete ordered command array length");
  const outputs = list(r.outputs, `${p}.outputs`).map((v, i) => str(v, `${p}.outputs[${i}]`));
  if (outputs.length !== commands.length || outputs.some((v, i) => !v.startsWith(`${commands[i]!.id}: `) || v.length <= commands[i]!.id.length + 2)) fail("REVIEW_FIELD", `${p}.outputs`, "requires one nonempty output description per ordered command ID");
  const pc = object(r.passCriteria, `${p}.passCriteria`, ["completionPercent", "exitCode", "critical", "major", "minorRationaleRequired"]);
  const passCriteria: ReviewPassCriteria = { completionPercent: literal(pc.completionPercent, `${p}.passCriteria.completionPercent`, 100), exitCode: literal(pc.exitCode, `${p}.passCriteria.exitCode`, 0), critical: literal(pc.critical, `${p}.passCriteria.critical`, 0), major: literal(pc.major, `${p}.passCriteria.major`, 0), minorRationaleRequired: literal(pc.minorRationaleRequired, `${p}.passCriteria.minorRationaleRequired`, true) };
  return { schemaVersion: REVIEW_MATRIX_SCHEMA_VERSION, source, repository, profile, prerequisites, environment, commands, commandCount, outputs, passCriteria };
}

/** Collect safely independent matrix fields. The fail-first parser remains the sole executable output. */
export function inspectReviewMatrix(input: string | Uint8Array): ReviewContractError[] {
  const errors: ReviewContractError[] = [];
  const check = (run: () => unknown): void => {
    try { run(); } catch (error) { if (error instanceof ReviewContractError) errors.push(error); else throw error; }
  };
  let row: Row | undefined;
  check(() => { row = object(json(input, MAX_REVIEW_ARTIFACT_BYTES, "matrix"), "matrix"); });
  if (!row) return errors;
  const r = row;
  check(() => version(r.schemaVersion, "matrix.schemaVersion", REVIEW_MATRIX_SCHEMA_VERSION));
  const keys = ["schemaVersion", "source", "repository", "profile", "prerequisites", "environment", "commands", "commandCount", "outputs", "passCriteria"];
  if (Object.keys(r).some((key) => !keys.includes(key))) check(() => fail("REVIEW_FIELD", "matrix", "contains an unknown field"));
  check(() => matrixSourceAt(r.source, "matrix.source"));
  check(() => {
    const repo = object(r.repository, "matrix.repository", ["key", "root", "baseSha", "branch"]);
    check(() => str(repo.key, "matrix.repository.key", /^[a-z0-9][a-z0-9-]*$/));
    check(() => absolutePath(repo.root, "matrix.repository.root"));
    check(() => str(repo.baseSha, "matrix.repository.baseSha", SHA));
    check(() => branch(repo.branch, "matrix.repository.branch"));
  });
  check(() => { if (!REVIEW_PROFILES.includes(r.profile as ReviewProfile)) fail("REVIEW_PROFILE", "matrix.profile", "profile version is unsupported"); });
  check(() => list(r.prerequisites, "matrix.prerequisites").forEach((p, index) => check(() => parseReviewPrerequisite(p, index))));
  check(() => {
    const env = object(r.environment, "matrix.environment");
    const names = [...Object.keys(REVIEW_ENVIRONMENT_BINDINGS), ...REVIEW_LITERAL_ENVIRONMENT_NAMES];
    if (Object.keys(env).some((key) => !names.includes(key))) check(() => fail("REVIEW_FIELD", "matrix.environment", "contains an unknown field"));
    for (const [name, binding] of Object.entries(REVIEW_ENVIRONMENT_BINDINGS)) check(() => {
      const value = object(env[name], `matrix.environment.${name}`, ["binding"]);
      literal(value.binding, `matrix.environment.${name}.binding`, binding);
    });
    for (const name of REVIEW_LITERAL_ENVIRONMENT_NAMES) check(() => {
      const value = object(env[name], `matrix.environment.${name}`, ["literal"]);
      str(value.literal, `matrix.environment.${name}.literal`, name === "PA_TICKET_ID" ? TICKET : undefined);
    });
  });
  check(() => list(r.commands, "matrix.commands", MAX_REVIEW_COMMANDS).forEach((input, index) => check(() => {
    const path = `matrix.commands[${index}]`;
    const c = object(input, path, ["id", "command", "cwd", "timeoutSeconds", "maxOutputBytes"]);
    check(() => str(c.id, `${path}.id`, ID));
    check(() => { if (typeof c.command !== "string" || !c.command.trim() || c.command.includes("\0") || c.command.includes("review-auth:")) fail("REVIEW_FIELD", `${path}.command`, "must be nonempty shell text without NUL or protected review authorization"); });
    check(() => relativePath(c.cwd, `${path}.cwd`));
    check(() => integer(c.timeoutSeconds, `${path}.timeoutSeconds`, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS));
    check(() => integer(c.maxOutputBytes, `${path}.maxOutputBytes`, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES));
  })));
  check(() => integer(r.commandCount, "matrix.commandCount", 1, MAX_REVIEW_COMMANDS));
  check(() => list(r.outputs, "matrix.outputs").forEach((output, index) => check(() => str(output, `matrix.outputs[${index}]`))));
  check(() => {
    const pc = object(r.passCriteria, "matrix.passCriteria", ["completionPercent", "exitCode", "critical", "major", "minorRationaleRequired"]);
    for (const [name, expected] of Object.entries({ completionPercent: 100, exitCode: 0, critical: 0, major: 0, minorRationaleRequired: true })) check(() => literal(pc[name], `matrix.passCriteria.${name}`, expected));
  });
  // Cross-field/profile/count uniqueness checks require the complete parsed fields.
  if (!errors.length) check(() => parseReviewMatrix(input));
  return errors;
}

export function parseReviewReadinessBinding(input: string | Uint8Array): ReviewReadinessBinding {
  const p = "readiness"; const r = object(json(input, MAX_REVIEW_OBJECTIVE_BYTES, p), p, ["gateId", "ticket", "branch", "featureSha", "matrixSource", "matrixAuthoritySha256", "installedRuntime", "mergedConfigSha", "pap232Evidence", "pap235Evidence"]);
  const ticket = str(r.ticket, `${p}.ticket`, TICKET);
  const runtime = object(r.installedRuntime, `${p}.installedRuntime`, ["binary", "packageName", "packageVersion", "sourceSha"]);
  const binary = absolutePath(runtime.binary, `${p}.installedRuntime.binary`);
  if (!/^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/ppa$/.test(binary)) fail("REVIEW_FIELD", `${p}.installedRuntime.binary`, "requires an exact installed PPA store binary, not a version label");
  return { gateId: str(r.gateId, `${p}.gateId`, ID), ticket, branch: branch(r.branch, `${p}.branch`, ticket), featureSha: str(r.featureSha, `${p}.featureSha`, SHA), matrixSource: matrixSourceAt(r.matrixSource, `${p}.matrixSource`), matrixAuthoritySha256: str(r.matrixAuthoritySha256, `${p}.matrixAuthoritySha256`, DIGEST), installedRuntime: { binary, packageName: str(runtime.packageName, `${p}.installedRuntime.packageName`, ID), packageVersion: str(runtime.packageVersion, `${p}.installedRuntime.packageVersion`), sourceSha: str(runtime.sourceSha, `${p}.installedRuntime.sourceSha`, SHA) }, mergedConfigSha: str(r.mergedConfigSha, `${p}.mergedConfigSha`, SHA), pap232Evidence: str(r.pap232Evidence, `${p}.pap232Evidence`, /^PAP-232\/c-[0-9]{17}$/), pap235Evidence: str(r.pap235Evidence, `${p}.pap235Evidence`, /^PAP-235\/c-[0-9]{17}$/) };
}

interface Line { text: string; start: number; end: number }
function lines(bytes: Uint8Array): Line[] {
  const b = Buffer.from(bytes); const result: Line[] = []; let start = 0;
  while (start < b.length) {
    const lf = b.indexOf(10, start); const end = lf < 0 ? b.length : lf + 1;
    let contentEnd = lf < 0 ? end : lf;
    if (contentEnd > start && b[contentEnd - 1] === 13) contentEnd--;
    result.push({ text: b.subarray(start, contentEnd).toString("utf8"), start, end }); start = end;
  }
  return result;
}
/** Hash raw byte offsets, never normalized text or reserialized JSON. */
export function parseReviewMatrixArtifact(input: Uint8Array, source: string): ReviewMatrixArtifact {
  parseReviewMatrixSource(source);
  text(input, MAX_REVIEW_ARTIFACT_BYTES, "artifact");
  const all = lines(input); let fence: { marker: string; length: number } | undefined;
  const headings: number[] = []; const starts: number[] = [];
  all.forEach((line, index) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (delimiter) {
      const marker = delimiter[1]!;
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
      return;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line.text);
    if (heading && heading[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim() === "Full Validation Matrix") {
      if (fence || line.text !== "### Full Validation Matrix") fail("REVIEW_BOUNDARY", "artifact.matrixHeading", "matrix heading is fenced or has ambiguous spelling/level");
      starts.push(index);
    }
    if (heading && heading[1]!.length <= 3 && !fence) headings.push(index);
  });
  if (fence) fail("REVIEW_FENCE", "artifact", "contains an unclosed Markdown fence");
  if (starts.length !== 1) fail("REVIEW_BOUNDARY", "artifact.matrixHeading", "requires exactly one Full Validation Matrix heading");
  const start = starts[0]!; const terminal = headings.find((i) => i > start);
  if (terminal === undefined) fail("REVIEW_BOUNDARY", "artifact.matrixBoundary", "requires a following level-1-to-3 heading");
  const authorityBytes = Uint8Array.from(input.subarray(all[start]!.start, all[terminal]!.start));
  const section = all.slice(start + 1, terminal);
  const delimiters = section.map((line, i) => ({ line, i })).filter(({ line }) => /^ {0,3}(?:`{3,}|~{3,})/.test(line.text));
  if (!delimiters.length || (!delimiters.some(({ line }) => line.text === "```json") && delimiters.some(({ line }) => /^```(?:bash|sh|shell)$/.test(line.text)))) fail("REVIEW_LEGACY_MIGRATION", "artifact.matrix", "legacy prose/inline/fenced-shell commands require a new versioned JSON matrix");
  if (delimiters.length !== 2 || delimiters[0]!.line.text !== "```json" || delimiters[1]!.line.text !== "```") fail("REVIEW_FENCE", "artifact.matrix", "requires exactly one unambiguous json fence");
  const open = delimiters[0]!.line; const close = delimiters[1]!.line;
  const payload = input.slice(open.end, close.start);
  let matrix: ReviewMatrix;
  try { matrix = parseReviewMatrix(payload); }
  catch (error) {
    if (error instanceof ReviewContractError) error.relatedErrors = inspectReviewMatrix(payload);
    throw error;
  }
  const sourceLines = section.filter((line) => /^(?:\*\*)?Matrix Source:/.test(line.text));
  if (sourceLines.length !== 1 || sourceLines[0]!.text !== `Matrix Source: ${source}`) fail("REVIEW_BINDING", "artifact.matrixSource", "matrix source line must agree exactly with the selected prefixed source");
  equal(matrix.source, source, "matrix.source");
  const headerLines = all.slice(0, start);
  const header = (label: string): string => {
    const prefix = `> ${label}: `;
    const spelling = new RegExp(`^>[ \\t]+(?:\\*\\*)?${label}:`);
    const matches = headerLines.filter((line) => spelling.test(line.text));
    if (matches.length !== 1 || !matches[0]!.text.startsWith(prefix)) fail("REVIEW_FIELD", `artifact.header.${label}`, "requires exactly one canonically spelled header field");
    return str(matches[0]!.text.slice(prefix.length), `artifact.header.${label}`);
  };
  const ticket = str(header("Ticket"), "artifact.header.ticket", TICKET);
  const approvalText = header("Matrix Approval Evidence");
  const commentIds = approvalText.match(/c-[0-9]{17}/g) ?? [];
  if (commentIds.length !== 1 || !(approvalText === commentIds[0] || new RegExp(`^${ticket} comment ${commentIds[0]} by sinh(?: [^\\r\\n]+)?$`).test(approvalText))) fail("REVIEW_FIELD", "artifact.header.matrixApprovalEvidence", "requires one exact comment ID or ticket comment ID by sinh header");
  return { source, authorityBytes, digest: createHash("sha256").update(authorityBytes).digest("hex"), matrix, header: {
    ticket, repositoryKey: str(header("Repository Key"), "artifact.header.repositoryKey", /^[a-z0-9][a-z0-9-]*$/), repositoryRoot: absolutePath(header("Repository Root"), "artifact.header.repositoryRoot"), approvedBaseSha: str(header("Approved Base SHA"), "artifact.header.approvedBaseSha", SHA), featureBranch: branch(header("Feature Branch"), "artifact.header.featureBranch", ticket), matrixAuthoritySha256: str(header("Matrix Authority SHA-256"), "artifact.header.matrixAuthoritySha256", DIGEST), matrixApprovalEvidence: commentIds[0]!,
  } };
}
function equal(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) fail("REVIEW_BINDING", path, "does not agree exactly with selected ticket/objective/approval/repository evidence");
}
/** Observational agreement only: neither approval authentication nor authorization consumption. */
export function assertReviewContractAgreement(objective: ReviewObjective, artifact: ReviewMatrixArtifact, expected: { ticket: string; repository: ReviewRepository; approval: ReviewMatrixApproval }): void {
  const h = artifact.header; const m = artifact.matrix; const a = expected.approval;
  equal(objective.ticket, expected.ticket, "objective.ticket"); equal(h.ticket, expected.ticket, "artifact.header.ticket");
  equal(objective.branch, expected.repository.branch, "objective.branch"); equal(h.featureBranch, objective.branch, "artifact.header.featureBranch");
  for (const field of ["key", "root", "baseSha", "branch"] as const) equal(m.repository[field], expected.repository[field], `matrix.repository.${field}`);
  equal(h.repositoryKey, m.repository.key, "artifact.header.repositoryKey"); equal(h.repositoryRoot, m.repository.root, "artifact.header.repositoryRoot"); equal(h.approvedBaseSha, m.repository.baseSha, "artifact.header.approvedBaseSha");
  equal(artifact.source, objective.matrixSource, "artifact.source"); equal(m.source, objective.matrixSource, "matrix.source");
  equal(artifact.digest, objective.matrixAuthoritySha256, "objective.matrixAuthoritySha256"); equal(h.matrixAuthoritySha256, artifact.digest, "artifact.header.matrixAuthoritySha256");
  equal(h.matrixApprovalEvidence, objective.matrixApprovalEvidence, "artifact.header.matrixApprovalEvidence");
  equal(a.author, "sinh", "approval.author"); equal(a.commentId, objective.matrixApprovalEvidence, "approval.commentId"); equal(a.ticket, expected.ticket, "approval.ticket"); equal(a.branch, objective.branch, "approval.branch"); equal(a.matrixSource, objective.matrixSource, "approval.matrixSource"); equal(a.matrixAuthoritySha256, artifact.digest, "approval.matrixAuthoritySha256");
  equal((m.environment.PA_TICKET_ID as { literal: string }).literal, expected.ticket, "matrix.environment.PA_TICKET_ID");
  const gates = m.prerequisites.filter((v) => v.kind === "operatorGate");
  if (Object.keys(objective.prerequisiteEvidence).length !== gates.length) fail("REVIEW_BINDING", "objective.prerequisiteEvidence", "must select exactly every declared operator gate, with no extra evidence");
  for (const gate of gates) {
    equal(gate.ticket, expected.ticket, "matrix.prerequisites.operatorGate.ticket");
    if (!Object.hasOwn(objective.prerequisiteEvidence, gate.id)) fail("REVIEW_BINDING", "objective.prerequisiteEvidence", "a declared gate comment selection is missing");
  }
}

/** Reads at most limit+1 bytes, rejects rather than truncating, opens no writer and initializes no state. */
export function readReviewEvidenceFile(path: string, limit: number, source: string): Uint8Array {
  absolutePath(path, source);
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || realpathSync(path) !== path) fail("REVIEW_SOURCE", source, "requires an exact regular file with no symlink aliases");
    if (before.size > limit) fail("REVIEW_SIZE", source, `must not exceed ${limit} bytes`);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) fail("REVIEW_SOURCE", source, "file identity changed during protected read");
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
    if (count > limit) fail("REVIEW_SIZE", source, `must not exceed ${limit} bytes`);
    const after = lstatSync(path); const final = fstatSync(fd);
    if (realpathSync(path) !== path || after.dev !== stat.dev || after.ino !== stat.ino || final.size !== count || final.mtimeMs !== stat.mtimeMs || final.ctimeMs !== stat.ctimeMs) fail("REVIEW_SOURCE", source, "file changed during protected read; reread fresh evidence");
    return bytes.subarray(0, count);
  } catch (error) {
    if (error instanceof ReviewContractError) throw error;
    return fail("REVIEW_IO", source, "cannot read the existing protected regular file");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { fail("REVIEW_IO", source, "cannot close the read-only file descriptor"); }
    }
  }
}
export function readReviewObjectiveFile(path: string): ReviewObjective {
  absolutePath(path, "objectiveFile");
  return parseReviewObjective(readReviewEvidenceFile(path, MAX_REVIEW_OBJECTIVE_BYTES, "objectiveFile"));
}
/** Read-only producer/runtime pairing. Synthetic fixtures prove schemas, never live approvals. */
export function readReviewProducerFixtures(configRoot: string): number {
  absolutePath(configRoot, "paired.configRoot");
  const manifest = object(parseReviewEvidenceJson(readReviewEvidenceFile(join(configRoot, "contracts/protected-review-v1.json"), MAX_REVIEW_ARTIFACT_BYTES, "paired.producers"), "paired.producers"), "paired.producers", ["schemaVersion", "fixtures"]);
  literal(manifest.schemaVersion, "paired.producers.schemaVersion", "pa-review-producer-fixtures/v1");
  const fixtures = list(manifest.fixtures, "paired.producers.fixtures", 3);
  if (fixtures.length !== 3) fail("REVIEW_PROFILE", "paired.producers.fixtures", "requires exactly one producer fixture for each supported profile");
  const profiles = new Set<string>();
  for (const input of fixtures) {
    const row = object(input, "paired.fixture", ["profile", "objective", "artifact"]);
    if (!REVIEW_PROFILES.includes(row.profile as ReviewProfile) || profiles.has(String(row.profile))) fail("REVIEW_PROFILE", "paired.fixture.profile", "requires each supported profile exactly once");
    const read = (key: string): Uint8Array => {
      const relative = relativePath(row[key], "paired.fixture.path");
      if (!relative.startsWith("contracts/fixtures/")) fail("REVIEW_SOURCE", "paired.fixture.path", "must be contained under contracts/fixtures");
      return readReviewEvidenceFile(join(configRoot, relative), MAX_REVIEW_ARTIFACT_BYTES, "paired.fixture");
    };
    const objective = parseReviewObjective(read("objective"));
    const artifact = parseReviewMatrixArtifact(read("artifact"), objective.matrixSource);
    equal(artifact.matrix.profile, row.profile, "paired.fixture.profile");
    assertReviewContractAgreement(objective, artifact, { ticket: objective.ticket, repository: artifact.matrix.repository,
      approval: { commentId: objective.matrixApprovalEvidence, author: "sinh", ticket: objective.ticket, branch: objective.branch,
        matrixSource: objective.matrixSource, matrixAuthoritySha256: objective.matrixAuthoritySha256 } });
    profiles.add(String(row.profile));
  }
  return profiles.size;
}

export function readReviewMatrixArtifact(aiUsageRoot: string, source: string): ReviewMatrixArtifact {
  parseReviewMatrixSource(source);
  absolutePath(aiUsageRoot, "aiUsageRoot");
  try {
    if (!lstatSync(aiUsageRoot).isDirectory() || realpathSync(aiUsageRoot) !== aiUsageRoot) fail("REVIEW_SOURCE", "aiUsageRoot", "requires the configured canonical directory without symlink aliases");
    const parts = source.slice("requirements:".length).split("/"); let path = aiUsageRoot;
    for (const part of parts.slice(0, -1)) {
      path = join(path, part); const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) fail("REVIEW_SOURCE", "matrixSource", "source ancestors must be exact directories without symlink aliases");
    }
    path = join(path, parts[parts.length - 1]!);
    return parseReviewMatrixArtifact(readReviewEvidenceFile(path, MAX_REVIEW_ARTIFACT_BYTES, "matrixSource"), source);
  } catch (error) {
    if (error instanceof ReviewContractError) throw error;
    return fail("REVIEW_IO", "matrixSource", "cannot read the existing requirements artifact beneath AI-usage");
  }
}
