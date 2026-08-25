import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeRuntimeHooks, createAgentApiApp, runCoreCommand } from "@pa-platform/pa-core";
import { meetsMinimum, normalizePiEvent, PiAdapter } from "../adapter.js";

class FakePiChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 42;
}

class FakePiPty extends EventEmitter {
  readonly pid = 43;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly signals: string[] = [];
  private onDataHandler?: (data: string) => void;
  private onExitHandler?: (event: { exitCode: number; signal: number }) => void;
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(signal?: string): void { this.signals.push(signal ?? ""); }
  onData(handler: (data: string) => void): void { this.onDataHandler = handler; }
  onExit(handler: (event: { exitCode: number; signal: number }) => void): void { this.onExitHandler = handler; }
  emitData(data: string): void { this.onDataHandler?.(data); }
  emitExit(exitCode: number): void { this.onExitHandler?.({ exitCode, signal: 0 }); }
}

class FakePiInput extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
}

class FakePiOutput { readonly chunks: string[] = []; write(chunk: string): boolean { this.chunks.push(chunk); return true; } }

function controlledAdapter(child: FakePiChild, options: { persistLine?: () => void; onSignal?: (signal: NodeJS.Signals) => void; onTimeout?: (callback: () => void) => void; processGroupGone?: () => boolean; onSpawn?: (args: string[], stdio: unknown) => void } = {}): PiAdapter {
  return new PiAdapter({
    cwd: tmpdir(),
    versionProbe: () => "0.80.8",
    supervision: {
      spawnProcess: ((...spawnArgs: unknown[]) => {
        const args = spawnArgs[1] as string[];
        const spawnOptions = spawnArgs[2] as { stdio?: unknown };
        options.onSpawn?.(args, spawnOptions.stdio);
        return child as never;
      }) as typeof spawn,
      persistLine: () => options.persistLine?.(),
      sendSignal: (_pid, signal) => options.onSignal?.(signal),
      processGroupGone: options.processGroupGone ?? (() => false),
      setTimeout: (callback) => { options.onTimeout?.(callback); return {} as NodeJS.Timeout; },
      clearTimeout: () => {},
    },
  });
}

function nextTick(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

test("uses interactive Pi arguments for foreground and JSON arguments for background", async () => {
  assert.equal(meetsMinimum("0.80.7"), false); assert.equal(meetsMinimum("0.80.8"), true); assert.equal(meetsMinimum("0.81.0"), true); assert.equal(meetsMinimum("not-a-version"), false);
  const dir = mkdtempSync(join(tmpdir(), "pi-pa-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work"); let probes = 0; const invocations: string[][] = [];
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => { probes++; return "0.80.8"; }, sessionIdFactory: () => "00000000-0000-0000-0000-000000000001", runCommand: (args) => { invocations.push(args); return { status: 0, stdout: '{"type":"message","text":"ok"}\n', stderr: "" }; } });
  await adapter.spawn({ primerPath: primer, deployId: "d-aaaaaa", mode: "foreground" });
  await adapter.spawn({ primerPath: primer, deployId: "d-bbbbbb", mode: "background" });
  assert.equal(probes, 2);
  assert.deepEqual(invocations[0]?.slice(0, 2), ["--session-id", "00000000-0000-0000-0000-000000000001"]);
  assert.ok(!invocations[0]?.includes("--print"));
  assert.ok(!invocations[0]?.includes("--mode"));
  assert.deepEqual(invocations[1]?.slice(0, 5), ["--print", "--mode", "json", "--session-id", "00000000-0000-0000-0000-000000000001"]);
  assert.ok(!invocations[1]?.includes("--json"));
});

test("managed Pi invocations normalize OpenAI provider and model arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-normalize-"));
  const primer = join(dir, "primer.md");
  writeFileSync(primer, "work");
  let invocation: string[] = [];
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", runCommand: (args) => { invocation = args; return { status: 0, stdout: "", stderr: "" }; } });
  await adapter.spawn({ primerPath: primer, deployId: "d-normalize", mode: "background", model: "openai/gpt-5.6-luna", env: { PA_PROVIDER: "openai" } });
  assert.deepEqual(invocation.slice(0, 9), ["--print", "--mode", "json", "--session-id", invocation[4], "--model", "gpt-5.6-luna", "--provider", "openai-codex"]);
});

