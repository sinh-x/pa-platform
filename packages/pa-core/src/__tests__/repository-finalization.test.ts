import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_REPOSITORY_CHILD_SETTLEMENT_BYTES, REPOSITORY_CHILD_SETTLEMENT_FILE,
  acquireRepositoryMutationLease, captureRepositoryGitSnapshot, finalizeRepositoryMutationBorrower,
  inspectRepositoryMutationLease, observeReadonlyRepositoryAuthority, publishRepositoryDirtyBorrowApproval, reconcileRepositoryTerminalChild, recoverRepositoryTerminalChild,
  registerRepositoryMutationBorrower, releaseRepositoryMutationBorrower, releaseRepositoryMutationLease,
  repositoryMutationBorrowerPath, repositoryMutationLeasePath, repositoryDirtyBorrowApprovalPath, reserveRepositoryReview,
  transferRepositoryMutationBorrower, transferRepositoryMutationLease, updateRepositoryMutationLeaseGitSnapshot,
  type ProcessFingerprint, type RepositoryAdmissionDependencies, type RepositoryChildSettlementHost,
  type RepositoryChildSettlementResult, type RepositoryChildSettlementStage,
} from "../deploy/repository-admission.js";
import { appendRegistryEvent, closeDb, getDb, getDeploymentEvents, queryDeploymentStatus } from "../registry/index.js";

