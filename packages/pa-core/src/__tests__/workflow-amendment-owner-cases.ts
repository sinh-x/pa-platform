import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../workflows/contracts.js";
import { JsonWorkflowService, type WorkflowEffectOwner, type WorkflowState } from "../workflows/service.js";
import { bytes, fixtureEvidence } from "./workflow-fixtures.js";
import { ticketOwnerFixture } from "./workflow-ticket-owner-cases.js";

type Fixture = ReturnType<typeof ticketOwnerFixture>;
async function initial(f: Fixture, queue = true) {
  const run = f.admit(), decision = await f.service.decide(run.runId, 1, "approve");
  const published = await f.service.requestStep(run.runId, 2, "publish", decision.decisionId);
  return queue ? f.service.requestStep(run.runId, published.revision, "queue", decision.decisionId) : published;
}
function revisedSubject(f: Fixture, previous: WorkflowState) {
  const next = structuredClone(previous.subject); next.revision++; next.subjectId = `subject-${next.revision}`;
  next.handoff = { type: "amendment", baseSha: next.handoff.baseSha, branch: next.handoff.branch, featureSha: "c".repeat(40), branchAction: "reuse" };
  next.requirements.ref = `requirements:agent-teams/requirements/artifacts/revision-${next.revision}.md`;
  next.matrix.ref = next.requirements.ref; next.uat.ref = `uat:agent-teams/requirements/artifacts/revision-${next.revision}-uat.md`;
  for (const [ref, raw] of fixtureEvidence(next)) f.evidence.set(ref, raw);
  return next;
}
async function amend(f: Fixture, previous: WorkflowState) {
  const subject = revisedSubject(f, previous), revised = f.service.revise(previous.runId, previous.revision, bytes(subject));
  const decision = await f.service.decide(revised.runId, revised.revision, "approve");
  const req = join(f.artifactRoot, subject.requirements.ref.slice("requirements:".length)), uat = join(f.artifactRoot, subject.uat.ref.slice("uat:".length));
  return { subject, state: f.service.status(previous.runId), decision, req, uat };
}

test("amendment publication promotes ONLY the proven predecessor, preserves historical bytes/metadata and reuses the queue", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f), ticket = f.store.get("EX-1")!, audit = f.store.readAudit().length;
    const inodes = [statSync(f.req).ino, statSync(f.uat).ino], raw = [readFileSync(f.req), readFileSync(f.uat)];
    const a = await amend(f, old);
    const published = await f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId);
    assert.equal(published.outcomes.publish, "completed");
    const current = f.store.get("EX-1")!;
    assert.deepEqual(current.doc_refs.filter(ref => ref.primary).map(ref => ref.path), [a.subject.requirements.ref.slice("requirements:".length)]);
    for (const ref of ticket.doc_refs) assert.deepEqual(current.doc_refs.find(r => r.path === ref.path), { ...ref, primary: false });
    assert.deepEqual([readFileSync(f.req), readFileSync(f.uat)], raw); assert.deepEqual([statSync(f.req).ino, statSync(f.uat).ino], inodes);
    assert.equal(digest(readFileSync(a.req)), a.subject.requirements.sha256); assert.equal(digest(readFileSync(a.uat)), a.subject.uat.sha256);
    assert.equal(f.store.readAudit().length, audit + 3); // two nonprimary refs, one mutex-serialized primary update
    const queued = await f.service.requestStep(old.runId, published.revision, "queue", a.decision.decisionId);
    assert.equal(queued.outcomes.queue, "completed"); assert.equal(f.store.readAudit().length, audit + 3);
    assert.equal(queued.attempts[0]!.outcomes.queue, "completed"); assert.equal(queued.attempts.length, 2);
    assert.equal(f.journal.runs("example", "EX-1").length, 1);
    for (const table of ["deployments", "review_authorization_claims"]) assert.equal((f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    const next = await amend(f, queued), republished = await f.service.requestStep(old.runId, next.state.revision, "publish", next.decision.decisionId);
    assert.equal(republished.attempts.length, 3); assert.equal(digest(readFileSync(a.req)), a.subject.requirements.sha256);
    assert.equal(f.store.get("EX-1")!.doc_refs.filter(ref => ref.primary).length, 1);
  } finally { f.close(); }
});

