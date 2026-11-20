import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { digest, ID, integer, object, oneOf, SHA256, strictJson, text } from "../workflows/contracts.js";
import { documentGuard, documentPackageSha, documentReject, type DocumentPackage } from "../documents/package-contract.js";
import { handoffBranchIntentSha, handoffReviewSubjectSha, parseHandoffBranchIntent, parseHandoffReviewSubject, type HandoffBranchIntent, type HandoffReviewSubject } from "../documents/handoff-contract.js";
import { documentPending, RegistryDocumentJournal } from "./documents.js";
import { contentReviewSubjectSha, parseContentReviewSubject, type ContentReviewSubject } from "../documents/content-review-contract.js";
import type { ContentPublicationAuthority, ContentReviewFence } from "../documents/content-publication-contract.js";
import { RegistryHandoffBranchJournal, handoffBranchOperationId } from "../documents/handoff-branch.js";

export interface HandoffReviewRequest {
  schemaVersion: "pa-handoff-native-request/v1" | "pa-handoff-local-request/v2" | "pa-content-review-request/v1"; requestKey: string; decisionId: string;
  subjectSha256: string; expectedRevision: number; operation: "capture" | "revoke"; targetDecisionId: string | null;
  callerIdentitySha256: string; selectionSha256: string; deploymentId: string; sessionId: string; requestedAt: string;
}
export interface HandoffIssuedDecision {
  requestKey: string; outcome: "approved" | "changes-requested" | "rejected" | "cancelled";
  principal: string; interactionId: string; evidenceSha256: string; recordedAt: string;
}
export interface HandoffStaleDisposition {
  requestKey: string | null; oldDevelopSha: string; newDevelopSha: string; observedAt: string;
}
export type HandoffReviewEvent = { revision: number; predecessor: string | null } & (
  { kind: "requested"; request: HandoffReviewRequest } | { kind: "issued"; decision: HandoffIssuedDecision }
  | { kind: "stale"; stale: HandoffStaleDisposition }
  | { kind: "publication-authorized"; authority: ContentPublicationAuthority }
  | { kind: "content-ineligible"; fence: ContentReviewFence });
