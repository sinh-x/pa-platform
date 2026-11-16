import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { digest, integer, object, oneOf, SHA256, strictJson, text } from "../workflows/contracts.js";
import { AutoWaitlistError } from "../auto/waitlist.js";
import { autoPolicyTime, parseAutoDelegationPolicy } from "../documents/auto-policy-contract.js";

export interface DocumentAutoPolicyReview {
  schemaVersion: "pa-auto-policy-review-record/v1"; reviewId: string; decisionId: string;
  operation: "adopt" | "revoke" | "withdraw"; policySha256: string; target: string | null; baselineSha256: string;
  phase: "requested" | "observed" | "issued"; callerIdentity: string; recordedAt: string;
  evidenceSha256: string | null; outcome: "approved" | "cancelled" | null; principal: string | null; interactionId: string | null;
}
export interface DocumentAutoPolicyEvent { schemaVersion: "pa-document-auto-policy-event/v1"; domain: string; revision: number; predecessor: string | null; data: DocumentAutoPolicyReview }
const reviewId = /^review-[a-f0-9-]{36}$/;
function record(value: unknown): DocumentAutoPolicyReview {
  const r = object(value, ["schemaVersion", "reviewId", "decisionId", "operation", "policySha256", "target", "baselineSha256", "phase", "callerIdentity", "recordedAt", "evidenceSha256", "outcome", "principal", "interactionId"]);
  if (r.schemaVersion !== "pa-auto-policy-review-record/v1") throw new AutoWaitlistError("AUTO_SOURCE");
  text(r.reviewId, reviewId); text(r.decisionId, /^decision-[a-f0-9-]{36}$/); text(r.policySha256, SHA256); text(r.baselineSha256, SHA256); text(r.callerIdentity, SHA256); autoPolicyTime(r.recordedAt);
  oneOf(r.operation, ["adopt", "revoke", "withdraw"]); oneOf(r.phase, ["requested", "observed", "issued"]);
  if (r.operation === "adopt") { if (r.target !== null) throw new AutoWaitlistError("AUTO_SOURCE"); }
  else text(r.target, r.operation === "withdraw" ? reviewId : /^decision-[a-f0-9-]{36}$/);
  if (r.phase === "requested") {
    if ([r.evidenceSha256, r.outcome, r.principal, r.interactionId].some(v => v !== null)) throw new AutoWaitlistError("AUTO_SOURCE");
  } else { text(r.evidenceSha256, SHA256); oneOf(r.outcome, ["approved", "cancelled"]); text(r.principal, /^local-uid:\d{1,20}$/); text(r.interactionId, /^interaction-[a-f0-9-]{36}$/); }
  return r as unknown as DocumentAutoPolicyReview;
}
export function documentAutoPolicyEpoch(events: readonly DocumentAutoPolicyEvent[]): string {
  return digest(JSON.stringify(events.filter(e => e.data.phase === "issued" && e.data.outcome === "approved").map(e => e.data)));
}
export function documentAutoPolicyPending(events: readonly DocumentAutoPolicyEvent[]): DocumentAutoPolicyReview[] {
  const settled = new Set(events.filter(e => e.data.phase === "issued").map(e => e.data.reviewId));
  for (const e of events) if (e.data.phase === "issued" && e.data.operation === "withdraw" && e.data.outcome === "approved") settled.add(e.data.target!);
  return events.flatMap(e => e.data.phase === "requested" && e.data.operation !== "withdraw" && !settled.has(e.data.reviewId) ? [events.filter(x => x.data.reviewId === e.data.reviewId).at(-1)!.data] : []);
}
export function documentAutoPolicyAdoption(events: readonly DocumentAutoPolicyEvent[]): DocumentAutoPolicyReview | null {
  let active: DocumentAutoPolicyReview | null = null;
  for (const { data } of events) if (data.phase === "issued" && data.outcome === "approved") {
    if (data.operation === "adopt") active = data;
    else if (data.operation === "revoke" && active?.decisionId === data.target) active = null;
  }
  return active;
}
export function readDocumentAutoPolicyEvents(db: Database.Database, domain: string): DocumentAutoPolicyEvent[] {
  text(domain, SHA256);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_auto_policy_events'").get()) return [];
  const rows = db.prepare("SELECT revision,predecessor,sha256,body FROM document_auto_policy_events WHERE domain=? ORDER BY revision LIMIT 10001").all(domain) as Array<{ revision: number; predecessor: string | null; sha256: string; body: string }>;
  if (rows.length > 10000) throw new AutoWaitlistError("AUTO_LIMIT"); let previous: string | null = null;
  const events: DocumentAutoPolicyEvent[] = [], policyIds = new Set<string>();
  rows.forEach((row, index) => {
    const e = object(structuredClone(strictJson(Buffer.from(row.body), 65536)), ["schemaVersion", "domain", "revision", "predecessor", "data"]);
    if (row.revision !== index + 1 || e.revision !== row.revision || e.domain !== domain || e.schemaVersion !== "pa-document-auto-policy-event/v1" || e.predecessor !== previous || row.predecessor !== previous || digest(row.body) !== row.sha256) throw new AutoWaitlistError("AUTO_STORE");
    const data = record(e.data); validateTransition(events, data); const policy = validateSnapshot(db, domain, data);
    if (data.phase === "requested" && data.operation === "adopt") { if (policyIds.has(policy.policyId)) throw new AutoWaitlistError("AUTO_STORE"); policyIds.add(policy.policyId); }
    previous = row.sha256; events.push({ ...e, data } as unknown as DocumentAutoPolicyEvent);
  });
  return events;
}
export function captureDocumentAutoPolicy(db: Database.Database, domain: string, review: string, raw: Uint8Array): string {
  return db.transaction(() => {
    if (raw.byteLength > 65536 || !readDocumentAutoPolicyEvents(db, domain).some(e => e.data.reviewId === review && e.data.phase === "requested")) throw new AutoWaitlistError("AUTO_SOURCE");
    const sha = digest(raw), existing = db.prepare("SELECT sha256 FROM document_auto_policy_captures WHERE domain=? AND review_id=?").get(domain, review) as { sha256: string } | undefined;
    if (existing && existing.sha256 !== sha) throw new AutoWaitlistError("AUTO_BUSY");
    db.prepare("INSERT OR IGNORE INTO document_snapshots(sha256,raw) VALUES(?,?)").run(sha, raw);
    db.prepare("INSERT OR IGNORE INTO document_auto_policy_captures(domain,review_id,sha256) VALUES(?,?,?)").run(domain, review, sha); return sha;
  }).immediate();
}
export function readDocumentAutoPolicyCapture(db: Database.Database, domain: string, review: string): string | null {
  const row = db.prepare("SELECT sha256 FROM document_auto_policy_captures WHERE domain=? AND review_id=?").get(domain, review) as { sha256: string } | undefined; return row?.sha256 ?? null;
}
function base(r: DocumentAutoPolicyReview) {
  const { phase: _phase, recordedAt: _at, evidenceSha256: _evidence, outcome: _outcome, principal: _principal, interactionId: _interaction, ...rest } = r; return rest;
}
function validateTransition(events: DocumentAutoPolicyEvent[], data: DocumentAutoPolicyReview): void {
  const prior = events.filter(e => e.data.reviewId === data.reviewId).at(-1)?.data;
  if (data.phase === "requested") {
    if (prior || events.some(e => e.data.decisionId === data.decisionId) || data.baselineSha256 !== documentAutoPolicyEpoch(events) || data.operation !== "withdraw" && documentAutoPolicyPending(events).length) throw new AutoWaitlistError("AUTO_BUSY");
    if (data.operation === "withdraw" && !documentAutoPolicyPending(events).some(r => r.reviewId === data.target && r.policySha256 === data.policySha256)) throw new AutoWaitlistError("AUTO_BUSY");
    if (data.operation === "revoke" && (documentAutoPolicyAdoption(events)?.decisionId !== data.target || documentAutoPolicyAdoption(events)?.policySha256 !== data.policySha256)) throw new AutoWaitlistError("AUTO_BUSY");
  } else {
    if (!prior || prior.phase !== (data.phase === "observed" ? "requested" : "observed") || !isDeepStrictEqual(base(prior), base(data))) throw new AutoWaitlistError("AUTO_BUSY");
    if (data.phase === "issued") {
      if (!isDeepStrictEqual({ ...prior, phase: data.phase, recordedAt: data.recordedAt }, data)) throw new AutoWaitlistError("AUTO_SOURCE");
      if (data.operation !== "withdraw" && (!documentAutoPolicyPending(events).some(r => r.reviewId === data.reviewId) || data.baselineSha256 !== documentAutoPolicyEpoch(events))) throw new AutoWaitlistError("AUTO_BUSY");
      if (data.operation === "withdraw" && !documentAutoPolicyPending(events).some(r => r.reviewId === data.target)) throw new AutoWaitlistError("AUTO_BUSY");
    }
  }
}
function validateSnapshot(db: Database.Database, domain: string, data: DocumentAutoPolicyReview) {
  const snapshot = (sha: string): Buffer => {
    const row = db.prepare("SELECT raw FROM document_snapshots WHERE sha256=?").get(sha) as { raw: Buffer } | undefined;
    if (!row || row.raw.length > 65536 || digest(row.raw) !== sha) throw new AutoWaitlistError("AUTO_STORE"); return Buffer.from(row.raw);
  };
  const policy = parseAutoDelegationPolicy(snapshot(data.policySha256));
  if (digest(JSON.stringify(policy.domain)) !== domain) throw new AutoWaitlistError("AUTO_SOURCE");
  if (data.evidenceSha256) {
    if (data.principal !== policy.domain.principal) throw new AutoWaitlistError("AUTO_SOURCE");
    const capture = db.prepare("SELECT sha256 FROM document_auto_policy_captures WHERE domain=? AND review_id=?").get(domain, data.reviewId) as { sha256: string } | undefined;
    if (!capture || capture.sha256 !== data.evidenceSha256) throw new AutoWaitlistError("AUTO_SOURCE");
    const evidence = object(structuredClone(strictJson(snapshot(data.evidenceSha256), 65536)), ["schemaVersion", "method", "reviewId", "decisionId", "operation", "policySha256", "target", "principal", "interactionId", "outcome", "boundary"]);
    if (evidence.schemaVersion !== "pa-auto-policy-native-review/v1" || evidence.method !== "ppa-auto-policy-foreground" || evidence.reviewId !== data.reviewId || evidence.decisionId !== data.decisionId || evidence.operation !== data.operation || evidence.policySha256 !== data.policySha256 || evidence.target !== data.target || evidence.principal !== data.principal || evidence.interactionId !== data.interactionId || evidence.outcome !== data.outcome || evidence.boundary !== "native-unmanaged-controlling-terminal-not-hostile-same-uid-isolation") throw new AutoWaitlistError("AUTO_SOURCE");
  }
  return policy;
}
/** Private implementation of RegistryDocumentJournal's NEW global scope. Uses
 * its existing immutable snapshot owner, never per-ticket confirmations. */
