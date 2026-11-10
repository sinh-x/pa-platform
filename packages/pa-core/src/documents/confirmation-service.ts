import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { digest, integer, oneOf, text, ID } from "../workflows/contracts.js";
import { documentRevokedDecisionIds, type DocumentConfirmation, type DocumentConfirmationScope, type DocumentEvent, type RegistryDocumentJournal } from "../registry/documents.js";
import { documentPackageSha, documentReject, type DocumentPackage } from "./package-contract.js";
import { documentText, readDocumentSources } from "./package-tools.js";
import { presentDocumentPackage } from "./presentation.js";
import { linkDocumentConfirmation } from "./confirmation-record.js";
import type { DocumentCaller, DocumentPackageHost } from "./package-service.js";

export interface NativeDocumentConfirmationRequest {
  subject: DocumentPackage; sha256: string; brief: string; scope: DocumentConfirmationScope;
  operation: "capture" | "revoke"; revokes: string | null; presentation: Record<string, unknown>;
  documents: { id: string; mediaType: string; content: string | null; sha256: string }[];
}
export interface NativeDocumentConfirmationResult {
  outcome: DocumentConfirmation["outcome"]; principal: string; interactionId: string;
  evidenceSha256: string; nativeEvidence: Uint8Array;
}
type ConfirmationEvent = DocumentEvent & { data: DocumentConfirmation & { kind: "confirmation" } };

/** Same native owner for model requests and operator command. Durable decision
 * is also the representation/linkage intent. No second grant database. */
export async function confirmDocument(journal: RegistryDocumentJournal, host: DocumentPackageHost, subject: DocumentPackage,
  caller: () => DocumentCaller, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!host.confirmationProfile || !host.confirm) documentReject("DOCUMENT_UNAVAILABLE");
  const before = caller();
  if (!before.sessionId) documentReject("DOCUMENT_AUTHORITY");
  const sha256 = documentPackageSha(subject), expectedRevision = integer(request.expectedRevision, 0, 1023);
  const operation = request.action === "confirm-revoke" ? "revoke" : "capture";
  const revokes = operation === "revoke" ? text(request.decisionId, ID) : null;
  let scope: DocumentConfirmationScope;
  if (operation === "capture") scope = oneOf(request.scope, ["content", "publish", "publish-and-queue"]);
  else {
    const target = journal.events(subject.repository.key, subject.ticket).find(e => e.data.kind === "confirmation" && e.data.operation === "capture" && e.data.subjectSha256 === sha256 && e.data.decisionId === revokes);
    if (!target || target.data.kind !== "confirmation" || target.data.outcome !== "approved") documentReject("DOCUMENT_AUTHORITY");
    scope = target.data.scope;
  }
  if (scope === "publish-and-queue" && !subject.effects.queue) documentReject("DOCUMENT_AUTHORITY");
  const requestKey = digest(JSON.stringify([sha256, expectedRevision, operation, scope, revokes]));
  const events = () => journal.events(subject.repository.key, subject.ticket);
  const same = () => { if (!isDeepStrictEqual(before, caller())) documentReject("DOCUMENT_STALE"); };
  const representation = (event: ConfirmationEvent, reused: boolean) => {
    same(); journal.snapshot(event.data.evidenceSha256);
    const approval = linkDocumentConfirmation(host.artifactRoot, host.tickets, subject, event);
    return { sha256, expectedRevision: events().length, outcome: event.data.outcome, decisionId: event.data.decisionId, scope: event.data.scope, operation, approval, reused,
      revoked: documentRevokedDecisionIds(events()).has(event.data.decisionId), executionAdmitted: false };
  };
  const existing = events().find(e => e.data.kind === "confirmation" && e.data.requestKey === requestKey);
  if (existing) return host.tickets.withWorkflowTransaction(() => representation(existing as ConfirmationEvent, true));
  const current = () => {
    same();
    if (events().length !== expectedRevision) documentReject("DOCUMENT_CONFLICT");
    if (operation === "revoke" && revokes && documentRevokedDecisionIds(events()).has(revokes)) documentReject("DOCUMENT_AUTHORITY");
    readDocumentSources(subject, host.artifactRoot);
  };
  current();
  const bytes = readDocumentSources(subject, host.artifactRoot);
  const brief = documentText(bytes[subject.members.findIndex(m => m.role === "brief")]!);
  if (Buffer.byteLength(brief) > 16384 || brief.trim().split(/\s+/).length > 1000) documentReject("DOCUMENT_INPUT");
  const presentation = presentDocumentPackage(subject, host.artifactRoot, sha => journal.snapshot(sha));
  const documents = subject.members.map(member => ({ id: member.id, mediaType: member.mediaType, sha256: member.sha256, content: member.mediaType.startsWith("text/") ? documentText(journal.snapshot(member.sha256)) : null }));
  const capture = await host.confirm({ subject, sha256, brief, scope, operation, revokes, presentation, documents });
  if (digest(capture.nativeEvidence) !== capture.evidenceSha256) documentReject("DOCUMENT_AUTHORITY");
  current();
  return host.tickets.withWorkflowTransaction(() => {
    current();
    if (events().some(e => e.data.kind === "confirmation" && e.data.interactionId === capture.interactionId)) documentReject("DOCUMENT_CONFLICT");
    const data: DocumentConfirmation & { kind: "confirmation" } = { kind: "confirmation", confirmationVersion: "pa-document-confirmation/v1", method: "pi-native-confirmation",
      decisionId: `decision-${randomUUID()}`, subjectSha256: sha256, outcome: capture.outcome, principal: capture.principal, evidenceSha256: capture.evidenceSha256,
      callerIdentity: before.identitySha256, interactionId: capture.interactionId, deploymentId: before.deploymentId, sessionId: before.sessionId!, recordedAt: new Date().toISOString(),
      requestKey, scope, operation, revokes };
    const event = journal.append(subject.repository.key, subject.ticket, expectedRevision, data, [capture.nativeEvidence]) as ConfirmationEvent;
    return representation(event, false);
  });
}
