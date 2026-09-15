import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRepositoryMutationLease, appendRegistryEvent, captureRepositoryGitSnapshot, closeDb, finalizeRepositoryMutationBorrower, getDeploymentEvents, inspectRepositoryMutationBorrower, inspectRepositoryMutationLease, queryDeploymentStatus, readActivityEvents, registerRepositoryMutationBorrower, releaseRepositoryMutationLease, repositoryMutationBorrowerPath, repositoryMutationLeasePath } from "@pa-platform/pa-core";
import { PI_PARENT_LEASE_CAPABILITY_ENV, PI_REPOSITORY_HANDOFF_FILE, PiAdapter, PI_BACKGROUND_CONFIG_FILE, PI_SUPERVISOR_FILE, readPiBackgroundConfig, readPiSupervisorOwnership, writePiRepositoryHandoff, writePiSupervisorOwnership, type PiBackgroundConfig } from "../adapter.js";
import { runPiBackgroundRunner } from "../background-runner.js";
import { readPiTerminalStatus } from "../terminal-status.js";

class RunnerChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 81_001;
}

class LauncherProcess extends EventEmitter {
  readonly pid = 81_002;
  unref(): void {}
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withRunnerEnv(fn: (root: string, deployDir: string, config: PiBackgroundConfig) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-runner-"));
  const deployId = "d-runner-test";
  const deployDir = join(root, "deployments", deployId);
  mkdirSync(deployDir, { recursive: true });
  const primerPath = join(deployDir, "primer.md");
  writeFileSync(primerPath, "bounded runner objective");
  const previousHome = process.env["PA_AI_USAGE_HOME"];
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  const config: PiBackgroundConfig = {
    schemaVersion: 1,
    ownershipToken: "bounded-ownership-token",
    deploymentId: deployId,
    team: "builder",
    cwd: deployDir,
    primerPath,
    logFile: join(deployDir, "pi.log"),
    sessionId: "runner-session",
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    managed: false,
    skills: [],
  };
  appendRegistryEvent({ deployment_id: deployId, team: "builder", event: "started", timestamp: "2026-08-29T00:00:00.000Z", runtime: "pi", binary: "ppa", pid: 81_001, effective_timeout_seconds: 120 });
  try {
    await fn(root, deployDir, config);
  } finally {
    closeDb();
    restore("PA_AI_USAGE_HOME", previousHome);
    restore("PA_REGISTRY_DB", previousRegistry);
    rmSync(root, { recursive: true, force: true });
  }
}

function immediate(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

function runGit(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitPath(repo: string, argument: "--git-dir" | "--git-common-dir"): string {
  return runGit(repo, ["rev-parse", "--path-format=absolute", argument]);
}

function linkedRepository(root: string, branch: string): { primary: string; worktree: string; gitDir: string; gitCommonDir: string } {
  const primary = join(root, "primary");
  const worktree = join(root, "linked");
  mkdirSync(primary);
  runGit(primary, ["init", "-b", "develop"]);
  runGit(primary, ["config", "user.name", "Test"]);
  runGit(primary, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(primary, "README.md"), "# linked runner fixture\n");
  runGit(primary, ["add", "README.md"]);
  runGit(primary, ["commit", "-m", "initial"]);
  runGit(primary, ["worktree", "add", "-b", branch, worktree]);
  return { primary, worktree, gitDir: gitPath(worktree, "--git-dir"), gitCommonDir: gitPath(worktree, "--git-common-dir") };
}

function terminalEvents(deployId: string) {
  return getDeploymentEvents(deployId).filter((event) => event.event === "completed" || event.event === "crashed");
}

test("persistent runner publishes active ownership before finalizing one natural success", async () => {
  await withRunnerEnv(async (_root, deployDir, config) => {
    const child = new RunnerChild();
    const running = runPiBackgroundRunner(config, { supervision: { spawnProcess: (() => child as never) as never } });
    await immediate();
    const active = readPiSupervisorOwnership(join(deployDir, PI_SUPERVISOR_FILE));
    assert.equal(active?.state, "active");
    assert.equal(active?.ready, true);
    assert.equal(active?.supervisorPid, process.pid);
    assert.equal(active?.childPid, child.pid);

    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end", stopReason: "stop", timestamp: "2026-08-29T00:00:01.000Z" })}\n`));
    child.emit("close", 0);
    await running;

    const final = readPiSupervisorOwnership(join(deployDir, PI_SUPERVISOR_FILE));
    assert.equal(final?.state, "finalized");
    assert.equal(final?.terminalEvent, "completed");
    assert.equal(final?.terminalStatus, "success");
    assert.deepEqual(terminalEvents(config.deploymentId).map((event) => [event.event, event.status]), [["completed", "success"]]);
    assert.equal(queryDeploymentStatus(config.deploymentId)?.status, "success");
    assert.equal(readPiTerminalStatus(deployDir)?.stopReason, "stop");
  });
});

test("Pi background supervisor authenticates transfer before readiness and releases after terminal finalization", async () => {
  await withRunnerEnv(async (root, deployDir, config) => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    runGit(repo, ["init", "-b", "develop"]);
    runGit(repo, ["config", "user.name", "Test"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "README.md"), "# owner fixture\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial"]);
    const snapshot = { branch: "develop", head: "a".repeat(40), stagedCount: 0, unstagedCount: 0, untrackedCount: 0, dirty: false, statusSummary: "" } as const;
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform",
      canonicalRepoRoot: repo,
      deploymentId: config.deploymentId,
      deploymentDirectory: deployDir,
      runtime: "pi",
      mode: "implement",
      gitSnapshot: snapshot,
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    config.repositoryHandoffPath = join(deployDir, PI_REPOSITORY_HANDOFF_FILE);
    writePiRepositoryHandoff(config.repositoryHandoffPath, {
      schemaVersion: 1,
      deploymentId: config.deploymentId,
      repositoryLease: { canonicalRepoRoot: repo, repositoryGitDir: join(repo, ".git"), repositoryGitCommonDir: join(repo, ".git"), ownershipToken: acquired.lease.ownershipToken },
    });
    const child = new RunnerChild();
    const running = runPiBackgroundRunner(config, { supervision: { spawnProcess: (() => child as never) as never } });
    await immediate();
    const live = inspectRepositoryMutationLease(repo);
    assert.equal(live.state, "live");
    assert.equal(live.lease?.ownershipToken, acquired.lease.ownershipToken);
    assert.equal(live.lease?.processFingerprint.pid, process.pid);
    child.emit("close", 0);
    await running;
    assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
    assert.equal(readPiSupervisorOwnership(join(deployDir, PI_SUPERVISOR_FILE))?.state, "finalized");
  });
});

test("runner rejects and removes a hard-linked protected repository handoff before child spawn", async () => {
  await withRunnerEnv(async (root, deployDir, config) => {
    const handoffPath = join(deployDir, PI_REPOSITORY_HANDOFF_FILE);
    const externalLink = join(root, "retained-handoff-link");
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    config.repositoryHandoffPath = handoffPath;
    writePiRepositoryHandoff(handoffPath, {
      schemaVersion: 1,
      deploymentId: config.deploymentId,
      repositoryLease: { canonicalRepoRoot: repo, repositoryGitDir: join(repo, ".git"), repositoryGitCommonDir: join(repo, ".git"), ownershipToken: "protected-handoff-token" },
    });
    linkSync(handoffPath, externalLink);
    let spawns = 0;
    await runPiBackgroundRunner(config, { supervision: { spawnProcess: (() => { spawns += 1; return new RunnerChild() as never; }) as never } });
    assert.equal(spawns, 0);
    assert.equal(existsSync(handoffPath), false);
    assert.equal(existsSync(externalLink), true);
    assert.equal(queryDeploymentStatus(config.deploymentId)?.status, "crashed");
    assert.doesNotMatch(JSON.stringify(getDeploymentEvents(config.deploymentId)), /protected-handoff-token/);
  });
});

test("managed runner rejects repository handoff root disagreement before child spawn", async () => {
  await withRunnerEnv(async (root, deployDir, config) => {
    config.managed = true;
    config.repoRoot = join(root, "primary");
    config.worktreeRoot = join(root, "linked");
    config.cwd = config.worktreeRoot;
    config.repositorySlot = "implement";
    const admittedGitDir = join(root, "admitted-git-dir");
    const admittedGitCommonDir = join(root, "admitted-git-common-dir");
    mkdirSync(admittedGitDir);
    mkdirSync(admittedGitCommonDir);
    config.repositoryHandoffPath = join(deployDir, PI_REPOSITORY_HANDOFF_FILE);
    writePiRepositoryHandoff(config.repositoryHandoffPath, {
      schemaVersion: 1,
      deploymentId: config.deploymentId,
      repositoryLease: { canonicalRepoRoot: join(root, "wrong-primary"), worktreeRoot: config.worktreeRoot, repositoryGitDir: admittedGitDir, repositoryGitCommonDir: admittedGitCommonDir, slot: "implement", ownershipToken: "mismatched-root-token" },
    });
    let spawns = 0;
    await runPiBackgroundRunner(config, { supervision: { spawnProcess: (() => { spawns += 1; return new RunnerChild() as never; }) as never } });
    assert.equal(spawns, 0);
    assert.equal(existsSync(config.repositoryHandoffPath), false);
    assert.equal(queryDeploymentStatus(config.deploymentId)?.status, "crashed");
    assert.match(terminalEvents(config.deploymentId)[0]?.summary ?? "", /repository handoff roots or slot do not match/);
  });
});

test("runner rejects malformed or mismatched protected Git identity before child spawn", async () => {
  await withRunnerEnv(async (root, deployDir, config) => {
    const { primary, worktree, gitDir, gitCommonDir } = linkedRepository(root, "feature/PAP-195-handoff-mismatch");
    config.managed = true;
    config.repoRoot = primary;
    config.worktreeRoot = worktree;
    config.cwd = worktree;
    config.repositorySlot = "implement";
    config.repositoryHandoffPath = join(deployDir, PI_REPOSITORY_HANDOFF_FILE);
    writeFileSync(config.repositoryHandoffPath, `${JSON.stringify({
      schemaVersion: 1,
      deploymentId: config.deploymentId,
      repositoryLease: { canonicalRepoRoot: primary, worktreeRoot: worktree, repositoryGitDir: "relative", repositoryGitCommonDir: gitCommonDir, slot: "implement", ownershipToken: "malformed" },
    })}\n`, { mode: 0o600 });
    let spawns = 0;
    await runPiBackgroundRunner(config, { supervision: { spawnProcess: (() => { spawns += 1; return new RunnerChild() as never; }) as never } });
    assert.equal(spawns, 0);
    assert.equal(existsSync(config.repositoryHandoffPath), false);
    assert.match(terminalEvents(config.deploymentId)[0]?.summary ?? "", /repository handoff is malformed/);

    const alternateGitDir = join(root, "alternate-git-dir");
    const alternateCommonDir = join(root, "alternate-common-dir");
    mkdirSync(alternateGitDir);
    mkdirSync(alternateCommonDir);
    const secondDeployId = `${config.deploymentId}-identity`;
    appendRegistryEvent({ deployment_id: secondDeployId, team: "builder", event: "started", timestamp: "2026-08-29T00:00:00.000Z", runtime: "pi", binary: "ppa" });
    const mismatched = { ...config, deploymentId: secondDeployId };
    writePiRepositoryHandoff(mismatched.repositoryHandoffPath!, {
      schemaVersion: 1,
      deploymentId: secondDeployId,
      repositoryLease: { canonicalRepoRoot: primary, worktreeRoot: worktree, repositoryGitDir: alternateGitDir, repositoryGitCommonDir: alternateCommonDir, slot: "implement", ownershipToken: "mismatched" },
    });
    await runPiBackgroundRunner(mismatched, { supervision: { spawnProcess: (() => { spawns += 1; return new RunnerChild() as never; }) as never } });
    assert.equal(spawns, 0);
    assert.equal(existsSync(mismatched.repositoryHandoffPath!), false);
    assert.match(terminalEvents(secondDeployId)[0]?.summary ?? "", /protected repository handoff identity does not match/);
    assert.equal(existsSync(join(alternateGitDir, "pa-repository-mutation.implement.lease.json")), false);
    assert.notEqual(gitDir, alternateGitDir);
  });
});

test("owned linked-worktree runner fails closed on post-readiness Git-dir drift and cleans only admitted authority", async () => {
  await withRunnerEnv(async (root, deployDir, config) => {
    const { primary, worktree, gitDir, gitCommonDir } = linkedRepository(root, "feature/PAP-195-owned-drift");
    const snapshot = captureRepositoryGitSnapshot(worktree);
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: primary, worktreeRoot: worktree,
      expectedGitDir: gitDir, expectedGitCommonDir: gitCommonDir, deploymentId: config.deploymentId,
      deploymentDirectory: deployDir, runtime: "pi", team: "builder", mode: "implement", launchMode: "background", gitSnapshot: snapshot,
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    config.managed = true;
    config.repoRoot = primary;
    config.worktreeRoot = worktree;
    config.cwd = worktree;
    config.repositorySlot = "implement";
    config.repositoryHandoffPath = join(deployDir, PI_REPOSITORY_HANDOFF_FILE);
    writePiRepositoryHandoff(config.repositoryHandoffPath, {
      schemaVersion: 1, deploymentId: config.deploymentId,
      repositoryLease: { canonicalRepoRoot: primary, worktreeRoot: worktree, repositoryGitDir: gitDir, repositoryGitCommonDir: gitCommonDir, slot: "implement", ownershipToken: acquired.lease.ownershipToken },
    });
    const originalLeasePath = repositoryMutationLeasePath(worktree, "implement");
    const replacementGitDir = join(root, "replacement-git-dir");
    cpSync(gitDir, replacementGitDir, { recursive: true });
    const replacementLeasePath = join(replacementGitDir, "pa-repository-mutation.implement.lease.json");
    const replacementBytes = Buffer.from("unrelated replacement authority\n");
    writeFileSync(replacementLeasePath, replacementBytes, { mode: 0o600 });
    const child = new RunnerChild();
    const running = runPiBackgroundRunner(config, { supervision: { spawnProcess: (() => child as never) as never } });
    await immediate();
    assert.equal(readPiSupervisorOwnership(join(deployDir, PI_SUPERVISOR_FILE))?.state, "active");
    writeFileSync(join(worktree, ".git"), `gitdir: ${replacementGitDir}\n`);
    child.emit("close", 0);
    await running;

    const terminal = terminalEvents(config.deploymentId);
    assert.equal(terminal.length, 1);
    assert.deepEqual(terminal.map((event) => [event.event, event.status]), [["crashed", null]]);
    assert.equal(queryDeploymentStatus(config.deploymentId)?.status, "crashed");
    assert.match(terminal[0]?.summary ?? "", /repository metadata identity drift/);
    assert.ok((terminal[0]?.summary ?? "").length <= 2_000);
    assert.equal(existsSync(originalLeasePath), false);
    assert.deepEqual(readFileSync(replacementLeasePath), replacementBytes);
    assert.equal(readPiSupervisorOwnership(join(deployDir, PI_SUPERVISOR_FILE))?.state, "failed");
  });
});

test("borrowed linked-worktree runner fails closed on post-readiness common-dir drift and preserves parent and unrelated evidence", async () => {
  await withRunnerEnv(async (root, deployDir, config) => {
    const { primary, worktree, gitDir, gitCommonDir } = linkedRepository(root, "feature/PAP-195-borrowed-drift");
    const snapshot = captureRepositoryGitSnapshot(worktree);
    const parentDeploymentId = "d-parent-common-drift";
    const parentDir = join(root, "deployments", parentDeploymentId);
    mkdirSync(parentDir, { recursive: true });
    const parent = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: primary, worktreeRoot: worktree,
      expectedGitDir: gitDir, expectedGitCommonDir: gitCommonDir, deploymentId: parentDeploymentId,
      deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", gitSnapshot: snapshot,
    });
    assert.equal(parent.status, "acquired");
    if (parent.status !== "acquired") return;
    appendRegistryEvent({ deployment_id: parentDeploymentId, team: "builder", event: "started", timestamp: "2026-08-29T00:00:00.000Z", runtime: "pi", binary: "ppa" });
    const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    assert.ok(launcher.pid);
    try {
      const registration = registerRepositoryMutationBorrower({
        capability: parent.lease.ownershipToken, canonicalRepoKey: "pa-platform", canonicalRepoRoot: primary, worktreeRoot: worktree,
        expectedGitDir: gitDir, expectedGitCommonDir: gitCommonDir, parentDeploymentId, deploymentId: config.deploymentId,
        deploymentDirectory: deployDir, runtime: "pi", team: "builder", mode: "implement", launchMode: "background",
        ticket: "PAP-195", branch: snapshot.branch, timeoutSeconds: 60, pid: launcher.pid, expectedGitSnapshot: snapshot, gitSnapshot: snapshot,
      });
      assert.equal(registration.status, "registered");
      if (registration.status !== "registered") return;
      config.managed = true;
      config.repoRoot = primary;
      config.worktreeRoot = worktree;
      config.cwd = worktree;
      config.repositorySlot = "implement";
      config.repositoryHandoffPath = join(deployDir, PI_REPOSITORY_HANDOFF_FILE);
      writePiRepositoryHandoff(config.repositoryHandoffPath, {
        schemaVersion: 1, deploymentId: config.deploymentId,
        repositoryBorrower: { canonicalRepoRoot: primary, worktreeRoot: worktree, repositoryGitDir: gitDir, repositoryGitCommonDir: gitCommonDir, borrowerToken: registration.borrower.borrowerToken, parentDeploymentId, deploymentId: config.deploymentId },
      });
      const parentLeasePath = repositoryMutationLeasePath(worktree);
      const parentBytes = readFileSync(parentLeasePath);
      const originalCommonPointer = readFileSync(join(gitDir, "commondir"), "utf8");
      const replacementCommonDir = join(root, "replacement-common-dir");
      cpSync(gitCommonDir, replacementCommonDir, { recursive: true });
      const unrelatedPath = join(replacementCommonDir, "unrelated-authority.json");
      const unrelatedBytes = Buffer.from("unrelated common-dir evidence\n");
      writeFileSync(unrelatedPath, unrelatedBytes, { mode: 0o600 });
      const child = new RunnerChild();
      const running = runPiBackgroundRunner(config, { supervision: { spawnProcess: (() => child as never) as never } });
      await immediate();
      assert.equal(inspectRepositoryMutationBorrower(primary, { worktreeRoot: worktree, repositoryGitDir: gitDir, getProcessFingerprint: () => undefined }).borrower?.borrowerToken, registration.borrower.borrowerToken);
      writeFileSync(join(gitDir, "commondir"), `${replacementCommonDir}\n`);
      child.emit("close", 0);
      await running;

      const terminal = terminalEvents(config.deploymentId);
      assert.equal(terminal.length, 1);
      assert.deepEqual(terminal.map((event) => [event.event, event.status]), [["crashed", null]]);
      assert.equal(queryDeploymentStatus(config.deploymentId)?.status, "crashed");
      assert.match(terminal[0]?.summary ?? "", /repository metadata identity drift/);
      assert.equal(existsSync(repositoryMutationBorrowerPath(worktree)), false);
      assert.deepEqual(readFileSync(parentLeasePath), parentBytes);
      assert.deepEqual(readFileSync(unrelatedPath), unrelatedBytes);
      writeFileSync(join(gitDir, "commondir"), originalCommonPointer);
      assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: primary, worktreeRoot: worktree, repositoryGitDir: gitDir, ownershipToken: parent.lease.ownershipToken }).status, "released");
    } finally {
      launcher.kill("SIGKILL");
      await new Promise<void>((resolve) => launcher.once("close", () => resolve()));
    }
  });
});