function stale(value: unknown): HandoffStaleDisposition {
  const row = object(value, ["requestKey", "oldDevelopSha", "newDevelopSha", "observedAt"]);
  const result = { requestKey: row.requestKey === null ? null : text(row.requestKey, SHA256),
    oldDevelopSha: text(row.oldDevelopSha, /^[a-f0-9]{40}$/), newDevelopSha: text(row.newDevelopSha, /^[a-f0-9]{40}$/), observedAt: time(row.observedAt) };
  if (result.oldDevelopSha === result.newDevelopSha) documentReject("DOCUMENT_INPUT");
  return result;
}
function publicationAuthority(value: unknown): ContentPublicationAuthority {
  const row = object(value, ["schemaVersion", "contentDecisionId", "caller", "scope", "method", "authorizedAt"]);
  const caller = object(row.caller, ["callerIdentitySha256", "selectionSha256", "deploymentId", "sessionId"]);
  return { schemaVersion: oneOf(row.schemaVersion, ["pa-content-publication-authority/v1"]), contentDecisionId: text(row.contentDecisionId, ID),
    caller: { callerIdentitySha256: text(caller.callerIdentitySha256, SHA256), selectionSha256: text(caller.selectionSha256, SHA256),
      deploymentId: text(caller.deploymentId, /^d-[a-f0-9]{6}$/), sessionId: text(caller.sessionId, undefined, 256) },
    scope: oneOf(row.scope, ["publish-exact-content-only"]), method: oneOf(row.method, ["native-foreground-publication-confirmation"]), authorizedAt: time(row.authorizedAt) };
}
function contentFence(value: unknown): ContentReviewFence {
  const row = object(value, ["decisionId", "reason", "successor", "recordedAt"]);
  const reason = oneOf(row.reason, ["revoked", "superseded"]);
  if (reason === "revoked" && row.successor !== null || reason === "superseded" && row.successor === null) documentReject("DOCUMENT_INPUT");
  return { decisionId: text(row.decisionId, ID), reason, successor: row.successor === null ? null : text(row.successor, SHA256), recordedAt: time(row.recordedAt) };
}
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
  oneOf(r.schemaVersion, ["pa-handoff-native-request/v1", "pa-handoff-local-request/v2", "pa-content-review-request/v1"]);
  text(r.requestKey, SHA256); text(r.subjectSha256, SHA256); text(r.decisionId, ID); integer(r.expectedRevision, 0, 1021);
  oneOf(r.operation, ["capture", "revoke"]); text(r.callerIdentitySha256, SHA256); text(r.selectionSha256, SHA256);
  text(r.deploymentId, /^d-[a-f0-9]{6}$/); text(r.sessionId, undefined, 256); time(r.requestedAt);
  if (r.operation === "capture" ? r.targetDecisionId !== null : typeof r.targetDecisionId !== "string") documentReject("DOCUMENT_INPUT");
  if (r.targetDecisionId !== null) text(r.targetDecisionId, ID);
  const result = r as unknown as HandoffReviewRequest;
  if (handoffReviewRequestKey(result.subjectSha256, result.expectedRevision, result.operation, result.targetDecisionId) !== result.requestKey) documentReject("DOCUMENT_INPUT");
  return structuredClone(result);
}
function issued(value: unknown, local = false): HandoffIssuedDecision {
  const d = object(value, ["requestKey", "outcome", "principal", "interactionId", "evidenceSha256", "recordedAt"]);
  text(d.requestKey, SHA256); oneOf(d.outcome, ["approved", "changes-requested", "rejected", "cancelled"]);
  text(d.principal, local ? /^local-unverified$/ : /^local-uid:\d{1,20}$/); text(d.interactionId, ID); text(d.evidenceSha256, SHA256); time(d.recordedAt);
  return structuredClone(d) as unknown as HandoffIssuedDecision;
}
/** Shared handoff journal, never an old document confirmation/receipt. v1
 * accepts only native capture evidence. v2 generates unverified local evidence
 * atomically with issuance; its public input cannot set principal/provenance. */
