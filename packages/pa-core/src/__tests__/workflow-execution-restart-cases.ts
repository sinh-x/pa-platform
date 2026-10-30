import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExecutionCustodyService, parseExecutionBinding, parseExecutionPlan, readExecutionState, readExecutionOperations,
  type ExecutionCommand, type ExecutionHolder, type ExecutionHost,
} from "../deploy/execution-custody.js";
import { ProtectedWorkflowStore, workflowDigest, type SourceVersion } from "../deploy/prepared-workflow.js";
import { repositoryGitSnapshotDigest } from "../deploy/repository-admission.js";

// The registry/process/capacity authentication below is a synthetic trusted host,
// not a native Pi restart or a production custody-transfer implementation.
const time = "2026-10-17T00:00:00.000Z", sha = "a".repeat(40);
const holders: readonly ExecutionHolder[] = [1, 2, 3, 4, 5].map(n => ({ deploymentId: `d-${String(n).repeat(6)}`,
  process: { pid: 100 + n, startTimeTicks: String(1000 + n), bootId: "fixture-boot" } }));
const ref = (name: string): SourceVersion => ({ ref: `fixture:${name}`, version: "v1", sha256: workflowDigest(name) });
const binding = () => parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: "b".repeat(64), lineageId: "retained-lineage",
  repoKey: "fixture", repoRoot: "/fixture/repo", worktreeRoot: "/fixture/linked", ticket: "PAP-271", branch: "feature/PAP-271-fixture",
  initialHeadSha: sha, owner: holders[0], bounds: { startedAt: time, deadlineAt: "2026-10-17T02:00:00.000Z", runtimeMinutes: 120,
    consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null } });
