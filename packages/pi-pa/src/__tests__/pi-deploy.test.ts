import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appendRegistryEvent, closeDb, getDeployPaths, getDeploymentEvents, queryDeploymentStatus, queryDeploymentStatuses, readActivityEvents, runCoreCommand, type RuntimeAdapter, type SpawnOpts, type SpawnResult } from "@pa-platform/pa-core";
import { PiAdapter, PI_SUPERVISOR_FILE, readPiBackgroundConfig, writePiSupervisorOwnership, type PiBackgroundConfig } from "../adapter.js";
import { runPiBackgroundRunner } from "../background-runner.js";
import { deployWithPi, piSessionCommand } from "../deploy.js";
import { resolvePiRuntimeConfig } from "../runtime-normalization.js";
import { PI_FOREGROUND_COMPLETION_FILE, readPiForegroundCompletion, readPiTerminalStatus, writePiForegroundCompletion, writePiTerminalStatus } from "../terminal-status.js";

function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }

function withPiEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ppa-deploy-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\n`);
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
  ].join("\n") + "\n");
  const previous = Object.fromEntries(["PA_PLATFORM_CONFIG", "PA_PLATFORM_TEAMS", "PA_REGISTRY_DB", "PA_AI_USAGE_HOME", "PA_MAX_RUNTIME"].map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  delete process.env["PA_MAX_RUNTIME"];
  return fn(root).finally(() => {
    closeDb();
    for (const [key, value] of Object.entries(previous)) restore(key, value);
    rmSync(root, { recursive: true, force: true });
  });
}

function stubAdapter(options: { preflight?: () => Promise<void>; result?: (sessionId: string) => SpawnResult | Promise<SpawnResult>; onSpawn?: (opts: SpawnOpts) => void; onResume?: (opts: SpawnOpts) => void }): RuntimeAdapter & { preflight(): Promise<void>; allocateSessionId(): string } {
  const result = (sessionId: string) => options.result?.(sessionId) ?? { sessionId, exitCode: 0, metadata: { sessionId } };
  return {
    name: "pi",
    defaultModel: "",
    sessionFileName: "session-id-pi.txt",
    preflight: options.preflight ?? (async () => {}),
    allocateSessionId: () => "authoritative-session-id",
    installHooks() {},
    spawn(opts) { options.onSpawn?.(opts); return result(opts.sessionId ?? ""); },
    resume(opts) { options.onResume?.(opts); return result(opts.sessionId); },
    extractActivity() { return []; },
    describeTools() { return { runtime: "pi", markdown: "stub" }; },
  };
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

function within<T>(promise: Promise<T>, milliseconds: number, message: string | (() => string)): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(typeof message === "string" ? message : message())), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

test("foreground PPA /quit forwards to the live PTY and emits one terminal event after PTY exit", async () => {
  await withPiEnv(async (root) => {
    let running = true;
    const input = new ForegroundDeploymentInput();
    const output = { write() { return true; } };
    let pty: ForegroundDeploymentPty;
    pty = new ForegroundDeploymentPty(() => {
      running = false;
      queueMicrotask(() => pty.emitExit(0));
    });
    const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.80.8", supervision: {
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
  });
});

test("foreground open-stdin subprocess exits naturally within 1000ms after child-exit evidence", { timeout: 15_000 }, async (context) => {
  interface FixtureEvent {
    type: "child-exit-evidence" | "adapter-settled";
    readableFlowing: boolean | null;
    dataListeners: number;
    readableFlowingBefore?: boolean | null;
    exitCode?: number;
  }
  const fixture = fileURLToPath(new URL("fixtures/foreground-open-stdin-child.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture], {
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
    const event = JSON.parse(line) as FixtureEvent;
    events.push(event);
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
    assert.equal(evidence.readableFlowingBefore, null);
    assert.equal(evidence.readableFlowing, true);
    assert.equal(evidence.dataListeners, 1);
    assert.equal(writerOpenAtEvidence, true, "parent closed the subprocess stdin writer before exit measurement");

    const exited = await within(exitPromise, 1_000, () => `subprocess remained alive with open stdin; stdout=${stdout}; stderr=${stderr}`);
    await within(closePromise, 1_000, `subprocess stdio did not close; stdout=${stdout}; stderr=${stderr}`);
    if (carry) { observeLine(carry); carry = ""; }
    assert.equal(exited.code, 0, stderr);
    assert.equal(exited.signal, null);
    const exitElapsedMs = exited.at - evidenceAt;
    assert.ok(exitElapsedMs < 1_000, `subprocess exit took ${exitElapsedMs}ms after child-exit evidence`);
    const settlements = events.filter((event) => event.type === "adapter-settled");
    assert.equal(settlements.length, 1, stdout);
    assert.equal(settlements[0]?.exitCode, 0);
    assert.equal(settlements[0]?.readableFlowing, false);
    assert.equal(settlements[0]?.dataListeners, 0);
    assert.equal(child.stdin?.writableEnded, false, "test must not end the child stdin writer to induce exit");
    context.diagnostic(`open-stdin lifecycle: before=${String(evidence.readableFlowingBefore)}, attached=${String(evidence.readableFlowing)}/${evidence.dataListeners} listener, settled=${String(settlements[0]?.readableFlowing)}/${settlements[0]?.dataListeners} listeners, writerOpen=${writerOpenAtEvidence}, naturalExitMs=${exitElapsedMs.toFixed(1)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await within(closePromise, 1_000, "failed to clean up timed-out stdin fixture").catch(() => {});
    }
    child.stdin?.destroy();
  }
});

test("live foreground PTY PID protects status, wait, health, and sweep before settlement", async () => {
  await withPiEnv(async () => {
    let running = true;
    const input = new ForegroundDeploymentInput();
    const output = { write() { return true; } };
    const pty = new ForegroundDeploymentPty(() => {}, process.pid);
    const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.80.8", supervision: {
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
  await withPiEnv(async () => {
    let deployId = "";
    const adapter = stubAdapter({
      onSpawn: (opts) => { deployId = opts.deployId; },
      result: (sessionId) => ({ sessionId, exitCode: 0, metadata: { sessionId, pending: true, supervisorPid: process.pid, pid: process.pid } }),
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

test("ordinary background deploy flows timeout through runner escalation to one causal terminal failure", async () => {
  await withPiEnv(async () => {
    const launcher = new BackgroundDeploymentProcess(88_001);
    let config: PiBackgroundConfig | undefined;
    const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.80.8", nativeRegistryProbe: () => undefined, supervision: {
      launchBackgroundRunner: ((_runnerPath, configPath) => {
        config = readPiBackgroundConfig(configPath);
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

test("Pi adapter failure without session metadata keeps its original reason", async () => {
  await withPiEnv(async () => {
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
      const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.80.8", supervision: {
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
      versionProbe: () => "0.80.8",
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