test("reuses a successful configurable version preflight and preserves timeout failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-preflight-"));
  const primer = join(dir, "primer.md");
  writeFileSync(primer, "work");
  let probes = 0;
  const slowAdapter = new PiAdapter({
    cwd: dir,
    versionTimeoutMs: 30,
    versionProbe: () => new Promise((resolve) => { probes++; setTimeout(() => resolve("0.80.8"), 10); }),
    runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  await slowAdapter.preflight();
  const result = await slowAdapter.spawn({ primerPath: primer, deployId: "d-slow", mode: "foreground" });
  assert.equal(result.exitCode, 0);
  assert.equal(probes, 1);

  let spawned = false;
  const timedOutAdapter = new PiAdapter({
    cwd: dir,
    versionTimeoutMs: 1,
    versionProbe: () => new Promise((resolve) => setTimeout(() => resolve("0.80.8"), 20)),
    runCommand: () => { spawned = true; return { status: 0, stdout: "", stderr: "" }; },
  });
  const timedOut = await timedOutAdapter.spawn({ primerPath: primer, deployId: "d-timeout-probe", mode: "foreground" });
  assert.equal(timedOut.exitCode, 1);
  assert.match(timedOut.errorMessage ?? "", /Pi version probe timed out after 1ms/);
  assert.equal(spawned, false);
});

test("managed Pi invocations disable discovery and load only plan resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-managed-"));
  const primer = join(dir, "primer.md");
  writeFileSync(primer, "work");
  const invocations: string[][] = [];
  const adapter = new PiAdapter({
    cwd: tmpdir(),
    versionProbe: () => "0.80.8",
    runCommand: (args, options) => {
      invocations.push(args);
      assert.equal(options.cwd, dir);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  await adapter.spawn({
    primerPath: primer,
    deployId: "d-managed",
    mode: "background",
    executionPlan: {
      runtime: "pi",
      team: "builder",
      mode: "implement",
      repositoryCwd: dir,
      ticketRequired: false,
      objective: "work",
      skills: [{ name: "pa-cli", injectAs: "reference", path: join(dir, "pa-cli", "SKILL.md") }],
      memoryDocuments: [],
      environment: {},
      timeoutSeconds: 60,
      lifecycle: { deploymentId: "d-managed", deploymentDir: dir, activityLogPath: join(dir, "activity.jsonl"), registryDbPath: join(dir, "registry.db"), terminalMarker: join(dir, "terminal.json") },
    },
  });
  assert.deepEqual(invocations[0]?.slice(0, 9), ["--print", "--mode", "json", "--session-id", invocations[0]?.[4], "--no-skills", "--no-extensions", "--skill", join(dir, "pa-cli", "SKILL.md")]);
});

test("ppa deploy selects Pi while omitted-runtime Agent API deploys remain on OpenCode", async () => {
  let opencodeCalls = 0;
  let piCalls = 0;
  const hooks = composeRuntimeHooks(
    { deploy: () => { opencodeCalls++; return { status: "pending", deploymentId: "d-open01" }; } },
    { deploy: () => { piCalls++; return { status: "pending", deploymentId: "d-pi0001" }; } }, "pi",
  );

  const cliCode = await runCoreCommand(["deploy", "builder"], { hooks, io: { stdout: () => {}, stderr: () => {} }, binaryName: "ppa" });
  assert.equal(cliCode, 0);
  assert.equal(piCalls, 1);
  assert.equal(opencodeCalls, 0);

  const api = createAgentApiApp({ hooks });
  const omitted = await api.app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder" }) });
  const explicitPi = await api.app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder", runtime: "pi" }) });
  assert.equal(omitted.status, 202);
  assert.equal(explicitPi.status, 202);
  assert.equal(opencodeCalls, 1);
  assert.equal(piCalls, 2);
  api.cleanup();
});

test("normalizes additive, malformed, redacted, and bounded Pi events", () => {
  const event = normalizePiEvent({ type: "tool_result", content: "token=secret-value", extra: true }, "d-aaaaaa"); assert.equal(event.kind, "tool_result"); assert.ok(event.body.length <= 500); assert.ok(!event.body.includes("secret-value"));
});

test("requires an exact supported Pi version and redacts nested array content", () => {
  assert.equal(meetsMinimum("pi 0.80.8"), true);
  assert.equal(meetsMinimum("0.80.8foo"), false);
  assert.equal(meetsMinimum("0.80.8-dev"), false);
  const event = normalizePiEvent({ type: "message", content: [{ text: "hello" }, { authorization: "configured-secret", nested: [{ password: "pw" }] }] }, "d-aaaaaa", ["configured-secret"]);
  assert.match(event.body, /hello/);
  assert.doesNotMatch(event.body, /configured-secret|pw/);
});

test("foreground Pi relays terminal input, output, resize, interrupt, and exit status", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const primer = join(mkdtempSync(join(tmpdir(), "pi-close-")), "primer.md"); writeFileSync(primer, "work");
  let spawnedArgs: string[] = []; let spawnedOptions: { cols: number; rows: number } | undefined;
  const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.80.8", supervision: { spawnPty: (file, args, options) => { spawnedArgs = args; spawnedOptions = options; return pty as never; }, input: input as never, output: output as never, columns: 100, rows: 40 } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-close", mode: "foreground", sessionId: "interactive-session" });
  await nextTick();
  input.emit("data", Buffer.from("hello")); pty.emitData("visible\n"); process.stdout.emit("resize"); process.emit("SIGINT"); pty.emitExit(0);
  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "interactive-session");
  assert.deepEqual({ cols: spawnedOptions?.cols, rows: spawnedOptions?.rows }, { cols: 100, rows: 40 });
  assert.deepEqual(pty.resizes, [[process.stdout.columns ?? 80, process.stdout.rows ?? 24]]);
  assert.deepEqual(spawnedArgs.slice(0, 2), ["--session-id", "interactive-session"]);
  assert.ok(!spawnedArgs.includes("--print"));
  assert.ok(!spawnedArgs.includes("--mode"));
  assert.deepEqual(pty.writes, ["hello"]);
  assert.deepEqual(pty.signals, ["SIGINT"]);
  assert.deepEqual(output.chunks, ["visible\n"]);
});