test("background orchestrator runner waits for child finalization before releasing its parent lease", async () => {
  await withRunnerEnv(async (root, deployDir, config) => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    runGit(repo, ["init", "-b", "develop"]);
    runGit(repo, ["config", "user.name", "Test"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "README.md"), "# parent fixture\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial"]);
    const snapshot = { branch: "feature/PAP-191-background-parent", head: "c".repeat(40), stagedCount: 0, unstagedCount: 0, untrackedCount: 0, dirty: false, statusSummary: "" } as const;
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: config.deploymentId,
      deploymentDirectory: deployDir, runtime: "pi", team: "builder", mode: "orchestrator", gitSnapshot: snapshot,
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    config.repositoryHandoffPath = join(deployDir, PI_REPOSITORY_HANDOFF_FILE);
    writePiRepositoryHandoff(config.repositoryHandoffPath, {
      schemaVersion: 1,
      deploymentId: config.deploymentId,
      repositoryLease: { canonicalRepoRoot: repo, repositoryGitDir: join(repo, ".git"), repositoryGitCommonDir: join(repo, ".git"), ownershipToken: acquired.lease.ownershipToken },
    });
    const parentBytes = readFileSync(repositoryMutationLeasePath(repo));
    const child = new RunnerChild();
    let borrowerToken = "";
    const running = runPiBackgroundRunner(config, { supervision: {
      spawnProcess: (() => child as never) as never,
      onSpawn: () => {
        const registration = registerRepositoryMutationBorrower({
          capability: acquired.lease.ownershipToken, canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo,
          parentDeploymentId: config.deploymentId, deploymentId: "d-background-child", deploymentDirectory: join(root, "child"),
          runtime: "pi", team: "builder", mode: "implement", launchMode: "background", ticket: "PAP-191",
          branch: snapshot.branch, timeoutSeconds: 60, gitSnapshot: snapshot,
        });
        assert.equal(registration.status, "registered");
        if (registration.status !== "registered") return;
        borrowerToken = registration.borrower.borrowerToken;
      },
    } });
    await immediate();
    assert.equal(inspectRepositoryMutationBorrower(repo).state, "live");
    child.emit("close", 0);
    const childFinalization = new Promise<void>((resolve) => setImmediate(() => {
      assert.deepEqual(readFileSync(repositoryMutationLeasePath(repo)), parentBytes);
      const finalized = finalizeRepositoryMutationBorrower({
        canonicalRepoRoot: repo, borrowerToken,
        deploymentId: "d-background-child", finalGitSnapshot: snapshot,
      });
      assert.equal(finalized.status, "finalized");
      resolve();
    }));
    await running;
    await childFinalization;
    assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
    assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
  });
});

