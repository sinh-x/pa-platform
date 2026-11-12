import { isDeepStrictEqual } from "node:util";
import { documentDecisionRecords, documentPending, type RegistryDocumentJournal } from "../registry/documents.js";
import { TicketPackagePublication } from "../tickets/package-publication.js";
import { digest, ID, integer, text } from "../workflows/contracts.js";
import { DocumentPackageError, documentPackageSha, documentReject, type DocumentPackage } from "./package-contract.js";
import type { DocumentPackageHost } from "./package-service.js";

/** Exact persisted intent inspection. All facts are derived under the common
 * ticket mutex; a supplied hash is a comparison coordinate, never authority. */
export function diagnosePublication(journal: RegistryDocumentJournal, host: DocumentPackageHost, subject: DocumentPackage, request: Record<string, unknown>) {
  if (!host.recoveryProfile) documentReject("DOCUMENT_UNAVAILABLE");
  const before = host.authenticate(), sha256 = documentPackageSha(subject);
  const expectedRevision = integer(request.expectedRevision, 0, 1023), operationId = text(request.operationId, ID), decisionId = text(request.decisionId, ID);
  return host.tickets.withWorkflowTransaction(() => {
    const caller = host.authenticate();
    if (!isDeepStrictEqual(before, caller) || caller.repoKey !== subject.repository.key || caller.repoRoot !== subject.repository.root || caller.ticket !== subject.ticket) documentReject("DOCUMENT_AUTHORITY");
    const events = journal.events(subject.repository.key, subject.ticket);
    if (events.length !== expectedRevision) documentReject("DOCUMENT_CONFLICT");
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
