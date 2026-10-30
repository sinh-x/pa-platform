import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRepositoryMutationLease, acquireRepositoryTicketSlot, appendRegistryEvent, authenticateNativeExecutionRestart,
  captureRepositoryGitSnapshot, closeDb, ExecutionCustodyService, getDeployPaths, parseExecutionBinding, queryReadonlyDeploymentEvents,
  readExecutionState, readProcessFingerprint, repositoryMutationLeasePath, withExecutionWorktreeAdmission, withPreparedTicketCapacity,
  withPreparedWorkflowLocks, workflowDigest, type ExecutionHost, type ExecutionWorktreeTransaction, type PreparedTicketCapacityTransaction, type RegistryEvent } from "@pa-platform/pa-core";
import { createPiReadonlyHelperCapability } from "../deploy.js";
import { PiNativeExecutionAdapter, readOrdinaryNativeLineage } from "../execution-native.js";
import { PiPreparedNativeAuthority } from "../prepared-native.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { TreehouseClient } from "./treehouse-fixture.js";

// Real native resumed-session constructor/identity/descriptor/owner readers.
// Original journal admission, descriptor production and Treehouse/provider are
// fixtures. This is NOT default ppa --resume launch or real operator approval.
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pap271-bootstrap-")), env = { ...process.env }, cwd = process.cwd();
  let child: ChildProcess | undefined;
  closeDb();
  for (const key of Object.keys(process.env)) if (/^(PA_|GIT_)/.test(key) && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
  Object.assign(process.env, { PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), PA_PLATFORM_CONFIG: join(root, "config"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  try { await run(await setup(root, value => { child = value; })); }
  finally {
    if (child?.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill(); await ended; }
    process.chdir(cwd); closeDb(); process.env = env; rmSync(root, { recursive: true, force: true });
  }
}
async function setup(root: string, onChild: (child: ChildProcess) => void) {
  const repo = join(root, "repo"), worktree = join(root, "linked"), oldId = "d-aabbcc", id = "d-ddeeff", ticket = "PAP-271", branch = "feature/PAP-271-fixture";
  mkdirSync(repo); mkdirSync(join(root, "config")); mkdirSync(join(root, "tickets"));
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "develop"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]); git(["config", "core.hooksPath", "/dev/null"]);
  writeFileSync(join(repo, "file.txt"), "fixture\n"); git(["add", "file.txt"]); git(["commit", "-qm", "fixture"]);
  git(["worktree", "add", "-b", branch, worktree]); const head = git(["rev-parse", "HEAD"]);
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], worktree), common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree);
  writeFileSync(join(root, "config/config.yaml"), `repos:\n  fixture:\n    path: ${repo}\n    prefix: PAP\n`);
  writeFileSync(join(root, "tickets/PAP-271.json"), JSON.stringify({ id: ticket, project: "fixture", title: "Fixture", status: "implementing", priority: "high", type: "feature", assignee: "builder/team-manager", tags: [], blockedBy: [], doc_refs: [], comments: [],
    linkedBranches: [{ repo: "fixture", branch, state: "materialized", baseSha: head, headSha: head, sha: head }] }));
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); onChild(child); await once(child, "spawn");
  const oldProcess = readProcessFingerprint(child.pid!)!, currentProcess = readProcessFingerprint(process.pid)!;
  for (const deployId of [oldId, id]) mkdirSync(getDeployPaths(deployId).deployDir, { recursive: true, mode: 0o700 });
  assert.equal(recordPiProcessIdentity(oldId, getDeployPaths(oldId).deployDir, child.pid!), true);
  assert.equal(recordPiProcessIdentity(id, getDeployPaths(id).deployDir, process.pid), true);
  const started = new Date().toISOString(), currentStarted = new Date(Date.parse(started) + 1000).toISOString();
  const note = `ordinary-native-execution/v1:workflow:fixture:decision-fixture:${"a".repeat(64)}`;
  const origin: RegistryEvent = { deployment_id: oldId, event: "started", timestamp: started, team: "builder", mode: "orchestrator", runtime: "pi", binary: "ppa", builder_authority: "orchestrator",
    repo: worktree, repo_root: repo, worktree_root: worktree, ticket_id: ticket, treehouse_path: worktree, treehouse_lease_id: "fixture-lease", treehouse_lease_holder: "pa:fixture:PAP-271",
    branch_state: "materialized", branch_base_sha: head, branch_head_sha: head, ticket_slot_id: "pa:fixture:PAP-271", repository_permit: 1, effective_timeout_seconds: 7200, note };
  appendRegistryEvent(origin); appendRegistryEvent({ deployment_id: oldId, event: "pid", timestamp: started, team: "builder", pid: child.pid });
  const slot = acquireRepositoryTicketSlot({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo, ticket, deploymentId: oldId, deploymentDirectory: getDeployPaths(oldId).deployDir, pid: child.pid, processFingerprint: oldProcess });
  assert.equal(slot.status, "acquired"); if (slot.status !== "acquired") throw Error("slot");
  const acquired = acquireRepositoryMutationLease({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo, worktreeRoot: worktree, expectedGitDir: gitDir, expectedGitCommonDir: common,
    deploymentId: oldId, deploymentDirectory: getDeployPaths(oldId).deployDir, runtime: "pi", team: "builder", mode: "orchestrator", ticket, pid: child.pid, processFingerprint: oldProcess, gitSnapshot: captureRepositoryGitSnapshot(worktree) });
  assert.equal(acquired.status, "acquired"); if (acquired.status !== "acquired") throw Error("owner");
  withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, cap => withExecutionWorktreeAdmission(repo, worktree, cap, wt => wt.setDirectCustody({ deploymentId: oldId, ownershipToken: acquired.lease.ownershipToken, custody: "idle" })));
  const lease = JSON.parse(readFileSync(repositoryMutationLeasePath(worktree), "utf8")) as typeof acquired.lease;
  const authority = new PiPreparedNativeAuthority({ root: join(root, "native"), aiUsageRoot: root, runtime: () => ({ sourceSha: "a".repeat(40), configSha: "b".repeat(40), packageVersion: "fixture", storeRoot: "/fixture/runtime" }) });
  const store = authority.execution(true)!;
  const binding = parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: workflowDigest(JSON.stringify(["ordinary-native-execution/v1", oldId])), lineageId: oldId,
    repoKey: "fixture", repoRoot: repo, worktreeRoot: worktree, ticket, branch, initialHeadSha: head, owner: { deploymentId: oldId, process: oldProcess },
    bounds: { startedAt: started, deadlineAt: new Date(Date.parse(started) + 7200000).toISOString(), runtimeMinutes: 120, consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null } });
  const actor = { deploymentId: id, process: currentProcess }, evidence = { ref: "fixture:restart", version: "v1", sha256: workflowDigest("restart") }, source = { store, binding };
  let cap: PreparedTicketCapacityTransaction | null = null, wt: ExecutionWorktreeTransaction | null = null;
  const host: ExecutionHost = { locks: { repository: run => withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, tx => { cap = tx; try { return run(); } finally { cap = null; } }),
    worktree: run => withExecutionWorktreeAdmission(repo, worktree, cap!, tx => { wt = tx; try { return run(); } finally { wt = null; } }) },
    authorize() {}, assertLive() {}, verifyEvidence() {}, assertHandover() {}, now: () => new Date().toISOString(),
    assertRestart(state) { if (state.pendingRestart) authenticateNativeExecutionRestart(source); },
    projectCustody(_state, command, stage) { if (command.action === "restart" && stage === "before") { wt!.handoffDirectOwner(lease, source); cap!.handoffExecution(slot.slot, source, wt!); } } };
  const service = new ExecutionCustodyService(store, binding, host); service.initialize(binding.owner);
  const current: RegistryEvent = { ...origin, deployment_id: id, timestamp: currentStarted, resumed_from_deployment_id: oldId, effective_timeout_seconds: 7100 };
  appendRegistryEvent(current); appendRegistryEvent({ deployment_id: id, event: "pid", timestamp: currentStarted, team: "builder", pid: process.pid });
  const ended = once(child, "exit"); child.kill(); await ended;
  appendRegistryEvent({ deployment_id: oldId, event: "completed", timestamp: new Date().toISOString(), team: "builder", status: "partial", summary: "retained owner" });
  service.prepareRestart(actor, 0, evidence); service.restart(actor, 1, evidence);
  Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: getDeployPaths(id).deployDir, PA_TEAM: "builder", PA_MODE: "orchestrator", PA_TICKET_ID: ticket, PA_REPO: worktree, PA_WORKTREE_ROOT: worktree }); process.chdir(worktree);
  const treehouse = new TreehouseClient({ run: args => {
    if (args[0] !== "status") throw Error("no checkout lifecycle effect");
    return { status: 0, stdout: Buffer.from(JSON.stringify([{ name: "1", path: worktree, status: "leased", branch, detached: false, flavor: "git", lease_id: "fixture-lease", lease_holder: "pa:fixture:PAP-271", leased_at: started, processes: [] }])), stderr: Buffer.alloc(0) };
  } });
  const physical = createPiReadonlyHelperCapability({ treehouse }).authenticate(worktree).context;
  const original = queryReadonlyDeploymentEvents(oldId).find(event => event.event === "started")!, currentStart = queryReadonlyDeploymentEvents(id).find(event => event.event === "started")!;
  const launch = readOrdinaryNativeLineage(original, physical, currentStart), initial = { git: lease.preLaunchGitSnapshot, files: [] };
  const descriptor = `${workflowDigest(JSON.stringify(["native-execution-descriptor/v1", service.executionId]))}.intent.json`;
  withPreparedWorkflowLocks(host.locks, scope => store.publish(scope, descriptor, { schemaVersion: "native-ordinary-execution-descriptor/v1", binding, launchSha256: workflowDigest(JSON.stringify(launch)), initial }));
  const files = () => store.records().map(name => [name, readFileSync(join(authority.evidenceRoot(), name), "utf8")]);
  return { root, repo, worktree, oldId, id, actor, authority, binding, service, store, treehouse, descriptor, files };
}

