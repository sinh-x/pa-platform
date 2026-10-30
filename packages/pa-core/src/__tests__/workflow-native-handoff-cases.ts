import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRegistryEvent, closeDb } from "../registry/index.js";
import { ExecutionCustodyService, parseExecutionBinding, parseExecutionPlan, readExecutionState, type ExecutionHost } from "../deploy/execution-custody.js";
import { authenticateNativeExecutionRestart } from "../deploy/execution-restart.js";
import { ProtectedWorkflowStore, workflowDigest } from "../deploy/prepared-workflow.js";
import { acquireRepositoryMutationLease, captureRepositoryGitSnapshot, readProcessFingerprint, repositoryMutationLeasePath,
  withExecutionWorktreeAdmission, repositoryGitSnapshotDigest, REPOSITORY_REVIEW_RESERVATION_FILE, type ExecutionWorktreeTransaction } from "../deploy/repository-admission.js";
import { acquireRepositoryTicketSlot, repositoryTicketSlotPath, withPreparedTicketCapacity, type PreparedTicketCapacityTransaction } from "../deploy/ticket-concurrency.js";
import { getDeployPaths } from "../deploy/paths.js";
import type { RegistryEvent } from "../types.js";

// Real disposable registry/process/Git/capacity/repository/journal owners.
// Initial core intent admission/capture remains a synthetic trusted host. These
// cases do NOT exercise a default Pi launcher, actual operator approval or UAT.
const previousId = "d-aabbcc", nextId = "d-ddeeff", ticket = "PAP-271";
const evidence = { ref: "fixture:native-restart", version: "v1", sha256: workflowDigest("native-restart") };
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => unknown | Promise<unknown>, variant = "normal") {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "pap271-native-handoff-"));
  closeDb();
  for (const key of Object.keys(process.env)) if (/^(PA_|GIT_)/.test(key) && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
  Object.assign(process.env, { PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), PA_PLATFORM_CONFIG: join(root, "config"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  let f: Awaited<ReturnType<typeof setup>> | undefined, spawned: ChildProcess | undefined;
  try { f = await setup(root, variant, child => { spawned = child; }); await run(f); }
  finally {
    if (spawned?.exitCode === null && spawned.signalCode === null) { const exited = once(spawned, "exit"); spawned.kill(); await exited; }
    closeDb(); process.env = env; rmSync(root, { recursive: true, force: true });
  }
}
async function setup(root: string, variant: string, onChild: (child: ChildProcess) => void) {
  const repo = join(root, "repo"), worktree = join(root, "linked"), config = join(root, "config");
  mkdirSync(repo); mkdirSync(config);
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "develop"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Fixture"]);
  git(["config", "commit.gpgsign", "false"]); git(["config", "core.hooksPath", "/dev/null"]);
  writeFileSync(join(repo, "file.txt"), "original\n"); git(["add", "file.txt"]); git(["commit", "-qm", "fixture"]);
  const branch = `feature/${ticket}-fixture`, head = git(["rev-parse", "HEAD"]);
  git(["worktree", "add", "-b", branch, worktree]);
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], worktree), common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree);
  writeFileSync(join(config, "config.yaml"), `repos:\n  fixture:\n    path: ${repo}\n    prefix: PAP\n`);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); onChild(child); await once(child, "spawn");
  const oldProcess = readProcessFingerprint(child.pid!)!, currentProcess = readProcessFingerprint(process.pid)!;
  assert.ok(oldProcess); assert.ok(currentProcess);
  const started = new Date().toISOString(), currentStarted = new Date(Date.parse(started) + 1_000).toISOString();
  const note = `ordinary-native-execution/v1:workflow:fixture:decision-fixture:${"a".repeat(64)}`;
  const origin: RegistryEvent = { deployment_id: previousId, event: "started", timestamp: started, runtime: "pi", binary: "ppa", team: "builder", mode: "orchestrator",
    builder_authority: "orchestrator", repo, repo_root: repo, worktree_root: worktree, ticket_id: ticket, branch_state: "materialized", branch_base_sha: head,
    branch_head_sha: head, treehouse_path: worktree, treehouse_lease_id: "fixture-lease", treehouse_lease_holder: "pa:fixture:PAP-271", ticket_slot_id: "pa:fixture:PAP-271", repository_permit: 1,
    effective_timeout_seconds: 7200, note };
  origin.repo = worktree;
  appendRegistryEvent(origin); appendRegistryEvent({ deployment_id: previousId, event: "pid", timestamp: started, team: "builder", pid: child.pid });
  const acquired = acquireRepositoryTicketSlot({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo, ticket, deploymentId: previousId,
    deploymentDirectory: getDeployPaths(previousId).deployDir, pid: child.pid, processFingerprint: oldProcess });
  assert.equal(acquired.status, "acquired"); if (acquired.status !== "acquired") throw new Error("fixture capacity");
  const leased = acquireRepositoryMutationLease({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo, worktreeRoot: worktree,
    expectedGitDir: gitDir, expectedGitCommonDir: common, deploymentId: previousId, deploymentDirectory: getDeployPaths(previousId).deployDir,
    runtime: "pi", team: "builder", mode: "orchestrator", ticket, pid: child.pid, processFingerprint: oldProcess,
    gitSnapshot: captureRepositoryGitSnapshot(worktree) });
  assert.equal(leased.status, "acquired"); if (leased.status !== "acquired") throw new Error("fixture owner");
  withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, cap => withExecutionWorktreeAdmission(repo, worktree, cap, wt => {
    wt.setDirectCustody({ deploymentId: previousId, ownershipToken: leased.lease.ownershipToken, custody: "idle" });
  }));
  const lease = JSON.parse(readFileSync(repositoryMutationLeasePath(worktree), "utf8")) as typeof leased.lease;
  const binding = parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: workflowDigest(JSON.stringify(["ordinary-native-execution/v1", previousId])), lineageId: previousId,
    repoKey: "fixture", repoRoot: repo, worktreeRoot: worktree, ticket, branch, initialHeadSha: head, owner: { deploymentId: previousId, process: oldProcess },
    bounds: { startedAt: started, deadlineAt: new Date(Date.parse(started) + 7200000).toISOString(), runtimeMinutes: 120,
      consecutiveNoProgress: 0, replacementsUsed: 0, reviewsUsed: 0, reviewCap: 3, unresolvedFailureRef: null } });
  mkdirSync(join(root, "protected"), { mode: 0o700 });
  const actor = { deploymentId: nextId, process: currentProcess }, store = new ProtectedWorkflowStore(join(root, "protected")), source = { store, binding };
  let capacity: PreparedTicketCapacityTransaction | null = null, worktreeOwner: ExecutionWorktreeTransaction | null = null;
  const host: ExecutionHost = { locks: {
    repository: run => withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, tx => { capacity = tx; try { return run(); } finally { capacity = null; } }),
    worktree: run => withExecutionWorktreeAdmission(repo, worktree, capacity!, tx => { worktreeOwner = tx; try { return run(); } finally { worktreeOwner = null; } }),
  }, authorize() {}, assertLive() {}, verifyEvidence() {}, assertHandover() {},
    assertRestart(state) { if (state.pendingRestart) authenticateNativeExecutionRestart(source); }, now: () => new Date().toISOString() };
  const service = new ExecutionCustodyService(store, binding, host); service.initialize(binding.owner);
  if (variant === "unknown-operation" || variant === "failed-check") {
    service.apply(binding.owner, { action: "plan", plan: parseExecutionPlan({ phaseId: "source", scope: "fixture", paths: ["file.txt"], requirements: ["AC-15"],
      prerequisites: [], checks: ["check"], size: "bounded", complexity: "restart", rationale: "Retain original failure." }) });
    service.apply(binding.owner, { action: "select", executor: "orchestrator-direct", holder: binding.owner, handover: evidence });
    service.apply(binding.owner, { action: "begin", operation: { id: "original-check", kind: "check", check: "check", intent: null } });
    if (variant === "failed-check") {
      service.apply(binding.owner, { action: "finish", operationId: "original-check", evidence, failure: { check: "check", command: "fixture-check", exitCode: 2, candidateSha: head, output: evidence } });
      service.apply(binding.owner, { action: "settle", evidence, inventory: { branch, headSha: head, porcelainV2Base64: "",
        snapshotSha256: repositoryGitSnapshotDigest(branch, head, Buffer.alloc(0)), paths: [], evidence } });
    }
  }
  const current: RegistryEvent = { ...origin, deployment_id: nextId, timestamp: currentStarted, resumed_from_deployment_id: variant === "foreign-resume" ? "d-ffffff" : previousId,
    note: variant === "changed-note" ? note.replace("decision-fixture", "decision-other") : note,
    effective_timeout_seconds: variant === "renewed-deadline" ? 7200 : 7100 };
  appendRegistryEvent(current); appendRegistryEvent({ deployment_id: nextId, event: "pid", timestamp: currentStarted, team: "builder", pid: variant === "foreign-pid" ? child.pid : process.pid });
  if (variant !== "live-predecessor") { const exited = once(child, "exit"); child.kill(); await exited; }
  if (variant !== "nonterminal") appendRegistryEvent({ deployment_id: previousId, event: "completed", timestamp: new Date().toISOString(), team: "builder", status: "partial", summary: "retained original failure" });
  if (variant === "terminal-successor") appendRegistryEvent({ deployment_id: nextId, event: "completed", timestamp: new Date().toISOString(), team: "builder", status: "failed" });
  const pending = service.prepareRestart(actor, readExecutionState(store, binding).sequence, evidence);
  const slotPath = repositoryTicketSlotPath(repo, ticket), ownerPath = repositoryMutationLeasePath(worktree);
  const snapshot = () => ({ slot: readFileSync(slotPath, "utf8"), owner: readFileSync(ownerPath, "utf8"), journal: store.records().map(n => [n, readFileSync(join(root, "protected", n), "utf8")]) });
  const handoff = () => withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, cap =>
    withExecutionWorktreeAdmission(repo, worktree, cap, wt => ({ owner: wt.handoffDirectOwner(lease, source), slot: cap.handoffExecution(acquired.slot, source, wt) })));
  return { root, repo, worktree, gitDir, common, child, oldProcess, actor, binding, source, service, host, pending, slot: acquired.slot, lease,
    snapshot, handoff, slotPath, ownerPath, current, origin, store, cap: () => capacity!, wt: () => worktreeOwner! };
}

