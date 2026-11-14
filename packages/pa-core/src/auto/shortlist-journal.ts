import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { digest, GIT_SHA, integer, object, oneOf, SHA256, strictJson, text } from "../workflows/contracts.js";
import { assertNoSensitiveMatch } from "../sensitive-patterns.js";
import { RegistryAutoJournal, type AutoItem } from "./coordination.js";
import { parseAutoWaitlistSnapshot } from "./store.js";
import { AutoWaitlistError, type AutoWaitlistSnapshot } from "./waitlist.js";
import { parseAutoShortlistAssessment, parseAutoShortlistChoiceRequest, type AutoShortlistAssessment, type AutoShortlistAssessmentContext } from "./shortlist-report.js";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const cyclePattern = new RegExp(`^cycle-${uuid}$`), operationPattern = new RegExp(`^operation-${uuid}$`);
const activeCycle = (state: AutoReasoningCycle["state"]) => !["published", "failed"].includes(state);
const activeChoice = (state: AutoChoiceRecord["state"]) => state === "requested" || state === "observed";
// The strict reader deliberately uses null-prototype objects. Normalize only
// after validation so ordinary native records compare by data, not prototype.
const json = (raw: Uint8Array, max = 65_536): unknown => structuredClone(strictJson(raw, max));
const utc = (value: unknown): number => {
  const s = text(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), n = Date.parse(s);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== s) throw new AutoWaitlistError("AUTO_SOURCE");
  return n;
};
export interface AutoReasoningCycle {
  schemaVersion: "pa-auto-reasoning-cycle/v1"; cycleId: string; operationId: string; revision: number;
  state: "reserved" | "running" | "uncertain" | "report-saved" | "published" | "failed";
  createdAt: string; deadlineAt: string; context: AutoShortlistAssessmentContext;
  goalEvidenceSha256: string; requestSha256: string; outputSha256: string | null; reportSha256: string | null; viewVersion: string | null;
}
export interface AutoReasoningSessionEvidence {
  deploymentId: string; operationId: string; requestSha256: string; provider: string; model: string;
  configRevision: string; resourcesSha256: string; startedAt: string; completedAt: string;
  sourceRequests: number; contextBytes: number; outputBytes: number; cleanup: "settled";
}
export interface AutoShortlistReport {
  schemaVersion: "pa-auto-shortlist-report/v1"; cycleId: string; snapshotSha256: string; goalEvidenceSha256: string;
  outputSha256: string; session: AutoReasoningSessionEvidence; assessment: AutoShortlistAssessment;
}
export interface AutoPublishedShortlist {
  version: string; sha256: string; reportSha256: string; cycleId: string; view: Buffer; report: AutoShortlistReport;
}
export interface AutoShortlistObservationHost {
  authenticate(): string;
  now(): string;
  /** Native source/goal/config/policy/owner observations. Never a model port. */
  reobserve(cycle: AutoReasoningCycle): AutoShortlistAssessmentContext;
  /** Must verify ORIGINAL registered producer identity, actual completion and
   * finite bounds. A caller-supplied passed/settled flag is not this proof. */
  assertSession(cycle: AutoReasoningCycle, session: AutoReasoningSessionEvidence): void;
}
export interface AutoChoiceRecord {
  schemaVersion: "pa-auto-human-choice/v1"; requestId: string; revision: number; state: "requested" | "observed" | "accepted" | "refused" | "cancelled";
  viewVersion: string; viewSha256: string; callerIdentity: string; requestedAt: string;
  ticket: string | null; principal: string | null; interactionId: string | null; evidenceSha256: string | null;
  itemId: string | null; reason: "none" | "stale-or-busy";
}
export interface AutoShortlistChoiceHost extends AutoShortlistObservationHost {
  /** Actual unmanaged foreground interaction. No public actor/outcome import. */
  capture(request: AutoChoiceRecord, shortlist: AutoPublishedShortlist): Promise<{
    ticket: string | null; principal: string; interactionId: string; evidence: Uint8Array;
  }>;
}