test("native resumed-session bootstrap reuses original descriptor/journal and current authenticated holder without resetting limits", () => fixture(f => {
  const files = f.files(), session = new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } }).resolve({ cwd: f.worktree })!;
  assert.ok(session); assert.deepEqual(session.actor, f.actor); assert.deepEqual(session.contract, f.binding);
  assert.equal(session.service.executionId, f.service.executionId); assert.equal(session.service.status(session.actor).bounds.replacementsUsed, 1);
  assert.equal(session.contract.owner.deploymentId, f.oldId); assert.equal(session.actor.deploymentId, f.id);
  assert.deepEqual(f.files(), files);
  const reloaded = new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } }).resolve({ cwd: f.worktree })!;
  assert.deepEqual(reloaded.service.status(reloaded.actor), readExecutionState(f.store, f.binding)); assert.deepEqual(f.files(), files);
}));

test("native resumed-session bootstrap refuses a missing original descriptor without creating a replacement", () => fixture(f => {
  unlinkSync(join(f.authority.evidenceRoot(), f.descriptor)); const files = f.files();
  assert.throws(() => new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } }).resolve({ cwd: f.worktree }));
  assert.deepEqual(f.files(), files);
}));

test("native resumed-session bootstrap refuses a still-pending journal even if physical resources moved", () => fixture(f => {
  unlinkSync(join(f.authority.evidenceRoot(), `${f.service.executionId}.transaction-2.json`));
  assert.ok(readExecutionState(f.store, f.binding).pendingRestart); const files = f.files();
  assert.throws(() => new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } }).resolve({ cwd: f.worktree }));
  assert.deepEqual(f.files(), files);
}));

