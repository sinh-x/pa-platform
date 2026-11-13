import assert from "node:assert/strict";
import { test } from "node:test";
import { getDb, RegistryAutoJournal, routeAutoTicket, type AutoWorkOwner } from "@pa-platform/pa-core";
import { dispatchPiAuto } from "../auto-runtime.js";
import { deployWithPi } from "../deploy.js";
import { assertPiAutoScope } from "../auto-authority.js";
import type { AutoTerminal } from "../auto-terminal.js";
const terminal: AutoTerminal = { authenticate() {}, display() {}, choose: async () => -1 };
function fixture() {
  const db = getDb(":memory:"), journal = new RegistryAutoJournal(db);
  const entry = routeAutoTicket({ id: "PAP-1", project: "pa-platform", title: "Synthetic", priority: "medium", status: "idea", createdAt: new Date().toISOString(), ticketSha256: "a".repeat(64), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "missing" } });
  const selected = journal.select(entry, "/synthetic", () => entry, () => {});
  const item = journal.change(selected.itemId, selected.revision, b => ({ ...b, state: "approved-pending-dispatch", decisionId: "decision-synthetic", startSha256: "b".repeat(64) }), () => {});
  return { db, journal, item, enable: () => journal.setControl(0, { scansEnabled: true, dispatchEnabled: true, paused: false }, () => {}) };
}
test("paused/default-disabled dispatch performs no launch and preserves the approved original item", async () => {
  const f = fixture(); try {
    let launches = 0; const owner: AutoWorkOwner = { execute: async () => { launches++; return { state: "running", settled: false }; }, observe: async () => ({ state: "unknown", settled: false }) };
    await assert.rejects(() => dispatchPiAuto(f.item, f.journal, terminal, owner)); assert.equal(launches, 0); assert.equal(f.journal.active()!.itemId, f.item.itemId);
  } finally { f.db.close(); }
});
test("exact approved dispatch executes once; lost reply recovers original deployment without another launch", async () => {
  const f = fixture(); try {
    f.enable(); let launches = 0, observed = 0;
    const owner: AutoWorkOwner = { execute: async () => { launches++; throw new Error("lost spawn reply"); }, observe: async () => { observed++; return { state: "unknown", settled: false }; } };
    const first = await dispatchPiAuto(f.item, f.journal, terminal, owner); assert.equal(first.state, "uncertain");
    const again = await dispatchPiAuto(first, f.journal, terminal, owner);
    assert.equal(launches, 1); assert.equal(observed, 1); assert.equal(again.dispatch!.deploymentId, first.dispatch!.deploymentId); assert.ok(f.journal.active());
  } finally { f.db.close(); }
});
test("two competing dispatch requests cannot produce two implementation intents", async () => {
  const f = fixture(); try {
    f.enable(); let launches = 0;
    const owner: AutoWorkOwner = { execute: async () => { launches++; await new Promise(r => setTimeout(r, 10)); return { state: "running", settled: false }; }, observe: async () => ({ state: "running", settled: false }) };
    const results = await Promise.allSettled([dispatchPiAuto(f.item, f.journal, terminal, owner), dispatchPiAuto(f.item, f.journal, terminal, owner)]);
    assert.equal(launches, 1); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  } finally { f.db.close(); }
});
test("native owner stage CAS permits same-intent prelaunch reconciliation but cannot rewind a possible spawn", async () => {
  const f = fixture(); try {
    f.enable(); const owner: AutoWorkOwner = { execute: async () => ({ state: "unknown", settled: false }), observe: async () => ({ state: "unknown", settled: false }) };
    const item = await dispatchPiAuto(f.item, f.journal, terminal, owner), effect = item.dispatch!;
    assert.equal(f.journal.claimEffect(item, effect, () => {}), true);
    f.journal.advanceEffect(item, effect, "claimed", "ticket-effects", () => {});
    f.journal.advanceEffect(item, effect, "ticket-effects", "launch-requested", () => {});
    assert.equal(f.journal.effectStage(effect), "launch-requested");
    assert.throws(() => f.journal.advanceEffect(item, effect, "claimed", "ticket-effects", () => {}));
  } finally { f.db.close(); }
});
test("native auto launcher admission callback rejects before config, workspace or spawn effects", async () => {
  let checks = 0;
  await assert.rejects(() => deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-1" }, undefined, undefined,
    { autoLaunch: { deploymentId: "d-aaaaaa", deadlineAt: new Date(Date.now() + 60_000).toISOString(), assertCurrent() { checks++; throw new Error("fixture denial"); }, baseline() { throw new Error("must not resolve"); } } }));
  assert.equal(checks, 1);
});
test("native source scope excludes unreviewed paths and command changes", () => {
  const intent = { sourceScope: { files: ["src/a.ts"], directories: ["src/shared"], newPaths: ["src/new.ts"] }, validation: { commands: ["corepack pnpm test"] } } as Parameters<typeof assertPiAutoScope>[0];
  assert.doesNotThrow(() => assertPiAutoScope(intent, { paths: ["src/a.ts", "src/shared/a.ts"], checks: ["corepack pnpm test"] }));
  assert.throws(() => assertPiAutoScope(intent, { paths: ["outside.ts"], checks: [] }));
  assert.throws(() => assertPiAutoScope(intent, { paths: ["src/a.ts"], checks: ["git push"] }));
});