test("PAP-271 real native owner handoff preserves token/permit/acquiredAt/launch snapshot, then reuses exact interrupted results", () => fixture(f => {
  const before = f.snapshot(), next = f.handoff();
  assert.deepEqual(next.slot, { ...f.slot, deploymentId: nextId, deploymentDirectory: getDeployPaths(nextId).deployDir, processFingerprint: f.actor.process });
  assert.deepEqual(next.owner, { ...f.lease, deploymentId: nextId, deploymentDirectory: getDeployPaths(nextId).deployDir, processFingerprint: f.actor.process });
  assert.equal(readExecutionState(f.store, f.binding).pendingRestart?.sequence, f.pending.sequence);
  const after = f.snapshot(), inodes = [statSync(f.slotPath).ino, statSync(f.ownerPath).ino];
  f.handoff(); assert.deepEqual(f.snapshot(), after); assert.deepEqual([statSync(f.slotPath).ino, statSync(f.ownerPath).ino], inodes);
  assert.deepEqual(after.journal, before.journal);
  const complete = f.service.restart(f.actor, f.pending.sequence, evidence);
  assert.equal(complete.pendingRestart, null); assert.equal(complete.bounds.replacementsUsed, 1); assert.deepEqual(complete.binding, f.binding);
  assert.throws(() => f.handoff()); assert.deepEqual(f.snapshot().slot, after.slot);
}));

