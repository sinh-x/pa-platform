import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquireRepositoryMutationLease, appendRegistryEvent, captureRepositoryGitSnapshot, closeDb, composeRuntimeHooks, createAgentApiApp, finalizeRepositoryMutationBorrower, getDeployPaths, getDeploymentEvents, inspectRepositoryMutationBorrower, inspectRepositoryMutationLease, publishRepositoryDirtyBorrowApproval, queryDeploymentStatus, queryDeploymentStatuses, readActivityEvents, readProcessFingerprint, registerRepositoryMutationBorrower, releaseRepositoryMutationLease, repositoryGitSnapshotsEqual, repositoryMutationBorrowerPath, repositoryMutationLeasePath, runCoreCommand, transferRepositoryMutationBorrower, type RepositoryDirtyBorrowApproval, type RuntimeAdapter, type SpawnOpts, type SpawnResult } from "@pa-platform/pa-core";
import { PI_PARENT_LEASE_CAPABILITY_ENV, PiAdapter, PI_SUPERVISOR_FILE, readPiBackgroundConfig, readPiRepositoryHandoff, writePiSupervisorOwnership, type PiBackgroundConfig } from "../adapter.js";
import { runPiBackgroundRunner } from "../background-runner.js";
import { createPiHooks, deployWithPi, piSessionCommand } from "../deploy.js";
import { deployWithOpencode } from "../../../opencode-pa/src/deploy.js";
import { resolvePiRuntimeConfig } from "../runtime-normalization.js";
import { PI_FOREGROUND_COMPLETION_FILE, readPiForegroundCompletion, readPiTerminalStatus, writePiForegroundCompletion, writePiTerminalStatus } from "../terminal-status.js";
import { assertBuilderExclusiveRepositoryAdmission, installGitStateRecorder, type GitStateRecorder } from "../../../../test/helpers/git-state-recorder.js";

function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function markParentRunning(deploymentId: string): void {
  appendRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "started", timestamp: new Date().toISOString(), runtime: "pi", binary: "ppa" });
}

function initializeGitRepo(path: string): void {
  mkdirSync(path);
  git(["init", "-b", "develop"], path);
  git(["config", "user.email", "test@example.com"], path);
  git(["config", "user.name", "Test"], path);
  writeFileSync(join(path, "README.md"), "# Test\n");
  git(["add", "README.md"], path);
  git(["commit", "-m", "initial"], path);
}

type PreflightGitDrift = "branch" | "head" | "staged" | "unstaged" | "untracked";
type PreflightMetadataDrift = "git-dir" | "common-dir";

function applyPreflightGitDrift(worktree: string, drift: PreflightGitDrift): void {
  switch (drift) {
    case "branch":
      git(["checkout", "-b", "feature/PAP-195-preflight-branch"], worktree);
      break;
    case "head":
      git(["commit", "--allow-empty", "-m", "preflight head drift"], worktree);
      break;
    case "staged":
      writeFileSync(join(worktree, "preflight-staged.txt"), "staged during preflight\n");
      git(["add", "preflight-staged.txt"], worktree);
      break;
    case "unstaged":
      writeFileSync(join(worktree, "README.md"), "# changed during preflight\n");
      break;
    case "untracked":
      writeFileSync(join(worktree, "preflight-untracked.txt"), "untracked during preflight\n");
      break;
  }
}

function preparePreflightMetadataDrift(root: string, worktree: string, drift: PreflightMetadataDrift): { gitDir: string; apply: () => void; restore: () => void } {
  const dotGitPath = join(worktree, ".git");
  const originalDotGit = readFileSync(dotGitPath, "utf8");
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], worktree);
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree);
  const originalCommonPointer = readFileSync(join(gitDir, "commondir"), "utf8");
  if (drift === "git-dir") {
    const replacementGitDir = join(root, `replacement-${drift}`);
    cpSync(gitDir, replacementGitDir, { recursive: true });
    writeFileSync(join(replacementGitDir, "commondir"), `${commonDir}\n`);
    return {
      gitDir,
      apply: () => { writeFileSync(dotGitPath, `gitdir: ${replacementGitDir}\n`); },
      restore: () => { writeFileSync(dotGitPath, originalDotGit); },
    };
  }
  const replacementCommonDir = join(root, `replacement-${drift}`);
  cpSync(commonDir, replacementCommonDir, { recursive: true });
  return {
    gitDir,
    apply: () => { writeFileSync(join(gitDir, "commondir"), `${replacementCommonDir}\n`); },
    restore: () => { writeFileSync(join(gitDir, "commondir"), originalCommonPointer); },
  };
}

function withPiEnv(fn: (root: string, gitState: GitStateRecorder) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ppa-deploy-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  initializeGitRepo(repo);
  writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\n`);
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n`);
  writeFileSync(join(teams, "builder.yaml"), [
    "name: builder",
    "description: Builder",
    "objective: Build",
    "agents:",
    "  - name: builder-agent",
    "    role: Builds",
    "deploy_modes:",
    "  - id: implement",
    "    label: Implement",
    "  - id: orchestrator",
    "    label: Orchestrator",
  ].join("\n") + "\n");
  writeFileSync(join(teams, "requirements.yaml"), [
    "name: requirements",
    "description: Requirements",
    "objective: Analyze",
    "agents:",
    "  - name: researcher",
    "    role: Researches",
    "deploy_modes:",
    "  - id: analyze",
    "    label: Analyze",
  ].join("\n") + "\n");
  const previous = Object.fromEntries(["PA_PLATFORM_CONFIG", "PA_PLATFORM_TEAMS", "PA_REGISTRY_DB", "PA_AI_USAGE_HOME", "PA_MAX_RUNTIME", "PATH"].map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  const gitState = installGitStateRecorder(root);
  const previousCwd = process.cwd();
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PATH"] = `${gitState.binDir}:${previous["PATH"] ?? ""}`;
  delete process.env["PA_MAX_RUNTIME"];
  process.chdir(repo);
  return fn(root, gitState).finally(() => {
    process.chdir(previousCwd);
    closeDb();
    for (const [key, value] of Object.entries(previous)) restore(key, value);
    rmSync(root, { recursive: true, force: true });
  });
}

function stubAdapter(options: { preflight?: () => Promise<void>; result?: (sessionId: string) => SpawnResult | Promise<SpawnResult>; onInstall?: (plan: SpawnOpts["executionPlan"]) => void; onSpawn?: (opts: SpawnOpts) => void; onResume?: (opts: SpawnOpts) => void; onDescribe?: () => void }): RuntimeAdapter & { preflight(): Promise<void>; allocateSessionId(): string } {
  const result = (sessionId: string) => options.result?.(sessionId) ?? { sessionId, exitCode: 0, metadata: { sessionId } };
  return {
    name: "pi",
    defaultModel: "",
    sessionFileName: "session-id-pi.txt",
    preflight: options.preflight ?? (async () => {}),
    allocateSessionId: () => "authoritative-session-id",
    installHooks(_dir, config) { options.onInstall?.(config.executionPlan); },
    spawn(opts) { options.onSpawn?.(opts); return result(opts.sessionId ?? ""); },
    resume(opts) { options.onResume?.(opts); return result(opts.sessionId); },
    extractActivity() { return []; },
    describeTools() { options.onDescribe?.(); return { runtime: "pi", markdown: "stub" }; },
  };
}

function writeRogueOneTeamConfig(root: string): void {
  writeFileSync(join(root, "teams", "rogue-one.yaml"), [
    "name: rogue-one",
    "description: configured workflow must be omitted",
    "default_mode: direct",
    "objective: configured objective must be omitted",
    "agents: []",
    "deploy_modes:",
    "  - id: direct",
    "    label: Direct",
    "    provider: openai",
    "    model: openai/gpt-5.6-sol",
    "    require_ticket: true",
  ].join("\n"));
}

function assertTimeoutMetadata(opts: SpawnOpts, timeoutSeconds: number): void {
  assert.equal(opts.executionPlan?.timeoutSeconds, timeoutSeconds);
  assert.equal(readFileSync(opts.primerPath, "utf8").match(new RegExp(`timeout_seconds: ${timeoutSeconds}`, "g"))?.length, 1);
  assert.equal(getDeploymentEvents(opts.deployId)[0]?.effective_timeout_seconds, timeoutSeconds);
}

class ForegroundDeploymentPty extends EventEmitter {
  readonly writes: string[] = [];
  readonly signals: string[] = [];
  private onDataHandler?: (data: string) => void;
  private onExitHandler?: (event: { exitCode: number; signal: number }) => void;
  constructor(private readonly onQuit: () => void, readonly pid = 77_001, private readonly onKill: (signal: string) => void = () => {}) { super(); }
  write(data: string): void { this.writes.push(data); if (data === "/quit\n") this.onQuit(); }
  resize(): void {}
  kill(signal?: string): void { const value = signal ?? ""; this.signals.push(value); this.onKill(value); }
  onData(handler: (data: string) => void): void { this.onDataHandler = handler; }
  onExit(handler: (event: { exitCode: number; signal: number }) => void): void { this.onExitHandler = handler; }
  emitData(data: string): void { this.onDataHandler?.(data); }
  emitExit(exitCode: number): void { this.onExitHandler?.({ exitCode, signal: 0 }); }
}

class ForegroundDeploymentInput extends Readable {
  readonly isTTY = true;
  isRaw = false;
  _read(): void {}
  setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
}

class BackgroundDeploymentProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  constructor(readonly pid: number) { super(); }
  unref(): void {}
}

function nextTick(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

const inheritedEnvironmentKeys = [PI_PARENT_LEASE_CAPABILITY_ENV, "PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_REPO", "PA_TICKET_ID"] as const;
async function withInheritedEnvironment(values: Partial<Record<(typeof inheritedEnvironmentKeys)[number], string>>, fn: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(inheritedEnvironmentKeys.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  for (const key of inheritedEnvironmentKeys) {
    const value = values[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { await fn(); }
  finally { for (const [key, value] of Object.entries(previous)) restore(key, value); }
}

function within<T>(promise: Promise<T>, milliseconds: number, message: string | (() => string)): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(typeof message === "string" ? message : message())), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

test("ppa rogue-one reaches the normal hook/spawn seam with fixed bare evidence", async () => {
  await withPiEnv(async (root, gitState) => {
    writeRogueOneTeamConfig(root);
    let installedPlan: SpawnOpts["executionPlan"];
    let spawned: SpawnOpts | undefined;
    const adapter = stubAdapter({
      onInstall: (plan) => { installedPlan = plan; },
      onSpawn: (opts) => { spawned = opts; },
    });
    const warnings: string[] = [];
    const result = await deployWithPi({ team: "rogue-one", mode: "implement", repo: "pa-platform", objective: "Direct work" }, adapter, { stderr: (line) => warnings.push(line) });
    assert.equal(result.status, "success");
    assert.equal(result.mode, "rogue-one");
    assert.equal(installedPlan, spawned?.executionPlan);
    assert.equal(spawned?.executionPlan?.rogue_one, true);
    assert.equal(spawned?.executionPlan?.invocation_channel, "cli");
    assert.equal(spawned?.env.PA_ROGUE_ONE, "1");
    assert.equal(spawned?.executionPlan?.repositoryAdmission.access, "non-locking");
    assert.equal(spawned?.executionPlan?.repositoryAdmission.ownershipIntent, "none");
    assert.equal(gitState.readCommands().some((args) => args[0] === "status"), false);
    assert.match(readFileSync(spawned!.primerPath, "utf8"), /ROGUE-ONE ACTIVE/);
    assert.doesNotMatch(readFileSync(spawned!.primerPath, "utf8"), /configured workflow|configured objective/);
    assert.match(warnings.join("\n"), /supplied --mode is ignored/);
    const started = getDeploymentEvents(result.deploymentId!)[0];
    assert.equal(started?.rogue_one, true);
    assert.equal(started?.invocation_channel, "cli");
  });
});

test("foreground PPA /quit emits one terminal event with no Git state operation", async () => {
  await withPiEnv(async (_root, gitState) => {
    let running = true;
    const input = new ForegroundDeploymentInput();
    const output = { write() { return true; } };
    let pty: ForegroundDeploymentPty;
    pty = new ForegroundDeploymentPty(() => {
      running = false;
      queueMicrotask(() => pty.emitExit(0));
    });
    const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: {
      spawnPty: () => pty as never, input: input as never, output: output as never,
      processExists: () => running,
    } });
    const deploymentPromise = deployWithPi({ team: "builder", mode: "implement" }, adapter);
    await nextTick();
    input.emit("data", "/quit\n");
    const result = await deploymentPromise;
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(pty.writes, ["/quit\n"]);
    assert.equal(input.isRaw, false);
    const terminalEvents = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0]?.event, "completed");
    assert.equal(terminalEvents[0]?.status, "partial");
    assert.match(terminalEvents[0]?.summary ?? "", /without a staged completion payload/);
    assert.equal(queryDeploymentStatus(result.deploymentId!)?.status, "partial");
    assert.deepEqual(gitState.readOperations(), []);
  });
});

