import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { adoptedWorkflow, packageDecision } from "../workflows/catalog.js";
import { requireDecision } from "../workflows/service.js";
import { subjectRevisionReason } from "../workflows/revisions.js";
import { readWorkflowEvidence } from "../workflows/evidence.js";
import { workflowReadService, workflowPrimerView } from "../workflows/public.js";
import { bytes, fixtureEvidence } from "./workflow-fixtures.js";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";
import { digest, type ReviewBundle } from "../workflows/contracts.js";

function nextSubject(f: ReturnType<typeof workflowRuntimeFixture>, amendment = false): ReviewBundle {
  const b = structuredClone(f.service.status(f.journal.runs(f.bundle.repository.key, f.bundle.ticket)[0]!).subject);
  b.revision++; b.subjectId = `package-revision-${b.revision}`;
  b.requirements.ref = `requirements:agent-teams/requirements/artifacts/revision-${b.revision}.md`;
  b.uat.ref = `uat:agent-teams/requirements/artifacts/revision-${b.revision}-uat.md`; b.matrix.ref = b.requirements.ref;
  if (amendment) b.handoff = { type: "amendment", branch: b.handoff.branch, baseSha: b.handoff.baseSha, featureSha: "c".repeat(40), branchAction: "reuse" };
  for (const [ref, raw] of fixtureEvidence(b)) f.evidence.set(ref, raw);
  return b;
}
async function changesRequested(f: ReturnType<typeof workflowRuntimeFixture>) {
  const capture = f.host.capture;
  f.host.capture = async r => ({ ...await capture(r), outcome: "changes-requested" });
  const state = f.service.admit(f.selection, f.subject);
  await f.service.decide(state.runId, 1, "approve"); f.host.capture = capture;
  return f.service.status(state.runId);
}

for (const ticket of ["EX-1", "EX-001", "EX-0", "EX-000"]) {
  test(`registry caller/read/revision surfaces preserve canonical ticket bytes ${ticket}`, async () => {
    const f = workflowRuntimeFixture(); try {
      f.bundle.ticket = ticket; f.bundle.handoff.branch = `feature/${ticket}-example`;
      for (const [ref, raw] of fixtureEvidence(f.bundle)) f.evidence.set(ref, raw);
      const capture = f.host.capture; f.host.capture = async r => ({ ...await capture(r), outcome: "changes-requested" });
      const run = f.service.admit(f.selection, bytes(f.bundle)); await f.service.decide(run.runId, 1, "approve");
      assert.equal(run.caller.ticket, ticket);
      const next = nextSubject(f); const revised = f.service.revise(run.runId, 2, bytes(next));
      assert.equal(revised.subject.ticket, ticket); assert.equal(revised.subject.handoff.branch, `feature/${ticket}-example`);
      const read = workflowReadService(JSON.stringify({ action: "status", ticket }), { state: exact => { assert.equal(exact, ticket); return revised; } });
      assert.equal(read.ok, true);
      f.host.authenticate = () => ({ ...run.caller, ticket: ticket === "EX-001" ? "EX-1" : "EX-999" });
      await assert.rejects(f.service.decide(run.runId, revised.revision, "approve"), /WORKFLOW_AUTHORITY/);
    } finally { f.close(); }
  });
}

test("public workflow reads reject malformed/oversized ticket IDs before resolving state", () => {
  let reads = 0;
  for (const ticket of ["EX-", "ex-001", "EX-1/../2", "EX-1\\u200b", `EX-${"1".repeat(62)}`]) {
    const result = workflowReadService(JSON.stringify({ action: "status", ticket }), { state: () => { reads++; return null; } });
    assert.equal(result.ok, false);
  }
  assert.equal(reads, 0);
});

