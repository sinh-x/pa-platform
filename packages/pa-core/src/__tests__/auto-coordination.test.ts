import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getDb } from "../registry/db.js";
import { RegistryAutoJournal, AutoCoordinator, type AutoItem, type AutoWorkOwner } from "../auto/coordination.js";
import { routeAutoTicket, AutoWaitlistError, type AutoWaitlistEntry } from "../auto/waitlist.js";
const entry = (project: "pa-platform" | "pa-platform-config" = "pa-platform"): AutoWaitlistEntry => routeAutoTicket({ id: project === "pa-platform" ? "PAP-1" : "PAPC-1", project, title: "Synthetic", status: "idea", priority: "medium", createdAt: new Date().toISOString(), ticketSha256: "a".repeat(64), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "missing" } });
const fixture = () => { const db = getDb(":memory:"), journal = new RegistryAutoJournal(db); return { db, journal, coordinator: new AutoCoordinator(journal, () => {}), select: () => { const e = entry(); return journal.select(e, "/synthetic/repo", () => e, () => {}); } }; };
test("one global slot holds every nonterminal state across both projects", () => {
  const f = fixture();
  try {
    let current = f.select();
    for (const state of ["selected", "drafting", "awaiting-review", "approved-pending-dispatch", "running", "blocked", "uncertain", "review-ready"] as const) {
      current = f.journal.change(current.itemId, current.revision, before => ({ ...before, state }), () => {});
      const other = entry("pa-platform-config"); assert.throws(() => f.journal.select(other, "/synthetic/config", () => other, () => {}), AutoWaitlistError);
      assert.equal(f.journal.active()!.itemId, current.itemId);
    }
    f.coordinator.close(current, "closed", () => {}); assert.equal(f.journal.active(), null);
    const other = entry("pa-platform-config"); assert.equal(f.journal.select(other, "/synthetic/config", () => other, () => {}).ticket, "PAPC-1");
  } finally { f.db.close(); }
});
test("selection reobserves exact context and authenticates inside the transaction", () => {
  const f = fixture(); try {
    const e = entry(); assert.throws(() => f.journal.select(e, "/synthetic", () => ({ ...e, ticketSha256: "b".repeat(64) }), () => {}));
    assert.throws(() => f.journal.select(e, "/synthetic", () => e, () => { throw new Error("denied"); })); assert.equal(f.journal.active(), null);
  } finally { f.db.close(); }
});
test("coordination CAS, hash chain and append-only events detect corruption", () => {
  const f = fixture(); try {
    const item = f.select(); f.journal.change(item.itemId, 1, b => ({ ...b, state: "blocked" }), () => {});
    assert.throws(() => f.journal.change(item.itemId, 1, b => ({ ...b }), () => {}), AutoWaitlistError);
    assert.throws(() => f.db.prepare("UPDATE auto_events SET body='{}'").run(), /append-only/);
    assert.throws(() => f.db.prepare("DELETE FROM auto_events").run(), /append-only/);
    f.db.prepare("UPDATE auto_items SET body='{}'").run(); assert.throws(() => f.journal.active(), AutoWaitlistError);
  } finally { f.db.close(); }
});
test("controls are disabled and paused by default; pause is durable CAS, not worker termination", () => {
  const f = fixture(); try {
    assert.deepEqual(f.journal.control(), { revision: 0, scansEnabled: false, dispatchEnabled: false, paused: true });
    f.journal.setControl(0, { scansEnabled: true, dispatchEnabled: true, paused: false }, () => {});
    assert.throws(() => f.journal.setControl(0, { scansEnabled: true, dispatchEnabled: true, paused: true }, () => {}), AutoWaitlistError);
    const item = f.select(); f.journal.setControl(1, { scansEnabled: false, dispatchEnabled: false, paused: true }, () => {});
    assert.equal(f.journal.active()!.itemId, item.itemId);
  } finally { f.db.close(); }
});
test("lost draft reply reconciles the original intent without another execution", async () => {
  const f = fixture(); try {
    let executions = 0;
    const owner: AutoWorkOwner = { execute: async () => { executions++; throw new Error("lost reply"); }, observe: async () => ({ state: "draft-ready", settled: true, subjectSha256: "b".repeat(64) }) };
    const uncertain = await f.coordinator.draft(f.select(), owner); assert.equal(uncertain.state, "uncertain");
    assert.throws(() => f.coordinator.close(uncertain, "closed", () => {}), AutoWaitlistError);
    const ready = await f.coordinator.draft(uncertain, owner); assert.equal(ready.state, "awaiting-review"); assert.equal(executions, 1);
    assert.equal(ready.draft!.operationId, uncertain.draft!.operationId); assert.equal(ready.subjectSha256, "b".repeat(64));
  } finally { f.db.close(); }
});
test("native effect claims survive response loss and never infer permission from a missing PID", async () => {
  const f = fixture(); try {
    const owner: AutoWorkOwner = { execute: async () => ({ state: "running", settled: false }), observe: async () => ({ state: "unknown", settled: false }) };
    const item = await f.coordinator.draft(f.select(), owner);
    assert.equal(f.journal.claimEffect(item, item.draft!, () => {}), true); assert.equal(f.journal.claimEffect(item, item.draft!, () => {}), false);
    const result = await f.coordinator.reconcile(item, owner, "draft"); assert.equal(result.state, "uncertain");
    assert.equal(f.journal.active()!.itemId, item.itemId);
  } finally { f.db.close(); }
});
test("close preserves evidence and requires the actual owner's settled proof", async () => {
  const f = fixture(); try {
    const owner: AutoWorkOwner = { execute: async () => ({ state: "failed", settled: true }), observe: async () => ({ state: "failed", settled: true }) };
    const item = await f.coordinator.draft(f.select(), owner);
    assert.throws(() => f.coordinator.close(item, "closed", () => { throw new Error("custody uncertain"); }));
    f.coordinator.close(item, "closed", () => {}); assert.equal(f.journal.item(item.itemId).state, "closed"); assert.ok(f.journal.history(item.itemId).length >= 4);
  } finally { f.db.close(); }
});
test("independent processes racing PAP/PAPC selection admit one durable winner", async () => {
  const folder = mkdtempSync(join(tmpdir(), "pap302-slot-")), dbPath = join(folder, "registry.db"); getDb(dbPath).close();
  const script = new URL("./fixtures/auto-selection-worker.mts", import.meta.url);
  const start = (project: string) => spawn(process.execPath, ["--import=tsx", script.pathname, dbPath, project], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const a = start("pa-platform"), b = start("pa-platform-config"), exits = [once(a, "exit"), once(b, "exit")];
  try {
    const results = await Promise.all(exits); assert.deepEqual(results.map(r => r[0]).sort(), [0, 2]);
    const db = getDb(dbPath); try { assert.ok(new RegistryAutoJournal(db).active()); assert.equal((db.prepare("SELECT count(*) AS n FROM auto_items").get() as { n: number }).n, 1); } finally { db.close(); }
  } finally { for (const p of [a, b]) if (p.exitCode === null) p.kill("SIGKILL"); rmSync(folder, { recursive: true, force: true }); }
});
