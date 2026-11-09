import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../workflows/contracts.js";
import { bytes, fixtureEvidence } from "./workflow-fixtures.js";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";
import { ticketOwnerFixture } from "./workflow-ticket-owner-cases.js";
import { documentRevisionEligibility } from "../workflows/revisions.js";
import { coordinatorAdoptionPurpose, coordinatorOperationAllowed, workflowCoordinator, type WorkflowState, type WorkflowEffectOwner } from "../workflows/service.js";
import { packageDecision } from "../workflows/catalog.js";

function nextSubject(state: WorkflowState, evidence: Map<string, Buffer>) {
  const next = structuredClone(state.subject); next.revision++; next.subjectId = `document-revision-${next.revision}`;
  next.requirements.ref = `requirements:agent-teams/requirements/artifacts/document-${next.revision}.md`;
  next.uat.ref = `uat:agent-teams/requirements/artifacts/document-${next.revision}-uat.md`; next.matrix.ref = next.requirements.ref;
  for (const [ref, raw] of fixtureEvidence(next)) evidence.set(ref, raw);
  return next;
}

test("approved fresh revision retains lineage/pins/history, consumes no old grant and rechecks unmaterialized proof at CAS", async () => {
  const f = workflowRuntimeFixture(); try {
    const run = f.service.admit(f.selection, f.subject), decision = await f.service.decide(run.runId, 1, "approve");
    const before = f.journal.read(run.runId), oldRaw = f.journal.snapshot(run.subjectSha256), state = f.service.status(run.runId);
    let checks = 0;
    f.host.assertDocumentContinuation = (s, subject, unmaterialized) => { checks++; assert.equal(s.subjectSha256, run.subjectSha256); assert.equal(unmaterialized, true); assert.equal(subject.handoff.type, "fresh"); };
    const next = nextSubject(state, f.evidence), revised = f.service.revise(run.runId, state.revision, bytes(next));
    assert.equal(checks, 2); assert.equal(revised.attempts[1]!.reason, "document-revision");
    assert.deepEqual(revised.subject.handoff, run.subject.handoff); assert.deepEqual(revised.resources, run.resources);
    assert.deepEqual(revised.decisions, [decision]); assert.deepEqual(Object.keys(revised.outcomes), []); assert.equal(revised.pending.length, 0);
    assert.deepEqual(f.journal.read(run.runId).slice(0, before.length), before); assert.deepEqual(f.journal.snapshot(run.subjectSha256), oldRaw);
    assert.throws(() => packageDecision(revised), /WORKFLOW_AUTHORITY/);
    await assert.rejects(f.service.requestStep(run.runId, revised.revision, "publish", decision.decisionId), /WORKFLOW_/);
    const fresh = await f.service.decide(run.runId, revised.revision, "approve"); assert.notEqual(fresh.decisionId, decision.decisionId);
    assert.equal(packageDecision(f.service.status(run.runId)), fresh.decisionId);
  } finally { f.close(); }
});

for (const variant of ["missing-proof", "live-writer", "materialization-race", "revoked", "pending-publication"] as const) {
  test(`document revision rejects ${variant} without new snapshots, source or abandoned intents`, async () => {
    const f = workflowRuntimeFixture(); try {
      const run = f.service.admit(f.selection, f.subject), decision = await f.service.decide(run.runId, 1, "approve");
      if (variant === "missing-proof") delete f.host.assertDocumentContinuation;
      if (variant === "live-writer") f.host.assertDocumentContinuation = () => { throw Error("live writer"); };
      if (variant === "materialization-race") { let n = 0; f.host.assertDocumentContinuation = () => { if (++n === 2) throw Error("materialized during CAS"); }; }
      if (variant === "revoked") await f.service.revoke(run.runId, 2, decision.decisionId);
      if (variant === "pending-publication") {
        (f.host.owners as Map<string, WorkflowEffectOwner>).set("publication.pair", { admit() {}, observe: async () => ({ state: "unknown" }), execute: async () => { throw Error("must not replay"); }, verify: () => false });
        await assert.rejects(f.service.requestStep(run.runId, 2, "publish", decision.decisionId), /WORKFLOW_UNCERTAIN/);
      }
      const state = f.service.status(run.runId), before = f.journal.read(run.runId), next = nextSubject(state, f.evidence);
      const snapshots = f.db.prepare("SELECT count(*) AS n FROM workflow_snapshots").get();
      assert.throws(() => f.service.revise(run.runId, state.revision, bytes(next)));
      assert.deepEqual(f.journal.read(run.runId), before); assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM workflow_snapshots").get(), snapshots);
      if (variant === "pending-publication") { assert.equal(documentRevisionEligibility(state).gateId, "pending-effect-reconciliation"); assert.equal(coordinatorAdoptionPurpose(state), null); }
    } finally { f.close(); }
  });
}

