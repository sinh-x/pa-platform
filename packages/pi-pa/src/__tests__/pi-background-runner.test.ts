import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRegistryEvent, closeDb, getDeploymentEvents, queryDeploymentStatus, readActivityEvents } from "@pa-platform/pa-core";
import { PiAdapter, PI_BACKGROUND_CONFIG_FILE, PI_SUPERVISOR_FILE, readPiSupervisorOwnership, type PiBackgroundConfig } from "../adapter.js";
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
    versionProbe: () => "0.80.8",
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

    const readFailure = new PiAdapter({ cwd: root, versionProbe: () => "0.80.8", supervision: {
      launchBackgroundRunner: (() => new LauncherProcess() as never),
      readBackgroundOwnership: () => { throw new Error("ownership fixture unreadable"); },
    } });
    const unreadable = await readFailure.spawn({ primerPath: primer, deployId: "d-read-error", mode: "background", sessionId: "read-error-session" });
    assert.equal(unreadable.exitCode, 1);
    assert.match(unreadable.errorMessage ?? "", /^runner-readiness: ownership fixture unreadable$/);
    assert.equal(existsSync(join(root, PI_BACKGROUND_CONFIG_FILE)), false);

    const launcherFailure = new PiAdapter({ cwd: root, versionProbe: () => "0.80.8", secretValues: [secret], supervision: {
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
  const adapter = new PiAdapter({ cwd: root, versionProbe: () => "0.80.8", supervision: {
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
  writeFileSync(fakePi, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.80.8; exit 0; fi\nsleep 0.5\nprintf '%s\\n' '{\"type\":\"agent_end\",\"stopReason\":\"stop\",\"timestamp\":\"2026-08-29T00:00:01.000Z\"}'\n");
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
    `const adapter = new PiAdapter({ cwd: ${JSON.stringify(deployDir)}, supervision: { launchBackgroundRunner: (_ignored, configPath, options) => spawn(process.execPath, ["--import", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(runnerWrapper)}, configPath], { ...options, detached: true, stdio: ["ignore", "ignore", "inherit"] }) } });`,
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
