import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../registry/db.js";
import { AutoWaitlistError } from "../auto/waitlist.js";
import { RegistryAutoShortlists } from "../auto/shortlist-journal.js";
import { shortlistFixture, asBytes } from "./auto-shortlist-fixture.js";

const fixture = () => { const db = getDb(":memory:"); return { db, ...shortlistFixture(db) }; };
const denied = (fn: () => unknown) => assert.throws(fn, AutoWaitlistError);

test("reasoning reserves the shared manual/PAP/PAPC slot before any provider request", () => {
  const f = fixture(); try {
    const cycle = f.store.reserve(f.input, f.host);
    assert.equal(f.store.activeCycle()?.cycleId, cycle.cycleId);
    assert.equal(f.store.items.active(), null);
    denied(() => f.store.reserve(f.input, f.host));
    const entry = f.snapshot.entries[0]!;
    denied(() => f.store.items.select(entry, "/synthetic/runtime", () => entry, () => {}));
    const claimed = f.store.claim(cycle, f.host);
    denied(() => f.store.claim(claimed, f.host));
    const unknown = f.store.uncertain(claimed, f.host);
    assert.equal(unknown.state, "uncertain");
    denied(() => f.store.claim(unknown, f.host));
    denied(() => f.store.reserve(f.input, f.host));
  } finally { f.db.close(); }
});

test("manual selections and all held item states prevent a competing reasoning cycle", () => {
  const f = fixture(); try {
    const entry = f.snapshot.entries[0]!;
    let item = f.store.items.select(entry, "/synthetic/runtime", () => entry, () => {});
    for (const state of ["selected", "drafting", "blocked", "uncertain", "running", "review-ready"] as const) {
      item = f.store.items.change(item.itemId, item.revision, b => ({ ...b, state }), () => {});
      denied(() => f.store.reserve(f.input, f.host));
    }
  } finally { f.db.close(); }
});

test("reasoning stores complete source, safe goal and original request immutably with CAS/hash chains", () => {
  const f = fixture(); try {
    const cycle = f.store.reserve(f.input, f.host);
    assert.deepEqual(f.store.snapshot(cycle), f.snapshot);
    assert.deepEqual(f.store.blob(cycle.goalEvidenceSha256), f.input.goalEvidence);
    assert.deepEqual(f.store.blob(cycle.requestSha256), f.input.request);
    f.store.claim(cycle, f.host);
    denied(() => f.store.claim(cycle, f.host));
    assert.throws(() => f.db.prepare("UPDATE auto_reasoning_events SET body='{}'").run(), /append-only/);
    assert.throws(() => f.db.prepare("DELETE FROM auto_shortlist_blobs").run(), /immutable/);
    f.db.prepare("UPDATE auto_reasoning_cycles SET sha256=?").run("a".repeat(64));
    denied(() => f.store.activeCycle());
  } finally { f.db.close(); }
});

test("reasoning refuses incomplete scan coverage, identity/goal drift, invalid expiry and native admission denial before reserving", () => {
  for (const variant of ["coverage", "goal", "future", "deadline", "source", "host"] as const) {
    const f = fixture(); try {
      const input = structuredClone(f.input);
      if (variant === "coverage") input.context.eligibleTickets.pop();
      if (variant === "goal") input.goalEvidence = asBytes({ changed: true });
      if (variant === "future") f.setNow("2026-11-14T02:59:00.000Z");
      if (variant === "deadline") input.deadlineAt = "2026-11-14T03:10:00.001Z";
      const host = variant === "source" ? { ...f.host, reobserve: () => ({ ...f.context, configSha256: "e".repeat(64) }) } : variant === "host" ? { ...f.host, authenticate: () => { throw new AutoWaitlistError("AUTO_UNAVAILABLE"); } } : f.host;
      denied(() => f.store.reserve(input, host)); assert.equal(f.store.activeCycle(), null);
    } finally { f.db.close(); }
  }
});

test("raw invalid/incomplete output is retained, never a fresh empty shortlist or safe relaunch", () => {
  const f = fixture(); try {
    let cycle = f.store.claim(f.store.reserve(f.input, f.host), f.host);
    cycle = f.store.captureOutput(cycle, asBytes({ invalid: "output" }), f.host);
    denied(() => f.store.saveReport(cycle, f.session(cycle, 20), f.host));
    assert.deepEqual(JSON.parse(f.store.blob(cycle.outputSha256!).toString()), { invalid: "output" });
    assert.equal(f.store.head(), null); assert.equal(f.store.activeCycle()?.cycleId, cycle.cycleId);
    denied(() => f.store.captureOutput(cycle, asBytes(f.assessment()), f.host));
  } finally { f.db.close(); }
});

