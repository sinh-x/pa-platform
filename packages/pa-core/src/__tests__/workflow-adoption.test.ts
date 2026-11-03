import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";
import { adoptedWorkflow, assertWorkflowMarkerReferences } from "../workflows/catalog.js";
import { workflowReadService } from "../workflows/public.js";
import { workflowCoordinator } from "../workflows/service.js";

async function fixture() {
  const f = workflowRuntimeFixture(), capture = f.host.capture;
  f.host.capture = async r => ({ ...await capture(r), outcome: "cancelled" });
  const run = f.service.admit(f.selection, f.subject), cancelled = await f.service.decide(run.runId, 1, "approve");
  const current = { ...run.caller, deploymentId: "d-fedcba", identitySha256: "b".repeat(64) };
  f.host.authenticate = () => current; f.host.capture = capture; f.host.assertInactive = () => {};
  return { ...f, run, cancelled, current, capture };
}

test("fresh coordinator adoption preserves original caller, resources, decisions, attempts and journal prefix; package recovery remains separate", async () => {
  const f = await fixture(); try {
    const before = f.journal.read(f.run.runId);
    await assert.rejects(f.service.recoverCancelled(f.run.runId, 2, f.cancelled.decisionId, f.run.subjectSha256), /WORKFLOW_AUTHORITY/);
    let proofs = 0; f.host.assertInactive = owner => { proofs++; assert.deepEqual(owner, f.run.caller); };
    f.host.capture = async r => { assert.equal(r.action, "adopt"); assert.deepEqual(r.succession, { previous: f.run.caller, current: f.current, purpose: "cancelled-review" }); return f.capture(r); };
    const adopted = await f.service.adoptCoordinator(f.run.runId, 2, f.run.subjectSha256);
    assert.ok(proofs >= 3); assert.deepEqual(adopted.caller, f.run.caller); assert.deepEqual(workflowCoordinator(adopted), f.current);
    assert.deepEqual(adopted.resources, f.run.resources); assert.equal(adopted.subjectSha256, f.run.subjectSha256);
    assert.deepEqual(adopted.decisions, [f.cancelled]); assert.equal(adopted.attempts.length, 1);
    assert.deepEqual(f.journal.read(f.run.runId).slice(0, before.length), before);
    assert.equal(adopted.outcomes.approve, "cancelled"); assert.equal(adopted.pending.length, 0);
    f.host.capture = f.capture;
    const recovered = await f.service.recoverCancelled(f.run.runId, 3, f.cancelled.decisionId, f.run.subjectSha256);
    assert.equal(recovered.outcome, "approved"); assert.equal(f.service.status(f.run.runId).decisions.length, 2);
    f.host.authenticate = () => f.run.caller;
    await assert.rejects(f.service.revoke(f.run.runId, 4, recovered.decisionId), /WORKFLOW_AUTHORITY/);
    assert.equal(f.journal.runs(f.run.caller.repoKey, f.run.caller.ticket).length, 1);
  } finally { f.close(); }
});

for (const variant of ["cancel", "no-proof", "live", "liveness-drift", "caller-drift", "evidence-drift", "evidence", "stale", "subject", "role", "repo", "ticket", "same-deployment", "revoked"] as const) {
  test(`fresh adoption rejects or cancels ${variant} without issuing coordinator/package authority`, async () => {
    const f = await fixture(); try {
      if (variant === "no-proof") delete f.host.assertInactive;
      if (variant === "live") f.host.assertInactive = () => { throw Error("live-owner"); };
      if (variant === "evidence") f.evidence.clear();
      if (variant === "role") f.current.team = "rogue-one";
      if (variant === "repo") f.current.repoRoot = "/foreign";
      if (variant === "ticket") f.current.ticket = "EX-2";
      if (variant === "same-deployment") f.current.deploymentId = f.run.caller.deploymentId;
      if (variant === "revoked") {
        f.host.authenticate = () => f.run.caller; await f.service.revoke(f.run.runId, 2, f.cancelled.decisionId); f.host.authenticate = () => f.current;
      }
      f.host.capture = async r => {
        if (variant === "liveness-drift") f.host.assertInactive = () => { throw Error("live-owner"); };
        if (variant === "caller-drift") f.host.authenticate = () => ({ ...f.current, identitySha256: "c".repeat(64) });
        if (variant === "evidence-drift") f.evidence.clear();
        return { ...await f.capture(r), ...(variant === "cancel" ? { outcome: "cancelled" as const } : {}) };
      };
      const before = f.journal.read(f.run.runId);
      const attempt = f.service.adoptCoordinator(f.run.runId, variant === "stale" ? 1 : before.length, variant === "subject" ? "f".repeat(64) : f.run.subjectSha256);
      if (variant === "cancel") await attempt; else await assert.rejects(attempt);
      assert.deepEqual(f.journal.read(f.run.runId), before); assert.deepEqual(workflowCoordinator(f.service.status(f.run.runId)), f.run.caller);
    } finally { f.close(); }
  });
}