for (const variant of ["live-predecessor", "nonterminal", "foreign-resume", "changed-note", "renewed-deadline", "foreign-pid", "terminal-successor", "unknown-operation"]) {
  test(`PAP-271 actual native ${variant} rejects without resource or journal mutation`, () => fixture(f => {
    const before = f.snapshot(); assert.throws(() => f.handoff()); assert.deepEqual(f.snapshot(), before);
  }, variant));
}

test("PAP-271 actual resource handoff preserves unresolved original failure and recovery barrier", () => fixture(f => {
  const before = readExecutionState(f.store, f.binding); assert.ok(before.originalFailure); assert.equal(before.recoveryPending, true);
  f.handoff(); const complete = f.service.restart(f.actor, f.pending.sequence, evidence);
  assert.deepEqual(complete.originalFailure, before.originalFailure); assert.equal(complete.recoveryPending, true);
  assert.deepEqual(complete.bounds, { ...before.bounds, replacementsUsed: 1 }); assert.deepEqual(complete.usedOperationIds, before.usedOperationIds);
}, "failed-check"));

test("PAP-271 resource interruption retains pending intent and capacity/exclusion, and exact retry never allocates", () => fixture(f => {
  withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: f.repo }, cap =>
    withExecutionWorktreeAdmission(f.repo, f.worktree, cap, wt => { wt.handoffDirectOwner(f.lease, f.source); }));
  assert.equal(JSON.parse(readFileSync(f.ownerPath, "utf8")).deploymentId, nextId);
  assert.equal(JSON.parse(readFileSync(f.slotPath, "utf8")).deploymentId, previousId);
  const next = f.handoff(); assert.equal(next.slot.repositoryPermit, f.slot.repositoryPermit); assert.equal(next.owner.ownershipToken, f.lease.ownershipToken);
  assert.equal(readExecutionState(f.store, f.binding).pendingRestart?.sequence, f.pending.sequence);
  assert.equal(acquireRepositoryTicketSlot({ canonicalRepoKey: "fixture", canonicalRepoRoot: f.repo, ticket, deploymentId: "d-ffffff", deploymentDirectory: join(f.root, "foreign") }).status, "rejected");
}));

