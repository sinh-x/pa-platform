import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { documentDecisionRecords, documentPending, retirementRequestKey, type DocumentRetirementConsent, type RegistryDocumentJournal } from "../registry/documents.js";
import { TicketPackagePublication } from "../tickets/package-publication.js";
import { digest, ID, integer, SHA256, text } from "../workflows/contracts.js";
import { DocumentPackageError, documentPackageSha, documentReject, type DocumentPackage } from "./package-contract.js";
import type { DocumentPackageHost } from "./package-service.js";

/** Exact persisted intent inspection. All facts are derived under the common
 * ticket mutex; a supplied hash is a comparison coordinate, never authority. */
export function diagnosePublication(journal: RegistryDocumentJournal, host: DocumentPackageHost, subject: DocumentPackage, request: Record<string, unknown>, recheckRevision?: number) {
  if (!host.recoveryProfile) documentReject("DOCUMENT_UNAVAILABLE");
  const before = host.authenticate(), sha256 = documentPackageSha(subject);
  const expectedRevision = integer(request.expectedRevision, 0, 1023), operationId = text(request.operationId, ID), decisionId = text(request.decisionId, ID);
  return host.tickets.withWorkflowTransaction(() => {
    const caller = host.authenticate();
    if (!isDeepStrictEqual(before, caller) || caller.repoKey !== subject.repository.key || caller.repoRoot !== subject.repository.root || caller.ticket !== subject.ticket) documentReject("DOCUMENT_AUTHORITY");
    const events = journal.events(subject.repository.key, subject.ticket);
    if (events.length !== (recheckRevision ?? expectedRevision)) documentReject("DOCUMENT_CONFLICT");
    const original = events.find(e => e.data.kind === "intent" && e.data.operationId === operationId);
    if (!original || original.data.kind !== "intent" || original.data.subjectSha256 !== sha256 || original.data.decisionId !== decisionId) documentReject("DOCUMENT_AUTHORITY");
    const decision = documentDecisionRecords(events, sha256).find(d => d.decisionId === decisionId);
    if (!decision || decision.outcome !== "approved" || operationId !== `effect-${digest(JSON.stringify([sha256, decisionId, original.data.operation]))}`) documentReject("DOCUMENT_AUTHORITY");
    journal.snapshot(decision.evidenceSha256);
    let custody: "available" | DocumentPackageError["code"] = "available";
    try { host.assertEffectAvailable(subject); } catch (error) { custody = error instanceof DocumentPackageError ? error.code : "DOCUMENT_UNCERTAIN"; }
    const observation = new TicketPackagePublication(host.tickets, host.artifactRoot).diagnose(subject);
    const pending = documentPending(events);
    const historicalResults = events.flatMap(e => e.data.kind === "result" && e.data.operationId === operationId ? [{ revision: e.revision, ...e.data }] : []);
    const eligible = custody === "available" && observation.eligible && original.data.operation === "publish" && subject.predecessor === null
      && pending.length === 1 && pending[0]!.operationId === operationId
      && !events.some(e => e.data.kind === "result" && e.data.subjectSha256 === sha256 && e.data.outcome === "completed")
      && !events.some(e => e.data.kind === "intent" && e.data.subjectSha256 === sha256 && e.data.operation === "queue");
    const facts = { schemaVersion: "pa-document-publication-diagnosis/v1", repository: subject.repository, ticket: subject.ticket, sha256, operationId, decisionId, expectedRevision,
      originalRequestSha256: digest(JSON.stringify(original)), originalIntentRevision: original.revision, custody, observation, historicalResults, eligible,
      cause: "Original internal failure cause is unproven; retained result codes are historical evidence, not a diagnosis." };
    if (!isDeepStrictEqual(before, host.authenticate())) documentReject("DOCUMENT_STALE");
    return { ...facts, observationSha256: digest(JSON.stringify(facts)), settled: false };
  });
}

export type PublicationDiagnosis = ReturnType<typeof diagnosePublication>;
export interface NativeRetirementRequest {
  subject: DocumentPackage; diagnosis: PublicationDiagnosis; requestId: string; requestKey: string;
}
export interface NativeRetirementResult {
  outcome: DocumentRetirementConsent["outcome"]; principal: string; interactionId: string;
  evidenceSha256: string; nativeEvidence: Uint8Array;
}

/** The consent event is durable issuance, not settlement. An interrupted exact
 * request resumes from it without a second prompt. Only the terminal event
 * releases pending AND fences the subject, in the same registry append. */