test("an unchanged exact canonical pair is reused after a new material subject decision without metadata churn", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f), next = structuredClone(old.subject); next.revision++; next.subjectId = "same-artifacts-new-scope";
    next.handoff = { type: "amendment", baseSha: next.handoff.baseSha, branch: next.handoff.branch, featureSha: "c".repeat(40), branchAction: "reuse" }; next.scope.newPaths.push("src/amended.ts");
    const revised = f.service.revise(old.runId, old.revision, bytes(next)), decision = await f.service.decide(old.runId, revised.revision, "approve"), before = f.store.get("EX-1"), audit = f.store.readAudit();
    const published = await f.service.requestStep(old.runId, f.service.status(old.runId).revision, "publish", decision.decisionId);
    const queued = await f.service.requestStep(old.runId, published.revision, "queue", decision.decisionId);
    assert.equal(queued.outcomes.queue, "completed"); assert.deepEqual(f.store.get("EX-1"), before); assert.deepEqual(f.store.readAudit(), audit);
  } finally { f.close(); }
});

test("a revised subject cannot overwrite changed bytes at an old canonical path", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f), next = revisedSubject(f, old); next.requirements.ref = old.subject.requirements.ref; next.matrix.ref = next.requirements.ref;
    const evidence = fixtureEvidence(next), raw = Buffer.concat([evidence.get(next.requirements.ref)!, Buffer.from("\nMaterially changed document text.\n")]);
    next.requirements.sha256 = digest(raw); evidence.set(next.requirements.ref, raw); for (const [ref, body] of evidence) f.evidence.set(ref, body);
    const revised = f.service.revise(old.runId, old.revision, bytes(next)), decision = await f.service.decide(old.runId, revised.revision, "approve");
    const before = readFileSync(f.req), ticket = f.store.get("EX-1");
    await assert.rejects(f.service.requestStep(old.runId, f.service.status(old.runId).revision, "publish", decision.decisionId), /WORKFLOW_UNCERTAIN/);
    assert.deepEqual(readFileSync(f.req), before); assert.deepEqual(f.store.get("EX-1"), ticket);
  } finally { f.close(); }
});

test("implementing status alone cannot stand in for the predecessor's missing native queue result", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f, false); f.store.update("EX-1", { status: "implementing", assignee: "builder/team-manager" });
    const a = await amend(f, old), published = await f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId), before = f.store.get("EX-1"), audit = f.store.readAudit();
    await assert.rejects(f.service.requestStep(old.runId, published.revision, "queue", a.decision.decisionId), /WORKFLOW_CONFLICT/);
    assert.deepEqual(f.store.get("EX-1"), before); assert.deepEqual(f.store.readAudit(), audit); assert.equal(f.service.status(old.runId).outcomes.queue, undefined);
  } finally { f.close(); }
});

test("amendment queue preserves an already implementing lifecycle and never resets unrelated counters/history", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f);
    f.store.update("EX-1", { status: "implementing", tags: ["review-attempt-3", "failure-retained"] }); f.store.comment("EX-1", "synthetic/operator", "Original failure remains.");
    const before = f.store.get("EX-1")!, a = await amend(f, old);
    const pub = await f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId), count = f.store.readAudit().length;
    const queued = await f.service.requestStep(old.runId, pub.revision, "queue", a.decision.decisionId), after = f.store.get("EX-1")!;
    assert.equal(queued.outcomes.queue, "completed"); assert.equal(after.status, "implementing"); assert.equal(after.assignee, before.assignee);
    assert.deepEqual(after.tags, before.tags); assert.deepEqual(after.comments, before.comments); assert.equal(after.resolvedAt, before.resolvedAt);
    assert.equal(f.store.readAudit().length, count);
  } finally { f.close(); }
});

