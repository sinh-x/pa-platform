import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { workflowReadService } from "../workflows/public.js";
import { runWorkflowCommand } from "../cli/commands/workflow.js";
import { preflightWorkflow, type WorkflowObservations } from "../workflows/preflight.js";
import { workflowTemplateError } from "../workflows/template-diagnostics.js";
import { digest } from "../workflows/contracts.js";
import { bytes, fixtureEvidence } from "./workflow-fixtures.js";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";

for (const profile of ["supported", "missing", "unsupported", "uninspected"] as const) {
  test(`requirements admission/revision defers ${profile} execution profile without inventing effect authority`, async () => {
    const f = workflowRuntimeFixture();
    try {
      const observe = f.host.observations;
      f.host.observations = () => ({ ...observe(), projectProfile: profile });
      const preflight = preflightWorkflow(f.selection, "requirements", "analyze", f.host.observations());
      assert.equal(preflight.status, "static-compatible"); assert.equal(preflight.executionAdmitted, false);
      assert.equal(preflight.projectProfile, profile);
      assert.equal(preflight.executionPrerequisites.length, profile === "supported" ? 0 : 1);
      for (const gate of preflight.executionPrerequisites) {
        assert.equal(gate.outcome, "blocked"); assert.match(gate.nextAction, /Before source\/check execution/);
      }
      const capture = f.host.capture;
      f.host.capture = async request => ({ ...await capture(request), outcome: "changes-requested" });
      const state = f.service.admit(f.selection, f.subject);
      assert.deepEqual(state.decisions, []); assert.deepEqual(state.pending, []);
      // Neither admission nor deferring a command profile grants package permissions.
      await assert.rejects(f.service.requestStep(state.runId, 1, "publish", "unissued"), /WORKFLOW_/);
      await f.service.decide(state.runId, 1, "approve");
      const next = structuredClone(f.bundle); next.revision++; next.subjectId = "package-two";
      next.requirements.ref = "requirements:agent-teams/requirements/artifacts/revision-two.md"; next.matrix.ref = next.requirements.ref;
      for (const [ref, raw] of fixtureEvidence(next)) f.evidence.set(ref, raw);
      const revised = f.service.revise(state.runId, 2, bytes(next));
      assert.equal(revised.attempts.length, 2); assert.equal(revised.decisions.length, 1);
      assert.deepEqual(revised.pending, []); assert.deepEqual(f.service.next(state.runId).eligible, ["approve"]);
    } finally { f.close(); }
  });
}

for (const operation of ["source.local", "check.matrix"] as const) for (const profile of ["missing", "unsupported", "uninspected"] as const) {
  test(`${operation} request fails closed at its own boundary with no intent or effect for ${profile} execution contract`, async () => {
    const f = workflowRuntimeFixture();
    try {
      const definition = f.selection.definitions[0]!.definition;
      definition.requiredCapabilities.push(operation === "source.local" ? "execution.scoped-local" : "validation.matrix");
      definition.steps[1]!.transitions.completed = "execute";
      definition.steps.push({ id: "execute", order: 3, title: "Scoped execution", kind: operation === "source.local" ? "action" : "check", owner: operation === "source.local" ? "execution" : "validation",
        dependsOn: [{ stepId: "publish", outcome: "completed" }], when: true,
        inputs: [{ name: "package", schemaVersion: "pa-review-bundle/v1", source: "context", field: "bundle" }, { name: "decision", schemaVersion: "pa-decision/v1", source: "output", stepId: "approve", output: "decision" }],
        operation: { id: operation, version: "v1" }, authorization: operation === "source.local" ? ["source.edit-scoped", "repair.same-scope", "git.commit-local"] : ["check.execute-scoped"],
        effects: operation === "source.local" ? ["source.scoped", "git.local"] : ["check.scoped"],
        outputs: [{ name: operation === "source.local" ? "execution" : "validation", schemaVersion: operation === "source.local" ? "pa-execution-result/v1" : "pa-validation-result/v1" }],
        verification: [{ id: operation === "source.local" ? "execution.native" : "validation.native", version: "v1", inputs: ["package", "decision"] }],
        transitions: operation === "source.local" ? { completed: "completed", failed: "blocked", unknown: "blocked" } : { passed: "completed", failed: "blocked", unknown: "blocked" }, failurePolicy: { strategy: "reconcile", correctionOwner: "execution-owner" } });
      const raw = bytes(definition); f.bundle.workflow.sha256 = digest(raw);
      f.selection = { ...f.selection, definitions: f.selection.definitions.map(row => ({ ...row, raw, sha256: digest(raw) })) };
      const observed = f.host.observations; f.host.observations = () => ({ ...observed(), projectProfile: profile });
      let executionCalls = 0;
      const proof = { state: "proven" as const, outcome: "completed" as const, evidence: [{ schemaVersion: "pa-workflow-evidence-ref/v1" as const, ref: "synthetic-publication", version: "v1", sha256: "d".repeat(64) }] };
      const owners = f.host.owners as Map<string, any>;
      owners.set("publication.pair", { admit: () => {}, observe: async () => proof, execute: async () => proof, verify: () => true });
      owners.set(operation, { admit: () => { executionCalls++; }, observe: () => { executionCalls++; }, execute: () => { executionCalls++; }, verify: () => { executionCalls++; } });
      const run = f.service.admit(f.selection, bytes(f.bundle)), decision = await f.service.decide(run.runId, 1, "approve");
      const published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId);
      assert.deepEqual(f.service.next(run.runId).eligible, []);
      assert.deepEqual(f.service.next(run.runId).blocked, [{ stepId: "execute", code: "WORKFLOW_CAPABILITY" }]);
      const before = f.journal.read(run.runId);
      await assert.rejects(f.service.requestStep(run.runId, published.revision, "execute", decision.decisionId), new RegExp(profile === "missing" ? "project-command-contract-required" : `project-command-contract-${profile}`));
      assert.equal(executionCalls, 0); assert.deepEqual(f.journal.read(run.runId), before);
    } finally { f.close(); }
  });
}

