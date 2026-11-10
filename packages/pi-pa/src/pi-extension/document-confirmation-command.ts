import { DocumentPackageError, parseDocumentRequest } from "@pa-platform/pa-core";
import { mutatePiDocument } from "../document-native.js";
import type { PiDocumentConfirmationContext } from "../document-confirmation-native.js";

export function documentConfirmationCommandFailure(code: unknown): string {
  const reasons: Record<string, string> = { DOCUMENT_INPUT: "The request shape, scope or values are invalid.", DOCUMENT_UNAVAILABLE: "Eligible native v3 foreground/custom-UI capability is unavailable; there is no retained-dialog or imported-receipt fallback.", DOCUMENT_AUTHORITY: "Native caller, subject or requested authority was not proven.", DOCUMENT_STALE: "Caller or reviewed source changed; no new grant for changed bytes is established.", DOCUMENT_CONFLICT: "Current revision, competing review or immutable tracking evidence conflicts with this request.", DOCUMENT_SOURCE: "The required exact source/snapshot or artifact boundary could not be established.", DOCUMENT_UNCERTAIN: "Issuance or linkage completion is uncertain; preserve the existing request and evidence." };
  const safeCode = typeof code === "string" && Object.hasOwn(reasons, code) ? code : "DOCUMENT_UNCERTAIN";
  return `Package decision request not completed; a prior decision or partial linkage may exist.\nCondition: This confirmation/reconciliation did not establish complete linkage.\nSource: Native document decision owner (${safeCode}).\nReason: ${reasons[safeCode]}\nCorrection: Inspect pa_document status/show and preserve the original request revision before repair. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: authenticated package context and retained evidence.\nResume Action: Correct the proven cause, then reconcile the same unchanged request; do not supply an approval result, reset evidence or request a duplicate grant.`;
}

/** Operator and model entry share mutatePiDocument, native authentication/UI,
 * registry CAS and linkage recovery. No JSON actor/outcome or CLI receipt port. */
export async function runDocumentConfirmationCommand(args: string, context: PiDocumentConfirmationContext, mutate = mutatePiDocument): Promise<Record<string, unknown>> {
  let result: Record<string, unknown>;
  try {
    const request = parseDocumentRequest(args);
    if (request.action !== "confirm" && request.action !== "confirm-revoke") throw new DocumentPackageError("DOCUMENT_INPUT");
    result = await mutate(args, context);
  } catch (error) { result = { ok: false, code: error instanceof DocumentPackageError ? error.code : "DOCUMENT_UNAVAILABLE" }; }
  if (result.ok === true) {
    const data = result.result as { outcome?: string; approval?: { linkage?: string }; reused?: boolean; revoked?: boolean; superseded?: boolean; operation?: string } | undefined;
    const outcome = ["approved", "rejected", "changes-requested", "cancelled"].includes(data?.outcome ?? "") ? data!.outcome : "unproven";
    context.ui?.notify?.(`${data?.operation === "revoke" ? "Package revocation response" : "Package decision"}: ${outcome}.${data?.revoked || data?.superseded ? ` This issued decision is ${data.revoked ? "revoked" : "superseded"}; no current approval authority.` : ""} JSON/ticket linkage: ${data?.approval?.linkage === "complete" ? "verified complete" : "unproven"}.${data?.reused ? " Reused the issued decision; no new prompt." : ""} No implementation launched.`, "info");
  } else {
    context.ui?.notify?.(documentConfirmationCommandFailure(result.code), "error");
  }
  return result;
}