const plan = () => parseExecutionPlan({ phaseId: "source", scope: "retained scope", paths: ["src/file.ts"], requirements: ["AC-15"],
  prerequisites: [], checks: ["check"], size: "bounded", complexity: "restart", rationale: "Keep the original execution lineage." });
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap271-restart-"));
  try { run(setup(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  const store = new ProtectedWorkflowStore(root), contract = binding();
  let repo = false, worktree = false, now = time, allowed = true, evidenceValid = true, oldDead = true, oldTerminal = true, custodyRetained = true;
  const calls: string[] = [];
  const host: ExecutionHost = {
    locks: { repository: run => { assert.equal(repo, false); repo = true; try { return run(); } finally { repo = false; } },
      worktree: run => { assert.equal(repo, true); assert.equal(worktree, false); worktree = true; try { return run(); } finally { worktree = false; } } },
    authorize(_binding, _actor, command) { assert.ok(repo && worktree); calls.push(typeof command === "string" ? command : command.action); if (!allowed) throw new Error("denied"); },
    assertLive(actor) { assert.ok(repo && worktree); if (!holders.some(h => JSON.stringify(h) === JSON.stringify(actor))) throw new Error("foreign live actor"); },
    verifyEvidence(evidence) { if (!evidenceValid || evidence.ref === "fixture:forged") throw new Error("unproven evidence"); },
    assertHandover() {},
    assertRestart(state, actor, evidence) { assert.ok(repo && worktree); calls.push("native-restart");
      assert.deepEqual(state.binding, contract); assert.notDeepEqual(actor, state.activeOwner); assert.deepEqual(evidence, ref("native-resume"));
      if (!oldDead || !oldTerminal || !custodyRetained) throw new Error("retained owner cannot authenticate handoff"); },
    now: () => now,
  };
  const service = new ExecutionCustodyService(store, contract, host); service.initialize(holders[0]!);
  const status = () => readExecutionState(store, contract);
  const apply = (command: ExecutionCommand, actor = status().activeOwner) => service.apply(actor, command);
  const select = () => apply({ action: "select", executor: "orchestrator-direct", holder: status().activeOwner, handover: ref("holder") });
  const begin = (id: string) => apply({ action: "begin", operation: { id, kind: "check", check: "check", intent: null } });
  const finish = (id: string, fail = false) => apply({ action: "finish", operationId: id, evidence: ref(`result-${id}`), failure: fail
    ? { check: "check", command: "fixture-check", exitCode: 2, candidateSha: sha, output: ref("original-output") } : null });
  const settle = () => apply({ action: "settle", evidence: ref("settled"), inventory: { branch: contract.branch, headSha: sha,
    porcelainV2Base64: "", snapshotSha256: repositoryGitSnapshotDigest(contract.branch, sha, Buffer.alloc(0)), paths: [], evidence: ref("inventory") } });
  const restart = (actor = holders[1]!, expected = status().sequence) => service.restart(actor, expected, ref("native-resume"));
  const files = () => store.records().map(name => [name, readFileSync(join(root, name), "utf8")]);
  return { root, store, contract, service, host, status, apply, select, begin, finish, settle, restart, files, calls,
    plan: () => apply({ action: "plan", plan: plan() }), setNow: (value: string) => { now = value; },
    deny: () => { allowed = false; }, badEvidence: () => { evidenceValid = false; },
    oldLive: () => { oldDead = false; }, nonterminal: () => { oldTerminal = false; }, lostCustody: () => { custodyRetained = false; } };
}

test("PAP-271 journal restart preserves immutable launch, plan, passes, candidate, used IDs and direct exclusion without idle gap", () => fixture(f => {
  f.plan(); f.select(); f.begin("passed-before"); f.finish("passed-before");
  const before = f.status(), files = f.files(), stages: string[] = [];
  f.host.projectCustody = (next, command, stage) => { assert.equal(command.action, "restart");
    assert.equal(next.custody.state, "orchestrator-direct"); assert.deepEqual(next.custody.holder, holders[1]);
    stages.push(`${stage}:${f.store.records().includes(`${f.service.executionId}.transaction-${next.sequence}.json`)}`); };
  const next = f.restart();
  assert.deepEqual(next, { ...before, sequence: before.sequence + 1, activeOwner: holders[1], retiredOwners: [holders[0]],
    bounds: { ...before.bounds, replacementsUsed: 1 }, custody: { ...before.custody, holder: holders[1] } });
  assert.deepEqual(f.files().filter(([name]) => files.some(([old]) => old === name)), files);
  assert.deepEqual(stages, ["before:false", "after:true"]);
  assert.deepEqual(new ExecutionCustodyService(f.store, f.contract, f.host).initialize(holders[1]!), next);
  assert.throws(() => f.service.initialize(holders[0]!));
  assert.throws(() => f.begin("passed-before"));
  // Disable the test projection, then show the actual successor can work.
  delete f.host.projectCustody;
  f.begin("successor-check"); f.finish("successor-check"); f.settle();
  assert.throws(() => f.apply({ action: "plan", plan: plan() }, holders[0]!));
}));

test("PAP-271 restart retains original failure, recovery/no-progress, diagnostics and independent review counters", () => fixture(f => {
  f.plan(); f.select(); f.begin("failed"); f.finish("failed", true); f.settle();
  const recovery = { originalFailure: ref("original-output"), diagnostic: ref("diagnosis"), remedy: ref("remedy"), rationale: "Native proven remedy.",
    recheck: { check: "check", command: "fixture-check", exitCode: 2, candidateSha: sha, output: ref("second-failure") } };
  f.apply({ action: "attempt", recovery }); f.apply({ action: "attempt", recovery });
  const before = f.status(), next = f.restart();
  assert.deepEqual(next.originalFailure, before.originalFailure); assert.deepEqual(next.bounds, { ...before.bounds, replacementsUsed: 1 });
  assert.equal(next.bounds.consecutiveNoProgress, 1); assert.equal(next.bounds.unresolvedFailureRef, "fixture:original-output");
  assert.deepEqual(next.diagnosticDigests, before.diagnosticDigests); assert.deepEqual(next.remedyDigests, before.remedyDigests);
  assert.throws(() => f.apply({ action: "resolve", evidence: ref("invented-pass") }));
  f.select(); f.begin("repair"); f.finish("repair"); f.settle(); f.apply({ action: "resolve", evidence: ref("result-repair") });
  assert.equal(f.status().originalFailure, null);
  assert.ok(f.files().some(([, text]) => text!.includes("original-output")));
}));

test("PAP-271 restart retains a consumed review and shares the existing replacement budget", () => fixture(f => {
  f.plan(); f.select(); f.begin("passed"); f.finish("passed"); f.settle();
  f.apply({ action: "select", executor: "review-reserved", holder: holders[2]!, handover: ref("review") }); f.settle();
  f.apply({ action: "select", executor: "implement-child", holder: holders[2]!, handover: ref("child") }); f.settle();
  f.apply({ action: "select", executor: "implement-child", holder: holders[2]!, handover: ref("replacement-child") }); f.settle();
  const before = f.status(); assert.equal(before.bounds.reviewsUsed, 1); assert.equal(before.bounds.replacementsUsed, 1);
  const next = f.restart(); assert.deepEqual(next.bounds, { ...before.bounds, replacementsUsed: 2 });
  assert.deepEqual(next.usedOperationIds, before.usedOperationIds); assert.deepEqual(next.passedChecks, before.passedChecks);
}));

test("PAP-271 restart cannot rewrite owner/bounds/checkout by substituting the binding", () => fixture(f => {
  f.restart(); const files = f.files();
  for (const patch of [{ owner: holders[1] }, { worktreeRoot: "/fixture/foreign" }, { initialHeadSha: "c".repeat(40) },
    { bounds: { ...f.contract.bounds, replacementsUsed: 0, startedAt: "2026-10-17T01:00:00.000Z", deadlineAt: "2026-10-17T03:00:00.000Z" } }]) {
    const changed = new ExecutionCustodyService(f.store, { ...f.contract, ...patch }, f.host);
    assert.equal(changed.executionId, f.service.executionId);
    assert.throws(() => changed.initialize(holders[1]!)); assert.throws(() => changed.restart(holders[2]!, 1, ref("native-resume")));
  }
  assert.deepEqual(f.files(), files);
}));

test("PAP-271 unknown operation remains exact, cannot be finished by retired/successor caller or cleared by another restart", () => fixture(f => {
  f.plan(); f.select(); f.begin("unknown-start");
  const before = f.status(), next = f.restart();
  assert.deepEqual(next.operation, before.operation); assert.deepEqual(next.custody, before.custody);
  assert.deepEqual(next.usedOperationIds, before.usedOperationIds);
  for (const actor of holders.slice(0, 2)) {
    assert.throws(() => f.apply({ action: "finish", operationId: "unknown-start", evidence: ref("forged"), failure: null }, actor));
    assert.throws(() => f.apply({ action: "plan", plan: plan() }, actor));
  }
  assert.throws(() => f.settle()); assert.throws(() => f.begin("retry")); assert.throws(() => f.restart(holders[2]!));
  assert.deepEqual(f.status(), next);
}));

for (const gate of ["deny", "badEvidence", "oldLive", "nonterminal", "lostCustody"] as const) {
  test(`PAP-271 restart requires trusted locked ${gate} proof and rejection writes nothing`, () => fixture(f => {
    f.plan(); f.select(); const before = f.status(), files = f.files(); f[gate]();
    assert.throws(() => f.restart()); assert.deepEqual(f.status(), before); assert.deepEqual(f.files(), files);
  }));
}

test("PAP-271 restart is unavailable without native port; public apply and arbitrary fields cannot import it", () => fixture(f => {
  const files = f.files(); delete f.host.assertRestart;
  assert.throws(() => f.restart());
  assert.throws(() => f.apply({ action: "restart", previousOwner: holders[0]!, evidence: ref("native-resume") }, holders[1]!));
  assert.throws(() => f.service.restart(holders[1]!, 0, { ...ref("native-resume"), passed: true } as SourceVersion));
  assert.deepEqual(f.files(), files);
}));

test("PAP-271 restart revision CAS rejects overlapping successors and reused/PID-recycled identities", () => fixture(f => {
  const before = f.status(), first = f.restart();
  const second = new ExecutionCustodyService(f.store, f.contract, f.host);
  assert.throws(() => second.restart(holders[2]!, before.sequence, ref("native-resume")));
  assert.throws(() => f.restart(holders[0]!)); assert.throws(() => f.restart(holders[1]!));
  assert.throws(() => f.restart({ ...holders[2]!, process: holders[0]!.process }));
  assert.deepEqual(f.status(), first);
  for (const invalid of [-1, NaN, 1.5, Infinity]) assert.throws(() => f.restart(holders[2]!, invalid));
  assert.deepEqual(f.status(), first);
}));

test("PAP-271 native authentication callbacks cannot supply Boolean/Promise authority or mutate frozen previous state", () => {
  for (const callback of [(() => true), (async () => undefined), ((state: object) => { Object.assign(state, { candidateSha: "f".repeat(40) }); })]) fixture(f => {
    f.host.assertRestart = callback as ExecutionHost["assertRestart"];
    const before = f.status(), files = f.files(); assert.throws(() => f.restart());
    assert.deepEqual(f.status(), before); assert.deepEqual(f.files(), files);
  });
});

test("PAP-271 deadline, no-progress and replacement limits cannot be reset by journal restart", () => {
  fixture(f => { f.setNow("2026-10-17T02:00:00.000Z"); assert.throws(() => f.restart()); assert.equal(f.status().sequence, 0); });
  fixture(f => {
    for (const actor of holders.slice(1, 4)) f.restart(actor);
    const before = f.status(); assert.equal(before.bounds.replacementsUsed, 3); assert.throws(() => f.restart(holders[4]!));
    assert.deepEqual(f.status(), before); assert.deepEqual(before.binding, f.contract);
  });
  fixture(f => {
    f.plan(); f.select(); f.begin("failed"); f.finish("failed", true); f.settle();
    for (let i = 0; i < 3; i++) f.apply({ action: "attempt", recovery: { originalFailure: ref("original-output"), diagnostic: null, remedy: null, rationale: null,
      recheck: { check: "check", command: "fixture-check", exitCode: 2, candidateSha: sha, output: ref(`failure-${i}`) } } });
    const before = f.status(); assert.throws(() => f.restart()); assert.deepEqual(f.status(), before);
  });
});

test("PAP-271 delegated/review holders are not implicitly adopted by coordinator restart", () => {
  for (const executor of ["implement-child", "review-reserved"] as const) fixture(f => {
    f.plan();
    if (executor === "review-reserved") { f.select(); f.begin("check"); f.finish("check"); f.settle(); }
    f.apply({ action: "select", executor, holder: holders[2]!, handover: ref("child") });
    const before = f.status(); assert.throws(() => f.restart()); assert.deepEqual(f.status(), before);
  });
});

test("PAP-271 durable restart intent precedes resource projection and blocks all ordinary work until exact settlement", () => fixture(f => {
  f.plan(); f.select(); const before = f.status(), files = f.files(); let projections = 0;
  f.host.projectCustody = () => { projections++; };
  const pending = f.service.prepareRestart(holders[1]!, before.sequence, ref("native-resume"));
  assert.equal(projections, 0); assert.deepEqual(pending.custody, before.custody); assert.deepEqual(pending.bounds, before.bounds);
  assert.deepEqual(pending.activeOwner, before.activeOwner); assert.equal(pending.pendingRestart?.sequence, pending.sequence);
  assert.deepEqual(f.files().filter(([name]) => files.some(([old]) => old === name)), files);
  const records = f.files();
  assert.deepEqual(f.service.prepareRestart(holders[1]!, before.sequence, ref("native-resume")), pending);
  assert.deepEqual(f.files(), records);
  for (const actor of holders.slice(0, 2)) {
    assert.throws(() => f.apply({ action: "plan", plan: plan() }, actor));
    assert.throws(() => f.apply({ action: "select", executor: "orchestrator-direct", holder: actor!, handover: ref("holder") }, actor));
    assert.throws(() => f.apply({ action: "begin", operation: { id: "bypass", kind: "check", check: "check", intent: null } }, actor));
    assert.throws(() => f.apply({ action: "restart-intent", previousOwner: holders[0]!, evidence: ref("native-resume") }, actor));
  }
  assert.throws(() => f.service.prepareRestart(holders[2]!, before.sequence, ref("native-resume")));
  assert.throws(() => f.service.prepareRestart(holders[1]!, before.sequence, ref("changed-evidence")));
  assert.throws(() => f.restart(holders[2]!));
  const successor = new ExecutionCustodyService(f.store, f.contract, f.host);
  const settled = successor.restart(holders[1]!, pending.sequence, ref("native-resume"));
  assert.equal(settled.pendingRestart, null); assert.equal(settled.bounds.replacementsUsed, 1); assert.equal(projections, 2);
  assert.equal(settled.sequence, before.sequence + 2); assert.deepEqual(settled.binding, before.binding);
}));

for (const fault of ["before", "after"] as const) test(`PAP-271 ${fault}-publication interruption retains the durable handoff or exact successor, never rolls it back`, () => fixture(f => {
  f.plan(); f.select(); const before = f.status();
  const pending = f.service.prepareRestart(holders[1]!, before.sequence, ref("native-resume"));
  f.host.projectCustody = (_next, command, stage) => { assert.equal(command.action, "restart");
    assert.equal(f.status().pendingRestart !== null, stage === "before");
    if (stage === fault) throw new Error("injected resource boundary"); };
  assert.throws(() => f.restart());
  const observed = readExecutionState(f.store, f.contract);
  if (fault === "before") {
    assert.deepEqual(observed, pending); delete f.host.projectCustody;
    const complete = f.restart(); assert.equal(complete.pendingRestart, null); assert.equal(complete.bounds.replacementsUsed, 1);
  } else {
    assert.equal(observed.pendingRestart, null); assert.deepEqual(observed.activeOwner, holders[1]);
    assert.equal(observed.bounds.replacementsUsed, 1); assert.throws(() => f.service.restart(holders[1]!, pending.sequence, ref("native-resume")));
    assert.deepEqual(f.status(), observed);
  }
}));

test("PAP-271 persisted handoff can settle after deadline without renewing runtime or authorizing new work", () => fixture(f => {
  f.plan(); const before = f.status(); f.service.prepareRestart(holders[1]!, before.sequence, ref("native-resume"));
  f.setNow("2026-10-17T02:01:00.000Z"); const settled = f.restart();
  assert.deepEqual(settled.bounds, { ...before.bounds, replacementsUsed: 1 });
  assert.throws(() => f.select()); assert.throws(() => f.plan());
}));

test("PAP-271 preparing handoff around an unknown operation retains both barriers across owner recreation", () => fixture(f => {
  f.plan(); f.select(); f.begin("unknown"); const before = f.status();
  const pending = f.service.prepareRestart(holders[1]!, before.sequence, ref("native-resume"));
  assert.deepEqual(pending.operation, before.operation); assert.deepEqual(pending.custody, before.custody);
  const successor = new ExecutionCustodyService(f.store, f.contract, f.host);
  const settled = successor.restart(holders[1]!, pending.sequence, ref("native-resume"));
  assert.deepEqual(settled.operation, before.operation); assert.deepEqual(settled.custody, before.custody);
  for (const actor of holders.slice(0, 2)) assert.throws(() => successor.apply(actor!, {
    action: "finish", operationId: "unknown", evidence: ref("forged"), failure: null }));
}));

test("PAP-271 operation replay retains each original actor and open intent without latest-holder substitution or writes", () => fixture(f => {
  f.plan(); f.select(); f.begin("old-operation"); f.finish("old-operation");
  const old = readExecutionOperations(f.store, f.contract)[0]!; assert.deepEqual(old.actor, holders[0]);
  f.restart(); f.begin("new-operation"); f.finish("new-operation"); f.begin("still-unknown");
  const files = f.files(), calls = [...f.calls], operations = readExecutionOperations(f.store, f.contract);
  assert.deepEqual(operations[0], old); assert.deepEqual(operations[1]!.actor, holders[1]);
  assert.equal(operations[2]!.finish, null); assert.equal(operations[2]!.operation.id, "still-unknown");
  assert.ok(operations[0]!.finish!.sequence < operations[1]!.beginSequence);
  assert.throws(() => Object.assign(operations[0]!.actor.process, holders[1]!.process));
  assert.throws(() => Object.assign(operations[0]!.operation, { id: "rewritten" }));
  assert.deepEqual(f.files(), files); assert.deepEqual(f.calls, calls);
}));

test("PAP-271 restart replays in a separate process without replacement descriptor or mutation of historical bytes", () => fixture(f => {
  f.plan(); f.select(); f.begin("unknown"); const next = f.restart(), files = f.files();
  const script = join(f.root, "read.mts");
  writeFileSync(script, `import { ProtectedWorkflowStore } from ${JSON.stringify(new URL("../deploy/prepared-workflow.ts", import.meta.url).href)};
import { readExecutionState } from ${JSON.stringify(new URL("../deploy/execution-custody.ts", import.meta.url).href)};
console.log(JSON.stringify(readExecutionState(new ProtectedWorkflowStore(${JSON.stringify(f.root)}), ${JSON.stringify(f.contract)})));\n`);
  const output = execFileSync(process.execPath, ["--import", "tsx", script], { cwd: process.cwd(), encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), next); assert.deepEqual(f.files(), files);
}));