test("inactive-owner document adoption is scoped, preserves issued approval and needs a new exact approval for revised publication", async () => {
  const f = ticketOwnerFixture(); try {
    f.host.assertDocumentContinuation = () => {};
    const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve");
    const published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId);
    const old = [readFileSync(f.req), readFileSync(f.uat)], refs = f.store.get("EX-1")!.doc_refs, before = f.journal.read(run.runId);
    const current = { ...run.caller, deploymentId: "d-fedcba", identitySha256: "b".repeat(64) };
    f.host.authenticate = () => current; f.host.assertInactive = () => {};
    const capture = f.host.capture;
    f.host.capture = async r => { assert.equal(r.succession?.purpose, "document-continuation"); return capture(r); };
    const adopted = await f.service.adoptCoordinator(run.runId, published.revision, published.subjectSha256);
    assert.equal(adopted.coordinatorDocumentOnly, true); assert.equal(adopted.coordinatorQueueOnly, false);
    assert.deepEqual(workflowCoordinator(adopted), current); assert.deepEqual(adopted.decisions, [decision]);
    await assert.rejects(f.service.requestStep(run.runId, adopted.revision, "queue", decision.decisionId), /adopted-document-continuation-only/);
    assert.deepEqual(f.service.next(run.runId).eligible, []);
    const next = nextSubject(adopted, f.evidence), revised = f.service.revise(run.runId, adopted.revision, bytes(next));
    assert.equal(revised.coordinatorDocumentOnly, true); assert.throws(() => packageDecision(revised), /WORKFLOW_AUTHORITY/);
    f.host.capture = capture;
    const approved = await f.service.decide(run.runId, revised.revision, "approve");
    const result = await f.service.requestStep(run.runId, f.service.status(run.runId).revision, "publish", approved.decisionId);
    assert.equal(result.outcomes.publish, "completed"); assert.equal(result.outcomes.queue, undefined);
    assert.deepEqual([readFileSync(f.req), readFileSync(f.uat)], old);
    const after = f.store.get("EX-1")!;
    for (const ref of refs) assert.deepEqual(after.doc_refs.find(r => r.path === ref.path), { ...ref, primary: false });
    assert.deepEqual(after.doc_refs.filter(r => r.primary).map(r => r.path), [next.requirements.ref.slice("requirements:".length)]);
    assert.deepEqual(f.journal.read(run.runId).slice(0, before.length), before);
    assert.equal(f.journal.runs("example", "EX-1").length, 1);
    assert.equal(readFileSync(join(f.artifactRoot, next.uat.ref.slice("uat:".length))).byteLength > 0, true);
    const queued = await f.service.requestStep(run.runId, result.revision, "queue", approved.decisionId);
    assert.equal(queued.outcomes.queue, "completed"); assert.equal(queued.coordinatorDocumentOnly, true); // queue is separately authorized, not execution custody
    assert.equal(coordinatorOperationAllowed(queued, "source.local"), false); assert.equal(coordinatorOperationAllowed(queued, "check.matrix"), false);
  } finally { f.close(); }
});