test("borrowed runner transfers process identity, scrubs implementation env/config, and preserves parent lease bytes", async () => {
  await withRunnerEnv(async (root, deployDir, config) => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const initialized = spawnSync("git", ["init", "-b", "feature/PAP-191-runner-test"], { cwd: repo, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    writeFileSync(join(repo, "README.md"), "# Synthetic borrower fixture\n");
    assert.equal(spawnSync("git", ["add", "README.md"], { cwd: repo }).status, 0);
    const committed = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repo, encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
    const snapshot = { branch: "feature/PAP-191-runner-test", head: "b".repeat(40), stagedCount: 0, unstagedCount: 0, untrackedCount: 0, dirty: false, statusSummary: "" } as const;
    const parentDeploymentId = "d-parent-runner";
    const parentDir = join(root, "deployments", parentDeploymentId);
    mkdirSync(parentDir, { recursive: true });
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: parentDeploymentId,
      deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator", gitSnapshot: snapshot,
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    const capability = acquired.lease.ownershipToken;
    appendRegistryEvent({ deployment_id: parentDeploymentId, team: "builder", event: "started", timestamp: "2026-08-29T00:00:00.000Z", runtime: "pi", binary: "ppa" });
    const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    assert.ok(launcher.pid);
    const registration = registerRepositoryMutationBorrower({
      capability, canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, parentDeploymentId,
      deploymentId: config.deploymentId, deploymentDirectory: deployDir, runtime: "pi", team: "builder",
      mode: "implement", launchMode: "background", ticket: "PAP-191", branch: snapshot.branch, timeoutSeconds: 60,
      pid: launcher.pid, gitSnapshot: snapshot,
    });
    assert.equal(registration.status, "registered");
    if (registration.status !== "registered") return;
    config.repositoryHandoffPath = join(deployDir, PI_REPOSITORY_HANDOFF_FILE);
    const repositoryBorrower = {
      canonicalRepoRoot: repo,
      repositoryGitDir: gitPath(repo, "--git-dir"),
      repositoryGitCommonDir: gitPath(repo, "--git-common-dir"),
      borrowerToken: registration.borrower.borrowerToken,
      parentDeploymentId,
      deploymentId: config.deploymentId,
      approvedMutationPaths: registration.borrower.approvedMutationPaths,
    };
    writePiRepositoryHandoff(config.repositoryHandoffPath, { schemaVersion: 1, deploymentId: config.deploymentId, repositoryBorrower });
    const parentBytes = readFileSync(repositoryMutationLeasePath(repo));
    const previousCapability = process.env[PI_PARENT_LEASE_CAPABILITY_ENV];
    process.env[PI_PARENT_LEASE_CAPABILITY_ENV] = capability;
    const child = new RunnerChild();
    let runtimeEnvironment: NodeJS.ProcessEnv | undefined;
    try {
      const running = runPiBackgroundRunner(config, { supervision: { spawnProcess: ((_command, _args, options) => {
        runtimeEnvironment = options.env;
        const borrower = inspectRepositoryMutationBorrower(repo);
        assert.equal(borrower.state, "live");
        assert.equal(borrower.borrower?.processFingerprint.pid, process.pid);
        assert.deepEqual(readFileSync(repositoryMutationLeasePath(repo)), parentBytes);
        return child as never;
      }) as never } });
      await immediate();
      assert.equal(runtimeEnvironment?.[PI_PARENT_LEASE_CAPABILITY_ENV], undefined);
      assert.equal(statSync(repositoryMutationBorrowerPath(repo)).mode & 0o777, 0o600);
      child.emit("close", 0);
      await running;
      assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
      assert.deepEqual(readFileSync(repositoryMutationLeasePath(repo)), parentBytes);
      assert.doesNotMatch(JSON.stringify(getDeploymentEvents(config.deploymentId)), new RegExp(capability));
      assert.doesNotMatch(JSON.stringify(readActivityEvents(join(deployDir, "activity.jsonl"))), new RegExp(capability));

      let persistedConfig = "";
      let persistedHandoff = "";
      let handoffMode = 0;
      let supervisorEnvironment: NodeJS.ProcessEnv | undefined;
      const backgroundLauncher = new LauncherProcess();
      const adapter = new PiAdapter({
        cwd: deployDir,
        env: { ...process.env, [PI_PARENT_LEASE_CAPABILITY_ENV]: capability, PA_TEAM: "builder" },
        versionProbe: () => "0.84.4",
        nativeRegistryProbe: () => undefined,
        supervision: {
          launchBackgroundRunner: ((_runnerPath, configPath, options) => {
            persistedConfig = readFileSync(configPath, "utf8");
            const parsedConfig = readPiBackgroundConfig(configPath);
            persistedHandoff = readFileSync(parsedConfig.repositoryHandoffPath!, "utf8");
            handoffMode = statSync(parsedConfig.repositoryHandoffPath!).mode & 0o777;
            rmSync(parsedConfig.repositoryHandoffPath!);
            supervisorEnvironment = options.env;
            const parsed = readPiBackgroundConfig(configPath);
            writePiSupervisorOwnership(join(deployDir, PI_SUPERVISOR_FILE), {
              schemaVersion: 1, deploymentId: parsed.deploymentId, ownershipToken: parsed.ownershipToken,
              state: "active", ready: true, supervisorPid: backgroundLauncher.pid, updatedAt: new Date().toISOString(), finalizationDeadlineMs: 5_000,
            });
            return backgroundLauncher as never;
          }),
        },
      });
      const launched = await adapter.spawn({
        primerPath: config.primerPath, deployId: config.deploymentId, mode: "background", sessionId: config.sessionId,
        repositoryBorrower,
        executionPlan: {
          runtime: "pi", team: "builder", mode: "implement", repoRoot: repo, worktreeRoot: repo,
          repositoryCwd: repo, repositoryGitDir: repositoryBorrower.repositoryGitDir,
          repositoryGitCommonDir: repositoryBorrower.repositoryGitCommonDir, repositoryAdmission: {}, skills: [],
        } as never,
      });
      assert.equal(launched.exitCode, 0, launched.errorMessage);
      assert.equal(launched.metadata?.["repositoryBorrowerTransferred"], true);
      assert.equal(supervisorEnvironment?.[PI_PARENT_LEASE_CAPABILITY_ENV], undefined);
      assert.doesNotMatch(persistedConfig, new RegExp(capability));
      assert.doesNotMatch(persistedConfig, new RegExp(registration.borrower.borrowerToken));
      assert.equal(persistedConfig.includes(repositoryBorrower.repositoryGitDir), false);
      assert.equal(persistedConfig.includes(repositoryBorrower.repositoryGitCommonDir), false);
      assert.doesNotMatch(persistedHandoff, new RegExp(capability));
      assert.match(persistedHandoff, new RegExp(registration.borrower.borrowerToken));
      assert.equal(persistedHandoff.includes(repositoryBorrower.repositoryGitDir), true);
      assert.equal(persistedHandoff.includes(repositoryBorrower.repositoryGitCommonDir), true);
      assert.equal(handoffMode, 0o600);
    } finally {
      if (previousCapability === undefined) delete process.env[PI_PARENT_LEASE_CAPABILITY_ENV]; else process.env[PI_PARENT_LEASE_CAPABILITY_ENV] = previousCapability;
      launcher.kill("SIGKILL");
      await new Promise<void>((resolve) => launcher.once("close", () => resolve()));
      assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, ownershipToken: capability }).status, "released");
    }
  });
});