test("request-changes creates an explicit immutable linked attempt in the same pinned run, not a latest-run guess", async () => {
  const f = workflowRuntimeFixture(); try {
    const previous = await changesRequested(f), oldEvents = f.journal.read(previous.runId), oldRaw = f.journal.snapshot(previous.subjectSha256);
    const next = nextSubject(f);
    // Rollout disable is not revocation/migration of this already admitted run.
    f.selection = { ...f.selection, bindings: f.selection.bindings.map(b => ({ ...b, enabled: false })) };
    const state = f.service.revise(previous.runId, previous.revision, bytes(next));
    assert.equal(state.runId, previous.runId); assert.equal(state.configRevision, previous.configRevision); assert.deepEqual(state.definition, previous.definition);
    assert.equal(state.attempts.length, 2); assert.equal(state.attempts[1]!.predecessor, state.attempts[0]!.attemptId);
    assert.equal(state.attempts[1]!.reason, "changes-requested"); assert.equal(state.attempts[0]!.outcomes.approve, "changes-requested");
    assert.equal(state.outcomes.approve, undefined); assert.equal(state.decisions.length, 1);
    assert.deepEqual(f.journal.read(state.runId).slice(0, oldEvents.length), oldEvents); assert.deepEqual(f.journal.snapshot(previous.subjectSha256), oldRaw);
    assert.equal(adoptedWorkflow(f.journal, next.repository.key, next.ticket)!.subjectSha256, state.subjectSha256);
    assert.deepEqual(f.service.next(state.runId).eligible, ["approve"]); assert.throws(() => packageDecision(state), /WORKFLOW_AUTHORITY/);
    const decision = await f.service.decide(state.runId, state.revision, "approve");
    const approved = f.service.status(state.runId); assert.equal(packageDecision(approved), decision.decisionId);
    assert.equal(approved.decisions.length, 2); assert.equal(f.journal.runs(next.repository.key, next.ticket).length, 1);
    assert.throws(() => f.service.admit(f.selection, bytes(next)), /WORKFLOW_DISABLED/);
  } finally { f.close(); }
});

test("material amendment preserves failures/old decisions, requires a new decision and revokes the exact historical subject", async () => {
  const f = workflowRuntimeFixture(); try {
    const run = f.service.admit(f.selection, f.subject), old = await f.service.decide(run.runId, 1, "approve");
    const owner = { admit: () => {}, observe: async () => ({ state: "proven" as const, outcome: "failed" as const, evidence: [{ schemaVersion: "pa-workflow-evidence-ref/v1" as const, ref: "synthetic-original-failure", version: "v1", sha256: "d".repeat(64) }] }), execute: async () => { throw Error("must not replay failed effect"); }, verify: () => true };
    (f.host.owners as Map<string, typeof owner>).set("publication.pair", owner);
    const failed = await f.service.requestStep(run.runId, 2, "publish", old.decisionId);
    const next = nextSubject(f, true); next.scope.newPaths.push("src/amended.ts");
    const revised = f.service.revise(run.runId, failed.revision, bytes(next));
    assert.equal(revised.attempts[0]!.outcomes.publish, "failed"); assert.equal(revised.attempts[1]!.reason, "material-amendment");
    assert.throws(() => requireDecision(revised, old.decisionId, []), /WORKFLOW_AUTHORITY/);
    assert.throws(() => packageDecision(revised), /WORKFLOW_AUTHORITY/);
    const readHost = { state: () => f.service.status(run.runId) };
    const history = workflowReadService(JSON.stringify({ action: "decision-verify", ticket: next.ticket, id: old.decisionId }), readHost) as { ok: boolean; result: { issued: boolean; currentSubject: boolean; approved: boolean } };
    assert.equal(history.ok, true); assert.equal(history.result.issued, true); assert.equal(history.result.currentSubject, false); assert.equal(history.result.approved, false);
    const approved = await f.service.decide(run.runId, revised.revision, "approve");
    assert.equal(packageDecision(f.service.status(run.runId)), approved.decisionId);
    let displayed: unknown; const capture = f.host.capture;
    f.host.capture = async request => { displayed = request; return capture(request); };
    const revoked = await f.service.revoke(run.runId, f.service.status(run.runId).revision, old.decisionId);
    assert.equal((displayed as { subjectSha256: string }).subjectSha256, run.subjectSha256);
    assert.equal((displayed as { subject: ReviewBundle }).subject.subjectId, run.subject.subjectId);
    assert.equal(packageDecision(revoked), approved.decisionId); assert.ok(revoked.revoked.includes(old.decisionId));
    assert.ok(workflowPrimerView(revoked).nextAction.includes("publish"));
    assert.ok(f.journal.read(run.runId).some(e => e.event.type === "result" && e.event.data.outcome === "failed"));
  } finally { f.close(); }
});

