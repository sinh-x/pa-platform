import type Database from "better-sqlite3";
import { digest, ID, integer, object, oneOf, SHA256, strictJson, text, workflowTicket } from "../workflows/contracts.js";
import { documentGuard, documentPackageSha, documentReject, DOCUMENT_LIMITS, parseDocumentPackage, type DocumentPackage } from "../documents/package-contract.js";

export interface DocumentDecision { decisionId: string; subjectSha256: string; outcome: "approved" | "rejected" | "changes-requested" | "cancelled"; principal: string; evidenceSha256: string; callerIdentity: string }
export interface DocumentIntent { operationId: string; subjectSha256: string; decisionId: string; operation: "publish" | "queue" }
export type DocumentEventData = { kind: "frozen"; subjectSha256: string }
  | ({ kind: "decision" } & DocumentDecision)
  | { kind: "revoked"; subjectSha256: string; decisionId: string; evidenceSha256: string }
  | ({ kind: "intent" } & DocumentIntent)
  | { kind: "result"; subjectSha256: string; operationId: string; outcome: "completed" | "failed" | "unknown"; code: string };
export interface DocumentEvent { schemaVersion: "pa-document-event/v1"; repoKey: string; ticket: string; revision: number; predecessor: string | null; data: DocumentEventData }
function eventData(value: unknown): DocumentEventData {
  const row = value as Record<string, unknown>;
  const fields = row?.kind === "frozen" ? ["kind", "subjectSha256"] : row?.kind === "decision" ? ["kind", "subjectSha256", "decisionId", "outcome", "principal", "evidenceSha256", "callerIdentity"]
    : row?.kind === "revoked" ? ["kind", "subjectSha256", "decisionId", "evidenceSha256"] : row?.kind === "intent" ? ["kind", "subjectSha256", "operationId", "decisionId", "operation"]
      : row?.kind === "result" ? ["kind", "subjectSha256", "operationId", "outcome", "code"] : [];
  if (!fields.length) documentReject("DOCUMENT_UNCERTAIN");
  const r = object(value, fields); text(r.subjectSha256, SHA256);
  if (r.kind === "decision") { text(r.decisionId, ID); oneOf(r.outcome, ["approved", "rejected", "changes-requested", "cancelled"]); text(r.principal); text(r.evidenceSha256, SHA256); text(r.callerIdentity, SHA256); }
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
      for (const raw of snapshots) {
        if (raw.byteLength > DOCUMENT_LIMITS.memberBytes) documentReject("DOCUMENT_INPUT");
        const sha256 = digest(raw); this.db.prepare("INSERT OR IGNORE INTO document_snapshots (sha256, raw) VALUES (?, ?)").run(sha256, raw); this.snapshot(sha256);
      }
      if ((data.kind === "decision" || data.kind === "revoked") && digest(this.snapshot(data.evidenceSha256)) !== data.evidenceSha256) documentReject("DOCUMENT_UNCERTAIN");
      const last = this.db.prepare("SELECT sha256 FROM document_events WHERE repo_key = ? AND ticket = ? ORDER BY revision DESC LIMIT 1").get(repoKey, ticket) as { sha256: string } | undefined;
      const event: DocumentEvent = { schemaVersion: "pa-document-event/v1", repoKey, ticket, revision: expectedRevision + 1, predecessor: last?.sha256 ?? null, data };
      const body = JSON.stringify(event);
      this.db.prepare("INSERT INTO document_events (repo_key, ticket, revision, predecessor, sha256, body) VALUES (?, ?, ?, ?, ?, ?)").run(repoKey, ticket, event.revision, event.predecessor, digest(body), body);
      return event;
    }).immediate());
  }
}
export function documentDecisions(events: DocumentEvent[], sha256: string): DocumentDecision[] {
  const revoked = events.flatMap(e => e.data.kind === "revoked" ? [e.data.decisionId] : []);
  return events.flatMap(e => e.data.kind === "decision" && e.data.subjectSha256 === sha256 && !revoked.includes(e.data.decisionId) ? [e.data] : []);
}
export function documentCompletedOperation(events: DocumentEvent[], sha256: string, operation: DocumentIntent["operation"]): boolean {
  const completed = new Set(events.flatMap(e => e.data.kind === "result" && e.data.outcome === "completed" ? [e.data.operationId] : []));
  return events.some(e => e.data.kind === "intent" && e.data.subjectSha256 === sha256 && e.data.operation === operation && completed.has(e.data.operationId));
}
export function documentPending(events: DocumentEvent[]): DocumentIntent[] {
  const completed = new Set(events.flatMap(e => e.data.kind === "result" && e.data.outcome === "completed" ? [e.data.operationId] : []));
  return events.flatMap(e => e.data.kind === "intent" && !completed.has(e.data.operationId) ? [e.data] : []);
}
