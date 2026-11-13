import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { digest, object, strictJson, text, oneOf, integer, SHA256 } from "../workflows/contracts.js";
import { AUTO_PROJECTS, AutoWaitlistError, type AutoProject, type AutoRoute, type AutoWaitlistEntry } from "./waitlist.js";

export const AUTO_RUNTIME_VERSION = "pa-auto-runtime/v1" as const;
export const AUTO_STATES = ["selected", "drafting", "awaiting-review", "approved-pending-dispatch", "running", "blocked", "uncertain", "review-ready", "closed", "declined"] as const;
export type AutoItemState = typeof AUTO_STATES[number];
export interface AutoEffect {
  operationId: string; deploymentId: string; state: "intent" | "running" | "completed" | "failed" | "unknown";
}
export interface AutoItem {
  schemaVersion: typeof AUTO_RUNTIME_VERSION; itemId: string; revision: number; project: AutoProject; repoRoot: string;
  ticket: string; ticketSha256: string; selectedAt: string; route: Exclude<AutoRoute, "observe">;
  state: AutoItemState; subjectSha256: string | null; decisionId: string | null; startSha256: string | null;
  draft: AutoEffect | null; dispatch: AutoEffect | null; reason: "none" | "contract" | "drift" | "owner" | "question" | "failure" | "uncertain";
}
export interface AutoControl { revision: number; scansEnabled: boolean; dispatchEnabled: boolean; paused: boolean }
const initialControl = (): AutoControl => ({ revision: 0, scansEnabled: false, dispatchEnabled: false, paused: true });
const held = (state: AutoItemState) => state !== "closed" && state !== "declined";
const date = (value: unknown): string => { const s = text(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); if (!Number.isFinite(Date.parse(s))) throw new AutoWaitlistError("AUTO_STORE"); return s; };
export function parseAutoItem(raw: string): AutoItem {
  try {
    const r = object(strictJson(Buffer.from(raw), 65_536), ["schemaVersion", "itemId", "revision", "project", "repoRoot", "ticket", "ticketSha256", "selectedAt", "route", "state", "subjectSha256", "decisionId", "startSha256", "draft", "dispatch", "reason"]);
    if (r.schemaVersion !== AUTO_RUNTIME_VERSION) throw new Error();
    const project = oneOf(r.project, ["pa-platform", "pa-platform-config"]), root = text(r.repoRoot, /^\//);
    const ticket = text(r.ticket, new RegExp(`^${AUTO_PROJECTS[project]}-\\d+$`), 64);
    const nullable = (v: unknown, pattern: RegExp) => v === null ? null : text(v, pattern);
    const effect = (v: unknown): AutoEffect | null => {
      if (v === null) return null;
      const e = object(v, ["operationId", "deploymentId", "state"]);
      return { operationId: text(e.operationId, /^operation-[a-f0-9-]{36}$/), deploymentId: text(e.deploymentId, /^d-[a-f0-9]{6}$/), state: oneOf(e.state, ["intent", "running", "completed", "failed", "unknown"]) };
    };
    return { schemaVersion: AUTO_RUNTIME_VERSION, itemId: text(r.itemId, /^auto-[a-f0-9-]{36}$/), revision: integer(r.revision, 1), project, repoRoot: root, ticket,
      ticketSha256: text(r.ticketSha256, SHA256), selectedAt: date(r.selectedAt), route: oneOf(r.route, ["draft", "review-package", "review-start"]), state: oneOf(r.state, AUTO_STATES),
      subjectSha256: nullable(r.subjectSha256, SHA256), decisionId: nullable(r.decisionId, /^[a-z][a-z0-9.-]{0,127}$/), startSha256: nullable(r.startSha256, SHA256),
      draft: effect(r.draft), dispatch: effect(r.dispatch), reason: oneOf(r.reason, ["none", "contract", "drift", "owner", "question", "failure", "uncertain"]) };
  } catch { throw new AutoWaitlistError("AUTO_STORE"); }
}
/** Registry-owned coordination, NOT a decision/permission ledger. All effects
 * still require native document/launch owners. UNIQUE(active_slot) serializes
 * both projects and every hold state across independent OS processes. */
export class RegistryAutoJournal {
  constructor(readonly db: Database.Database) {}
  control(): AutoControl {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auto_control'").get();
    if (!table) return initialControl();
    const row = this.db.prepare("SELECT body FROM auto_control WHERE singleton=1").get() as { body: string } | undefined;
    if (!row) return initialControl();
    try {
      const r = object(strictJson(Buffer.from(row.body)), ["revision", "scansEnabled", "dispatchEnabled", "paused"]);
      if ([r.scansEnabled, r.dispatchEnabled, r.paused].some(v => typeof v !== "boolean")) throw new Error();
      return { revision: integer(r.revision, 1), scansEnabled: r.scansEnabled as boolean, dispatchEnabled: r.dispatchEnabled as boolean, paused: r.paused as boolean };
    } catch { throw new AutoWaitlistError("AUTO_STORE"); }
  }
  setControl(expected: number, next: Omit<AutoControl, "revision">, authenticate: () => void): AutoControl {
    return this.db.transaction(() => {
      authenticate(); const before = this.control();
      if (before.revision !== expected) throw new AutoWaitlistError("AUTO_BUSY");
      const result = { revision: expected + 1, ...next };
      if ([result.paused, result.scansEnabled, result.dispatchEnabled].some(v => typeof v !== "boolean")) throw new AutoWaitlistError("AUTO_INPUT");
      this.db.prepare("INSERT INTO auto_control(singleton,revision,body) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,body=excluded.body").run(result.revision, JSON.stringify(result));
      return result;
    }).immediate();
  }
  active(): AutoItem | null {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auto_items'").get()) return null;
    const row = this.db.prepare("SELECT item_id FROM auto_items WHERE active_slot=1").get() as { item_id: string } | undefined;
    return row ? this.item(row.item_id) : null;
  }
  item(id: string): AutoItem {
    const row = this.db.prepare("SELECT revision,body,sha256,active_slot FROM auto_items WHERE item_id=?").get(id) as { revision: number; body: string; sha256: string; active_slot: number | null } | undefined;
    if (!row || digest(row.body) !== row.sha256) throw new AutoWaitlistError("AUTO_STORE");
    const item = parseAutoItem(row.body);
    if (item.itemId !== id || item.revision !== row.revision || held(item.state) !== (row.active_slot === 1)) throw new AutoWaitlistError("AUTO_STORE");
    const events = this.history(id);
    if (events.at(-1)?.sha256 !== row.sha256 || events.length !== item.revision) throw new AutoWaitlistError("AUTO_STORE");
    return item;
  }
  history(id: string): Array<{ revision: number; sha256: string; item: AutoItem }> {
    if (!/^auto-[a-f0-9-]{36}$/.test(id)) throw new AutoWaitlistError("AUTO_INPUT");
    const rows = this.db.prepare("SELECT revision,predecessor,body,sha256 FROM auto_events WHERE item_id=? ORDER BY revision LIMIT 1025").all(id) as { revision: number; predecessor: string | null; body: string; sha256: string }[];
    if (rows.length > 1024) throw new AutoWaitlistError("AUTO_LIMIT");
    let predecessor: string | null = null;
    return rows.map((r, i) => {
      if (r.revision !== i + 1 || r.predecessor !== predecessor || digest(r.body) !== r.sha256) throw new AutoWaitlistError("AUTO_STORE");
      const item = parseAutoItem(r.body);
      if (item.itemId !== id || item.revision !== r.revision) throw new AutoWaitlistError("AUTO_STORE");
      predecessor = r.sha256; return { revision: r.revision, sha256: r.sha256, item };
    });
  }
  select(entry: AutoWaitlistEntry, repoRoot: string, reobserve: () => AutoWaitlistEntry, authenticate: () => void): AutoItem {
    if (entry.route === "observe") throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    return this.db.transaction(() => {
      authenticate(); if (this.active()) throw new AutoWaitlistError("AUTO_BUSY");
      if (JSON.stringify(reobserve()) !== JSON.stringify(entry)) throw new AutoWaitlistError("AUTO_SOURCE");
      const item: AutoItem = { schemaVersion: AUTO_RUNTIME_VERSION, itemId: `auto-${randomUUID()}`, revision: 1,
        project: entry.project, repoRoot, ticket: entry.id, ticketSha256: entry.ticketSha256, selectedAt: new Date().toISOString(), route: entry.route as AutoItem["route"],
        state: entry.route === "draft" ? "selected" : "awaiting-review", subjectSha256: entry.documents.subjectSha256 ?? null,
        decisionId: null, startSha256: null, draft: null, dispatch: null, reason: "none" };
      return this.persist(item, null);
    }).immediate();
  }
  /** Durable at-most-once entry to an actual owner, independent of PID/reply.
   * A crash after this claim is UNKNOWN, never permission to run it again. */
  claimEffect(item: AutoItem, effect: AutoEffect, authenticate: () => void): boolean {
    return this.db.transaction(() => {
      authenticate(); const current = this.item(item.itemId);
      if (![current.draft?.operationId, current.dispatch?.operationId].includes(effect.operationId)) throw new AutoWaitlistError("AUTO_STORE");
      return this.db.prepare("INSERT OR IGNORE INTO auto_effect_claims(operation_id,item_id,body) VALUES(?,?,?)").run(effect.operationId, item.itemId, JSON.stringify({ effect, stage: "claimed" })).changes === 1;
    }).immediate();
  }
  effectStage(effect: AutoEffect): "claimed" | "ticket-effects" | "launch-requested" {
    const row = this.db.prepare("SELECT body FROM auto_effect_claims WHERE operation_id=?").get(effect.operationId) as { body: string } | undefined;
    if (!row) throw new AutoWaitlistError("AUTO_STORE");
    const r = object(strictJson(Buffer.from(row.body)), ["effect", "stage"]);
    const saved = object(r.effect, ["operationId", "deploymentId", "state"]);
    if (saved.operationId !== effect.operationId || saved.deploymentId !== effect.deploymentId) throw new AutoWaitlistError("AUTO_STORE");
    return oneOf(r.stage, ["claimed", "ticket-effects", "launch-requested"]);
  }
  advanceEffect(item: AutoItem, effect: AutoEffect, expected: "claimed" | "ticket-effects", next: "ticket-effects" | "launch-requested", authenticate: () => void): void {
    this.db.transaction(() => {
      authenticate(); const current = this.item(item.itemId);
      if (current.dispatch?.operationId !== effect.operationId || this.effectStage(effect) !== expected) throw new AutoWaitlistError("AUTO_BUSY");
      this.db.prepare("UPDATE auto_effect_claims SET body=? WHERE operation_id=?").run(JSON.stringify({ effect, stage: next }), effect.operationId);
    }).immediate();
  }
  /** Trusted coordination transition. A callback is rechecked under SQLite CAS;
   * public CLI/request JSON never supplies state, outcomes or this callback. */
  change(id: string, expected: number, transform: (before: Readonly<AutoItem>) => AutoItem, authenticate: () => void): AutoItem {
    return this.db.transaction(() => {
      authenticate(); const before = this.item(id);
      if (!held(before.state) || before.revision !== expected) throw new AutoWaitlistError("AUTO_BUSY");
      const next = transform(structuredClone(before));
      if (next.itemId !== before.itemId || next.project !== before.project || next.ticket !== before.ticket || next.repoRoot !== before.repoRoot || next.selectedAt !== before.selectedAt) throw new AutoWaitlistError("AUTO_STORE");
      return this.persist({ ...next, revision: expected + 1 }, digest(JSON.stringify(before)));
    }).immediate();
  }
  private persist(item: AutoItem, predecessor: string | null): AutoItem {
    const body = JSON.stringify(parseAutoItem(JSON.stringify(item))), sha = digest(body);
    this.db.prepare("INSERT INTO auto_events(item_id,revision,predecessor,body,sha256) VALUES(?,?,?,?,?)").run(item.itemId, item.revision, predecessor, body, sha);
    this.db.prepare("INSERT INTO auto_items(item_id,active_slot,revision,body,sha256) VALUES(?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET active_slot=excluded.active_slot,revision=excluded.revision,body=excluded.body,sha256=excluded.sha256").run(item.itemId, held(item.state) ? 1 : null, item.revision, body, sha);
    return this.item(item.itemId);
  }
}

export type AutoOwnerObservation = { state: "running" | "unknown" | "failed"; settled: false } | { state: "review-ready" | "draft-ready" | "failed"; settled: true; subjectSha256?: string };
export interface AutoWorkOwner {
  /** Read-only admission before persisting a first effect intent. */
  admit?(item: AutoItem): void;
  observe(item: AutoItem, effect: AutoEffect): Promise<AutoOwnerObservation>;
  /** Same-intent owner reconciliation may finish proven missing pre-launch effects. */
  reconcile?(item: AutoItem, effect: AutoEffect): Promise<AutoOwnerObservation>;
  /** Called ONCE after durable intent. Any lost reply remains same-intent uncertain. */
  execute(item: AutoItem, effect: AutoEffect): Promise<AutoOwnerObservation>;
}
export class AutoCoordinator {
  constructor(readonly journal: RegistryAutoJournal, private readonly authenticate: () => void) {}
  async draft(item: AutoItem, owner: AutoWorkOwner): Promise<AutoItem> {
    this.authenticate();
    if (item.draft) return this.reconcile(item, owner, "draft");
    if (!(item.state === "selected" || item.state === "blocked" && item.reason === "contract") || item.route !== "draft") throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    owner.admit?.(item);
    const effect: AutoEffect = { operationId: `operation-${randomUUID()}`, deploymentId: `d-${randomUUID().replaceAll("-", "").slice(0, 6)}`, state: "intent" };
    const saved = this.journal.change(item.itemId, item.revision, before => ({ ...before, state: "drafting", draft: effect }), this.authenticate);
    try { return this.apply(saved, "draft", await owner.execute(saved, effect)); }
    catch { return this.apply(saved, "draft", { state: "unknown", settled: false }); }
  }
  async reconcile(item: AutoItem, owner: AutoWorkOwner, kind: "draft" | "dispatch"): Promise<AutoItem> {
    const effect = item[kind]; if (!effect) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    let observation: AutoOwnerObservation;
    try { observation = await (owner.reconcile ?? owner.observe)(item, effect); } catch { observation = { state: "unknown", settled: false }; }
    return this.apply(item, kind, observation);
  }
  apply(item: AutoItem, kind: "draft" | "dispatch", observation: AutoOwnerObservation): AutoItem {
    return this.journal.change(item.itemId, item.revision, before => {
      const effect = before[kind]; if (!effect) throw new AutoWaitlistError("AUTO_STORE");
      const state: AutoItemState = observation.state === "unknown" ? "uncertain" : observation.state === "running" ? kind === "draft" ? "drafting" : "running"
        : observation.state === "failed" ? "blocked" : observation.state === "draft-ready" ? "awaiting-review" : "review-ready";
      if (observation.state === "draft-ready" && !observation.subjectSha256) throw new AutoWaitlistError("AUTO_SOURCE");
      return { ...before, state, [kind]: { ...effect, state: observation.state === "running" ? "running" : observation.state === "unknown" ? "unknown" : observation.state === "failed" ? "failed" : "completed" },
        subjectSha256: observation.settled && observation.subjectSha256 ? observation.subjectSha256 : before.subjectSha256,
        reason: observation.state === "unknown" ? "uncertain" : observation.state === "failed" ? "failure" : "none" };
    }, this.authenticate);
  }
  close(item: AutoItem, disposition: "closed" | "declined", assertSettled: (current: AutoItem) => void): AutoItem {
    return this.journal.change(item.itemId, item.revision, before => {
      if ([before.draft, before.dispatch].some(e => e && !["completed", "failed"].includes(e.state))) throw new AutoWaitlistError("AUTO_BUSY");
      assertSettled(before); return { ...before, state: disposition };
    }, this.authenticate);
  }
}