test("overlapping fresh adoption has one CAS winner and stale explicit resume cannot recover", async () => {
  const f = await fixture(); try {
    const waiters: (() => void)[] = [];
    f.host.capture = async r => { await new Promise<void>(resolve => waiters.push(resolve)); return f.capture(r); };
    const first = f.service.adoptCoordinator(f.run.runId, 2, f.run.subjectSha256), second = f.service.adoptCoordinator(f.run.runId, 2, f.run.subjectSha256);
    assert.equal(waiters.length, 2); for (const resolve of waiters) resolve();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.service.status(f.run.runId).revision, 3);
    f.host.authenticate = () => ({ ...f.run.caller, deploymentId: "d-aabbcc" });
    f.host.continues = original => original.deploymentId === f.run.caller.deploymentId;
    await assert.rejects(f.service.recoverCancelled(f.run.runId, 3, f.cancelled.decisionId, f.run.subjectSha256), /WORKFLOW_AUTHORITY/);
    assert.equal(f.service.status(f.run.runId).decisions.length, 1);
  } finally { f.close(); }
});

test("read diagnostics distinguish structural adoption from caller rights and retain issued approval when artifacts are unavailable", async () => {
  const f = await fixture(); try {
    const status = workflowReadService(JSON.stringify({ action: "status", ticket: f.run.subject.ticket }), { state: () => f.service.status(f.run.runId) }) as any;
    assert.equal(status.ok, true); assert.equal(status.result.coordinatorContinuation.adoption.structurallyAvailable, true);
    assert.equal(status.result.coordinatorContinuation.caller.status, "uninspected"); assert.equal(status.result.packageReview.approved, false);
    await f.service.adoptCoordinator(f.run.runId, 2, f.run.subjectSha256);
    const decision = await f.service.recoverCancelled(f.run.runId, 3, f.cancelled.decisionId, f.run.subjectSha256);
    const unavailable = workflowReadService(JSON.stringify({ action: "decision-verify", ticket: f.run.subject.ticket, id: decision.decisionId }), { state: () => f.service.status(f.run.runId) }) as any;
    assert.equal(unavailable.ok, true); assert.equal(unavailable.result.issued, true); assert.equal(unavailable.result.approved, true);
    assert.equal(unavailable.result.revoked, false); assert.equal(unavailable.result.evidenceState, "unavailable"); assert.equal(unavailable.executionAdmitted, false);
    await f.service.revoke(f.run.runId, 4, decision.decisionId);
    const revoked = workflowReadService(JSON.stringify({ action: "decision-verify", ticket: f.run.subject.ticket, id: decision.decisionId }), { state: () => f.service.status(f.run.runId) }) as any;
    assert.equal(revoked.result.issued, true); assert.equal(revoked.result.revoked, true); assert.equal(revoked.result.approved, false);
    assert.equal(workflowReadService(JSON.stringify({ action: "decision-verify", ticket: f.run.subject.ticket, id: "decision-foreign" }), { state: () => f.service.status(f.run.runId) }).ok, false);
  } finally { f.close(); }
});

test("retained adoption discovery rejects foreign duplicate markers and ambiguous runs without a newest-run fallback", async () => {
  const f = await fixture(); try {
    assert.doesNotThrow(() => assertWorkflowMarkerReferences([], f.run.runId));
    assert.doesNotThrow(() => assertWorkflowMarkerReferences([{ type: "workflow", path: `registry-workflow:${f.run.runId}` }], f.run.runId));
    for (const refs of [[{ type: "workflow", path: "registry-workflow:foreign" }], [{ type: "workflow", path: `registry-workflow:${f.run.runId}` }, { type: "workflow", path: `registry-workflow:${f.run.runId}` }]]) assert.throws(() => assertWorkflowMarkerReferences(refs, f.run.runId), /WORKFLOW_CONFLICT/);
    assert.throws(() => assertWorkflowMarkerReferences([{ type: "workflow", path: `registry-workflow:${f.run.runId}` }], null), /WORKFLOW_UNCERTAIN/);
    assert.throws(() => assertWorkflowMarkerReferences({}, f.run.runId), /WORKFLOW_UNCERTAIN/);
    const event = f.journal.read(f.run.runId)[0]!.event;
    f.journal.append("wf-competing", 0, () => ({ type: "admitted", eventId: "event-competing", data: event.data }));
    assert.throws(() => adoptedWorkflow(f.journal, f.run.caller.repoKey, f.run.caller.ticket), /WORKFLOW_CONFLICT/);
    assert.deepEqual(f.service.status(f.run.runId).decisions, [f.cancelled]);
  } finally { f.close(); }
});

