import type Database from "better-sqlite3";
import { digest, ID, integer, object, oneOf, SHA256, strictJson, text, workflowTicket } from "../workflows/contracts.js";
import { documentGuard, documentPackageSha, documentReject, DOCUMENT_LIMITS, parseDocumentPackage, type DocumentPackage } from "../documents/package-contract.js";

export interface DocumentDecision { decisionId: string; subjectSha256: string; outcome: "approved" | "rejected" | "changes-requested" | "cancelled"; principal: string; evidenceSha256: string; callerIdentity: string }
export type DocumentConfirmationScope = "content" | "publish" | "publish-and-queue";
export interface DocumentConfirmation extends DocumentDecision {
  confirmationVersion: "pa-document-confirmation/v1"; method: "pi-native-confirmation";
  requestKey: string; scope: DocumentConfirmationScope; operation: "capture" | "revoke"; revokes: string | null; supersedes: string | null;
  interactionId: string; deploymentId: string; sessionId: string; recordedAt: string;
}
export interface DocumentAutoStart extends DocumentDecision {
  autoStartVersion: "pa-auto-start/v1"; method: "ppa-auto-foreground"; itemId: string; startSha256: string;
  requestKey: string; documentScope: "none" | "queue-only" | "publish-and-queue"; interactionId: string; recordedAt: string;
}
export interface DocumentIntent { operationId: string; subjectSha256: string; decisionId: string; operation: "publish" | "queue" }
export interface DocumentRetirementConsent {
  consentId: string; subjectSha256: string; operationId: string; decisionId: string;
  requestId: string; requestKey: string; expectedRevision: number; originalRequestSha256: string; observationSha256: string; observationEvidenceSha256: string;
  outcome: DocumentDecision["outcome"]; principal: string; interactionId: string; evidenceSha256: string;
  callerIdentity: string; deploymentId: string; sessionId: string; recordedAt: string;
}
export function retirementRequestKey(r: Pick<DocumentRetirementConsent, "subjectSha256" | "operationId" | "decisionId" | "requestId" | "expectedRevision" | "originalRequestSha256" | "observationSha256">): string {
  return digest(JSON.stringify([r.subjectSha256, r.operationId, r.decisionId, r.requestId, r.expectedRevision, r.originalRequestSha256, r.observationSha256]));
}
export type DocumentEventData = { kind: "frozen"; subjectSha256: string }
  | ({ kind: "decision" } & DocumentDecision)
  | ({ kind: "confirmation" } & DocumentConfirmation)
  | ({ kind: "auto-start" } & DocumentAutoStart)
  | { kind: "auto-proposal"; subjectSha256: string; itemId: string; startSha256: string }
  | { kind: "revoked"; subjectSha256: string; decisionId: string; evidenceSha256: string }
  | ({ kind: "intent" } & DocumentIntent)
  | ({ kind: "retirement-consent" } & DocumentRetirementConsent)
  | { kind: "retired"; subjectSha256: string; operationId: string; consentId: string; observationSha256: string }
  | { kind: "result"; subjectSha256: string; operationId: string; outcome: "completed" | "failed" | "unknown"; code: string };