test("native resumed-session bootstrap rereads the current Treehouse lease and rejects drift before journal writes", () => fixture(f => {
  const foreign = new TreehouseClient({ run: args => {
    if (args[0] !== "status") throw Error("no checkout lifecycle effect");
    return { status: 0, stdout: Buffer.from(JSON.stringify([{ name: "1", path: f.worktree, status: "leased", branch: f.binding.branch, detached: false, flavor: "git", lease_id: "changed-lease", lease_holder: "pa:fixture:PAP-271", leased_at: new Date().toISOString(), processes: [] }])), stderr: Buffer.alloc(0) };
  } });
  const files = f.files(); assert.throws(() => new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: foreign } }).resolve({ cwd: f.worktree }));
  assert.deepEqual(f.files(), files);
}));

test("native resumed-session bootstrap cannot adopt changed original identity", () => fixture(f => {
  const descriptorPath = join(f.authority.evidenceRoot(), f.descriptor), descriptor = readFileSync(descriptorPath);
  const row = JSON.parse(descriptor.toString()); row.binding.owner.process.startTimeTicks = "999999999";
  writeFileSync(descriptorPath, JSON.stringify(row), { mode: 0o600 }); const files = f.files();
  assert.throws(() => new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } }).resolve({ cwd: f.worktree }));
  assert.deepEqual(f.files(), files);
}));