/** Existing registry coordination owner, not a policy/permission store. Immutable
 * reports precede publication; native human evidence precedes selection CAS.
 * SQL guards share the slot with the retained manual auto_items owner. */
export class RegistryAutoShortlists {
  readonly items: RegistryAutoJournal;
  constructor(readonly db: Database.Database) { this.items = new RegistryAutoJournal(db); }
  private tx<T>(fn: () => T): { immediate(): T } {
    return { immediate: () => {
      try { return this.db.transaction(fn).immediate(); }
      catch (error) { throw error instanceof AutoWaitlistError ? error : new AutoWaitlistError("AUTO_SOURCE"); }
    } };
  }
  private present(table: "auto_reasoning_cycles" | "auto_choice_requests" | "auto_shortlists"): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
  private bytes(raw: Uint8Array, max = 1_048_576): string {
    if (raw.byteLength > max) throw new AutoWaitlistError("AUTO_LIMIT");
    const sha = digest(raw);
    this.db.prepare("INSERT OR IGNORE INTO auto_shortlist_blobs(sha256,raw) VALUES(?,?)").run(sha, raw);
    this.blob(sha, max); return sha;
  }
  blob(sha: string, max = 1_048_576): Buffer {
    text(sha, SHA256);
    const row = this.db.prepare("SELECT raw FROM auto_shortlist_blobs WHERE sha256=?").get(sha) as { raw: Buffer } | undefined;
    if (!row || row.raw.length > max || digest(row.raw) !== sha) throw new AutoWaitlistError("AUTO_STORE");
    return Buffer.from(row.raw);
  }
  activeCycle(): AutoReasoningCycle | null {
    if (!this.present("auto_reasoning_cycles")) return null;
    const row = this.db.prepare("SELECT cycle_id FROM auto_reasoning_cycles WHERE active_slot=1").get() as { cycle_id: string } | undefined;
    return row ? this.cycle(row.cycle_id) : null;
  }
  cycle(id: string): AutoReasoningCycle {
    text(id, cyclePattern);
    const rows = this.db.prepare("SELECT revision,predecessor,body,sha256 FROM auto_reasoning_events WHERE cycle_id=? ORDER BY revision LIMIT 1025").all(id) as Array<{ revision: number; predecessor: string | null; body: string; sha256: string }>;
    if (!rows.length || rows.length > 1024) throw new AutoWaitlistError("AUTO_STORE");
    let prior: string | null = null;
    const events = rows.map((row, i) => {
      if (row.revision !== i + 1 || row.predecessor !== prior || digest(row.body) !== row.sha256) throw new AutoWaitlistError("AUTO_STORE");
      const r = object(json(Buffer.from(row.body)), ["schemaVersion", "cycleId", "operationId", "revision", "state", "createdAt", "deadlineAt", "context", "goalEvidenceSha256", "requestSha256", "outputSha256", "reportSha256", "viewVersion"]);
      if (r.schemaVersion !== "pa-auto-reasoning-cycle/v1" || r.cycleId !== id || r.revision !== row.revision) throw new AutoWaitlistError("AUTO_STORE");
      text(r.operationId, operationPattern); oneOf(r.state, ["reserved", "running", "uncertain", "report-saved", "published", "failed"]);
      if (utc(r.deadlineAt) <= utc(r.createdAt) || utc(r.deadlineAt) - utc(r.createdAt) > 600_000) throw new AutoWaitlistError("AUTO_STORE");
      for (const key of ["goalEvidenceSha256", "requestSha256"]) text(r[key], SHA256);
      for (const key of ["outputSha256", "reportSha256"]) if (r[key] !== null) text(r[key], SHA256);
      if (r.viewVersion !== null) text(r.viewVersion, new RegExp(`^${uuid}$`));
      const cycle = r as unknown as AutoReasoningCycle;
      this.validateContext(cycle.context, this.snapshot(cycle));
      prior = row.sha256; return cycle;
    });
    const current = events.at(-1)!, row = this.db.prepare("SELECT revision,body,sha256,active_slot FROM auto_reasoning_cycles WHERE cycle_id=?").get(id) as { revision: number; body: string; sha256: string; active_slot: number | null } | undefined;
    if (!row || row.revision !== current.revision || row.body !== rows.at(-1)!.body || row.sha256 !== prior || (row.active_slot === 1) !== activeCycle(current.state)) throw new AutoWaitlistError("AUTO_STORE");
    return current;
  }
  snapshot(cycle: AutoReasoningCycle): AutoWaitlistSnapshot { return structuredClone(parseAutoWaitlistSnapshot(this.blob(cycle.context.snapshotSha256, 32 * 1_048_576))); }
  private validateContext(context: AutoShortlistAssessmentContext, snapshot: AutoWaitlistSnapshot): void {
    object(context, ["sessionId", "snapshotSha256", "goalSha256", "policySha256", "configSha256", "eligibleTickets"]);
    text(context.sessionId, /^d-[a-f0-9]{6}$/);
    for (const key of ["snapshotSha256", "goalSha256", "policySha256", "configSha256"] as const) text(context[key], SHA256);
    const eligible = snapshot.entries.filter(e => e.route !== "observe").map(e => e.id).sort();
    if (!Array.isArray(context.eligibleTickets) || !isDeepStrictEqual([...context.eligibleTickets].sort(), eligible)) throw new AutoWaitlistError("AUTO_SOURCE");
  }
  private saveCycle(next: AutoReasoningCycle, predecessor: string | null): AutoReasoningCycle {
    const body = JSON.stringify(next), sha = digest(body);
    this.db.prepare("INSERT INTO auto_reasoning_events(cycle_id,revision,predecessor,body,sha256) VALUES(?,?,?,?,?)").run(next.cycleId, next.revision, predecessor, body, sha);
    this.db.prepare("INSERT INTO auto_reasoning_cycles(cycle_id,active_slot,revision,body,sha256) VALUES(?,?,?,?,?) ON CONFLICT(cycle_id) DO UPDATE SET active_slot=excluded.active_slot,revision=excluded.revision,body=excluded.body,sha256=excluded.sha256").run(next.cycleId, activeCycle(next.state) ? 1 : null, next.revision, body, sha);
    return this.cycle(next.cycleId);
  }
  private changeCycle(cycle: AutoReasoningCycle, patch: Partial<Pick<AutoReasoningCycle, "state" | "outputSha256" | "reportSha256" | "viewVersion">>): AutoReasoningCycle {
    const current = this.cycle(cycle.cycleId);
    if (current.revision !== cycle.revision) throw new AutoWaitlistError("AUTO_BUSY");
    return this.saveCycle({ ...current, ...patch, revision: current.revision + 1 }, digest(JSON.stringify(current)));
  }
  reserve(input: { snapshot: Uint8Array; goalEvidence: Uint8Array; request: Uint8Array; context: AutoShortlistAssessmentContext; deadlineAt: string }, host: AutoShortlistObservationHost): AutoReasoningCycle {
    return this.tx(() => {
      host.authenticate();
      if (this.items.active() || this.activeCycle()) throw new AutoWaitlistError("AUTO_BUSY");
      if (this.db.prepare("SELECT 1 FROM auto_reasoning_cycles WHERE json_extract(body,'$.context.sessionId')=?").get(input.context.sessionId)) throw new AutoWaitlistError("AUTO_BUSY");
      const snapshot = parseAutoWaitlistSnapshot(Buffer.from(input.snapshot)), createdAt = host.now();
      this.validateContext(input.context, snapshot);
      if (digest(input.snapshot) !== input.context.snapshotSha256 || digest(input.goalEvidence) !== input.context.goalSha256 || utc(createdAt) < utc(snapshot.completedAt)
        || utc(createdAt) >= utc(snapshot.completedAt) + 30 * 60_000 || utc(input.deadlineAt) <= utc(createdAt) || utc(input.deadlineAt) - utc(createdAt) > 600_000) throw new AutoWaitlistError("AUTO_SOURCE");
      assertNoSensitiveMatch("content", new TextDecoder("utf-8", { fatal: true }).decode(input.goalEvidence));
      this.bytes(input.snapshot, 32 * 1_048_576);
      const cycle: AutoReasoningCycle = { schemaVersion: "pa-auto-reasoning-cycle/v1", cycleId: `cycle-${randomUUID()}`, operationId: `operation-${randomUUID()}`, revision: 1,
        state: "reserved", createdAt, deadlineAt: input.deadlineAt, context: structuredClone(input.context), goalEvidenceSha256: this.bytes(input.goalEvidence, 65_536), requestSha256: this.bytes(input.request), outputSha256: null, reportSha256: null, viewVersion: null };
      if (!isDeepStrictEqual(host.reobserve(cycle), cycle.context)) throw new AutoWaitlistError("AUTO_SOURCE");
      return this.saveCycle(cycle, null);
    }).immediate();
  }
  /** Persist before the first provider request. A lost reply/claimed cycle can
   * only be observed/reconciled, never claimed a second time. */
  claim(cycle: AutoReasoningCycle, host: AutoShortlistObservationHost): AutoReasoningCycle {
    return this.tx(() => {
      host.authenticate();
      if (this.cycle(cycle.cycleId).state !== "reserved" || utc(host.now()) >= utc(cycle.deadlineAt) || !isDeepStrictEqual(host.reobserve(cycle), cycle.context)) throw new AutoWaitlistError("AUTO_BUSY");
      return this.changeCycle(cycle, { state: "running" });
    }).immediate();
  }
  uncertain(cycle: AutoReasoningCycle, host: AutoShortlistObservationHost): AutoReasoningCycle {
    return this.tx(() => { host.authenticate(); if (!activeCycle(cycle.state) || cycle.state === "reserved") throw new AutoWaitlistError("AUTO_BUSY"); return this.changeCycle(cycle, { state: "uncertain" }); }).immediate();
  }
  fail(cycle: AutoReasoningCycle, session: AutoReasoningSessionEvidence, host: AutoShortlistObservationHost): AutoReasoningCycle {
    return this.tx(() => { host.authenticate(); this.session(cycle, session); host.assertSession(cycle, session); if (!activeCycle(cycle.state)) throw new AutoWaitlistError("AUTO_BUSY"); return this.changeCycle(cycle, { state: "failed" }); }).immediate();
  }
  private session(cycle: AutoReasoningCycle, input: AutoReasoningSessionEvidence): AutoReasoningSessionEvidence {
    const s = object(input, ["deploymentId", "operationId", "requestSha256", "provider", "model", "configRevision", "resourcesSha256", "startedAt", "completedAt", "sourceRequests", "contextBytes", "outputBytes", "cleanup"]);
    if (s.deploymentId !== cycle.context.sessionId || s.operationId !== cycle.operationId || s.requestSha256 !== cycle.requestSha256 || s.resourcesSha256 !== cycle.context.configSha256 || s.cleanup !== "settled"
      || utc(s.startedAt) < utc(cycle.createdAt) || utc(s.completedAt) < utc(s.startedAt) || utc(s.completedAt) > utc(cycle.deadlineAt)) throw new AutoWaitlistError("AUTO_SOURCE");
    text(s.provider, /^[a-z][a-z0-9-]{0,63}$/); text(s.model, /^[A-Za-z0-9_][A-Za-z0-9_./:-]{0,255}$/); text(s.configRevision, GIT_SHA);
    integer(s.sourceRequests, 0, 32); integer(s.contextBytes, 0, 1_048_576); integer(s.outputBytes, 0, 1_048_576);
    return structuredClone(input);
  }
  /** Raw captured bytes survive validation failure. No invalid output is ever
   * promoted to a complete report or a fresh empty shortlist. */
  captureOutput(cycle: AutoReasoningCycle, output: Uint8Array, host: AutoShortlistObservationHost): AutoReasoningCycle {
    return this.tx(() => {
      host.authenticate(); if (!["running", "uncertain"].includes(cycle.state) || cycle.outputSha256) throw new AutoWaitlistError("AUTO_BUSY");
      return this.changeCycle(cycle, { outputSha256: this.bytes(output) });
    }).immediate();
  }
  saveReport(cycle: AutoReasoningCycle, sessionInput: AutoReasoningSessionEvidence, host: AutoShortlistObservationHost): AutoReasoningCycle {
    return this.tx(() => {
      host.authenticate(); if (!cycle.outputSha256 || !["running", "uncertain"].includes(cycle.state)) throw new AutoWaitlistError("AUTO_BUSY");
      const raw = this.blob(cycle.outputSha256), assessment = parseAutoShortlistAssessment(raw, cycle.context), session = this.session(cycle, sessionInput);
      if (session.outputBytes !== raw.length) throw new AutoWaitlistError("AUTO_SOURCE");
      host.assertSession(cycle, session);
      const report: AutoShortlistReport = { schemaVersion: "pa-auto-shortlist-report/v1", cycleId: cycle.cycleId, snapshotSha256: cycle.context.snapshotSha256,
        goalEvidenceSha256: cycle.goalEvidenceSha256, outputSha256: cycle.outputSha256, session, assessment };
      const bytes = Buffer.from(JSON.stringify(report)); assertNoSensitiveMatch("content", bytes.toString("utf8"));
      return this.changeCycle(cycle, { state: "report-saved", reportSha256: this.bytes(bytes) });
    }).immediate();
  }
  report(cycle: AutoReasoningCycle): AutoShortlistReport {
    if (!cycle.reportSha256 || !cycle.outputSha256) throw new AutoWaitlistError("AUTO_STORE");
    const r = object(json(this.blob(cycle.reportSha256), 1_048_576), ["schemaVersion", "cycleId", "snapshotSha256", "goalEvidenceSha256", "outputSha256", "session", "assessment"]);
    if (r.schemaVersion !== "pa-auto-shortlist-report/v1" || r.cycleId !== cycle.cycleId || r.snapshotSha256 !== cycle.context.snapshotSha256 || r.goalEvidenceSha256 !== cycle.goalEvidenceSha256 || r.outputSha256 !== cycle.outputSha256) throw new AutoWaitlistError("AUTO_STORE");
    this.session(cycle, r.session as AutoReasoningSessionEvidence);
    const assessment = parseAutoShortlistAssessment(this.blob(cycle.outputSha256), cycle.context);
    if (!isDeepStrictEqual(r.assessment, assessment)) throw new AutoWaitlistError("AUTO_STORE");
    return r as unknown as AutoShortlistReport;
  }
  publish(cycle: AutoReasoningCycle, expiresAt: string, host: AutoShortlistObservationHost): AutoPublishedShortlist {
    return this.tx(() => {
      host.authenticate(); const current = this.cycle(cycle.cycleId);
      if (current.state === "published" && current.viewVersion) return this.published(current.viewVersion);
      if (current.revision !== cycle.revision || current.state !== "report-saved" || this.items.active()) throw new AutoWaitlistError("AUTO_BUSY");
      const report = this.report(current), generatedAt = host.now(), scanCompletedAt = this.snapshot(current).completedAt;
      host.assertSession(current, report.session);
      if (!isDeepStrictEqual(host.reobserve(current), current.context) || utc(generatedAt) < utc(report.session.completedAt) || utc(expiresAt) <= utc(generatedAt) || utc(expiresAt) > utc(scanCompletedAt) + 30 * 60_000) throw new AutoWaitlistError("AUTO_SOURCE");
      const version = randomUUID(), view = Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-shortlist-view/v1", version, scanCompletedAt, generatedAt, expiresAt, assessment: report.assessment }));
      const sha = this.bytes(view);
      this.db.prepare("INSERT INTO auto_shortlists(version,cycle_id,sha256,report_sha256) VALUES(?,?,?,?)").run(version, current.cycleId, sha, current.reportSha256);
      this.db.prepare("INSERT INTO auto_shortlist_head(singleton,version) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version").run(version);
      this.changeCycle(current, { state: "published", viewVersion: version });
      return this.published(version);
    }).immediate();
  }
  head(): AutoPublishedShortlist | null {
    if (!this.present("auto_shortlists")) return null;
    const row = this.db.prepare("SELECT version FROM auto_shortlist_head WHERE singleton=1").get() as { version: string } | undefined;
    return row ? this.published(row.version) : null;
  }
  published(version: string): AutoPublishedShortlist {
    text(version, new RegExp(`^${uuid}$`));
    const row = this.db.prepare("SELECT cycle_id,sha256,report_sha256 FROM auto_shortlists WHERE version=?").get(version) as { cycle_id: string; sha256: string; report_sha256: string } | undefined;
    if (!row) throw new AutoWaitlistError("AUTO_STORE");
    const cycle = this.cycle(row.cycle_id), report = this.report(cycle), view = this.blob(row.sha256);
    if (cycle.viewVersion !== version || cycle.state !== "published" || cycle.reportSha256 !== row.report_sha256) throw new AutoWaitlistError("AUTO_STORE");
    const v = object(json(view, 1_048_576), ["schemaVersion", "version", "scanCompletedAt", "generatedAt", "expiresAt", "assessment"]);
    if (v.schemaVersion !== "pa-auto-shortlist-view/v1" || v.version !== version || v.scanCompletedAt !== this.snapshot(cycle).completedAt || !isDeepStrictEqual(v.assessment, report.assessment)) throw new AutoWaitlistError("AUTO_STORE");
    utc(v.generatedAt); utc(v.expiresAt);
    return { version, sha256: row.sha256, reportSha256: row.report_sha256, cycleId: cycle.cycleId, view, report };
  }
  pendingChoice(): AutoChoiceRecord | null {
    if (!this.present("auto_choice_requests")) return null;
    const row = this.db.prepare("SELECT request_id FROM auto_choice_requests WHERE active_slot=1").get() as { request_id: string } | undefined;
    return row ? this.choice(row.request_id) : null;
  }
  choice(id: string): AutoChoiceRecord {
    text(id, operationPattern);
    const rows = this.db.prepare("SELECT revision,predecessor,body,sha256 FROM auto_choice_events WHERE request_id=? ORDER BY revision LIMIT 5").all(id) as Array<{ revision: number; predecessor: string | null; body: string; sha256: string }>;
    if (!rows.length || rows.length > 3) throw new AutoWaitlistError("AUTO_STORE");
    let prior: string | null = null;
    const records = rows.map((row, i) => {
      if (row.revision !== i + 1 || row.predecessor !== prior || digest(row.body) !== row.sha256) throw new AutoWaitlistError("AUTO_STORE");
      const r = object(json(Buffer.from(row.body)), ["schemaVersion", "requestId", "revision", "state", "viewVersion", "viewSha256", "callerIdentity", "requestedAt", "ticket", "principal", "interactionId", "evidenceSha256", "itemId", "reason"]);
      if (r.schemaVersion !== "pa-auto-human-choice/v1" || r.requestId !== id || r.revision !== row.revision) throw new AutoWaitlistError("AUTO_STORE");
      oneOf(r.state, ["requested", "observed", "accepted", "refused", "cancelled"]); oneOf(r.reason, ["none", "stale-or-busy"]);
      text(r.viewVersion, new RegExp(`^${uuid}$`)); text(r.viewSha256, SHA256); text(r.callerIdentity, SHA256); utc(r.requestedAt);
      if (r.ticket !== null) text(r.ticket, /^(?:PAP|PAPC)-\d+$/, 64);
      if (r.state === "requested") { if ([r.ticket, r.principal, r.interactionId, r.evidenceSha256, r.itemId].some(v => v !== null)) throw new AutoWaitlistError("AUTO_STORE"); }
      else { text(r.principal); text(r.interactionId, /^interaction-[a-f0-9-]{36}$/); this.blob(text(r.evidenceSha256, SHA256), 65_536); }
      if (r.itemId !== null) text(r.itemId, /^auto-[a-f0-9-]{36}$/);
      if ((r.state === "accepted") !== (r.itemId !== null) || r.state === "accepted" && r.ticket === null || r.state === "cancelled" && r.ticket !== null) throw new AutoWaitlistError("AUTO_STORE");
      prior = row.sha256; return r as unknown as AutoChoiceRecord;
    });
    const current = records.at(-1)!, row = this.db.prepare("SELECT revision,body,sha256,active_slot FROM auto_choice_requests WHERE request_id=?").get(id) as { revision: number; body: string; sha256: string; active_slot: number | null } | undefined;
    if (!row || row.revision !== current.revision || row.body !== rows.at(-1)!.body || row.sha256 !== prior || (row.active_slot === 1) !== activeChoice(current.state)) throw new AutoWaitlistError("AUTO_STORE");
    return current;
  }
  private saveChoice(next: AutoChoiceRecord, predecessor: string | null): AutoChoiceRecord {
    const body = JSON.stringify(next), sha = digest(body);
    this.db.prepare("INSERT INTO auto_choice_events(request_id,revision,predecessor,body,sha256) VALUES(?,?,?,?,?)").run(next.requestId, next.revision, predecessor, body, sha);
    this.db.prepare("INSERT INTO auto_choice_requests(request_id,active_slot,revision,body,sha256) VALUES(?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET active_slot=excluded.active_slot,revision=excluded.revision,body=excluded.body,sha256=excluded.sha256").run(next.requestId, activeChoice(next.state) ? 1 : null, next.revision, body, sha);
    return this.choice(next.requestId);
  }
  private assertView(shortlist: AutoPublishedShortlist, ticket: string, requestId: string, host: AutoShortlistObservationHost): void {
    if (this.head()?.version !== shortlist.version || this.items.active() || this.activeCycle()) throw new AutoWaitlistError("AUTO_BUSY");
    const cycle = this.cycle(shortlist.cycleId), current = host.reobserve(cycle);
    parseAutoShortlistChoiceRequest(Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-shortlist-choice-request/v1", requestId, shortlistVersion: shortlist.version, shortlistSha256: shortlist.sha256, ticket })), { view: shortlist.view, current, now: host.now() });
  }
  /** Claimed BEFORE opening the native UI. A lost capture reply stays requested
   * and holds competing selection; it is never silently reprompted. */
  async choose(version: string, host: AutoShortlistChoiceHost): Promise<AutoChoiceRecord> {
    const request = this.tx(() => {
      const identity = text(host.authenticate(), SHA256), shortlist = this.published(version);
      if (this.pendingChoice()) throw new AutoWaitlistError("AUTO_BUSY");
      const first = shortlist.report.assessment.shortlist[0];
      if (!first) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      const requestId = `operation-${randomUUID()}`;
      // First entry is used ONLY to validate the view before opening its UI,
      // never as a selected/default ticket or recorded native choice.
      this.assertView(shortlist, first.ticket, requestId, host);
      return this.saveChoice({ schemaVersion: "pa-auto-human-choice/v1", requestId, revision: 1, state: "requested", viewVersion: version, viewSha256: shortlist.sha256,
        callerIdentity: identity, requestedAt: host.now(), ticket: null, principal: null, interactionId: null, evidenceSha256: null, itemId: null, reason: "none" }, null);
    }).immediate();
    const capture = await host.capture(request, this.published(version));
    this.tx(() => {
      if (host.authenticate() !== request.callerIdentity || this.choice(request.requestId).revision !== request.revision) throw new AutoWaitlistError("AUTO_BUSY");
      const e = object(json(capture.evidence), ["schemaVersion", "method", "requestId", "viewVersion", "viewSha256", "ticket", "principal", "interactionId"]);
      if (e.schemaVersion !== "pa-auto-shortlist-human-choice/v1" || e.method !== "ppa-auto-foreground" || e.requestId !== request.requestId || e.viewVersion !== version || e.viewSha256 !== request.viewSha256
        || e.ticket !== capture.ticket || e.principal !== capture.principal || e.interactionId !== capture.interactionId) throw new AutoWaitlistError("AUTO_SOURCE");
      this.saveChoice({ ...request, revision: 2, state: "observed", ticket: capture.ticket, principal: capture.principal, interactionId: capture.interactionId, evidenceSha256: this.bytes(capture.evidence, 65_536) }, digest(JSON.stringify(request)));
    }).immediate();
    return this.reconcileChoice(request.requestId, host);
  }
  reconcileChoice(requestId: string, host: AutoShortlistObservationHost): AutoChoiceRecord {
    return this.tx(() => {
      host.authenticate(); const current = this.choice(requestId);
      if (!activeChoice(current.state)) return current;
      if (current.state !== "observed") throw new AutoWaitlistError("AUTO_BUSY");
      let state: AutoChoiceRecord["state"] = "cancelled", item: AutoItem | null = null;
      if (current.ticket !== null) {
        const shortlist = this.published(current.viewVersion);
        try { this.assertView(shortlist, current.ticket, requestId, host); state = "accepted"; }
        catch { state = "refused"; }
        if (state === "accepted") {
          const snapshot = this.snapshot(this.cycle(shortlist.cycleId)), entry = snapshot.entries.find(e => e.id === current.ticket)!;
          const root = snapshot.projects.find(p => p.key === entry.project)?.canonicalRoot;
          if (!root || entry.route === "observe") throw new AutoWaitlistError("AUTO_SOURCE");
          // Release only this choice's coordination flag INSIDE the same SQLite
          // transaction as native item creation and immutable accepted evidence.
          this.db.prepare("UPDATE auto_choice_requests SET active_slot=NULL WHERE request_id=?").run(requestId);
          item = this.items.select(entry, root, () => { this.assertNoMaterialDrift(shortlist, host); return entry; }, () => { host.authenticate(); });
        }
      }
      return this.saveChoice({ ...current, revision: current.revision + 1, state, itemId: item?.itemId ?? null, reason: state === "refused" ? "stale-or-busy" : "none" }, digest(JSON.stringify(current)));
    }).immediate();
  }
  private assertNoMaterialDrift(shortlist: AutoPublishedShortlist, host: AutoShortlistObservationHost): void {
    const cycle = this.cycle(shortlist.cycleId);
    if (!isDeepStrictEqual(host.reobserve(cycle), cycle.context)) throw new AutoWaitlistError("AUTO_SOURCE");
  }
  selectionForItem(itemId: string): AutoChoiceRecord | null {
    if (!this.present("auto_choice_requests")) return null;
    // Bounded exact native correlation, not a caller/model-authored item flag.
    const rows = this.db.prepare("SELECT request_id FROM auto_choice_requests WHERE json_extract(body,'$.itemId')=? LIMIT 2").all(itemId) as Array<{ request_id: string }>;
    if (rows.length > 1) throw new AutoWaitlistError("AUTO_STORE");
    const choice = rows[0] ? this.choice(rows[0].request_id) : null;
    if (choice && (choice.state !== "accepted" || this.items.item(itemId).ticket !== choice.ticket)) throw new AutoWaitlistError("AUTO_STORE");
    return choice;
  }
}