test("fresh status/next expose selected-without-run and authenticated pre-subject repository context", () => {
  const f = workflowRuntimeFixture(), env = process.env;
  try {
    const config = join(f.root, "config"), tickets = join(f.root, "tickets"); mkdirSync(config); mkdirSync(tickets);
    writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: f.root, prefix: "EX" } } }));
    writeFileSync(join(tickets, "EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", doc_refs: [] }));
    process.env = { ...env, PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "absent.db") };
    let observed = 0;
    const host = { selection: () => f.selection, observations: (subject: unknown, repository: unknown): WorkflowObservations => {
      observed++; assert.equal(subject, undefined); assert.deepEqual(repository, { key: "example", root: f.root });
      return { ...f.host.observations(), projectProfile: "missing" };
    } };
    for (const action of ["preflight", "status", "next"]) {
      const response = workflowReadService(JSON.stringify({ action, ticket: "EX-1" }), host);
      assert.equal(response.ok, true); assert.equal(response.executionAdmitted, false);
      const result = response.result as Record<string, any>;
      const preflight = action === "preflight" ? result : result.preflight;
      assert.equal(preflight.status, "static-compatible"); assert.equal(preflight.projectProfile, "missing");
      assert.equal(preflight.executionPrerequisites.length, 1);
      if (action !== "preflight") { assert.equal(result.runState, "selected-without-run"); assert.equal(result.runId, null); assert.equal(result.effectsAdmitted, false); }
      const output: string[] = [];
      assert.equal(runWorkflowCommand("workflow", [action, "--ticket", "EX-1", "--json"], { stdout: s => output.push(s), stderr: () => { throw Error("unexpected stderr"); } }, host), 0);
      assert.deepEqual(JSON.parse(output[0]!), response);
    }
    assert.equal(observed, 6); assert.equal(existsSync(join(f.root, "absent.db")), false);
    // A retained workflow marker without its journal is uncertain, NOT an ordinary no-run startup.
    writeFileSync(join(tickets, "EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", doc_refs: [{ type: "workflow", path: "registry-workflow:missing" }] }));
    assert.equal(workflowReadService('{"action":"status","ticket":"EX-1"}', host).code, "WORKFLOW_UNCERTAIN");
  } finally { process.env = env; f.close(); }
});

test("disabled selected bindings are selection-blocked-without-run, never admitted or silently enabled", () => {
  const f = workflowRuntimeFixture(); try {
    const selection = { ...f.selection, bindings: f.selection.bindings.map(binding => ({ ...binding, enabled: false })) };
    for (const action of ["status", "next"]) {
      const response = workflowReadService(JSON.stringify({ action, ticket: "EX-1" }), { selection: () => selection, state: () => null, observations: f.host.observations });
      assert.equal(response.ok, true);
      const result = response.result as Record<string, any>;
      assert.equal(result.runState, "selection-blocked-without-run"); assert.equal(result.effectsAdmitted, false);
      assert.equal(result.preflight.status, "blocked"); assert.equal(result.preflight.selected, null);
      assert.ok(result.preflight.gates.some((gate: any) => gate.code === "WORKFLOW_DISABLED"));
    }
    assert.ok(selection.bindings.every(binding => !binding.enabled));
    assert.deepEqual(f.journal.runs(f.bundle.repository.key, f.bundle.ticket), []);
  } finally { f.close(); }
});

test("retained reads use the pinned definition and reject wrong ticket-repository context before observation", () => {
  const f = workflowRuntimeFixture();
  try {
    const state = f.service.admit(f.selection, f.subject);
    const host = { selection: () => { throw Error("must not select current definition"); }, state: () => state, observations: f.host.observations };
    const response = workflowReadService('{"action":"preflight","ticket":"EX-1"}', host);
    assert.equal(response.ok, true); assert.equal((response.result as any).status, "static-compatible");
    for (const action of ["status", "next", "preflight"]) {
      const wrong = workflowReadService(JSON.stringify({ action, ticket: "EX-1" }), { ...host,
        context: () => ({ state, repository: { key: "other", root: state.subject.repository.root } }),
        observations: () => { throw Error("must not inspect a wrong repository"); } });
      assert.equal(wrong.code, "WORKFLOW_AUTHORITY"); assert.equal(wrong.gateId, "ticket-repository");
    }
  } finally { f.close(); }
});

for (const cause of ["TEMPLATE_PAIR", "TEMPLATE_CAPABILITY", "TEMPLATE_CONSUMER_REQUIRED", "TEMPLATE_DIGEST"] as const) {
  test(`preflight and admission preserve native ${cause}, without writing a broken run`, () => {
    const f = workflowRuntimeFixture();
    try {
      const observe = f.host.observations;
      f.host.observations = () => ({ ...observe(), producerContract: "unsupported", producerFailure: workflowTemplateError(cause) });
      const result = preflightWorkflow(f.selection, "requirements", "analyze", f.host.observations());
      assert.equal(result.status, "blocked"); assert.ok(result.gates.some(g => g.code === cause));
      assert.ok(!result.gates.some(g => g.gateId === "shared-producer-contract-required"));
      assert.throws(() => f.service.admit(f.selection, f.subject), new RegExp(cause));
      assert.deepEqual(f.journal.runs(f.bundle.repository.key, f.bundle.ticket), []);
    } finally { f.close(); }
  });
}
