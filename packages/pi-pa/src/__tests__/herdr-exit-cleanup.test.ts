import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PiAdapter, runPiManagedProcess } from "../adapter.js";
import { createHerdrExitCleanup } from "../herdr-exit-cleanup.js";
import { selectedPiEnvironment } from "../selected-pi-launch.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const unavailable = (deathEvidence: string) => ({ status: "unavailable", reason: "incarnation-safe-retirement-unsupported", deathEvidence });

async function fixture(run: (root: string, env: NodeJS.ProcessEnv, connections: () => number) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-exit-")), socketPath = join(root, "herdr.sock");
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    await run(root, { PATH: process.env.PATH, HOME: process.env.HOME, PA_HERDR_LIFECYCLE: "1", HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p315" }, () => connections);
    await tick();
    assert.equal(connections, 0, "unsupported cleanup must not even open a socket");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

class Pty {
  readonly pid = 918_315;
  readonly signals: string[] = [];
  readonly writes: string[] = [];
  data?: (value: string) => void;
  exit?: (event: { exitCode: number; signal?: number }) => void;
  onData(handler: Pty["data"]): void { this.data = handler; }
  onExit(handler: Pty["exit"]): void { this.exit = handler; }
  write(value: string): void { this.writes.push(value); }
  resize(): void {}
  kill(signal: string): void { this.signals.push(signal); }
}
class Input extends Readable {
  readonly isTTY = true;
  isRaw = false;
  _read(): void {}
  setRawMode(raw: boolean): void { this.isRaw = raw; }
}

function foreground(root: string, env: NodeJS.ProcessEnv, options: { processExists?: () => boolean; fastClock?: boolean } = {}) {
  const pty = new Pty(), input = new Input(), output: string[] = [];
  const primerPath = join(root, "primer.txt"); writeFileSync(primerPath, "inert fixture");
  let now = 0;
  const adapter = new PiAdapter({ cwd: root, env, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined,
    supervision: {
      spawnPty: () => pty as never, input: input as never,
      output: { write: (value: string) => { output.push(value); return true; } } as never,
      persistLine: () => {}, processExists: options.processExists ?? (() => true),
      ...(options.fastClock ? { now: () => now, sleep: async (ms: number) => { now += ms; await tick(); } } : {}),
    },
  });
  const result = adapter.spawn({ primerPath, deployId: "d-herdr-exit", mode: "foreground", sessionId: "same-conversation" });
  return { pty, input, result, output };
}

test("launch selection is inert for absent, disabled, partial, invalid and aliased bindings", async () => fixture(async (root, env) => {
  const alias = join(root, "alias.sock"); symlinkSync(env.HERDR_SOCKET_PATH!, alias);
  for (const candidate of [
    {}, { ...env, PA_HERDR_LIFECYCLE: "0" }, { ...env, HERDR_ENV: "0" },
    { ...env, HERDR_PANE_ID: undefined }, { ...env, HERDR_PANE_ID: "../other" },
    { ...env, HERDR_SOCKET_PATH: alias }, { ...env, HERDR_SOCKET_PATH: join(root, "dead.sock") },
  ]) assert.equal(createHerdrExitCleanup(candidate), undefined);
  const environmentNames = JSON.parse(readFileSync(new URL("../../runtime/selected-pi-environment.json", import.meta.url), "utf8")) as string[];
  const selectedEnv = selectedPiEnvironment({ schemaVersion: 1, entryFile: "/inert/entry", nodeFile: "/inert/node", packageRoot: "/inert/pi", addonFile: "/inert/addon", environmentNames }, env);
  assert.equal(createHerdrExitCleanup(selectedEnv), undefined, "the actual finite selected-host environment does not forward Herdr bindings");
}));

test("launch-bound checkpoint is synchronous, memoized and never claims removal", async () => fixture(async (_root, env) => {
  const stage = createHerdrExitCleanup(env)!;
  env.HERDR_PANE_ID = "replacement"; env.HERDR_SOCKET_PATH = "/other.sock";
  const before = performance.now();
  const result = stage.afterVerifiedExit("pty-exit");
  assert.ok(performance.now() - before < 500, "unsupported path must not wait on transport");
  assert.deepEqual(result, unavailable("pty-exit"));
  assert.equal(stage.afterVerifiedExit("confirmed-process-gone"), result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal("socketPath" in result, false);
  assert.equal("paneId" in result, false);
}));

test("normal, crash and child signals preserve settlement and never submit unsupported teardown", async context => {
  for (const [exitCode, signal] of [[0, 0], [7, 0], [143, 15], [137, 9]] as const) {
    await context.test(`${exitCode}/${signal}`, () => fixture(async (root, env) => {
      const { pty, input, result, output } = foreground(root, env);
      let settlements = 0; void result.then(() => { settlements++; });
      await tick();
      assert.equal(input.isRaw, true);
      const before = performance.now();
      pty.exit?.({ exitCode, signal });
      pty.exit?.({ exitCode: 0 });
      const settled = await result;
      assert.ok(performance.now() - before < 500);
      assert.equal(settlements, 1);
      assert.equal(settled.exitCode, exitCode);
      assert.equal(settled.metadata?.normalExit, signal === 0);
      assert.deepEqual(settled.metadata?.herdrCleanup, unavailable("pty-exit"));
      assert.equal(settled.metadata?.rawExitCode, exitCode);
      assert.deepEqual(pty.signals, []);
      assert.deepEqual(output, [], "no new human-facing or machine-stream diagnostic");
      assert.equal(input.isRaw, false);
      assert.equal(input.listenerCount("data"), 0);
      input.destroy();
    }));
  }
});

test("turn markers, idle text and quit input cannot complete a still-live child", async () => fixture(async (root, env, connections) => {
  const { pty, input, result } = foreground(root, env);
  let settled = false; void result.then(() => { settled = true; });
  await tick();
  for (const state of ["idle", "working", "blocked"]) {
    pty.data?.(`${JSON.stringify({ type: "agent_end", state })}\n`);
    await tick();
    assert.equal(settled, false);
  }
  input.emit("data", "/quit\n");
  await tick();
  assert.equal(settled, false);
  assert.equal(connections(), 0);
  assert.deepEqual(pty.signals, []);
  pty.exit?.({ exitCode: 0 });
  assert.deepEqual((await result).metadata?.herdrCleanup, unavailable("pty-exit"));
  input.destroy();
}));

test("EOF cannot report child death before exit confirmation", async () => fixture(async (root, env) => {
  const { pty, input, result } = foreground(root, env);
  let settled = false; void result.then(() => { settled = true; });
  await tick(); input.emit("end"); await tick();
  assert.equal(settled, false);
  assert.deepEqual(pty.signals, ["SIGTERM"], "existing cancellation behavior is unchanged");
  pty.exit?.({ exitCode: 0 });
  const value = await result;
  assert.equal(value.exitCode, 0);
  assert.equal(value.metadata?.cleanupVerified, true);
  assert.deepEqual(value.metadata?.herdrCleanup, unavailable("pty-exit"));
  input.destroy();
}));

test("confirmed death with unknown exit status remains a failure with truthful cleanup metadata", async () => fixture(async (root, env) => {
  const { pty, input, result } = foreground(root, env, { processExists: () => false, fastClock: true });
  const value = await result;
  assert.equal(value.exitCode, 1);
  assert.match(value.errorMessage!, /^process-exit-status-unavailable:/);
  assert.equal(value.metadata?.rawExitCode, undefined);
  assert.deepEqual(value.metadata?.herdrCleanup, unavailable("confirmed-process-gone"));
  pty.exit?.({ exitCode: 0 });
  assert.deepEqual(pty.signals, []);
  input.destroy();
}));

test("cancellation confirmed-death fallback records one unavailable checkpoint without an exit callback", async () => fixture(async (root, env) => {
  let running = true;
  const { input, result } = foreground(root, env, { processExists: () => running, fastClock: true });
  await tick(); input.emit("end"); running = false;
  const value = await result;
  assert.equal(value.exitCode, 0);
  assert.equal(value.metadata?.cleanupVerified, true);
  assert.deepEqual(value.metadata?.herdrCleanup, unavailable("confirmed-process-gone"));
  input.destroy();
}));

test("unproven death stays inert even when existing cancellation reaches its deadline", async () => fixture(async (root, env) => {
  const { pty, input, result } = foreground(root, env, { fastClock: true });
  await tick(); input.emit("end");
  const value = await result;
  assert.equal(value.metadata?.cleanupVerified, false);
  assert.equal(value.metadata?.herdrCleanup, undefined);
  assert.deepEqual(pty.signals, ["SIGTERM", "SIGKILL"]);
  input.destroy();
}));

test("unavailable Herdr stage preserves natural open-stdin exit below 1000 ms", { timeout: 15_000 }, async context => fixture(async (_root, env) => {
  for (const shape of ["valid-json", "non-json", "different-json"]) {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("fixtures/foreground-open-stdin-child.ts", import.meta.url)), shape], { env, stdio: ["pipe", "pipe", "pipe"] });
    let carry = "", stderr = "", evidenceAt = 0;
    const settlements: Array<Record<string, unknown>> = [];
    child.stdout.on("data", bytes => {
      const lines = (carry + String(bytes)).split("\n"); carry = lines.pop() ?? "";
      for (const line of lines) {
        let event: Record<string, unknown>; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "child-exit-evidence") {
          evidenceAt = performance.now();
          assert.equal(child.stdin.writableEnded, false);
        } else if (event.type === "adapter-settled") settlements.push(event);
      }
    });
    child.stderr.on("data", bytes => { stderr += String(bytes); });
    let timer: NodeJS.Timeout | undefined;
    try {
      const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      const code = await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("open-stdin fixture timed out")), 10_000); })]);
      assert.equal(code, 0, stderr);
      const elapsed = performance.now() - evidenceAt;
      assert.ok(evidenceAt > 0 && elapsed < 1_000, `natural exit after evidence: ${elapsed} ms`);
      assert.equal(settlements.length, 1);
      assert.deepEqual(settlements[0]!.herdrCleanup, unavailable("pty-exit"));
      assert.equal(settlements[0]!.dataListeners, 0);
      assert.equal(settlements[0]!.readableFlowing, false);
      assert.equal(child.stdin.writableEnded, false);
      context.diagnostic(`${shape}: ${elapsed.toFixed(1)} ms from child-exit evidence to natural process close; stdin writer remained open`);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin.destroy();
    }
  }
}));

test("headless managed processes do not create a foreground checkpoint", async () => fixture(async (root, env) => {
  const child = Object.assign(new EventEmitter(), { pid: 918_316, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const result = runPiManagedProcess([], root, env, { primerPath: join(root, "primer.txt"), deployId: "d-headless", mode: "background" }, "inert", [], {
    spawnProcess: (() => child) as never, persistLine: () => {},
  });
  child.emit("close", 0);
  assert.equal((await result).metadata?.herdrCleanup, undefined);
}));
