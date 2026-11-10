import { DocumentPackageError, parseDocumentRequest } from "@pa-platform/pa-core";
import { mutatePiDocument } from "../document-native.js";
import type { PiDocumentConfirmationContext } from "../document-confirmation-native.js";

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
    const data = result.result as { outcome?: string; approval?: { linkage?: string }; reused?: boolean } | undefined;
    const outcome = ["approved", "rejected", "changes-requested", "cancelled"].includes(data?.outcome ?? "") ? data!.outcome : "unproven";
    context.ui?.notify?.(`Package decision: ${outcome}. JSON/ticket linkage: ${data?.approval?.linkage === "complete" ? "verified complete" : "unproven"}.${data?.reused ? " Reused the issued decision; no new prompt." : ""} No implementation launched.`, "info");
  } else {
    context.ui?.notify?.("Package decision request not completed; a prior decision or partial linkage may exist.\nCondition: This confirmation/reconciliation did not establish complete linkage.\nSource: Native document decision owner.\nReason: Input, caller, source, revision, UI availability or linkage checks rejected; inspect the native result code and current package status.\nCorrection: Inspect pa_document status/show and preserve the original request revision before repair. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: authenticated package context and retained evidence.\nResume Action: Correct the proven cause, then reconcile the same unchanged request; do not supply an approval result, reset evidence or request a duplicate grant.", "error");
  }
  return result;
}
