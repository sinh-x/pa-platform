import "./workflow-producer-cases.js";
import "./workflow-ticket-owner-cases.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../workflows/contracts.js";
import { preflightWorkflow, type WorkflowObservations } from "../workflows/preflight.js";
import { renderWorkflowGate } from "../workflows/presentation.js";
import { type WorkflowSelection } from "../workflows/selected.js";
import { bundle, bytes, definition } from "./workflow-fixtures.js";
export function selection(): WorkflowSelection {
  const d = definition(); const raw = bytes(d);
  return { schemaVersion: "pa-workflow-selection/v1", configRoot: "/selected", configRevision: "a".repeat(40), manifestSha256: "a".repeat(64),
    bindings: [{ schemaVersion: "pa-workflow-binding/v1", team: "builder", mode: "orchestrator", enabled: true, workflowId: d.workflowId, workflowVersion: d.version }],
    definitions: [{ definition: d, raw, sha256: digest(raw), configRoot: "/selected", configRevision: "a".repeat(40), manifestSha256: "a".repeat(64) }] };
}
test("preflight reports independent missing prerequisites without executing any effect/probe", () => {
  const counters = { projectWrites: 0, registryWrites: 0, ticketWrites: 0, leaseWrites: 0, allocations: 0, launches: 0, projectProbes: 0 };
  const before = structuredClone(counters);
  const result = preflightWorkflow(selection(), "builder", "orchestrator", { capabilities: new Set(), projectProfile: "missing", producerContract: "missing", readEvidence: () => { throw new Error("protected-sentinel"); } }, bundle());
  assert.equal(result.status, "blocked"); assert.equal(result.executionAdmitted, false);
  assert.ok(result.gates.some(g => g.gateId === "project-command-contract-required"));
  assert.ok(result.gates.some(g => g.gateId === "shared-producer-contract-required"));
  assert.ok(result.gates.some(g => g.gateId === "subject-evidence"));
  assert.deepEqual(counters, before);
  for (const g of result.gates) { assert.ok(renderWorkflowGate(g).length <= 2000); assert.ok(!JSON.stringify(g).includes("protected-sentinel")); }
});
test("static-compatible always defers live admission and cannot allocate through this interface", () => {
  const observations: WorkflowObservations = { capabilities: new Set(["operator.foreground"]), projectProfile: "supported", producerContract: "supported", readEvidence: () => null };
  const result = preflightWorkflow(selection(), "builder", "orchestrator", observations);
  assert.equal(result.status, "static-compatible"); assert.equal(result.executionAdmitted, false);
  assert.ok(result.gates.some(g => g.outcome === "deferred"));
});
test("disabled selection and material subject drift are explicit, not a legacy admission", () => {
  const s = selection(); const b = bundle(); b.workflow.sha256 = "b".repeat(64);
  const observations: WorkflowObservations = { capabilities: new Set(["operator.foreground"]), projectProfile: "supported", producerContract: "supported", readEvidence: () => null };
  assert.ok(preflightWorkflow(s, "builder", "orchestrator", observations, b).gates.some(g => g.gateId === "subject-binding"));
  const disabled = { ...s, bindings: s.bindings.map(binding => ({ ...binding, enabled: false })) };
  assert.ok(preflightWorkflow(disabled, "builder", "orchestrator", observations).gates.some(g => g.code === "WORKFLOW_DISABLED"));
});
