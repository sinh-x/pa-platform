import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentApiApp, runCoreCommand } from "@pa-platform/pa-core";
import { meetsMinimum, normalizePiEvent, PiAdapter } from "../adapter.js";
import { composePpaExecutionHooks } from "../deploy.js";

class FakePiChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 42;
}

function controlledAdapter(child: FakePiChild, options: { persistLine?: () => void; onSignal?: (signal: NodeJS.Signals) => void; onTimeout?: (callback: () => void) => void; processGroupGone?: () => boolean } = {}): PiAdapter {
  return new PiAdapter({
    cwd: tmpdir(),
    versionProbe: () => "0.80.8",
    supervision: {
      spawnProcess: (() => child as never) as typeof spawn,
      persistLine: () => options.persistLine?.(),
      sendSignal: (_pid, signal) => options.onSignal?.(signal),
      processGroupGone: options.processGroupGone ?? (() => false),
      setTimeout: (callback) => { options.onTimeout?.(callback); return {} as NodeJS.Timeout; },
      clearTimeout: () => {},
    },
  });
}

function nextTick(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

test("checks the Pi version and uses the 0.80.8 JSON argument contract per deployment", async () => {
  assert.equal(meetsMinimum("0.80.7"), false); assert.equal(meetsMinimum("0.80.8"), true); assert.equal(meetsMinimum("0.81.0"), true); assert.equal(meetsMinimum("not-a-version"), false);
  const dir = mkdtempSync(join(tmpdir(), "pi-pa-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work"); let probes = 0;
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => { probes++; return "0.80.8"; }, sessionIdFactory: () => "00000000-0000-0000-0000-000000000001", runCommand: (args) => { assert.deepEqual(args.slice(0, 5), ["--print", "--mode", "json", "--session-id", "00000000-0000-0000-0000-000000000001"]); assert.ok(!args.includes("--json")); return { status: 0, stdout: '{"type":"message","text":"ok"}\n', stderr: "" }; } });
  await adapter.spawn({ primerPath: primer, deployId: "d-aaaaaa", mode: "foreground" }); await adapter.spawn({ primerPath: primer, deployId: "d-bbbbbb", mode: "foreground" }); assert.equal(probes, 2);
});

test("ppa deploy selects Pi while omitted-runtime Agent API deploys remain on OpenCode", async () => {
  let opencodeCalls = 0;
  let piCalls = 0;
  const hooks = composePpaExecutionHooks(
    { deploy: () => { opencodeCalls++; return { status: "pending", deploymentId: "d-open01" }; } },
    { deploy: () => { piCalls++; return { status: "pending", deploymentId: "d-pi0001" }; } },
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

test("waits for normal direct-child close before settling", async () => {
  const child = new FakePiChild();
  const primer = join(mkdtempSync(join(tmpdir(), "pi-close-")), "primer.md"); writeFileSync(primer, "work");
  const signals: NodeJS.Signals[] = [];
  const adapter = controlledAdapter(child, { onSignal: (signal) => signals.push(signal) });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-close", mode: "foreground" });
  await nextTick();
  child.stdout.emit("data", Buffer.from('{"type":"message","text":"ok"}\n'));
  child.emit("close", 0);
  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(signals, []);
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
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-timeout", mode: "foreground", timeoutMs: 1 });
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
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-deadline", mode: "foreground", timeoutMs: 1 });
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
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-competing", mode: "foreground", timeoutMs: 1 });
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
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-persist", mode: "foreground" });
  await nextTick();
  child.stdout.emit("data", Buffer.from('{"type":"message","text":"fails"}\n'));
  const result = await resultPromise;
  assert.equal(result.exitCode, 1);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

  const backgroundChild = new FakePiChild();
  const background = controlledAdapter(backgroundChild);
  const started = await background.spawn({ primerPath: primer, deployId: "d-background", mode: "background" });
  const monitor = started.metadata?.monitor as { completion: Promise<{ status: number | null }> };
  backgroundChild.emit("close", 0);
  assert.equal((await monitor.completion).status, 0);
  assert.equal(groupGone, true);
});
