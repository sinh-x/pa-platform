import { isAbsolute } from "node:path";
import { digest, GIT_SHA, ID, integer, literal, object, oneOf, parseWorkflowRequest, SHA256, text, workflowTicket } from "../workflows/contracts.js";
import { documentGuard, documentReject, DOCUMENT_LIMITS } from "./package-contract.js";

/** P1 candidate contracts ONLY. No production dispatch, capability registration,
 * decision consumer, Git port or authority is exported. Parsing a record proves
 * structure, never native provenance, association, ownership or permission.
 * These versions must be independently reviewed before an adapter selects them.
 * pa-document-package/v1 and its existing scopes are deliberately unchanged. */
export const HANDOFF_REVIEW_VERSION = "pa-handoff-review/v1" as const;
export const HANDOFF_INTENT_VERSION = "pa-handoff-branch-intent/v1" as const;
export const HANDOFF_REQUEST_VERSION = "pa-handoff-request/v1" as const;

export interface HandoffRepository {
  key: string;
  root: string;
  physicalIdentitySha256: string;
}
export interface HandoffBranchIntent {
  schemaVersion: typeof HANDOFF_INTENT_VERSION;
  requestId: string;
  callerIdentitySha256: string;
  expectedTicketVersion: string;
  repository: HandoffRepository;
  ticket: string;
  branch: string;
  action: "create" | "reuse";
  base: {
    ref: "refs/heads/develop";
    sha: string;
    observedDevelopSha: string;
    observedAt: string;
    provenance: "local-develop-ref" | "native-original-base";
    remoteFreshness: "not-established";
  };
  /** Expected exact legacy link bytes, not proof that the write completed. */
  plannedLinkSha256: string;
  /** Existing native history, not a branch-name-based adoption token. */
  lineage: null | { operationSha256: string; originalBaseSha: string; observedHeadSha: string };
}
export interface HandoffReviewSubject {
  schemaVersion: typeof HANDOFF_REVIEW_VERSION;
  documentSubjectSha256: string;
  branchIntentSha256: string;
  deliverySha256: string;
  selectionSha256: string;
  callerIdentitySha256: string;
  effects: { publish: boolean; branchRef: boolean; queue: boolean };
}
/** Desired caller input only. Owner observations and grants are not request fields.
 * All original coordinates must be retained after response loss. */
export type HandoffRequest =
  | { schemaVersion: typeof HANDOFF_REQUEST_VERSION; action: "plan"; ticket: string; requestId: string; branch: string; expectedTicketVersion: string }
  | { schemaVersion: typeof HANDOFF_REQUEST_VERSION; action: "review"; subjectSha256: string; expectedRevision: number }
  | { schemaVersion: typeof HANDOFF_REQUEST_VERSION; action: "complete-branch"; subjectSha256: string; decisionId: string; expectedRevision: number }
  | { schemaVersion: typeof HANDOFF_REQUEST_VERSION; action: "open"; deliverySha256: string };

