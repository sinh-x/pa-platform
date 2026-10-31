import assert from "node:assert/strict";
import { test } from "node:test";
import { digest, JsonWorkflowError, MAX_WORKFLOW_BYTES, MAX_WORKFLOW_RECORD_BYTES, parseReviewBundle, strictJson } from "../workflows/contracts.js";
import { evaluatePredicate, parseWorkflowDefinition } from "../workflows/definition.js";
import { OPERATIONS } from "../workflows/operations.js";
import type { WorkflowDefinition, WorkflowStep } from "../workflows/contracts.js";
import { loadSelectedWorkflows, selectNewWorkflow, type SelectedConfigReader } from "../workflows/selected.js";
import { bundle, bytes, decisionStep, definition } from "./workflow-fixtures.js";

test("strict reader: exact byte budgets and one-over; decoded duplicate keys, BOM, UTF-8, surrogates and depth", () => {
  for (const limit of [MAX_WORKFLOW_BYTES, MAX_WORKFLOW_RECORD_BYTES]) {
    assert.deepEqual(Object.keys(strictJson(Buffer.from("{}" + " ".repeat(limit - 2)), limit) as object), []);
    assert.throws(() => strictJson(Buffer.from("{}" + " ".repeat(limit - 1)), limit), JsonWorkflowError);
  }
  for (const raw of [Buffer.from('{"a":1,"\\u0061":2}'), Buffer.from("\ufeff{}"), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), Buffer.from('{"x":"\\ud800"}'), Buffer.from('{} garbage')]) assert.throws(() => strictJson(raw), JsonWorkflowError);
  assert.doesNotThrow(() => strictJson(Buffer.from('{"x":' + '['.repeat(63) + '0' + ']'.repeat(63) + '}')));
  assert.throws(() => strictJson(Buffer.from('{"x":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}')), JsonWorkflowError);
});
test("valid definition, presentation order independence, 256 steps and one-over", () => {
  assert.equal(parseWorkflowDefinition(bytes(definition())).workflowId, "software");
  const d = definition(); d.steps = Array.from({ length: 256 }, (_, n) => decisionStep(`step-${n}`, 256 - n));
  assert.equal(parseWorkflowDefinition(bytes(d)).steps.length, 256);
  d.steps.push(decisionStep("over", 257)); assert.throws(() => parseWorkflowDefinition(bytes(d)), JsonWorkflowError);
  const raw = bytes(definition()); assert.doesNotThrow(() => parseWorkflowDefinition(Buffer.concat([raw, Buffer.alloc(MAX_WORKFLOW_BYTES - raw.length, 32)])));
});
test("closed step grammar, operation/profile/result bounds and graph negatives", async t => {
  const mutations: Record<string, (d: ReturnType<typeof definition>) => void> = {
    "unknown field": d => Object.assign(d.steps[0]!, { secret: "sentinel-protected-token" }),
    "unsupported version": d => Object.assign(d, { schemaVersion: "pa-workflow-definition/v2" }),
    "duplicate ID": d => d.steps.push(decisionStep()),
    "duplicate order": d => d.steps.push(decisionStep("second")),
    "unresolved dependency": d => { d.steps[0]!.dependsOn = [{ stepId: "missing", outcome: "approved" }]; },
    "wrong dependency outcome": d => { d.steps.push(decisionStep("second", 2)); d.steps[1]!.dependsOn = [{ stepId: "approve", outcome: "passed" }]; },
    "cycle": d => { d.steps[0]!.dependsOn = [{ stepId: "approve", outcome: "approved" }]; },
    "missing transition": d => { delete d.steps[0]!.transitions.rejected; },
    "unknown transition": d => { d.steps[0]!.transitions.approved = "missing"; },
    "back edge": d => { d.steps[0]!.transitions.approved = "approve"; },
    "unsafe predicate": d => Object.assign(d.steps[0]!, { when: { eval: "process.exit()" } }),
    "unsupported context": d => { d.steps[0]!.when = { op: "eq", field: "caller.approved", value: "true" }; },
    "unsupported operation": d => { d.steps[0]!.operation.id = "shell.exec"; },
    "role escalation": d => { d.steps[0]!.owner = "root"; },
    "effect escalation": d => Object.assign(d.steps[0]!, { effects: ["remote.push"] }),
    "hidden effect": d => { d.steps[0]!.effects = []; },
    "permission escalation": d => { d.steps[0]!.authorization = ["git.commit-local"]; },
    "wrong schema": d => { d.steps[0]!.inputs[0]!.schemaVersion = "pa-decision/v1"; },
    "forward reference": d => { d.steps[0]!.inputs = [{ name: "package", schemaVersion: "pa-review-bundle/v1", source: "output", stepId: "second", output: "package" }]; d.steps.push(decisionStep("second", 2)); },
    "model passed verifier": d => Object.assign(d.steps[0]!, { verification: [{ passed: true }] }),
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const d = definition(); mutate(d); assert.throws(() => parseWorkflowDefinition(bytes(d)), (e: unknown) => e instanceof JsonWorkflowError && e.message.length <= 2000 && !e.message.includes("sentinel-protected-token"));
  });
});
test("all registered kinds round-trip with typed producer references and exhaustive outcomes", () => {
  const d = definition();
  const ids = ["approve", "publish", "queue", "implement", "validate"];
  const successes = ["approved", "completed", "completed", "completed", "passed"];
  d.requiredCapabilities = OPERATIONS.map(operation => operation.capability);
  for (let n = 1; n < OPERATIONS.length; n++) {
    const op = OPERATIONS[n]!; const prior = d.steps[n - 1]!;
    prior.transitions[successes[n - 1]!] = ids[n]!;
    const inputs: WorkflowStep["inputs"] = op.inputSchemas.map((schema, k) => schema === "pa-review-bundle/v1"
      ? { name: `input-${k}`, schemaVersion: schema, source: "context", field: "bundle" }
      : schema === "pa-decision/v1" ? { name: `input-${k}`, schemaVersion: schema, source: "output", stepId: "approve", output: "decision" }
        : { name: `input-${k}`, schemaVersion: schema, source: "output", stepId: "publish", output: "result" });
    const outcomes = op.kind === "check" ? ["passed", "failed", "unknown"] : ["completed", "failed", "unknown"];
    d.steps.push({ ...decisionStep(ids[n]!, n + 1), kind: op.kind, owner: op.owner, operation: { id: op.id, version: "v1" },
      dependsOn: [{ stepId: prior.id, outcome: successes[n - 1] as "approved" | "completed" }], inputs,
      outputs: [{ name: "result", schemaVersion: op.outputSchema }], effects: [...op.effects], authorization: [...op.permissions],
      verification: [{ id: op.verifier, version: "v1", inputs: inputs.map(i => i.name) }],
      transitions: Object.fromEntries(outcomes.map(o => [o, o === successes[n] ? "completed" : "blocked"])) });
  }
  assert.equal(parseWorkflowDefinition(bytes(d)).steps.length, 5);
  const bad: WorkflowDefinition = structuredClone(d); bad.steps[1]!.transitions.unknown = "completed";
  assert.throws(() => parseWorkflowDefinition(bytes(bad)), JsonWorkflowError);
});
test("typed applicability has no arbitrary execution or unknown fields", () => {
  assert.equal(evaluatePredicate({ op: "all", predicates: [{ op: "eq", field: "runtime", value: "pi" }, { op: "in", field: "ticket", values: ["EX-1"] }] }, { runtime: "pi", ticket: "EX-1" }), true);
  assert.equal(evaluatePredicate({ op: "eq", field: "runtime", value: "pi" }, {}), false);
});
test("immutable package grammar separates fresh/amendment, binds matrix and closes permissions/paths", () => {
  const b = bundle(); assert.equal(parseReviewBundle(bytes(b)).handoff.type, "fresh");
  const amendment = { ...b, handoff: { ...b.handoff, type: "amendment", branchAction: "reuse", featureSha: "c".repeat(40) } };
  assert.equal(parseReviewBundle(bytes(amendment)).handoff.type, "amendment");
  for (const bad of [{ ...b, handoff: { ...b.handoff, featureSha: "c".repeat(40) } }, { ...b, requestedPermissions: ["remote.push"] }, { ...b, scope: { ...b.scope, files: ["../outside"] } }, { ...b, scope: { ...b.scope, checks: [{ matrixSource: b.matrix.ref, matrixSha256: "b".repeat(64), commandId: "check" }] } }]) assert.throws(() => parseReviewBundle(bytes(bad)), JsonWorkflowError);
});
test("selected source is pinned, missing/disabled prevents new runs and incompatible never falls back", () => {
  const raw = bytes(definition());
  const manifest = { schemaVersion: "pa-workflow-manifest/v1", definitions: [{ workflowId: "software", version: "r001", file: "workflows/definitions/software.json", sha256: digest(raw) }], bindings: [{ schemaVersion: "pa-workflow-binding/v1", team: "builder", mode: "orchestrator", enabled: true, workflowId: "software", workflowVersion: "r001" }] };
  const reader: SelectedConfigReader = { root: () => "/selected", revision: () => "a".repeat(40), read: (_root, file) => file === "workflows/manifest.json" ? bytes(manifest) : raw };
  const selected = loadSelectedWorkflows(reader); assert.equal(selectNewWorkflow(selected, "builder", "orchestrator").sha256, digest(raw));
  manifest.bindings[0]!.enabled = false;
  assert.throws(() => selectNewWorkflow(loadSelectedWorkflows(reader), "builder", "orchestrator"), /WORKFLOW_DISABLED/);
  assert.throws(() => selectNewWorkflow(loadSelectedWorkflows({ ...reader, read: () => null }), "builder", "orchestrator"), /WORKFLOW_DISABLED/);
  manifest.definitions[0]!.sha256 = "b".repeat(64); assert.throws(() => loadSelectedWorkflows(reader), /WORKFLOW_SOURCE/);
});
