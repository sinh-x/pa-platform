import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RegistryAutoJournal, type AutoItem, type AutoEffect } from "./coordination.js";
import { RegistryAutoShortlists, type AutoChoiceRecord } from "./shortlist-journal.js";
import { AutoWaitlistError } from "./waitlist.js";
import { digest, integer, object, oneOf, SHA256, strictJson, text } from "../workflows/contracts.js";
import type { ProcessFingerprint } from "../deploy/repository-admission.js";

export interface AutoDraftPolicyRef { decisionId: string; policySha256: string; expiresAt: string }
export interface AutoDraftGeneration {
  schemaVersion: "pa-auto-draft-generation/v1"; itemId: string; generation: number; revision: number;
  operationId: string; deploymentId: string; selectionId: string; selectionSha256: string; policy: AutoDraftPolicyRef;
  createdAt: string; deadlineAt: string; requestSha256: string; ticketVersion: string;
  state: "reserved" | "running" | "uncertain" | "output-saved" | "frozen" | "attaching" | "ready" | "questions" | "blocked" | "quarantined";
  outputSha256: string | null; bundleSha256: string | null; subjectSha256: string | null; appendSha256: string | null;
}
export interface AutoDraftGenerationHost {
  authenticate(): string;
  now(): string;
  /** Actual native policy owner, NEVER a model/config/receipt port. The returned
   * value is correlation only; this callback must reauthorize every effect. */
  authorize(item: AutoItem, choice: AutoChoiceRecord, policy?: AutoDraftPolicyRef): AutoDraftPolicyRef;
  assertCurrent(generation: AutoDraftGeneration): void;
}
export interface AutoDraftProcessObservation {
  state: "completed" | "failed" | "unknown"; pid: number | null; fingerprint: ProcessFingerprint | null;
  startedAt: string; completedAt: string; exitCode: number | null; signal: string | null; groupSettled: boolean; stderrBytes: number;
}
export interface AutoDraftTurn {
  turn: number; promptSha256: string; anchor: ProcessFingerprint | null;
  observation: AutoDraftProcessObservation | null; outputSha256: string | null; sourceSha256: string | null;
}
const json = (raw: Uint8Array, max = 65_536) => structuredClone(strictJson(raw, max));
const iso = (value: unknown): number => {
  const s = text(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), n = Date.parse(s);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== s) throw new AutoWaitlistError("AUTO_SOURCE"); return n;
};
const policyRef = (value: unknown): AutoDraftPolicyRef => {
  const r = object(value, ["decisionId", "policySha256", "expiresAt"]); iso(r.expiresAt);
  return { decisionId: text(r.decisionId, /^decision-[a-f0-9-]{36}$/), policySha256: text(r.policySha256, SHA256), expiresAt: r.expiresAt as string };
};
function synchronous<T>(value: T): T {
  if (value instanceof Promise) { void value.catch(() => {}); throw new AutoWaitlistError("AUTO_UNAVAILABLE"); }
  return value;
}
function authorize(host: AutoDraftGenerationHost, item: AutoItem, choice: AutoChoiceRecord, expected?: AutoDraftPolicyRef): AutoDraftPolicyRef {
  const result: unknown = synchronous(host.authorize(item, choice, expected));
  const ref = policyRef(result);
  if (expected && !isDeepStrictEqual(ref, expected)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  return ref;
}
function fingerprint(value: unknown): ProcessFingerprint {
  const r = object(value, ["pid", "startTimeTicks", "bootId"]);
  return { pid: integer(r.pid, 1), startTimeTicks: text(r.startTimeTicks, /^\d{1,30}$/), bootId: text(r.bootId, /^[a-f0-9-]{36}$/) };
}
/** Durable coordination/evidence, not a permission store. One immutable original
 * selection/policy/request binds every generation, provider turn and append.
 * Native adapters must supply actual authentication and policy/effect owners. */
export class RegistryAutoDrafts {
  readonly shortlists: RegistryAutoShortlists;
  constructor(readonly journal: RegistryAutoJournal) { this.shortlists = new RegistryAutoShortlists(journal.db); }
  private tx<T>(fn: () => T): T {
    try { return this.journal.db.transaction(fn).immediate(); }
    catch (error) { throw error instanceof AutoWaitlistError ? error : new AutoWaitlistError("AUTO_SOURCE"); }
  }
  private put(raw: Uint8Array, max = 1_048_576): string {
    if (raw.byteLength > max) throw new AutoWaitlistError("AUTO_LIMIT");
    const sha = digest(raw); this.journal.db.prepare("INSERT OR IGNORE INTO auto_draft_snapshots(sha256,raw) VALUES(?,?)").run(sha, raw); this.blob(sha, max); return sha;
  }
  blob(sha: string, max = 1_048_576): Buffer {
    text(sha, SHA256); const row = this.journal.db.prepare("SELECT raw FROM auto_draft_snapshots WHERE sha256=?").get(sha) as { raw: Buffer } | undefined;
    if (!row || row.raw.length > max || digest(row.raw) !== sha) throw new AutoWaitlistError("AUTO_STORE"); return Buffer.from(row.raw);
  }
  current(itemId: string): AutoDraftGeneration | null {
    if (!this.journal.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auto_draft_generations'").get()) return null;
    const row = this.journal.db.prepare("SELECT generation FROM auto_draft_generations WHERE item_id=? ORDER BY generation DESC LIMIT 1").get(itemId) as { generation: number } | undefined;
    return row ? this.generation(itemId, row.generation) : null;
  }
  generation(itemId: string, generation: number): AutoDraftGeneration {
    text(itemId, /^auto-[a-f0-9-]{36}$/); integer(generation, 1, 1024);
    const rows = this.journal.db.prepare("SELECT revision,predecessor,body,sha256 FROM auto_draft_events WHERE item_id=? AND generation=? ORDER BY revision LIMIT 1025").all(itemId, generation) as Array<{ revision: number; predecessor: string | null; body: string; sha256: string }>;
    if (!rows.length || rows.length > 1024) throw new AutoWaitlistError("AUTO_STORE");
    let predecessor: string | null = null;
    const records = rows.map((row, i) => {
      if (row.revision !== i + 1 || row.predecessor !== predecessor || digest(row.body) !== row.sha256) throw new AutoWaitlistError("AUTO_STORE");
      const r = object(json(Buffer.from(row.body)), ["schemaVersion", "itemId", "generation", "revision", "operationId", "deploymentId", "selectionId", "selectionSha256", "policy", "createdAt", "deadlineAt", "requestSha256", "ticketVersion", "state", "outputSha256", "bundleSha256", "subjectSha256", "appendSha256"]);
      if (r.schemaVersion !== "pa-auto-draft-generation/v1" || r.itemId !== itemId || r.generation !== generation || r.revision !== row.revision || iso(r.deadlineAt) <= iso(r.createdAt) || iso(r.deadlineAt) - iso(r.createdAt) > 1_800_000) throw new AutoWaitlistError("AUTO_STORE");
      text(r.operationId, /^operation-[a-f0-9-]{36}$/); text(r.deploymentId, /^d-[a-f0-9]{6}$/); text(r.selectionId, /^operation-[a-f0-9-]{36}$/);
      for (const key of ["selectionSha256", "requestSha256", "ticketVersion"]) text(r[key], SHA256);
      for (const key of ["outputSha256", "bundleSha256", "subjectSha256", "appendSha256"]) if (r[key] !== null) text(r[key], SHA256);
      policyRef(r.policy); oneOf(r.state, ["reserved", "running", "uncertain", "output-saved", "frozen", "attaching", "ready", "questions", "blocked", "quarantined"]);
      predecessor = row.sha256; return r as unknown as AutoDraftGeneration;
    });
    const current = records.at(-1)!, head = this.journal.db.prepare("SELECT revision,body,sha256 FROM auto_draft_generations WHERE item_id=? AND generation=?").get(itemId, generation) as { revision: number; body: string; sha256: string } | undefined;
    if (!head || head.revision !== current.revision || head.sha256 !== predecessor || head.body !== rows.at(-1)!.body) throw new AutoWaitlistError("AUTO_STORE");
    return current;
  }
  private save(next: AutoDraftGeneration, previous: string | null): AutoDraftGeneration {
    const raw = JSON.stringify(next), sha = digest(raw);
    this.journal.db.prepare("INSERT INTO auto_draft_events(item_id,generation,revision,predecessor,body,sha256) VALUES(?,?,?,?,?,?)").run(next.itemId, next.generation, next.revision, previous, raw, sha);
    this.journal.db.prepare("INSERT INTO auto_draft_generations(item_id,generation,revision,body,sha256) VALUES(?,?,?,?,?) ON CONFLICT(item_id,generation) DO UPDATE SET revision=excluded.revision,body=excluded.body,sha256=excluded.sha256").run(next.itemId, next.generation, next.revision, raw, sha);
    return this.generation(next.itemId, next.generation);
  }
  private change(g: AutoDraftGeneration, patch: Partial<Pick<AutoDraftGeneration, "state" | "outputSha256" | "bundleSha256" | "subjectSha256" | "appendSha256">>): AutoDraftGeneration {
    const current = this.generation(g.itemId, g.generation); if (current.revision !== g.revision) throw new AutoWaitlistError("AUTO_BUSY");
    return this.save({ ...current, ...patch, revision: current.revision + 1 }, digest(JSON.stringify(current)));
  }
  assertCurrent(g: AutoDraftGeneration, host: AutoDraftGenerationHost): void {
    text(synchronous(host.authenticate()), SHA256); const latest = this.current(g.itemId), item = this.journal.active(), choice = this.shortlists.selectionForItem(g.itemId);
    if (!latest || !isDeepStrictEqual(latest, g) || latest.state === "quarantined" || !item || item.itemId !== g.itemId || item.dispatch || item.startSha256 || item.decisionId
      || item.draft?.operationId !== g.operationId || item.draft.deploymentId !== g.deploymentId || !choice || choice.requestId !== g.selectionId || digest(JSON.stringify(choice)) !== g.selectionSha256
      || iso(host.now()) < iso(g.createdAt) || iso(host.now()) >= iso(g.deadlineAt)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    if (!isDeepStrictEqual(authorize(host, item, choice, g.policy), g.policy) || iso(host.now()) >= iso(g.policy.expiresAt)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const result: unknown = synchronous(host.assertCurrent(structuredClone(g)));
    if (result !== undefined || iso(host.now()) >= iso(g.deadlineAt) || iso(host.now()) >= iso(g.policy.expiresAt)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  }
  reserve(item: AutoItem, input: { request: Uint8Array; ticketVersion: string }, host: AutoDraftGenerationHost): AutoDraftGeneration {
    return this.tx(() => {
      text(synchronous(host.authenticate()), SHA256); const current = this.journal.active(), choice = this.shortlists.selectionForItem(item.itemId);
      if (!current || current.itemId !== item.itemId || current.revision !== item.revision || current.route !== "draft" || current.draft || current.dispatch || current.startSha256 || current.decisionId || !choice || this.current(item.itemId)) throw new AutoWaitlistError("AUTO_BUSY");
      const policy = authorize(host, current, choice), createdAt = host.now(), end = Math.min(iso(createdAt) + 1_800_000, iso(policy.expiresAt));
      if (end <= iso(createdAt)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      const g: AutoDraftGeneration = { schemaVersion: "pa-auto-draft-generation/v1", itemId: item.itemId, generation: 1, revision: 1,
        operationId: `operation-${randomUUID()}`, deploymentId: `d-${randomUUID().replaceAll("-", "").slice(0, 6)}`, selectionId: choice.requestId, selectionSha256: digest(JSON.stringify(choice)), policy,
        createdAt, deadlineAt: new Date(end).toISOString(), requestSha256: this.put(input.request), ticketVersion: text(input.ticketVersion, SHA256), state: "reserved", outputSha256: null, bundleSha256: null, subjectSha256: null, appendSha256: null };
      const effect: AutoEffect = { operationId: g.operationId, deploymentId: g.deploymentId, state: "intent" };
      this.journal.change(item.itemId, item.revision, before => ({ ...before, draft: effect, state: "drafting", reason: "none" }), () => { text(synchronous(host.authenticate()), SHA256); authorize(host, current, choice, policy); });
      this.save(g, null); this.assertCurrent(g, host); return g;
    });
  }
  start(g: AutoDraftGeneration, host: AutoDraftGenerationHost): AutoDraftGeneration {
    return this.tx(() => {
      this.assertCurrent(g, host); if (g.state !== "reserved") throw new AutoWaitlistError("AUTO_BUSY");
      const item = this.journal.item(g.itemId);
      if (!this.journal.claimEffect(item, item.draft!, () => this.assertCurrent(g, host))) throw new AutoWaitlistError("AUTO_BUSY");
      return this.change(g, { state: "running" });
    });
  }
  private appendTurn(g: AutoDraftGeneration, turn: number, phase: "claimed" | "anchored" | "observed" | "source", data: Record<string, unknown>): void {
    const previous = this.journal.db.prepare("SELECT sha256 FROM auto_draft_turns WHERE item_id=? AND generation=? AND turn=? ORDER BY rowid DESC LIMIT 1").get(g.itemId, g.generation, turn) as { sha256: string } | undefined;
    const body = JSON.stringify({ phase, ...data });
    this.journal.db.prepare("INSERT INTO auto_draft_turns(item_id,generation,turn,phase,predecessor,body,sha256) VALUES(?,?,?,?,?,?,?)").run(g.itemId, g.generation, turn, phase, previous?.sha256 ?? null, body, digest(body));
  }
  turns(g: AutoDraftGeneration): AutoDraftTurn[] {
    const rows = this.journal.db.prepare("SELECT turn,phase,predecessor,body,sha256 FROM auto_draft_turns WHERE item_id=? AND generation=? ORDER BY rowid LIMIT 133").all(g.itemId, g.generation) as Array<{ turn: number; phase: string; predecessor: string | null; body: string; sha256: string }>;
    if (rows.length > 132) throw new AutoWaitlistError("AUTO_LIMIT");
    const result: AutoDraftTurn[] = []; let previous: string | null = null;
    for (const row of rows) {
      if (row.turn > 32 || row.turn < 0 || digest(row.body) !== row.sha256) throw new AutoWaitlistError("AUTO_STORE");
      const fields = row.phase === "claimed" ? ["phase", "promptSha256"] : row.phase === "anchored" ? ["phase", "fingerprint"] : row.phase === "observed" ? ["phase", "observation", "outputSha256"] : row.phase === "source" ? ["phase", "sourceSha256"] : [];
      const r = object(json(Buffer.from(row.body)), fields); if (r.phase !== row.phase) throw new AutoWaitlistError("AUTO_STORE");
      if (row.phase === "claimed") {
        if (row.turn !== result.length || row.predecessor !== null) throw new AutoWaitlistError("AUTO_STORE");
        result.push({ turn: row.turn, promptSha256: text(r.promptSha256, SHA256), anchor: null, observation: null, outputSha256: null, sourceSha256: null });
      } else {
        const current = result.at(-1); if (!current || current.turn !== row.turn || row.predecessor !== previous) throw new AutoWaitlistError("AUTO_STORE");
        if (row.phase === "anchored") { if (current.anchor || current.observation) throw new AutoWaitlistError("AUTO_STORE"); current.anchor = fingerprint(r.fingerprint); }
        if (row.phase === "observed") {
          if (current.observation) throw new AutoWaitlistError("AUTO_STORE");
          const o = object(r.observation, ["state", "pid", "fingerprint", "startedAt", "completedAt", "exitCode", "signal", "groupSettled", "stderrBytes"]);
          oneOf(o.state, ["completed", "failed", "unknown"]); iso(o.startedAt); iso(o.completedAt); integer(o.stderrBytes, 0);
          if (o.state !== "unknown" && (!current.anchor || !isDeepStrictEqual(current.anchor, fingerprint(o.fingerprint)) || o.pid !== current.anchor.pid || o.groupSettled !== true || o.signal !== null || !Number.isInteger(o.exitCode)
            || (o.state === "completed" ? o.exitCode !== 0 : o.exitCode === 0))) throw new AutoWaitlistError("AUTO_STORE");
          current.observation = o as unknown as AutoDraftProcessObservation; current.outputSha256 = text(r.outputSha256, SHA256); this.blob(current.outputSha256);
        }
        if (row.phase === "source") { if (!current.observation || current.observation.state !== "completed" || current.sourceSha256) throw new AutoWaitlistError("AUTO_STORE"); current.sourceSha256 = text(r.sourceSha256, SHA256); this.blob(current.sourceSha256); }
      }
      previous = row.sha256;
    }
    return result;
  }
  claimTurn(g: AutoDraftGeneration, prompt: Uint8Array, host: AutoDraftGenerationHost): AutoDraftTurn {
    return this.tx(() => {
      this.assertCurrent(g, host); const turns = this.turns(g), prior = turns.at(-1);
      if (this.current(g.itemId)?.state !== "running" || turns.length >= 33 || prior && (!prior.sourceSha256 || prior.observation?.state !== "completed")) throw new AutoWaitlistError("AUTO_BUSY");
      this.appendTurn(g, turns.length, "claimed", { promptSha256: this.put(prompt) }); return this.turns(g).at(-1)!;
    });
  }
  anchor(g: AutoDraftGeneration, turn: number, value: ProcessFingerprint, host: AutoDraftGenerationHost): void {
    this.tx(() => { this.assertCurrent(g, host); const current = this.turns(g).at(-1); if (!current || current.turn !== turn || current.anchor || current.observation) throw new AutoWaitlistError("AUTO_BUSY"); this.appendTurn(g, turn, "anchored", { fingerprint: fingerprint(value) }); });
  }
  /** Capture actual ORIGINAL observations even after revocation/fencing. This
   * is historical evidence only; no dependent write or continuation is granted. */
  observeTurn(g: AutoDraftGeneration, turn: number, observation: AutoDraftProcessObservation, output: Uint8Array, host: AutoDraftGenerationHost): void {
    this.tx(() => {
      text(synchronous(host.authenticate()), SHA256); const current = this.turns(g).at(-1);
      if (!current || current.turn !== turn || current.observation) throw new AutoWaitlistError("AUTO_BUSY");
      this.appendTurn(g, turn, "observed", { observation, outputSha256: this.put(output) }); this.turns(g);
    });
  }
  source(g: AutoDraftGeneration, turn: number, response: Uint8Array, host: AutoDraftGenerationHost): void {
    this.tx(() => { this.assertCurrent(g, host); const current = this.turns(g).at(-1); if (!current || current.turn !== turn || current.sourceSha256 || current.observation?.state !== "completed") throw new AutoWaitlistError("AUTO_BUSY"); this.appendTurn(g, turn, "source", { sourceSha256: this.put(response) }); });
  }
  uncertain(g: AutoDraftGeneration, host: AutoDraftGenerationHost): AutoDraftGeneration {
    return this.tx(() => {
      text(synchronous(host.authenticate()), SHA256); const current = this.generation(g.itemId, g.generation);
      if (["uncertain", "ready", "questions", "blocked", "quarantined"].includes(current.state)) return current;
      const next = this.change(current, { state: "uncertain" }), item = this.journal.item(g.itemId);
      if (this.journal.active()?.itemId === g.itemId) this.journal.change(item.itemId, item.revision, b => ({ ...b, state: "uncertain", reason: "uncertain", draft: { ...b.draft!, state: "unknown" } }), () => { text(synchronous(host.authenticate()), SHA256); });
      return next;
    });
  }
  resumeKnown(g: AutoDraftGeneration, host: AutoDraftGenerationHost): AutoDraftGeneration {
    return this.tx(() => {
      this.assertCurrent(g, host); const current = this.generation(g.itemId, g.generation), turns = this.turns(g);
      if (current.state !== "uncertain" || !turns.length || turns.some(turn => !turn.observation || turn.observation.state !== "completed")) throw new AutoWaitlistError("AUTO_BUSY");
      const next = this.change(current, { state: "running" }), item = this.journal.item(g.itemId);
      this.journal.change(item.itemId, item.revision, b => ({ ...b, state: "drafting", reason: "none", draft: { ...b.draft!, state: "running" } }), () => this.assertCurrent(next, host));
      return next;
    });
  }
  block(g: AutoDraftGeneration, host: AutoDraftGenerationHost): AutoDraftGeneration {
    return this.tx(() => {
      text(synchronous(host.authenticate()), SHA256); const current = this.generation(g.itemId, g.generation), turns = this.turns(g);
      if (!["running", "uncertain"].includes(current.state) || current.bundleSha256 || turns.some(turn => !turn.observation || turn.observation.state === "unknown")) throw new AutoWaitlistError("AUTO_BUSY");
      const next = this.change(current, { state: "blocked" }), item = this.journal.item(g.itemId);
      if (this.journal.active()?.itemId === g.itemId) this.journal.change(item.itemId, item.revision, b => ({ ...b, state: "blocked", reason: "failure", draft: { ...b.draft!, state: "failed" } }), () => { text(synchronous(host.authenticate()), SHA256); });
      return next;
    });
  }
  output(g: AutoDraftGeneration, bundle: Uint8Array, host: AutoDraftGenerationHost): AutoDraftGeneration {
    return this.tx(() => {
      this.assertCurrent(g, host); const current = this.current(g.itemId)!, last = this.turns(g).at(-1);
      if (!last || last.observation?.state !== "completed" || last.sourceSha256 || !last.outputSha256 || !["running", "uncertain"].includes(current.state)) throw new AutoWaitlistError("AUTO_BUSY");
      return this.change(current, { state: "output-saved", outputSha256: last.outputSha256, bundleSha256: this.put(bundle, 4 * 1_048_576) });
    });
  }
  freeze(g: AutoDraftGeneration, subjectSha256: string, freeze: () => void, host: AutoDraftGenerationHost): AutoDraftGeneration {
    return this.tx(() => { this.assertCurrent(g, host); if (g.state !== "output-saved") throw new AutoWaitlistError("AUTO_BUSY"); if (synchronous(freeze()) !== undefined) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); return this.change(g, { state: "frozen", subjectSha256: text(subjectSha256, SHA256) }); });
  }
  appendIntent(g: AutoDraftGeneration, raw: Uint8Array, host: AutoDraftGenerationHost): AutoDraftGeneration {
    return this.tx(() => { this.assertCurrent(g, host); if (g.state !== "frozen") throw new AutoWaitlistError("AUTO_BUSY"); return this.change(g, { state: "attaching", appendSha256: this.put(raw, 65_536) }); });
  }
  finish(g: AutoDraftGeneration, questions: boolean, assertAppendSettled: () => void, host: AutoDraftGenerationHost): AutoDraftGeneration {
    return this.tx(() => {
      this.assertCurrent(g, host); if (g.state !== "attaching" || !g.subjectSha256 || !g.appendSha256) throw new AutoWaitlistError("AUTO_BUSY"); if (synchronous(assertAppendSettled()) !== undefined) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      const next = this.change(g, { state: questions ? "questions" : "ready" }), item = this.journal.item(g.itemId);
      this.journal.change(item.itemId, item.revision, b => ({ ...b, state: questions ? "blocked" : "awaiting-review", reason: questions ? "question" : "none", subjectSha256: g.subjectSha256, draft: { ...b.draft!, state: "completed" } }), () => this.assertCurrent(next, host));
      return next;
    });
  }
}