export interface DocumentEvent { schemaVersion: "pa-document-event/v1"; repoKey: string; ticket: string; revision: number; predecessor: string | null; data: DocumentEventData }
function eventData(value: unknown): DocumentEventData {
  const row = value as Record<string, unknown>;
  const fields = row?.kind === "auto-proposal" ? ["kind", "subjectSha256", "itemId", "startSha256"] : row?.kind === "auto-start" ? ["kind", "decisionId", "subjectSha256", "outcome", "principal", "evidenceSha256", "callerIdentity", "autoStartVersion", "method", "itemId", "startSha256", "requestKey", "documentScope", "interactionId", "recordedAt"] : row?.kind === "retirement-consent" ? ["kind", "consentId", "subjectSha256", "operationId", "decisionId", "requestId", "requestKey", "expectedRevision", "originalRequestSha256", "observationSha256", "observationEvidenceSha256", "outcome", "principal", "interactionId", "evidenceSha256", "callerIdentity", "deploymentId", "sessionId", "recordedAt"]
    : row?.kind === "retired" ? ["kind", "subjectSha256", "operationId", "consentId", "observationSha256"] : row?.kind === "confirmation" ? ["kind", "subjectSha256", "decisionId", "outcome", "principal", "evidenceSha256", "callerIdentity", "confirmationVersion", "method", "requestKey", "scope", "operation", "revokes", "supersedes", "interactionId", "deploymentId", "sessionId", "recordedAt"] : row?.kind === "frozen" ? ["kind", "subjectSha256"] : row?.kind === "decision" ? ["kind", "subjectSha256", "decisionId", "outcome", "principal", "evidenceSha256", "callerIdentity"]
    : row?.kind === "revoked" ? ["kind", "subjectSha256", "decisionId", "evidenceSha256"] : row?.kind === "intent" ? ["kind", "subjectSha256", "operationId", "decisionId", "operation"]
      : row?.kind === "result" ? ["kind", "subjectSha256", "operationId", "outcome", "code"] : [];
  if (!fields.length) documentReject("DOCUMENT_UNCERTAIN");
  const r = object(value, fields); text(r.subjectSha256, SHA256);
  if (r.kind === "auto-proposal") { text(r.itemId, /^auto-[a-f0-9-]{36}$/); text(r.startSha256, SHA256); }
  if (r.kind === "auto-start") {
    if (r.autoStartVersion !== "pa-auto-start/v1" || r.method !== "ppa-auto-foreground") documentReject("DOCUMENT_UNCERTAIN");
    text(r.itemId, /^auto-[a-f0-9-]{36}$/); text(r.startSha256, SHA256); text(r.requestKey, SHA256); text(r.interactionId, ID);
    oneOf(r.documentScope, ["none", "queue-only", "publish-and-queue"]); text(r.recordedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
  if (r.kind === "retirement-consent") {
    for (const field of ["consentId", "operationId", "decisionId", "requestId", "interactionId"]) text(r[field], ID);
    for (const field of ["requestKey", "originalRequestSha256", "observationSha256", "observationEvidenceSha256", "evidenceSha256", "callerIdentity"]) text(r[field], SHA256);
    integer(r.expectedRevision, 0, 1022); oneOf(r.outcome, ["approved", "rejected", "changes-requested", "cancelled"]);
    text(r.principal); text(r.deploymentId, /^d-[0-9a-f]{6}$/); text(r.sessionId, undefined, 256);
    const at = text(r.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    if (new Date(at).toISOString() !== at) documentReject("DOCUMENT_UNCERTAIN");
  }
  if (r.kind === "retired") { text(r.operationId, ID); text(r.consentId, ID); text(r.observationSha256, SHA256); }
  if (r.kind === "confirmation") {
    if (r.confirmationVersion !== "pa-document-confirmation/v1" || r.method !== "pi-native-confirmation") documentReject("DOCUMENT_UNCERTAIN");
    text(r.requestKey, SHA256); oneOf(r.scope, ["content", "publish", "publish-and-queue"]); oneOf(r.operation, ["capture", "revoke"]);
    if (r.operation === "capture" ? r.revokes !== null : typeof r.revokes !== "string") documentReject("DOCUMENT_UNCERTAIN");
    if (r.revokes !== null) text(r.revokes, ID);
    if (r.supersedes !== null) text(r.supersedes, ID);
    if (r.operation === "revoke" && r.supersedes !== null) documentReject("DOCUMENT_UNCERTAIN");
    text(r.interactionId, ID); text(r.deploymentId, /^d-[0-9a-f]{6}$/); text(r.sessionId, undefined, 256);
    const recordedAt = text(r.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    if (new Date(recordedAt).toISOString() !== recordedAt) documentReject("DOCUMENT_UNCERTAIN");
  }
  if (r.kind === "decision" || r.kind === "confirmation" || r.kind === "auto-start") { text(r.decisionId, ID); oneOf(r.outcome, ["approved", "rejected", "changes-requested", "cancelled"]); text(r.principal); text(r.evidenceSha256, SHA256); text(r.callerIdentity, SHA256); }
  if (r.kind === "revoked") { text(r.decisionId, ID); text(r.evidenceSha256, SHA256); }
  if (r.kind === "intent") { text(r.operationId, ID); text(r.decisionId, ID); oneOf(r.operation, ["publish", "queue"]); }
  if (r.kind === "result") { text(r.operationId, ID); oneOf(r.outcome, ["completed", "failed", "unknown"]); text(r.code, /^[A-Z_]+$/); }
  return r as unknown as DocumentEventData;
}
/** Document evidence extension of the existing SQLite registry owner. No public
 * receipt import; no workflow graph replay or parallel permission store. */
export class RegistryDocumentJournal {
  constructor(private readonly db: Database.Database) {}
  events(repoKey: string, ticket: string): DocumentEvent[] {
    return documentGuard(() => {
      text(repoKey, ID); workflowTicket(ticket);
      const rows = this.db.prepare("SELECT revision, predecessor, sha256, body FROM document_events WHERE repo_key = ? AND ticket = ? ORDER BY revision LIMIT 1025").all(repoKey, ticket) as { revision: number; predecessor: string | null; sha256: string; body: string }[];
      if (rows.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
      let predecessor: string | null = null;
      return rows.map((row, index) => {
        const e = object(strictJson(Buffer.from(row.body), DOCUMENT_LIMITS.requestBytes), ["schemaVersion", "repoKey", "ticket", "revision", "predecessor", "data"]);
        if (e.schemaVersion !== "pa-document-event/v1" || e.repoKey !== repoKey || e.ticket !== ticket || e.revision !== index + 1 || row.revision !== e.revision || e.predecessor !== predecessor || row.predecessor !== predecessor || digest(row.body) !== row.sha256) documentReject("DOCUMENT_UNCERTAIN");
        const data = eventData(e.data); predecessor = row.sha256;
        return { ...e, data } as unknown as DocumentEvent;
      });
    });
  }
  subject(sha256: string): DocumentPackage {
    return documentGuard(() => {
      text(sha256, SHA256);
      const row = this.db.prepare("SELECT body FROM document_subjects WHERE sha256 = ?").get(sha256) as { body: string } | undefined;
      if (!row || digest(row.body) !== sha256) documentReject("DOCUMENT_SOURCE");
      const subject = parseDocumentPackage(strictJson(Buffer.from(row.body), DOCUMENT_LIMITS.requestBytes));
      if (documentPackageSha(subject) !== sha256) documentReject("DOCUMENT_UNCERTAIN");
      return subject;
    });
  }
  snapshot(sha256: string): Buffer {
    text(sha256, SHA256);
    const row = this.db.prepare("SELECT raw FROM document_snapshots WHERE sha256 = ?").get(sha256) as { raw: Buffer } | undefined;
    if (!row || row.raw.byteLength > DOCUMENT_LIMITS.memberBytes || digest(row.raw) !== sha256) documentReject("DOCUMENT_UNCERTAIN");
    return Buffer.from(row.raw);
  }
  /** CAS and all immutable bytes commit together; no SQL transaction spans UI or filesystem effects. */
  freeze(subjectInput: DocumentPackage, expectedRevision: number, bytes: readonly Uint8Array[]): string {
    const subject = parseDocumentPackage(subjectInput), sha256 = documentPackageSha(subject);
    return this.db.transaction(() => {
      if (this.events(subject.repository.key, subject.ticket).length !== expectedRevision) documentReject("DOCUMENT_CONFLICT");
      const existing = this.db.prepare("SELECT sha256 FROM document_subjects WHERE repo_key = ? AND ticket = ? AND package_id = ? AND revision = ?").get(subject.repository.key, subject.ticket, subject.packageId, subject.revision) as { sha256: string } | undefined;
      if (existing) { if (existing.sha256 !== sha256) documentReject("DOCUMENT_CONFLICT"); this.subject(sha256); return sha256; }
      if (bytes.length !== subject.members.length) documentReject();
      subject.members.forEach((member, index) => {
        const raw = bytes[index]!;
        if (raw.byteLength !== member.bytes || digest(raw) !== member.sha256) documentReject("DOCUMENT_STALE");
        this.db.prepare("INSERT OR IGNORE INTO document_snapshots (sha256, raw) VALUES (?, ?)").run(member.sha256, raw);
        this.snapshot(member.sha256);
      });
      this.db.prepare("INSERT INTO document_subjects (sha256, repo_key, ticket, package_id, revision, body) VALUES (?, ?, ?, ?, ?, ?)").run(sha256, subject.repository.key, subject.ticket, subject.packageId, subject.revision, JSON.stringify(subject));
      this.append(subject.repository.key, subject.ticket, expectedRevision, { kind: "frozen", subjectSha256: sha256 });
      return sha256;
    }).immediate();
  }
  append(repoKey: string, ticket: string, expectedRevision: number, input: DocumentEventData, snapshots: readonly Uint8Array[] = []): DocumentEvent {
    return documentGuard(() => this.db.transaction(() => {
      integer(expectedRevision, 0, 1023); const events = this.events(repoKey, ticket), data = eventData(input);
      if (events.length !== expectedRevision) documentReject("DOCUMENT_CONFLICT");
      const subject = this.subject(data.subjectSha256);
      if (subject.repository.key !== repoKey || subject.ticket !== ticket) documentReject("DOCUMENT_AUTHORITY");
      if ((data.kind === "intent" || data.kind === "result") && documentRetiredSubjects(events).has(data.subjectSha256)) documentReject("DOCUMENT_AUTHORITY");
      if (data.kind === "retirement-consent") {
        if (data.expectedRevision !== expectedRevision || retirementRequestKey(data) !== data.requestKey || events.some(e => e.data.kind === "retirement-consent" && (e.data.requestId === data.requestId || e.data.consentId === data.consentId || e.data.interactionId === data.interactionId))) documentReject("DOCUMENT_CONFLICT");
        const intent = events.find(e => e.data.kind === "intent" && e.data.operationId === data.operationId);
        if (!intent || intent.data.kind !== "intent" || intent.data.subjectSha256 !== data.subjectSha256 || intent.data.decisionId !== data.decisionId || intent.data.operation !== "publish" || digest(JSON.stringify(intent)) !== data.originalRequestSha256 || subject.predecessor !== null || documentPending(events).length !== 1 || documentPending(events)[0]?.operationId !== data.operationId || documentCompletedOperation(events, data.subjectSha256, "publish") || documentCompletedOperation(events, data.subjectSha256, "queue")) documentReject("DOCUMENT_AUTHORITY");
      }
      if (data.kind === "retired") {
        const consent = events.at(-1);
        if (!consent || consent.data.kind !== "retirement-consent" || consent.data.outcome !== "approved" || consent.data.consentId !== data.consentId || consent.data.subjectSha256 !== data.subjectSha256 || consent.data.operationId !== data.operationId || consent.data.observationSha256 !== data.observationSha256 || documentRetiredSubjects(events).has(data.subjectSha256) || !documentPending(events).some(i => i.operationId === data.operationId)) documentReject("DOCUMENT_AUTHORITY");
        this.snapshot(consent.data.evidenceSha256); this.snapshot(consent.data.observationEvidenceSha256);
      }
      if (data.kind === "auto-proposal" && events.some(e => e.data.kind === "auto-proposal" && e.data.itemId === data.itemId && e.data.startSha256 === data.startSha256)) documentReject("DOCUMENT_CONFLICT");
      if (data.kind === "auto-start") {
        if (!events.some(e => e.data.kind === "auto-proposal" && e.data.itemId === data.itemId && e.data.startSha256 === data.startSha256 && e.data.subjectSha256 === data.subjectSha256)
          || digest(this.snapshot(data.startSha256)) !== data.startSha256
          || data.requestKey !== digest(JSON.stringify([data.itemId, data.subjectSha256, data.startSha256, data.documentScope]))
          || events.some(e => e.data.kind === "auto-start" && (e.data.requestKey === data.requestKey || e.data.decisionId === data.decisionId || e.data.interactionId === data.interactionId))) documentReject("DOCUMENT_CONFLICT");
      }
      if (data.kind === "confirmation") {
        if (data.requestKey !== digest(JSON.stringify([data.subjectSha256, expectedRevision, data.operation, data.scope, data.revokes]))) documentReject("DOCUMENT_AUTHORITY");
        if (events.some(e => (e.data.kind === "confirmation" || e.data.kind === "decision") && e.data.decisionId === data.decisionId || e.data.kind === "confirmation" && (e.data.requestKey === data.requestKey || e.data.interactionId === data.interactionId))) documentReject("DOCUMENT_CONFLICT");
        if (data.operation === "capture" && data.supersedes !== (documentDecisionRecords(events, data.subjectSha256).at(-1)?.decisionId ?? null)) documentReject("DOCUMENT_AUTHORITY");
        if (data.operation === "revoke" && !events.some(e => e.data.kind === "confirmation" && e.data.operation === "capture" && e.data.subjectSha256 === data.subjectSha256 && e.data.decisionId === data.revokes && e.data.outcome === "approved" && !documentRevokedDecisionIds(events).has(e.data.decisionId))) documentReject("DOCUMENT_AUTHORITY");
      }
      for (const raw of snapshots) {
        if (raw.byteLength > DOCUMENT_LIMITS.memberBytes) documentReject("DOCUMENT_INPUT");
        const sha256 = digest(raw); this.db.prepare("INSERT OR IGNORE INTO document_snapshots (sha256, raw) VALUES (?, ?)").run(sha256, raw); this.snapshot(sha256);
      }
      if ((data.kind === "decision" || data.kind === "confirmation" || data.kind === "auto-start" || data.kind === "revoked") && digest(this.snapshot(data.evidenceSha256)) !== data.evidenceSha256) documentReject("DOCUMENT_UNCERTAIN");
      if (data.kind === "retirement-consent") { this.snapshot(data.evidenceSha256); this.snapshot(data.observationEvidenceSha256); }
      const last = this.db.prepare("SELECT sha256 FROM document_events WHERE repo_key = ? AND ticket = ? ORDER BY revision DESC LIMIT 1").get(repoKey, ticket) as { sha256: string } | undefined;
      const event: DocumentEvent = { schemaVersion: "pa-document-event/v1", repoKey, ticket, revision: expectedRevision + 1, predecessor: last?.sha256 ?? null, data };
      const body = JSON.stringify(event);
      this.db.prepare("INSERT INTO document_events (repo_key, ticket, revision, predecessor, sha256, body) VALUES (?, ?, ?, ?, ?, ?)").run(repoKey, ticket, event.revision, event.predecessor, digest(body), body);
      return event;
    }).immediate());
  }
}
export function documentRevokedDecisionIds(events: DocumentEvent[]): Set<string> {
  return new Set(events.flatMap(e => e.data.kind === "revoked" ? [e.data.decisionId] : e.data.kind === "confirmation" && e.data.operation === "revoke" && e.data.outcome === "approved" && e.data.revokes ? [e.data.revokes] : []));
}
export function documentDecisionRecords(events: DocumentEvent[], sha256: string): ((DocumentDecision & { kind: "decision" }) | (DocumentConfirmation & { kind: "confirmation" }) | (DocumentAutoStart & { kind: "auto-start" }))[] {
  return events.flatMap(e => (e.data.kind === "decision" || e.data.kind === "confirmation" && e.data.operation === "capture" || e.data.kind === "auto-start" && e.data.documentScope === "publish-and-queue") && e.data.subjectSha256 === sha256 ? [e.data] : []);
}
export function documentDecisions(events: DocumentEvent[], sha256: string): DocumentDecision[] {
  const revoked = documentRevokedDecisionIds(events);
  return documentDecisionRecords(events, sha256).filter(d => !revoked.has(d.decisionId));
}
export function documentCompletedOperation(events: DocumentEvent[], sha256: string, operation: DocumentIntent["operation"]): boolean {
  const completed = new Set(events.flatMap(e => e.data.kind === "result" && e.data.outcome === "completed" ? [e.data.operationId] : []));
  return events.some(e => e.data.kind === "intent" && e.data.subjectSha256 === sha256 && e.data.operation === operation && completed.has(e.data.operationId));
}
export function documentRetiredSubjects(events: DocumentEvent[]): Set<string> {
  return new Set(events.flatMap(e => e.data.kind === "retired" ? [e.data.subjectSha256] : []));
}
export function documentPending(events: DocumentEvent[]): DocumentIntent[] {
  const completed = new Set(events.flatMap(e => e.data.kind === "retired" || e.data.kind === "result" && e.data.outcome === "completed" ? [e.data.operationId] : []));
  return events.flatMap(e => e.data.kind === "intent" && !completed.has(e.data.operationId) ? [e.data] : []);
}
