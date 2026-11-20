import { isAbsolute } from "node:path";
import { digest, GIT_SHA, ID, integer, literal, object, oneOf, parseWorkflowRequest, SHA256, text, workflowTicket } from "../workflows/contracts.js";
import { documentGuard, documentReject, DOCUMENT_LIMITS } from "./package-contract.js";

/** Parsing proves structure, never native provenance or authority. v2 local
 * confirmation is explicitly unauthenticated; retained v1 scopes are unchanged. */
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
export interface HandoffReviewOrigin {
  deploymentId: string;
  sessionId: string;
  planIdentity: { scope: string; requestId: string };
}
interface HandoffReviewBindings {
  documentSubjectSha256: string;
  branchIntentSha256: string;
  deliverySha256: string;
  selectionSha256: string;
  callerIdentitySha256: string;
  effects: { publish: boolean; branchRef: boolean; queue: boolean };
}
export type HandoffReviewSubject = HandoffReviewBindings & (
  { schemaVersion: typeof HANDOFF_REVIEW_VERSION }
  | { schemaVersion: "pa-handoff-review/v2"; origin: HandoffReviewOrigin });
export type LocalHandoffReviewSubject = Extract<HandoffReviewSubject, { schemaVersion: "pa-handoff-review/v2" }>;
export const LOCAL_REVIEW_VERSION = "pa-local-review/v1" as const;
export type LocalReviewOutcome = "approved" | "changes-requested" | "rejected" | "cancelled";
export type LocalReviewRequest = { schemaVersion: typeof LOCAL_REVIEW_VERSION; subjectSha256: string } & (
  { action: "show" }
  | { action: "request"; expectedRevision: number }
  | { action: "decide"; expectedRevision: number; requestKey: string; outcome: LocalReviewOutcome }
  | { action: "revoke"; expectedRevision: number; decisionId: string });

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
  // Pure historical shape, NOT current naming policy. Literal-template
  // matching (including the actual topic capture) belongs to current owners.
  const branch = text(value, undefined, 256);
  const placement = new RegExp(`(^|[^A-Za-z0-9])${ticket}(?=$|[^A-Za-z0-9])`).exec(branch);
  if (!placement || branch.startsWith("-") || branch.endsWith(".") || /[\s~^:?*\[\\]/.test(branch)
    || branch.includes("..") || branch.includes("@{")
    || branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) documentReject();
  // A history record has no template field. Do not mistake literal framing
  // (e.g. -REVIEW or parentheses) for the topic. Current admission uses the
  // registered template's strict lowercase-kebab topic capture; parsing alone
  // proves only ref/ticket structure and never a policy match or approval.
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
    const version = object(value, ["schemaVersion"], ["documentSubjectSha256", "branchIntentSha256", "deliverySha256", "selectionSha256", "callerIdentitySha256", "effects", "origin"]).schemaVersion;
    const row = object(value, ["schemaVersion", "documentSubjectSha256", "branchIntentSha256", "deliverySha256", "selectionSha256", "callerIdentitySha256", "effects", ...(version === "pa-handoff-review/v2" ? ["origin"] : [])]);
    const effects = object(row.effects, ["publish", "branchRef", "queue"]);
    if (typeof effects.publish !== "boolean" || typeof effects.branchRef !== "boolean" || typeof effects.queue !== "boolean"
      || effects.branchRef && !effects.publish || effects.queue && (!effects.publish || !effects.branchRef)) documentReject();
    const bindings = { documentSubjectSha256: text(row.documentSubjectSha256, SHA256),
      branchIntentSha256: text(row.branchIntentSha256, SHA256), deliverySha256: text(row.deliverySha256, SHA256), selectionSha256: text(row.selectionSha256, SHA256),
      callerIdentitySha256: text(row.callerIdentitySha256, SHA256), effects: { publish: effects.publish, branchRef: effects.branchRef, queue: effects.queue } };
    if (version === "pa-handoff-review/v2") {
      const origin = object(row.origin, ["deploymentId", "sessionId", "planIdentity"]), plan = object(origin.planIdentity, ["scope", "requestId"]);
      return bounded({ schemaVersion: "pa-handoff-review/v2", ...bindings, origin: {
        deploymentId: text(origin.deploymentId, /^d-[a-f0-9]{6}$/), sessionId: text(origin.sessionId, undefined, 256),
        planIdentity: { scope: text(plan.scope, SHA256), requestId: text(plan.requestId, ID) } } });
    }
    return bounded({ schemaVersion: literal(row.schemaVersion, HANDOFF_REVIEW_VERSION), ...bindings });
  });
}
export function handoffReviewSubjectSha(value: HandoffReviewSubject): string {
  return digest(JSON.stringify(parseHandoffReviewSubject(value)));
}
export function parseLocalReviewRequest(raw: string): LocalReviewRequest {
  return documentGuard(() => {
    const row = object(parseWorkflowRequest(raw), ["schemaVersion", "action", "subjectSha256"], ["expectedRevision", "requestKey", "outcome", "decisionId"]);
    const schemaVersion = literal(row.schemaVersion, LOCAL_REVIEW_VERSION), subjectSha256 = text(row.subjectSha256, SHA256);
    const action = oneOf(row.action, ["show", "request", "decide", "revoke"]);
    const fields = { show: [], request: ["expectedRevision"], decide: ["expectedRevision", "requestKey", "outcome"], revoke: ["expectedRevision", "decisionId"] };
    object(row, ["schemaVersion", "action", "subjectSha256", ...fields[action]]);
    if (action === "show") return { schemaVersion, action, subjectSha256 };
    const expectedRevision = integer(row.expectedRevision, 0, 1021);
    if (action === "request") return { schemaVersion, action, subjectSha256, expectedRevision };
    if (action === "revoke") return { schemaVersion, action, subjectSha256, expectedRevision, decisionId: text(row.decisionId, ID) };
    return { schemaVersion, action, subjectSha256, expectedRevision, requestKey: text(row.requestKey, SHA256),
      outcome: oneOf(row.outcome, ["approved", "changes-requested", "rejected", "cancelled"]) };
  });
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
