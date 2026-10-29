import { createHash } from "node:crypto";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { isCanonicalTicketId } from "../tickets/validate.js";

// Shared pure contract for template validation and workflow consumers.
// No selector, store, authority capture or effect owner is loaded here.

export const WORKFLOW_CONTRACT = "pa-workflow-definition/v1" as const;
export const MAX_WORKFLOW_BYTES = 1_048_576;
export const MAX_WORKFLOW_RECORD_BYTES = 65_536;
export const MAX_WORKFLOW_STEPS = 256;
export const PACKAGE_PERMISSIONS = ["artifact.publish-pair", "ticket.queue.advance", "source.edit-scoped", "check.execute-scoped", "repair.same-scope", "git.commit-local"] as const;
export type PackagePermission = typeof PACKAGE_PERMISSIONS[number];
export type StepKind = "decision" | "check" | "action" | "publication";
export const STEP_OUTCOMES = {
  decision: ["approved", "rejected", "changes-requested", "cancelled"],
  check: ["passed", "failed", "unknown"],
  action: ["completed", "failed", "unknown"],
  publication: ["completed", "failed", "unknown"],
} as const;
export type StepOutcome = typeof STEP_OUTCOMES[StepKind][number];
export type Effect = "none" | "operator.capture" | "artifact.write-pair" | "ticket.queue" | "source.scoped" | "check.scoped" | "git.local" | "review.claim";
export interface OperationRef { id: string; version: "v1" }
export interface OutputDeclaration { name: string; schemaVersion: string }
export type InputReference = OutputDeclaration & ({ source: "context"; field: string } | { source: "output"; stepId: string; output: string });
export type Predicate = true | { op: "eq"; field: string; value: string } | { op: "in"; field: string; values: string[] } | { op: "all" | "any"; predicates: Predicate[] };
export interface WorkflowStep {
  id: string; order: number; title: string; description?: string; kind: StepKind; owner: string;
  dependsOn: { stepId: string; outcome: StepOutcome }[]; when: Predicate;
  inputs: InputReference[]; operation: OperationRef; authorization: PackagePermission[];
  effects: Effect[]; outputs: OutputDeclaration[];
  verification: { id: string; version: "v1"; inputs: string[] }[];
  transitions: Record<string, string>;
  failurePolicy: { strategy: "stop" | "reconcile" | "operator-retry"; correctionOwner: string };
}
export interface WorkflowDefinition {
  schemaVersion: typeof WORKFLOW_CONTRACT; workflowId: string; version: string;
  requiredCapabilities: string[]; steps: WorkflowStep[];
}
export interface WorkflowBinding {
  schemaVersion: "pa-workflow-binding/v1"; team: string; mode: string; enabled: boolean;
  workflowId: string; workflowVersion: string;
}
export interface EvidenceRef {
  schemaVersion: "pa-workflow-evidence-ref/v1"; ref: string; version: string; sha256: string;
}
export interface ReviewBundle {
  schemaVersion: "pa-review-bundle/v1"; subjectId: string; revision: number;
  requirements: EvidenceRef; uat: EvidenceRef; matrix: EvidenceRef;
  repository: { key: string; root: string }; ticket: string; route: { team: string; mode: string };
  handoff: { type: "fresh"; baseSha: string; branch: string; branchAction: "create" }
    | { type: "amendment"; baseSha: string; branch: string; featureSha: string; branchAction: "reuse" };
  workflow: { id: string; version: string; sha256: string };
  scope: { requirements: string[]; acceptanceCriteria: string[]; files: string[]; directories: string[]; newPaths: string[]; checks: CommandReference[]; excludedEffects: string[] };
  requestedPermissions: PackagePermission[];
}
export interface CommandReference { matrixSource: string; matrixSha256: string; commandId: string }
export type WorkflowErrorCode = "WORKFLOW_CONTRACT" | "WORKFLOW_SOURCE" | "WORKFLOW_DISABLED" | "WORKFLOW_CAPABILITY" | "WORKFLOW_CONFLICT" | "WORKFLOW_AUTHORITY" | "WORKFLOW_UNCERTAIN";
export class JsonWorkflowError extends Error {
  constructor(readonly code: WorkflowErrorCode, readonly gateId = "contract", readonly correctionOwner = "workflow-contract-owner") {
    super(`Condition: JSON workflow blocked\nSource: ${gateId}\nReason: ${code}\nCorrection: ${correctionOwner} must supply supported matching evidence; preserve retained state\nResume Action: rerun observational preflight; never infer authority or use legacy fallback`);
    this.name = "JsonWorkflowError";
  }
}
export function reject(code: WorkflowErrorCode = "WORKFLOW_CONTRACT"): never { throw new JsonWorkflowError(code); }
export type Row = Record<string, unknown>;
export function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject();
  const row = value as Row;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) reject();
  return row;
}
export function text(value: unknown, pattern?: RegExp, max = 4096): string {
  if (typeof value !== "string" || !value.length || value.length > max || value !== value.trim() || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) || (pattern && !pattern.test(value))) reject();
  return value;
}
/** Preserve canonical ticket bytes, including padding; never normalize aliases. */
export function workflowTicket(value: unknown): string {
  const ticket = text(value); if (!isCanonicalTicketId(ticket)) reject(); return ticket;
}
export const ID = /^[a-z][a-z0-9.-]{0,127}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const GIT_SHA = /^[a-f0-9]{40}$/;
export function array<T>(value: unknown, parse: (item: unknown) => T, max = 256): T[] {
  if (!Array.isArray(value) || value.length > max) reject();
  return value.map(parse);
}
export function unique<T>(values: T[]): T[] { if (new Set(values).size !== values.length) reject(); return values; }
export function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) reject(); return value as T;
}
export function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) reject(); return value as number;
}
export function literal<T extends string>(value: unknown, expected: T): T { if (value !== expected) reject(); return expected; }
/** Reuse the review owner's duplicate-decoded-key, fatal UTF-8, BOM and depth-64 reader. Never echo rejected bytes. */
export function strictJson(input: Uint8Array, limit = MAX_WORKFLOW_BYTES): unknown {
  if (input.byteLength > limit) reject();
  try { return parseReviewEvidenceJson(input, "workflow"); } catch { return reject(); }
}
export function parseWorkflowRequest(input: Uint8Array | string): unknown {
  if (typeof input === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) reject();
  return strictJson(typeof input === "string" ? Buffer.from(input) : input, MAX_WORKFLOW_RECORD_BYTES);
}
export function digest(input: Uint8Array | string): string { return createHash("sha256").update(input).digest("hex"); }
export function evidenceRef(value: unknown): EvidenceRef {
  const r = object(value, ["schemaVersion", "ref", "version", "sha256"]);
  return { schemaVersion: literal(r.schemaVersion, "pa-workflow-evidence-ref/v1"), ref: text(r.ref), version: text(r.version), sha256: text(r.sha256, SHA256) };
}
export function relativePath(value: unknown): string {
  const path = text(value);
  if (path.startsWith("/") || path.includes("\\") || path.includes(":") || path.split("/").some(p => !p || p === "." || p === ".." || p === ".git")) reject();
  return path;
}
export function commandReference(value: unknown): CommandReference {
  const r = object(value, ["matrixSource", "matrixSha256", "commandId"]);
  return { matrixSource: text(r.matrixSource, /^requirements:agent-teams\/requirements\/artifacts\/.+\.md$/), matrixSha256: text(r.matrixSha256, SHA256), commandId: text(r.commandId, ID) };
}
export function parseReviewBundle(input: Uint8Array): ReviewBundle {
  const r = object(strictJson(input), ["schemaVersion", "subjectId", "revision", "requirements", "uat", "matrix", "repository", "ticket", "route", "handoff", "workflow", "scope", "requestedPermissions"]);
  literal(r.schemaVersion, "pa-review-bundle/v1");
  const repository = object(r.repository, ["key", "root"]); const route = object(r.route, ["team", "mode"]);
  const h = r.handoff as Row; const fresh = h?.type === "fresh";
  object(h, fresh ? ["type", "baseSha", "branch", "branchAction"] : ["type", "baseSha", "branch", "featureSha", "branchAction"]);
  const ticket = workflowTicket(r.ticket);
  const branch = text(h.branch, /^feature\/[A-Z][A-Z0-9]*-[0-9]+-[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
  if (!branch.startsWith(`feature/${ticket}-`) || branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.split("/").some(p => p.endsWith(".lock") || p.endsWith("."))) reject();
  const baseSha = text(h.baseSha, GIT_SHA);
  const handoff: ReviewBundle["handoff"] = fresh ? { type: literal(h.type, "fresh"), baseSha, branch, branchAction: literal(h.branchAction, "create") }
    : { type: literal(h.type, "amendment"), baseSha, branch, featureSha: text(h.featureSha, GIT_SHA), branchAction: literal(h.branchAction, "reuse") };
  const w = object(r.workflow, ["id", "version", "sha256"]);
  const s = object(r.scope, ["requirements", "acceptanceCriteria", "files", "directories", "newPaths", "checks", "excludedEffects"]);
  const root = text(repository.root); if (!root.startsWith("/") || root.includes("\\") || root.split("/").slice(1).some(p => !p || p === "." || p === "..")) reject();
  const requirements = evidenceRef(r.requirements); const uat = evidenceRef(r.uat); const matrix = evidenceRef(r.matrix);
  for (const [ref, prefix] of [[requirements.ref, "requirements:"], [uat.ref, "uat:"]] as const) {
    if (!ref.startsWith(`${prefix}agent-teams/requirements/artifacts/`) || !ref.endsWith(".md")) reject();
    relativePath(ref.slice(prefix.length));
  }
  if (matrix.ref !== requirements.ref || requirements.ref.slice("requirements:".length) === uat.ref.slice("uat:".length)) reject();
  const checks = array(s.checks, commandReference); unique(checks.map(c => c.commandId));
  if (checks.some(c => c.matrixSource !== matrix.ref || c.matrixSha256 !== matrix.sha256)) reject();
  return {
    schemaVersion: "pa-review-bundle/v1", subjectId: text(r.subjectId, ID), revision: integer(r.revision),
    requirements, uat, matrix,
    repository: { key: text(repository.key, ID), root }, ticket, route: { team: text(route.team, ID), mode: text(route.mode, ID) }, handoff,
    workflow: { id: text(w.id, ID), version: text(w.version, ID), sha256: text(w.sha256, SHA256) },
    scope: { requirements: unique(array(s.requirements, v => text(v, /^FR-[0-9]+$/))), acceptanceCriteria: unique(array(s.acceptanceCriteria, v => text(v, /^AC-[0-9]+$/))),
      files: unique(array(s.files, relativePath)), directories: unique(array(s.directories, relativePath)), newPaths: unique(array(s.newPaths, relativePath)), checks,
      excludedEffects: unique(array(s.excludedEffects, v => text(v, ID))) },
    requestedPermissions: unique(array(r.requestedPermissions, v => oneOf(v, PACKAGE_PERMISSIONS))),
  };
}
export function parseWorkflowBinding(value: unknown): WorkflowBinding {
  const r = object(value, ["schemaVersion", "team", "mode", "enabled", "workflowId", "workflowVersion"]);
  if (typeof r.enabled !== "boolean") reject();
  return { schemaVersion: literal(r.schemaVersion, "pa-workflow-binding/v1"), team: text(r.team, ID), mode: text(r.mode, ID), enabled: r.enabled,
    workflowId: text(r.workflowId, ID), workflowVersion: text(r.workflowVersion, ID) };
}