test("interrupted adoption has no reservation/grant before commit and a lost reply is discovered without another transfer", async () => {
  const f = await fixture(); try {
    const before = f.journal.read(f.run.runId);
    f.host.capture = async () => { throw Error("injected native response interruption"); };
    await assert.rejects(f.service.adoptCoordinator(f.run.runId, 2, f.run.subjectSha256), /interruption/);
    assert.deepEqual(f.journal.read(f.run.runId), before); assert.equal(f.service.status(f.run.runId).coordinator, undefined);
    f.host.capture = f.capture;
    // Native consent+CAS committed, but the transport did not deliver its reply.
    await assert.rejects((async () => { await f.service.adoptCoordinator(f.run.runId, 2, f.run.subjectSha256); throw Error("lost reply after commit"); })(), /lost reply/);
    assert.deepEqual(workflowCoordinator(f.service.status(f.run.runId)), f.current);
    await assert.rejects(f.service.adoptCoordinator(f.run.runId, 2, f.run.subjectSha256), /WORKFLOW_CONFLICT/);
    assert.equal(f.journal.read(f.run.runId).filter(e => e.event.type === "coordinator-adopted").length, 1);
    assert.equal(f.service.status(f.run.runId).decisions.length, 1); assert.deepEqual(f.journal.read(f.run.runId).slice(0, 2), before);
  } finally { f.close(); }
});

test("four actual processes racing fresh coordinator adoption commit one exact successor", { timeout: 90000 }, async () => {
  const f = await fixture(); const children: ReturnType<typeof spawn>[] = [];
  try {
    const source = `import {createInterface} from 'node:readline';
const w=JSON.parse(process.argv[1]);
const {getDb}=await import(w.dbModule),{RegistryWorkflowJournal}=await import(w.journalModule),{JsonWorkflowService}=await import(w.serviceModule);
const db=getDb(w.path),journal=new RegistryWorkflowJournal(db),evidence=new Map(w.evidence.map(([k,v])=>[k,Buffer.from(v)]));
const service=new JsonWorkflowService(journal,{authenticate:()=>w.current,assertInactive(){},observations:()=>({readEvidence:r=>evidence.get(r.ref)||null}),owners:new Map(),capture:async()=>({outcome:'approved',principal:'synthetic-process-consent',evidence:{schemaVersion:'pa-workflow-evidence-ref/v1',ref:'synthetic-adoption-'+w.current.deploymentId,version:'v1',sha256:'c'.repeat(64)}}),now:()=>''});
const input=createInterface({input:process.stdin});console.log('ready');
for await(const line of input){try{await service.adoptCoordinator(w.runId,2,w.subjectSha256);console.log('accepted');}catch(e){console.log(e.code==='WORKFLOW_CONFLICT'?'conflict':'unexpected');}break;}input.close();db.close();`;
    let ready = 0;
    const outcomes = await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<string>((resolve, reject) => {
      const data = { current: { ...f.current, deploymentId: `d-fedcb${index}` }, runId: f.run.runId, subjectSha256: f.run.subjectSha256, path: join(f.root, "registry.db"),
        dbModule: new URL("../registry/db.ts", import.meta.url).href, journalModule: new URL("../registry/workflows.ts", import.meta.url).href, serviceModule: new URL("../workflows/service.ts", import.meta.url).href,
        evidence: [...f.evidence].map(([key, value]) => [key, [...value]]) };
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, JSON.stringify(data)], { stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
      let output = "", errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
      child.stdout!.on("data", chunk => {
        output += chunk;
        if (output.includes("ready\n")) { output = output.replace("ready\n", ""); if (++ready === 4) for (const c of children) c.stdin!.end("\n"); }
      });
      child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(Error(`fixture child ${code}: ${errors}`)));
    })));
    assert.equal(outcomes.filter(value => value === "accepted").length, 1); assert.equal(outcomes.filter(value => value === "conflict").length, 3);
    const state = f.service.status(f.run.runId); assert.equal(state.revision, 3); assert.equal(state.decisions.length, 1);
    assert.deepEqual(state.caller, f.run.caller); assert.deepEqual(state.resources, f.run.resources); assert.equal(state.subjectSha256, f.run.subjectSha256);
  } finally { for (const child of children) { child.stdin?.end(); if (child.exitCode === null) child.kill(); } f.close(); }
});

test("adoption does not reset the sixteen-decision recovery bound", async () => {
  const f = await fixture(); try {
    f.host.authenticate = () => f.run.caller;
    f.host.capture = async r => ({ ...await f.capture(r), outcome: "cancelled" });
    let decision = f.cancelled;
    for (let index = 1; index < 16; index++) decision = await f.service.recoverCancelled(f.run.runId, index + 1, decision.decisionId, f.run.subjectSha256);
    f.host.authenticate = () => f.current;
    await assert.rejects(f.service.adoptCoordinator(f.run.runId, 17, f.run.subjectSha256), /WORKFLOW_CONFLICT/);
    assert.equal(f.service.status(f.run.runId).decisions.length, 16);
  } finally { f.close(); }
});
