import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { getDb } from "../registry/db.js";
import { RegistryWorkflowJournal } from "../registry/workflows.js";
import { digest, JsonWorkflowError, type EvidenceRef, type WorkflowDefinition } from "../workflows/contracts.js";
import { parseWorkflowDefinition } from "../workflows/definition.js";
import { JsonWorkflowService, type WorkflowEffectOwner, type WorkflowHost } from "../workflows/service.js";
import type { WorkflowSelection } from "../workflows/selected.js";
import { bundle, bytes, definition } from "./workflow-fixtures.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-json-workflow-")); const db = getDb(join(root, "registry.db"));
  const journal = new RegistryWorkflowJournal(db); const d: WorkflowDefinition = definition();
  d.requiredCapabilities.push("artifact.paired-publication"); d.steps[0]!.transitions.approved = "publish";
  d.steps.push({ id: "publish", order: 2, title: "Publish exact pair", kind: "publication", owner: "tickets", dependsOn: [{ stepId: "approve", outcome: "approved" }], when: true,
    inputs: [{ name: "package", schemaVersion: "pa-review-bundle/v1", source: "context", field: "bundle" }, { name: "decision", schemaVersion: "pa-decision/v1", source: "output", stepId: "approve", output: "decision" }],
    operation: { id: "publication.pair", version: "v1" }, authorization: ["artifact.publish-pair"], effects: ["artifact.write-pair"], outputs: [{ name: "pair", schemaVersion: "pa-publication-pair/v1" }],
    verification: [{ id: "publication.exact-pair", version: "v1", inputs: ["package", "decision"] }], transitions: { completed: "completed", failed: "blocked", unknown: "blocked" }, failurePolicy: { strategy: "reconcile", correctionOwner: "tickets" } });
  const raw = bytes(d); parseWorkflowDefinition(raw); const b = bundle(); b.workflow.sha256 = digest(raw);
  const evidence = new Map([[b.requirements.ref, Buffer.from("requirements")], [b.uat.ref, Buffer.from("uat")]]);
  b.requirements.sha256 = digest(evidence.get(b.requirements.ref)!); b.uat.sha256 = digest(evidence.get(b.uat.ref)!); b.matrix.sha256 = b.requirements.sha256;
  const selection: WorkflowSelection = { schemaVersion: "pa-workflow-selection/v1", configRoot: "/selected", configRevision: "a".repeat(40), manifestSha256: "a".repeat(64), bindings: [{ schemaVersion: "pa-workflow-binding/v1", team: "builder", mode: "orchestrator", enabled: true, workflowId: d.workflowId, workflowVersion: d.version }], definitions: [{ definition: d, raw, sha256: digest(raw), configRoot: "/selected", configRevision: "a".repeat(40), manifestSha256: "a".repeat(64) }] };
  let captures = 0;
  const ref = (): EvidenceRef => ({ schemaVersion: "pa-workflow-evidence-ref/v1", ref: `synthetic-capture-${++captures}`, version: "v1", sha256: digest(`synthetic-${captures}`) });
  const host: WorkflowHost = { authenticate: () => ({ deploymentId: "d-abcdef", repoKey: b.repository.key, repoRoot: b.repository.root, ticket: b.ticket, team: b.route.team, mode: b.route.mode, identitySha256: "a".repeat(64) }),
    observations: () => ({ capabilities: new Set(d.requiredCapabilities), projectProfile: "supported", producerContract: "supported", readEvidence: r => evidence.get(r.ref) ?? null }),
    capture: async () => ({ outcome: "approved", principal: "synthetic-test-operator", evidence: ref() }), owners: new Map(), now: () => "2026-10-28T00:00:00.000Z" };
  const service = new JsonWorkflowService(journal, host);
  return { db, journal, host, selection, service, subject: bytes(b), close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
test("pinned continuation, immutable snapshots, approval/rejection and revocation do not depend on summaries", async () => {
  const f = fixture(); try {
    const admitted = f.service.admit(f.selection, f.subject); const decision = await f.service.decide(admitted.runId, 1, "approve");
    assert.equal(decision.permissions.length, 6); assert.deepEqual(f.service.next(admitted.runId).blocked, [{ stepId: "publish", code: "WORKFLOW_CAPABILITY" }]);
    const disabled = { ...f.selection, bindings: f.selection.bindings.map(b => ({ ...b, enabled: false })) };
    assert.throws(() => f.service.admit(disabled, f.subject), /WORKFLOW_DISABLED/);
    const reloaded = new JsonWorkflowService(f.journal, f.host); assert.equal(reloaded.status(admitted.runId).definition.version, "r001");
    const revoked = await reloaded.revoke(admitted.runId, 2, decision.decisionId); assert.deepEqual(revoked.revoked, [decision.decisionId]);
    await assert.rejects(reloaded.requestStep(admitted.runId, 3, "publish", decision.decisionId), /WORKFLOW_AUTHORITY/);
    assert.equal(reloaded.status(admitted.runId).decisions.length, 1);
    assert.throws(() => f.db.prepare("UPDATE workflow_events SET body = '{}' WHERE run_id = ?").run(admitted.runId), /append-only/);
    assert.throws(() => f.db.prepare("DELETE FROM workflow_snapshots").run(), /immutable/);
    const exported = reloaded.status(admitted.runId); exported.outcomes.publish = "completed";
    assert.equal(reloaded.status(admitted.runId).outcomes.publish, undefined);
  } finally { f.close(); }
});
test("stale dialogs, foreign callers and public unissued records cannot advance", async () => {
  const f = fixture(); try {
    const run = f.service.admit(f.selection, f.subject);
    const original = f.host.capture;
    // Use a separate host to advance while the outer dialog is open, without recursion.
    const other = new JsonWorkflowService(f.journal, { ...f.host, capture: original });
    f.host.capture = async request => { await other.decide(run.runId, 1, "approve"); return original(request); };
    await assert.rejects(f.service.decide(run.runId, 1, "approve"), /WORKFLOW_CONFLICT/);
    assert.equal(f.service.status(run.runId).decisions.length, 1);
    f.host.authenticate = () => ({ ...run.caller, ticket: "EX-2" });
    await assert.rejects(f.service.requestStep(run.runId, 2, "publish", "unissued-json-decision"), /WORKFLOW_AUTHORITY/);
  } finally { f.close(); }
});
test("same-intent crash recovery reuses proof, unknown blocks and revocation still permits settlement", async () => {
  const f = fixture(); try {
    const run = f.service.admit(f.selection, f.subject); const decision = await f.service.decide(run.runId, 1, "approve");
    let effects = 0; let proven = false; let crash = true;
    const owner: WorkflowEffectOwner = { admit: () => {}, observe: async () => proven ? { state: "proven", outcome: "completed", evidence: [{ schemaVersion: "pa-workflow-evidence-ref/v1", ref: "synthetic-pair", version: "v1", sha256: "a".repeat(64) }] } : { state: "absent" },
      execute: async () => { effects++; proven = true; if (crash) throw new Error("injected after effect"); return { state: "unknown" }; }, verify: (_intent, result) => result.state === "proven" && proven };
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("publication.pair", owner);
    await assert.rejects(f.service.requestStep(run.runId, 2, "publish", decision.decisionId), /injected/);
    const pending = f.service.status(run.runId); assert.equal(pending.pending.length, 1); assert.equal(effects, 1);
    await f.service.revoke(run.runId, 3, decision.decisionId); crash = false;
    const settled = await f.service.reconcile(run.runId, 4, pending.pending[0]!.intentId);
    assert.equal(settled.outcomes.publish, "completed"); assert.equal(effects, 1);
  } finally { f.close(); }
});
test("unknown result preserves the intent; unsupported owners never create an intent", async () => {
  const f = fixture(); try {
    const run = f.service.admit(f.selection, f.subject); const decision = await f.service.decide(run.runId, 1, "approve");
    await assert.rejects(f.service.requestStep(run.runId, 2, "publish", decision.decisionId), /WORKFLOW_CAPABILITY/);
    assert.equal(f.service.status(run.runId).revision, 2);
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("publication.pair", { admit: () => {}, observe: async () => ({ state: "unknown" }), execute: async () => { throw new Error("must not execute"); }, verify: () => false });
    await assert.rejects(f.service.requestStep(run.runId, 2, "publish", decision.decisionId), /WORKFLOW_UNCERTAIN/);
    assert.equal(f.service.status(run.runId).pending.length, 1);
  } finally { f.close(); }
});
test("32 actual SQLite connections racing one revision accept exactly one append", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-workflow-cas-")); const path = join(root, "registry.db"); const db = getDb(path);
  try {
    const barrier = new SharedArrayBuffer(4); const signal = new Int32Array(barrier);
    const source = `const { parentPort, workerData } = require('node:worker_threads');
(async () => {
 const { tsImport } = await import(workerData.tsx);
 const { getDb } = await tsImport(workerData.dbModule, workerData.dbModule);
 const { RegistryWorkflowJournal } = await tsImport(workerData.journalModule, workerData.journalModule);
 const db = getDb(workerData.path); const journal = new RegistryWorkflowJournal(db);
 parentPort.postMessage('ready'); Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
 try { journal.append('wf-race', 0, () => ({ eventId: 'event-race', type: 'admitted', data: {} })); parentPort.postMessage('accepted'); }
 catch (e) { parentPort.postMessage(e.code === 'WORKFLOW_CONFLICT' ? 'conflict' : 'unexpected'); }
 finally { db.close(); }
})().catch(e => { throw e; });`;
    const workers = Array.from({ length: 32 }, () => new Worker(source, { eval: true, workerData: { barrier, path, tsx: import.meta.resolve("tsx/esm/api"), dbModule: new URL("../registry/db.ts", import.meta.url).href, journalModule: new URL("../registry/workflows.ts", import.meta.url).href } }));
    let ready = 0;
    const results = await Promise.all(workers.map(worker => new Promise<string>((resolve, reject) => { worker.on("error", reject); worker.on("message", message => { if (message === "ready") { ready++; if (ready === 32) { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0, 32); } } else resolve(String(message)); }); })));
    await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => { if (worker.threadId === -1) resolve(); else { worker.once("exit", code => code === 0 ? resolve() : reject(new Error("worker failed"))); worker.once("error", reject); } })));
    assert.equal(results.filter(r => r === "accepted").length, 1); assert.equal(results.filter(r => r === "conflict").length, 31);
    assert.equal(new RegistryWorkflowJournal(db).read("wf-race").length, 1);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