test("runner failure replaces premature agent success once and keeps process category bounded", async () => {
  await withRunnerEnv(async (_root, deployDir, config) => {
    const secret = "runner-sensitive-sentinel";
    const child = new RunnerChild();
    appendRegistryEvent({ deployment_id: config.deploymentId, team: config.team, event: "completed", timestamp: "2026-08-29T00:00:01.000Z", status: "success", summary: "agent claimed success", exit_code: 0 });
    const running = runPiBackgroundRunner(config, { supervision: { spawnProcess: (() => child as never) as never } });
    await immediate();
    child.stderr.emit("data", Buffer.from(`process failed ${secret}`));
    child.emit("close", 17);
    await running;

    const terminal = terminalEvents(config.deploymentId);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.event, "completed");
    assert.equal(terminal[0]?.status, "failed");
    assert.equal(terminal[0]?.exit_code, 17);
    assert.match(terminal[0]?.summary ?? "", /runner-process:/);
    assert.ok((terminal[0]?.summary ?? "").length <= 2000);
    assert.equal(readPiTerminalStatus(deployDir)?.stopReason, "error");
    assert.equal(readPiSupervisorOwnership(join(deployDir, PI_SUPERVISOR_FILE))?.terminalStatus, "failed");
  });
});

test("runner preserves spawn category and one terminal event when child emits error", async () => {
  await withRunnerEnv(async (_root, deployDir, config) => {
    const child = new RunnerChild();
    const running = runPiBackgroundRunner(config, { supervision: { spawnProcess: (() => child as never) as never } });
    await immediate();
    child.emit("error", new Error("spawn fixture unavailable"));
    await running;
    const terminal = terminalEvents(config.deploymentId);
    assert.equal(terminal.length, 1);
    assert.match(terminal[0]?.summary ?? "", /runner-spawn: spawn fixture unavailable/);
    assert.equal(readPiTerminalStatus(deployDir)?.stopReason, "error");
    assert.ok(readActivityEvents(join(deployDir, "activity.jsonl")).every((event) => event.body.length <= 500));
  });
});