for (const variant of ["before-decision", "rejected", "cancelled", "stale", "revision-gap", "reused-id", "foreign-ticket", "foreign-repo", "foreign-route", "changed-base", "changed-branch", "changed-workflow", "missing-evidence", "missing-profile", "foreign-caller"] as const) {
  test(`subject revision rejects ${variant} with zero new snapshots/events`, async () => {
    const f = workflowRuntimeFixture(); try {
      let state = f.service.admit(f.selection, f.subject);
      if (variant !== "before-decision") {
        const capture = f.host.capture;
        f.host.capture = async r => ({ ...await capture(r), outcome: variant === "rejected" ? "rejected" : variant === "cancelled" ? "cancelled" : "changes-requested" });
        await f.service.decide(state.runId, 1, "approve"); state = f.service.status(state.runId);
      }
      const b = nextSubject(f);
      if (variant === "revision-gap") b.revision++;
      if (variant === "reused-id") b.subjectId = state.subject.subjectId;
      if (variant === "foreign-ticket") { b.ticket = "EX-2"; b.handoff.branch = "feature/EX-2-example"; }
      if (variant === "foreign-repo") b.repository.root = "/foreign/root";
      if (variant === "foreign-route") b.route.mode = "worker";
      if (variant === "changed-base") b.handoff.baseSha = "e".repeat(40);
      if (variant === "changed-branch") b.handoff.branch += "-other";
      if (variant === "changed-workflow") b.workflow.version = "r002";
      if (variant === "missing-evidence") f.evidence.delete(b.uat.ref);
      if (variant === "missing-profile") { const observe = f.host.observations; f.host.observations = () => ({ ...observe(), projectProfile: "missing" }); }
      if (variant === "foreign-caller") f.host.authenticate = () => ({ ...state.caller, deploymentId: "d-fedcba" });
      const counts = () => [f.db.prepare("SELECT count(*) AS n FROM workflow_events").get(), f.db.prepare("SELECT count(*) AS n FROM workflow_snapshots").get()];
      const before = counts();
      assert.throws(() => f.service.revise(state.runId, variant === "stale" ? state.revision - 1 : state.revision, bytes(b)), /WORKFLOW_/);
      assert.deepEqual(counts(), before); assert.equal(f.service.status(state.runId).attempts.length, 1);
    } finally { f.close(); }
  });
}

test("material revision cannot become fresh, change pinned semantics or forget an unknown in-flight intent", async () => {
  const f = workflowRuntimeFixture(); try {
    const run = f.service.admit(f.selection, f.subject), d = await f.service.decide(run.runId, 1, "approve");
    assert.throws(() => f.service.revise(run.runId, 2, bytes(nextSubject(f))), /WORKFLOW_AUTHORITY/);
    const owner = { admit: () => {}, observe: async () => ({ state: "unknown" as const }), execute: async () => { throw Error("must not execute"); }, verify: () => false };
    (f.host.owners as Map<string, typeof owner>).set("publication.pair", owner);
    await assert.rejects(f.service.requestStep(run.runId, 2, "publish", d.decisionId), /WORKFLOW_UNCERTAIN/);
    const pending = f.service.status(run.runId);
    assert.throws(() => f.service.revise(run.runId, pending.revision, bytes(nextSubject(f, true))), /WORKFLOW_CONFLICT/);
    assert.deepEqual(f.service.status(run.runId).pending, pending.pending); assert.equal(f.service.status(run.runId).attempts.length, 1);
  } finally { f.close(); }
});

test("amendment request-changes never restores fresh creation, and attempt bounds accept 255 predecessors but reject a 257th attempt", async () => {
  const f = workflowRuntimeFixture(); try {
    const run = await changesRequested(f), b = nextSubject(f, true);
    const revised = f.service.revise(run.runId, run.revision, bytes(b));
    const capture = f.host.capture; f.host.capture = async r => ({ ...await capture(r), outcome: "changes-requested" });
    await f.service.decide(run.runId, revised.revision, "approve");
    const state = f.service.status(run.runId), next = nextSubject(f);
    next.handoff = { type: "fresh", baseSha: next.handoff.baseSha, branch: next.handoff.branch, branchAction: "create" };
    assert.throws(() => f.service.revise(run.runId, state.revision, bytes(next)), /WORKFLOW_AUTHORITY/);
    const amendment = nextSubject(f, true);
    state.attempts = Array.from({ length: 255 }, (_, i) => ({ ...state.attempts[0]!, attemptId: `attempt-${i}`, subjectRef: `old-package-${i}` }));
    assert.equal(subjectRevisionReason(state, amendment), "changes-requested");
    state.attempts.push({ ...state.attempts[0]!, attemptId: "attempt-last", subjectRef: "old-package-last" });
    assert.throws(() => subjectRevisionReason(state, amendment), /WORKFLOW_CONFLICT/);
  } finally { f.close(); }
});