for (const point of ["member", "first-ref", "before-promotion", "after-promotion"] as const) {
  test(`interrupted amendment ${point} reconciles the SAME intent without duplicate files/refs or lost primary`, async () => {
    const f = ticketOwnerFixture(); try {
      const old = await initial(f), a = await amend(f, old), auth = f.host.authenticate, update = f.store.update.bind(f.store);
      let interrupted = false;
      f.host.authenticate = () => {
        if (!interrupted && point === "member" && existsSync(a.req) && !existsSync(a.uat)) { interrupted = true; throw Error("injected amendment member"); }
        return auth();
      };
      f.store.update = (...args) => {
        if (!interrupted && point === "before-promotion" && args[1].doc_refs) { interrupted = true; throw Error("injected amendment before promotion"); }
        const result = update(...args);
        if (!interrupted && ((point === "first-ref" && args[1].add_doc_ref?.path === a.subject.requirements.ref.slice("requirements:".length)) || (point === "after-promotion" && args[1].doc_refs))) {
          interrupted = true; throw Error("injected amendment after write");
        }
        return result;
      };
      await assert.rejects(f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId), /injected amendment/);
      const pending = f.service.status(old.runId), inode = statSync(a.req).ino;
      assert.equal(pending.pending.length, 1); assert.equal(f.store.get("EX-1")!.doc_refs.filter(ref => ref.primary).length, 1);
      f.host.authenticate = auth; f.store.update = update;
      const reloaded = new JsonWorkflowService(f.journal, f.host);
      const settled = await reloaded.reconcile(old.runId, pending.revision, pending.pending[0]!.intentId);
      assert.equal(settled.outcomes.publish, "completed"); assert.equal(statSync(a.req).ino, inode);
      assert.equal(f.store.get("EX-1")!.doc_refs.length, 4); assert.equal(f.store.readAudit().length, 6);
      assert.equal(f.journal.read(old.runId).filter(e => e.event.type === "intent" && (e.event.data.intent as { subjectSha256: string }).subjectSha256 === a.state.subjectSha256).length, 1);
    } finally { f.close(); }
  });
}

for (const point of ["before-promotion", "after-promotion"] as const) {
  test(`revoked amendment ${point} blocks missing work but permits proven settlement`, async () => {
    const f = ticketOwnerFixture(); try {
      const old = await initial(f), a = await amend(f, old), update = f.store.update.bind(f.store);
      f.store.update = (...args) => {
        if (point === "before-promotion" && args[1].doc_refs) throw Error("injected before promotion");
        const result = update(...args); if (point === "after-promotion" && args[1].doc_refs) throw Error("injected after promotion"); return result;
      };
      await assert.rejects(f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId), /injected/); f.store.update = update;
      const pending = f.service.status(old.runId), revoked = await f.service.revoke(old.runId, pending.revision, a.decision.decisionId), before = f.store.get("EX-1"), audit = f.store.readAudit().length;
      if (point === "before-promotion") {
        await assert.rejects(f.service.reconcile(old.runId, revoked.revision, pending.pending[0]!.intentId), /WORKFLOW_AUTHORITY/);
        assert.deepEqual(f.store.get("EX-1"), before); assert.equal(f.service.status(old.runId).pending.length, 1);
      } else {
        const settled = await f.service.reconcile(old.runId, revoked.revision, pending.pending[0]!.intentId); assert.equal(settled.outcomes.publish, "completed");
        await assert.rejects(f.service.requestStep(old.runId, settled.revision, "queue", a.decision.decisionId), /WORKFLOW_AUTHORITY/);
      }
      assert.equal(f.store.readAudit().length, audit);
    } finally { f.close(); }
  });
}

