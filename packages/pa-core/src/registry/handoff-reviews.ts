import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { digest, ID, integer, object, oneOf, SHA256, strictJson, text } from "../workflows/contracts.js";
import { documentGuard, documentPackageSha, documentReject, type DocumentPackage } from "../documents/package-contract.js";
import { handoffBranchIntentSha, handoffReviewSubjectSha, parseHandoffBranchIntent, parseHandoffReviewSubject, type HandoffBranchIntent, type HandoffReviewSubject } from "../documents/handoff-contract.js";
import { documentPending, RegistryDocumentJournal } from "./documents.js";
import { RegistryHandoffBranchJournal, handoffBranchOperationId } from "../documents/handoff-branch.js";

export interface HandoffReviewRequest {
  schemaVersion: "pa-handoff-native-request/v1"; requestKey: string; decisionId: string;
  subjectSha256: string; expectedRevision: number; operation: "capture" | "revoke"; targetDecisionId: string | null;
  callerIdentitySha256: string; selectionSha256: string; deploymentId: string; sessionId: string; requestedAt: string;
}
export interface HandoffIssuedDecision {
  requestKey: string; outcome: "approved" | "changes-requested" | "rejected" | "cancelled";
  principal: string; interactionId: string; evidenceSha256: string; recordedAt: string;
}
export type HandoffReviewEvent = { revision: number; predecessor: string | null } & (
  { kind: "requested"; request: HandoffReviewRequest } | { kind: "issued"; decision: HandoffIssuedDecision });
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function time(value: unknown): string {
  const at = text(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  if (new Date(at).toISOString() !== at) documentReject("DOCUMENT_INPUT"); return at;
}
export function handoffReviewRequestKey(subjectSha256: string, expectedRevision: number, operation: HandoffReviewRequest["operation"], target: string | null): string {
  return digest(json([text(subjectSha256, SHA256), integer(expectedRevision, 0, 1021), oneOf(operation, ["capture", "revoke"]), target]));
}
function request(value: unknown): HandoffReviewRequest {
  const r = object(value, ["schemaVersion", "requestKey", "decisionId", "subjectSha256", "expectedRevision", "operation", "targetDecisionId", "callerIdentitySha256", "selectionSha256", "deploymentId", "sessionId", "requestedAt"]);
  if (r.schemaVersion !== "pa-handoff-native-request/v1") documentReject("DOCUMENT_INPUT");
  text(r.requestKey, SHA256); text(r.subjectSha256, SHA256); text(r.decisionId, ID); integer(r.expectedRevision, 0, 1021);
  oneOf(r.operation, ["capture", "revoke"]); text(r.callerIdentitySha256, SHA256); text(r.selectionSha256, SHA256);
  text(r.deploymentId, /^d-[a-f0-9]{6}$/); text(r.sessionId, undefined, 256); time(r.requestedAt);
  if (r.operation === "capture" ? r.targetDecisionId !== null : typeof r.targetDecisionId !== "string") documentReject("DOCUMENT_INPUT");
  if (r.targetDecisionId !== null) text(r.targetDecisionId, ID);
  const result = r as unknown as HandoffReviewRequest;
  if (handoffReviewRequestKey(result.subjectSha256, result.expectedRevision, result.operation, result.targetDecisionId) !== result.requestKey) documentReject("DOCUMENT_INPUT");
  return structuredClone(result);
}
function issued(value: unknown): HandoffIssuedDecision {
  const d = object(value, ["requestKey", "outcome", "principal", "interactionId", "evidenceSha256", "recordedAt"]);
  text(d.requestKey, SHA256); oneOf(d.outcome, ["approved", "changes-requested", "rejected", "cancelled"]);
  text(d.principal, /^local-uid:\d{1,20}$/); text(d.interactionId, ID); text(d.evidenceSha256, SHA256); time(d.recordedAt);
  return structuredClone(d) as unknown as HandoffIssuedDecision;
}
/** NEW native provenance, never an old document confirmation/receipt. No public
 * outcome/principal import. Only the trusted foreground service calls capture. */
export class RegistryHandoffReviewJournal {
  readonly documents: RegistryDocumentJournal;
  constructor(private readonly db: Database.Database) {
    if (db.pragma("synchronous", { simple: true }) !== 2) documentReject("DOCUMENT_UNAVAILABLE");
    this.documents = new RegistryDocumentJournal(db);
    db.exec(`CREATE TABLE IF NOT EXISTS handoff_review_subjects(sha256 TEXT PRIMARY KEY, body TEXT NOT NULL, intent TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoff_review_events(subject_sha TEXT NOT NULL, revision INTEGER NOT NULL, sha256 TEXT NOT NULL, body TEXT NOT NULL,
        decision_claim TEXT UNIQUE, interaction_claim TEXT UNIQUE, PRIMARY KEY(subject_sha,revision));
      CREATE TABLE IF NOT EXISTS handoff_review_captures(request_key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, raw BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS handoff_review_effects(operation_id TEXT PRIMARY KEY, body TEXT NOT NULL, result TEXT);`);
  }
  transaction<T>(run: () => T): T { return this.db.transaction(run).immediate(); }
  freeze(rawSubject: HandoffReviewSubject, rawIntent: HandoffBranchIntent): string {
    const subject = parseHandoffReviewSubject(rawSubject), intent = parseHandoffBranchIntent(rawIntent), sha256 = handoffReviewSubjectSha(subject);
    const document = this.documents.subject(subject.documentSubjectSha256);
    if (subject.branchIntentSha256 !== handoffBranchIntentSha(intent) || subject.callerIdentitySha256 !== intent.callerIdentitySha256
      || document.ticket !== intent.ticket || document.repository.key !== intent.repository.key || document.repository.root !== intent.repository.root
      || subject.effects.queue && !document.effects.queue) documentReject("DOCUMENT_AUTHORITY");
    document.members.forEach(member => this.documents.snapshot(member.sha256));
    this.transaction(() => {
      const existing = this.db.prepare("SELECT body,intent FROM handoff_review_subjects WHERE sha256=?").get(sha256) as { body: string; intent: string } | undefined;
      if (existing && (existing.body !== JSON.stringify(subject) || existing.intent !== JSON.stringify(intent))) documentReject("DOCUMENT_CONFLICT");
      this.db.prepare("INSERT OR IGNORE INTO handoff_review_subjects(sha256,body,intent) VALUES(?,?,?)").run(sha256, JSON.stringify(subject), JSON.stringify(intent));
      this.subject(sha256);
    }); return sha256;
  }
  subject(sha256: string): { subject: HandoffReviewSubject; intent: HandoffBranchIntent; document: DocumentPackage } {
    text(sha256, SHA256);
    const row = this.db.prepare("SELECT body,intent FROM handoff_review_subjects WHERE sha256=?").get(sha256) as { body: string; intent: string } | undefined;
    if (!row) return documentReject("DOCUMENT_SOURCE");
    const subject = parseHandoffReviewSubject(strictJson(Buffer.from(row.body), 65536)), intent = parseHandoffBranchIntent(strictJson(Buffer.from(row.intent), 65536));
    const document = this.documents.subject(subject.documentSubjectSha256);
    if (handoffReviewSubjectSha(subject) !== sha256 || handoffBranchIntentSha(intent) !== subject.branchIntentSha256 || documentPackageSha(document) !== subject.documentSubjectSha256
      || subject.callerIdentitySha256 !== intent.callerIdentitySha256 || intent.ticket !== document.ticket || intent.repository.key !== document.repository.key || intent.repository.root !== document.repository.root
      || subject.effects.queue && !document.effects.queue) documentReject("DOCUMENT_UNCERTAIN");
    return { subject, intent, document };
  }
  capture(requestKey: string): Buffer | null {
    const row = this.db.prepare("SELECT raw,sha256 FROM handoff_review_captures WHERE request_key=?").get(text(requestKey, SHA256)) as { raw: Buffer; sha256: string } | undefined;
    if (!row) return null;
    if (row.raw.length > 65536 || digest(row.raw) !== row.sha256) documentReject("DOCUMENT_UNCERTAIN");
    return Buffer.from(row.raw);
  }
  saveCapture(subjectSha256: string, requestKey: string, raw: Uint8Array): void {
    this.transaction(() => {
      if (!(raw instanceof Uint8Array) || raw.byteLength > 65536 || !this.events(subjectSha256).some(e => e.kind === "requested" && e.request.requestKey === requestKey)) documentReject("DOCUMENT_AUTHORITY");
      const before = this.capture(requestKey), bytes = Buffer.from(raw);
      if (before && !before.equals(bytes)) documentReject("DOCUMENT_CONFLICT");
      this.db.prepare("INSERT OR IGNORE INTO handoff_review_captures(request_key,sha256,raw) VALUES(?,?,?)").run(requestKey, digest(bytes), bytes);
      this.capture(requestKey);
    });
  }
  evidence(r: HandoffReviewRequest): Omit<HandoffIssuedDecision, "recordedAt"> {
    const raw = this.capture(r.requestKey); if (!raw) return documentReject("DOCUMENT_UNCERTAIN");
    return documentGuard(() => {
      const e = object(strictJson(raw, 65536), ["schemaVersion", "method", "request", "outcome", "principal", "interactionId", "boundary"]);
      if (e.schemaVersion !== "pa-handoff-native-evidence/v1" || e.method !== "pi-native-handoff-review"
        || !isDeepStrictEqual(request(e.request), r) || e.boundary !== "native-foreground-not-hostile-same-uid-isolation") documentReject("DOCUMENT_AUTHORITY");
      const d = issued({ requestKey: r.requestKey, outcome: e.outcome, principal: e.principal, interactionId: e.interactionId, evidenceSha256: digest(raw), recordedAt: r.requestedAt });
      const { recordedAt: _at, ...rest } = d; return rest;
    });
  }
  events(subjectSha256: string): HandoffReviewEvent[] {
    this.subject(subjectSha256);
    const rows = this.db.prepare("SELECT revision,sha256,body FROM handoff_review_events WHERE subject_sha=? ORDER BY revision LIMIT 1025").all(subjectSha256) as { revision: number; sha256: string; body: string }[];
    if (rows.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
    let predecessor: string | null = null; const events: HandoffReviewEvent[] = [];
    for (const row of rows) {
      const value = strictJson(Buffer.from(row.body), 65536), k = (value as { kind?: unknown }).kind;
      const e = object(value, ["revision", "predecessor", "kind", k === "requested" ? "request" : "decision"]);
      if (row.revision !== events.length + 1 || e.revision !== row.revision || e.predecessor !== predecessor || digest(row.body) !== row.sha256) documentReject("DOCUMENT_UNCERTAIN");
      const event: HandoffReviewEvent = k === "requested" ? { revision: row.revision, predecessor, kind: "requested", request: request(e.request) }
        : k === "issued" ? { revision: row.revision, predecessor, kind: "issued", decision: issued(e.decision) } : documentReject("DOCUMENT_UNCERTAIN");
      this.transition(subjectSha256, events, event); events.push(event); predecessor = row.sha256;
    } return events;
  }
  private transition(sha: string, prior: HandoffReviewEvent[], next: HandoffReviewEvent): void {
    const last = prior.at(-1), { subject } = this.subject(sha);
    if (next.kind === "requested") {
      const r = next.request;
      if (last?.kind === "requested" || r.expectedRevision !== prior.length || r.subjectSha256 !== sha || r.callerIdentitySha256 !== subject.callerIdentitySha256
        || r.selectionSha256 !== subject.selectionSha256 || prior.some(e => e.kind === "requested" && (e.request.requestKey === r.requestKey || e.request.decisionId === r.decisionId))) documentReject("DOCUMENT_CONFLICT");
      if (r.operation === "revoke") this.approvedFrom(prior, r.targetDecisionId!);
    } else {
      if (last?.kind !== "requested" || last.request.requestKey !== next.decision.requestKey) documentReject("DOCUMENT_CONFLICT");
      const { recordedAt: _at, ...d } = next.decision;
      if (!isDeepStrictEqual(d, this.evidence(last.request))) documentReject("DOCUMENT_AUTHORITY");
    }
  }
  /** New bytes/subject cannot evade this owner's unresolved ticket history.
   * Revocation remains possible during partial effects; it grants no new write. */
  private assertNoOtherPending(sha: string, newRequest = false): void {
    const { document } = this.subject(sha);
    if (documentPending(this.documents.events(document.repository.key, document.ticket)).length) documentReject("DOCUMENT_UNCERTAIN");
    const rows = this.db.prepare("SELECT sha256 FROM handoff_review_subjects LIMIT 1025").all() as { sha256: string }[];
    if (rows.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
    for (const row of rows) {
      if (row.sha256 === sha && !newRequest) continue;
      const other = this.subject(row.sha256).document;
      if (other.ticket !== document.ticket || other.repository.key !== document.repository.key) continue;
      const events = this.events(row.sha256);
      if (events.at(-1)?.kind === "requested") documentReject("DOCUMENT_UNCERTAIN");
      for (const event of events) if (event.kind === "requested" && event.request.operation === "capture") {
        for (const operation of ["publish", "queue"] as const) {
          const effect = this.effect(row.sha256, event.request.decisionId, operation);
          if (effect.started && !effect.completed) documentReject("DOCUMENT_UNCERTAIN");
        }
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_branch_events'").get()) {
          const branch = new RegistryHandoffBranchJournal(this.db).events(handoffBranchOperationId(row.sha256, event.request.decisionId));
          if (branch.length && branch.at(-1)?.kind !== "complete") documentReject("DOCUMENT_UNCERTAIN");
        }
      }
    }
  }
  appendRequest(raw: HandoffReviewRequest): void {
    const r = request(raw);
    this.transaction(() => {
      if (r.operation === "capture") this.assertNoOtherPending(r.subjectSha256, true);
      this.append(r.subjectSha256, r.expectedRevision, { kind: "requested", request: r });
    });
  }
  issue(sha: string, r: HandoffReviewRequest, recordedAt: string): HandoffIssuedDecision {
    const decision = { ...this.evidence(r), recordedAt: time(recordedAt) };
    this.append(sha, this.events(sha).length, { kind: "issued", decision }); return decision;
  }
  private append(sha: string, revision: number, data: { kind: "requested"; request: HandoffReviewRequest } | { kind: "issued"; decision: HandoffIssuedDecision }): void {
    this.transaction(() => {
      const prior = this.events(sha); if (prior.length !== revision) documentReject("DOCUMENT_CONFLICT");
      const last = this.db.prepare("SELECT sha256 FROM handoff_review_events WHERE subject_sha=? ORDER BY revision DESC LIMIT 1").get(sha) as { sha256: string } | undefined;
      const event = { revision: revision + 1, predecessor: last?.sha256 ?? null, ...data } as HandoffReviewEvent;
      this.transition(sha, prior, event);
      const body = JSON.stringify(event);
      this.db.prepare("INSERT INTO handoff_review_events(subject_sha,revision,sha256,body,decision_claim,interaction_claim) VALUES(?,?,?,?,?,?)")
        .run(sha, event.revision, digest(body), body, data.kind === "requested" ? data.request.decisionId : null, data.kind === "issued" ? data.decision.interactionId : null);
      this.events(sha);
    });
  }
  private approvedFrom(events: HandoffReviewEvent[], decisionId: string): HandoffReviewRequest {
    const latest = events.filter(e => e.kind === "requested" && e.request.operation === "capture").at(-1);
    const issued = latest?.kind === "requested" ? events.find(e => e.kind === "issued" && e.decision.requestKey === latest.request.requestKey) : undefined;
    if (latest?.kind !== "requested" || latest.request.decisionId !== decisionId || issued?.kind !== "issued" || issued.decision.outcome !== "approved"
      || events.some(e => e.kind === "requested" && e.request.operation === "revoke" && e.request.targetDecisionId === decisionId
        && events.some(d => d.kind === "issued" && d.decision.requestKey === e.request.requestKey && d.decision.outcome === "approved"))) documentReject("DOCUMENT_AUTHORITY");
    return latest.request;
  }
  approved(sha: string, decisionId: string, effect: "publish" | "branchRef" | "queue"): HandoffReviewRequest {
    this.assertNoOtherPending(sha);
    const events = this.events(sha), r = this.approvedFrom(events, text(decisionId, ID));
    if (events.at(-1)?.kind === "requested" || !this.subject(sha).subject.effects[effect]) documentReject("DOCUMENT_AUTHORITY");
    return r;
  }
  /** Durable original effect identity, separate from legacy document intents. */
  effect(sha: string, decisionId: string, operation: "publish" | "queue", start = false): { operationId: string; started: boolean; completed: boolean } {
    const operationId = digest(json(["pa-handoff-effect/v1", text(sha, SHA256), text(decisionId, ID), oneOf(operation, ["publish", "queue"])]));
    const body = JSON.stringify({ subjectSha256: sha, decisionId, operation });
    const row = this.db.prepare("SELECT body,result FROM handoff_review_effects WHERE operation_id=?").get(operationId) as { body: string; result: string | null } | undefined;
    if (row && (row.body !== body || row.result !== null && row.result !== "completed")) documentReject("DOCUMENT_UNCERTAIN");
    if (start && !row) { this.approved(sha, decisionId, operation); this.db.prepare("INSERT INTO handoff_review_effects(operation_id,body) VALUES(?,?)").run(operationId, body); }
    return { operationId, started: row !== undefined || start, completed: row?.result === "completed" };
  }
  completeEffect(sha: string, decisionId: string, operation: "publish" | "queue"): void {
    const { operationId } = this.effect(sha, decisionId, operation);
    const changed = this.db.prepare("UPDATE handoff_review_effects SET result='completed' WHERE operation_id=?").run(operationId);
    if (changed.changes !== 1) documentReject("DOCUMENT_UNCERTAIN");
  }
}
