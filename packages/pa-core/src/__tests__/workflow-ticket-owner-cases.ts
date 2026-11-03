import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { TicketStore } from "../tickets/store.js";
import { createTicketWorkflowOwners } from "../workflows/ticket-owner.js";
import { digest } from "../workflows/contracts.js";
import { parseWorkflowDefinition } from "../workflows/definition.js";
import type { WorkflowEffectOwner } from "../workflows/service.js";
import { bytes } from "./workflow-fixtures.js";
import { structuredTaskBaseline } from "../workflows/consumers.js";
import { templateFixture } from "./template-fixture.js";
import { workflowResourceFixture } from "./workflow-resource-fixture.js";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";

export function ticketOwnerFixture() {
  const f = workflowRuntimeFixture(); const d = f.selection.definitions[0]!.definition;
  d.requiredCapabilities.push("ticket.queue"); d.steps[1]!.transitions.completed = "queue";
  d.steps.push({ id: "queue", order: 3, title: "Advance exact pair", kind: "action", owner: "tickets", dependsOn: [{ stepId: "publish", outcome: "completed" }], when: true,
    inputs: [{ name: "pair", schemaVersion: "pa-publication-pair/v1", source: "output", stepId: "publish", output: "pair" }, { name: "decision", schemaVersion: "pa-decision/v1", source: "output", stepId: "approve", output: "decision" }],
    operation: { id: "ticket.queue", version: "v1" }, authorization: ["ticket.queue.advance"], effects: ["ticket.queue"], outputs: [{ name: "queue", schemaVersion: "pa-ticket-queue-result/v1" }],
    verification: [{ id: "ticket.queue-observed", version: "v1", inputs: ["pair", "decision"] }], transitions: { completed: "completed", failed: "blocked", unknown: "blocked" }, failurePolicy: { strategy: "reconcile", correctionOwner: "tickets" } });
  const raw = bytes(d); parseWorkflowDefinition(raw);
  f.selection = { ...f.selection, definitions: f.selection.definitions.map(selected => ({ ...selected, raw, sha256: digest(raw) })) };
  f.bundle.workflow.sha256 = digest(raw);
  const storeDir = join(f.root, "tickets"); const artifactRoot = join(f.root, "artifacts"); mkdirSync(storeDir); mkdirSync(artifactRoot);
  const store = new TicketStore(storeDir, { team: "requirements", mode: "analyze", privileged: true });
  writeFileSync(join(storeDir, "EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", title: "Synthetic workflow owner fixture", status: "requirement-review", doc_refs: [], comments: [] }));
  const req = join(artifactRoot, f.bundle.requirements.ref.slice("requirements:".length)); const uat = join(artifactRoot, f.bundle.uat.ref.slice("uat:".length));
  mkdirSync(dirname(req), { recursive: true });
  const owners = createTicketWorkflowOwners(f.journal, store, artifactRoot, () => f.host.authenticate());
  for (const [id, owner] of owners) (f.host.owners as Map<string, WorkflowEffectOwner>).set(id, owner);
  const admit = () => f.service.admit(f.selection, bytes(f.bundle));
  return { ...f, store, req, uat, artifactRoot, owners, admit };
}

const fixture = ticketOwnerFixture;