test("foreground open-stdin output shapes exit naturally within 1000ms after child-exit evidence", { timeout: 15_000 }, async (context) => {
  type OutputShape = "valid-json" | "non-json" | "different-json";
  interface FixtureEvent {
    type: "child-exit-evidence" | "adapter-settled";
    outputShape: OutputShape;
    readableFlowing: boolean | null;
    dataListeners: number;
    readableFlowingBefore?: boolean | null;
    exitCode?: number;
  }
  const fixture = fileURLToPath(new URL("fixtures/foreground-open-stdin-child.ts", import.meta.url));
  const expectedOutput: Record<OutputShape, RegExp> = {
    "valid-json": /valid Pi output/,
    "non-json": /plain Pi terminal output/,
    "different-json": /"unexpected":\{"nested":"Pi output"\}/,
  };
  const runShape = async (outputShape: OutputShape): Promise<void> => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture, outputShape], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let carry = "";
    let evidenceAt = 0;
    let writerOpenAtEvidence = false;
    const events: FixtureEvent[] = [];
    let resolveEvidence!: (event: FixtureEvent) => void;
    const evidencePromise = new Promise<FixtureEvent>((resolve) => { resolveEvidence = resolve; });
    const observeLine = (line: string): void => {
      if (!line) return;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const event = parsed as Partial<FixtureEvent>;
      if (event.type !== "child-exit-evidence" && event.type !== "adapter-settled") return;
      events.push(event as FixtureEvent);
      if (event.type === "child-exit-evidence" && evidenceAt === 0) {
        evidenceAt = performance.now();
        writerOpenAtEvidence = child.stdin !== null && !child.stdin.writableEnded && !child.stdin.destroyed;
        resolveEvidence(event);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      const lines = (carry + text).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) observeLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal, at: performance.now() }));
    });
    const closePromise = new Promise<void>((resolve) => { child.once("close", () => resolve()); });

    try {
      const evidence = await within(evidencePromise, 10_000, `fixture did not report child-exit evidence; stderr=${stderr}`);
      assert.equal(evidence.outputShape, outputShape);
      assert.equal(evidence.readableFlowingBefore, null);
      assert.equal(evidence.readableFlowing, true);
      assert.equal(evidence.dataListeners, 1);
      assert.equal(writerOpenAtEvidence, true, "parent closed the subprocess stdin writer before exit measurement");

      const exited = await within(exitPromise, 1_000, () => `subprocess remained alive with open stdin; stdout=${stdout}; stderr=${stderr}`);
      await within(closePromise, 1_000, `subprocess stdio did not close; stdout=${stdout}; stderr=${stderr}`);
      if (carry) { observeLine(carry); carry = ""; }
      assert.equal(exited.code, 0, stderr);
      assert.equal(exited.signal, null);
      assert.match(stdout, expectedOutput[outputShape]);
      const exitElapsedMs = exited.at - evidenceAt;
      assert.ok(exitElapsedMs < 1_000, `subprocess exit took ${exitElapsedMs}ms after child-exit evidence`);
      const settlements = events.filter((event) => event.type === "adapter-settled");
      assert.equal(settlements.length, 1, stdout);
      assert.equal(settlements[0]?.outputShape, outputShape);
      assert.equal(settlements[0]?.exitCode, 0);
      assert.equal(settlements[0]?.readableFlowing, false);
      assert.equal(settlements[0]?.dataListeners, 0);
      assert.equal(child.stdin?.writableEnded, false, "test must not end the child stdin writer to induce exit");
      context.diagnostic(`open-stdin lifecycle (${outputShape}): before=${String(evidence.readableFlowingBefore)}, attached=${String(evidence.readableFlowing)}/${evidence.dataListeners} listener, settled=${String(settlements[0]?.readableFlowing)}/${settlements[0]?.dataListeners} listeners, writerOpen=${writerOpenAtEvidence}, naturalExitMs=${exitElapsedMs.toFixed(1)}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await within(closePromise, 1_000, "failed to clean up timed-out stdin fixture").catch(() => {});
      }
      child.stdin?.destroy();
    }
  };
  for (const outputShape of ["valid-json", "non-json", "different-json"] as const) await runShape(outputShape);
});

test("live foreground PTY PID protects status, wait, health, and sweep before settlement", async () => {
  await withPiEnv(async () => {
    let running = true;
    const input = new ForegroundDeploymentInput();
    const output = { write() { return true; } };
    const pty = new ForegroundDeploymentPty(() => {}, process.pid);
    const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: {
      spawnPty: () => pty as never, input: input as never, output: output as never,
      processExists: () => running,
    } });
    const deploymentPromise = deployWithPi({ team: "builder", mode: "implement" }, adapter);
    await nextTick();

    const live = queryDeploymentStatuses()[0];
    assert.ok(live);
    assert.equal(live.status, "running");
    assert.equal(live.pid, pty.pid);
    assert.deepEqual(getDeploymentEvents(live.deploy_id).map((event) => event.event), ["started", "pid"]);
    writePiTerminalStatus(getDeployPaths(live.deploy_id).deployDir, { type: "agent_end", stopReason: "stop", timestamp: new Date().toISOString() });

    const statusOutput: string[] = [];
    assert.equal(await runCoreCommand(["status", live.deploy_id], { io: { stdout: (line) => statusOutput.push(line), stderr: () => {} } }), 0);
    assert.match(statusOutput.join("\n"), /running/);
    assert.equal(await runCoreCommand(["health", "deployments", "--json"], { io: { stdout: () => {}, stderr: () => {} } }), 0);
    assert.equal(await runCoreCommand(["registry", "sweep", "--fix"], { io: { stdout: () => {}, stderr: () => {} } }), 0);
    assert.equal(queryDeploymentStatus(live.deploy_id)?.status, "running");
    assert.equal(getDeploymentEvents(live.deploy_id).filter((event) => event.event === "completed" || event.event === "crashed").length, 0);

    let sleeps = 0;
    const waitOutput: string[] = [];
    const waitCode = await runCoreCommand(["status", live.deploy_id, "--wait"], {
      io: { stdout: (line) => waitOutput.push(line), stderr: () => {} },
      processAlive: (pid) => pid === pty.pid && running,
      clock: () => sleeps * 250,
      sleep: async () => {
        sleeps += 1;
        running = false;
        pty.emitExit(0);
        await deploymentPromise;
      },
    });
    assert.equal(waitCode, 0);
    assert.equal(sleeps, 1);
    assert.match(waitOutput.join("\n"), /partial - ppa foreground session exited without a staged completion payload/);
    assert.equal(getDeploymentEvents(live.deploy_id).filter((event) => event.event === "pid").length, 1);
    assert.equal(getDeploymentEvents(live.deploy_id).filter((event) => event.event === "completed" || event.event === "crashed").length, 1);
    assert.equal(input.isRaw, false);
  });
});

test("foreground and background Pi children receive distinct internal execution modes", async () => {
  await withPiEnv(async () => {
    const captured: SpawnOpts[] = [];
    const adapter = stubAdapter({ onSpawn: (opts) => { captured.push(opts); } });
    assert.equal((await deployWithPi({ team: "builder", mode: "implement" }, adapter)).status, "success");
    assert.equal((await deployWithPi({ team: "builder", mode: "implement", background: true }, adapter)).status, "success");
    assert.equal(captured[0]?.env?.["PA_PI_EXECUTION_MODE"], "foreground");
    assert.equal(captured[1]?.env?.["PA_PI_EXECUTION_MODE"], "background");
  });
});

test("Pi orchestrator keeps its private lease capability in the trusted launcher closure for both launch modes", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    for (const background of [false, true]) {
      let protectedCapability = "";
      let deploymentId = "";
      const result = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-191", background }, stubAdapter({
        onSpawn: (opts) => {
          deploymentId = opts.deployId;
          const lease = inspectRepositoryMutationLease(repo).lease;
          protectedCapability = lease?.ownershipToken ?? "";
          assert.ok(protectedCapability);
          assert.equal(opts.env?.[PI_PARENT_LEASE_CAPABILITY_ENV], undefined);
          assert.equal(Object.hasOwn(opts.executionPlan?.environment ?? {}, PI_PARENT_LEASE_CAPABILITY_ENV), false);
          assert.doesNotMatch(readFileSync(opts.primerPath, "utf8"), new RegExp(escapeRegExp(protectedCapability)));
        },
      }));
      assert.equal(result.status, "success", result.reason);
      assert.ok(deploymentId);
      assert.doesNotMatch(JSON.stringify(getDeploymentEvents(deploymentId)), new RegExp(escapeRegExp(protectedCapability)));
      for (const name of readdirSync(getDeployPaths(deploymentId).deployDir)) {
        const path = join(getDeployPaths(deploymentId).deployDir, name);
        if (!statSync(path).isFile()) continue;
        assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(escapeRegExp(protectedCapability)), `${name} retained the parent capability`);
      }
      assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
    }
  });
});

test("authenticated inherited background implement admission preserves parent bytes and scrubs every child sink", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    git(["checkout", "-b", "feature/PAP-191-inherited-test"], repo);
    for (const parentLaunchMode of ["foreground", "background"] as const) {
      const parentDeploymentId = `d-parent-${parentLaunchMode}`;
      const parentDir = join(root, "deployments", parentDeploymentId);
      mkdirSync(parentDir, { recursive: true });
      const acquired = acquireRepositoryMutationLease({
        canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: parentDeploymentId,
        deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator",
        launchMode: parentLaunchMode, ticket: "PAP-191",
      });
      assert.equal(acquired.status, "acquired");
      if (acquired.status !== "acquired") continue;
      markParentRunning(parentDeploymentId);
      const capability = acquired.lease.ownershipToken;
      const leasePath = repositoryMutationLeasePath(repo);
      const parentBytes = readFileSync(leasePath);
      await withInheritedEnvironment({
        [PI_PARENT_LEASE_CAPABILITY_ENV]: capability,
        PA_DEPLOYMENT_ID: parentDeploymentId,
        PA_DEPLOYMENT_DIR: parentDir,
        PA_TEAM: "builder",
        PA_MODE: "orchestrator",
        PA_REPO: repo,
        PA_TICKET_ID: "PAP-191",
      }, async () => {
        let captured: SpawnOpts | undefined;
        let spawns = 0;
        const result = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true }, stubAdapter({
          onSpawn: (opts) => {
            captured = opts;
            spawns += 1;
            const borrower = inspectRepositoryMutationBorrower(repo);
            assert.equal(borrower.state, "live");
            assert.equal(borrower.borrower?.parentDeploymentId, parentDeploymentId);
            assert.equal(statSync(repositoryMutationBorrowerPath(repo)).mode & 0o777, 0o600);
            assert.ok(statSync(repositoryMutationBorrowerPath(repo)).size <= 64 * 1024);
            assert.deepEqual(readFileSync(leasePath), parentBytes);
          },
        }));
        assert.equal(result.status, "success", result.reason);
        assert.equal(spawns, 1);
        assert.ok(captured?.repositoryBorrower?.borrowerToken);
        assert.equal(captured?.repositoryBorrower?.parentDeploymentId, parentDeploymentId);
        assert.equal(captured?.repositoryLease, undefined);
        assert.equal(captured?.env?.[PI_PARENT_LEASE_CAPABILITY_ENV], undefined);
        assert.doesNotMatch(readFileSync(captured!.primerPath, "utf8"), new RegExp(escapeRegExp(capability)));
        assert.doesNotMatch(JSON.stringify(getDeploymentEvents(result.deploymentId!)), new RegExp(escapeRegExp(capability)));
        assert.doesNotMatch(JSON.stringify(readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath)), new RegExp(escapeRegExp(capability)));
        for (const name of readdirSync(getDeployPaths(result.deploymentId!).deployDir)) {
          const path = join(getDeployPaths(result.deploymentId!).deployDir, name);
          if (statSync(path).isFile()) assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(escapeRegExp(capability)), `${name} retained the parent capability`);
        }
        assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
        assert.deepEqual(readFileSync(leasePath), parentBytes);
      });
      assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, ownershipToken: capability }).status, "released");
    }
  });
});

test("approved classified dirty direct child admits once, renders exact scope, and preserves parent bytes", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    git(["checkout", "-b", "feature/PAP-191-dirty-direct"], repo);
    writeFileSync(join(repo, "README.md"), "# Preserved PAP-191 work\n");
    const parentDeploymentId = "d-parent-dirty";
    const parentDir = join(root, "deployments", parentDeploymentId);
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: parentDeploymentId,
      deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", ticket: "PAP-191",
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    markParentRunning(parentDeploymentId);
    const inspection = inspectRepositoryMutationLease(repo);
    assert.ok(inspection.evidenceIdentity);
    const approval: RepositoryDirtyBorrowApproval = {
      schemaVersion: 1,
      receiptId: "receipt-private-sentinel",
      approvalReference: "approval-private-sentinel",
      approvedAt: new Date().toISOString(),
      action: "preserve-and-continue",
      parentDeploymentId,
      parentDeploymentDirectory: parentDir,
      parentProcessFingerprint: acquired.lease.processFingerprint,
      parentLeaseEvidenceIdentity: inspection.evidenceIdentity!,
      canonicalRepoKey: "pa-platform",
      canonicalRepoRoot: repo,
      ticket: "PAP-191",
      branch: acquired.lease.preLaunchGitSnapshot.branch,
      snapshot: acquired.lease.preLaunchGitSnapshot,
      classifications: [{ path: "README.md", classification: "active-ticket-preserved" }],
      plannedNewPaths: ["packages/new-approved.ts"],
    };
    const approvalPath = publishRepositoryDirtyBorrowApproval(approval);
    const capability = acquired.lease.ownershipToken;
    const parentBytes = readFileSync(repositoryMutationLeasePath(repo));
    await withInheritedEnvironment({
      [PI_PARENT_LEASE_CAPABILITY_ENV]: capability,
      PA_DEPLOYMENT_ID: parentDeploymentId,
      PA_DEPLOYMENT_DIR: parentDir,
      PA_TEAM: "builder",
      PA_MODE: "orchestrator",
      PA_REPO: repo,
      PA_TICKET_ID: "PAP-191",
    }, async () => {
      let spawns = 0;
      const contenderAdapter = stubAdapter({
        onSpawn: (opts) => {
          spawns += 1;
          const primer = readFileSync(opts.primerPath, "utf8");
          assert.match(primer, /Exact Approved Dirty Borrower Scope/);
          assert.match(primer, /- README\.md/);
          assert.match(primer, /- packages\/new-approved\.ts/);
          assert.doesNotMatch(primer, /receipt-private-sentinel|approval-private-sentinel|[0-9a-f]{64}/);
          assert.deepEqual(opts.executionPlan?.repositoryAdmission.approvedMutationPaths, ["README.md", "packages/new-approved.ts"]);
          assert.equal(opts.repositoryBorrower?.repositoryGitDir, opts.executionPlan?.repositoryGitDir);
          assert.equal(opts.repositoryBorrower?.repositoryGitCommonDir, opts.executionPlan?.repositoryGitCommonDir);
          assert.deepEqual(readFileSync(repositoryMutationLeasePath(repo)), parentBytes);
          mkdirSync(join(repo, "packages"), { recursive: true });
          writeFileSync(join(repo, "packages", "new-approved.ts"), "export {};\n");
        },
      });
      const contenders = await Promise.all(Array.from({ length: 50 }, () =>
        deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true, timeout: 60 }, contenderAdapter)));
      const admitted = contenders.find((result) => result.status === "success");
      assert.ok(admitted);
      assert.equal(contenders.filter((result) => result.status === "success").length, 1);
      assert.equal(contenders.filter((result) => result.status === "failed").length, 49);
      assert.equal(spawns, 1);
      assert.equal(existsSync(approvalPath), false);
      assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
      assert.deepEqual(readFileSync(repositoryMutationLeasePath(repo)), parentBytes);
      const sinks = [
        JSON.stringify(getDeploymentEvents(admitted.deploymentId!)),
        JSON.stringify(readActivityEvents(getDeployPaths(admitted.deploymentId!).activityLogPath)),
        ...readdirSync(getDeployPaths(admitted.deploymentId!).deployDir).filter((name) => statSync(join(getDeployPaths(admitted.deploymentId!).deployDir, name)).isFile()).map((name) => readFileSync(join(getDeployPaths(admitted.deploymentId!).deployDir, name), "utf8")),
      ].join("\n");
      for (const protectedValue of [capability, approval.receiptId, approval.approvalReference, approval.snapshot.digestSha256!]) assert.doesNotMatch(sinks, new RegExp(escapeRegExp(protectedValue)));

      let replaySpawns = 0;
      const replay = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true, timeout: 60 }, stubAdapter({ onSpawn: () => { replaySpawns += 1; } }));
      assert.equal(replay.status, "failed");
      assert.equal(replaySpawns, 0);
      assert.match(replay.reason ?? "", /dirty-approval/);
    });
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(repo)), parentBytes);
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, ownershipToken: capability }).status, "released");
  });
});

test("inherited admission rejects parent-only, capability, context, mode, dirty-state, and rollback cases before spawn", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    git(["checkout", "-b", "feature/PAP-191-rejection-test"], repo);
    const parentDeploymentId = "d-parent-rejections";
    const parentDir = join(root, "deployments", parentDeploymentId);
    mkdirSync(parentDir, { recursive: true });
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: parentDeploymentId,
      deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator", ticket: "PAP-191",
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    markParentRunning(parentDeploymentId);
    const capability = acquired.lease.ownershipToken;
    const leasePath = repositoryMutationLeasePath(repo);
    const parentBytes = readFileSync(leasePath);
    await withInheritedEnvironment({ PA_DEPLOYMENT_ID: parentDeploymentId, PA_DEPLOYMENT_DIR: parentDir, PA_TEAM: "builder", PA_MODE: "orchestrator", PA_REPO: repo, PA_TICKET_ID: "PAP-191" }, async () => {
      const cases = [
        { name: "mismatched parent", capability, parentId: "d-unrelated-parent", request: { team: "builder", mode: "implement", ticket: "PAP-191", background: true } },
        { name: "foreground child", capability, request: { team: "builder", mode: "implement", ticket: "PAP-191" } },
        { name: "child mode", capability, request: { team: "builder", mode: "orchestrator", ticket: "PAP-191", background: true } },
      ] as const;
      for (const item of cases) {
        if (item.capability === undefined) delete process.env[PI_PARENT_LEASE_CAPABILITY_ENV];
        else process.env[PI_PARENT_LEASE_CAPABILITY_ENV] = item.capability;
        process.env["PA_DEPLOYMENT_ID"] = "parentId" in item ? item.parentId : parentDeploymentId;
        let spawns = 0;
        const result = await deployWithPi(item.request, stubAdapter({ onSpawn: () => { spawns += 1; } }));
        assert.equal(result.status, "failed", item.name);
        assert.equal(spawns, 0, item.name);
        assert.ok((result.reason ?? "").length <= 2_000, item.name);
        assert.match(result.reason ?? "", /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s, item.name);
        assert.doesNotMatch(result.reason ?? "", new RegExp(escapeRegExp(capability)), item.name);
        assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent", item.name);
        assert.deepEqual(readFileSync(leasePath), parentBytes, item.name);
      }

      process.env[PI_PARENT_LEASE_CAPABILITY_ENV] = capability;
      process.env["PA_DEPLOYMENT_ID"] = parentDeploymentId;
      let requirementsSpawns = 0;
      const requirements = await deployWithPi(
        { team: "requirements", mode: "analyze", ticket: "PAP-191", background: true },
        stubAdapter({ onSpawn: () => { requirementsSpawns += 1; } }),
      );
      assert.equal(requirements.status, "success", requirements.reason);
      assert.equal(requirementsSpawns, 1);
      assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
      assert.deepEqual(readFileSync(leasePath), parentBytes);

      const dirtyCases = [
        { name: "staged", prepare: () => { writeFileSync(join(repo, "staged.txt"), "staged\n"); git(["add", "staged.txt"], repo); }, clean: () => { git(["restore", "--staged", "staged.txt"], repo); rmSync(join(repo, "staged.txt")); } },
        { name: "unstaged", prepare: () => writeFileSync(join(repo, "README.md"), "# Changed\n"), clean: () => { git(["restore", "README.md"], repo); } },
        { name: "untracked", prepare: () => writeFileSync(join(repo, "untracked.txt"), "untracked\n"), clean: () => rmSync(join(repo, "untracked.txt")) },
      ];
      for (const dirty of dirtyCases) for (const force of [false, true]) {
        dirty.prepare();
        let spawns = 0;
        const result = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true, force }, stubAdapter({ onSpawn: () => { spawns += 1; } }));
        assert.equal(result.status, "failed", `${dirty.name} force=${force}`);
        assert.match(result.reason ?? "", /dirty-approval/);
        assert.match(result.reason ?? "", /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
        assert.equal(spawns, 0);
        assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
        assert.deepEqual(readFileSync(leasePath), parentBytes);
        dirty.clean();
      }

      let rollbackSpawns = 0;
      const rollback = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true }, stubAdapter({
        onSpawn: () => { rollbackSpawns += 1; throw new Error(`launch failed ${capability}`); },
      }));
      assert.equal(rollback.status, "failed");
      assert.equal(rollbackSpawns, 1);
      assert.doesNotMatch(rollback.reason ?? "", new RegExp(escapeRegExp(capability)));
      assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
      assert.deepEqual(readFileSync(leasePath), parentBytes);
    });
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, ownershipToken: capability }).status, "released");
  });
});

test("failed readiness with an unverified live transferred runner retains blocking authority until verified death", { timeout: 15_000 }, async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    git(["checkout", "-b", "feature/PAP-191-readiness-live"], repo);
    const parentDeploymentId = "d-parent-readiness-live";
    const parentDir = join(root, "deployments", parentDeploymentId);
    mkdirSync(parentDir, { recursive: true });
    const parent = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: parentDeploymentId,
      deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", ticket: "PAP-191",
    });
    assert.equal(parent.status, "acquired");
    if (parent.status !== "acquired") return;
    markParentRunning(parentDeploymentId);
    let runner: ReturnType<typeof spawn> | undefined;
    let borrowerToken = "";
    let childDeploymentId = "";
    let clock = 0;
    const adapter = new PiAdapter({
      cwd: repo,
      env: process.env,
      versionProbe: () => "0.84.4",
      nativeRegistryProbe: () => undefined,
      supervision: {
        launchBackgroundRunner: ((_runnerPath, configPath) => {
          const config = readPiBackgroundConfig(configPath);
          const handoff = readPiRepositoryHandoff(config.repositoryHandoffPath!);
          assert.ok(handoff.repositoryBorrower);
          borrowerToken = handoff.repositoryBorrower.borrowerToken;
          childDeploymentId = config.deploymentId;
          runner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
          assert.ok(runner.pid);
          const fingerprint = readProcessFingerprint(runner.pid!);
          assert.ok(fingerprint);
          const transfer = transferRepositoryMutationBorrower({
            canonicalRepoRoot: repo,
            borrowerToken,
            nextProcessFingerprint: fingerprint!,
          });
          assert.equal(transfer.status, "transferred");
          rmSync(config.repositoryHandoffPath!);
          return runner;
        }),
        readinessNow: () => clock,
        readinessSleep: async (milliseconds) => { clock += milliseconds; },
        readinessTimeoutMs: 50,
        sendSignal: () => { /* fixture deliberately remains live */ },
        processGroupGone: (pid) => {
          try { process.kill(-pid, 0); return false; }
          catch { return true; }
        },
      },
    });
    try {
      await withInheritedEnvironment({
        PA_DEPLOYMENT_ID: parentDeploymentId,
        PA_DEPLOYMENT_DIR: parentDir,
        PA_TEAM: "builder",
        PA_MODE: "orchestrator",
        PA_REPO: repo,
        PA_TICKET_ID: "PAP-191",
      }, async () => {
        const failed = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true, timeout: 60 }, adapter);
        assert.equal(failed.status, "failed");
        assert.match(failed.reason ?? "", /uncertain-live/);
        assert.match(failed.reason ?? "", /preserve the blocking borrower\/finalizing evidence.*verify the recorded sibling runner has terminated/s);
        assert.match(failed.reason ?? "", /finalize the matching borrower only after verified death.*do not dispatch a sibling or unrelated builder/s);
        assert.doesNotMatch(failed.reason ?? "", /zero-entry Git snapshot|for clean borrowing|ordinary clean retry/i);
        assert.equal(inspectRepositoryMutationBorrower(repo).state, "live");
        assert.equal((JSON.parse(readFileSync(repositoryMutationBorrowerPath(repo), "utf8")) as Record<string, unknown>)["finalizationState"], "finalizing");

        let siblingSpawns = 0;
        const sibling = await deployWithPi(
          { team: "builder", mode: "implement", ticket: "PAP-191", background: true, timeout: 60 },
          stubAdapter({ onSpawn: () => { siblingSpawns += 1; } }),
        );
        assert.equal(sibling.status, "failed");
        assert.equal(siblingSpawns, 0);
        assert.match(sibling.reason ?? "", /borrower-state/);
        assert.match(sibling.reason ?? "", /preserve the blocking borrower\/finalizing evidence.*verify the recorded sibling runner has terminated/s);
        assert.match(sibling.reason ?? "", /finalize the matching borrower only after verified death.*do not dispatch a sibling or unrelated builder/s);
        assert.doesNotMatch(sibling.reason ?? "", /zero-entry Git snapshot|for clean borrowing|ordinary clean retry/i);

        const unrelated = acquireRepositoryMutationLease({
          canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: "d-unrelated",
          deploymentDirectory: join(root, "deployments", "d-unrelated"), runtime: "opencode", team: "builder", mode: "implement", force: true,
        });
        assert.equal(unrelated.status, "rejected");
      });
    } finally {
      if (runner?.pid) {
        try { process.kill(-runner.pid, "SIGKILL"); } catch { /* already gone */ }
        await new Promise<void>((resolve) => runner!.once("close", () => resolve()));
      }
    }
    const finalized = finalizeRepositoryMutationBorrower({
      canonicalRepoRoot: repo, borrowerToken, deploymentId: childDeploymentId,
    });
    assert.equal(finalized.status, "finalized");
    assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, ownershipToken: parent.lease.ownershipToken }).status, "released");
  });
});

test("foreground and background orchestrator finalization waits for a live child before releasing parent ownership", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    git(["checkout", "-b", "feature/PAP-191-parent-wait"], repo);
    for (const background of [false, true]) {
      let childFinalization: Promise<void> | undefined;
      const result = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-191", background, timeout: 60 }, stubAdapter({
        onSpawn: (opts) => {
          const lease = inspectRepositoryMutationLease(repo).lease;
          assert.ok(lease);
          const parentBytes = readFileSync(repositoryMutationLeasePath(repo));
          const childDeploymentId = `d-waiting-child-${background ? "background" : "foreground"}`;
          const registration = registerRepositoryMutationBorrower({
            capability: lease.ownershipToken,
            canonicalRepoKey: "pa-platform",
            canonicalRepoRoot: repo,
            parentDeploymentId: opts.deployId,
            deploymentId: childDeploymentId,
            deploymentDirectory: join(root, "deployments", childDeploymentId),
            runtime: "pi",
            team: "builder",
            mode: "implement",
            launchMode: "background",
            ticket: "PAP-191",
            branch: "feature/PAP-191-parent-wait",
            timeoutSeconds: 60,
          });
          assert.equal(registration.status, "registered");
          if (registration.status !== "registered") return;
          childFinalization = new Promise<void>((resolve) => setImmediate(() => {
            assert.deepEqual(readFileSync(repositoryMutationLeasePath(repo)), parentBytes);
            const finalized = finalizeRepositoryMutationBorrower({
              canonicalRepoRoot: repo,
              borrowerToken: registration.borrower.borrowerToken,
              deploymentId: childDeploymentId,
            });
            assert.equal(finalized.status, "finalized");
            if (finalized.status === "finalized") assert.equal(finalized.parentLease, "retained");
            resolve();
          }));
        },
      }));
      assert.equal(result.status, "success", result.reason);
      await childFinalization;
      assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
      assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
    }
  });
});

test("inherited success, failure, timeout, and cancellation finalize only the matching borrower and preserve parent bytes", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    git(["checkout", "-b", "feature/PAP-191-terminal-test"], repo);
    const parentDeploymentId = "d-parent-terminal";
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: parentDeploymentId,
      deploymentDirectory: join(root, "deployments", parentDeploymentId), runtime: "pi", team: "builder", mode: "orchestrator",
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    markParentRunning(parentDeploymentId);
    const capability = acquired.lease.ownershipToken;
    const leasePath = repositoryMutationLeasePath(repo);
    const parentBytes = readFileSync(leasePath);
    await withInheritedEnvironment({
      [PI_PARENT_LEASE_CAPABILITY_ENV]: capability,
      PA_DEPLOYMENT_ID: parentDeploymentId,
      PA_DEPLOYMENT_DIR: join(root, "deployments", parentDeploymentId),
      PA_TEAM: "builder",
      PA_MODE: "orchestrator",
      PA_REPO: repo,
      PA_TICKET_ID: "PAP-191",
    }, async () => {
      for (const exitCode of [0, 17, 124, 143]) {
        let spawns = 0;
        const result = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true, timeout: 60 }, stubAdapter({
          onSpawn: () => { spawns += 1; },
          result: (sessionId) => ({ sessionId, exitCode, ...(exitCode === 0 ? {} : { errorMessage: `terminal ${exitCode}` }), metadata: { sessionId } }),
        }));
        assert.equal(result.status, exitCode === 0 ? "success" : "failed", String(exitCode));
        assert.equal(spawns, 1);
        if (exitCode !== 0) {
          assert.match(result.reason ?? "", /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
          assert.ok((result.reason ?? "").length <= 2_000);
          assert.doesNotMatch(result.reason ?? "", new RegExp(escapeRegExp(capability)));
        }
        assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
        assert.deepEqual(readFileSync(leasePath), parentBytes);
      }
    });
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, ownershipToken: capability }).status, "released");
  });
});

test("PPA foreground builders own the exact repository through every adapter terminal outcome", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    const leasePath = repositoryMutationLeasePath(repo);
    for (const exitCode of [0, 17, 124, 143]) {
      let observedToken = "";
      const adapter = stubAdapter({
        onSpawn: (opts) => {
          const inspection = inspectRepositoryMutationLease(repo);
          assert.equal(inspection.state, "live");
          assert.equal(inspection.lease?.deploymentId, opts.deployId);
          assert.equal(inspection.lease?.canonicalRepoRoot, repo);
          assert.equal(inspection.lease?.runtime, "pi");
          assert.equal(inspection.lease?.preLaunchGitSnapshot.dirty, false);
          assert.equal(opts.repositoryLease?.ownershipToken, inspection.lease?.ownershipToken);
          observedToken = inspection.lease?.ownershipToken ?? "";
          assert.equal(statSync(leasePath).mode & 0o777, 0o600);
          assert.ok(statSync(leasePath).size <= 64 * 1024);
          assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, ownershipToken: "not-the-owner" }).status, "token-mismatch");
          assert.equal(inspectRepositoryMutationLease(repo).state, "live");
        },
        result: (sessionId) => ({ sessionId, exitCode, ...(exitCode === 0 ? {} : { errorMessage: `terminal ${exitCode}` }), metadata: { sessionId } }),
      });
      const result = await deployWithPi({ team: "builder", mode: "implement" }, adapter);
      assert.ok(observedToken);
      assert.equal(result.status, exitCode === 0 ? "success" : "failed");
      assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
    }

    const launchFailure = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({ result: () => { throw new Error("launch failed"); } }));
    assert.equal(launchFailure.status, "failed");
    assert.match(launchFailure.reason ?? "", /launch failed/);
    assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
  });
});

test("PPA dirty background rejects pre-spawn while requirements bypass status and lease admission", async () => {
  await withPiEnv(async (root, gitState) => {
    const repo = join(root, "repo");
    const leasePath = repositoryMutationLeasePath(repo);
    writeFileSync(join(repo, "dirty.txt"), "dirty\n");
    let builderSpawns = 0;
    const rejected = await deployWithPi({ team: "builder", mode: "implement", background: true }, stubAdapter({ onSpawn: () => { builderSpawns += 1; } }));
    assert.equal(rejected.status, "failed");
    assert.match(rejected.reason ?? "", /state=dirty-background/);
    assert.ok((rejected.reason ?? "").length <= 2_000);
    assert.equal(builderSpawns, 0);
    assert.equal(existsSync(leasePath), false);

    writeFileSync(leasePath, "live evidence must remain byte-identical\n", { mode: 0o600 });
    const before = readFileSync(leasePath, "utf8");
    const commandOffset = gitState.readCommands().length;
    let requirementsSpawns = 0;
    const launched = await deployWithPi({ team: "requirements", mode: "analyze", background: true }, stubAdapter({ onSpawn: (opts) => {
      requirementsSpawns += 1;
      assert.equal(opts.executionPlan?.repositoryAdmission.access, "read-only");
      assert.equal(opts.repositoryLease, undefined);
    } }));
    assert.equal(launched.status, "success", launched.reason);
    assert.equal(requirementsSpawns, 1);
    assert.equal(readFileSync(leasePath, "utf8"), before);
    assert.equal(gitState.readCommands().slice(commandOffset).some((args) => args[0] === "status"), false);
    assert.deepEqual(gitState.readOperations(), []);
  });
});

test("PPA re-reads clean-to-dirty state after planning before background or foreground spawn", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    const leasePath = repositoryMutationLeasePath(repo);
    let backgroundSpawns = 0;
    const background = await deployWithPi({ team: "builder", mode: "implement", background: true }, stubAdapter({
      onDescribe: () => writeFileSync(join(repo, "arrived-after-plan.txt"), "dirty\n"),
      onSpawn: () => { backgroundSpawns += 1; },
    }));
    assert.equal(background.status, "failed");
    assert.match(background.reason ?? "", /state=dirty-background/);
    assert.equal(backgroundSpawns, 0);
    assert.equal(existsSync(leasePath), false);

    rmSync(join(repo, "arrived-after-plan.txt"));
    let foregroundSpawns = 0;
    const foreground = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({
      onDescribe: () => writeFileSync(join(repo, "arrived-after-plan.txt"), "dirty\n"),
      onSpawn: (opts) => {
        foregroundSpawns += 1;
        const snapshot = opts.executionPlan?.repositoryAdmission.gitSnapshot;
        const leaseSnapshot = inspectRepositoryMutationLease(repo).lease?.preLaunchGitSnapshot;
        const primer = readFileSync(opts.primerPath, "utf8");
        assert.equal(snapshot?.dirty, true);
        assert.equal(snapshot?.untrackedCount, 1);
        assert.deepEqual(snapshot, leaseSnapshot);
        assert.match(snapshot?.statusSummary ?? "", /arrived-after-plan\.txt/);
        assert.match(primer, /Mandatory Dirty Repository Intent Contract/);
        assert.match(primer, /Immediately before acting on approval, re-read the branch, HEAD, and full Git status/);
        assert.match(primer, /arrived-after-plan\.txt/);
      },
    }));
    assert.equal(foreground.status, "success", foreground.reason);
    assert.equal(foregroundSpawns, 1);
    assert.equal(existsSync(leasePath), false);
  });
});

test("PPA dirty-to-changed branch, HEAD, and status drift stays consistent across plan, primer, and lease", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    writeFileSync(join(repo, "dirty-before-plan.txt"), "initial dirty\n");
    const initialHead = git(["rev-parse", "HEAD"], repo);
    let finalHead = "";
    const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({
      onDescribe: () => {
        git(["checkout", "-b", "feature/post-plan-drift"], repo);
        git(["commit", "--allow-empty", "-m", "post-plan head drift"], repo);
        writeFileSync(join(repo, "changed-after-plan.txt"), "changed dirty state\n");
        finalHead = git(["rev-parse", "HEAD"], repo);
      },
      onSpawn: (opts) => {
        const snapshot = opts.executionPlan?.repositoryAdmission.gitSnapshot;
        const leaseSnapshot = inspectRepositoryMutationLease(repo).lease?.preLaunchGitSnapshot;
        const primer = readFileSync(opts.primerPath, "utf8");
        assert.notEqual(finalHead, initialHead);
        assert.equal(snapshot?.branch, "feature/post-plan-drift");
        assert.equal(snapshot?.head, finalHead);
        assert.equal(snapshot?.untrackedCount, 2);
        assert.deepEqual(snapshot, leaseSnapshot);
        assert.match(snapshot?.statusSummary ?? "", /dirty-before-plan\.txt/);
        assert.match(snapshot?.statusSummary ?? "", /changed-after-plan\.txt/);
        assert.match(primer, new RegExp(`- HEAD: ${finalHead}`));
        assert.match(primer, /- Branch: feature\/post-plan-drift/);
        assert.match(primer, /changed-after-plan\.txt/);
      },
    }));
    assert.equal(result.status, "success", result.reason);
    assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
  });
});

test("owned linked-worktree slots reconcile branch, HEAD, staged, unstaged, and untracked preflight drift before spawn", async () => {
  for (const drift of ["branch", "head", "staged", "unstaged", "untracked"] as const) {
    await withPiEnv(async (root) => {
      const primary = join(root, "repo");
      const worktree = join(root, `owned-preflight-${drift}`);
      execFileSync(REAL_GIT, ["worktree", "add", "-b", `feature/PAP-195-owned-${drift}`, worktree], { cwd: primary, stdio: "ignore" });
      process.chdir(worktree);
      let preflights = 0;
      let spawns = 0;
      const result = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-195" }, stubAdapter({
        preflight: async () => {
          preflights += 1;
          applyPreflightGitDrift(worktree, drift);
        },
        onSpawn: (opts) => {
          spawns += 1;
          const observed = captureRepositoryGitSnapshot(worktree);
          const planSnapshot = opts.executionPlan?.repositoryAdmission.gitSnapshot;
          const leaseSnapshot = inspectRepositoryMutationLease(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktree, slot: "implement" }).lease?.preLaunchGitSnapshot;
          assert.ok(planSnapshot, `${drift}: spawn plan snapshot`);
          assert.equal(repositoryGitSnapshotsEqual(planSnapshot!, observed), true, `${drift}: spawn plan snapshot`);
          assert.deepEqual(leaseSnapshot, planSnapshot, `${drift}: lease snapshot`);
          assert.match(
            readFileSync(opts.primerPath, "utf8"),
            new RegExp(`- Git: branch=${escapeRegExp(observed.branch)}, head=${observed.head}, staged=${observed.stagedCount}, unstaged=${observed.unstagedCount}, untracked=${observed.untrackedCount}`),
            `${drift}: primer snapshot`,
          );
        },
      }));
      assert.equal(result.status, "success", `${drift}: ${result.reason ?? ""}`);
      assert.equal(preflights, 1, drift);
      assert.equal(spawns, 1, drift);
      assert.equal(inspectRepositoryMutationLease(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktree, slot: "implement" }).state, "absent", drift);
    });
  }
});

test("borrowed linked-worktree children reject branch, HEAD, staged, unstaged, and untracked preflight drift before spawn", async () => {
  for (const drift of ["branch", "head", "staged", "unstaged", "untracked"] as const) {
    await withPiEnv(async (root) => {
      const primary = join(root, "repo");
      const worktree = join(root, `borrowed-preflight-${drift}`);
      const branch = `feature/PAP-195-borrowed-${drift}`;
      execFileSync(REAL_GIT, ["worktree", "add", "-b", branch, worktree], { cwd: primary, stdio: "ignore" });
      process.chdir(worktree);
      const parentDeploymentId = `d-parent-preflight-${drift}`;
      const parentDir = join(root, "deployments", parentDeploymentId);
      mkdirSync(parentDir, { recursive: true });
      const parent = acquireRepositoryMutationLease({
        canonicalRepoKey: "pa-platform", canonicalRepoRoot: primary, worktreeRoot: worktree,
        deploymentId: parentDeploymentId, deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", ticket: "PAP-195",
      });
      assert.equal(parent.status, "acquired", drift);
      if (parent.status !== "acquired") return;
      markParentRunning(parentDeploymentId);
      const parentPath = repositoryMutationLeasePath(worktree);
      const parentBytes = readFileSync(parentPath);
      await withInheritedEnvironment({
        [PI_PARENT_LEASE_CAPABILITY_ENV]: parent.lease.ownershipToken,
        PA_DEPLOYMENT_ID: parentDeploymentId,
        PA_DEPLOYMENT_DIR: parentDir,
        PA_TEAM: "builder",
        PA_MODE: "orchestrator",
        PA_REPO: primary,
        PA_TICKET_ID: "PAP-195",
      }, async () => {
        let preflights = 0;
        let spawns = 0;
        const result = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-195", background: true, timeout: 60 }, stubAdapter({
          preflight: async () => {
            preflights += 1;
            applyPreflightGitDrift(worktree, drift);
          },
          onSpawn: () => { spawns += 1; },
        }));
        assert.equal(result.status, "failed", drift);
        assert.equal(preflights, 1, drift);
        assert.equal(spawns, 0, drift);
        assert.match(result.reason ?? "", /pre-spawn-reread/, drift);
        assert.match(result.reason ?? "", /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s, drift);
        assert.ok((result.reason ?? "").length <= 2_000, drift);
        assert.equal(inspectRepositoryMutationBorrower(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktree }).state, "absent", drift);
        assert.deepEqual(readFileSync(parentPath), parentBytes, drift);
      });
      assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: primary, worktreeRoot: worktree, slot: "orchestrator", ownershipToken: parent.lease.ownershipToken }).status, "released", drift);
    });
  }
});

test("owned linked-worktree launch rejects equal-snapshot Git metadata identity drift and safely finalizes without spawn", async () => {
  for (const drift of ["git-dir", "common-dir"] as const) {
    await withPiEnv(async (root) => {
      const primary = join(root, "repo");
      const worktree = join(root, `owned-metadata-${drift}`);
      execFileSync(REAL_GIT, ["worktree", "add", "-b", `feature/PAP-195-owned-metadata-${drift}`, worktree], { cwd: primary, stdio: "ignore" });
      process.chdir(worktree);
      const plannedSnapshot = captureRepositoryGitSnapshot(worktree);
      const metadata = preparePreflightMetadataDrift(root, worktree, drift);
      const leasePath = repositoryMutationLeasePath(worktree, "implement");
      let spawns = 0;
      try {
        const result = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-195" }, stubAdapter({
          preflight: async () => {
            metadata.apply();
            assert.equal(repositoryGitSnapshotsEqual(plannedSnapshot, captureRepositoryGitSnapshot(worktree)), true, `${drift}: snapshot fixture`);
          },
          onSpawn: () => { spawns += 1; },
        }));
        assert.equal(result.status, "failed", drift);
        assert.match(result.reason ?? "", drift === "git-dir" ? /Git directory changed after planning/ : /Git common directory changed after planning/, drift);
        assert.equal(spawns, 0, drift);
        assert.equal(existsSync(leasePath), false, `${drift}: matching owned authority finalized`);
      } finally {
        metadata.restore();
      }
    });
  }
});

test("borrowed linked-worktree launch rejects equal-snapshot Git metadata identity drift and safely finalizes without spawn", async () => {
  for (const drift of ["git-dir", "common-dir"] as const) {
    await withPiEnv(async (root) => {
      const primary = join(root, "repo");
      const worktree = join(root, `borrowed-metadata-${drift}`);
      const branch = `feature/PAP-195-borrowed-metadata-${drift}`;
      execFileSync(REAL_GIT, ["worktree", "add", "-b", branch, worktree], { cwd: primary, stdio: "ignore" });
      process.chdir(worktree);
      const plannedSnapshot = captureRepositoryGitSnapshot(worktree);
      const metadata = preparePreflightMetadataDrift(root, worktree, drift);
      const parentDeploymentId = `d-parent-metadata-${drift}`;
      const parentDir = join(root, "deployments", parentDeploymentId);
      mkdirSync(parentDir, { recursive: true });
      const parent = acquireRepositoryMutationLease({
        canonicalRepoKey: "pa-platform", canonicalRepoRoot: primary, worktreeRoot: worktree,
        deploymentId: parentDeploymentId, deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", ticket: "PAP-195",
      });
      assert.equal(parent.status, "acquired", drift);
      if (parent.status !== "acquired") return;
      markParentRunning(parentDeploymentId);
      const parentPath = repositoryMutationLeasePath(worktree);
      const borrowerPath = repositoryMutationBorrowerPath(worktree);
      const parentBytes = readFileSync(parentPath);
      try {
        await withInheritedEnvironment({
          [PI_PARENT_LEASE_CAPABILITY_ENV]: parent.lease.ownershipToken,
          PA_DEPLOYMENT_ID: parentDeploymentId,
          PA_DEPLOYMENT_DIR: parentDir,
          PA_TEAM: "builder",
          PA_MODE: "orchestrator",
          PA_REPO: primary,
          PA_TICKET_ID: "PAP-195",
        }, async () => {
          let spawns = 0;
          const result = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-195", background: true, timeout: 60 }, stubAdapter({
            preflight: async () => {
              metadata.apply();
              assert.equal(repositoryGitSnapshotsEqual(plannedSnapshot, captureRepositoryGitSnapshot(worktree)), true, `${drift}: snapshot fixture`);
            },
            onSpawn: () => { spawns += 1; },
          }));
          assert.equal(result.status, "failed", drift);
          assert.match(result.reason ?? "", /repository-identity/, drift);
          assert.match(result.reason ?? "", drift === "git-dir" ? /Git directory changed after planning/ : /Git common directory changed after planning/, drift);
          assert.match(result.reason ?? "", /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s, drift);
          assert.equal((result.reason ?? "").length <= 2_000, true, drift);
          assert.equal(spawns, 0, drift);
          assert.equal(existsSync(borrowerPath), false, `${drift}: matching borrower finalized`);
          assert.deepEqual(readFileSync(parentPath), parentBytes, `${drift}: parent authority preserved`);
        });
      } finally {
        metadata.restore();
      }
      assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: primary, worktreeRoot: worktree, slot: "orchestrator", ownershipToken: parent.lease.ownershipToken }).status, "released", drift);
    });
  }
});

test("consumed dirty approval cannot authorize borrower drift introduced during Pi preflight", async () => {
  await withPiEnv(async (root) => {
    const primary = join(root, "repo");
    const worktree = join(root, "borrowed-preflight-dirty-approval");
    const branch = "feature/PAP-195-borrowed-dirty-approval";
    execFileSync(REAL_GIT, ["worktree", "add", "-b", branch, worktree], { cwd: primary, stdio: "ignore" });
    process.chdir(worktree);
    writeFileSync(join(worktree, "README.md"), "# approved dirty work\n");
    const parentDeploymentId = "d-parent-preflight-dirty";
    const parentDir = join(root, "deployments", parentDeploymentId);
    mkdirSync(parentDir, { recursive: true });
    const parent = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: primary, worktreeRoot: worktree,
      deploymentId: parentDeploymentId, deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", ticket: "PAP-195",
    });
    assert.equal(parent.status, "acquired");
    if (parent.status !== "acquired") return;
    markParentRunning(parentDeploymentId);
    const inspection = inspectRepositoryMutationLease(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktree, slot: "orchestrator" });
    assert.ok(inspection.evidenceIdentity);
    const approval: RepositoryDirtyBorrowApproval = {
      schemaVersion: 1,
      receiptId: "preflight-dirty-receipt",
      approvalReference: "preflight-dirty-approval",
      approvedAt: new Date().toISOString(),
      action: "preserve-and-continue",
      parentDeploymentId,
      parentDeploymentDirectory: parentDir,
      parentProcessFingerprint: parent.lease.processFingerprint,
      parentLeaseEvidenceIdentity: inspection.evidenceIdentity!,
      canonicalRepoKey: "pa-platform",
      canonicalRepoRoot: primary,
      worktreeRoot: worktree,
      ticket: "PAP-195",
      branch,
      snapshot: parent.lease.preLaunchGitSnapshot,
      classifications: [{ path: "README.md", classification: "active-ticket-preserved" }],
      plannedNewPaths: [],
    };
    const approvalPath = publishRepositoryDirtyBorrowApproval(approval);
    const parentPath = repositoryMutationLeasePath(worktree);
    const parentBytes = readFileSync(parentPath);
    await withInheritedEnvironment({
      [PI_PARENT_LEASE_CAPABILITY_ENV]: parent.lease.ownershipToken,
      PA_DEPLOYMENT_ID: parentDeploymentId,
      PA_DEPLOYMENT_DIR: parentDir,
      PA_TEAM: "builder",
      PA_MODE: "orchestrator",
      PA_REPO: primary,
      PA_TICKET_ID: "PAP-195",
    }, async () => {
      let spawns = 0;
      const result = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-195", background: true, timeout: 60 }, stubAdapter({
        preflight: async () => { writeFileSync(join(worktree, "outside-approved-scope.txt"), "arrived during preflight\n"); },
        onSpawn: () => { spawns += 1; },
      }));
      assert.equal(result.status, "failed");
      assert.equal(spawns, 0);
      assert.equal(existsSync(approvalPath), false, "the one-use dirty approval must remain consumed");
      assert.match(result.reason ?? "", /approved-path-containment/);
      assert.match(result.reason ?? "", /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
      assert.equal(inspectRepositoryMutationBorrower(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktree }).state, "absent");
      assert.deepEqual(readFileSync(parentPath), parentBytes);
    });
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: primary, worktreeRoot: worktree, slot: "orchestrator", ownershipToken: parent.lease.ownershipToken }).status, "released");
  });
});

test("REST-selected Pi defaults dirty builders to rejection before spawn without ownership", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    writeFileSync(join(repo, "dirty-rest.txt"), "dirty\n");
    let spawns = 0;
    const adapter = stubAdapter({ onSpawn: () => { spawns += 1; } });
    const { app } = createAgentApiApp({ hooks: composeRuntimeHooks({}, createPiHooks(adapter)) });
    const response = await app.request("/api/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: "builder", mode: "implement", runtime: "pi" }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { status: string; reason?: string };
    assert.equal(body.status, "failed");
    assert.match(body.reason ?? "", /state=dirty-background/);
    assert.ok((body.reason ?? "").length <= 2_000);
    assert.equal(spawns, 0);
    assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
  });
});

test("REST-selected Pi rejects malformed controls before hooks, spawn, sessions, or lease lifecycle", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    const leasePath = repositoryMutationLeasePath(repo);
    const sentinel = "malformed lease evidence must remain byte-identical\n";
    let deployHookCalls = 0;
    let spawns = 0;
    const adapter = stubAdapter({ onSpawn: () => { spawns += 1; } });
    const actualHooks = createPiHooks(adapter);
    const piHooks = {
      ...actualHooks,
      deploy: (...args: Parameters<NonNullable<typeof actualHooks.deploy>>) => {
        deployHookCalls += 1;
        return actualHooks.deploy!(...args);
      },
    };
    const api = createAgentApiApp({ hooks: composeRuntimeHooks({}, piHooks) });

    for (const force of [false, true]) {
      if (force) writeFileSync(leasePath, sentinel, { mode: 0o600 });
      for (const flag of ["listModes", "validate"] as const) {
        for (const value of ["true", 1, null, [], {}] as const) {
          const response = await api.app.request("/api/deploy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ team: "builder", mode: "implement", runtime: "pi", force, [flag]: value }),
          });
          assert.equal(response.status, 400);
          const body = await response.json() as { error: string; code: string };
          assert.deepEqual(body, { error: `${flag} must be a boolean`, code: "BAD_REQUEST" });
          assert.ok(body.error.length <= 2_000);
          if (force) assert.equal(readFileSync(leasePath, "utf8"), sentinel);
          else assert.equal(existsSync(leasePath), false);
        }
      }
    }

    assert.equal(deployHookCalls, 0);
    assert.equal(spawns, 0);
    assert.deepEqual(await (await api.app.request("/api/sessions")).json(), []);
    assert.equal(readdirSync(join(repo, ".git")).some((name) => name.includes("pa-repository-mutation.lease.json.quarantine.")), false);
    api.cleanup();
  });
});

test("PPA background launcher requires authenticated supervisor handoff and releases failed handoffs", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    let handedOffToken = "";
    const accepted = await deployWithPi({ team: "builder", mode: "implement", background: true }, stubAdapter({
      onSpawn: (opts) => { handedOffToken = opts.repositoryLease?.ownershipToken ?? ""; },
      result: (sessionId) => ({ sessionId, exitCode: 0, metadata: { sessionId, pending: true, supervisorPid: process.pid, repositoryLeaseTransferred: true } }),
    }));
    assert.equal(accepted.status, "pending", accepted.reason);
    assert.equal(inspectRepositoryMutationLease(repo).lease?.ownershipToken, handedOffToken);
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, ownershipToken: handedOffToken }).status, "released");

    const rejected = await deployWithPi({ team: "builder", mode: "implement", background: true }, stubAdapter({
      result: (sessionId) => ({ sessionId, exitCode: 0, metadata: { sessionId, pending: true, supervisorPid: process.pid } }),
    }));
    assert.equal(rejected.status, "failed");
    assert.match(rejected.reason ?? "", /did not authenticate repository ownership transfer/);
    assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
  });
});

test("50 mixed PPA and OPA same-root builder contenders produce exactly one owner and one spawn", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    let releaseFirst!: () => void;
    let spawns = 0;
    const held = new Promise<SpawnResult>((resolve) => { releaseFirst = () => resolve({ sessionId: "authoritative-session-id", exitCode: 0, metadata: { sessionId: "authoritative-session-id" } }); });
    const firstAdapter = stubAdapter({ onSpawn: () => { spawns += 1; }, result: () => held });
    const first = deployWithPi({ team: "builder", mode: "implement" }, firstAdapter);
    while (spawns === 0) await nextTick();
    assert.equal(inspectRepositoryMutationLease(repo).state, "live");

    const rejectedAdapter = (runtime: "pi" | "opencode"): RuntimeAdapter => ({
      name: runtime,
      defaultModel: runtime === "pi" ? "" : "stub/model",
      sessionFileName: runtime === "pi" ? "session-id-pi.txt" : "session-id-opencode.txt",
      installHooks() {},
      spawn() { spawns += 1; return { exitCode: 0 }; },
      resume() { spawns += 1; return { exitCode: 0 }; },
      extractActivity() { return []; },
      describeTools() { return { runtime, markdown: "stub" }; },
    });
    const contenders = Array.from({ length: 49 }, (_, index) => index % 2 === 0
      ? deployWithPi({ team: "builder", mode: "implement" }, rejectedAdapter("pi"))
      : deployWithOpencode({ team: "builder", mode: "implement" }, rejectedAdapter("opencode")));
    const outcomes = await Promise.all(contenders);
    assert.equal(outcomes.every((outcome) => outcome.status === "failed"), true);
    assert.equal(outcomes.every((outcome) => /state=live/.test(outcome.reason ?? "")), true);
    assert.equal(outcomes.every((outcome) => (outcome.reason ?? "").length <= 2_000), true);
    assert.equal(spawns, 1);
    assert.equal(inspectRepositoryMutationLease(repo).state, "live");
    releaseFirst();
    assert.equal((await first).status, "success");
    assert.equal(inspectRepositoryMutationLease(repo).state, "absent");
  });
});

test("one live inherited child excludes 50 sibling and unrelated PPA/OPA spawns, then the next authenticated child enters", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    git(["checkout", "-b", "feature/PAP-191-sibling-test"], repo);
    const parentDeploymentId = "d-parent-sibling";
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: parentDeploymentId,
      deploymentDirectory: join(root, "deployments", parentDeploymentId), runtime: "pi", team: "builder", mode: "orchestrator",
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    markParentRunning(parentDeploymentId);
    const capability = acquired.lease.ownershipToken;
    const parentBytes = readFileSync(repositoryMutationLeasePath(repo));
    await withInheritedEnvironment({
      [PI_PARENT_LEASE_CAPABILITY_ENV]: capability,
      PA_DEPLOYMENT_ID: parentDeploymentId,
      PA_DEPLOYMENT_DIR: join(root, "deployments", parentDeploymentId),
      PA_TEAM: "builder",
      PA_MODE: "orchestrator",
      PA_REPO: repo,
      PA_TICKET_ID: "PAP-191",
    }, async () => {
      let releaseFirst!: () => void;
      let spawns = 0;
      const held = new Promise<SpawnResult>((resolve) => { releaseFirst = () => resolve({ sessionId: "authoritative-session-id", exitCode: 0, metadata: { sessionId: "authoritative-session-id" } }); });
      const first = deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true, timeout: 60 }, stubAdapter({
        onSpawn: () => { spawns += 1; },
        result: () => held,
      }));
      while (spawns === 0) await nextTick();
      assert.equal(inspectRepositoryMutationBorrower(repo).state, "live");

      const rejectedAdapter = (runtime: "pi" | "opencode"): RuntimeAdapter => ({
        name: runtime,
        defaultModel: runtime === "pi" ? "" : "stub/model",
        sessionFileName: runtime === "pi" ? "session-id-pi.txt" : "session-id-opencode.txt",
        installHooks() {},
        spawn() { spawns += 1; return { exitCode: 0 }; },
        resume() { spawns += 1; return { exitCode: 0 }; },
        extractActivity() { return []; },
        describeTools() { return { runtime, markdown: "stub" }; },
      });
      const contenders = Array.from({ length: 50 }, (_, index) => index % 2 === 0
        ? deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true, timeout: 60 }, rejectedAdapter("pi"))
        : deployWithOpencode({ team: "builder", mode: "implement" }, rejectedAdapter("opencode")));
      const outcomes = await Promise.all(contenders);
      assert.equal(outcomes.every((outcome) => outcome.status === "failed"), true);
      assert.equal(spawns, 1);
      assert.deepEqual(readFileSync(repositoryMutationLeasePath(repo)), parentBytes);

      releaseFirst();
      assert.equal((await first).status, "success");
      assert.equal(inspectRepositoryMutationBorrower(repo).state, "absent");
      const next = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-191", background: true, timeout: 60 }, stubAdapter({ onSpawn: () => { spawns += 1; } }));
      assert.equal(next.status, "success", next.reason);
      assert.equal(spawns, 2);
      assert.deepEqual(readFileSync(repositoryMutationLeasePath(repo)), parentBytes);
    });
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, ownershipToken: capability }).status, "released");
  });
});

test("abnormal parent exit leaves a live borrower blocking normal and forced PPA/OPA until fingerprint mismatch", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    git(["checkout", "-b", "feature/PAP-191-abnormal-parent"], repo);
    const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    assert.ok(parent.pid);
    assert.ok(child.pid);
    try {
      const acquired = acquireRepositoryMutationLease({
        canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo, deploymentId: "d-abnormal-parent",
        deploymentDirectory: join(root, "parent"), runtime: "pi", team: "builder", mode: "orchestrator", pid: parent.pid,
      });
      assert.equal(acquired.status, "acquired");
      if (acquired.status !== "acquired") return;
      markParentRunning("d-abnormal-parent");
      const registration = registerRepositoryMutationBorrower({
        capability: acquired.lease.ownershipToken, canonicalRepoKey: "pa-platform", canonicalRepoRoot: repo,
        parentDeploymentId: "d-abnormal-parent", deploymentId: "d-live-child", deploymentDirectory: join(root, "child"),
        runtime: "pi", team: "builder", mode: "implement", launchMode: "background", ticket: "PAP-191",
        branch: "feature/PAP-191-abnormal-parent", timeoutSeconds: 60, pid: child.pid,
      });
      assert.equal(registration.status, "registered");
      parent.kill("SIGKILL");
      await new Promise<void>((resolve) => parent.once("close", () => resolve()));
      assert.equal(inspectRepositoryMutationLease(repo).state, "stale");
      assert.equal(inspectRepositoryMutationBorrower(repo).state, "live");

      let spawns = 0;
      const adapterFor = (runtime: "pi" | "opencode"): RuntimeAdapter => ({
        name: runtime, defaultModel: runtime === "pi" ? "" : "stub/model",
        sessionFileName: runtime === "pi" ? "session-id-pi.txt" : "session-id-opencode.txt",
        allocateSessionId: () => "authoritative-session-id",
        installHooks() {}, spawn(opts) { spawns += 1; return { sessionId: opts.sessionId, exitCode: 0, metadata: { sessionId: opts.sessionId } }; }, resume(opts) { spawns += 1; return { sessionId: opts.sessionId, exitCode: 0, metadata: { sessionId: opts.sessionId } }; },
        extractActivity() { return []; }, describeTools() { return { runtime, markdown: "stub" }; },
      });
      for (const force of [false, true]) {
        const ppa = await deployWithPi({ team: "builder", mode: "implement", force }, adapterFor("pi"));
        const opa = await deployWithOpencode({ team: "builder", mode: "implement", force }, adapterFor("opencode"));
        assert.equal(ppa.status, "failed");
        assert.equal(opa.status, "failed");
        assert.match(ppa.reason ?? "", /live borrower/);
        assert.match(opa.reason ?? "", /live borrower/);
      }
      assert.equal(spawns, 0);

      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      assert.equal(inspectRepositoryMutationBorrower(repo).state, "stale");
      const recovered = await deployWithPi({ team: "builder", mode: "implement", force: true }, adapterFor("pi"));
      assert.equal(recovered.status, "success", recovered.reason);
      assert.equal(spawns, 1);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

test("PPA and OPA builders hold different canonical repositories independently", async () => {
  await withPiEnv(async (root) => {
    const firstRepo = join(root, "repo");
    const secondRepo = join(root, "repo-two");
    initializeGitRepo(secondRepo);
    writeFileSync(join(root, "config", "repos.yaml"), `repos:\n  first:\n    path: ${firstRepo}\n  second:\n    path: ${secondRepo}\n`);
    let resolvePi!: () => void;
    let resolveOpa!: () => void;
    let spawns = 0;
    const piAdapter = stubAdapter({
      onSpawn: () => { spawns += 1; },
      result: (sessionId) => new Promise<SpawnResult>((resolve) => { resolvePi = () => resolve({ sessionId, exitCode: 0, metadata: { sessionId } }); }),
    });
    const opaBase: RuntimeAdapter = {
      name: "opencode", defaultModel: "stub/model", sessionFileName: "session-id-opencode.txt", installHooks() {},
      spawn() { spawns += 1; return new Promise<SpawnResult>((resolve) => { resolveOpa = () => resolve({ exitCode: 0 }); }); },
      resume() { return { exitCode: 0 }; }, extractActivity() { return []; }, describeTools() { return { runtime: "opencode", markdown: "stub" }; },
    };
    const piRun = deployWithPi({ team: "builder", mode: "implement", repo: "first" }, piAdapter);
    const opaRun = deployWithOpencode({ team: "builder", mode: "implement", repo: "second" }, opaBase);
    while (spawns < 2) await nextTick();
    assert.equal(inspectRepositoryMutationLease(firstRepo).state, "live");
    assert.equal(inspectRepositoryMutationLease(secondRepo).state, "live");
    resolvePi();
    resolveOpa();
    const outcomes = await Promise.all([piRun, opaRun]);
    assert.equal(outcomes.every((outcome) => outcome.status === "success"), true);
    assert.equal(inspectRepositoryMutationLease(firstRepo).state, "absent");
    assert.equal(inspectRepositoryMutationLease(secondRepo).state, "absent");
  });
});

test("PPA CWD-inferred linked worktrees preserve dirty state and carry dual-root evidence through foreground and background", async () => {
  await withPiEnv(async (root, gitState) => {
    const primary = join(root, "repo");
    const worktree = join(root, "linked-pap-195");
    execFileSync(REAL_GIT, ["worktree", "add", "-b", "feature/PAP-195-linked", worktree], { cwd: primary, stdio: "ignore" });
    writeFileSync(join(worktree, "README.md"), "# staged\n");
    execFileSync(REAL_GIT, ["add", "README.md"], { cwd: worktree, stdio: "ignore" });
    writeFileSync(join(worktree, "README.md"), "# staged\nunstaged\n");
    writeFileSync(join(worktree, "untracked.txt"), "preserve me\n");
    const nested = join(worktree, "nested");
    mkdirSync(nested);

    const beforeStatus = execFileSync(REAL_GIT, ["status", "--porcelain=v2", "--untracked-files=all", "-z"], { cwd: worktree });
    const beforeReadme = readFileSync(join(worktree, "README.md"));
    const beforeUntracked = readFileSync(join(worktree, "untracked.txt"));
    const observations: SpawnOpts[] = [];
    const adapter = stubAdapter({ onSpawn: (opts) => observations.push(opts), onResume: (opts) => observations.push(opts) });
    let resumeFrom = "";

    const launches = [
      { cwd: worktree, background: false },
      { cwd: nested, background: false },
      { cwd: nested, background: true },
    ];
    for (const [index, launch] of launches.entries()) {
      process.chdir(launch.cwd);
      const result = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-195", ...(launch.background ? { background: true } : {}) }, adapter);
      assert.equal(result.status, "success", result.reason);
      assert.equal(observations.length, index + 1, result.reason);
      if (index === 0) resumeFrom = result.deploymentId!;
      const opts = observations.at(-1)!;
      const plan = opts.executionPlan!;
      assert.equal(plan.repoRoot, primary);
      assert.equal(plan.worktreeRoot, worktree);
      assert.equal(plan.repositoryCwd, worktree);
      assert.equal(plan.repositoryKind, "linked");
      assert.equal(plan.memoryDocumentRoot, worktree);
      assert.equal(plan.environment.PA_REPO, primary);
      assert.equal(plan.environment.PA_WORKTREE_ROOT, worktree);
      assert.equal(plan.repositoryAdmission.slot, "implement");
      assert.equal(plan.repositoryAdmission.gitSnapshot?.dirty, true);
      assert.equal(opts.repositoryLease?.canonicalRepoRoot, primary);
      assert.equal(opts.repositoryLease?.worktreeRoot, worktree);
      assert.equal(opts.repositoryLease?.slot, "implement");
      const primer = readFileSync(opts.primerPath, "utf8");
      assert.match(primer, new RegExp(`^repo_root: ${escapeRegExp(primary)}$`, "m"));
      assert.match(primer, new RegExp(`^worktree_root: ${escapeRegExp(worktree)}$`, "m"));
      assert.match(primer, new RegExp(`^cwd: ${escapeRegExp(worktree)}$`, "m"));
      assert.match(primer, new RegExp(`^  PA_REPO: ${escapeRegExp(primary)}$`, "m"));
      assert.match(primer, new RegExp(`^  PA_WORKTREE_ROOT: ${escapeRegExp(worktree)}$`, "m"));
      const started = getDeploymentEvents(result.deploymentId!).find((event) => event.event === "started");
      assert.deepEqual({ repo: started?.repo, repoRoot: started?.repo_root, worktreeRoot: started?.worktree_root, slot: started?.repository_slot }, { repo: worktree, repoRoot: primary, worktreeRoot: worktree, slot: "implement" });
      assert.equal(inspectRepositoryMutationLease(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktree, slot: "implement" }).state, "absent");
    }

    process.chdir(nested);
    const resumed = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-195", resume: resumeFrom }, adapter);
    assert.equal(resumed.status, "success", resumed.reason);
    assert.equal(observations.length, 4);
    assert.equal(observations.at(-1)?.executionPlan?.repoRoot, primary);
    assert.equal(observations.at(-1)?.executionPlan?.worktreeRoot, worktree);
    assert.equal(observations.at(-1)?.executionPlan?.repositoryCwd, worktree);

    assert.deepEqual(execFileSync(REAL_GIT, ["status", "--porcelain=v2", "--untracked-files=all", "-z"], { cwd: worktree }), beforeStatus);
    assert.deepEqual(readFileSync(join(worktree, "README.md")), beforeReadme);
    assert.deepEqual(readFileSync(join(worktree, "untracked.txt")), beforeUntracked);
    const lifecycleOperations = gitState.readOperations().filter((args) => /^(checkout|switch|branch|reset|clean|restore|stash)$/.test(args[0] ?? "") || (args[0] === "worktree" && args[1] !== "list"));
    assert.deepEqual(lifecycleOperations, []);
  });
});

test("PPA linked-worktree local-remote commit and push stay on the preselected execution branch", async () => {
  await withPiEnv(async (root) => {
    const primary = join(root, "repo");
    const remote = join(root, "remote.git");
    const worktree = join(root, "git-workflow");
    const branch = "feature/PAP-195-local-remote";
    execFileSync(REAL_GIT, ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync(REAL_GIT, ["remote", "add", "origin", remote], { cwd: primary, stdio: "ignore" });
    execFileSync(REAL_GIT, ["worktree", "add", "-b", branch, worktree], { cwd: primary, stdio: "ignore" });
    process.chdir(worktree);

    let runtimeCwd = "";
    const adapter = stubAdapter({
      onSpawn: (opts) => {
        runtimeCwd = opts.executionPlan?.repositoryCwd ?? "";
        writeFileSync(join(runtimeCwd, "agent-authored.txt"), "committed from linked worktree\n");
        execFileSync(REAL_GIT, ["add", "agent-authored.txt"], { cwd: runtimeCwd, stdio: "ignore" });
        execFileSync(REAL_GIT, ["commit", "-m", "test linked-worktree workflow"], { cwd: runtimeCwd, stdio: "ignore" });
        execFileSync(REAL_GIT, ["push", "--set-upstream", "origin", branch], { cwd: runtimeCwd, stdio: "ignore" });
      },
    });
    const result = await deployWithPi({ team: "builder", mode: "implement", objective: "Exercise the existing Git workflow", foreground: true }, adapter);

    assert.equal(result.status, "success");
    assert.equal(runtimeCwd, worktree);
    assert.equal(execFileSync(REAL_GIT, ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).trim(), branch);
    const localHead = execFileSync(REAL_GIT, ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
    assert.equal(execFileSync(REAL_GIT, ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim(), localHead);
    assert.equal(execFileSync(REAL_GIT, ["branch", "--show-current"], { cwd: primary, encoding: "utf8" }).trim(), "develop");
    assert.equal(existsSync(join(primary, "agent-authored.txt")), false);
  });
});

test("PPA linked-worktree deployments enforce one orchestrator and one shared implement slot without blocking siblings", async () => {
  await withPiEnv(async (root) => {
    const primary = join(root, "repo");
    const worktreeA = join(root, "linked-slot-a");
    const worktreeB = join(root, "linked-slot-b");
    execFileSync(REAL_GIT, ["worktree", "add", "-b", "feature/PAP-195-slot-a", worktreeA], { cwd: primary, stdio: "ignore" });
    execFileSync(REAL_GIT, ["worktree", "add", "-b", "feature/PAP-195-slot-b", worktreeB], { cwd: primary, stdio: "ignore" });

    const releases: Array<() => void> = [];
    let preflights = 0;
    let spawns = 0;
    const heldAdapter = () => stubAdapter({
      preflight: async () => { preflights += 1; },
      onSpawn: () => { spawns += 1; },
      result: (sessionId) => new Promise<SpawnResult>((resolveResult) => {
        releases.push(() => resolveResult({ sessionId, exitCode: 0, metadata: { sessionId } }));
      }),
    });
    const start = (worktree: string, mode: string) => {
      process.chdir(worktree);
      return deployWithPi({ team: "builder", mode, ticket: "PAP-195" }, heldAdapter());
    };

    const active = [
      start(worktreeA, "orchestrator"),
      start(worktreeA, "implement"),
      start(worktreeB, "orchestrator"),
      start(worktreeB, "implement"),
    ];
    while (spawns < 4) await nextTick();
    assert.equal(inspectRepositoryMutationLease(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktreeA, slot: "orchestrator" }).state, "live");
    assert.equal(inspectRepositoryMutationLease(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktreeA, slot: "implement" }).state, "live");
    assert.equal(inspectRepositoryMutationLease(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktreeB, slot: "orchestrator" }).state, "live");
    assert.equal(inspectRepositoryMutationLease(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktreeB, slot: "implement" }).state, "live");

    process.chdir(worktreeA);
    const duplicateOrchestrator = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-195" }, stubAdapter({ preflight: async () => { preflights += 1; }, onSpawn: () => { spawns += 1; } }));
    const duplicateImplement = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-195" }, stubAdapter({ preflight: async () => { preflights += 1; }, onSpawn: () => { spawns += 1; } }));
    assert.equal(duplicateOrchestrator.status, "failed");
    assert.equal(duplicateImplement.status, "failed");
    assert.match(duplicateOrchestrator.reason ?? "", /slot=orchestrator.*state=live/);
    assert.match(duplicateImplement.reason ?? "", /slot=implement.*state=live/);
    assert.equal(preflights, 4, "occupied slots must reject before Pi/native-host preflight processes");
    assert.equal(spawns, 4, "occupied slots must reject before adapter spawn");

    for (const release of releases) release();
    await Promise.all(active);
    for (const worktree of [worktreeA, worktreeB]) {
      for (const slot of ["orchestrator", "implement"] as const) {
        assert.equal(inspectRepositoryMutationLease(primary, { getProcessFingerprint: readProcessFingerprint, worktreeRoot: worktree, slot }).state, "absent");
      }
    }
  });
});

test("PPA key and exact-path builder requests consume one canonical builder-exclusive admission plan", async () => {
  await withPiEnv(async (root, gitState) => {
    const repo = join(root, "repo");
    const observations: Array<{ plan: NonNullable<SpawnOpts["executionPlan"]>; primer: string; repositoryLease?: SpawnOpts["repositoryLease"]; registryRepo?: string; runtimeCwd?: string }> = [];
    for (const requestedRepo of ["pa-platform", repo]) {
      let captured: SpawnOpts | undefined;
      let runtimeCwd: string | undefined;
      const adapter = new class extends PiAdapter {
        override spawn(opts: SpawnOpts): Promise<SpawnResult> {
          captured = opts;
          return super.spawn(opts);
        }
      }({
        cwd: join(root, "adapter-local-cwd-must-not-win"),
        versionProbe: () => "0.84.4",
        nativeRegistryProbe: () => undefined,
        runCommand: (_args, options) => {
          runtimeCwd = options.cwd;
          return { status: 0, stdout: `${JSON.stringify({ type: "agent_end", stopReason: "stop" })}\n`, stderr: "" };
        },
      });

      const result = await deployWithPi({ team: "builder", mode: "implement", repo: requestedRepo, background: true }, adapter);
      assert.equal(result.status, "success", result.reason);
      assert.ok(captured?.executionPlan);
      const plan = captured.executionPlan;
      const primer = readFileSync(captured.primerPath, "utf8");
      const started = getDeploymentEvents(result.deploymentId!).find((event) => event.event === "started");
      observations.push({ plan, primer, repositoryLease: captured.repositoryLease, registryRepo: started?.repo, runtimeCwd });
    }

    for (const observation of observations) {
      assert.equal(Object.isFrozen(observation.plan), true);
      assert.equal(observation.plan.repoKey, "pa-platform");
      assert.equal(observation.plan.repoRoot, repo);
      assert.equal(observation.plan.repositoryCwd, repo);
      assert.equal(observation.plan.memoryDocumentRoot, repo);
      assert.equal(observation.plan.environment.PA_REPO, repo);
      assert.equal(observation.plan.userObjectiveOverride, undefined);
      assertBuilderExclusiveRepositoryAdmission(observation.plan, observation.primer);
      assert.equal(observation.plan.repositoryAdmission.launchMode, "background");
      assert.equal(observation.plan.repositoryAdmission.force, false);
      assert.equal(observation.plan.repositoryAdmission.gitSnapshot?.dirty, false);
      assert.ok(observation.repositoryLease?.ownershipToken);
      assert.equal(observation.repositoryLease?.canonicalRepoRoot, repo);
      assert.equal(observation.repositoryLease?.repositoryGitDir, observation.plan.repositoryGitDir);
      assert.equal(observation.repositoryLease?.repositoryGitCommonDir, observation.plan.repositoryGitCommonDir);
      assert.equal(observation.runtimeCwd, repo);
      assert.equal(observation.registryRepo, repo);
      assert.equal(observation.primer.match(/^## Additional Instructions$/gm)?.length, 1);
      assert.match(observation.primer, /No user objective override was provided/);
      assert.match(observation.primer, /^repo_key: pa-platform$/m);
      assert.match(observation.primer, new RegExp(`^repo_root: ${escapeRegExp(repo)}$`, "m"));
      assert.match(observation.primer, new RegExp(`^repo: ${escapeRegExp(repo)}$`, "m"));
      assert.match(observation.primer, new RegExp(`^  PA_REPO: ${escapeRegExp(repo)}$`, "m"));
    }
    assert.deepEqual(
      observations.map(({ plan, registryRepo, runtimeCwd }) => ({ key: plan.repoKey, root: plan.repoRoot, paRepo: plan.environment.PA_REPO, memoryRoot: plan.memoryDocumentRoot, registryRepo, runtimeCwd })),
      [0, 1].map(() => ({ key: "pa-platform", root: repo, paRepo: repo, memoryRoot: repo, registryRepo: repo, runtimeCwd: repo })),
    );
    assert.deepEqual(gitState.readOperations(), []);
  });
});

test("PPA rejects invalid and ambiguous repository inputs before preflight or runtime spawn", async () => {
  await withPiEnv(async (root) => {
    const repo = join(root, "repo");
    const worktree = join(root, "linked-worktree");
    git(["worktree", "add", "-b", "feature/rejected-explicit-worktree", worktree], repo);
    let preflights = 0;
    let spawns = 0;
    const adapter = stubAdapter({
      preflight: async () => { preflights += 1; },
      onSpawn: () => { spawns += 1; },
    });
    const invalid = await deployWithPi({ team: "builder", mode: "implement", repo: worktree }, adapter);
    assert.equal(invalid.status, "failed");
    assert.match(invalid.reason ?? "", /registered project paths only/);
    assert.ok((invalid.reason ?? "").length <= 2000);

    const second = join(root, "registered-worktree");
    const ambiguous = join(root, "ambiguous-worktree");
    git(["worktree", "add", "-b", "feature/registered-worktree", second], repo);
    git(["worktree", "add", "-b", "feature/ambiguous-worktree", ambiguous], repo);
    writeFileSync(join(root, "config", "repos.yaml"), `repos:\n  first:\n    path: ${repo}\n  second:\n    path: ${second}\n`);
    const rejected = await deployWithPi({ team: "builder", mode: "implement", repo: ambiguous }, adapter);
    assert.equal(rejected.status, "failed");
    assert.match(rejected.reason ?? "", /linked Git working tree/);
    assert.ok((rejected.reason ?? "").length <= 2000);
    assert.equal(preflights, 0);
    assert.equal(spawns, 0);
  });
});

test("unattended foreground registry completion stays staged and running until PTY exit", async () => {
  await withPiEnv(async () => {
    let deployId = "";
    let deployDir = "";
    let resolveSpawn!: (result: SpawnResult) => void;
    const adapter = stubAdapter({
      onSpawn: (opts) => { deployId = opts.deployId; deployDir = getDeployPaths(opts.deployId).deployDir; },
      result: (sessionId) => new Promise<SpawnResult>((resolve) => { resolveSpawn = resolve; }).then((result) => ({ ...result, sessionId, metadata: { ...(result.metadata ?? {}), sessionId } })),
    });
    const deploymentPromise = deployWithPi({ team: "builder", mode: "implement" }, adapter);
    await nextTick();
    assert.ok(deployId);

    const previousExecutionMode = process.env["PA_PI_EXECUTION_MODE"];
    const previousDeploymentId = process.env["PA_DEPLOYMENT_ID"];
    const previousDeploymentDir = process.env["PA_DEPLOYMENT_DIR"];
    process.env["PA_PI_EXECUTION_MODE"] = "foreground";
    process.env["PA_DEPLOYMENT_ID"] = deployId;
    process.env["PA_DEPLOYMENT_DIR"] = deployDir;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let result: Awaited<typeof deploymentPromise>;
    try {
      const code = await runCoreCommand([
        "registry", "complete", deployId,
        "--status", "success",
        "--summary", "unattended objective complete",
        "--log-file", "/tmp/foreground-session.md",
        "--rating-overall", "4",
        "--rating-quality", "5",
      ], { binaryName: "ppa", io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } });
      assert.equal(code, 0);
      assert.deepEqual(stderr, []);
      assert.doesNotMatch(stdout.join("\n"), new RegExp(`^Completed ${deployId}`, "m"));
      assert.equal(queryDeploymentStatus(deployId)?.status, "running");
      assert.equal(getDeploymentEvents(deployId).filter((event) => event.event === "completed" || event.event === "crashed").length, 0);
      assert.equal(statSync(join(deployDir, PI_FOREGROUND_COMPLETION_FILE)).mode & 0o777, 0o600);
      const staged = readPiForegroundCompletion(deployDir);
      assert.equal(staged?.status, "success");
      assert.equal(staged?.summary, "unattended objective complete");
      assert.equal(staged?.logFile, "/tmp/foreground-session.md");
      assert.equal(staged?.rating?.overall, 4);
      assert.equal(staged?.rating?.quality, 5);
    } finally {
      restore("PA_PI_EXECUTION_MODE", previousExecutionMode);
      restore("PA_DEPLOYMENT_ID", previousDeploymentId);
      restore("PA_DEPLOYMENT_DIR", previousDeploymentDir);
      resolveSpawn({ exitCode: 0 });
      result = await deploymentPromise;
    }

    assert.equal(result.status, "success");
    const terminal = getDeploymentEvents(deployId).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.status, "success");
    assert.equal(terminal[0]?.summary, "unattended objective complete");
    assert.equal(terminal[0]?.log_file, "/tmp/foreground-session.md");
    assert.equal(terminal[0]?.rating?.overall, 4);
    assert.equal(terminal[0]?.rating?.quality, 5);
    assert.equal(existsSync(join(deployDir, PI_FOREGROUND_COMPLETION_FILE)), false);
  });
});

test("foreground exit publishes staged partial and failed mappings with payload preservation", async () => {
  for (const stagedStatus of ["partial", "failed"] as const) {
    await withPiEnv(async () => {
      let deploymentId = "";
      let deployDir = "";
      const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({
        onSpawn: (opts) => { deploymentId = opts.deployId; deployDir = getDeployPaths(opts.deployId).deployDir; },
        result: (sessionId) => {
          writePiForegroundCompletion(deployDir, {
            type: "registry_complete",
            deploymentId,
            status: stagedStatus,
            timestamp: "2026-08-30T00:00:00.000Z",
            summary: `${stagedStatus} staged summary`,
            logFile: `/tmp/${stagedStatus}.md`,
            rating: { source: "agent", overall: 3, productivity: 4, quality: 3, efficiency: 2, insight: 3 },
            fallback: true,
          });
          return { sessionId, exitCode: 0, metadata: { sessionId } };
        },
      }));

      assert.equal(result.status, stagedStatus === "failed" ? "failed" : "success");
      const terminal = getDeploymentEvents(deploymentId).filter((event) => event.event === "completed" || event.event === "crashed");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.event, "completed");
      assert.equal(terminal[0]?.status, stagedStatus);
      assert.equal(terminal[0]?.summary, `${stagedStatus} staged summary`);
      assert.equal(terminal[0]?.log_file, `/tmp/${stagedStatus}.md`);
      assert.deepEqual(terminal[0]?.rating, { source: "agent", overall: 3, productivity: 4, quality: 3, efficiency: 2, insight: 3 });
      assert.equal(terminal[0]?.fallback, true);
      assert.equal(terminal[0]?.exit_code, stagedStatus === "failed" ? 1 : 0);
      assert.equal(readPiTerminalStatus(deployDir)?.stopReason, stagedStatus === "failed" ? "error" : "stop");
      assert.equal(existsSync(join(deployDir, PI_FOREGROUND_COMPLETION_FILE)), false);
    });
  }
});

test("malformed foreground completion sidecars fall back without publishing before Pi exits", async () => {
  await withPiEnv(async () => {
    let deployId = "";
    let deployDir = "";
    let resolveSpawn!: (result: SpawnResult) => void;
    const adapter = stubAdapter({
      onSpawn: (opts) => { deployId = opts.deployId; deployDir = getDeployPaths(opts.deployId).deployDir; },
      result: (sessionId) => new Promise<SpawnResult>((resolve) => { resolveSpawn = resolve; }).then((result) => ({ ...result, sessionId, metadata: { ...(result.metadata ?? {}), sessionId } })),
    });
    const deploymentPromise = deployWithPi({ team: "builder", mode: "implement" }, adapter);
    await nextTick();
    writeFileSync(join(deployDir, PI_FOREGROUND_COMPLETION_FILE), "{malformed\n", { mode: 0o600 });
    assert.equal(getDeploymentEvents(deployId).filter((event) => event.event === "completed" || event.event === "crashed").length, 0);
    resolveSpawn({ exitCode: 0 });
    const result = await deploymentPromise;
    assert.equal(result.status, "success");
    const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.status, "partial");
    assert.match(terminal[0]?.summary ?? "", /without a staged completion payload/);
    assert.equal(existsSync(join(deployDir, PI_FOREGROUND_COMPLETION_FILE)), false);
    const diagnostics = readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath).filter((event) => event.kind === "error");
    assert.match(diagnostics.at(-1)?.body ?? "", /foreground completion sidecar is malformed/);
    assert.ok((diagnostics.at(-1)?.body.length ?? 501) <= 500);
  });
});

test("background registry completion remains immediate and exactly once", async () => {
  await withPiEnv(async (root) => {
    let deployId = "";
    let repositoryToken = "";
    const adapter = stubAdapter({
      onSpawn: (opts) => { deployId = opts.deployId; repositoryToken = opts.repositoryLease?.ownershipToken ?? ""; },
      result: (sessionId) => ({ sessionId, exitCode: 0, metadata: { sessionId, pending: true, supervisorPid: process.pid, pid: process.pid, repositoryLeaseTransferred: true } }),
    });
    const deployed = await deployWithPi({ team: "builder", mode: "implement", background: true }, adapter);
    assert.equal(deployed.status, "pending");

    const previousExecutionMode = process.env["PA_PI_EXECUTION_MODE"];
    process.env["PA_PI_EXECUTION_MODE"] = "background";
    const stdout: string[] = [];
    try {
      assert.equal(await runCoreCommand([
        "registry", "complete", deployId, "--status", "success", "--summary", "background complete",
      ], { binaryName: "ppa", io: { stdout: (line) => stdout.push(line), stderr: () => {} } }), 0);
    } finally {
      restore("PA_PI_EXECUTION_MODE", previousExecutionMode);
    }
    assert.match(stdout.join("\n"), new RegExp(`Completed ${deployId} with status success`));
    assert.equal(queryDeploymentStatus(deployId)?.status, "success");
    const terminal = getDeploymentEvents(deployId).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.summary, "background complete");
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: join(root, "repo"), ownershipToken: repositoryToken }).status, "released");
  });
});

test("new foreground Pi deployments omit the adapter deadline but retain timeout metadata", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.ok(captured);
    assert.equal(captured.mode, "foreground");
    assert.equal(Object.hasOwn(captured, "timeoutMs"), false);
    assert.equal(captured.timeoutMs, undefined);
    assertTimeoutMetadata(captured, 1800);
  });
});

test("new background Pi deployments pass the resolved adapter deadline while retaining supervision metadata", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement", background: true, timeout: 2400 }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.ok(captured);
    assert.equal(captured.mode, "background");
    assert.equal(captured.timeoutMs, 2_400_000);
    assertTimeoutMetadata(captured, 2400);
  });
});

test("ordinary background termination retains one causal failure with no Git state operation", async () => {
  await withPiEnv(async (_root, gitState) => {
    const launcher = new BackgroundDeploymentProcess(88_001);
    let config: PiBackgroundConfig | undefined;
    const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: {
      launchBackgroundRunner: ((_runnerPath, configPath) => {
        config = readPiBackgroundConfig(configPath);
        if (config.repositoryHandoffPath) {
          const handoff = readPiRepositoryHandoff(config.repositoryHandoffPath);
          if (handoff.repositoryLease) config.repositoryLease = handoff.repositoryLease;
          if (handoff.repositoryBorrower) config.repositoryBorrower = handoff.repositoryBorrower;
          rmSync(config.repositoryHandoffPath);
          delete config.repositoryHandoffPath;
        }
        writePiSupervisorOwnership(join(configPath, "..", PI_SUPERVISOR_FILE), {
          schemaVersion: 1,
          deploymentId: config.deploymentId,
          ownershipToken: config.ownershipToken,
          state: "active",
          ready: true,
          supervisorPid: launcher.pid,
          childPid: 88_002,
          updatedAt: new Date().toISOString(),
          finalizationDeadlineMs: 5_000,
        });
        return launcher as never;
      }),
    } });
    const deployed = await deployWithPi({ team: "builder", mode: "implement", background: true, timeout: 60 }, adapter);
    assert.equal(deployed.status, "pending");
    assert.equal(config?.timeoutMs, 60_000);

    const child = new BackgroundDeploymentProcess(88_002);
    let timeoutCallback: (() => void) | undefined;
    let now = 0;
    let gone = false;
    const signals: NodeJS.Signals[] = [];
    const running = runPiBackgroundRunner(config!, { supervision: {
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
    await nextTick();
    timeoutCallback?.();
    await running;
    const terminal = getDeploymentEvents(deployed.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(terminal.length, 1);
    assert.match(terminal[0]?.summary ?? "", /runner-timeout:/);
    assert.equal(queryDeploymentStatus(deployed.deploymentId!)?.status, "failed");
    assert.ok(now < 5_000);
    assert.deepEqual(gitState.readOperations(), []);
  });
});

test("ticketed, standalone, resume, and evaluator foreground routes share deferred reconciliation without adapter deadlines", async () => {
  await withPiEnv(async () => {
    const captured: Array<{ kind: "spawn" | "resume"; opts: SpawnOpts }> = [];
    let activeOpts: SpawnOpts | undefined;
    const adapter = stubAdapter({
      onSpawn: (opts) => { activeOpts = opts; captured.push({ kind: "spawn", opts }); },
      onResume: (opts) => { activeOpts = opts; captured.push({ kind: "resume", opts }); },
      result: (sessionId) => {
        assert.ok(activeOpts);
        writePiForegroundCompletion(getDeployPaths(activeOpts.deployId).deployDir, {
          type: "registry_complete",
          deploymentId: activeOpts.deployId,
          status: "success",
          timestamp: "2026-08-30T00:00:00.000Z",
          summary: `route complete ${captured.length}`,
        });
        return { sessionId, exitCode: 0, metadata: { sessionId } };
      },
    });
    const standalone = await deployWithPi({ team: "builder", mode: "implement", timeout: 1200 }, adapter);
    const ticketed = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-159", timeout: 1200 }, adapter);
    const resumed = await deployWithPi({ team: "builder", mode: "implement", resume: standalone.deploymentId, timeout: 1200 }, adapter);
    const evaluator = await deployWithPi({ team: "builder", mode: "implement", evaluateDeployment: "d-abcdef", timeout: 600 }, adapter);

    for (const result of [standalone, ticketed, resumed, evaluator]) {
      assert.equal(result.status, "success", result.reason);
      const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.status, "success");
      assert.equal(existsSync(join(getDeployPaths(result.deploymentId!).deployDir, PI_FOREGROUND_COMPLETION_FILE)), false);
    }
    assert.deepEqual(captured.map((item) => item.kind), ["spawn", "spawn", "resume", "spawn"]);
    assert.ok(captured.every((item) => item.opts.mode === "foreground" && item.opts.timeoutMs === undefined));
    assert.ok(captured.every((item) => item.opts.env?.["PA_PI_EXECUTION_MODE"] === "foreground"));
    assertTimeoutMetadata(captured[0]!.opts, 1200);
    assertTimeoutMetadata(captured[1]!.opts, 1200);
    assertTimeoutMetadata(captured[2]!.opts, 1200);
    assertTimeoutMetadata(captured[3]!.opts, 600);
    assert.equal(getDeploymentEvents(ticketed.deploymentId!)[0]?.ticket_id, "PAP-159");
    assert.equal(getDeploymentEvents(resumed.deploymentId!)[0]?.resumed_from_deployment_id, standalone.deploymentId);
  });
});

test("Pi preflight failure is controlled, actionable, and leaves no session file", async () => {
  await withPiEnv(async () => {
    let spawned = 0;
    const adapter = stubAdapter({
      preflight: async () => { throw new Error("Pi version probe timed out after 5ms."); },
      onSpawn: () => { spawned++; },
    });
    const result = await deployWithPi({ team: "builder", mode: "implement" }, adapter);
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /Pi version probe timed out after 5ms/);
    assert.equal(spawned, 0);
    assert.ok(result.deploymentId);
    const paths = getDeployPaths(result.deploymentId!);
    assert.equal(existsSync(join(paths.deployDir, "session-id-pi.txt")), false);
    assert.deepEqual(getDeploymentEvents(result.deploymentId!).map((event) => event.event), ["started", "completed"]);
    assert.equal(getDeploymentEvents(result.deploymentId!)[1]?.status, "failed");
    const errors = readActivityEvents(paths.activityLogPath).filter((event) => event.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.body ?? "", /Pi version probe timed out after 5ms/);
  });
});

test("Pi foreground failure keeps its original reason with no Git state operation", async () => {
  await withPiEnv(async (_root, gitState) => {
    const adapter = stubAdapter({ result: () => ({ exitCode: 1, errorMessage: "model auth failed" }) });
    const result = await deployWithPi({ team: "builder", mode: "implement" }, adapter);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "model auth failed");
    assert.doesNotMatch(result.reason ?? "", /session id different/);
    assert.ok(result.deploymentId);
    const events = getDeploymentEvents(result.deploymentId!);
    assert.deepEqual(events.map((event) => event.event), ["started", "completed"]);
    assert.equal(events[1]?.summary, "ppa deploy failed: model auth failed");
    const error = readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath).find((event) => event.kind === "error");
    assert.match(error?.body ?? "", /model auth failed/);
    assert.deepEqual(gitState.readOperations(), []);
  });
});

test("managed Pi outcomes emit one accurate bounded redacted terminal event", async () => {
  const secret = "configured-terminal-secret";
  const previous = process.env["PAP_151_API_KEY"];
  process.env["PAP_151_API_KEY"] = secret;
  try {
    const cases: Array<{ name: string; adapter: ReturnType<typeof stubAdapter>; event: "completed" | "crashed"; status?: "success" | "partial" | "failed"; reason: RegExp }> = [
      { name: "success", adapter: stubAdapter({}), event: "completed", status: "partial", reason: /without a staged completion payload/ },
      { name: "validation", adapter: stubAdapter({ preflight: async () => { throw new Error(`validation failed ${secret}`); } }), event: "completed", status: "failed", reason: /validation failed/ },
      { name: "native-load", adapter: stubAdapter({ preflight: async () => { throw new Error(`native-load: undefined V8 symbol ${secret} ${"x".repeat(3000)}`); } }), event: "completed", status: "failed", reason: /native-load: undefined V8 symbol/ },
      { name: "malformed", adapter: stubAdapter({ result: () => ({ exitCode: 1, errorMessage: `Malformed Pi tool call todo ${secret}` }) }), event: "completed", status: "failed", reason: /Malformed Pi tool call/ },
      { name: "nonzero", adapter: stubAdapter({ result: () => ({ exitCode: 17, errorMessage: `pi exited with code 17 ${secret}` }) }), event: "completed", status: "failed", reason: /code 17/ },
      { name: "launcher", adapter: stubAdapter({ result: () => { throw new Error(`launcher exception ${secret}`); } }), event: "crashed", reason: /launcher exception/ },
    ];
    for (const item of cases) {
      await withPiEnv(async () => {
        const result = await deployWithPi({ team: "builder", mode: "implement" }, item.adapter);
        assert.equal(result.status, item.name === "success" ? "success" : "failed", item.name);
        const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
        assert.equal(terminal.length, 1, item.name);
        assert.equal(terminal[0]?.event, item.event, item.name);
        assert.notEqual(terminal[0]?.fallback, true, item.name);
        if (item.status) assert.equal(terminal[0]?.status, item.status, item.name);
        const diagnostic = String(terminal[0]?.summary ?? terminal[0]?.error ?? "");
        assert.match(diagnostic, item.reason, item.name);
        assert.ok(diagnostic.length <= 2000, item.name);
        assert.doesNotMatch(diagnostic, new RegExp(secret), item.name);
        const paths = getDeployPaths(result.deploymentId!);
        const marker = readPiTerminalStatus(paths.deployDir);
        assert.equal(marker?.stopReason, item.name === "success" ? "stop" : "error", item.name);
        assert.equal(marker?.error, item.name === "success" ? undefined : diagnostic, item.name);
        assert.equal(statSync(join(paths.deployDir, "pi-terminal-status.json")).mode & 0o777, 0o600, item.name);
        assert.doesNotMatch(readFileSync(join(paths.deployDir, "pi-terminal-status.json"), "utf8"), new RegExp(secret), item.name);
        for (const activity of readActivityEvents(paths.activityLogPath)) {
          assert.ok(activity.body.length <= 500, item.name);
          assert.doesNotMatch(activity.body, new RegExp(secret), item.name);
        }
      });
    }
  } finally {
    restore("PAP_151_API_KEY", previous);
  }
});

test("deploy reconciliation replaces a turn marker with the authoritative exit outcome", async () => {
  await withPiEnv(async () => {
    const turnTimestamp = "2026-08-28T00:00:00.000Z";
    let deployDir = "";
    const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({
      onSpawn: (opts) => { deployDir = getDeployPaths(opts.deployId).deployDir; },
      result: (sessionId) => {
        writePiTerminalStatus(deployDir, { type: "agent_end", stopReason: "stop", timestamp: turnTimestamp });
        return { sessionId, exitCode: 0, metadata: { sessionId } };
      },
    }));
    assert.equal(result.status, "success");
    const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.status, "partial");
    assert.notEqual(terminal[0]?.timestamp, turnTimestamp);
    assert.equal(readPiTerminalStatus(deployDir)?.timestamp, terminal[0]?.timestamp);
  });
});

test("background supervisor honors an agent-owned successful terminal registry event", async () => {
  await withPiEnv(async () => {
    let deploymentId = "";
    const result = await deployWithPi({ team: "builder", mode: "implement", background: true }, stubAdapter({
      onSpawn: (opts) => { deploymentId = opts.deployId; },
      result: (sessionId) => {
        appendRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "completed", timestamp: "2026-08-28T05:20:45.081Z", status: "success", summary: "attachment summary" });
        return { sessionId, exitCode: 0, metadata: { sessionId, pending: true, monitor: { completion: Promise.resolve({ status: 0, stdout: "", stderr: "" }) } } };
      },
    }));
    assert.equal(result.status, "pending");
    await nextTick();
    const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.summary, "attachment summary");
    const marker = readPiTerminalStatus(getDeployPaths(result.deploymentId!).deployDir);
    assert.equal(marker?.stopReason, "stop");
    assert.equal(marker?.timestamp, "2026-08-28T05:20:45.081Z");
  });
});

test("supervisor fails closed when an agent-owned crash conflicts with adapter success", async () => {
  await withPiEnv(async () => {
    let deploymentId = "";
    const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({
      onSpawn: (opts) => { deploymentId = opts.deployId; },
      result: (sessionId) => {
        appendRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "crashed", timestamp: "2026-08-28T05:20:45.081Z", error: "agent shutdown failed", exit_code: 1 });
        return { sessionId, exitCode: 0, metadata: { sessionId } };
      },
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "agent shutdown failed");
    const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.event, "crashed");
    const marker = readPiTerminalStatus(getDeployPaths(result.deploymentId!).deployDir);
    assert.equal(marker?.stopReason, "error");
    assert.equal(marker?.error, "agent shutdown failed");
  });
});

test("foreground fatal exit overrides staged successful and partial completion payloads", async () => {
  for (const stagedStatus of ["success", "partial"] as const) {
    await withPiEnv(async () => {
      let deploymentId = "";
      let deployDir = "";
      const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({
        onSpawn: (opts) => { deploymentId = opts.deployId; deployDir = getDeployPaths(opts.deployId).deployDir; },
        result: (sessionId) => {
          writePiForegroundCompletion(deployDir, {
            type: "registry_complete",
            deploymentId,
            status: stagedStatus,
            timestamp: "2026-08-30T00:00:00.000Z",
            summary: `staged ${stagedStatus} must not win`,
            rating: { source: "agent", overall: 5 },
          });
          return { sessionId, exitCode: 17, errorMessage: "Pi exited fatally with code 17", metadata: { sessionId } };
        },
      }));
      assert.equal(result.status, "failed");
      const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.status, "failed");
      assert.match(terminal[0]?.summary ?? "", /fatally with code 17/);
      assert.notEqual(terminal[0]?.summary, `staged ${stagedStatus} must not win`);
      assert.equal(terminal[0]?.rating, undefined);
      assert.ok((terminal[0]?.summary?.length ?? 2_001) <= 2_000);
      assert.equal(existsSync(join(deployDir, PI_FOREGROUND_COMPLETION_FILE)), false);
      const diagnostics = readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath).filter((event) => event.kind === "error");
      assert.ok(diagnostics.length > 0);
      assert.ok(diagnostics.every((event) => event.body.length <= 500));
    });
  }
});

test("real foreground cleanup failures override staged success exactly once", async () => {
  for (const failure of ["exit-17", "cleanup-deadline"] as const) {
    await withPiEnv(async () => {
      let now = 0;
      let running = true;
      const input = new ForegroundDeploymentInput();
      const output = { write() { return true; } };
      let pty!: ForegroundDeploymentPty;
      pty = new ForegroundDeploymentPty(() => {}, failure === "exit-17" ? 77_017 : 77_099, (signal) => {
        if (failure === "exit-17" && signal === "SIGTERM") {
          running = false;
          queueMicrotask(() => pty.emitExit(17));
        }
      });
      const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: {
        spawnPty: () => pty as never, input: input as never, output: output as never,
        processExists: () => running,
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
      } });
      const deploymentPromise = deployWithPi({ team: "builder", mode: "implement" }, adapter);
      await nextTick();
      const live = queryDeploymentStatuses()[0];
      assert.ok(live);
      const deployDir = getDeployPaths(live.deploy_id).deployDir;
      writePiForegroundCompletion(deployDir, {
        type: "registry_complete",
        deploymentId: live.deploy_id,
        status: "success",
        timestamp: "2026-08-30T00:00:00.000Z",
        summary: `staged success must not survive ${failure}`,
        rating: { source: "agent", overall: 5 },
      });

      const cleanupStartedAt = now;
      input.emit("end");
      const result = await deploymentPromise;
      assert.equal(result.status, "failed", failure);
      assert.match(result.reason ?? "", failure === "exit-17" ? /Pi exited with code 17/ : /PTY child exit was not confirmed before cleanup deadline/);
      const terminal = getDeploymentEvents(live.deploy_id).filter((event) => event.event === "completed" || event.event === "crashed");
      assert.equal(terminal.length, 1, failure);
      assert.equal(terminal[0]?.status, "failed", failure);
      assert.notEqual(terminal[0]?.summary, `staged success must not survive ${failure}`);
      assert.equal(terminal[0]?.rating, undefined);
      assert.equal(queryDeploymentStatus(live.deploy_id)?.status, "failed");
      assert.equal(existsSync(join(deployDir, PI_FOREGROUND_COMPLETION_FILE)), false);
      assert.deepEqual(pty.signals, failure === "exit-17" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
      assert.ok(now - cleanupStartedAt <= 4_900);
      assert.equal(input.isRaw, false);
    });
  }
});

test("foreground supervisor replaces agent success when adapter settlement fails", async () => {
  for (const item of [
    { name: "nonzero", result: (sessionId: string) => ({ sessionId, exitCode: 17, errorMessage: "Pi exited with code 17", metadata: { sessionId } }), reason: /code 17/, exitCode: 17 },
    { name: "semantic", result: (sessionId: string) => ({ sessionId, exitCode: 0, metadata: { sessionId, terminalError: "terminal semantic error" } }), reason: /semantic error/, exitCode: 1 },
  ]) {
    await withPiEnv(async () => {
      let deploymentId = "";
      const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({
        onSpawn: (opts) => { deploymentId = opts.deployId; },
        result: (sessionId) => {
          appendRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "completed", timestamp: "2026-08-28T05:20:45.081Z", status: "success", summary: "agent claimed success", exit_code: 0 });
          writePiTerminalStatus(getDeployPaths(deploymentId).deployDir, { type: "agent_end", stopReason: "stop", timestamp: "2026-08-28T05:20:45.081Z" });
          return item.result(sessionId);
        },
      }));
      assert.equal(result.status, "failed", item.name);
      assert.match(result.reason ?? "", item.reason, item.name);
      const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
      assert.equal(terminal.length, 1, item.name);
      assert.equal(terminal[0]?.status, "failed", item.name);
      assert.equal(terminal[0]?.exit_code, item.exitCode, item.name);
      assert.match(terminal[0]?.summary ?? "", item.reason, item.name);
      assert.equal(queryDeploymentStatus(result.deploymentId!)?.status, "failed", item.name);
      const marker = readPiTerminalStatus(getDeployPaths(result.deploymentId!).deployDir);
      assert.equal(marker?.stopReason, "error", item.name);
      assert.match(marker?.error ?? "", item.reason, item.name);
    });
  }
});

test("launcher failure replaces an agent success with one crashed representation", async () => {
  await withPiEnv(async () => {
    let deploymentId = "";
    const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({
      onSpawn: (opts) => { deploymentId = opts.deployId; },
      result: () => {
        appendRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "completed", timestamp: "2026-08-28T05:20:45.081Z", status: "success", summary: "agent claimed success", exit_code: 0 });
        throw new Error("launcher settlement failed");
      },
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "launcher settlement failed");
    const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.event, "crashed");
    assert.equal(terminal[0]?.exit_code, 1);
    assert.equal(readPiTerminalStatus(getDeployPaths(result.deploymentId!).deployDir)?.stopReason, "error");
  });
});

test("background supervisor replaces agent success and stop marker after failed settlement", async () => {
  await withPiEnv(async () => {
    let deploymentId = "";
    const result = await deployWithPi({ team: "builder", mode: "implement", background: true }, stubAdapter({
      onSpawn: (opts) => { deploymentId = opts.deployId; },
      result: (sessionId) => {
        appendRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "completed", timestamp: "2026-08-28T05:20:45.081Z", status: "success", summary: "agent claimed success", exit_code: 0 });
        writePiTerminalStatus(getDeployPaths(deploymentId).deployDir, { type: "agent_end", stopReason: "stop", timestamp: "2026-08-28T05:20:45.081Z" });
        return { sessionId, exitCode: 0, metadata: { sessionId, pending: true, monitor: { completion: Promise.resolve({ status: 17, stdout: "", stderr: "Pi exited with code 17" }) } } };
      },
    }));
    assert.equal(result.status, "pending");
    await nextTick();
    const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.status, "failed");
    assert.equal(terminal[0]?.exit_code, 17);
    assert.match(terminal[0]?.summary ?? "", /code 17/);
    assert.equal(queryDeploymentStatus(result.deploymentId!)?.status, "failed");
    assert.equal(readPiTerminalStatus(getDeployPaths(result.deploymentId!).deployDir)?.stopReason, "error");
  });
});

test("background terminal diagnostics cannot retain success status or exit zero", async () => {
  await withPiEnv(async () => {
    const adapter = stubAdapter({ result: (sessionId) => ({
      sessionId,
      exitCode: 0,
      metadata: {
        sessionId,
        pending: true,
        monitor: { completion: Promise.resolve({ status: 0, stdout: "", stderr: "", metadata: { terminalError: "Malformed Pi tool call todo" } }) },
      },
    }) });
    const result = await deployWithPi({ team: "builder", mode: "implement", background: true }, adapter);
    assert.equal(result.status, "pending");
    await nextTick();
    const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.event, "completed");
    assert.equal(terminal[0]?.status, "failed");
    assert.equal(terminal[0]?.exit_code, 1);
    assert.match(terminal[0]?.summary ?? "", /^ppa deploy failed: Malformed Pi tool call todo$/);
    assert.notEqual(terminal[0]?.fallback, true);
  });
});

test("Pi successful results still require both authoritative session IDs", async () => {
  for (const resultFor of [
    () => ({ exitCode: 0, metadata: { sessionId: "authoritative-session-id" } }),
    () => ({ exitCode: 0, sessionId: "authoritative-session-id", metadata: {} }),
    () => ({ exitCode: 0, sessionId: "wrong-session-id", metadata: { sessionId: "authoritative-session-id" } }),
  ]) {
    await withPiEnv(async () => {
      const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({ result: resultFor }));
      assert.equal(result.status, "failed");
      assert.match(result.reason ?? "", /Pi adapter returned a session id different/);
      assert.ok(result.deploymentId);
      assert.equal(readFileSync(join(getDeployPaths(result.deploymentId!).deployDir, "session-id-pi.txt"), "utf8").trim(), "authoritative-session-id");
      assert.deepEqual(getDeploymentEvents(result.deploymentId!).map((event) => event.event), ["started", "crashed"]);
    });
  }
});

test("Pi Agent API session commands normalize OpenAI identifiers", () => {
  const command = piSessionCommand({ model: "openai/gpt-5.6-luna", prompt: "work", sessionId: "session", env: { PA_PROVIDER: "openai" }, session: { id: "unused", model: "", status: "running", startedAt: "", deploymentId: "", runtime: "pi" } });
  assert.deepEqual(command.args, ["--print", "--mode", "json", "--session-id", "session", "--model", "gpt-5.6-luna", "--provider", "openai-codex", "work"]);
});

test("managed Pi deployment keeps provider, model, and ticket identity aligned", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement", provider: "openai", model: "openai/gpt-5.6-luna", ticket: "PAP-151", objective: "Verify {{TICKET_ID}}" }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.equal(captured?.model, "gpt-5.6-luna");
    assert.equal(captured?.env?.["PA_PROVIDER"], "openai-codex");
    assert.equal(captured?.env?.["PA_MODEL"], "gpt-5.6-luna");
    assert.equal(captured?.env?.["PA_TICKET_ID"], "PAP-151");
    assert.equal(captured?.executionPlan?.ticket, "PAP-151");
    const primer = readFileSync(captured!.primerPath, "utf8");
    assert.match(primer, /PA_PROVIDER: openai-codex/);
    assert.match(primer, /PA_MODEL: gpt-5.6-luna/);
    assert.match(primer, /> \*\*Ticket:\*\* PAP-151/);
    assert.match(primer, /ticket_id: PAP-151/);
    assert.match(primer, /Verify PAP-151/);
    assert.match(primer, /objective: Verify \{\{TICKET_ID\}\}/);
    const resolution = readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath)[0];
    assert.deepEqual(resolution?.metadata, { provider: "openai-codex", model: "gpt-5.6-luna", resolution: "cli" });
    const started = getDeploymentEvents(result.deploymentId!)[0];
    assert.equal(started?.provider, "openai-codex");
    assert.equal(started?.models?.team, "gpt-5.6-luna");
    assert.equal(started?.ticket_id, "PAP-151");
  });
});

test("active builder and requirements modes keep one normalized pair across Pi evidence", async () => {
  await withPiEnv(async (root) => {
    writeFileSync(join(root, "teams", "builder.yaml"), [
      "name: builder", "description: Builder", "objective: Build", "agents: []", "deploy_modes:",
      "  - id: implement", "    label: Implement", "    provider: openai", "    model: openai/gpt-5.6-sol",
      "  - id: orchestrator", "    label: Orchestrator", "    provider: openai", "    model: openai/gpt-5.6-sol",
    ].join("\n") + "\n");
    writeFileSync(join(root, "teams", "requirements.yaml"), [
      "name: requirements", "description: Requirements", "objective: Review", "agents: []", "deploy_modes:",
      "  - id: review-auto", "    label: Review Auto", "    provider: openai", "    model: openai/gpt-5.6-sol",
    ].join("\n") + "\n");
    const invocations: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const adapter = new PiAdapter({
      versionProbe: () => "0.84.4",
      nativeRegistryProbe: () => undefined,
      runCommand: (args, opts) => {
        invocations.push({ args, env: opts.env });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    for (const [team, mode] of [["builder", "implement"], ["builder", "orchestrator"], ["requirements", "review-auto"]] as const) {
      const result = await deployWithPi({ team, mode }, adapter);
      assert.equal(result.status, "success", result.reason);
      const invocation = invocations.at(-1)!;
      const modelIndex = invocation.args.indexOf("--model");
      const providerIndex = invocation.args.indexOf("--provider");
      assert.equal(invocation.args[modelIndex + 1], "gpt-5.6-sol");
      assert.equal(invocation.args[providerIndex + 1], "openai-codex");
      assert.equal(invocation.env["PA_PROVIDER"], "openai-codex");
      assert.equal(invocation.env["PA_MODEL"], "gpt-5.6-sol");
      const paths = getDeployPaths(result.deploymentId!);
      const primer = readFileSync(join(paths.deployDir, "primer.md"), "utf8");
      assert.match(primer, /PA_PROVIDER: openai-codex/);
      assert.match(primer, /PA_MODEL: gpt-5.6-sol/);
      const resolution = readActivityEvents(paths.activityLogPath)[0];
      assert.deepEqual(resolution?.metadata, { provider: "openai-codex", model: "gpt-5.6-sol", resolution: "mode" });
      const started = getDeploymentEvents(result.deploymentId!)[0];
      assert.equal(started?.provider, "openai-codex");
      assert.equal(started?.models?.team, "gpt-5.6-sol");
    }
  });
});

test("PPA defaults to Sol and uses one normalized pair for spawn, env, primer, and registry", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.equal(captured?.model, "gpt-5.6-sol");
    assert.equal(captured?.env?.["PA_PROVIDER"], "openai-codex");
    assert.equal(captured?.env?.["PA_MODEL"], "gpt-5.6-sol");
    assert.match(readFileSync(captured!.primerPath, "utf8"), /PA_PROVIDER: openai-codex/);
    assert.match(readFileSync(captured!.primerPath, "utf8"), /PA_MODEL: gpt-5.6-sol/);
    const resolution = readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath)[0];
    assert.equal(resolution?.body, "Resolved Pi runtime openai-codex/gpt-5.6-sol");
    assert.deepEqual(resolution?.metadata, { provider: "openai-codex", model: "gpt-5.6-sol", resolution: "default" });
    const started = getDeploymentEvents(result.deploymentId!)[0];
    assert.equal(started?.provider, "openai-codex");
    assert.equal(started?.models?.team, "gpt-5.6-sol");
  });
});

test("PPA rejects unsupported and provider-qualified mismatched pairs", () => {
  assert.throws(
    () => resolvePiRuntimeConfig(Object.freeze({ provider: "anthropic", model: "claude-sonnet-4-6", source: "mode" })),
    /provider field is unsupported.*anthropic\/claude-sonnet-4-6/,
  );
  assert.throws(
    () => resolvePiRuntimeConfig(Object.freeze({ provider: "openai", model: "anthropic/claude-sonnet-4-6", source: "mode" })),
    /provider and model fields do not match.*openai\/anthropic\/claude-sonnet-4-6/,
  );
});

test("PPA rejects partial and mismatched CLI pairs before Pi preflight or spawn", async () => {
  await withPiEnv(async () => {
    for (const item of [
      { request: { provider: "openai" }, reason: /--model is required when --provider is supplied/ },
      { request: { model: "openai\/gpt-5.6-luna" }, reason: /--provider is required when --model is supplied/ },
      { request: { provider: "openai", model: "deepseek\/deepseek-v4-pro" }, reason: /provider and model fields do not match/ },
    ]) {
      let preflights = 0;
      let spawns = 0;
      const adapter = stubAdapter({ preflight: async () => { preflights++; }, onSpawn: () => { spawns++; } });
      const result = await deployWithPi({ team: "builder", mode: "implement", ...item.request }, adapter);
      assert.equal(result.status, "failed");
      assert.match(result.reason ?? "", item.reason);
      assert.equal(preflights, 0);
      assert.equal(spawns, 0);
      assert.deepEqual(getDeploymentEvents(result.deploymentId!).map((event) => event.event), ["completed"]);
      const marker = readPiTerminalStatus(getDeployPaths(result.deploymentId!).deployDir);
      assert.equal(marker?.stopReason, "error");
      assert.match(marker?.error ?? "", item.reason);
    }
  });
});