test("terminal Pi error fails on exit 0 and redacts persisted diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-semantic-")); const primer = join(dir, "primer.md"); const logFile = join(dir, "pi.log"); writeFileSync(primer, "work");
  const secret = "sentinel-secret-value"; const event = JSON.stringify({ type: "agent_end", stopReason: "error", error: `authentication ${secret}` });
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", secretValues: [secret], runCommand: () => ({ status: 0, stdout: `${event}\n`, stderr: "" }) });
  const result = await adapter.spawn({ primerPath: primer, deployId: "d-semantic", mode: "background", logFile });
  assert.equal(result.exitCode, 1); assert.match(result.errorMessage ?? "", /authentication/); assert.doesNotMatch(result.errorMessage ?? "", /sentinel-secret-value/); assert.doesNotMatch(readFileSync(logFile, "utf8"), /sentinel-secret-value/);
  const successful = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", runCommand: () => ({ status: 0, stdout: `${JSON.stringify({ type: "agent_end", stopReason: "stop", message: "completed" })}\n`, stderr: "" }) });
  assert.equal((await successful.spawn({ primerPath: primer, deployId: "d-semantic-success", mode: "background" })).exitCode, 0);
});

test("escalates resistant timeout cleanup and settles once after the process group disappears", async () => {
  const child = new FakePiChild();
  let now = 0;
  let groupGone = false;
  const signals: NodeJS.Signals[] = [];
  let timeoutCallback: (() => void) | undefined;
  const primer = join(mkdtempSync(join(tmpdir(), "pi-timeout-")), "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({
    cwd: tmpdir(), versionProbe: () => "0.80.8",
    supervision: {
      spawnProcess: (() => child as never) as typeof spawn,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      processGroupGone: () => groupGone,
      sendSignal: (_pid, signal) => { signals.push(signal); if (signal === "SIGKILL") { groupGone = true; child.emit("close", 137); } },
      setTimeout: (callback) => { timeoutCallback = callback; return {} as NodeJS.Timeout; },
      clearTimeout: () => {},
    },
  });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-timeout", mode: "dry-run", timeoutMs: 1 });
  await nextTick();
  timeoutCallback?.();
  const result = await resultPromise;
  assert.equal(result.exitCode, 124);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.metadata?.cleanupVerified, true);
});