for (const variant of ["wrong-parent-subject", "wrong-parent-attempt", "reused-attempt", "wrong-reason", "missing-snapshot"] as const) {
  test(`immutable replay rejects a malformed revision edge: ${variant}`, async () => {
    const f = workflowRuntimeFixture(); try {
      const run = await changesRequested(f), next = nextSubject(f), raw = bytes(next);
      const snapshots = variant === "missing-snapshot" ? [raw] : [raw, ...readWorkflowEvidence(next, ref => f.evidence.get(ref.ref) ?? null)];
      f.journal.append(run.runId, run.revision, () => ({ eventId: "event-malformed-revision", type: "subject-revised", data: {
        previousSubjectSha256: variant === "wrong-parent-subject" ? "f".repeat(64) : run.subjectSha256,
        previousAttemptId: variant === "wrong-parent-attempt" ? "attempt-foreign" : run.attempts[0]!.attemptId,
        attemptId: variant === "reused-attempt" ? run.attempts[0]!.attemptId : "attempt-next",
        subjectSha256: digest(raw), reason: variant === "wrong-reason" ? "material-amendment" : "changes-requested",
      } }), snapshots);
      assert.throws(() => f.service.status(run.runId), /WORKFLOW_/);
    } finally { f.close(); }
  });
}

test("32 actual SQLite connections accept exactly one linked subject revision, retaining one run and all history", { timeout: 120_000 }, async () => {
  const f = workflowRuntimeFixture(); try {
    const state = await changesRequested(f), b = nextSubject(f), barrier = new SharedArrayBuffer(4), signal = new Int32Array(barrier);
    const source = `const {parentPort,workerData:w}=require('node:worker_threads');
(async()=>{const {tsImport}=await import(w.tsx); const {getDb}=await tsImport(w.dbModule,w.dbModule);
const {RegistryWorkflowJournal}=await tsImport(w.journalModule,w.journalModule); const {JsonWorkflowService}=await tsImport(w.serviceModule,w.serviceModule);
const db=getDb(w.path), journal=new RegistryWorkflowJournal(db); const evidence=new Map(w.evidence.map(([k,v])=>[k,Buffer.from(v)]));
const service=new JsonWorkflowService(journal,{authenticate:()=>w.caller,observations:()=>({capabilities:new Set(w.capabilities),projectProfile:'supported',producerContract:'supported',readEvidence:r=>evidence.get(r.ref)||null}),owners:new Map(),capture:()=>{throw Error('no capture');},now:()=>''});
parentPort.postMessage('ready'); Atomics.wait(new Int32Array(w.barrier),0,0);
try{service.revise(w.runId,w.revision,Buffer.from(w.subject));parentPort.postMessage('accepted');}
catch(e){parentPort.postMessage(e.code==='WORKFLOW_CONFLICT'?'conflict':'unexpected');} finally{db.close();}
})().catch(e=>{throw e;});`;
    const workers = Array.from({ length: 32 }, () => new Worker(source, { eval: true, workerData: { barrier, path: join(f.root, "registry.db"), tsx: import.meta.resolve("tsx/esm/api"), dbModule: new URL("../registry/db.ts", import.meta.url).href, journalModule: new URL("../registry/workflows.ts", import.meta.url).href, serviceModule: new URL("../workflows/service.ts", import.meta.url).href,
      caller: state.caller, capabilities: state.definition.requiredCapabilities, evidence: [...f.evidence].map(([k, v]) => [k, [...v]]), subject: [...bytes(b)], runId: state.runId, revision: state.revision } }));
    let ready = 0;
    const results = await Promise.all(workers.map(worker => new Promise<string>((resolve, reject) => { worker.on("error", reject); worker.on("message", m => { if (m === "ready") { if (++ready === workers.length) { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0, workers.length); } } else resolve(String(m)); }); })));
    await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => { if (worker.threadId === -1) resolve(); else { worker.once("exit", code => code === 0 ? resolve() : reject(Error("worker failed"))); worker.once("error", reject); } })));
    assert.equal(results.filter(r => r === "accepted").length, 1); assert.equal(results.filter(r => r === "conflict").length, 31);
    assert.equal(f.service.status(state.runId).attempts.length, 2); assert.equal(f.journal.runs(b.repository.key, b.ticket).length, 1);
  } finally { f.close(); }
});