test("complete report precedes native publication, preserves 13 candidates and at most ten recommendations without owning a ticket", () => {
  const f = fixture(); try {
    const { cycle, shortlist } = f.saved();
    assert.equal(f.store.report(cycle).assessment.assessments.length, 13);
    assert.equal(shortlist.report.assessment.shortlist.length, 10);
    assert.equal(f.store.activeCycle(), null); assert.equal(f.store.items.active(), null);
    assert.deepEqual(f.store.head(), shortlist);
    assert.deepEqual(f.store.publish(cycle, "2026-11-14T03:30:00.000Z", f.host), shortlist); // Same original publication after reply loss.
    assert.throws(() => f.db.prepare("UPDATE auto_shortlists SET sha256='x'").run(), /immutable/);
    denied(() => f.store.reserve(f.input, f.host)); // Registered deployment identity must never be reused.
  } finally { f.db.close(); }
});

test("native session proof and bounds are required; a passed/cleanup flag cannot replace the owner", () => {
  const f = fixture(); try {
    let cycle = f.store.claim(f.store.reserve(f.input, f.host), f.host), raw = asBytes(f.assessment());
    cycle = f.store.captureOutput(cycle, raw, f.host);
    const proof = f.session(cycle, raw.length);
    for (const patch of [{ sourceRequests: 33 }, { contextBytes: 1_048_577 }, { outputBytes: raw.length + 1 }, { completedAt: "2026-11-14T03:10:00.001Z" }, { operationId: "operation-wrong" }, { configRevision: "wrong" }]) denied(() => f.store.saveReport(cycle, { ...proof, ...patch }, f.host));
    denied(() => f.store.saveReport(cycle, proof, { ...f.host, assertSession: () => { throw new AutoWaitlistError("AUTO_SOURCE"); } }));
    assert.equal(f.store.cycle(cycle.cycleId).reportSha256, null);
    cycle = f.store.saveReport(cycle, proof, f.host);
    f.setNow("2026-11-14T03:02:00.000Z");
    denied(() => f.store.publish(cycle, "2026-11-14T03:30:00.001Z", f.host));
    denied(() => f.store.publish(cycle, "2026-11-14T03:30:00.000Z", { ...f.host, reobserve: () => ({ ...f.context, goalSha256: "e".repeat(64) }) }));
    assert.equal(f.store.head(), null); assert.equal(f.store.activeCycle()?.state, "report-saved");
  } finally { f.db.close(); }
});

test("explicit native non-top choice records immutable human evidence and one globally held item, without a start grant", async () => {
  const f = fixture(); try {
    const { shortlist } = f.saved();
    const result = await f.store.choose(shortlist.version, f.host), item = f.store.items.active()!;
    assert.equal(result.state, "accepted"); assert.equal(result.ticket, shortlist.report.assessment.shortlist[2]!.ticket);
    assert.notEqual(result.ticket, shortlist.report.assessment.shortlist[0]!.ticket);
    assert.equal(item.itemId, result.itemId); assert.equal(item.decisionId, null); assert.equal(item.dispatch, null);
    assert.equal(f.store.selectionForItem(item.itemId)?.requestId, result.requestId);
    assert.deepEqual(f.store.reconcileChoice(result.requestId, f.host), result);
    assert.equal(f.store.pendingChoice(), null);
    assert.throws(() => f.db.prepare("DELETE FROM auto_choice_events").run(), /append-only/);
    denied(() => f.store.reserve(f.input, f.host));
  } finally { f.db.close(); }
});

test("Cancel records cancellation and creates no selection, approval, drafting or implementation", async () => {
  const f = fixture(); try {
    const { shortlist } = f.saved();
    const result = await f.store.choose(shortlist.version, { ...f.host, capture: (request, report) => f.capture(request, report, null) });
    assert.equal(result.state, "cancelled"); assert.equal(result.ticket, null); assert.equal(f.store.items.active(), null); assert.equal(f.store.pendingChoice(), null);
  } finally { f.db.close(); }
});

test("zero suitable items never open a choice interaction or create filler", async () => {
  const f = fixture(); try {
    const { shortlist } = f.saved(0); let captures = 0;
    await assert.rejects(f.store.choose(shortlist.version, { ...f.host, capture: async (...args) => { captures++; return f.capture(...args); } }), AutoWaitlistError);
    assert.equal(captures, 0); assert.equal(f.store.pendingChoice(), null); assert.equal(f.store.items.active(), null);
  } finally { f.db.close(); }
});

test("lost choice reply retains the original requested interaction and fences competing manual/CLI choices", async () => {
  const f = fixture(); try {
    const { shortlist } = f.saved(); let prompts = 0;
    const host = { ...f.host, capture: async () => { prompts++; throw new Error("reply lost"); } };
    await assert.rejects(f.store.choose(shortlist.version, host));
    const pending = f.store.pendingChoice()!; assert.equal(pending.state, "requested");
    await assert.rejects(f.store.choose(shortlist.version, host), AutoWaitlistError);
    denied(() => f.store.reconcileChoice(pending.requestId, f.host));
    const entry = f.snapshot.entries[0]!; denied(() => f.store.items.select(entry, "/synthetic/runtime", () => entry, () => {}));
    assert.equal(prompts, 1); assert.equal(f.store.items.active(), null);
  } finally { f.db.close(); }
});