test("settles at the cleanup deadline when the child and process group never disappear", async () => {
  const child = new FakePiChild();
  let now = 0;
  let timeoutCallback: (() => void) | undefined;
  const signals: NodeJS.Signals[] = [];
  const primer = join(mkdtempSync(join(tmpdir(), "pi-deadline-")), "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({
    cwd: tmpdir(), versionProbe: () => "0.80.8",
    supervision: {
      spawnProcess: (() => child as never) as typeof spawn,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      processGroupGone: () => false,
      sendSignal: (_pid, signal) => { signals.push(signal); },
      setTimeout: (callback) => { timeoutCallback = callback; return {} as NodeJS.Timeout; },
      clearTimeout: () => {},
    },
  });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-deadline", mode: "dry-run", timeoutMs: 1 });
  await nextTick();
  timeoutCallback?.();
  const result = await resultPromise;
  assert.equal(now, 4900);
  assert.equal(result.exitCode, 124);
  assert.equal(result.metadata?.cleanupVerified, false);
  assert.equal(result.errorMessage, "Pi deployment timed out; process tree cleanup deadline exceeded");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("settles exactly once when persistence failure, timeout, and late close compete", async () => {
  const child = new FakePiChild();
  let now = 0;
  let groupGone = false;
  let timeoutCallback: (() => void) | undefined;
  let outcomes = 0;
  const signals: NodeJS.Signals[] = [];
  const primer = join(mkdtempSync(join(tmpdir(), "pi-competing-")), "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({
    cwd: tmpdir(), versionProbe: () => "0.80.8",
    supervision: {
      spawnProcess: (() => child as never) as typeof spawn,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      persistLine: () => { throw new Error("persistence failed"); },
      processGroupGone: () => groupGone,
      sendSignal: (_pid, signal) => { signals.push(signal); if (signal === "SIGKILL") groupGone = true; },
      setTimeout: (callback) => { timeoutCallback = callback; return {} as NodeJS.Timeout; },
      clearTimeout: () => {},
    },
  });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-competing", mode: "dry-run", timeoutMs: 1 });
  resultPromise.then(() => { outcomes++; });
  await nextTick();
  child.stdout.emit("data", Buffer.from('{"type":"message","text":"fails"}\n'));
  timeoutCallback?.();
  child.emit("close", 137);
  child.emit("close", 137);
  const result = await resultPromise;
  await nextTick();
  assert.equal(outcomes, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "persistence failed");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("cleans up after persistence failure and completes background supervision", async () => {
  const child = new FakePiChild();
  let groupGone = false;
  const primer = join(mkdtempSync(join(tmpdir(), "pi-persist-")), "primer.md"); writeFileSync(primer, "work");
  const signals: NodeJS.Signals[] = [];
  const adapter = controlledAdapter(child, {
    persistLine: () => { throw new Error("persistence failed"); },
    onSignal: (signal) => { signals.push(signal); if (signal === "SIGKILL") { groupGone = true; child.emit("close", 137); } },
    processGroupGone: () => groupGone,
  });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-persist", mode: "dry-run" });
  await nextTick();
  child.stdout.emit("data", Buffer.from('{"type":"message","text":"fails"}\n'));
  const result = await resultPromise;
  assert.equal(result.exitCode, 1);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

  const backgroundChild = new FakePiChild();
  let backgroundArgs: string[] = []; let backgroundStdio: unknown;
  const background = controlledAdapter(backgroundChild, { onSpawn: (args, stdio) => { backgroundArgs = args; backgroundStdio = stdio; } });
  const started = await background.spawn({ primerPath: primer, deployId: "d-background", mode: "background" });
  const monitor = started.metadata?.monitor as { completion: Promise<{ status: number | null }> };
  backgroundChild.emit("close", 0);
  assert.equal((await monitor.completion).status, 0);
  assert.deepEqual(backgroundStdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(backgroundArgs.slice(0, 5), ["--print", "--mode", "json", "--session-id", started.sessionId]);
  assert.equal(groupGone, true);
});
