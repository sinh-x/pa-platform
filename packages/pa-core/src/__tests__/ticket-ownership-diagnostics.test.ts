import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../registry/db.js";
import { emitStartedEvent, emitPidEvent, emitCompletedEvent } from "../deploy/events.js";
import { TicketStore } from "../tickets/store.js";
import { TicketStatusError } from "../tickets/status-intent.js";
import { assertTicketAdminOwner, assertTicketStatusOwner } from "../tickets/status-service.js";
import { renderTicketOwnershipDiagnostic, TICKET_OWNERSHIP_CAUSES } from "../tickets/ownership-diagnostic.js";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";
import type { WorkflowEffectOwner } from "../workflows/service.js";
import { assertWorkflowMarkerReferences, assertWorkflowMarkerAvailable } from "../workflows/catalog.js";
import { JsonWorkflowError, digest } from "../workflows/contracts.js";
import { WorkflowMarkerError } from "../workflows/marker-diagnostic.js";
import { bytes } from "./workflow-fixtures.js";
import { RegistryDocumentJournal } from "../registry/documents.js";

const caller = { deploymentId: "d-352001", repoKey: "example" };
function fixture(run: (root: string, store: TicketStore) => void): void {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "ticket-cause-")); closeDb();
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("PA_")) delete process.env[key];
    const config = join(root, "config"); mkdirSync(config); mkdirSync(join(root, "tickets"));
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${root}\n  prefix: EX\n`);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), NO_COLOR: "1" });
    const store = new TicketStore(join(root, "tickets"), { privileged: true });
    writeFileSync(join(root, "tickets/EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", title: "Inert custody fixture", status: "idea", doc_refs: [], comments: [] }));
    getDb(); run(root, store);
  } finally { closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); }
}
function denied(run: () => void, expected: string): TicketStatusError {
  let failure: unknown;
  try { run(); } catch (error) { failure = error; }
  assert.ok(failure instanceof TicketStatusError);
  assert.equal(failure.code, "TICKET_STATUS_OWNER");
  assert.match(failure.message, new RegExp(expected));
  assert.ok(failure.message.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(failure.message.split(`${label}:`).length, 2);
  return failure;
}
function competing(status: "running" | "partial", pid?: number): void {
  emitStartedEvent({ deploymentId: "d-352002", team: "builder", mode: "implement", runtime: "pi", ticketId: "EX-1" });
  if (pid) emitPidEvent({ deploymentId: "d-352002", team: "builder", pid });
  if (status === "partial") emitCompletedEvent({ deploymentId: "d-352002", team: "builder", status });
}

test("custody cause: record lookup and project mismatch do not collapse to competing owner", () => fixture((_root, store) => {
  denied(() => assertTicketAdminOwner(store, "EX-404", caller), "record is missing");
  denied(() => assertTicketAdminOwner(store, "EX-1", { ...caller, repoKey: "other" }), "different project");
  store.get = () => { throw Error("private fixture body"); };
  const error = denied(() => assertTicketAdminOwner(store, "EX-1", caller), "record could not be read");
  assert.ok(!error.message.includes("private fixture"));
}));
test("custody cause: active registry, terminal without PID, present/reused PID and absent PID differ", () => {
  for (const scenario of ["active", "missing", "present", "absent"] as const) fixture((_root, store) => {
    competing(scenario === "active" ? "running" : "partial", scenario === "present" ? process.pid : scenario === "absent" ? 2147483647 : undefined);
    if (scenario === "absent") assert.doesNotThrow(() => assertTicketAdminOwner(store, "EX-1", caller));
    else {
      const error = denied(() => assertTicketAdminOwner(store, "EX-1", caller), scenario === "active" ? "registered outside" : scenario === "missing" ? "no usable process ID" : "reused ID");
      assert.match(error.message, /Registry deployment: d-352002/);
      assert.deepEqual(Object.keys(error), ["code"], "no new machine Error fields");
    }
  });
});
test("custody cause: unreadable proc is unknown and active deployment short circuits proc", () => {
  for (const active of [false, true]) fixture((_root, store) => {
    competing(active ? "running" : "partial", process.pid);
    const original = fs.lstatSync; let probes = 0;
    fs.lstatSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === `/proc/${process.pid}`) { probes++; throw Object.assign(Error("private probe body"), { code: "EACCES" }); }
      return (original as Function)(path, ...args);
    }) as typeof fs.lstatSync; syncBuiltinESMExports();
    try {
      denied(() => assertTicketAdminOwner(store, "EX-1", caller), active ? "registered outside" : "lookup failed without proving");
      assert.equal(probes, active ? 0 : 1);
    } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
  });
});
test("custody cause: failed retained workflow evidence is not reported as known owner", () => fixture((root, store) => {
  writeFileSync(join(root, "tickets/EX-1.json"), "not json; private fixture body");
  const error = denied(() => assertTicketStatusOwner(store, "EX-1", caller), "workflow evidence could not be read");
  assert.match(error.message, /checks were not evaluated/);
  assert.ok(!error.message.includes("private fixture"));
}));
test("custody cause: document probe failure and competing registry query failure stay distinct", () => {
  fixture((_root, store) => {
    const original = RegistryDocumentJournal.prototype.events;
    RegistryDocumentJournal.prototype.events = () => { throw Error("private fixture"); };
    try { denied(() => assertTicketAdminOwner(store, "EX-1", caller), "document registry could not be inspected"); }
    finally { RegistryDocumentJournal.prototype.events = original; }
  });
  fixture((_root, store) => {
    getDb().exec("ALTER TABLE deployments RENAME TO hidden_deployments");
    denied(() => assertTicketAdminOwner(store, "EX-1", caller), "deployment registry lookup failed");
  });
});
test("custody cause: excessive competing records stop before process checks", () => fixture((_root, store) => {
  competing("running");
  const db = getDb();
  // Schema-independent clone of the real fixture row.
  const row = db.prepare("SELECT * FROM deployments WHERE deployment_id = 'd-352002'").get() as Record<string, unknown>;
  const columns = Object.keys(row), insert = db.prepare(`INSERT INTO deployments (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  for (let n = 0; n < 256; n++) insert.run(...columns.map(k => k === "deployment_id" ? `d-${(0x353000 + n).toString(16)}` : row[k]));
  denied(() => assertTicketAdminOwner(store, "EX-1", caller), "more than 256");
}));
test("custody cause: pending document effects block before a competing registry query", () => fixture((_root, store) => {
  const original = RegistryDocumentJournal.prototype.events;
  RegistryDocumentJournal.prototype.events = () => [{ schemaVersion: "pa-document-event/v1", repoKey: "example", ticket: "EX-1", revision: 1, predecessor: null,
    data: { kind: "intent", operationId: "original-operation", subjectSha256: "a".repeat(64), decisionId: "original-decision", operation: "publish" } }];
  getDb().exec("ALTER TABLE deployments RENAME TO hidden_deployments");
  try { denied(() => assertTicketAdminOwner(store, "EX-1", caller), "Document replay found pending"); }
  finally { RegistryDocumentJournal.prototype.events = original; }
}));
test("custody cause: retained and pending workflow come from original journal replay", async () => {
  const env = { ...process.env }; closeDb(); const f = workflowRuntimeFixture();
  try {
    const config = join(f.root, "config"); mkdirSync(config); mkdirSync(join(f.root, "tickets"));
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${f.bundle.repository.root}\n  prefix: EX\n`);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "registry.db") });
    writeFileSync(join(f.root, "tickets/EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", title: "Inert workflow", status: "idea", doc_refs: [], comments: [] }));
    const store = new TicketStore(join(f.root, "tickets"), { privileged: true });
    const run = f.service.admit(f.selection, bytes(f.bundle));
    denied(() => assertTicketStatusOwner(store, "EX-1", caller), "retained workflow was found");
    assert.doesNotThrow(() => assertTicketAdminOwner(store, "EX-1", caller), "settled workflow history is not admin custody");
    const decision = await f.service.decide(run.runId, 1, "approve");
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("publication.pair", {
      admit() {}, observe: async () => ({ state: "absent" }), verify: () => false,
      execute: async () => { throw Error("inert interrupted owner"); },
    });
    await assert.rejects(f.service.requestStep(run.runId, 2, "publish", decision.decisionId), /inert interrupted/);
    assert.equal(f.service.status(run.runId).pending.length, 1);
    denied(() => assertTicketAdminOwner(store, "EX-1", caller), "Workflow replay found pending");
  } finally { f.close(); closeDb(); process.env = env; }
});
test("marker owner preserves narrower facts and existing workflow codes without new enumerable fields", () => {
  for (const [refs, run, code, reason] of [
    [{}, null, "WORKFLOW_UNCERTAIN", "not an array"],
    [[{ type: "workflow", path: "private fixture" }], null, "WORKFLOW_UNCERTAIN", "without a matching adopted run"],
    [[{ type: "workflow", path: "private fixture" }], "run-inert", "WORKFLOW_CONFLICT", "differs from the adopted run"],
  ] as const) {
    assert.throws(() => assertWorkflowMarkerReferences(refs, run), error => {
      assert.ok(error instanceof WorkflowMarkerError); assert.ok(error instanceof JsonWorkflowError);
      assert.equal(error.code, code); assert.match(error.message, new RegExp(reason));
      assert.ok(!error.message.includes("private fixture")); assert.ok(error.message.length <= 2000);
      assert.deepEqual(Object.keys(error), Object.keys(new JsonWorkflowError(code)));
      return true;
    });
  }
  fixture((_root, store) => {
    const body = JSON.stringify({ data: { kind: "intent" } });
    getDb().prepare("INSERT INTO document_events (repo_key, ticket, revision, predecessor, sha256, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run("example", "EX-1", 1, null, digest(body), body);
    denied(() => assertTicketStatusOwner(store, "EX-1", caller), "even if that intent failed");
    assert.throws(() => assertWorkflowMarkerAvailable("example", "EX-1", false, store), error => error instanceof WorkflowMarkerError && error.code === "WORKFLOW_CONFLICT");
  });
  fixture((root, store) => {
    writeFileSync(join(root, "tickets/EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", doc_refs: [{ type: "workflow", path: "private fixture" }] }));
    const error = denied(() => assertTicketAdminOwner(store, "EX-1", caller), "no matching adopted run");
    assert.ok(!error.message.includes("private fixture"));
  });
});
test("finite custody presentation never evaluates hostile input or leaks arbitrary context", () => {
  for (const cause of [...TICKET_OWNERSHIP_CAUSES, undefined, "\u001b[31m\nReason: private fixture", new Proxy({}, { get() { throw Error("getter"); } })]) {
    const text = renderTicketOwnershipDiagnostic(cause as any, "\u001b[31m\nReason: private fixture");
    assert.ok(text.length <= 2000); assert.ok(!text.includes("private fixture")); assert.ok(!text.includes("..."), "static facts must not be truncated");
    assert.match(text, /Impact: none/); assert.match(text, /Actor: operator/); assert.match(text, /New approval:/); assert.match(text, /Prerequisite:/);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(text.split(`${label}:`).length, 2);
  }
});