test("readiness timeout is causal and bounded config never persists inherited secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runner-readiness-"));
  const primer = join(root, "primer.md");
  const secret = "readiness-sensitive-sentinel";
  writeFileSync(primer, "bounded objective");
  let clock = 0;
  let configBody = "";
  const launcher = new LauncherProcess();
  const adapter = new PiAdapter({
    cwd: root,
    env: { ...process.env, PAP_156_SECRET: secret, PA_TEAM: "builder" },
    versionProbe: () => "0.84.4",
    nativeRegistryProbe: () => undefined,
    supervision: {
      launchBackgroundRunner: ((_path, configPath) => {
        configBody = readFileSync(configPath, "utf8");
        return launcher as never;
      }),
      readinessNow: () => clock,
      readinessSleep: async (milliseconds) => { clock += milliseconds; },
      readinessTimeoutMs: 100,
    },
  });
  try {
    const result = await adapter.spawn({ primerPath: primer, deployId: "d-readiness", mode: "background", sessionId: "readiness-session" });
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /^runner-readiness: ownership was not established within 100ms$/);
    assert.ok((result.errorMessage ?? "").length <= 2000);
    assert.doesNotMatch(configBody, new RegExp(secret));
    assert.doesNotMatch(result.errorMessage ?? "", new RegExp(secret));
    assert.equal(existsSync(join(root, PI_BACKGROUND_CONFIG_FILE)), false);

    const readFailure = new PiAdapter({ cwd: root, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: {
      launchBackgroundRunner: (() => new LauncherProcess() as never),
      readBackgroundOwnership: () => { throw new Error("ownership fixture unreadable"); },
    } });
    const unreadable = await readFailure.spawn({ primerPath: primer, deployId: "d-read-error", mode: "background", sessionId: "read-error-session" });
    assert.equal(unreadable.exitCode, 1);
    assert.match(unreadable.errorMessage ?? "", /^runner-readiness: ownership fixture unreadable$/);
    assert.equal(existsSync(join(root, PI_BACKGROUND_CONFIG_FILE)), false);

    const launcherFailure = new PiAdapter({ cwd: root, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, secretValues: [secret], supervision: {
      launchBackgroundRunner: (() => { throw new Error(`launcher fixture failed ${secret}`); }),
    } });
    const failed = await launcherFailure.spawn({ primerPath: primer, deployId: "d-launcher", mode: "background", sessionId: "launcher-session" });
    assert.equal(failed.exitCode, 1);
    assert.match(failed.errorMessage ?? "", /^runner-launcher: launcher fixture failed/);
    assert.doesNotMatch(failed.errorMessage ?? "", new RegExp(secret));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readiness timeout escalates a resistant runner and removes only its owned config", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runner-readiness-resistant-"));
  const primer = join(root, "primer.md");
  writeFileSync(primer, "bounded objective");
  const launcher = new LauncherProcess();
  let clock = 0;
  let gone = false;
  const signals: NodeJS.Signals[] = [];
  const adapter = new PiAdapter({ cwd: root, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: {
    launchBackgroundRunner: (() => launcher as never),
    readinessNow: () => clock,
    readinessSleep: async (milliseconds) => { clock += milliseconds; },
    readinessTimeoutMs: 100,
    processGroupGone: () => gone,
    sendSignal: (_pid, signal) => { signals.push(signal); if (signal === "SIGKILL") gone = true; },
  } });
  try {
    const result = await adapter.spawn({ primerPath: primer, deployId: "d-readiness-resistant", mode: "background", sessionId: "readiness-resistant-session" });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(existsSync(join(root, PI_BACKGROUND_CONFIG_FILE)), false);
    assert.ok(clock < 5_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launcher process exits after handoff while the persistent runner owns completion", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runner-boundary-"));
  const bin = join(root, "bin");
  const deployDir = join(root, "deployments", "d-boundary");
  mkdirSync(bin, { recursive: true });
  mkdirSync(deployDir, { recursive: true });
  const fakePi = join(bin, "pi");
  writeFileSync(fakePi, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.84.4; exit 0; fi\nsleep 0.5\nprintf '%s\\n' '{\"type\":\"agent_end\",\"stopReason\":\"stop\",\"timestamp\":\"2026-08-29T00:00:01.000Z\"}'\n");
  chmodSync(fakePi, 0o755);
  const primer = join(deployDir, "primer.md");
  writeFileSync(primer, "process boundary objective");
  const launcherPath = join(root, "launcher.mjs");
  const adapterUrl = new URL("../adapter.ts", import.meta.url).href;
  const runnerUrl = new URL("../background-runner.ts", import.meta.url).href;
  const tsxLoader = import.meta.resolve("tsx");
  const runnerWrapper = join(root, "runner-wrapper.mjs");
  writeFileSync(runnerWrapper, [
    `import { readPiBackgroundConfig } from ${JSON.stringify(adapterUrl)};`,
    `import { runPiBackgroundRunner } from ${JSON.stringify(runnerUrl)};`,
    `await runPiBackgroundRunner(readPiBackgroundConfig(process.argv[2]));`,
  ].join("\n"));
  writeFileSync(launcherPath, [
    `import { spawn } from "node:child_process";`,
    `import { PiAdapter } from ${JSON.stringify(adapterUrl)};`,
    `const adapter = new PiAdapter({ cwd: ${JSON.stringify(deployDir)}, nativeRegistryProbe: () => undefined, supervision: { launchBackgroundRunner: (_ignored, configPath, options) => spawn(process.execPath, ["--import", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(runnerWrapper)}, configPath], { ...options, detached: true, stdio: ["ignore", "ignore", "inherit"] }) } });`,
    `const result = await adapter.spawn({ primerPath: ${JSON.stringify(primer)}, deployId: "d-boundary", mode: "background", sessionId: "boundary-session", logFile: ${JSON.stringify(join(deployDir, "pi.log"))} });`,
    `process.stdout.write(JSON.stringify(result));`,
  ].join("\n"));
  const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), PA_TEAM: "builder" };
  try {
    const launcher = spawn(process.execPath, ["--import", "tsx", launcherPath], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    launcher.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    launcher.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const launcherCode = await new Promise<number | null>((resolve) => launcher.once("close", resolve));
    assert.equal(launcherCode, 0, stderr);
    const result = JSON.parse(stdout) as { exitCode: number; metadata?: Record<string, unknown> };
    assert.equal(result.exitCode, 0, stdout);
    assert.equal(result.metadata?.["pending"], true);
    assert.equal(typeof result.metadata?.["supervisorPid"], "number");
    assert.notEqual(result.metadata?.["supervisorPid"], launcher.pid);

    const ownershipPath = join(deployDir, PI_SUPERVISOR_FILE);
    let ownership = readPiSupervisorOwnership(ownershipPath);
    assert.equal(ownership?.ready, true);
    assert.equal(ownership?.supervisorPid, result.metadata?.["supervisorPid"]);
    assert.notEqual(ownership?.supervisorPid, launcher.pid);
    assert.ok(["active", "finalizing", "finalized"].includes(ownership?.state ?? ""));

    // This parallel tsx process test is functional only. The release-blocking
    // <5 s public caller limit and <=4 s material-margin target are measured
    // against installed output by pap-156-caller-boundary-smoke.mjs.
    while (ownership?.state !== "finalized") {
      await new Promise((resolve) => setTimeout(resolve, 25));
      ownership = readPiSupervisorOwnership(ownershipPath);
    }
    assert.equal(ownership.terminalStatus, "success");
    assert.equal(readPiTerminalStatus(deployDir)?.stopReason, "stop");
    const coreUrl = import.meta.resolve("@pa-platform/pa-core");
    const registry = spawnSync(process.execPath, ["--input-type=module", "--eval", `const core = await import(${JSON.stringify(coreUrl)}); const terminal = core.getDeploymentEvents("d-boundary").filter((event) => event.event === "completed" || event.event === "crashed"); process.stdout.write(JSON.stringify(terminal));`], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(registry.status, 0, registry.stderr);
    const terminal = JSON.parse(registry.stdout) as Array<{ event: string; status?: string }>;
    assert.deepEqual(terminal.map((event) => [event.event, event.status]), [["completed", "success"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner persistence failure cleans up and retains the persistence category", async () => {
  await withRunnerEnv(async (_root, _deployDir, config) => {
    const child = new RunnerChild();
    let now = 0;
    let gone = false;
    const running = runPiBackgroundRunner(config, { supervision: {
      spawnProcess: (() => child as never) as never,
      persistLine: () => { throw new Error("persistence fixture failed"); },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      processGroupGone: () => gone,
      sendSignal: (_pid, signal) => {
        if (signal === "SIGKILL") { gone = true; child.emit("close", 137); }
      },
    } });
    await immediate();
    child.stdout.emit("data", Buffer.from('{"type":"message","text":"persist me"}\n'));
    await running;
    const terminal = terminalEvents(config.deploymentId);
    assert.equal(terminal.length, 1);
    assert.match(terminal[0]?.summary ?? "", /runner-persistence: persistence fixture failed/);
  });
});

test("runner timeout owns escalation and retains the timeout category", async () => {
  await withRunnerEnv(async (_root, deployDir, baseConfig) => {
    const config = { ...baseConfig, timeoutMs: 1 };
    const child = new RunnerChild();
    let timeoutCallback: (() => void) | undefined;
    let now = 0;
    let gone = false;
    const signals: NodeJS.Signals[] = [];
    const running = runPiBackgroundRunner(config, { supervision: {
      spawnProcess: (() => child as never) as never,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      setTimeout: (callback) => { timeoutCallback = callback; return {} as NodeJS.Timeout; },
      clearTimeout: () => {},
      processGroupGone: () => gone,
      sendSignal: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") { gone = true; child.emit("close", 137); }
      },
    } });
    await immediate();
    timeoutCallback?.();
    await running;
    const terminal = terminalEvents(config.deploymentId);
    assert.equal(terminal.length, 1);
    assert.match(terminal[0]?.summary ?? "", /runner-timeout:/);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(readPiSupervisorOwnership(join(deployDir, PI_SUPERVISOR_FILE))?.terminalStatus, "failed");
  });
});

test("runner shutdown escalates a TERM-resistant process group and finalizes exactly once", async () => {
  await withRunnerEnv(async (_root, deployDir, config) => {
    const child = new RunnerChild();
    const shutdown = new AbortController();
    let now = 0;
    let gone = false;
    const signals: NodeJS.Signals[] = [];
    const running = runPiBackgroundRunner(config, { shutdownSignal: shutdown.signal, supervision: {
      spawnProcess: (() => child as never) as never,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      processGroupGone: () => gone,
      sendSignal: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") { gone = true; child.emit("close", 137); }
      },
    } });
    await immediate();
    shutdown.abort("SIGTERM");
    await running;
    const terminal = terminalEvents(config.deploymentId);
    assert.equal(terminal.length, 1);
    assert.match(terminal[0]?.summary ?? "", /runner-shutdown:.*SIGTERM/);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(readPiSupervisorOwnership(join(deployDir, PI_SUPERVISOR_FILE))?.terminalStatus, "failed");
    assert.ok(now < 5_000);
  });
});
