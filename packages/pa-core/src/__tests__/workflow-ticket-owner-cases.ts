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
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";

function fixture() {
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