export function appendDocumentAutoPolicyEvent(db: Database.Database, domain: string, revision: number, input: DocumentAutoPolicyReview, snapshots: readonly Uint8Array[]): DocumentAutoPolicyEvent {
  return db.transaction(() => {
    integer(revision, 0, 9999); const events = readDocumentAutoPolicyEvents(db, domain), data = record(input);
    if (events.length !== revision) throw new AutoWaitlistError("AUTO_BUSY");
    validateTransition(events, data);
    for (const raw of snapshots) {
      if (raw.byteLength > 65536) throw new AutoWaitlistError("AUTO_LIMIT"); const sha = digest(raw);
      db.prepare("INSERT OR IGNORE INTO document_snapshots(sha256,raw) VALUES(?,?)").run(sha, raw);
    }
    const policy = validateSnapshot(db, domain, data), claim = data.phase === "requested" && data.operation === "adopt" ? policy.policyId : null;
    if (claim && db.prepare("SELECT 1 FROM document_auto_policy_events WHERE policy_claim=?").get(claim)) throw new AutoWaitlistError("AUTO_BUSY");
    const last = db.prepare("SELECT sha256 FROM document_auto_policy_events WHERE domain=? ORDER BY revision DESC LIMIT 1").get(domain) as { sha256: string } | undefined;
    const e: DocumentAutoPolicyEvent = { schemaVersion: "pa-document-auto-policy-event/v1", domain, revision: revision + 1, predecessor: last?.sha256 ?? null, data };
    const body = JSON.stringify(e);
    db.prepare("INSERT INTO document_auto_policy_events(domain,revision,review_id,phase,predecessor,sha256,body,decision_claim,interaction_claim,policy_claim) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(domain, e.revision, data.reviewId, data.phase, e.predecessor, digest(body), body, data.phase === "requested" ? data.decisionId : null, data.phase === "observed" ? data.interactionId : null, claim);
    return e;
  }).immediate();
}