export async function retirePublication(journal: RegistryDocumentJournal, host: DocumentPackageHost, subject: DocumentPackage, request: Record<string, unknown>) {
  if (!host.recoveryProfile || !host.retire) documentReject("DOCUMENT_UNAVAILABLE");
  const before = host.authenticate();
  if (!before.sessionId || before.ticket !== subject.ticket) documentReject("DOCUMENT_AUTHORITY");
  const coordinates = { subjectSha256: documentPackageSha(subject), operationId: text(request.operationId, ID), decisionId: text(request.decisionId, ID),
    requestId: text(request.requestId, ID), expectedRevision: integer(request.expectedRevision, 0, 1022),
    originalRequestSha256: text(request.originalRequestSha256, SHA256), observationSha256: text(request.observationSha256, SHA256) };
  const requestKey = retirementRequestKey(coordinates);
  const same = () => { if (!isDeepStrictEqual(before, host.authenticate())) documentReject("DOCUMENT_STALE"); };
  const events = () => journal.events(subject.repository.key, subject.ticket);
  const reobserve = (revision: number) => {
    same();
    const diagnosis = diagnosePublication(journal, host, subject, request, revision);
    if (!diagnosis.eligible || diagnosis.observationSha256 !== coordinates.observationSha256 || diagnosis.originalRequestSha256 !== coordinates.originalRequestSha256) documentReject("DOCUMENT_CONFLICT");
    return diagnosis;
  };
  const existing = events().find(e => e.data.kind === "retirement-consent" && e.data.requestId === coordinates.requestId);
  let consent: DocumentRetirementConsent;
  let reused = false;
  if (existing && existing.data.kind === "retirement-consent") {
    consent = existing.data; reused = true;
    if (consent.requestKey !== requestKey || consent.callerIdentity !== before.identitySha256 || consent.deploymentId !== before.deploymentId || consent.sessionId !== before.sessionId) documentReject("DOCUMENT_AUTHORITY");
    journal.snapshot(consent.evidenceSha256); journal.snapshot(consent.observationEvidenceSha256);
  } else {
    const diagnosis = reobserve(coordinates.expectedRevision);
    // Never hold the ticket mutex while waiting for the native operator.
    const capture = await host.retire({ subject, diagnosis, requestId: coordinates.requestId, requestKey });
    if (digest(capture.nativeEvidence) !== capture.evidenceSha256) documentReject("DOCUMENT_AUTHORITY");
    consent = host.tickets.withWorkflowTransaction(() => {
      reobserve(coordinates.expectedRevision);
      const observation = Buffer.from(JSON.stringify(diagnosis));
      const data: DocumentRetirementConsent & { kind: "retirement-consent" } = { kind: "retirement-consent", ...coordinates, requestKey,
        consentId: `retirement-${randomUUID()}`, observationEvidenceSha256: digest(observation), outcome: capture.outcome, principal: capture.principal,
        interactionId: capture.interactionId, evidenceSha256: capture.evidenceSha256, callerIdentity: before.identitySha256,
        deploymentId: before.deploymentId, sessionId: before.sessionId!, recordedAt: new Date().toISOString() };
      journal.append(subject.repository.key, subject.ticket, coordinates.expectedRevision, data, [capture.nativeEvidence, observation]);
      return data;
    });
  }
  return host.tickets.withWorkflowTransaction(() => {
    same();
    let current = events();
    const retired = current.find(e => e.data.kind === "retired" && e.data.consentId === consent.consentId);
    if (!retired && consent.outcome === "approved") {
      reobserve(coordinates.expectedRevision + 1);
      journal.append(subject.repository.key, subject.ticket, coordinates.expectedRevision + 1, { kind: "retired", subjectSha256: coordinates.subjectSha256,
        operationId: coordinates.operationId, consentId: consent.consentId, observationSha256: consent.observationSha256 });
      current = events();
    }
    const settlement = current.find(e => e.data.kind === "retired" && e.data.consentId === consent.consentId);
    return { sha256: coordinates.subjectSha256, operationId: coordinates.operationId, requestId: consent.requestId, requestKey, consentId: consent.consentId,
      outcome: settlement ? "retired" : consent.outcome, settled: !!settlement, reused, expectedRevision: current.length,
      consentRef: `registry-document-event:${subject.repository.key}:${subject.ticket}:${coordinates.expectedRevision + 1}`,
      evidenceRef: `registry-document-snapshot:${consent.evidenceSha256}`, observationRef: `registry-document-snapshot:${consent.observationEvidenceSha256}`,
      settlementRef: settlement ? `registry-document-event:${subject.repository.key}:${subject.ticket}:${settlement.revision}` : null,
      message: settlement ? "The obsolete publication was retired. Existing partial files and references were kept; no old requirements were promoted. Next: review the corrected same-package revision for fresh approval." : "Retirement was not approved. Publication remains unresolved; preserve the original operation and evidence." };
  });
}
