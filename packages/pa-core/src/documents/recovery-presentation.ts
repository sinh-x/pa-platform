import type { DocumentPackageError } from "./package-contract.js";

/** Pure typed guidance: never copy exception prose, probe state or infer that a
 * failed reply means the append was absent. The original request owns replay. */
export function publicationRecoveryGuidance(code: unknown): string {
  const reasons: Record<DocumentPackageError["code"], string> = {
    DOCUMENT_INPUT: "The strict recovery request is invalid. No caller-supplied outcome, identity, path or receipt is accepted.",
    DOCUMENT_SOURCE: "Required immutable or physical evidence is unreadable or unsafe; safe destination state is unproven.",
    DOCUMENT_STALE: "The authenticated caller or observed facts changed. Earlier consent cannot authorize changed facts.",
    DOCUMENT_AUTHORITY: "Exact subject, operation, caller or recovery authority does not match, or the subject is permanently retired.",
    DOCUMENT_CONFLICT: "The journal revision or destination/reference observations do not match eligible recovery coordinates.",
    DOCUMENT_UNCERTAIN: "Custody or the operation result is unproven; existing partial effects and history must be preserved.",
    DOCUMENT_UNAVAILABLE: "This route lacks qualified policy-profile recovery or its native foreground decision UI. Retained profiles are not upgraded.",
  };
  const reason = typeof code === "string" && Object.hasOwn(reasons, code) ? reasons[code as DocumentPackageError["code"]] : reasons.DOCUMENT_UNCERTAIN;
  return `Publication recovery is not proven settled. Do not retry obsolete publication.\nCondition: This recovery request did not establish a settled result; an issued consent or settlement may already exist.\nSource: Native document publication recovery owner.\nReason: ${reason}\nCorrection: Inspect this ticket with pa_document status and the supported exact publication-diagnose request. Impact: read-only. Actor: agent or operator. New approval: not required to inspect. Prerequisite: retain the original subject, operation, decision and request coordinates; do not clear evidence or start a replacement lineage.\nResume Action: Reconcile an issued request using its ORIGINAL revision and bindings before any new prompt. A new eligible observation needs its own exact native consent; changed facts require fresh admission. Corrected content still needs fresh package approval.`;
}
