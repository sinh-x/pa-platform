import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readdirSync, symlinkSync, linkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketStore } from "@pa-platform/pa-core";
import { ContextTicketReader } from "../pi-extension/context-ticket.js";
import { initialContextSnapshot, collectContext } from "../pi-extension/context-state.js";
import { contextText } from "../pi-extension/context-text.js";
import type { ContextTicketSummary } from "../pi-extension/context-reader.js";

const summary = (id: string): ContextTicketSummary => ({ id, project: "example", title: id, status: "idea", priority: "medium", assignee: "", summary: "", description: "" });
const tick = () => new Promise(resolve => setImmediate(resolve));
function snapshot(id?: string) {
  const s = initialContextSnapshot({ cwd: "/repo" }, { env: { PA_DEPLOYMENT_ID: "d-test" } });
  s.deployment = { ...s.deployment, project: "example", ticket: id, projectionAvailable: true };
  return s;
}

test("exact summary reads are bounded, no-follow, no-alias and do not initialize or mutate storage", () => {
  const root = mkdtempSync(join(tmpdir(), "context-summary-"));
  try {
    const missing = join(root, "absent");
    assert.throws(() => TicketStore.readSummary("example", "EX-001", missing));
    assert.equal(existsSync(missing), false);
    const ticket = { ...summary("EX-001"), comments: [{ content: "never projected" }], doc_refs: [{ path: "never opened" }] };
    const file = join(root, "EX-001.json");
    const bytes = JSON.stringify(ticket);
    writeFileSync(file, bytes);
    assert.deepEqual(TicketStore.readSummary("example", "EX-001", root), summary("EX-001"));
    assert.equal(TicketStore.readSummary("other", "EX-001", root), undefined);
    writeFileSync(join(root, "EX-002.json"), JSON.stringify({ _alias: true, movedTo: "EX-001" }));
    assert.equal(TicketStore.readSummary("example", "EX-002", root), undefined);
    symlinkSync(file, join(root, "EX-003.json"));
    assert.throws(() => TicketStore.readSummary("example", "EX-003", root));
    linkSync(file, join(root, "EX-004.json"));
    assert.throws(() => TicketStore.readSummary("example", "EX-004", root));
    writeFileSync(join(root, "EX-005.json"), "x".repeat(1024 * 1024 + 1));
    assert.throws(() => TicketStore.readSummary("example", "EX-005", root));
    assert.deepEqual(readdirSync(root).sort(), ["EX-001.json", "EX-002.json", "EX-003.json", "EX-004.json", "EX-005.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("projection distinguishes verified none and unavailable; never falls back to launch", async () => {
  const env = { PA_DEPLOYMENT_ID: "d-test", PA_TICKET_ID: "EX-001" };
  const initial = initialContextSnapshot({ cwd: "/repo" }, { env });
  assert.equal(initial.deployment.ticket, undefined);
  const observed = await collectContext(initial, { cwd: "/repo" }, { env, gitLookup: async () => ({ available: false }), deploymentLookup: async () => ({ ticket: "EX-002", objective: "effective\nobjective" }) });
  const lost = await collectContext(observed, { cwd: "/repo" }, { env, gitLookup: async () => ({ available: false }), deploymentLookup: async () => { throw new Error("private"); } });
  assert.equal(lost.deployment.ticket, undefined);
  assert.equal(lost.deployment.projectionAvailable, false);
  assert.equal(lost.deployment.lastVerifiedTicket, "EX-002");
  assert.equal(lost.deployment.launchTicket, "EX-001");
  assert.equal(lost.deployment.objective, "effective\nobjective");
  const none = await collectContext(lost, { cwd: "/repo" }, { env, gitLookup: async () => ({ available: false }), deploymentLookup: async () => ({}) });
  assert.equal(none.deployment.projectionAvailable, true);
  assert.equal(none.deployment.ticket, undefined);
});

test("A→B→A and overlapping same-ID retries reject obsolete bodies with one in-flight read", async () => {
  const releases: Array<(value: ContextTicketSummary) => void> = [];
  let calls = 0;
  const reader = new ContextTicketReader(async () => { calls++; return await new Promise(resolve => releases.push(resolve)); }, () => {});
  reader.observe(snapshot("EX-001")); reader.setOpen(true); await tick();
  reader.observe(snapshot("EX-002")); reader.observe(snapshot("EX-001"));
  reader.retry(); reader.retry();
  assert.equal(calls, 1);
  releases[0]!(summary("EX-001")); await tick(); await tick();
  assert.equal(reader.state.status, "loading");
  assert.equal(calls, 2);
  releases[1]!(summary("EX-001")); await tick();
  assert.equal(reader.state.status, "ready");
  reader.retry(); await tick(); reader.setOpen(false);
  releases[2]!(summary("EX-001")); await tick();
  assert.notEqual(reader.state.status, "ready");
});

test("verification loss withholds bodies; same-ticket retry recovers after timeout without reassociation", async () => {
  let slow = true;
  const reader = new ContextTicketReader(async () => { if (slow) await new Promise(resolve => setTimeout(resolve, 15)); return summary("EX-001"); }, () => {}, () => 42, 3);
  reader.observe(snapshot("EX-001")); reader.setOpen(true);
  await new Promise(resolve => setTimeout(resolve, 6));
  assert.equal(reader.state.status, "unavailable");
  slow = false; reader.retry();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reader.state.status, "ready");
  const lost = snapshot("EX-001"); lost.deployment.projectionAvailable = false;
  reader.observe(lost);
  assert.deepEqual(reader.state, { status: "withheld" });
  reader.observe(snapshot()); assert.deepEqual(reader.state, { status: "none" });
});

test("literal text disables terminal/bidi controls and explicitly truncates over-budget content", () => {
  assert.equal(contextText("a\r\nb\t\x1b]8;\x07\u202ec"), "a\nb    ?]8;??c");
  assert.equal(contextText("abcdTAIL", 4), "abcd\n[truncated]");
});
