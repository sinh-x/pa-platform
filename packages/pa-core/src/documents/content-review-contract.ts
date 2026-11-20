import { digest, literal, object, SHA256, strictJson, text, workflowTicket } from "../workflows/contracts.js";
import { documentGuard, documentReject } from "./package-contract.js";
import type { LocalReviewOutcome } from "./handoff-contract.js";

export interface ContentReviewOrigin {
  callerIdentitySha256: string; selectionSha256: string; deploymentId: string; sessionId: string;
}
/** No branch intent or effect mask: this subject cannot convey effect authority. */
export interface ContentReviewSubject extends ContentReviewOrigin {
  schemaVersion: "pa-content-review-subject/v1";
  documentSubjectSha256: string; deliverySha256: string; purpose: "sign-content-only";
}
export type ContentReviewRequest = { action: "list"; ticket: string }
  | { action: "show"; reference: string } | { action: "request"; reference: string }
  | { action: "decide"; reference: string; outcome: LocalReviewOutcome };
export function parseContentReviewSubject(value: unknown): ContentReviewSubject {
  return documentGuard(() => {
    const s = object(value, ["schemaVersion", "documentSubjectSha256", "deliverySha256", "purpose", "callerIdentitySha256", "selectionSha256", "deploymentId", "sessionId"]);
    return { schemaVersion: literal(s.schemaVersion, "pa-content-review-subject/v1"), documentSubjectSha256: text(s.documentSubjectSha256, SHA256),
      deliverySha256: text(s.deliverySha256, SHA256), purpose: literal(s.purpose, "sign-content-only"),
      callerIdentitySha256: text(s.callerIdentitySha256, SHA256), selectionSha256: text(s.selectionSha256, SHA256),
      deploymentId: text(s.deploymentId, /^d-[a-f0-9]{6}$/), sessionId: text(s.sessionId, undefined, 256) };
  });
}
export const contentReviewSubjectSha = (value: ContentReviewSubject): string => digest(JSON.stringify(parseContentReviewSubject(value)));
export function contentReviewReferenceSha(value: unknown): string { return documentGuard(() => text(value, /^review:[a-f0-9]{64}$/, 71).slice(7)); }
export function parseContentReviewRequest(raw: string): ContentReviewRequest {
  return documentGuard(() => {
    const value = strictJson(Buffer.from(raw), 65536);
    const head = object(value, ["schemaVersion", "action"], ["ticket", "reference", "outcome"]);
    literal(head.schemaVersion, "pa-content-review/v1");
    if (head.action === "list") { const r = object(value, ["schemaVersion", "action", "ticket"]); return { action: "list", ticket: workflowTicket(r.ticket) }; }
    if (head.action !== "show" && head.action !== "request" && head.action !== "decide") return documentReject();
    const r = object(value, ["schemaVersion", "action", "reference", ...(head.action === "decide" ? ["outcome"] : [])]);
    const reference = `review:${contentReviewReferenceSha(r.reference)}`;
    if (head.action !== "decide") return { action: head.action, reference };
    const outcome = r.outcome;
    if (outcome !== "approved" && outcome !== "changes-requested" && outcome !== "rejected" && outcome !== "cancelled") return documentReject();
    return { action: "decide", reference, outcome };
  });
}
