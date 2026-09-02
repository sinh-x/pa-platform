import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activateRepositoryLifecycle,
  captureRepositoryCheckout,
  cleanupMergedFeatureBranch,
  finalizeRepositoryLifecycle,
  transferRepositoryLeaseByDeployment,
  type ExecutionPlan,
} from "../index.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(name: string): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), `pa-lifecycle-${name}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "develop"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  return { root, repo };
}

function plan(root: string, repo: string, id: string, access: "read-only" | "mutating" = "mutating"): ExecutionPlan {
  const deploymentDir = join(root, "deployments", id);
  mkdirSync(deploymentDir, { recursive: true });
  return Object.freeze({
    runtime: "opencode",
    team: "builder",
    mode: access === "mutating" ? "implement" : "inspect",
    repoKey: "registered",
    repoRoot: repo,
    repositoryCwd: repo,
    memoryDocumentRoot: repo,
    repositoryAccess: access,
    ticketRequired: false,
    objective: "test",
    skills: Object.freeze([]),
    memoryDocuments: Object.freeze([]),
    environment: Object.freeze({ PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: deploymentDir, PA_REPO: repo }),
    timeoutSeconds: 60,
    lifecycle: Object.freeze({ deploymentId: id, deploymentDir, activityLogPath: join(deploymentDir, "activity.jsonl"), registryDbPath: join(root, "registry.db"), terminalMarker: join(deploymentDir, "terminal.json") }),
  });
}

function deadPid(): number {
  for (let pid = 900_000; pid < 999_999; pid += 1) {
    try { process.kill(pid, 0); } catch { return pid; }
  }
  return 2_000_000_000;
}

