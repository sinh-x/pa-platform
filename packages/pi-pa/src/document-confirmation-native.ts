import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { MODE_CAPABILITY_SESSION, capabilityToolSelected, DocumentPackageError, workflowDigest, type DocumentPackageHost } from "@pa-platform/pa-core";
import { authenticatePiDocumentCaller, assertSameDocumentCaller, confirmationDocumentCaller } from "./document-session.js";
import type { PiWorkflowContext } from "./workflow-native.js";
import type { DocumentConfirmationUi } from "./pi-extension/document-confirmation-ui.js";

export interface PiDocumentConfirmationContext extends PiWorkflowContext {
  readonly ui?: NonNullable<PiWorkflowContext["ui"]> & DocumentConfirmationUi;
}
/** This callback obtains a genuine native custom-UI selection directly. Generic
 * question answers, input source labels and JSON receipts are never inputs. */
export function createPiDocumentRetirement(context: PiDocumentConfirmationContext,
  authenticate = () => authenticatePiDocumentCaller(context), signal?: AbortSignal): NonNullable<DocumentPackageHost["retire"]> {
  return async request => {
    const before = authenticate();
    if (before.profile !== MODE_CAPABILITY_SESSION || !before.capabilities || !capabilityToolSelected(before.capabilities.policy, "pa_document") || !before.sessionId || context.mode !== "tui" || !context.ui?.custom) throw new DocumentPackageError("DOCUMENT_UNAVAILABLE");
    if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const interactionId = `interaction-${randomUUID()}`;
    const { showDocumentConfirmation } = await import("./pi-extension/document-confirmation-ui.js");
    const outcome = await showDocumentConfirmation(context.ui, request, signal);
    if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    assertSameDocumentCaller(before, authenticate());
    if (!["approved", "rejected", "changes-requested", "cancelled"].includes(outcome)) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const principal = `local-uid:${userInfo().uid}`;
    const nativeEvidence = Buffer.from(JSON.stringify({ schemaVersion: "pa-native-document-retirement/v1", method: "pi-native-retirement", interactionId, principal, caller: before,
      request, outcome, boundary: "trusted-managed-extension-local-tui-not-hostile-same-uid-isolation" }));
    return { outcome, principal, interactionId, evidenceSha256: workflowDigest(nativeEvidence), nativeEvidence };
  };
}
export function createPiDocumentConfirmation(context: PiDocumentConfirmationContext,
  authenticate = () => authenticatePiDocumentCaller(context), signal?: AbortSignal): NonNullable<DocumentPackageHost["confirm"]> {
  return async request => {
    const before = authenticate();
    if (!confirmationDocumentCaller(before) || !before.sessionId || context.mode !== "tui" || !context.ui?.custom) throw new DocumentPackageError("DOCUMENT_UNAVAILABLE");
    if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const interactionId = `interaction-${randomUUID()}`;
    const { showDocumentConfirmation } = await import("./pi-extension/document-confirmation-ui.js");
    const outcome = await showDocumentConfirmation(context.ui, request, signal);
    if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    assertSameDocumentCaller(before, authenticate());
    if (!["approved", "rejected", "changes-requested", "cancelled"].includes(outcome)) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const principal = `local-uid:${userInfo().uid}`;
    const nativeEvidence = Buffer.from(JSON.stringify({ schemaVersion: "pa-native-document-confirmation/v1", confirmationMethod: "pi-native-confirmation", interactionId, principal,
      caller: before, subjectSha256: request.sha256, scope: request.scope, operation: request.operation, revokes: request.revokes, supersedes: request.supersedes,
      displayedDocuments: request.documents.map(d => ({ id: d.id, sha256: d.sha256, mediaType: d.mediaType })), outcome,
      boundary: "trusted-managed-extension-local-tui-not-hostile-same-uid-isolation" }));
    return { outcome, principal, interactionId, evidenceSha256: workflowDigest(nativeEvidence), nativeEvidence };
  };
}
