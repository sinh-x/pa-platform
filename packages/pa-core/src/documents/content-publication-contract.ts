import { object, oneOf, strictJson } from "../workflows/contracts.js";
import { documentGuard } from "./package-contract.js";
import { contentReviewReferenceSha, type ContentReviewOrigin } from "./content-review-contract.js";

export type ContentPublicationCaller = ContentReviewOrigin;
export interface ContentPublicationAuthority {
  schemaVersion: "pa-content-publication-authority/v1";
  contentDecisionId: string;
  caller: ContentPublicationCaller;
  scope: "publish-exact-content-only";
  method: "native-foreground-publication-confirmation";
  authorizedAt: string;
}
export interface ContentReviewFence {
  decisionId: string;
  reason: "revoked" | "superseded";
  successor: string | null;
  recordedAt: string;
}
export type ContentPublicationRequest = { action: "authorize" | "publish" | "status" | "revoke"; reference: string }
  | { action: "supersede"; reference: string; successorReference: string };
export function contentPublicationGuidance(code: unknown): string {
  const reasons: Record<string, string> = {
    DOCUMENT_INPUT: "Use the exact issued reference and supported publication action. Imported authority, outcomes and extra fields are rejected.",
    DOCUMENT_AUTHORITY: "The exact active content decision, native publication authority or current caller is not eligible. A saved content decision alone cannot publish.",
    DOCUMENT_SOURCE: "Required immutable source, delivery or native provenance could not be verified.",
    DOCUMENT_STALE: "Bound source, delivery or caller changed. The original operation and valid history remain retained.",
    DOCUMENT_CONFLICT: "Current custody, lifecycle, predecessor, destination or structured references conflict with this publication.",
    DOCUMENT_UNCERTAIN: "The original publication may be partial; its final result or ownership is unproven.",
    DOCUMENT_UNAVAILABLE: "A required native owner or environment is unavailable; the exact cause is unproven here.",
  };
  const reason = typeof code === "string" && Object.hasOwn(reasons, code) ? reasons[code] : reasons.DOCUMENT_UNAVAILABLE;
  return `Publication completion is not established; preserve any completed effects.\nCondition: This exact publication cannot report verified completion.\nSource: Native content-publication owner.\nReason: ${reason}\nCorrection: Ask the runtime owner to inspect the same reference, saved authority and original operation. Impact: read-only. Actor: agent or operator. New approval: not required to inspect; repairs need their owner's authority. Prerequisite: preserve native history, delivery and partial files/references.\nResume Action: Continue only the original operation after its owner establishes the result and resolves the cause. Remaining effects recheck admission. Do not replace the operation or repeat the unchanged content signature; completed truth is not permission for missing writes.`;
}
export function parseContentPublicationRequest(raw: string): ContentPublicationRequest {
  return documentGuard(() => {
    const head = object(strictJson(Buffer.from(raw), 65536), ["schemaVersion", "action", "reference"], ["successorReference"]);
    if (head.schemaVersion !== "pa-content-publication/v1") throw Error("version");
    const action = oneOf(head.action, ["authorize", "publish", "status", "revoke", "supersede"]);
    const row = object(head, ["schemaVersion", "action", "reference", ...(action === "supersede" ? ["successorReference"] : [])]);
    contentReviewReferenceSha(row.reference);
    // The reference validator established this bounded string; retain no unknown fields.
    const reference = `review:${contentReviewReferenceSha(row.reference)}`;
    return action === "supersede" ? { action, reference, successorReference: `review:${contentReviewReferenceSha(row.successorReference)}` } : { action, reference };
  });
}