test("admits a read-only deployment while retaining mutator-only lease serialization", () => {
  const f = fixture("serialization");
  try {
    const before = captureRepositoryCheckout(f.repo);
    const owner = activateRepositoryLifecycle(plan(f.root, f.repo, "d-owner"));
    assert.equal(owner.repositoryLease?.role, "owner");
    let runtimeSpawns = 0;
    assert.throws(() => {
      activateRepositoryLifecycle(plan(f.root, f.repo, "d-second"));
      runtimeSpawns += 1;
    }, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /mutation lease conflict.*deployment=d-owner/is);
      assert.ok(error.message.length <= 2_000);
      return true;
    });
    assert.equal(runtimeSpawns, 0);
    const reader = activateRepositoryLifecycle(plan(f.root, f.repo, "d-reader", "read-only"));
    assert.equal(reader.repositoryLease?.role, "reader");
    assert.equal(reader.repositoryLease?.state, "not-required");
    assert.equal(reader.repositoryLease?.leasePath, undefined);
    assert.ok(owner.repositoryLease?.leasePath && existsSync(owner.repositoryLease.leasePath));
    assert.deepEqual(captureRepositoryCheckout(f.repo), before);
    assert.equal(finalizeRepositoryLifecycle(reader).ok, true);
    assert.ok(owner.repositoryLease?.leasePath && existsSync(owner.repositoryLease.leasePath));
    assert.equal(finalizeRepositoryLifecycle(owner).ok, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a delayed ownership transfer after finalization cannot recreate the released lease", () => {
  const f = fixture("delayed-transfer");
  try {
    const active = activateRepositoryLifecycle(plan(f.root, f.repo, "d-owner"));
    const leasePath = active.repositoryLease?.leasePath;
    assert.ok(leasePath);
    assert.equal(finalizeRepositoryLifecycle(active).ok, true);
    transferRepositoryLeaseByDeployment(active.lifecycle.deploymentDir, process.pid);
    assert.equal(existsSync(leasePath), false);
    const evidence = JSON.parse(readFileSync(join(active.lifecycle.deploymentDir, "repository-lifecycle.json"), "utf8")) as Record<string, unknown>;
    assert.equal(evidence["state"], "released");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("background reader transfer is a no-op and cannot affect the mutator lease", () => {
  const f = fixture("reader-transfer");
  try {
    const owner = activateRepositoryLifecycle(plan(f.root, f.repo, "d-owner"));
    const reader = activateRepositoryLifecycle(plan(f.root, f.repo, "d-reader", "read-only"));
    assert.equal(reader.repositoryLease?.leasePath, undefined);
    transferRepositoryLeaseByDeployment(reader.lifecycle.deploymentDir, 4242);
    assert.equal(finalizeRepositoryLifecycle(reader).ok, true);
    assert.ok(owner.repositoryLease?.leasePath && existsSync(owner.repositoryLease.leasePath));
    assert.equal(finalizeRepositoryLifecycle(owner).ok, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("delegated mutators share the live owner without releasing or restoring it", () => {
  const f = fixture("delegate");
  try {
    const owner = activateRepositoryLifecycle(plan(f.root, f.repo, "d-owner"));
    const delegate = activateRepositoryLifecycle(plan(f.root, f.repo, "d-child"), { env: owner.environment as NodeJS.ProcessEnv });
    assert.equal(delegate.repositoryLease?.role, "delegate");
    assert.equal(delegate.repositoryLease?.ownerDeploymentId, "d-owner");
    assert.equal(finalizeRepositoryLifecycle(delegate).ok, true);
    assert.equal(finalizeRepositoryLifecycle(owner).ok, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("stale owner recovery restores exact checkout and release is idempotent", () => {
  const f = fixture("stale");
  try {
    const original = captureRepositoryCheckout(f.repo);
    const stale = activateRepositoryLifecycle(plan(f.root, f.repo, "d-stale"));
    git(f.repo, ["checkout", "-b", "feature/PAP-162-stale"]);
    writeFileSync(join(f.repo, "feature.txt"), "feature\n");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-m", "feature"]);
    const leasePath = stale.repositoryLease?.leasePath;
    assert.ok(leasePath);
    const lease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    lease["pid"] = deadPid();
    writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);

    const recovered = activateRepositoryLifecycle(plan(f.root, f.repo, "d-recovered"));
    assert.deepEqual(captureRepositoryCheckout(f.repo), original);
    const first = finalizeRepositoryLifecycle(recovered);
    const second = finalizeRepositoryLifecycle(recovered);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.evidence?.after, original);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("release remains idempotent after a crash between durable lease unlink and lifecycle publication", () => {
  const f = fixture("release-crash");
  try {
    const before = captureRepositoryCheckout(f.repo);
    const active = activateRepositoryLifecycle(plan(f.root, f.repo, "d-owner"));
    assert.ok(active.repositoryLease?.leasePath);
    unlinkSync(active.repositoryLease.leasePath);
    const first = finalizeRepositoryLifecycle(active);
    const second = finalizeRepositoryLifecycle(active);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(first.evidence?.after, before);
    assert.deepEqual(second.evidence?.after, before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("terminal success restores original branch and HEAD after a clean feature commit", () => {
  const f = fixture("restore-success");
  try {
    const before = captureRepositoryCheckout(f.repo);
    const active = activateRepositoryLifecycle(plan(f.root, f.repo, "d-owner"));
    git(f.repo, ["checkout", "-b", "feature/PAP-162-restore"]);
    writeFileSync(join(f.repo, "change.txt"), "change\n");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-m", "change"]);
    const result = finalizeRepositoryLifecycle(active);
    assert.equal(result.ok, true);
    assert.deepEqual(captureRepositoryCheckout(f.repo), before);
    assert.equal(git(f.repo, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("dirty terminal failure preserves staged, unstaged, and untracked files and retains recovery ownership", () => {
  const f = fixture("restore-failure");
  try {
    const active = activateRepositoryLifecycle(plan(f.root, f.repo, "d-owner"));
    writeFileSync(join(f.repo, "staged.txt"), "staged\n");
    git(f.repo, ["add", "staged.txt"]);
    writeFileSync(join(f.repo, "README.md"), "unstaged\n");
    writeFileSync(join(f.repo, "untracked.txt"), "untracked\n");
    const dirty = captureRepositoryCheckout(f.repo);
    const result = finalizeRepositoryLifecycle(active);
    assert.equal(result.ok, false);
    assert.ok((result.diagnostic?.length ?? 0) <= 2_000);
    assert.deepEqual(captureRepositoryCheckout(f.repo), dirty);
    assert.ok(active.repositoryLease?.leasePath && readFileSync(active.repositoryLease.leasePath, "utf8").includes("d-owner"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("failed stale recovery persists bounded evidence across repeated dirty attempts", () => {
  const f = fixture("stale-dirty");
  try {
    const stale = activateRepositoryLifecycle(plan(f.root, f.repo, "d-stale"));
    const leasePath = stale.repositoryLease?.leasePath;
    assert.ok(leasePath);
    const lease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    lease["pid"] = deadPid();
    writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
    writeFileSync(join(f.repo, "preserve.txt"), "dirty\n");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(() => activateRepositoryLifecycle(plan(f.root, f.repo, `d-next-${attempt}`)), /Stale repository mutation lease recovery is required/is);
      const evidence = JSON.parse(readFileSync(join(f.root, "deployments", "d-stale", "repository-lifecycle.json"), "utf8")) as Record<string, unknown>;
      assert.equal(evidence["state"], "recovery-required");
      assert.ok(String(evidence["diagnostic"]).length <= 2_000);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("failed stale recovery persists evidence when the original branch moved", () => {
  const f = fixture("stale-moved-branch");
  try {
    const stale = activateRepositoryLifecycle(plan(f.root, f.repo, "d-stale"));
    const leasePath = stale.repositoryLease?.leasePath;
    assert.ok(leasePath);
    git(f.repo, ["checkout", "-b", "feature/PAP-162-moved"]);
    writeFileSync(join(f.repo, "feature.txt"), "feature\n");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-m", "feature"]);
    git(f.repo, ["branch", "-f", "develop", "HEAD"]);
    const lease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    lease["pid"] = deadPid();
    writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
    assert.throws(() => activateRepositoryLifecycle(plan(f.root, f.repo, "d-next")), /Original branch develop moved/is);
    const evidence = JSON.parse(readFileSync(join(f.root, "deployments", "d-stale", "repository-lifecycle.json"), "utf8")) as Record<string, unknown>;
    assert.equal(evidence["state"], "recovery-required");
    assert.match(String(evidence["diagnostic"]), /Original branch develop moved/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("stale recovery persistence failure leaves durable fallback evidence beside the lease", () => {
  const f = fixture("stale-persistence");
  try {
    const stale = activateRepositoryLifecycle(plan(f.root, f.repo, "d-stale"));
    const leasePath = stale.repositoryLease?.leasePath;
    assert.ok(leasePath);
    const lease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    lease["pid"] = deadPid();
    writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
    writeFileSync(join(f.repo, "preserve.txt"), "dirty\n");
    rmSync(join(f.root, "deployments", "d-stale"), { recursive: true });
    writeFileSync(join(f.root, "deployments", "d-stale"), "blocks lifecycle directory\n");
    assert.throws(() => activateRepositoryLifecycle(plan(f.root, f.repo, "d-next")), /evidence persistence also failed/is);
    const fallback = JSON.parse(readFileSync(`${leasePath}.recovery-required.json`, "utf8")) as Record<string, unknown>;
    assert.equal(fallback["state"], "recovery-required");
    assert.match(String(fallback["diagnostic"]), /Lifecycle persistence failed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("dirty preflight rejects without checkout mutation and bounds diagnostics", () => {
  const f = fixture("dirty-preflight");
  try {
    writeFileSync(join(f.repo, "untracked.txt"), "keep\n");
    const before = captureRepositoryCheckout(f.repo);
    assert.throws(() => activateRepositoryLifecycle(plan(f.root, f.repo, "d-owner")), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /rejected before checkout mutation.*untracked=1/is);
      assert.ok(error.message.length <= 2_000);
      return true;
    });
    assert.deepEqual(captureRepositoryCheckout(f.repo), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy worktree resume reports are rejected without mutation and with recovery guidance", () => {
  const f = fixture("legacy");
  try {
    const prior = join(f.root, "deployments", "d-legacy");
    mkdirSync(prior, { recursive: true });
    const report = "Execution strategy: worktree\nWorktree: /tmp/old-worktree\n";
    writeFileSync(join(prior, "orchestration-report.md"), report);
    const before = captureRepositoryCheckout(f.repo);
    assert.throws(() => activateRepositoryLifecycle(plan(f.root, f.repo, "d-new"), { resumeDeploymentId: "d-legacy" }), /Legacy worktree orchestration report rejected without mutation.*preserve every unmerged commit.*Automatic migration is prohibited/is);
    assert.equal(readFileSync(join(prior, "orchestration-report.md"), "utf8"), report);
    assert.deepEqual(captureRepositoryCheckout(f.repo), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy resume reports remain rejected when a matching lifecycle sidecar exists", () => {
  const f = fixture("legacy-sidecar");
  try {
    const prior = join(f.root, "deployments", "d-legacy");
    mkdirSync(prior, { recursive: true });
    writeFileSync(join(prior, "repository-lifecycle.json"), JSON.stringify({
      schemaVersion: 1,
      role: "owner",
      state: "released",
      repositoryKey: "registered",
      repositoryRoot: f.repo,
      deploymentId: "d-legacy",
    }));
    writeFileSync(join(prior, "orchestration-report.md"), "| **Execution strategy:** | worktree |\n| **Worktree:** | /tmp/legacy |\n");
    const before = captureRepositoryCheckout(f.repo);
    assert.throws(() => activateRepositoryLifecycle(plan(f.root, f.repo, "d-new"), { resumeDeploymentId: "d-legacy" }), /Legacy worktree orchestration report rejected without mutation/);
    assert.deepEqual(captureRepositoryCheckout(f.repo), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy heading-style worktree reports are rejected", () => {
  const f = fixture("legacy-headings");
  try {
    const prior = join(f.root, "deployments", "d-legacy");
    mkdirSync(prior, { recursive: true });
    writeFileSync(join(prior, "orchestration-report.md"), "## Execution strategy\nworktree\n## Worktree path\n/tmp/legacy\n");
    assert.throws(() => activateRepositoryLifecycle(plan(f.root, f.repo, "d-new"), { resumeDeploymentId: "d-legacy" }), /Legacy worktree orchestration report rejected without mutation/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("local and GitHub merge evidence permit policy-based cleanup only after ancestry proof", () => {
  for (const kind of ["local", "github"] as const) {
    const f = fixture(`cleanup-${kind}`);
    try {
      git(f.repo, ["checkout", "-b", `feature/PAP-162-${kind}`]);
      writeFileSync(join(f.repo, `${kind}.txt`), `${kind}\n`);
      git(f.repo, ["add", "."]);
      git(f.repo, ["commit", "-m", kind]);
      git(f.repo, ["checkout", "develop"]);
      git(f.repo, ["merge", "--no-ff", "-m", `merge ${kind}`, `feature/PAP-162-${kind}`]);
      const merge = git(f.repo, ["rev-parse", "HEAD"]);
      const evidence = kind === "local"
        ? `local:target=develop;merge_commit=${merge};ancestor=true;remote=${merge};verified=true`
        : `github:pr=162;merge_commit=${merge};target=develop;ci=passed;verified=true`;
      const denied = cleanupMergedFeatureBranch(f.repo, `feature/PAP-162-${kind}`, evidence, { deleteLocal: false });
      assert.equal(denied.deletedLocal, false);
      assert.doesNotThrow(() => git(f.repo, ["rev-parse", `refs/heads/feature/PAP-162-${kind}`]));
      const cleaned = cleanupMergedFeatureBranch(f.repo, `feature/PAP-162-${kind}`, evidence, { deleteLocal: true });
      assert.equal(cleaned.deletedLocal, true);
      assert.throws(() => git(f.repo, ["rev-parse", `refs/heads/feature/PAP-162-${kind}`]));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("terminal finalization applies persisted cleanup policy after restoration and still releases on cleanup failure", () => {
  const f = fixture("terminal-cleanup");
  try {
    git(f.repo, ["checkout", "-b", "feature/PAP-162-terminal"]);
    writeFileSync(join(f.repo, "feature.txt"), "feature\n");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-m", "feature"]);
    git(f.repo, ["checkout", "develop"]);
    git(f.repo, ["merge", "--no-ff", "-m", "merge feature", "feature/PAP-162-terminal"]);
    const merge = git(f.repo, ["rev-parse", "HEAD"]);
    const terminalPlan = plan(f.root, f.repo, "d-terminal");
    const active = activateRepositoryLifecycle(Object.freeze({ ...terminalPlan, environment: Object.freeze({ ...terminalPlan.environment, PA_FEATURE_BRANCH: "feature/PAP-162-terminal", PA_MERGE_EVIDENCE: `local:target=develop;merge_commit=${merge};ancestor=true;remote=${merge};verified=true`, PA_BRANCH_CLEANUP_LOCAL: "true" }) }));
    const result = finalizeRepositoryLifecycle(active);
    assert.equal(result.ok, true);
    assert.equal(result.evidence?.branchCleanup?.result?.deletedLocal, true);
    assert.equal(existsSync(active.repositoryLease?.leasePath ?? ""), false);
    assert.throws(() => git(f.repo, ["rev-parse", "refs/heads/feature/PAP-162-terminal"]));

    const failedCleanupPlan = plan(f.root, f.repo, "d-terminal-failed-cleanup");
    const failedCleanup = activateRepositoryLifecycle(Object.freeze({ ...failedCleanupPlan, environment: Object.freeze({ ...failedCleanupPlan.environment, PA_FEATURE_BRANCH: "feature/missing", PA_MERGE_EVIDENCE: `local:target=develop;merge_commit=${merge};ancestor=true;remote=${merge};verified=true`, PA_BRANCH_CLEANUP_LOCAL: "true" }) }));
    const failedResult = finalizeRepositoryLifecycle(failedCleanup);
    assert.equal(failedResult.ok, true);
    assert.match(failedResult.evidence?.branchCleanup?.result?.diagnostic ?? "", /cleanup failed.*lease release continued/is);
    assert.equal(existsSync(failedCleanup.repositoryLease?.leasePath ?? ""), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("cleanup never deletes a current or unmerged feature branch", () => {
  const f = fixture("cleanup-safety");
  try {
    git(f.repo, ["checkout", "-b", "feature/PAP-162-current"]);
    writeFileSync(join(f.repo, "change.txt"), "change\n");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-m", "change"]);
    const develop = git(f.repo, ["rev-parse", "develop"]);
    const evidence = `local:target=develop;merge_commit=${develop};ancestor=true;remote=${develop};verified=true`;
    assert.throws(() => cleanupMergedFeatureBranch(f.repo, "feature/PAP-162-current", evidence, { deleteLocal: true }), /Never delete currently checked-out branch/);
    git(f.repo, ["checkout", "develop"]);
    assert.throws(() => cleanupMergedFeatureBranch(f.repo, "feature/PAP-162-current", evidence, { deleteLocal: true }), /not merged/);
    assert.doesNotThrow(() => git(f.repo, ["rev-parse", "refs/heads/feature/PAP-162-current"]));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