export class RegistryHandoffReviewJournal {
  readonly documents: RegistryDocumentJournal;
  constructor(private readonly db: Database.Database, initialize = true) {
    if (!db.readonly && db.pragma("synchronous", { simple: true }) !== 2) documentReject("DOCUMENT_UNAVAILABLE");
    this.documents = new RegistryDocumentJournal(db);
    if (!initialize) return; // Existing-only status must never allocate journal tables.
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
  /** Content-only bindings live in the SAME native subjects/events/captures.
   * A null intent is mandatory, not a fabricated branch plan with false effects. */
  freezeContent(raw: ContentReviewSubject): string {
    const subject = parseContentReviewSubject(raw), sha = contentReviewSubjectSha(subject);
    this.documents.subject(subject.documentSubjectSha256).members.forEach(m => this.documents.snapshot(m.sha256));
    return this.transaction(() => {
      const existing = this.contentSubjects().find(value => value.subject.documentSubjectSha256 === subject.documentSubjectSha256 && value.subject.deliverySha256 === subject.deliverySha256);
      if (existing) return existing.sha256;
      this.db.prepare("INSERT INTO handoff_review_subjects(sha256,body,intent) VALUES(?,?,?)").run(sha, JSON.stringify(subject), "null");
      this.contentSubject(sha); return sha;
    });
  }
  contentSubject(sha256: string): { subject: ContentReviewSubject; document: DocumentPackage } {
    const row = this.db.prepare<[string], { body: string; intent: string }>("SELECT body,intent FROM handoff_review_subjects WHERE sha256=?").get(text(sha256, SHA256));
    if (!row) return documentReject("DOCUMENT_SOURCE");
    const subject = parseContentReviewSubject(strictJson(Buffer.from(row.body), 65536));
    if (row.intent !== "null" || contentReviewSubjectSha(subject) !== sha256) documentReject("DOCUMENT_UNCERTAIN");
    return { subject, document: this.documents.subject(subject.documentSubjectSha256) };
  }
  contentSubjects(): { sha256: string; subject: ContentReviewSubject; document: DocumentPackage }[] {
    const rows = this.db.prepare<[], { sha256: string }>("SELECT sha256 FROM handoff_review_subjects WHERE json_extract(body,'$.schemaVersion')='pa-content-review-subject/v1' LIMIT 1025").all();
    if (rows.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
    return rows.map(row => ({ sha256: row.sha256, ...this.contentSubject(row.sha256) }));
  }
  publicationSubject(sha256: string) {
    const subject = this.binding(sha256);
    return subject.schemaVersion === "pa-content-review-subject/v1" ? { ...this.contentSubject(sha256), intent: null } : this.subject(sha256);
  }
  private binding(sha256: string): HandoffReviewSubject | ContentReviewSubject {
    const row = this.db.prepare<[string], { body: string }>("SELECT body FROM handoff_review_subjects WHERE sha256=?").get(text(sha256, SHA256));
    if (!row) return documentReject("DOCUMENT_SOURCE");
    const head = object(strictJson(Buffer.from(row.body), 65536), ["schemaVersion"], ["documentSubjectSha256", "deliverySha256", "purpose", "callerIdentitySha256", "selectionSha256", "deploymentId", "sessionId", "branchIntentSha256", "effects", "origin"]);
    return head.schemaVersion === "pa-content-review-subject/v1" ? this.contentSubject(sha256).subject : this.subject(sha256).subject;
  }
  capture(requestKey: string): Buffer | null {
    const row = this.db.prepare("SELECT raw,sha256 FROM handoff_review_captures WHERE request_key=?").get(text(requestKey, SHA256)) as { raw: Buffer; sha256: string } | undefined;
    if (!row) return null;
    if (row.raw.length > 65536 || digest(row.raw) !== row.sha256) documentReject("DOCUMENT_UNCERTAIN");
    return Buffer.from(row.raw);
  }
  saveCapture(subjectSha256: string, requestKey: string, raw: Uint8Array): void {
    this.transaction(() => {
      if (this.subject(subjectSha256).subject.schemaVersion !== "pa-handoff-review/v1"
        || !(raw instanceof Uint8Array) || raw.byteLength > 65536 || !this.events(subjectSha256).some(e => e.kind === "requested" && e.request.requestKey === requestKey)) documentReject("DOCUMENT_AUTHORITY");
      const before = this.capture(requestKey), bytes = Buffer.from(raw);
      if (before && !before.equals(bytes)) documentReject("DOCUMENT_CONFLICT");
      this.db.prepare("INSERT OR IGNORE INTO handoff_review_captures(request_key,sha256,raw) VALUES(?,?,?)").run(requestKey, digest(bytes), bytes);
      this.capture(requestKey);
    });
  }
  evidence(r: HandoffReviewRequest): Omit<HandoffIssuedDecision, "recordedAt"> {
    const raw = this.capture(r.requestKey); if (!raw) return documentReject("DOCUMENT_UNCERTAIN");
    return documentGuard(() => {
      const local = this.binding(r.subjectSha256).schemaVersion !== "pa-handoff-review/v1";
      const e = object(strictJson(raw, 65536), ["schemaVersion", "method", "request", "outcome", "principal", "interactionId", "boundary", ...(local ? ["acceptedAt"] : [])]);
      if (local) {
        if (!["pa-handoff-local-request/v2", "pa-content-review-request/v1"].includes(r.schemaVersion) || e.schemaVersion !== "pa-handoff-local-evidence/v2"
          || e.method !== "unauthenticated-local-confirmation" || e.boundary !== "local-unverified-not-authenticated-human-consent") documentReject("DOCUMENT_AUTHORITY");
        time(e.acceptedAt);
      } else if (r.schemaVersion !== "pa-handoff-native-request/v1" || e.schemaVersion !== "pa-handoff-native-evidence/v1" || e.method !== "pi-native-handoff-review"
        || e.boundary !== "native-foreground-not-hostile-same-uid-isolation") documentReject("DOCUMENT_AUTHORITY");
      if (!isDeepStrictEqual(request(e.request), r)) documentReject("DOCUMENT_AUTHORITY");
      const d = issued({ requestKey: r.requestKey, outcome: e.outcome, principal: e.principal, interactionId: e.interactionId, evidenceSha256: digest(raw), recordedAt: local ? e.acceptedAt : r.requestedAt }, local);
      const { recordedAt: _at, ...rest } = d; return rest;
    });
  }
  events(subjectSha256: string): HandoffReviewEvent[] {
    const local = this.binding(subjectSha256).schemaVersion !== "pa-handoff-review/v1";
    const rows = this.db.prepare("SELECT revision,sha256,body FROM handoff_review_events WHERE subject_sha=? ORDER BY revision LIMIT 1025").all(subjectSha256) as { revision: number; sha256: string; body: string }[];
    if (rows.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
    let predecessor: string | null = null; const events: HandoffReviewEvent[] = [];
    for (const row of rows) {
      const value = strictJson(Buffer.from(row.body), 65536), k = (value as { kind?: unknown }).kind;
      const e = object(value, ["revision", "predecessor", "kind", k === "requested" ? "request" : k === "stale" ? "stale" : k === "publication-authorized" ? "authority" : k === "content-ineligible" ? "fence" : "decision"]);
      if (row.revision !== events.length + 1 || e.revision !== row.revision || e.predecessor !== predecessor || digest(row.body) !== row.sha256) documentReject("DOCUMENT_UNCERTAIN");
      const event: HandoffReviewEvent = k === "requested" ? { revision: row.revision, predecessor, kind: "requested", request: request(e.request) }
        : k === "issued" ? { revision: row.revision, predecessor, kind: "issued", decision: issued(e.decision, local) }
        : k === "stale" && local ? { revision: row.revision, predecessor, kind: "stale", stale: stale(e.stale) }
        : k === "publication-authorized" ? { revision: row.revision, predecessor, kind: "publication-authorized", authority: publicationAuthority(e.authority) }
        : k === "content-ineligible" ? { revision: row.revision, predecessor, kind: "content-ineligible", fence: contentFence(e.fence) } : documentReject("DOCUMENT_UNCERTAIN");
      this.transition(subjectSha256, events, event); events.push(event); predecessor = row.sha256;
    } return events;
  }
  private transition(sha: string, prior: HandoffReviewEvent[], next: HandoffReviewEvent): void {
    const last = prior.at(-1), subject = this.binding(sha);
    if (next.kind === "publication-authorized" || next.kind === "content-ineligible") {
      if (subject.schemaVersion !== "pa-content-review-subject/v1" || prior.some(e => e.kind === "content-ineligible")) documentReject("DOCUMENT_AUTHORITY");
      const request = this.approvedFrom(prior, next.kind === "publication-authorized" ? next.authority.contentDecisionId : next.fence.decisionId);
      if (next.kind === "publication-authorized" && (prior.some(e => e.kind === "publication-authorized") || request.schemaVersion !== "pa-content-review-request/v1")) documentReject("DOCUMENT_CONFLICT");
      if (next.kind === "content-ineligible" && next.fence.reason === "superseded") {
        const current = this.contentSubject(sha).document, successor = this.contentSubject(next.fence.successor!).document;
        if (current.ticket !== successor.ticket || !isDeepStrictEqual(current.repository, successor.repository) || current.packageId !== successor.packageId || current.revision >= successor.revision) documentReject("DOCUMENT_AUTHORITY");
        this.contentDecision(next.fence.successor!, false);
      }
    } else if (next.kind === "requested") {
      const r = next.request;
      if (subject.schemaVersion === "pa-content-review-subject/v1") {
        if (prior.length || r.schemaVersion !== "pa-content-review-request/v1" || r.operation !== "capture" || r.targetDecisionId !== null
          || r.deploymentId !== subject.deploymentId || r.sessionId !== subject.sessionId) documentReject("DOCUMENT_AUTHORITY");
      } else if (subject.schemaVersion === "pa-handoff-review/v2") {
        if (r.schemaVersion !== "pa-handoff-local-request/v2" || r.deploymentId !== subject.origin.deploymentId || r.sessionId !== subject.origin.sessionId) documentReject("DOCUMENT_AUTHORITY");
      } else if (r.schemaVersion !== "pa-handoff-native-request/v1") documentReject("DOCUMENT_AUTHORITY");
      if (last?.kind === "requested" || prior.some(e => e.kind === "stale") || r.expectedRevision !== prior.length || r.subjectSha256 !== sha || r.callerIdentitySha256 !== subject.callerIdentitySha256
        || r.selectionSha256 !== subject.selectionSha256 || prior.some(e => e.kind === "requested" && (e.request.requestKey === r.requestKey || e.request.decisionId === r.decisionId))) documentReject("DOCUMENT_CONFLICT");
      if (r.operation === "revoke") this.approvedFrom(prior, r.targetDecisionId!);
    } else if (next.kind === "stale") {
      const disposition = stale(next.stale), { intent } = this.subject(sha);
      if (subject.schemaVersion !== "pa-handoff-review/v2" || disposition.oldDevelopSha !== intent.base.observedDevelopSha
        || prior.some(e => e.kind === "stale" || e.kind === "issued" && e.decision.outcome === "approved")
        || (last?.kind === "requested" ? last.request.operation !== "capture" || disposition.requestKey !== last.request.requestKey : disposition.requestKey !== null)) documentReject("DOCUMENT_CONFLICT");
    } else {
      if (last?.kind !== "requested" || last.request.requestKey !== next.decision.requestKey) documentReject("DOCUMENT_CONFLICT");
      const { recordedAt: _at, ...d } = next.decision;
      if (!isDeepStrictEqual(d, this.evidence(last.request))) documentReject("DOCUMENT_AUTHORITY");
      if (subject.schemaVersion !== "pa-handoff-review/v1") {
        const capture = object(strictJson(this.capture(last.request.requestKey)!, 65536), ["schemaVersion", "method", "request", "outcome", "principal", "interactionId", "boundary", "acceptedAt"]);
        if (next.decision.recordedAt !== capture.acceptedAt) documentReject("DOCUMENT_UNCERTAIN");
      }
    }
  }
  /** New bytes/subject cannot evade this owner's unresolved ticket history.
   * Revocation remains possible during partial effects; it grants no new write. */
  private assertNoOtherPending(sha: string, newRequest = false): void {
    const { document } = this.publicationSubject(sha);
    if (documentPending(this.documents.events(document.repository.key, document.ticket)).length) documentReject("DOCUMENT_UNCERTAIN");
    const rows = this.db.prepare("SELECT sha256 FROM handoff_review_subjects LIMIT 1025").all() as { sha256: string }[];
    if (rows.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
    for (const row of rows) {
      if (row.sha256 === sha && !newRequest) continue;
      const binding = this.publicationSubject(row.sha256), other = binding.document;
      if (other.ticket !== document.ticket || other.repository.key !== document.repository.key) continue;
      const events = this.events(row.sha256);
      // A pending sign-only review is not an effect intent or ticket lock.
      if (binding.subject.schemaVersion !== "pa-content-review-subject/v1" && events.at(-1)?.kind === "requested") documentReject("DOCUMENT_UNCERTAIN");
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
      if (r.operation === "capture" && this.binding(r.subjectSha256).schemaVersion !== "pa-content-review-subject/v1") this.assertNoOtherPending(r.subjectSha256, true);
      this.append(r.subjectSha256, r.expectedRevision, { kind: "requested", request: r });
    });
  }
  issue(sha: string, r: HandoffReviewRequest, recordedAt: string): HandoffIssuedDecision {
    if (this.subject(sha).subject.schemaVersion !== "pa-handoff-review/v1" || r.schemaVersion !== "pa-handoff-native-request/v1") documentReject("DOCUMENT_AUTHORITY");
    const decision = { ...this.evidence(r), recordedAt: time(recordedAt) };
    this.append(sha, this.events(sha).length, { kind: "issued", decision }); return decision;
  }
  /** Bind outcome, interaction and server time in the SAME durable transaction
   * as issuance. There is no externally importable v2 capture or crash window. */
  issueLocal(sha: string, rawRequest: HandoffReviewRequest, outcome: HandoffIssuedDecision["outcome"]): HandoffIssuedDecision {
    const r = request(rawRequest);
    oneOf(outcome, ["approved", "changes-requested", "rejected", "cancelled"]);
    return this.transaction(() => {
      const subject = this.binding(sha);
      if ((subject.schemaVersion === "pa-handoff-review/v2" ? r.schemaVersion !== "pa-handoff-local-request/v2"
        : subject.schemaVersion === "pa-content-review-subject/v1" ? r.schemaVersion !== "pa-content-review-request/v1" : true) || r.subjectSha256 !== sha) documentReject("DOCUMENT_AUTHORITY");
      const events = this.events(sha), original = events.find(e => e.kind === "requested" && e.request.requestKey === r.requestKey);
      if (original?.kind !== "requested" || !isDeepStrictEqual(original.request, r)) documentReject("DOCUMENT_AUTHORITY");
      const previous = events.find(e => e.kind === "issued" && e.decision.requestKey === r.requestKey);
      if (previous?.kind === "issued") {
        if (previous.decision.outcome !== outcome) documentReject("DOCUMENT_CONFLICT");
        return previous.decision;
      }
      if (events.at(-1)?.kind !== "requested" || this.capture(r.requestKey)) documentReject("DOCUMENT_UNCERTAIN");
      const acceptedAt = new Date().toISOString();
      const bytes = json({ schemaVersion: "pa-handoff-local-evidence/v2", method: "unauthenticated-local-confirmation", request: r, outcome,
        principal: "local-unverified", interactionId: `interaction-${randomUUID()}`, boundary: "local-unverified-not-authenticated-human-consent", acceptedAt });
      this.db.prepare("INSERT INTO handoff_review_captures(request_key,sha256,raw) VALUES(?,?,?)").run(r.requestKey, digest(bytes), bytes);
      const decision = { ...this.evidence(r), recordedAt: acceptedAt };
      this.append(sha, events.length, { kind: "issued", decision });
      return decision;
    });
  }
  markStale(sha: string, newDevelopSha: string): HandoffStaleDisposition {
    return this.transaction(() => {
      const events = this.events(sha), previous = events.find(e => e.kind === "stale");
      if (previous?.kind === "stale") return previous.stale;
      const { intent } = this.subject(sha), last = events.at(-1);
      const value = stale({ requestKey: last?.kind === "requested" ? last.request.requestKey : null,
        oldDevelopSha: intent.base.observedDevelopSha, newDevelopSha, observedAt: new Date().toISOString() });
      this.append(sha, events.length, { kind: "stale", stale: value }); return value;
    });
  }
  /** Read-only pending/partial checks for preflight and exact native refresh. */
  assertSettled(sha: string): void { this.assertNoOtherPending(sha); }
  branchEffect(sha: string, decisionId: string): { operationId: string; started: boolean; completed: boolean } {
    const operationId = handoffBranchOperationId(sha, decisionId);
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_branch_events'").get();
    const events = exists ? new RegistryHandoffBranchJournal(this.db, false).events(operationId) : [];
    return { operationId, started: events.length > 0, completed: events.at(-1)?.kind === "complete" };
  }
  private append(sha: string, revision: number, data: { kind: "requested"; request: HandoffReviewRequest } | { kind: "issued"; decision: HandoffIssuedDecision } | { kind: "stale"; stale: HandoffStaleDisposition } | { kind: "publication-authorized"; authority: ContentPublicationAuthority } | { kind: "content-ineligible"; fence: ContentReviewFence }): void {
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
  /** Canonical content eligibility is NOT a combined effect grant. */
  contentDecision(sha: string, active = true): HandoffReviewRequest {
    this.contentSubject(sha);
    const events = this.events(sha), request = events.find(e => e.kind === "requested");
    if (request?.kind !== "requested" || request.request.operation !== "capture" || request.request.schemaVersion !== "pa-content-review-request/v1"
      || active && events.some(e => e.kind === "content-ineligible")) return documentReject("DOCUMENT_AUTHORITY");
    return this.approvedFrom(events, request.request.decisionId);
  }
  contentAuthority(sha: string, active = true): ContentPublicationAuthority {
    const request = this.contentDecision(sha, active), event = this.events(sha).find(e => e.kind === "publication-authorized");
    if (event?.kind !== "publication-authorized" || event.authority.contentDecisionId !== request.decisionId) return documentReject("DOCUMENT_AUTHORITY");
    return event.authority;
  }
  authorizeContentPublication(sha: string, raw: ContentPublicationAuthority): void {
    this.transaction(() => { this.contentDecision(sha); this.append(sha, this.events(sha).length, { kind: "publication-authorized", authority: publicationAuthority(raw) }); });
  }
  fenceContent(sha: string, reason: ContentReviewFence["reason"], successor: string | null = null): void {
    this.transaction(() => {
      const request = this.contentDecision(sha);
      if (reason === "superseded") { if (successor === null) documentReject("DOCUMENT_INPUT"); this.contentDecision(successor); }
      this.append(sha, this.events(sha).length, { kind: "content-ineligible", fence: contentFence({ decisionId: request.decisionId, reason, successor, recordedAt: new Date().toISOString() }) });
    });
  }
  beginContentPublication(sha: string) {
    return this.transaction(() => {
      const authority = this.contentAuthority(sha); this.assertNoOtherPending(sha);
      const effect = this.effect(sha, authority.contentDecisionId, "publish");
      if (!effect.started) this.db.prepare("INSERT INTO handoff_review_effects(operation_id,body) VALUES(?,?)")
        .run(effect.operationId, JSON.stringify({ subjectSha256: sha, decisionId: authority.contentDecisionId, operation: "publish" }));
      return this.effect(sha, authority.contentDecisionId, "publish");
    });
  }
  /** Native completed-publication provenance only, not a transferred grant.
   * Deliberately does not invoke cross-subject pending admission: the successor
   * may be recovering its own partial publication. Its current authorization is
   * checked separately before every remaining write. */
  completedPublication(documentSha256: string): { subjectSha256: string; decisionId: string } | undefined {
    text(documentSha256, SHA256);
    const rows = this.db.prepare("SELECT sha256 FROM handoff_review_subjects LIMIT 1025").all() as { sha256: string }[];
    if (rows.length > 1024) return documentReject("DOCUMENT_UNCERTAIN");
    const matches = rows.flatMap(row => {
      const binding = this.publicationSubject(row.sha256);
      if (binding.subject.documentSubjectSha256 !== documentSha256) return [];
      const events = this.events(row.sha256);
      return events.flatMap(event => {
        if (event.kind !== "requested" || event.request.operation !== "capture"
          || !this.effect(row.sha256, event.request.decisionId, "publish").completed) return [];
        if (binding.subject.schemaVersion === "pa-content-review-subject/v1") {
          if (this.contentDecision(row.sha256, false).decisionId !== event.request.decisionId || !events.some(e => e.kind === "publication-authorized" && e.authority.contentDecisionId === event.request.decisionId)) documentReject("DOCUMENT_AUTHORITY");
        } else {
          if (events.at(-1)?.kind === "requested" || !binding.subject.effects.publish) return documentReject("DOCUMENT_AUTHORITY");
          this.approvedFrom(events, event.request.decisionId);
        }
        return [{ subjectSha256: row.sha256, decisionId: event.request.decisionId }];
      });
    });
    if (matches.length > 1) return documentReject("DOCUMENT_CONFLICT");
    return matches[0];
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