// Never inherit the admitted agent's identity, registry, activity/task paths or
// protected evidence. Each test process owns only these disposable fixtures.
for (const key of Object.keys(process.env)) if (key.startsWith("PA_") && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
const sandbox = mkdtempSync(join(tmpdir(), "pa-child-settlement-tests-"));
process.env["PA_AI_USAGE_HOME"] = join(sandbox, "usage");
process.env["PA_REGISTRY_DB"] = join(sandbox, "unused.db");
process.env["PA_PLATFORM_CONFIG"] = join(sandbox, "unused-config");
test.after(() => { closeDb(); rmSync(sandbox, { recursive: true, force: true }); });

const parentProcess: ProcessFingerprint = { pid: 740001, startTimeTicks: "100", bootId: "fixture-boot" };
const runnerProcess: ProcessFingerprint = { pid: 740002, startTimeTicks: "101", bootId: "fixture-boot" };
const executionProcess: ProcessFingerprint = { pid: 740003, startTimeTicks: "102", bootId: "fixture-boot" };
const scope = ["a.txt", "b.txt", "c.txt", "new space.txt", "new\nline.txt", "binary.dat", "renamed\nfile.txt"];
const git = (root: string, args: readonly string[]) => execFileSync("git", [...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();

function fixture(outcome: "success" | "failed" | "partial" = "failed") {
  const dir = mkdtempSync(join(sandbox, "case-")), canonical = join(dir, "canonical"), worktree = join(dir, "worktree");
  mkdirSync(canonical);
  git(canonical, ["init", "-b", "develop"]);
  git(canonical, ["config", "user.name", "Fixture"]); git(canonical, ["config", "user.email", "fixture@example.invalid"]);
  for (const path of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(canonical, path), `${path}\n`);
  writeFileSync(join(canonical, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  git(canonical, ["add", "."]); git(canonical, ["commit", "-m", "fixture baseline"]);
  git(canonical, ["worktree", "add", "-b", "feature/PAP-238-fixture", worktree]);
  const gitDir = git(worktree, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const config = join(dir, "config"); mkdirSync(config);
  writeFileSync(join(config, "config.yaml"), `repos:\n  fixture:\n    path: ${canonical}\n    prefix: PAP\n`);
  closeDb(); process.env["PA_REGISTRY_DB"] = join(dir, "registry.db"); process.env["PA_PLATFORM_CONFIG"] = config;
  const launch = captureRepositoryGitSnapshot(worktree);
  const running = new Map([[parentProcess.pid, parentProcess], [runnerProcess.pid, runnerProcess]]);
  let token = 0;
  const dependencies: Partial<RepositoryAdmissionDependencies> = {
    getProcessFingerprint: (pid) => running.get(pid), isProcessAlive: (pid) => running.has(pid),
    getCurrentProcessFingerprint: () => undefined, isDeploymentRunning: (id) => id === "d-238aaa",
    isProcessInLineage: () => true, createToken: () => `fixture-private-${++token}`,
    now: () => new Date("2026-10-21T16:00:00Z"),
  };
  const ownerOptions = { canonicalRepoKey: "fixture", canonicalRepoRoot: canonical, worktreeRoot: worktree,
    expectedGitDir: gitDir, expectedGitCommonDir: commonDir, deploymentId: "d-238aaa", deploymentDirectory: join(dir, "parent"),
    runtime: "pi" as const, team: "builder", mode: "orchestrator", launchMode: "foreground" as const, ticket: "PAP-238",
    pid: parentProcess.pid, processFingerprint: parentProcess, gitSnapshot: launch, dependencies };
  const owner = acquireRepositoryMutationLease(ownerOptions); assert.equal(owner.status, "acquired");
  if (owner.status !== "acquired") throw new Error("fixture owner rejected");
  const borrowerOptions = { canonicalRepoKey: "fixture", canonicalRepoRoot: canonical, worktreeRoot: worktree,
    expectedGitDir: gitDir, expectedGitCommonDir: commonDir, parentDeploymentId: "d-238aaa", deploymentId: "d-238bbb",
    deploymentDirectory: join(dir, "child"), runtime: "pi" as const, team: "builder", mode: "implement", launchMode: "background" as const,
    ticket: "PAP-238", branch: launch.branch, timeoutSeconds: 60, pid: runnerProcess.pid, processFingerprint: runnerProcess,
    gitSnapshot: launch, settlementMutationPaths: scope, dependencies };
  const registration = registerRepositoryMutationBorrower(borrowerOptions); assert.equal(registration.status, "registered");
  if (registration.status !== "registered") throw new Error("fixture borrower rejected");
  const binding = { repo: worktree, repo_root: canonical, worktree_root: worktree, ticket_id: "PAP-238", runtime: "pi" as const, binary: "ppa",
    treehouse_path: worktree, treehouse_lease_id: "fixture-lease", treehouse_lease_holder: "pa:fixture:PAP-238",
    branch_state: "materialized" as const, branch_base_sha: launch.head, branch_head_sha: launch.head, ticket_slot_id: "pa:fixture:PAP-238", repository_permit: 1 };
  appendRegistryEvent({ ...binding, deployment_id: "d-238aaa", team: "builder", mode: "orchestrator", builder_authority: "orchestrator", event: "started", timestamp: "2026-10-21T15:00:00Z" });
  appendRegistryEvent({ ...binding, deployment_id: "d-238bbb", team: "builder", mode: "implement", builder_authority: "parented-implement", parent_deployment_id: "d-238aaa", event: "started", timestamp: "2026-10-21T15:01:00Z" });
  appendRegistryEvent({ deployment_id: "d-238bbb", team: "builder", event: "completed", status: outcome, exit_code: outcome === "failed" ? 1 : 0,
    summary: "original causal result retained", timestamp: "2026-10-21T15:02:00Z" });
  running.delete(runnerProcess.pid);
  const ticketPath = join(dir, "ticket-projection.json");
  writeFileSync(ticketPath, JSON.stringify({ branch: launch.branch, baseSha: launch.head, headSha: launch.head }));
  let ticketWrites = 0;
  const host: RepositoryChildSettlementHost = {
    verifyExecution: () => ({ termination: "normal-exit", rawOutcome: { source: "background-supervisor", status: outcome === "partial" ? "failed" : outcome, exitCode: outcome === "success" ? 0 : 1 }, processes: [executionProcess] }),
    readTicket: () => JSON.parse(readFileSync(ticketPath, "utf8")) as ReturnType<RepositoryChildSettlementHost["readTicket"]>,
    publishTicket: (next) => {
      const before = host.readTicket();
      assert.equal(before.branch, next.branch); assert.equal(before.baseSha, next.baseSha);
      if (before.headSha === next.headSha) return;
      assert.equal(before.headSha, next.expectedHeadSha);
      writeFileSync(ticketPath, JSON.stringify({ branch: before.branch, baseSha: before.baseSha, headSha: next.headSha })); ticketWrites++;
    },
  };
  const options = { canonicalRepoKey: "fixture", canonicalRepoRoot: canonical, worktreeRoot: worktree, repositoryGitDir: gitDir,
    repositoryGitCommonDir: commonDir, parentDeploymentId: "d-238aaa", childDeploymentId: "d-238bbb", ticket: "PAP-238",
    borrowerToken: registration.borrower.borrowerToken, dependencies, host };
  const activePath = join(gitDir, REPOSITORY_CHILD_SETTLEMENT_FILE), borrowerPath = repositoryMutationBorrowerPath(worktree), leasePath = repositoryMutationLeasePath(worktree);
  const beforeLease = readFileSync(leasePath), beforeBorrower = readFileSync(borrowerPath);
  const starts = [getDeploymentEvents("d-238aaa")[0], getDeploymentEvents("d-238bbb")[0]];
  const dirty = () => {
    for (const path of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(worktree, path), "dirty fixture\n");
    writeFileSync(join(worktree, "new space.txt"), "new\n"); writeFileSync(join(worktree, "new\nline.txt"), "new\n");
  };
  const commit = () => { writeFileSync(join(worktree, "a.txt"), "committed fixture\n"); git(worktree, ["add", "a.txt"]); git(worktree, ["commit", "-m", "fixture partial commit"]); };
  return { dir, canonical, worktree, gitDir, commonDir, launch, running, dependencies, host, options, ownerOptions, borrowerOptions, owner,
    activePath, borrowerPath, leasePath, beforeLease, beforeBorrower, starts, ticketPath, dirty, commit,
    ticketWrites: () => ticketWrites, apply: () => reconcileRepositoryTerminalChild(options), dispose: () => { closeDb(); rmSync(dir, { recursive: true, force: true }); } };
}

function assertBlocked(result: RepositoryChildSettlementResult) {
  assert.equal(result.outcome, "blocked"); assert.ok(result.diagnostic); assert.ok(result.diagnostic.length <= 2000);
  for (const field of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.ok(result.diagnostic.includes(`${field}:`));
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-|ownershipToken|borrowerToken|startTimeTicks|bootId/);
}
function authorityEvents() { return getDeploymentEvents("d-238aaa").filter((event) => event.note?.startsWith("direct-child-authority:")); }
function readRecord(path: string) { return JSON.parse(readFileSync(path, "utf8")) as { digest: string; stage: string; firstFailure?: string; intent: { finalSnapshot: ReturnType<typeof captureRepositoryGitSnapshot> } }; }

for (const outcome of ["success", "failed", "partial"] as const) test(`dirty 0/3/2 ${outcome} publishes exact facts without relabelling outcome`, () => {
  const f = fixture(outcome);
  try {
    f.dirty(); const final = captureRepositoryGitSnapshot(f.worktree), raw = execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: f.worktree });
    assert.deepEqual([final.stagedCount, final.unstagedCount, final.untrackedCount], [0, 3, 2]);
    const result = f.apply(); assert.equal(result.outcome, "reconciled", result.diagnostic);
    assert.equal(result.softwareOutcome, outcome); assert.equal(result.executionOutcome, outcome === "partial" ? "failed" : outcome); assert.equal(result.head, f.launch.head); assert.equal(result.snapshotDigest, final.digestSha256);
    assert.deepEqual(result.projection, { lease: true, registry: true, ticket: true }); assert.equal(result.cleanup, true);
    assert.equal(existsSync(f.borrowerPath), false); assert.equal(existsSync(f.activePath), false);
    const records = readdirSync(f.gitDir).filter((name) => /^pa-repository-child-settlement\.[a-f0-9]{64}\.json$/.test(name)); assert.equal(records.length, 1);
    const path = join(f.gitDir, records[0]!); assert.equal(statSync(path).mode & 0o777, 0o600); assert.ok(statSync(path).size <= MAX_REPOSITORY_CHILD_SETTLEMENT_BYTES);
    assert.deepEqual(Buffer.from(readRecord(path).intent.finalSnapshot.statusPorcelainV2Base64!, "base64"), raw);
    const lease = inspectRepositoryMutationLease(f.canonical, { worktreeRoot: f.worktree, getProcessFingerprint: f.dependencies.getProcessFingerprint! }).lease!;
    assert.deepEqual(lease.preLaunchGitSnapshot, f.launch); assert.deepEqual(lease.authorityGitSnapshot, final); assert.equal(lease.authorityChildDeploymentId, "d-238bbb");
    assert.equal(queryDeploymentStatus("d-238bbb")?.status, outcome); assert.equal(queryDeploymentStatus("d-238aaa")?.status, "running");
    assert.deepEqual([getDeploymentEvents("d-238aaa")[0], getDeploymentEvents("d-238bbb")[0]], f.starts);
    assert.equal(f.apply().outcome, "already-reconciled"); assert.equal(authorityEvents().length, 1); assert.equal(f.ticketWrites(), 0);
    f.running.set(runnerProcess.pid, runnerProcess);
    const sibling = registerRepositoryMutationBorrower({ ...f.borrowerOptions, deploymentId: "d-238ccc", gitSnapshot: final, expectedGitSnapshot: final });
    assert.equal(sibling.status, "rejected"); if (sibling.status === "rejected") assert.equal(sibling.category, "dirty-approval");
  } finally { f.dispose(); }
});

for (const outcome of ["partial", "failed"] as const) test(`clean committed ${outcome} publishes a new full HEAD and keeps immutable starts`, () => {
  const f = fixture(outcome);
  try {
    f.commit(); const final = captureRepositoryGitSnapshot(f.worktree); assert.equal(final.dirty, false); assert.notEqual(final.head, f.launch.head);
    const result = f.apply(); assert.equal(result.outcome, "reconciled", result.diagnostic); assert.equal(result.head, final.head);
    assert.equal(queryDeploymentStatus("d-238aaa")?.branch_head_sha, final.head); assert.equal(f.host.readTicket().headSha, final.head);
    assert.equal(queryDeploymentStatus("d-238bbb")?.status, outcome); assert.equal(f.ticketWrites(), 1);
    assert.equal(f.apply().outcome, "already-reconciled"); assert.equal(f.ticketWrites(), 1); assert.equal(authorityEvents().length, 1);
    f.running.set(runnerProcess.pid, runnerProcess);
    const sibling = registerRepositoryMutationBorrower({ ...f.borrowerOptions, deploymentId: "d-238ccc", gitSnapshot: final, expectedGitSnapshot: final });
    assert.equal(sibling.status, "registered", sibling.diagnostic);
    assertBlocked(f.apply()); // A successor is never rolled back, even at the same HEAD.
  } finally { f.dispose(); }
});

for (const boundary of ["intent", "lease", "registry", "ticket", "published", "cleanup", "complete"] as const) test(`durable restart at ${boundary}, exactly one advancement`, () => {
  const f = fixture("partial");
  try {
    f.commit(); let interrupted = false;
    f.host.boundary = (stage) => { if (stage === boundary && !interrupted) { interrupted = true; throw new Error("fixture interruption"); } };
    assertBlocked(f.apply()); assert.equal(interrupted, true);
    if (boundary !== "complete") {
      assert.equal(existsSync(f.activePath), true);
      const active = readRecord(f.activePath); assert.equal(active.stage, boundary);
      const admission = registerRepositoryMutationBorrower({ ...f.borrowerOptions, deploymentId: "d-238ccc", force: true });
      assert.equal(admission.status, "rejected"); if (admission.status === "rejected") assert.equal(admission.category, "settlement-pending");
      const owner = acquireRepositoryMutationLease({ ...f.ownerOptions, force: true }); assert.equal(owner.status, "rejected");
      assert.equal(releaseRepositoryMutationBorrower({ canonicalRepoRoot: f.canonical, worktreeRoot: f.worktree, borrowerToken: f.options.borrowerToken }).status, "invalid-evidence");
      assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: f.canonical, worktreeRoot: f.worktree, ownershipToken: f.owner.lease.ownershipToken }).status, "invalid-evidence");
      assert.throws(() => observeReadonlyRepositoryAuthority(f.gitDir), /settlement/);
    }
    closeDb(); delete f.host.boundary;
    const result = f.apply(); assert.equal(result.outcome, boundary === "complete" ? "already-reconciled" : "reconciled", result.diagnostic);
    assert.equal(f.apply().outcome, "already-reconciled"); assert.equal(authorityEvents().length, 1); assert.equal(f.ticketWrites(), 1);
  } finally { f.dispose(); }
});

for (const boundary of ["intent", "lease", "registry", "ticket", "published", "cleanup", "complete"] as const) test(`existing-only recovery inspection and confirmed replay at ${boundary}`, () => {
  const f = fixture("partial");
  try {
    f.commit();
    f.host.boundary = (stage) => { if (stage === boundary) throw new Error("interruption"); };
    assertBlocked(f.apply()); delete f.host.boundary;
    const snapshot = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
      const path = join(dir, entry.name);
      // SQLite's readonly WAL reader updates volatile shared-memory read marks,
      // not database/WAL contents. Inventory its existence, not reader-lock bytes.
      return entry.isDirectory() ? Object.entries(snapshot(path)) : [[path, path.endsWith("registry.db-shm") ? "volatile-reader-lock-state" : createHash("sha256").update(readFileSync(path)).digest("hex")]];
    }));
    const before = snapshot(f.dir);
    const inspect = () => recoverRepositoryTerminalChild({ ...f.options, host: f.host });
    const first = inspect(); assert.equal(first.outcome, "eligible", first.diagnostic); assert.ok(first.observationDigest);
    assert.deepEqual(snapshot(f.dir), before, "inspection changes no durable file/directory/index/database/WAL bytes");
    assert.deepEqual(inspect(), first, "read-only observations are stable");
    const applied = recoverRepositoryTerminalChild({ ...f.options, host: f.host, expectedObservationDigest: first.observationDigest });
    assert.equal(applied.outcome, boundary === "complete" ? "already-reconciled" : "reconciled", applied.diagnostic);
    assert.equal(authorityEvents().length, 1);
    const completed = inspect(); assert.equal(completed.outcome, "eligible"); assert.equal(completed.cleanup, true);
    assert.equal(recoverRepositoryTerminalChild({ ...f.options, host: f.host, expectedObservationDigest: completed.observationDigest }).outcome, "already-reconciled");
    assert.equal(authorityEvents().length, 1);
  } finally { f.dispose(); }
});