test("actual ticket publication/queue owners publish exact pair once and preserve counters and audit on replay", async () => {
  const f = fixture(); try {
    const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve");
    await assert.rejects(f.service.requestStep(run.runId, 2, "queue", decision.decisionId), /WORKFLOW_CONFLICT/);
    const published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId);
    assert.equal(published.outcomes.publish, "completed");
    assert.equal(digest(readFileSync(f.req)), run.subject.requirements.sha256); assert.equal(digest(readFileSync(f.uat)), run.subject.uat.sha256);
    const reqInode = statSync(f.req).ino, uatInode = statSync(f.uat).ino;
    assert.equal(f.store.get("EX-1")!.doc_refs.filter(r => r.type === "requirements" && r.primary).length, 1);
    assert.equal(f.store.get("EX-1")!.status, "requirement-review");
    const queued = await f.service.requestStep(run.runId, published.revision, "queue", decision.decisionId);
    assert.equal(queued.outcomes.queue, "completed"); assert.equal(f.store.get("EX-1")!.status, "pending-implementation");
    assert.equal(f.store.get("EX-1")!.assignee, "builder/team-manager");
    assert.deepEqual([statSync(f.req).ino, statSync(f.uat).ino], [reqInode, uatInode]);
    assert.equal(f.store.readAudit().length, 3); // two refs, one queue; no duplicate ticket updates
    for (const table of ["deployments", "review_authorization_claims"]) assert.equal((f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  } finally { f.close(); }
});
test("recognized prequeued override converges the SAME intent and approved pair without recapture, republish or execution profile", async () => {
  const f = fixture(); try {
    const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve"), published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId);
    f.store.update("EX-1", { status: "pending-implementation", assignee: "sinh" }, "operator-queue-only");
    const real = f.owners.get("ticket.queue")!;
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("ticket.queue", { ...real, execute: async () => { throw Error("injected before queue convergence"); } });
    await assert.rejects(f.service.requestStep(run.runId, published.revision, "queue", decision.decisionId), /injected/);
    const pending = f.service.status(run.runId), intent = pending.pending[0]!, inodes = [statSync(f.req).ino, statSync(f.uat).ino];
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("ticket.queue", real);
    const observations = f.host.observations; f.host.observations = () => ({ ...observations(), projectProfile: "missing" });
    const settled = await f.service.reconcile(run.runId, pending.revision, intent.intentId);
    assert.equal(settled.outcomes.queue, "completed"); assert.equal(settled.pending.length, 0);
    assert.equal(f.store.get("EX-1")!.assignee, "builder/team-manager"); assert.equal(f.store.get("EX-1")!.status, "pending-implementation");
    assert.deepEqual([statSync(f.req).ino, statSync(f.uat).ino], inodes); assert.equal(settled.subjectSha256, published.subjectSha256);
    assert.deepEqual(settled.decisions, published.decisions); assert.equal(settled.attempts.length, 1);
    assert.equal(f.journal.read(run.runId).filter(e => e.event.type === "intent" && (e.event.data.intent as { stepId: string }).stepId === "queue").length, 1);
    const finalAudit = f.store.readAudit().at(-1)!; assert.deepEqual(finalAudit.changes.assignee, ["sinh", "builder/team-manager"]); assert.equal(finalAudit.changes.status, undefined);
    assert.equal(f.store.readAudit().length, 4);
  } finally { f.close(); }
});

for (const variant of ["foreign-owner", "advanced", "terminal", "unaudited", "revoked", "pair-drift", "stale", "partial-owner", "already-correct"] as const) {
  test(`same-intent queue convergence handles ${variant} without duplicate approval/publication`, async () => {
    const f = fixture(); try {
      const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve"), published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId);
      f.store.update("EX-1", { status: "pending-implementation", assignee: "sinh" }, "operator-queue-only");
      const real = f.owners.get("ticket.queue")!;
      (f.host.owners as Map<string, WorkflowEffectOwner>).set("ticket.queue", { ...real, execute: async () => { throw Error("injected"); } });
      await assert.rejects(f.service.requestStep(run.runId, published.revision, "queue", decision.decisionId), /injected/);
      (f.host.owners as Map<string, WorkflowEffectOwner>).set("ticket.queue", real);
      let state = f.service.status(run.runId);
      if (variant === "foreign-owner") f.store.update("EX-1", { assignee: "unrelated/team-manager" });
      if (variant === "advanced" || variant === "terminal") f.store.update("EX-1", { status: variant === "advanced" ? "implementing" : "done" });
      if (variant === "unaudited") writeFileSync(join(f.root, "tickets/audit.jsonl"), "");
      if (variant === "pair-drift") writeFileSync(f.uat, "changed");
      if (variant === "partial-owner") f.store.update("EX-1", { status: "requirement-review", assignee: "builder/team-manager" });
      if (variant === "already-correct") f.store.update("EX-1", { assignee: "builder/team-manager" });
      if (variant === "revoked" || variant === "already-correct") state = await f.service.revoke(run.runId, state.revision, decision.decisionId);
      const before = f.store.readAudit().length;
      const result = f.service.reconcile(run.runId, variant === "stale" ? state.revision - 1 : state.revision, state.pending[0]!.intentId);
      if (variant === "already-correct" || variant === "partial-owner") {
        assert.equal((await result).outcomes.queue, "completed"); assert.equal(f.store.readAudit().length, before + (variant === "partial-owner" ? 1 : 0));
      } else { await assert.rejects(result, /WORKFLOW_/); assert.equal(f.store.readAudit().length, before); }
      assert.deepEqual(f.service.status(run.runId).decisions, state.decisions);
      assert.equal(f.service.status(run.runId).subjectSha256, published.subjectSha256);
    } finally { f.close(); }
  });
}

test("concurrent queue reconcilers retain one intent, one missing-field update and one settlement", async () => {
  const f = fixture(); try {
    const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve"), published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId);
    f.store.update("EX-1", { status: "pending-implementation", assignee: "sinh" }); const real = f.owners.get("ticket.queue")!;
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("ticket.queue", { ...real, execute: async () => { throw Error("injected"); } });
    await assert.rejects(f.service.requestStep(run.runId, published.revision, "queue", decision.decisionId));
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("ticket.queue", real); const pending = f.service.status(run.runId), intent = pending.pending[0]!;
    const results = await Promise.allSettled(Array.from({ length: 16 }, () => f.service.reconcile(run.runId, pending.revision, intent.intentId)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const state = f.service.status(run.runId); assert.equal(state.outcomes.queue, "completed"); assert.equal(state.pending.length, 0);
    assert.equal(f.store.readAudit().filter(e => e.changes.assignee?.[1] === "builder/team-manager").length, 1);
    assert.equal(f.journal.read(run.runId).filter(e => e.event.type === "result" && e.event.data.intentId === intent.intentId).length, 1);
  } finally { f.close(); }
});

test("fresh queue-only coordinator adoption can settle only the retained authorized intent", async () => {
  const f = fixture(); try {
    const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve"), published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId);
    f.store.update("EX-1", { status: "pending-implementation", assignee: "sinh" });
    const real = f.owners.get("ticket.queue")!;
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("ticket.queue", { ...real, execute: async () => { throw Error("injected"); } });
    await assert.rejects(f.service.requestStep(run.runId, published.revision, "queue", decision.decisionId));
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("ticket.queue", real);
    const pending = f.service.status(run.runId); f.host.authenticate = () => ({ ...run.caller, deploymentId: "d-fedcba", identitySha256: "b".repeat(64) }); f.host.assertInactive = () => {};
    const capture = f.host.capture; f.host.capture = async request => {
      assert.equal(request.succession?.purpose, "queue-reconcile"); assert.deepEqual(request.succession?.queueIntent, pending.pending[0]); return capture(request);
    };
    const adopted = await f.service.adoptCoordinator(run.runId, pending.revision, run.subjectSha256);
    assert.equal(adopted.coordinatorQueueOnly, true);
    await assert.rejects(f.service.revoke(run.runId, adopted.revision, decision.decisionId), /adopted-queue-intent-only/);
    const settled = await f.service.reconcile(run.runId, adopted.revision, pending.pending[0]!.intentId);
    assert.equal(settled.outcomes.queue, "completed"); assert.equal(settled.decisions.length, 1);
    await assert.rejects(f.service.requestStep(run.runId, settled.revision, "publish", decision.decisionId), /adopted-queue-intent-only/);
  } finally { f.close(); }
});

test("selected initial existing-branch producer publishes, queues and yields an exact reuse baseline without fabricated previous canonical source", async () => {
  const f = fixture(), templates = templateFixture(); try {
    const entry = structuredClone(templates.registry.entries[0]!); entry.id = "review-bundle";
    entry.source = { path: "skills/templates/review-bundle.md", sha256: digest("{{bundle}}\n"), selector: null };
    entry.bindings = { bundle: { type: "json", required: true } }; entry.validation = { kind: "review-bundle", sections: [] };
    templates.registry.entries.push(entry); writeFileSync(join(templates.root, entry.source.path), "{{bundle}}\n"); const selected = templates.save();
    f.bundle.handoff = { type: "amendment", baseSha: f.bundle.handoff.baseSha, branch: f.bundle.handoff.branch, featureSha: "c".repeat(40), branchAction: "reuse" };
    f.selection = { ...f.selection, configRoot: templates.root, definitions: f.selection.definitions.map(d => ({ ...d, configRoot: templates.root })) };
    f.host.resources = (selection, subject, caller) => workflowResourceFixture(selection, subject, caller, selected);
    const run = f.service.admitProduced(f.selection, bytes({ action: "render", id: "review-bundle", version: "1", bindings: { bundle: f.bundle } }), { selection: selected });
    assert.equal(run.attempts.length, 1); assert.equal(run.attempts[0]!.predecessor, null);
    const decision = await f.service.decide(run.runId, 1, "approve"), published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId);
    const queued = await f.service.requestStep(run.runId, published.revision, "queue", decision.decisionId);
    assert.equal(queued.outcomes.queue, "completed");
    const baseline = structuredTaskBaseline(f.journal, run.runId, decision.decisionId, { repoKey: run.subject.repository.key, repoRoot: run.subject.repository.root, ticket: "EX-1", branch: run.subject.handoff.branch, team: "builder", mode: "orchestrator", primaryRequirementsRef: run.subject.requirements.ref }, ref => readFileSync(ref.startsWith("requirements:") ? f.req : f.uat));
    assert.deepEqual(baseline.handoff, f.bundle.handoff); assert.equal(baseline.handoff.branchAction, "reuse");
    assert.equal(baseline.authority.runId, run.runId); assert.equal(baseline.baseSha, f.bundle.handoff.baseSha);
    // Actual materialization still owns exact linked/checkout HEAD and custody;
    // this typed baseline does not create/select/reset any Git branch.
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM deployments").get() as { n: number }).n, 0);
  } finally { f.close(); templates.dispose(); }
});

test("32 concurrent publication requests produce one successor and exactly two audited attachments", async () => {
  const f = fixture(); try {
    const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve");
    const results = await Promise.allSettled(Array.from({ length: 32 }, () => f.service.requestStep(run.runId, 2, "publish", decision.decisionId)));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const failures = results.filter(r => r.status === "rejected"); assert.equal(failures.length, 31);
    for (const failure of failures) if (failure.status === "rejected") assert.match(String(failure.reason), /WORKFLOW_CONFLICT/);
    assert.equal(f.store.readAudit().length, 2); assert.equal(f.service.status(run.runId).outcomes.publish, "completed");
    assert.equal(f.journal.read(run.runId).filter(e => e.event.type === "intent").length, 1);
  } finally { f.close(); }
});
test("interrupted queue effect is observed once and settles after revocation without a second audit", async () => {
  const f = fixture(); try {
    const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve");
    const published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId), real = f.owners.get("ticket.queue")!;
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("ticket.queue", { ...real, execute: async i => { await real.execute(i); throw new Error("injected after queue"); } });
    await assert.rejects(f.service.requestStep(run.runId, published.revision, "queue", decision.decisionId), /injected after queue/);
    const pending = f.service.status(run.runId), revoked = await f.service.revoke(run.runId, pending.revision, decision.decisionId);
    const settled = await f.service.reconcile(run.runId, revoked.revision, pending.pending[0]!.intentId);
    assert.equal(settled.outcomes.queue, "completed"); assert.equal(f.store.readAudit().length, 3);
  } finally { f.close(); }
});
test("interruption after first member resumes only the absent member using the SAME durable intent", async () => {
  const f = fixture(); try {
    const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve"); const authenticate = f.host.authenticate;
    f.host.authenticate = () => { if (existsSync(f.req) && !existsSync(f.uat)) throw new Error("injected between members"); return authenticate(); };
    await assert.rejects(f.service.requestStep(run.runId, 2, "publish", decision.decisionId), /injected between members/);
    assert.equal(existsSync(f.uat), false); assert.equal(f.store.get("EX-1")!.status, "requirement-review");
    const reqInode = statSync(f.req).ino; const pending = f.service.status(run.runId);
    f.host.authenticate = authenticate;
    const result = await f.service.reconcile(run.runId, pending.revision, pending.pending[0]!.intentId);
    assert.equal(result.outcomes.publish, "completed"); assert.equal(statSync(f.req).ino, reqInode);
    assert.equal(f.journal.read(run.runId).filter(e => e.event.type === "intent").length, 1);
  } finally { f.close(); }
});
test("conflicting bytes, symlinks and foreign primary evidence are preserved, never overwritten or queued", async () => {
  for (const kind of ["bytes", "symlink", "primary"] as const) {
    const f = fixture(); try {
      const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve");
      if (kind === "bytes") writeFileSync(f.req, "original conflicting source");
      if (kind === "symlink") symlinkSync("/nonexistent/protected", f.req);
      if (kind === "primary") f.store.update("EX-1", { add_doc_ref: { path: "foreign.md", type: "requirements", primary: true } });
      await assert.rejects(f.service.requestStep(run.runId, 2, "publish", decision.decisionId), /WORKFLOW_UNCERTAIN/);
      assert.equal(existsSync(f.uat), false); assert.equal(f.store.get("EX-1")!.status, "requirement-review");
      assert.equal(f.service.status(run.runId).pending.length, 1);
      if (kind === "bytes") assert.equal(readFileSync(f.req, "utf8"), "original conflicting source");
    } finally { f.close(); }
  }
});
test("revocation after partial publication prevents the absent member; completed native effects can still settle", async () => {
  const f = fixture(); try {
    const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve"); const authenticate = f.host.authenticate;
    f.host.authenticate = () => { if (existsSync(f.req) && !existsSync(f.uat)) throw new Error("injected"); return authenticate(); };
    await assert.rejects(f.service.requestStep(run.runId, 2, "publish", decision.decisionId), /injected/);
    f.host.authenticate = authenticate;
    const pending = f.service.status(run.runId); await f.service.revoke(run.runId, pending.revision, decision.decisionId);
    const revoked = f.service.status(run.runId);
    await assert.rejects(f.service.reconcile(run.runId, revoked.revision, revoked.pending[0]!.intentId), /WORKFLOW_AUTHORITY/);
    assert.equal(existsSync(f.uat), false); assert.equal(existsSync(f.req), true);
  } finally { f.close(); }
  const complete = fixture(); try {
    const run = complete.admit(), decision = await complete.service.decide(run.runId, 1, "approve");
    const real = complete.owners.get("publication.pair")!;
    (complete.host.owners as Map<string, WorkflowEffectOwner>).set("publication.pair", { ...real, execute: async i => { await real.execute(i); throw new Error("injected after native publication"); } });
    await assert.rejects(complete.service.requestStep(run.runId, 2, "publish", decision.decisionId), /injected after/);
    const pending = complete.service.status(run.runId); const revoked = await complete.service.revoke(run.runId, pending.revision, decision.decisionId);
    const settled = await complete.service.reconcile(run.runId, revoked.revision, pending.pending[0]!.intentId);
    assert.equal(settled.outcomes.publish, "completed"); assert.equal(complete.store.readAudit().length, 2);
    await assert.rejects(complete.service.requestStep(run.runId, settled.revision, "queue", decision.decisionId), /WORKFLOW_AUTHORITY/);
  } finally { complete.close(); }
});