for (const variant of ["foreign-primary", "missing-old-ref", "duplicate-old-ref", "old-bytes", "old-symlink", "old-missing", "new-bytes", "new-symlink", "terminal", "review-uat"] as const) {
  test(`amendment ${variant} blocks without overwriting or selecting a convenient primary`, async () => {
    const f = ticketOwnerFixture(); try {
      const old = await initial(f), a = await amend(f, old);
      if (variant === "foreign-primary") f.store.update("EX-1", { add_doc_ref: { type: "requirements", path: "foreign.md", primary: true } });
      if (variant === "missing-old-ref") f.store.update("EX-1", { remove_doc_ref: old.subject.uat.ref.slice("uat:".length) });
      if (variant === "duplicate-old-ref") { const t = f.store.get("EX-1")!; f.store.update("EX-1", { doc_refs: [...t.doc_refs, t.doc_refs[0]!] }); }
      if (variant === "old-bytes") writeFileSync(f.req, "Preserve historical conflict");
      if (variant === "old-symlink") { unlinkSync(f.req); symlinkSync("/nonexistent/protected", f.req); }
      if (variant === "old-missing") unlinkSync(f.req);
      if (variant === "new-bytes") writeFileSync(a.req, "Preserve new conflict");
      if (variant === "new-symlink") symlinkSync("/nonexistent/protected", a.req);
      if (variant === "terminal" || variant === "review-uat") f.store.update("EX-1", { status: variant === "terminal" ? "done" : "review-uat" });
      const ticket = f.store.get("EX-1"), audit = f.store.readAudit().length;
      await assert.rejects(f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId), /WORKFLOW_(UNCERTAIN|CONFLICT)/);
      assert.equal(existsSync(a.uat), false); assert.deepEqual(f.store.get("EX-1"), ticket); assert.equal(f.store.readAudit().length, audit);
      if (variant === "new-bytes") assert.equal(readFileSync(a.req, "utf8"), "Preserve new conflict");
    } finally { f.close(); }
  });
}

test("files/refs/status alone cannot manufacture a predecessor publication outcome", async () => {
  const f = ticketOwnerFixture(); try {
    const run = f.admit(), capture = f.host.capture; f.host.capture = async r => ({ ...await capture(r), outcome: "changes-requested" });
    await f.service.decide(run.runId, 1, "approve"); f.host.capture = capture;
    writeFileSync(f.req, f.evidence.get(run.subject.requirements.ref)!); writeFileSync(f.uat, f.evidence.get(run.subject.uat.ref)!);
    f.store.update("EX-1", { add_doc_ref: { type: "requirements", path: run.subject.requirements.ref.slice("requirements:".length), primary: true } });
    f.store.update("EX-1", { add_doc_ref: { type: "uat", path: run.subject.uat.ref.slice("uat:".length) } });
    const a = await amend(f, f.service.status(run.runId)), before = f.store.get("EX-1");
    await assert.rejects(f.service.requestStep(run.runId, a.state.revision, "publish", a.decision.decisionId), /WORKFLOW_UNCERTAIN/);
    assert.deepEqual(f.store.get("EX-1"), before); assert.equal(existsSync(a.req), false);
  } finally { f.close(); }
});

test("an intervening request-changes attempt follows its explicit chain to the proven publication, not newest status", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f), capture = f.host.capture;
    const subject = revisedSubject(f, old), revised = f.service.revise(old.runId, old.revision, bytes(subject));
    f.host.capture = async r => ({ ...await capture(r), outcome: "changes-requested" }); await f.service.decide(old.runId, revised.revision, "approve"); f.host.capture = capture;
    const a = await amend(f, f.service.status(old.runId)), published = await f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId);
    assert.equal(published.attempts.length, 3); assert.equal(published.outcomes.publish, "completed");
    assert.equal(f.store.get("EX-1")!.doc_refs.length, 4); assert.equal(digest(readFileSync(f.req)), old.subject.requirements.sha256);
  } finally { f.close(); }
});

test("a failed intervening publication cannot be skipped to an older completed predecessor", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f), a = await amend(f, old), real = f.owners.get("publication.pair")!;
    // Deliberate trusted-host fixture injection; this is not a native passed/failed import surface.
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("publication.pair", { admit: () => {}, observe: async () => ({ state: "proven", outcome: "failed", evidence: [{ schemaVersion: "pa-workflow-evidence-ref/v1", ref: "synthetic-failure", version: "v1", sha256: "d".repeat(64) }] }), execute: async () => { throw Error("must not execute"); }, verify: () => true });
    const failed = await f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId);
    (f.host.owners as Map<string, WorkflowEffectOwner>).set("publication.pair", real);
    const b = await amend(f, failed), before = f.service.status(old.runId).revision;
    await assert.rejects(f.service.requestStep(old.runId, b.state.revision, "publish", b.decision.decisionId), /WORKFLOW_UNCERTAIN/);
    assert.equal(f.service.status(old.runId).revision, before); assert.equal(existsSync(b.req), false); assert.equal(f.store.get("EX-1")!.doc_refs.length, 2);
  } finally { f.close(); }
});