test("document scope denies source execution even with a newly approved package and rejects forged source intents on replay", async () => {
  const f = workflowRuntimeFixture(); try {
    const definition = f.selection.definitions[0]!.definition;
    definition.requiredCapabilities.push("execution.scoped-local"); definition.steps[1]!.transitions.completed = "source";
    definition.steps.push({ id: "source", order: 3, title: "Synthetic source", kind: "action", owner: "execution", dependsOn: [{ stepId: "publish", outcome: "completed" }], when: true,
      inputs: [{ name: "package", schemaVersion: "pa-review-bundle/v1", source: "context", field: "bundle" }, { name: "decision", schemaVersion: "pa-decision/v1", source: "output", stepId: "approve", output: "decision" }],
      operation: { id: "source.local", version: "v1" }, authorization: ["source.edit-scoped", "repair.same-scope", "git.commit-local"], effects: ["source.scoped", "git.local"],
      outputs: [{ name: "result", schemaVersion: "pa-execution-result/v1" }], verification: [{ id: "execution.native", version: "v1", inputs: ["package", "decision"] }],
      transitions: { completed: "completed", failed: "blocked", unknown: "blocked" }, failurePolicy: { strategy: "reconcile", correctionOwner: "execution" } });
    const raw = bytes(definition); f.selection = { ...f.selection, definitions: f.selection.definitions.map(d => ({ ...d, raw, sha256: digest(raw) })) }; f.bundle.workflow.sha256 = digest(raw);
    const run = f.service.admit(f.selection, bytes(f.bundle)); await f.service.decide(run.runId, 1, "approve");
    f.host.authenticate = () => ({ ...run.caller, deploymentId: "d-fedcba", identitySha256: "b".repeat(64) }); f.host.assertInactive = () => {};
    let state = await f.service.adoptCoordinator(run.runId, 2, run.subjectSha256);
    state = f.service.revise(run.runId, state.revision, bytes(nextSubject(state, f.evidence)));
    const approved = await f.service.decide(run.runId, state.revision, "approve");
    let effects = 0;
    const owners = f.host.owners as Map<string, WorkflowEffectOwner>;
    owners.set("source.local", { admit() { effects++; }, observe: async () => { effects++; return { state: "unknown" }; }, execute: async () => { effects++; return { state: "unknown" }; }, verify: () => false });
    owners.set("publication.pair", { admit() {}, observe: async () => ({ state: "proven", outcome: "completed", evidence: [{ schemaVersion: "pa-workflow-evidence-ref/v1", ref: "synthetic-published-pair", version: "v1", sha256: "c".repeat(64) }] }), execute: async () => { throw Error("no execution"); }, verify: () => true });
    state = await f.service.requestStep(run.runId, f.service.status(run.runId).revision, "publish", approved.decisionId);
    const before = f.journal.read(run.runId);
    await assert.rejects(f.service.requestStep(run.runId, state.revision, "source", approved.decisionId), /adopted-document-continuation-only/);
    assert.equal(effects, 0); assert.deepEqual(f.journal.read(run.runId), before);
    f.journal.append(run.runId, state.revision, () => ({ eventId: "event-forged-document-source", type: "intent", data: { intent: { intentId: "intent-forged-source", runId: run.runId, stepId: "source", owner: "execution", decisionId: approved.decisionId, subjectSha256: state.subjectSha256 } } }));
    assert.throws(() => f.service.status(run.runId), /WORKFLOW_UNCERTAIN/);
  } finally { f.close(); }
});

test("retained revoked material revisions stay replayable without reviving their permissions", async () => {
  const f = workflowRuntimeFixture(); try {
    const run = f.service.admit(f.selection, f.subject), decision = await f.service.decide(run.runId, 1, "approve");
    const revoked = await f.service.revoke(run.runId, 2, decision.decisionId), next = nextSubject(revoked, f.evidence);
    next.handoff = { ...next.handoff, type: "amendment", branchAction: "reuse", featureSha: "c".repeat(40) };
    const revised = f.service.revise(run.runId, revoked.revision, bytes(next));
    assert.equal(revised.attempts[1]!.reason, "material-amendment"); assert.deepEqual(revised.revoked, [decision.decisionId]);
    assert.throws(() => packageDecision(f.service.status(run.runId)), /WORKFLOW_AUTHORITY/);
  } finally { f.close(); }
});

test("interrupted fresh document pair publication reconciles the same intent and leaves the predecessor immutable", async () => {
  const f = ticketOwnerFixture(); try {
    const run = f.admit(), oldDecision = await f.service.decide(run.runId, 1, "approve");
    const published = await f.service.requestStep(run.runId, 2, "publish", oldDecision.decisionId);
    const old = [readFileSync(f.req), readFileSync(f.uat)], next = nextSubject(published, f.evidence);
    const revised = f.service.revise(run.runId, published.revision, bytes(next));
    const decision = await f.service.decide(run.runId, revised.revision, "approve");
    const req = join(f.artifactRoot, next.requirements.ref.slice("requirements:".length)), uat = join(f.artifactRoot, next.uat.ref.slice("uat:".length));
    const authenticate = f.host.authenticate; let interrupted = false;
    f.host.authenticate = () => { if (!interrupted && existsSync(req) && !existsSync(uat)) { interrupted = true; throw Error("interrupted pair"); } return authenticate(); };
    await assert.rejects(f.service.requestStep(run.runId, f.service.status(run.runId).revision, "publish", decision.decisionId), /interrupted pair/);
    const pending = f.service.status(run.runId); assert.equal(pending.pending.length, 1); assert.equal(existsSync(req), true); assert.equal(existsSync(uat), false);
    f.host.authenticate = authenticate;
    const settled = await f.service.reconcile(run.runId, pending.revision, pending.pending[0]!.intentId);
    assert.equal(settled.outcomes.publish, "completed"); assert.equal(settled.pending.length, 0);
    assert.deepEqual([readFileSync(f.req), readFileSync(f.uat)], old);
    assert.equal(f.journal.read(run.runId).filter(e => e.event.type === "intent" && (e.event.data.intent as { subjectSha256: string }).subjectSha256 === settled.subjectSha256).length, 1);
    assert.equal(f.store.get("EX-1")!.doc_refs.filter(r => r.primary).length, 1);
  } finally { f.close(); }
});