test("PAP-271 capacity-publish fault is recovered only under same pending intent; no second permit or snapshot reset", () => fixture(f => {
  assert.throws(() => withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: f.repo, boundary(point) { if (point === "published") throw new Error("injected after capacity publication"); } }, cap =>
    withExecutionWorktreeAdmission(f.repo, f.worktree, cap, wt => { cap.handoffExecution(f.slot, f.source, wt); })));
  assert.equal(JSON.parse(readFileSync(f.slotPath, "utf8")).deploymentId, nextId);
  assert.equal(JSON.parse(readFileSync(f.ownerPath, "utf8")).deploymentId, previousId);
  f.handoff(); assert.equal(readExecutionState(f.store, f.binding).pendingRestart?.sequence, f.pending.sequence);
  assert.equal(f.service.restart(f.actor, f.pending.sequence, evidence).bounds.replacementsUsed, 1);
}));

test("PAP-271 changed physical snapshot or overlapping review custody is never adopted", () => fixture(f => {
  const before = f.snapshot(); writeFileSync(join(f.worktree, "file.txt"), "foreign\n");
  assert.throws(() => f.handoff()); assert.deepEqual(f.snapshot(), before);
  writeFileSync(join(f.worktree, "file.txt"), "original\n");
  const review = join(f.gitDir, REPOSITORY_REVIEW_RESERVATION_FILE); writeFileSync(review, "unknown");
  assert.throws(() => f.handoff()); assert.deepEqual(f.snapshot(), before);
}));