test("a partially written ticket is retained as unknown, never repaired or blindly republished by amendment recovery", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f), a = await amend(f, old), update = f.store.update.bind(f.store), path = join(f.root, "tickets/EX-1.json");
    f.store.update = (...args) => {
      if (args[1].doc_refs) { writeFileSync(path, "{partial-ticket-fault"); throw Error("injected partial ticket persistence"); }
      return update(...args);
    };
    await assert.rejects(f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId), /injected partial ticket/); f.store.update = update;
    const pending = f.service.status(old.runId), ticket = readFileSync(path), raw = readFileSync(a.req), audit = f.store.readAudit();
    await assert.rejects(f.service.reconcile(old.runId, pending.revision, pending.pending[0]!.intentId));
    assert.deepEqual(readFileSync(path), ticket); assert.deepEqual(readFileSync(a.req), raw); assert.deepEqual(f.store.readAudit(), audit);
    assert.equal(f.service.status(old.runId).pending.length, 1); assert.equal(f.service.status(old.runId).outcomes.publish, undefined);
  } finally { f.close(); }
});

test("primary identity is reread AFTER native reauthentication, not just before entering the ticket mutex", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f), a = await amend(f, old), authenticate = f.host.authenticate; let changed = false;
    f.host.authenticate = () => {
      const ticket = f.store.get("EX-1")!;
      if (!changed && ticket.doc_refs.some(ref => ref.path === a.subject.requirements.ref.slice("requirements:".length)) && ticket.doc_refs.some(ref => ref.path === a.subject.uat.ref.slice("uat:".length))) {
        changed = true; f.store.update("EX-1", { add_doc_ref: { type: "requirements", path: "foreign-after-auth.md", primary: true } });
      }
      return authenticate();
    };
    await assert.rejects(f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId), /WORKFLOW_UNCERTAIN/);
    assert.equal(changed, true); assert.deepEqual(f.store.get("EX-1")!.doc_refs.filter(ref => ref.primary).map(ref => ref.path), ["foreign-after-auth.md"]);
    assert.equal(f.service.status(old.runId).outcomes.publish, undefined);
  } finally { f.close(); }
});

test("queue lifecycle is reread AFTER native reauthentication and never regresses a newly entered review state", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f), a = await amend(f, old), published = await f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId);
    f.store.update("EX-1", { status: "requirement-review", assignee: "requirements/team-manager" });
    const authenticate = f.host.authenticate, transaction = f.store.withWorkflowTransaction.bind(f.store); let inside = false, changed = false;
    f.store.withWorkflowTransaction = operation => transaction(() => { inside = true; try { return operation(); } finally { inside = false; } });
    f.host.authenticate = () => { if (inside && !changed) { changed = true; f.store.update("EX-1", { status: "review-uat" }); } return authenticate(); };
    await assert.rejects(f.service.requestStep(old.runId, published.revision, "queue", a.decision.decisionId), /WORKFLOW_CONFLICT/);
    assert.equal(changed, true); assert.equal(f.store.get("EX-1")!.status, "review-uat"); assert.equal(f.service.status(old.runId).outcomes.queue, undefined);
  } finally { f.close(); }
});

test("32 concurrent amendment requests create one intent and exactly one primary promotion", async () => {
  const f = ticketOwnerFixture(); try {
    const old = await initial(f), a = await amend(f, old);
    const results = await Promise.allSettled(Array.from({ length: 32 }, () => f.service.requestStep(old.runId, a.state.revision, "publish", a.decision.decisionId)));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected").length, 31);
    for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /WORKFLOW_CONFLICT/);
    assert.equal(f.store.readAudit().length, 6); assert.equal(f.store.get("EX-1")!.doc_refs.filter(ref => ref.primary).length, 1);
  } finally { f.close(); }
});