function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > DOCUMENT_LIMITS.requestBytes) documentReject();
  return value;
}
function repository(value: unknown): HandoffRepository {
  const row = object(value, ["key", "root", "physicalIdentitySha256"]);
  const root = text(row.root);
  if (!isAbsolute(root) || root.includes("\\") || root.split("/").slice(1).some(part => !part || part === "." || part === "..")) documentReject();
  return { key: text(row.key, ID), root, physicalIdentitySha256: text(row.physicalIdentitySha256, SHA256) };
}
function branchName(value: unknown, ticket: string): string {
  // Candidate profile deliberately supports only the existing default feature
  // convention. An owner must ALSO verify the registered repository convention.
  const branch = text(value, undefined, 256);
  if (!new RegExp(`^feature/${ticket}-[a-z0-9]+(?:-[a-z0-9]+)*$`).test(branch)) documentReject();
  return branch;
}
function utc(value: unknown): string {
  const stamp = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 24);
  const time = Date.parse(stamp);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== stamp) documentReject();
  return stamp;
}
export function parseHandoffBranchIntent(value: unknown): HandoffBranchIntent {
  return documentGuard(() => {
    const row = object(value, ["schemaVersion", "requestId", "callerIdentitySha256", "expectedTicketVersion", "repository", "ticket", "branch", "action", "base", "plannedLinkSha256", "lineage"]);
    const base = object(row.base, ["ref", "sha", "observedDevelopSha", "observedAt", "provenance", "remoteFreshness"]);
    const ticket = workflowTicket(row.ticket), action = oneOf(row.action, ["create", "reuse"]);
    let lineage: HandoffBranchIntent["lineage"] = null;
    if (row.lineage !== null) {
      const prior = object(row.lineage, ["operationSha256", "originalBaseSha", "observedHeadSha"]);
      lineage = { operationSha256: text(prior.operationSha256, SHA256), originalBaseSha: text(prior.originalBaseSha, GIT_SHA), observedHeadSha: text(prior.observedHeadSha, GIT_SHA) };
    }
    const result: HandoffBranchIntent = {
      schemaVersion: literal(row.schemaVersion, HANDOFF_INTENT_VERSION), requestId: text(row.requestId, ID),
      callerIdentitySha256: text(row.callerIdentitySha256, SHA256), expectedTicketVersion: text(row.expectedTicketVersion, SHA256),
      repository: repository(row.repository), ticket, branch: branchName(row.branch, ticket), action,
      base: { ref: literal(base.ref, "refs/heads/develop"), sha: text(base.sha, GIT_SHA), observedDevelopSha: text(base.observedDevelopSha, GIT_SHA),
        observedAt: utc(base.observedAt), provenance: oneOf(base.provenance, ["local-develop-ref", "native-original-base"]), remoteFreshness: literal(base.remoteFreshness, "not-established") },
      plannedLinkSha256: text(row.plannedLinkSha256, SHA256), lineage,
    };
    if (action === "create") {
      if (lineage !== null || result.base.provenance !== "local-develop-ref" || result.base.sha !== result.base.observedDevelopSha) documentReject();
    } else if (!lineage || result.base.provenance !== "native-original-base" || lineage.originalBaseSha !== result.base.sha) documentReject();
    return bounded(result);
  });
}
export function handoffBranchIntentSha(value: HandoffBranchIntent): string {
  return digest(JSON.stringify(parseHandoffBranchIntent(value)));
}
export function parseHandoffReviewSubject(value: unknown): HandoffReviewSubject {
  return documentGuard(() => {
    const row = object(value, ["schemaVersion", "documentSubjectSha256", "branchIntentSha256", "deliverySha256", "selectionSha256", "callerIdentitySha256", "effects"]);
    const effects = object(row.effects, ["publish", "branchRef", "queue"]);
    if (typeof effects.publish !== "boolean" || typeof effects.branchRef !== "boolean" || typeof effects.queue !== "boolean"
      || effects.branchRef && !effects.publish || effects.queue && (!effects.publish || !effects.branchRef)) documentReject();
    return bounded({ schemaVersion: literal(row.schemaVersion, HANDOFF_REVIEW_VERSION), documentSubjectSha256: text(row.documentSubjectSha256, SHA256),
      branchIntentSha256: text(row.branchIntentSha256, SHA256), deliverySha256: text(row.deliverySha256, SHA256), selectionSha256: text(row.selectionSha256, SHA256),
      callerIdentitySha256: text(row.callerIdentitySha256, SHA256), effects: { publish: effects.publish, branchRef: effects.branchRef, queue: effects.queue } });
  });
}
export function handoffReviewSubjectSha(value: HandoffReviewSubject): string {
  return digest(JSON.stringify(parseHandoffReviewSubject(value)));
}
export function parseHandoffRequest(raw: string): HandoffRequest {
  return documentGuard(() => {
    const input = object(parseWorkflowRequest(raw), ["schemaVersion", "action"], ["ticket", "requestId", "branch", "expectedTicketVersion", "subjectSha256", "decisionId", "expectedRevision", "deliverySha256"]);
    const schemaVersion = literal(input.schemaVersion, HANDOFF_REQUEST_VERSION);
    const action = oneOf(input.action, ["plan", "review", "complete-branch", "open"]);
    const fields = { plan: ["ticket", "requestId", "branch", "expectedTicketVersion"], review: ["subjectSha256", "expectedRevision"],
      "complete-branch": ["subjectSha256", "decisionId", "expectedRevision"], open: ["deliverySha256"] };
    object(input, ["schemaVersion", "action", ...fields[action]]);
    if (action === "plan") {
      const ticket = workflowTicket(input.ticket);
      return { schemaVersion, action, ticket, requestId: text(input.requestId, ID), branch: branchName(input.branch, ticket), expectedTicketVersion: text(input.expectedTicketVersion, SHA256) };
    }
    if (action === "open") return { schemaVersion, action, deliverySha256: text(input.deliverySha256, SHA256) };
    const subjectSha256 = text(input.subjectSha256, SHA256), expectedRevision = integer(input.expectedRevision, 0, 1023);
    return action === "review" ? { schemaVersion, action, subjectSha256, expectedRevision }
      : { schemaVersion, action, subjectSha256, decisionId: text(input.decisionId, ID), expectedRevision };
  });
}