test("PAP-271 expired worktree capabilities, changed expected tokens and foreign source bindings cannot transfer", () => fixture(f => {
  const before = f.snapshot(); let retained: ExecutionWorktreeTransaction | undefined;
  withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: f.repo }, cap => withExecutionWorktreeAdmission(f.repo, f.worktree, cap, wt => { retained = wt; }));
  assert.throws(() => retained!.handoffDirectOwner(f.lease, f.source));
  withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: f.repo }, cap => {
    assert.throws(() => cap.handoffExecution(f.slot, f.source, retained!));
    withExecutionWorktreeAdmission(f.repo, f.worktree, cap, wt => {
      assert.throws(() => wt.handoffDirectOwner({ ...f.lease, ownershipToken: "foreign-token" }, f.source));
      assert.throws(() => cap.handoffExecution({ ...f.slot, slotToken: "foreign-token" }, f.source, wt));
      assert.throws(() => wt.handoffDirectOwner(f.lease, { ...f.source, binding: { ...f.binding, worktreeRoot: f.repo } }));
    });
  });
  assert.deepEqual(f.snapshot(), before);
}));

test("PAP-271 real multi-process owner/journal contention settles one handoff and retains one permit", () => fixture(async f => {
  const core = new URL("../deploy/", import.meta.url).href, script = join(f.root, "contender.mts");
  writeFileSync(script, `import { ExecutionCustodyService } from ${JSON.stringify(core + "execution-custody.ts")};
import { authenticateNativeExecutionRestart } from ${JSON.stringify(core + "execution-restart.ts")};
import { ProtectedWorkflowStore } from ${JSON.stringify(core + "prepared-workflow.ts")};
import { withPreparedTicketCapacity } from ${JSON.stringify(core + "ticket-concurrency.ts")};
import { withExecutionWorktreeAdmission } from ${JSON.stringify(core + "repository-admission.ts")};
const binding=${JSON.stringify(f.binding)}, actor=${JSON.stringify(f.actor)}, evidence=${JSON.stringify(evidence)}, lease=${JSON.stringify(f.lease)}, slot=${JSON.stringify(f.slot)};
const store=new ProtectedWorkflowStore(${JSON.stringify(join(f.root, "protected"))}), source={store,binding}; let cap,wt;
const host={locks:{repository:run=>withPreparedTicketCapacity({canonicalRepoKey:'fixture',canonicalRepoRoot:binding.repoRoot},tx=>{cap=tx;return run()}),
worktree:run=>withExecutionWorktreeAdmission(binding.repoRoot,binding.worktreeRoot,cap,tx=>{wt=tx;return run()})},
authorize(){},assertLive(){},verifyEvidence(){},assertHandover(){},assertRestart(){authenticateNativeExecutionRestart(source)},now:()=>new Date().toISOString(),
projectCustody(state,command,stage){if(stage==='before'){wt.handoffDirectOwner(lease,source);cap.handoffExecution(slot,source,wt)}}};
try {new ExecutionCustodyService(store,binding,host).restart(actor,${f.pending.sequence},evidence);console.log('accepted')}catch{console.log('conflict')}
`);
  const results = await Promise.all(Array.from({ length: 32 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { error += data; });
    child.on("error", reject); child.on("close", code => code === 0 && !error ? resolve(output.trim()) : reject(new Error(error || `exit ${code}`)));
  })));
  assert.equal(results.filter(r => r === "accepted").length, 1); assert.equal(results.filter(r => r === "conflict").length, 31);
  const state = readExecutionState(f.store, f.binding); assert.equal(state.pendingRestart, null); assert.equal(state.bounds.replacementsUsed, 1);
  assert.equal(JSON.parse(readFileSync(f.slotPath, "utf8")).slotToken, f.slot.slotToken);
  assert.equal(JSON.parse(readFileSync(f.ownerPath, "utf8")).ownershipToken, f.lease.ownershipToken);
  withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: f.repo }, cap => assert.equal(cap.inventory().length, 1));
}));