test("stale/expired/drifted or foreign explicit choices are refused after capture without substitution", async () => {
  for (const variant of ["expiry", "drift", "foreign"] as const) {
    const f = fixture(); try {
      const { shortlist } = f.saved(); let drift = false;
      const result = await f.store.choose(shortlist.version, { ...f.host,
        reobserve: cycle => drift ? { ...f.context, policySha256: "f".repeat(64) } : f.host.reobserve(cycle),
        capture: async (request, report) => {
          if (variant === "expiry") f.setNow("2026-11-14T03:30:00.000Z");
          if (variant === "drift") drift = true;
          return f.capture(request, report, variant === "foreign" ? "PAP-999" : report.report.assessment.shortlist[2]!.ticket);
        } });
      assert.equal(result.state, "refused"); assert.equal(result.reason, "stale-or-busy"); assert.equal(f.store.items.active(), null);
      assert.ok(result.evidenceSha256); assert.equal(f.store.pendingChoice(), null);
    } finally { f.db.close(); }
  }
});

test("an observed choice with interrupted final CAS reconciles original evidence without another prompt", async () => {
  const f = fixture(); try {
    const { shortlist } = f.saved(); let observations = 0, captures = 0;
    const host = { ...f.host, reobserve: cycle => { if (++observations === 3) throw new AutoWaitlistError("AUTO_SOURCE"); return f.host.reobserve(cycle); },
      capture: async (...args: Parameters<typeof f.capture>) => { captures++; return f.capture(...args); } };
    await assert.rejects(f.store.choose(shortlist.version, host), AutoWaitlistError);
    const pending = f.store.pendingChoice()!; assert.equal(pending.state, "observed");
    const accepted = f.store.reconcileChoice(pending.requestId, f.host);
    assert.equal(accepted.state, "accepted"); assert.equal(captures, 1);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM auto_items").get() as { n: number }).n, 1);
  } finally { f.db.close(); }
});

test("refresh during an open native view refuses the old choice and preserves both immutable reports", async () => {
  const f = fixture(); try {
    const original = f.saved().shortlist;
    const result = await f.store.choose(original.version, { ...f.host, capture: async (request, report) => {
      f.context.sessionId = "d-dadada";
      let cycle = f.store.claim(f.store.reserve({ ...f.input, deadlineAt: "2026-11-14T03:12:00.000Z" }, f.host), f.host);
      const raw = asBytes(f.assessment()); cycle = f.store.captureOutput(cycle, raw, f.host);
      cycle = f.store.saveReport(cycle, { ...f.session(cycle, raw.length), completedAt: "2026-11-14T03:03:00.000Z" }, f.host);
      f.setNow("2026-11-14T03:04:00.000Z");
      f.store.publish(cycle, "2026-11-14T03:30:00.000Z", f.host);
      return f.capture(request, report);
    } });
    assert.equal(result.state, "refused"); assert.equal(f.store.items.active(), null);
    assert.notEqual(f.store.head()!.version, original.version); assert.deepEqual(f.store.published(original.version), original);
  } finally { f.db.close(); }
});

test("two real processes racing native choices record exactly one accepted human choice/item", async () => {
  const folder = mkdtempSync(join(tmpdir(), "pap302-choice-race-")), path = join(folder, "registry.db"), prepared = getDb(path);
  shortlistFixture(prepared).saved(); prepared.close();
  const script = new URL("./fixtures/auto-reasoning-worker.mts", import.meta.url);
  const start = () => spawn(process.execPath, ["--import=tsx", script.pathname, path, "choice"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const a = start(), b = start(), exits = [once(a, "exit"), once(b, "exit")];
  try {
    assert.deepEqual((await Promise.all(exits)).map(r => r[0]).sort(), [0, 2]);
    const db = getDb(path); try {
      const store = new RegistryAutoShortlists(db), item = store.items.active()!;
      assert.equal(store.selectionForItem(item.itemId)?.state, "accepted");
      assert.equal((db.prepare("SELECT count(*) AS n FROM auto_choice_requests").get() as { n: number }).n, 1);
    } finally { db.close(); }
  } finally { for (const child of [a, b]) if (child.exitCode === null) child.kill("SIGKILL"); rmSync(folder, { recursive: true, force: true }); }
});

test("two real processes racing a reasoning reservation and manual selection have one durable winner", async () => {
  const folder = mkdtempSync(join(tmpdir(), "pap302-reasoning-race-")), path = join(folder, "registry.db"); getDb(path).close();
  const script = new URL("./fixtures/auto-reasoning-worker.mts", import.meta.url);
  const start = (kind: string) => spawn(process.execPath, ["--import=tsx", script.pathname, path, kind], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const a = start("reasoning"), b = start("manual"), exits = [once(a, "exit"), once(b, "exit")];
  try {
    const results = await Promise.all(exits); assert.deepEqual(results.map(r => r[0]).sort(), [0, 2]);
    const db = getDb(path); try { const store = new RegistryAutoShortlists(db); assert.equal(Number(Boolean(store.activeCycle())) + Number(Boolean(store.items.active())), 1); } finally { db.close(); }
  } finally { for (const child of [a, b]) if (child.exitCode === null) child.kill("SIGKILL"); rmSync(folder, { recursive: true, force: true }); }
});
