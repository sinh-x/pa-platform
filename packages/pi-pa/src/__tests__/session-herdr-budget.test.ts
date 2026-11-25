import assert from "node:assert/strict";
import test from "node:test";
import { captureHerdrLocations, type HerdrCapture } from "../session-herdr.js";
import type { HerdrPane, HerdrSource } from "../session-herdr-source.js";
import type { ProcessReader } from "../session-process.js";
const fp = (pid: number) => ({ pid, startTimeTicks: String(pid), bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
const read: ProcessReader = pid => ({ kind: "present", fingerprint: fp(pid), parentPid: pid === 42 ? 20 : 0, state: "S", jobControl: { group: 20, session: 20, tty: 1, foregroundGroup: 20 } });

/** Deterministic virtual I/O waves: each outstanding read takes ten clock ticks.
 * No wall-clock timing assertion and no real HerdR processes/sockets. */
async function scheduledCapture(count: number, move = false) {
  let now = 0, active = 0, peak = 0, foregroundCalls = 0, snapshots = 0, settled = false;
  const pending: Array<() => void> = [];
  const panes: HerdrPane[] = Array.from({ length: count }, (_, i) => ({ workspaceId: "w1", workspaceLabel: "Project", tabId: "t1", tabLabel: "Task", paneId: `p${i}`, terminalId: `term${i}` }));
  const source: HerdrSource = {
    roster: async () => ({ endpoints: [{ name: "one", socketPath: "/inert/one.sock", identity: "one" }], complete: true, reasons: [] }),
    snapshot: async () => { snapshots++; return move && snapshots > 1 ? panes.map(pane => ({ ...pane, tabLabel: "Moved" })) : panes; },
    foreground: async (_endpoint, paneId) => {
      foregroundCalls++; active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => pending.push(resolve)); active--;
      return paneId === "p0" ? [20] : paneId === "p1" ? [43] : [];
    },
  };
  let result: HerdrCapture | undefined;
  const collecting = captureHerdrLocations(new Map([["d-000001", fp(42)], ["d-000002", fp(43)]]), source, read, 100, () => now)
    .then(value => { result = value; }).finally(() => { settled = true; });
  for (let turn = 0; !settled && turn < 1000; turn++) {
    await new Promise(resolve => setImmediate(resolve));
    if (pending.length) { now += 10; for (const resolve of pending.splice(0)) resolve(); }
  }
  assert.ok(settled, "bounded virtual collector must settle"); await collecting;
  return { result: result!, peak, foregroundCalls, snapshots, now };
}
test("many-pane capture completes with bounded parallel reads and coalesced topology rechecks", async () => {
  const observed = await scheduledCapture(40);
  assert.equal(observed.result.mappings.get("d-000001")!.state, "mapped");
  assert.equal(observed.result.mappings.get("d-000002")!.state, "mapped");
  assert.equal(observed.result.complete, true); assert.ok(observed.peak > 1); assert.ok(observed.peak <= 8);
  assert.equal(observed.foregroundCalls, 42); assert.equal(observed.snapshots, 2, "one initial and one shared same-endpoint recheck");
  assert.ok(observed.now < 100);
});
test("discovery exhaustion reserves recheck time and qualifies stable hits without claiming uniqueness", async () => {
  const observed = await scheduledCapture(96);
  assert.equal(observed.result.mappings.get("d-000001")!.state, "qualified");
  assert.equal(observed.result.mappings.get("d-000002")!.state, "qualified");
  assert.equal(observed.result.complete, false); assert.ok(observed.result.reasons.includes("herdr-pane-budget-exhausted"));
  assert.ok(!observed.result.reasons.includes("herdr-recheck-budget-exhausted")); assert.ok(observed.peak <= 8);
  assert.ok(observed.foregroundCalls < 98); assert.ok(observed.now < 100);
});
test("parallelism never turns changed topology into a reported location", async () => {
  const observed = await scheduledCapture(40, true);
  for (const mapping of observed.result.mappings.values()) { assert.equal(mapping.state, "unknown"); assert.ok(!("location" in mapping)); }
  assert.equal(observed.result.complete, false); assert.ok(observed.result.reasons.includes("herdr-match-changed-or-unavailable"));
});