test("operator observation drift and absence of retained native proof cannot create or publish authority", () => {
  const f = fixture();
  try {
    assertBlocked(recoverRepositoryTerminalChild({ ...f.options, host: f.host }));
    assert.equal(existsSync(f.activePath), false);
    f.host.boundary = (stage) => { if (stage === "intent") throw new Error("interruption"); };
    assertBlocked(f.apply()); delete f.host.boundary;
    const observed = recoverRepositoryTerminalChild({ ...f.options, host: f.host }); assert.equal(observed.outcome, "eligible");
    const before = readFileSync(f.activePath);
    assertBlocked(recoverRepositoryTerminalChild({ ...f.options, host: f.host, expectedObservationDigest: "a".repeat(64) }));
    assert.deepEqual(readFileSync(f.activePath), before); assert.deepEqual(readFileSync(f.leasePath), f.beforeLease); assert.equal(authorityEvents().length, 0);
    f.dirty();
    assertBlocked(recoverRepositoryTerminalChild({ ...f.options, host: f.host, expectedObservationDigest: observed.observationDigest }));
    assert.deepEqual(readFileSync(f.activePath), before); assert.equal(authorityEvents().length, 0);
  } finally { f.dispose(); }
});

test("rename endpoints, binary and newline inventory survive interruption byte-exactly", () => {
  const f = fixture();
  try {
    git(f.worktree, ["mv", "a.txt", "renamed\nfile.txt"]); writeFileSync(join(f.worktree, "binary.dat"), Buffer.from([0, 255, 3, 2]));
    writeFileSync(join(f.worktree, "new\nline.txt"), "new\n");
    const snapshot = captureRepositoryGitSnapshot(f.worktree); assert.equal(snapshot.statusEntries?.find((entry) => entry.kind === "rename-or-copy")?.sourcePath, "a.txt");
    f.host.boundary = (stage) => { if (stage === "intent") throw new Error("restart"); };
    assertBlocked(f.apply()); const bytes = readRecord(f.activePath).intent.finalSnapshot.statusPorcelainV2Base64;
    assert.equal(bytes, snapshot.statusPorcelainV2Base64); delete f.host.boundary;
    assert.equal(f.apply().outcome, "reconciled"); assert.equal(captureRepositoryGitSnapshot(f.worktree).statusPorcelainV2Base64, bytes);
  } finally { f.dispose(); }
});