test("approved document adoption has one CAS winner and cannot be rediscovered as legacy broad adoption", async () => {
  const f = workflowRuntimeFixture(); try {
    const run = f.service.admit(f.selection, f.subject); await f.service.decide(run.runId, 1, "approve");
    f.host.authenticate = () => ({ ...run.caller, deploymentId: "d-fedcba", identitySha256: "b".repeat(64) }); f.host.assertInactive = () => {};
    const capture = f.host.capture, waiters: (() => void)[] = [];
    f.host.capture = async r => { await new Promise<void>(resolve => waiters.push(resolve)); return capture(r); };
    const a = f.service.adoptCoordinator(run.runId, 2, run.subjectSha256), b = f.service.adoptCoordinator(run.runId, 2, run.subjectSha256);
    for (const resolve of waiters) resolve();
    assert.equal((await Promise.allSettled([a, b])).filter(r => r.status === "fulfilled").length, 1);
    const state = f.service.status(run.runId); assert.equal(state.revision, 3); assert.equal(state.coordinatorDocumentOnly, true);
    const event = f.journal.read(run.runId).at(-1)!.event;
    assert.equal(event.data.purpose, "document-continuation");
    // Missing purpose cannot be interpreted as an old unrestricted adoption of an approved subject.
    const legacy = { ...event.data }; delete legacy.purpose;
    f.journal.append(run.runId, state.revision, () => ({ eventId: "event-forged-legacy-adoption", type: "coordinator-adopted", data: { ...legacy, previous: state.coordinator, current: { ...run.caller, deploymentId: "d-aabbcc" } } }));
    assert.throws(() => f.service.status(run.runId), /WORKFLOW_UNCERTAIN/);
  } finally { f.close(); }
});

test("document adoption cannot widen itself through cancelled recovery or a later successor", async () => {
  const f = workflowRuntimeFixture(); try {
    const run = f.service.admit(f.selection, f.subject); await f.service.decide(run.runId, 1, "approve");
    let current = { ...run.caller, deploymentId: "d-fedcba", identitySha256: "b".repeat(64) };
    f.host.authenticate = () => current; f.host.assertInactive = () => {};
    let state = await f.service.adoptCoordinator(run.runId, 2, run.subjectSha256);
    state = f.service.revise(run.runId, state.revision, bytes(nextSubject(state, f.evidence)));
    const capture = f.host.capture; f.host.capture = async r => ({ ...await capture(r), outcome: "cancelled" });
    const cancelled = await f.service.decide(run.runId, state.revision, "approve");
    current = { ...current, deploymentId: "d-aabbcc" }; f.host.capture = capture;
    state = f.service.status(run.runId); assert.equal(coordinatorAdoptionPurpose(state), "document-continuation");
    state = await f.service.adoptCoordinator(run.runId, state.revision, state.subjectSha256);
    assert.equal(state.coordinatorDocumentOnly, true);
    await f.service.recoverCancelled(run.runId, state.revision, cancelled.decisionId, state.subjectSha256);
    assert.equal(f.service.status(run.runId).coordinatorDocumentOnly, true);
  } finally { f.close(); }
});

for (const variant of ["no-proof", "live", "unknown-custody", "cancel", "stale", "caller-drift", "liveness-drift"] as const) {
  test(`approved document adoption rejects/cancels ${variant} without transferring authority`, async () => {
    const f = workflowRuntimeFixture(); try {
      const run = f.service.admit(f.selection, f.subject); await f.service.decide(run.runId, 1, "approve");
      const current = { ...run.caller, deploymentId: "d-fedcba", identitySha256: "b".repeat(64) };
      f.host.authenticate = () => current; f.host.assertInactive = () => {};
      if (variant === "no-proof") delete f.host.assertDocumentContinuation;
      if (variant === "live") f.host.assertInactive = () => { throw Error("live"); };
      if (variant === "unknown-custody") f.host.assertDocumentContinuation = () => { throw Error("unknown"); };
      const capture = f.host.capture;
      f.host.capture = async r => {
        if (variant === "caller-drift") f.host.authenticate = () => ({ ...current, identitySha256: "c".repeat(64) });
        if (variant === "liveness-drift") f.host.assertInactive = () => { throw Error("live now"); };
        return { ...await capture(r), ...(variant === "cancel" ? { outcome: "cancelled" as const } : {}) };
      };
      const before = f.journal.read(run.runId), attempt = f.service.adoptCoordinator(run.runId, variant === "stale" ? 1 : 2, run.subjectSha256);
      if (variant === "cancel") await attempt; else await assert.rejects(attempt);
      assert.deepEqual(f.journal.read(run.runId), before); assert.equal(f.service.status(run.runId).coordinator, undefined);
    } finally { f.close(); }
  });
}