for (const field of ["canonicalRepoKey", "canonicalRepoRoot", "worktreeRoot", "repositoryGitDir", "repositoryGitCommonDir", "parentDeploymentId", "childDeploymentId", "ticket", "borrowerToken"] as const) test(`identity conflict ${field} preserves all owner/borrower evidence`, () => {
  const f = fixture();
  try {
    const wrong = field.endsWith("Root") || field.includes("Git") ? f.dir : "wrong";
    const result = reconcileRepositoryTerminalChild({ ...f.options, [field]: wrong }); assertBlocked(result);
    assert.deepEqual(readFileSync(f.leasePath), f.beforeLease); assert.deepEqual(readFileSync(f.borrowerPath), f.beforeBorrower); assert.equal(authorityEvents().length, 0);
  } finally { f.dispose(); }
});

for (const condition of ["live-runner", "uncertain-runner", "reused-runner", "live-execution", "reused-execution", "missing-execution", "dead-parent", "review", "implement-owner", "wrong-launch", "wrong-base", "replaced-owner", "replaced-metadata", "branch-drift", "scope", "committed-scope", "unmerged"] as const) test(`containment/liveness: ${condition}`, () => {
  const f = fixture();
  try {
    if (condition === "live-runner") f.running.set(runnerProcess.pid, runnerProcess);
    if (condition === "uncertain-runner") f.dependencies.isProcessAlive = (pid) => pid === runnerProcess.pid;
    if (condition === "reused-runner") f.running.set(runnerProcess.pid, { ...runnerProcess, startTimeTicks: "999" });
    if (condition === "live-execution") f.running.set(executionProcess.pid, executionProcess);
    if (condition === "reused-execution") f.running.set(executionProcess.pid, { ...executionProcess, startTimeTicks: "999" });
    if (condition === "missing-execution") f.host.verifyExecution = () => ({ termination: "normal-exit", rawOutcome: { source: "foreground", status: "failed", exitCode: 1 }, processes: [] });
    if (condition === "dead-parent") f.running.delete(parentProcess.pid);
    if (condition === "review") writeFileSync(join(f.gitDir, "pa-repository-review.reservation.json"), "blocking review");
    if (condition === "implement-owner") writeFileSync(join(f.gitDir, "pa-repository-mutation.implement.lease.json"), "blocking owner");
    if (condition === "wrong-launch") getDb().prepare("UPDATE registry_events SET branch_head_sha = ? WHERE deployment_id = 'd-238bbb' AND event = 'started'").run("a".repeat(40));
    if (condition === "wrong-base") getDb().prepare("UPDATE registry_events SET branch_base_sha = ? WHERE deployment_id = 'd-238bbb' AND event = 'started'").run("a".repeat(40));
    if (condition === "replaced-owner") { const value = JSON.parse(f.beforeLease.toString()) as Record<string, unknown>; value["ownershipToken"] = "replacement"; value["deploymentId"] = "d-238ccc"; writeFileSync(f.leasePath, JSON.stringify(value)); }
    if (condition === "replaced-metadata") { const bytes = readFileSync(join(f.worktree, ".git")); renameSync(join(f.worktree, ".git"), join(f.worktree, ".git.old")); writeFileSync(join(f.worktree, ".git"), bytes); }
    if (condition === "branch-drift") git(f.worktree, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
    if (condition === "scope" || condition === "committed-scope") { writeFileSync(join(f.worktree, "outside.txt"), "outside"); if (condition === "committed-scope") { git(f.worktree, ["add", "outside.txt"]); git(f.worktree, ["commit", "-m", "outside fixture"]); } }
    if (condition === "unmerged") {
      const object = git(f.worktree, ["rev-parse", "HEAD:a.txt"]);
      execFileSync("git", ["update-index", "--index-info"], { cwd: f.worktree, input: `0 ${"0".repeat(40)}\ta.txt\n100644 ${object} 1\ta.txt\n100644 ${object} 2\ta.txt\n100644 ${object} 3\ta.txt\n` });
    }
    const ownerBefore = readFileSync(f.leasePath), borrowerBefore = readFileSync(f.borrowerPath);
    assertBlocked(f.apply()); assert.deepEqual(readFileSync(f.leasePath), ownerBefore); assert.deepEqual(readFileSync(f.borrowerPath), borrowerBefore); assert.equal(authorityEvents().length, 0);
    if (["scope", "committed-scope", "unmerged"].includes(condition)) assert.equal(existsSync(f.activePath), true, "retain noncompliant observed facts as a blocker");
  } finally { f.dispose(); }
});

test("dirty settlement grants no approval; a separately exact fresh receipt is consumed once", () => {
  const f = fixture();
  try {
    f.dirty(); assert.equal(f.apply().outcome, "reconciled");
    const final = captureRepositoryGitSnapshot(f.worktree);
    f.running.set(runnerProcess.pid, runnerProcess);
    const { settlementMutationPaths: _cleanScope, ...borrowerOptions } = f.borrowerOptions;
    const next = { ...borrowerOptions, deploymentId: "d-238ccc", gitSnapshot: final, expectedGitSnapshot: final };
    assert.equal(registerRepositoryMutationBorrower(next).status, "rejected");
    const inspection = inspectRepositoryMutationLease(f.canonical, { worktreeRoot: f.worktree, getProcessFingerprint: f.dependencies.getProcessFingerprint! });
    const approvalPath = publishRepositoryDirtyBorrowApproval({ schemaVersion: 1, receiptId: "fresh-one-use-receipt", approvalReference: "fixture-operator-approval",
      approvedAt: "2026-10-21T16:05:00Z", action: "preserve-and-continue", parentDeploymentId: "d-238aaa", parentDeploymentDirectory: f.owner.lease.deploymentDirectory,
      parentProcessFingerprint: parentProcess, parentLeaseEvidenceIdentity: inspection.evidenceIdentity!, canonicalRepoKey: "fixture", canonicalRepoRoot: f.canonical,
      worktreeRoot: f.worktree, ticket: "PAP-238", branch: final.branch, snapshot: final,
      classifications: final.statusEntries!.map((entry) => ({ path: entry.path, classification: "active-ticket-preserved" as const })), plannedNewPaths: [] }, f.dependencies);
    assert.equal(registerRepositoryMutationBorrower({ ...next, dirtyApprovalPath: approvalPath }).status, "registered");
    assert.equal(existsSync(repositoryDirtyBorrowApprovalPath(f.owner.lease.deploymentDirectory)), false);
    assert.equal(registerRepositoryMutationBorrower({ ...next, deploymentId: "d-238ddd", dirtyApprovalPath: approvalPath }).status, "rejected");
  } finally { f.dispose(); }
});

for (const code of [124, 130, 137, 143]) test(`timeout/cancel exit ${code} is not normal settlement authority`, () => {
  const f = fixture();
  try { getDb().prepare("UPDATE registry_events SET exit_code = ? WHERE deployment_id = 'd-238bbb' AND event = 'completed'").run(code);
    assertBlocked(f.apply()); assert.deepEqual(readFileSync(f.leasePath), f.beforeLease); assert.deepEqual(readFileSync(f.borrowerPath), f.beforeBorrower); }
  finally { f.dispose(); }
});

test("missing borrower without protected retained proof is legacy-proof-unavailable, never reconstructed", () => {
  const f = fixture();
  try { unlinkSync(f.borrowerPath); const result = f.apply(); assertBlocked(result); assert.match(result.diagnostic!, /legacy-proof-unavailable/); assert.equal(existsSync(f.borrowerPath), false); assert.equal(existsSync(f.activePath), false); assert.deepEqual(readFileSync(f.leasePath), f.beforeLease); }
  finally { f.dispose(); }
});

test("missing borrower with a published durable intent resumes without reconstruction", () => {
  const f = fixture();
  try { f.dirty(); f.host.boundary = (stage) => { if (stage === "published") throw new Error("death"); }; assertBlocked(f.apply()); unlinkSync(f.borrowerPath); delete f.host.boundary; assert.equal(f.apply().outcome, "reconciled"); assert.equal(existsSync(f.borrowerPath), false); assert.equal(authorityEvents().length, 1); }
  finally { f.dispose(); }
});

for (const projection of ["registry", "ticket-write", "ticket-readback"] as const) test(`${projection} failure remains blocking and resumes the same CAS`, () => {
  const f = fixture("partial");
  try {
    f.commit(); const originalPublish = f.host.publishTicket, originalRead = f.host.readTicket;
    if (projection === "registry") getDb().exec("CREATE TRIGGER reject_settlement BEFORE UPDATE OF branch_head_sha ON deployments BEGIN SELECT RAISE(ABORT, 'fixture-private-do-not-disclose'); END");
    if (projection === "ticket-write") f.host.publishTicket = () => { throw new Error("fixture-private-do-not-disclose"); };
    if (projection === "ticket-readback") f.host.publishTicket = () => undefined;
    assertBlocked(f.apply()); assert.equal(existsSync(f.activePath), true); assert.equal(existsSync(f.borrowerPath), true);
    const before = readRecord(f.activePath); assert.equal(queryDeploymentStatus("d-238bbb")?.status, "partial");
    if (projection === "registry") getDb().exec("DROP TRIGGER reject_settlement");
    f.host.publishTicket = originalPublish; f.host.readTicket = originalRead;
    assert.equal(f.apply().outcome, "reconciled"); assert.equal(authorityEvents().length, 1);
    const retained = readdirSync(f.gitDir).find((name) => /^pa-repository-child-settlement\.[a-f0-9]{64}\.json$/.test(name))!;
    assert.equal(readRecord(join(f.gitDir, retained)).digest, before.digest); assert.equal(readRecord(join(f.gitDir, retained)).firstFailure, before.firstFailure);
  } finally { f.dispose(); }
});

for (const corrupt of ["symlink", "permissions", "oversize", "malformed", "unknown-progress"] as const) test(`private settlement ${corrupt} fails closed`, () => {
  const f = fixture();
  try {
    f.host.boundary = (stage) => { if (stage === "intent") throw new Error("stop"); }; assertBlocked(f.apply()); delete f.host.boundary;
    const prior = readFileSync(f.activePath);
    if (corrupt === "symlink") { unlinkSync(f.activePath); const target = join(f.dir, "target.json"); writeFileSync(target, prior, { mode: 0o600 }); symlinkSync(target, f.activePath); }
    if (corrupt === "permissions") chmodSync(f.activePath, 0o644);
    if (corrupt === "oversize") writeFileSync(f.activePath, Buffer.alloc(MAX_REPOSITORY_CHILD_SETTLEMENT_BYTES + 1, 32));
    if (corrupt === "malformed") writeFileSync(f.activePath, "{");
    if (corrupt === "unknown-progress") writeFileSync(f.activePath, prior.toString().replace('"stage":"intent"', '"stage":"unknown"'));
    const owner = readFileSync(f.leasePath), borrower = readFileSync(f.borrowerPath), evidence = readFileSync(f.activePath);
    assertBlocked(f.apply()); assert.deepEqual(readFileSync(f.leasePath), owner); assert.deepEqual(readFileSync(f.borrowerPath), borrower); assert.deepEqual(readFileSync(f.activePath), evidence);
    assert.equal(registerRepositoryMutationBorrower({ ...f.borrowerOptions, force: true }).status, "rejected");
  } finally { f.dispose(); }
});

test("oversized captured inventory is rejected without truncation or cleanup", () => {
  const f = fixture();
  try {
    const raw = Buffer.from(Array.from({ length: 5000 }, (_, i) => `? untracked-${i}-${"x".repeat(80)}\0`).join(""));
    f.dependencies.runGit = (args) => args[0] === "symbolic-ref" ? f.launch.branch : args[0] === "rev-parse" ? f.launch.head : args[0] === "status" ? raw : Buffer.alloc(0);
    assertBlocked(f.apply()); assert.deepEqual(readFileSync(f.leasePath), f.beforeLease); assert.deepEqual(readFileSync(f.borrowerPath), f.beforeBorrower); assert.equal(existsSync(f.activePath), false);
  } finally { f.dispose(); }
});

test("pending settlement blocks legacy mutators, transfers, review and snapshot replacement", () => {
  const f = fixture();
  try {
    f.host.boundary = (stage) => { if (stage === "intent") throw new Error("stop"); }; assertBlocked(f.apply());
    const location = { canonicalRepoRoot: f.canonical, worktreeRoot: f.worktree };
    assert.equal(finalizeRepositoryMutationBorrower({ ...location, borrowerToken: f.options.borrowerToken, deploymentId: "d-238bbb" }).status, "invalid-evidence");
    assert.equal(transferRepositoryMutationBorrower({ ...location, borrowerToken: f.options.borrowerToken, nextProcessFingerprint: parentProcess }).status, "invalid-evidence");
    assert.equal(transferRepositoryMutationLease({ ...location, ownershipToken: f.owner.lease.ownershipToken, nextProcessFingerprint: parentProcess }).status, "invalid-evidence");
    assert.equal(updateRepositoryMutationLeaseGitSnapshot({ ...location, ownershipToken: f.owner.lease.ownershipToken, gitSnapshot: f.launch }).status, "invalid-evidence");
    assert.throws(() => reserveRepositoryReview({ checkout: { kind: "review-candidate", repoKey: "fixture", repoRoot: f.canonical, worktreeRoot: f.worktree, ticket: "PAP-238",
      leaseId: "fixture-lease", leaseHolder: "pa:fixture:PAP-238", branch: f.launch.branch, branchState: "materialized", baseSha: f.launch.head, headSha: f.launch.head, featureSha: f.launch.head,
      repositoryGitDir: f.gitDir, repositoryGitCommonDir: f.commonDir, gitSnapshot: f.launch }, deploymentId: "d-238ccc", authorizationId: "review-auth:00000000-0000-4000-8000-000000000001",
      rereadCheckout: () => { throw new Error("must not select"); }, dependencies: f.dependencies }), /reservation/);
    assert.deepEqual(readFileSync(f.leasePath), f.beforeLease); assert.deepEqual(readFileSync(f.borrowerPath), f.beforeBorrower);
  } finally { f.dispose(); }
});

test("current Git or a successor registry/lease/ticket conflict never rolls back newer authority", () => {
  for (const successor of ["git", "lease", "registry", "ticket"] as const) {
    const f = fixture("partial");
    try {
      f.commit(); f.host.boundary = (stage) => { if (stage === "published") throw new Error("stop"); }; assertBlocked(f.apply()); delete f.host.boundary;
      if (successor === "git") writeFileSync(join(f.worktree, "b.txt"), "later edit\n");
      if (successor === "lease") { const parent = JSON.parse(readFileSync(f.leasePath, "utf8")) as Record<string, unknown>; parent["ownershipToken"] = "replacement"; writeFileSync(f.leasePath, JSON.stringify(parent)); }
      if (successor === "registry") appendRegistryEvent({ deployment_id: "d-238aaa", team: "builder", event: "updated", timestamp: "2026-10-21T16:03:00Z", note: "direct-owner-authority:successor", branch_state: "materialized", branch_base_sha: f.launch.head, branch_head_sha: "c".repeat(40) });
      if (successor === "ticket") writeFileSync(f.ticketPath, JSON.stringify({ ...f.host.readTicket(), headSha: "c".repeat(40) }));
      const owner = readFileSync(f.leasePath), ticket = readFileSync(f.ticketPath), events = getDeploymentEvents("d-238aaa");
      assertBlocked(f.apply()); assert.deepEqual(readFileSync(f.leasePath), owner); assert.deepEqual(readFileSync(f.ticketPath), ticket); assert.deepEqual(getDeploymentEvents("d-238aaa"), events); assert.equal(existsSync(f.borrowerPath), true);
    } finally { f.dispose(); }
  }
});

for (const boundary of ["intent", "lease", "registry", "ticket", "published", "cleanup"] as const) test(`replacement parent at ${boundary} is preserved before the next effect`, () => {
  const f = fixture("partial");
  try {
    f.commit(); let replacement: Buffer | undefined;
    f.host.boundary = (stage) => {
      if (stage !== boundary) return;
      const owner = JSON.parse(readFileSync(f.leasePath, "utf8")) as Record<string, unknown>;
      owner["ownershipToken"] = "replacement-private-capability";
      writeFileSync(f.leasePath, JSON.stringify(owner)); replacement = readFileSync(f.leasePath);
    };
    const result = f.apply(); assertBlocked(result); assert.ok(replacement);
    assert.deepEqual(readFileSync(f.leasePath), replacement); assert.equal(existsSync(f.activePath), true);
    assert.equal(existsSync(f.borrowerPath), boundary !== "cleanup");
    const admission = registerRepositoryMutationBorrower({ ...f.borrowerOptions, deploymentId: "d-238ccc", force: true });
    assert.equal(admission.status, "rejected");
    if (admission.status === "rejected") assert.equal(admission.category, "settlement-pending");
  } finally { f.dispose(); }
});

test("ticket identity conflict is rejected before lease or registry publication", () => {
  const f = fixture("partial");
  try {
    f.commit(); writeFileSync(f.ticketPath, JSON.stringify({ ...f.host.readTicket(), baseSha: "f".repeat(40) }));
    assertBlocked(f.apply()); assert.deepEqual(readFileSync(f.leasePath), f.beforeLease);
    assert.deepEqual(readFileSync(f.borrowerPath), f.beforeBorrower); assert.equal(authorityEvents().length, 0);
    assert.equal(existsSync(f.activePath), true);
  } finally { f.dispose(); }
});

test("a registry successor between intent and lease cannot advance the old parent lease", () => {
  const f = fixture("partial");
  try {
    f.commit();
    f.host.boundary = (stage) => {
      if (stage === "intent") appendRegistryEvent({ deployment_id: "d-238aaa", team: "builder", event: "updated", timestamp: "2026-10-21T16:03:00Z",
        note: "direct-owner-authority:successor", branch_state: "materialized", branch_base_sha: f.launch.head, branch_head_sha: f.launch.head });
    };
    assertBlocked(f.apply()); assert.deepEqual(readFileSync(f.leasePath), f.beforeLease);
    assert.deepEqual(readFileSync(f.borrowerPath), f.beforeBorrower); assert.equal(authorityEvents().length, 0);
  } finally { f.dispose(); }
});

test("retained settlement scope cannot widen an existing consumed dirty approval", () => {
  const f = fixture();
  try {
    // Synthetic protected borrower with a narrower consumed receipt. The host's
    // wider scope cannot supersede that admission-time bound.
    const borrower = JSON.parse(f.beforeBorrower.toString()) as Record<string, unknown>;
    borrower["approvedMutationPaths"] = ["a.txt"]; borrower["dirtyApprovalReceiptId"] = "consumed-fixture-receipt";
    writeFileSync(f.borrowerPath, JSON.stringify(borrower));
    writeFileSync(join(f.worktree, "b.txt"), "outside original approval\n");
    assertBlocked(f.apply()); assert.deepEqual(readFileSync(f.leasePath), f.beforeLease);
    assert.equal(authorityEvents().length, 0); assert.equal(existsSync(f.activePath), true);
  } finally { f.dispose(); }
});

test("two independent processes serialize settlement and later replay without duplicate effects", async () => {
  const f = fixture("partial");
  try {
    f.commit(); closeDb();
    const source = new URL("../deploy/repository-admission.ts", import.meta.url).href;
    const packet = { ...f.options, dependencies: undefined, host: undefined };
    const script = `import {readFileSync,writeFileSync} from 'node:fs';
      import {reconcileRepositoryTerminalChild} from ${JSON.stringify(source)};
      const parent = ${JSON.stringify(parentProcess)};
      const result = reconcileRepositoryTerminalChild({...${JSON.stringify(packet)},
        dependencies:{getProcessFingerprint:pid=>pid===parent.pid?parent:undefined,isProcessAlive:pid=>pid===parent.pid,getCurrentProcessFingerprint:()=>undefined,isDeploymentRunning:id=>id==='d-238aaa'},
        host:{verifyExecution:()=>({termination:'normal-exit',rawOutcome:{source:'background-supervisor',status:'failed',exitCode:1},processes:[${JSON.stringify(executionProcess)}]}),
          readTicket:()=>JSON.parse(readFileSync(${JSON.stringify(f.ticketPath)},'utf8')),
          publishTicket:next=>{const path=${JSON.stringify(f.ticketPath)}; const before=JSON.parse(readFileSync(path,'utf8')); if(before.headSha===next.headSha)return; if(before.headSha!==next.expectedHeadSha)throw Error('CAS'); writeFileSync(path,JSON.stringify({branch:next.branch,baseSha:next.baseSha,headSha:next.headSha}));}}});
      console.log(JSON.stringify(result));`;
    const run = () => new Promise<RepositoryChildSettlementResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject); child.on("exit", (code) => { if (code !== 0) reject(new Error(`fixture child exit=${code}: ${stderr}`)); else { try { resolve(JSON.parse(stdout) as RepositoryChildSettlementResult); } catch (error) { reject(error); } } });
    });
    const results = await Promise.all([run(), run()]); assert.deepEqual(results.map((result) => result.outcome).sort(), ["already-reconciled", "reconciled"]);
    assert.equal(f.apply().outcome, "already-reconciled"); assert.equal(authorityEvents().length, 1); assert.equal(existsSync(f.activePath), false); assert.equal(existsSync(f.borrowerPath), false);
  } finally { f.dispose(); }
});
