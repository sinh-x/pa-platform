import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PiAdapter, runPiManagedProcess } from "../adapter.js";
import { createHerdrExitCleanup, HERDR_EXIT_BUDGET_MS } from "../herdr-exit-cleanup.js";
import { selectedPiEnvironment } from "../selected-pi-launch.js";

type Json = Record<string, any>;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const report = (seq: number, session = "A") => ({ pane_id: "w1:p315", source: "herdr:pi", agent: "pi", seq, agent_session_id: session, state: "idle" });
const metadata = (status: string, submitted: boolean, deathEvidence = "pty-exit", reason?: string) => ({ status, ...(reason ? { reason } : {}), submitted, deathEvidence });
function assertOutcome(actual: unknown, expected: Json): void {
  const { requestId, ...rest } = actual as Json;
  assert.deepEqual(rest, expected);
  if (expected.submitted) assert.match(requestId, /^ppa-herdr:[0-9a-f-]{36}$/);
  else assert.equal(requestId, undefined);
}

function call(path: string, method: string, params: Json = {}, id = `${method}:${Math.random()}`): Promise<Json> {
  return new Promise((resolve, reject) => {
    const socket = connect(path); let carry = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("fixture request timed out")); }, 2_000);
    const finish = () => { clearTimeout(timer); socket.destroy(); };
    socket.on("error", error => { finish(); reject(error); });
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", chunk => {
      carry += String(chunk);
      if (!carry.includes("\n")) return;
      try { const body = JSON.parse(carry.split("\n")[0]!); finish(); resolve(body); }
      catch (error) { finish(); reject(error); }
    });
    socket.on("end", () => { if (!carry.includes("\n")) { finish(); reject(new Error("fixture response ended")); } });
  });
}

class Backend {
  requests: Json[] = [];
  watermark = -1;
  registration: Json | undefined;
  intercept?: (request: Json, socket: Socket, apply: () => void) => void;
  apply(request: Json, socket: Socket): void {
    let result: Json = {};
    const { method, params } = request;
    if (method === "pane.report_agent" || method === "pane.report_agent_session") {
      if (params.seq > this.watermark) {
        this.watermark = params.seq;
        this.registration = { pane_id: params.pane_id, agent: params.agent, agent_session: params.agent_session_path ? { kind: "path", value: params.agent_session_path } : { kind: "id", value: params.agent_session_id } };
      }
    } else if (method === "agent.get") {
      if (!this.registration) { socket.end(`${JSON.stringify({ id: request.id, error: { code: "agent_not_found", message: "inert" } })}\n`); return; }
      result = { agent: this.registration };
    } else if (method === "pane.clear_agent_authority") {
      if (this.registration && params.seq > this.watermark) { this.watermark = params.seq; this.registration = undefined; }
    } else result = { echo: params };
    socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
  }
}

async function fixture(run: (root: string, env: NodeJS.ProcessEnv, backend: Backend) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-exit-")), path = join(root, "herdr.sock"), backend = new Backend();
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let carry = "";
    socket.on("data", chunk => {
      carry += String(chunk); if (!carry.includes("\n")) return;
      const request = JSON.parse(carry.split("\n")[0]!); backend.requests.push(request);
      const apply = () => backend.apply(request, socket);
      if (backend.intercept) backend.intercept(request, socket, apply); else apply();
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(path, resolve));
    await run(root, { PATH: process.env.PATH, HOME: process.env.HOME, HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: "w1:p315" }, backend);
  } finally {
    for (const socket of sockets) socket.destroy();
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

async function foreground(root: string, env: NodeJS.ProcessEnv, options: { processExists?: () => boolean; fastClock?: boolean } = {}) {
  const pty = new Pty(), input = new Input(), output: string[] = [];
  const primerPath = join(root, "primer.txt"); writeFileSync(primerPath, "inert fixture");
  let now = 0, spawned!: (env: NodeJS.ProcessEnv) => void;
  const ready = new Promise<NodeJS.ProcessEnv>(resolve => { spawned = resolve; });
  const adapter = new PiAdapter({ cwd: root, env, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined,
    supervision: {
      spawnPty: (_file, _args, opts) => { spawned(opts.env); return pty as never; }, input: input as never,
      output: { write: (value: string) => { output.push(value); return true; } } as never,
      persistLine: () => {}, processExists: options.processExists ?? (() => true),
      ...(options.fastClock ? { now: () => now, sleep: async (ms: number) => { now += ms; await tick(); } } : {}),
    },
  });
  const result = adapter.spawn({ primerPath, deployId: "d-herdr-exit", mode: "foreground", sessionId: "same-conversation" });
  const childEnv = await ready;
  return { pty, input, result, output, childEnv };
}

async function registered(env: NodeJS.ProcessEnv) {
  const stage = (await createHerdrExitCleanup(env))!;
  await call(stage.environment.HERDR_SOCKET_PATH!, "pane.report_agent_session", report(7));
  await call(stage.environment.HERDR_SOCKET_PATH!, "pane.report_agent", report(8));
  return stage;
}

test("no-Herdr, disabled, partial, invalid, aliased and filtered selected-host paths remain inert", async () => fixture(async (root, env) => {
  const alias = join(root, "alias.sock"); symlinkSync(env.HERDR_SOCKET_PATH!, alias);
  for (const candidate of [
    {}, { ...env, PA_HERDR_LIFECYCLE: "0" }, { ...env, HERDR_ENV: "0" },
    { ...env, HERDR_PANE_ID: undefined }, { ...env, HERDR_PANE_ID: "../other" },
    { ...env, HERDR_SOCKET_PATH: alias }, { ...env, HERDR_SOCKET_PATH: join(root, "dead.sock") },
  ]) assert.equal(await createHerdrExitCleanup(candidate), undefined);
  const environmentNames = JSON.parse(readFileSync(new URL("../../runtime/selected-pi-environment.json", import.meta.url), "utf8")) as string[];
  assert.equal(await createHerdrExitCleanup(selectedPiEnvironment({ schemaVersion: 1, entryFile: "/inert/entry", nodeFile: "/inert/node", packageRoot: "/inert/pi", addonFile: "/inert/addon", environmentNames }, env)), undefined);
}));

test("clear uses captured original binding and exact later sequence; duplicate exit shares one completion", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env), endpoint = stage.environment.HERDR_SOCKET_PATH!;
  env.HERDR_PANE_ID = "replacement"; env.HERDR_SOCKET_PATH = "/other.sock";
  const first = stage.afterVerifiedExit("pty-exit");
  assert.equal(stage.afterVerifiedExit("confirmed-process-gone"), first);
  assertOutcome(await first, metadata("verified-absent", true));
  assert.equal(existsSync(endpoint), false);
  const clear = backend.requests.filter(request => request.method === "pane.clear_agent_authority");
  assert.equal(clear.length, 1);
  assert.deepEqual(clear[0]!.params, { pane_id: "w1:p315", source: "herdr:pi", seq: 9 });
  assert.deepEqual(backend.requests.map(request => request.method), ["pane.report_agent_session", "pane.report_agent", "agent.get", "pane.clear_agent_authority", "agent.get"]);
  stage.dispose();
}));

test("report counter reset/reuse cannot lower the captured final watermark", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!;
  for (const seq of [100, 1, 1, 99, 101]) await call(stage.environment.HERDR_SOCKET_PATH!, "pane.report_agent", report(seq));
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
  assert.deepEqual(backend.requests.filter(request => request.method === "pane.report_agent").map(request => request.params.seq), [100, 1, 1, 99, 101], "report bytes/sequence semantics stay owned by the existing server");
  assert.equal(backend.requests.find(request => request.method === "pane.clear_agent_authority")!.params.seq, 102);
}));

test("stale and equal-sequence reports from another session cannot overwrite cleanup ownership", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!;
  for (const [session, seq] of [["A", 10], ["B", 12], ["A", 11], ["C", 12]] as const) {
    await call(stage.environment.HERDR_SOCKET_PATH!, "pane.report_agent", report(seq, session));
  }
  assert.equal(backend.registration!.agent_session.value, "B");
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
  assert.equal(backend.requests.find(request => request.method === "pane.clear_agent_authority")!.params.seq, 13);
}));

test("sequence exhaustion never substitutes a guessed maximum or submits a clear", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!;
  await call(stage.environment.HERDR_SOCKET_PATH!, "pane.report_agent", report(Number.MAX_SAFE_INTEGER));
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("unconfirmed", false, "pty-exit", "sequence-exhausted"));
  assert.equal(backend.requests.some(request => request.method === "pane.clear_agent_authority"), false);
}));

test("active report is acknowledged before clear; unsent and late reports cannot resurrect the entry", async () => fixture(async (_root, env, backend) => {
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  backend.intercept = (request, _socket, apply) => {
    if (request.method === "pane.report_agent") void active.then(apply); else apply();
  };
  const stage = (await createHerdrExitCleanup(env))!;
  const sent = call(stage.environment.HERDR_SOCKET_PATH!, "pane.report_agent", report(11)).catch(() => {});
  while (!backend.requests.length) await tick();
  const queued = call(stage.environment.HERDR_SOCKET_PATH!, "pane.report_agent", report(12)).catch(() => {});
  await tick();
  const complete = stage.afterVerifiedExit("pty-exit");
  assert.equal(backend.requests.filter(request => request.method === "pane.clear_agent_authority").length, 0);
  release();
  assertOutcome(await complete, metadata("verified-absent", true));
  await Promise.all([sent, queued]);
  assert.deepEqual(backend.requests.filter(request => request.method === "pane.report_agent").map(request => request.params.seq), [11]);
  assert.equal(backend.requests.find(request => request.method === "pane.clear_agent_authority")!.params.seq, 12);
  await assert.rejects(call(stage.environment.HERDR_SOCKET_PATH!, "pane.report_agent", report(99)));
  assert.equal(backend.registration, undefined);
}));

test("unsettled report consumes one total 500 ms budget and prevents destructive submission", async context => fixture(async (_root, env, backend) => {
  backend.intercept = () => {};
  const stage = (await createHerdrExitCleanup(env))!;
  const pending = call(stage.environment.HERDR_SOCKET_PATH!, "pane.report_agent", report(1)).catch(() => {});
  while (!backend.requests.length) await tick();
  const before = performance.now(), result = await stage.afterVerifiedExit("pty-exit"), elapsed = performance.now() - before;
  assertOutcome(result, metadata("unconfirmed", false, "pty-exit", "report-uncertain"));
  assert.ok(elapsed >= HERDR_EXIT_BUDGET_MS - 20 && elapsed < 750, `total deadline: ${elapsed} ms`);
  assert.equal(backend.requests.length, 1);
  await pending; context.diagnostic(`pending-report deadline: ${elapsed.toFixed(1)} ms (500 ms budget, measured scheduling tolerance)`);
}));

test("a changed/unowned registration is preserved without clear", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env);
  backend.registration = { pane_id: "w1:p315", agent: "pi", agent_session: { kind: "id", value: "B" } };
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("skipped", false, "pty-exit", "foreign-registration"));
  assert.equal(backend.registration.agent_session.value, "B");
  assert.equal(backend.requests.some(request => request.method === "pane.clear_agent_authority"), false);
}));

test("missing or replaced real socket cannot receive cleanup for the old server", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env);
  unlinkSync(env.HERDR_SOCKET_PATH!);
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("unconfirmed", false, "pty-exit", "socket-error"));
  assert.equal(backend.requests.some(request => request.method === "pane.clear_agent_authority"), false);
}));

test("OK with no disappearance is acknowledged, never verified removal", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env);
  backend.intercept = (request, socket, apply) => request.method === "pane.clear_agent_authority" ? socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`) : apply();
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("acknowledged", true, "pty-exit", "still-listed"));
}));

test("rejected, malformed, wrong-id, partial and oversized clear responses never retry", async context => {
  for (const failure of ["rejected", "malformed", "wrong-id", "partial", "oversized", "timeout"] as const) await context.test(failure, () => fixture(async (_root, env, backend) => {
    const stage = await registered(env);
    backend.intercept = (request, socket, apply) => {
      if (request.method !== "pane.clear_agent_authority") { apply(); return; }
      if (failure === "rejected") socket.end(`${JSON.stringify({ id: request.id, error: { code: "no", message: "inert" } })}\n`);
      if (failure === "malformed") socket.end("not-json\n");
      if (failure === "wrong-id") socket.end(`${JSON.stringify({ id: "foreign", result: {} })}\n`);
      if (failure === "partial") socket.end('{"id":');
      if (failure === "oversized") socket.end("x".repeat(70_000));
    };
    const before = performance.now(), result = await stage.afterVerifiedExit("pty-exit");
    assert.equal(result.status, "unconfirmed"); assert.equal(result.submitted, true);
    assert.ok(performance.now() - before < 750);
    assert.equal(backend.requests.filter(request => request.method === "pane.clear_agent_authority").length, 1);
    assert.equal(existsSync(stage.environment.HERDR_SOCKET_PATH!), false);
  }));
});

test("readback shares the original deadline rather than starting another 500 ms wait", async context => fixture(async (_root, env, backend) => {
  const stage = await registered(env); let gets = 0;
  backend.intercept = (request, _socket, apply) => {
    if (request.method === "agent.get" && ++gets === 1) setTimeout(apply, 300);
    else if (request.method === "agent.get") return;
    else apply();
  };
  const before = performance.now(), result = await stage.afterVerifiedExit("pty-exit"), elapsed = performance.now() - before;
  assertOutcome(result, metadata("acknowledged", true, "pty-exit", "timeout"));
  assert.ok(elapsed < 750, `total stage: ${elapsed} ms`);
  context.diagnostic(`ownership observation + clear + unresponsive readback: ${elapsed.toFixed(1)} ms`);
}));

test("normal later-launch sequences reject a timed-out old clear without blind retry", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env); let applyOld!: () => void;
  backend.intercept = (request, _socket, apply) => {
    if (request.method === "pane.clear_agent_authority") applyOld = apply; else apply();
  };
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("unconfirmed", true, "pty-exit", "timeout"));
  await call(env.HERDR_SOCKET_PATH!, "pane.report_agent", report(100, "B"));
  applyOld();
  assert.equal(backend.registration!.agent_session.value, "B");
  assert.equal(backend.requests.filter(request => request.method === "pane.clear_agent_authority").length, 1);
  // Source-derived actual-sequence ordering only; clock rollback/reanchor and
  // independent launch behavior require separate actual-server qualification.
}));

test("existing non-lifecycle API requests and large replies pass through unchanged", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!;
  const params = { target: "other-pane", text: "inert".repeat(15_000) };
  const response = await call(stage.environment.HERDR_SOCKET_PATH!, "inert.echo", params, "preserved-id");
  assert.deepEqual(response, { id: "preserved-id", result: { echo: params } });
  assert.deepEqual(backend.requests[0], { id: "preserved-id", method: "inert.echo", params });
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("skipped", false, "pty-exit", "not-reported"));
}));

test("opaque forwarding preserves write-half-close and buffered replies to slow consumers", async context => {
  for (const halfClose of [false, true]) await context.test(`halfClose=${halfClose}`, () => fixture(async (_root, env, backend) => {
    const stage = (await createHerdrExitCleanup(env))!;
    const expected = Buffer.from(`${JSON.stringify({ id: "large", result: { text: "x".repeat(4 * 1024 * 1024) } })}\n`);
    backend.intercept = (_request, socket) => { setTimeout(() => socket.end(expected), 25); };
    try {
      const actual = await new Promise<Buffer>((resolve, reject) => {
        const socket = connect(stage.environment.HERDR_SOCKET_PATH!), chunks: Buffer[] = [];
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("opaque response timed out")); }, 2_000);
        socket.on("error", error => { clearTimeout(timer); socket.destroy(); reject(error); });
        socket.on("connect", () => {
          const frame = `${JSON.stringify({ id: "large", method: "inert.large", params: {} })}\n`;
          if (halfClose) socket.end(frame); else socket.write(frame);
          socket.pause(); setTimeout(() => socket.resume(), 75);
        });
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("end", () => { clearTimeout(timer); socket.destroy(); resolve(Buffer.concat(chunks)); });
      });
      assert.equal(actual.length, expected.length, "no tail bytes may be discarded at upstream EOF");
      assert.equal(actual.equals(expected), true);
    } finally { stage.dispose(); }
  }));
});

test("actual supervisor awaits clear before returning, preserving normal/crash/signal results", async context => {
  for (const [exitCode, signal] of [[0, 0], [7, 0], [143, 15], [137, 9]] as const) await context.test(`${exitCode}/${signal}`, () => fixture(async (root, env, backend) => {
    const { pty, input, result, output, childEnv } = await foreground(root, env);
    await call(childEnv.HERDR_SOCKET_PATH!, "pane.report_agent", report(10));
    let release!: () => void, settlements = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    backend.intercept = (request, _socket, apply) => { if (request.method === "pane.clear_agent_authority") void pending.then(apply); else apply(); };
    void result.then(() => { settlements++; });
    pty.exit?.({ exitCode, signal }); pty.exit?.({ exitCode: 0 });
    while (!backend.requests.some(request => request.method === "pane.clear_agent_authority")) await tick();
    assert.equal(settlements, 0, "PPA still holds the foreground while Herdr clear is pending");
    release(); const value = await result;
    assert.equal(settlements, 1); assert.equal(value.exitCode, exitCode);
    assertOutcome(value.metadata?.herdrCleanup, metadata("verified-absent", true));
    assert.equal(value.metadata?.normalExit, signal === 0);
    assert.deepEqual(pty.signals, []); assert.deepEqual(output, []);
    assert.equal(input.isRaw, false); assert.equal(input.listenerCount("data"), 0);
    input.destroy();
  }));
});

test("live turns, new/resume/fork reports and quit input do not unregister a continuing process", async () => fixture(async (root, env, backend) => {
  const { pty, input, result, childEnv } = await foreground(root, env);
  let settled = false; void result.then(() => { settled = true; });
  for (const [index, reason] of ["startup", "new", "resume", "fork"].entries()) {
    await call(childEnv.HERDR_SOCKET_PATH!, "pane.report_agent_session", { ...report(index + 1), session_start_source: reason });
    pty.data?.(`${JSON.stringify({ type: "agent_end", state: "idle" })}\n`);
    assert.equal(settled, false);
    assert.equal(backend.requests.some(request => request.method === "pane.clear_agent_authority"), false);
  }
  input.emit("data", "/quit\n"); await tick(); assert.equal(settled, false);
  pty.exit?.({ exitCode: 0 }); assert.equal((await result).exitCode, 0); input.destroy();
}));

test("EOF and confirmed-death fallbacks keep truthful status; unproven death never clears", async context => {
  for (const scenario of ["eof", "unknown-status", "confirmed-cancellation", "unproven"] as const) await context.test(scenario, () => fixture(async (root, env, backend) => {
    let running = true;
    const { pty, input, result, childEnv } = await foreground(root, env, { processExists: () => running, fastClock: scenario !== "eof" });
    await call(childEnv.HERDR_SOCKET_PATH!, "pane.report_agent", report(5));
    if (scenario === "unknown-status") running = false;
    else {
      input.emit("end");
      if (scenario === "eof") { await tick(); pty.exit?.({ exitCode: 0 }); }
      if (scenario === "confirmed-cancellation") running = false;
    }
    const value = await result;
    if (scenario === "unproven") { assert.equal(value.metadata?.herdrCleanup, undefined); assert.equal(backend.requests.some(request => request.method === "pane.clear_agent_authority"), false); }
    else {
      assertOutcome(value.metadata?.herdrCleanup, metadata("verified-absent", true, scenario === "eof" ? "pty-exit" : "confirmed-process-gone"));
      assert.equal(value.exitCode, scenario === "unknown-status" ? 1 : 0);
      if (scenario === "unknown-status") assert.match(value.errorMessage!, /^process-exit-status-unavailable:/);
    }
    input.destroy();
  }));
});

test("open-stdin process exits below 1000 ms with responsive, dead or unresponsive cleanup", { timeout: 30_000 }, async context => fixture(async (_root, env, backend) => {
  for (const mode of ["responsive", "dead", "unresponsive"]) for (const shape of ["valid-json", "non-json", "different-json"]) {
    backend.intercept = (request, socket, apply) => {
      if (request.method === "pane.clear_agent_authority" && mode !== "responsive") {
        if (mode === "dead") socket.destroy();
      } else apply();
    };
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("fixtures/foreground-open-stdin-child.ts", import.meta.url)), shape], { env: { ...env, PAP315_FIXTURE_HERDR_REPORT: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let carry = "", stderr = "", evidenceAt = 0;
    const settlements: Json[] = [];
    child.stdout.on("data", bytes => {
      const lines = (carry + String(bytes)).split("\n"); carry = lines.pop() ?? "";
      for (const line of lines) {
        let event: Json; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "child-exit-evidence") { evidenceAt = performance.now(); assert.equal(child.stdin.writableEnded, false); }
        else if (event.type === "adapter-settled") settlements.push(event);
      }
    });
    child.stderr.on("data", bytes => { stderr += String(bytes); });
    let timer: NodeJS.Timeout | undefined;
    try {
      const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      const code = await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("open-stdin fixture timed out")), 10_000); })]);
      assert.equal(code, 0, stderr); const elapsed = performance.now() - evidenceAt;
      assert.ok(evidenceAt > 0 && elapsed < 1_000, `natural exit: ${elapsed} ms`);
      assert.equal(settlements.length, 1); assert.equal(settlements[0]!.dataListeners, 0);
      assert.equal(settlements[0]!.readableFlowing, false); assert.equal(child.stdin.writableEnded, false);
      assert.equal(settlements[0]!.herdrCleanup.submitted, true);
      assert.equal(settlements[0]!.herdrCleanup.status, mode === "responsive" ? "verified-absent" : "unconfirmed");
      context.diagnostic(`${mode}/${shape}: ${elapsed.toFixed(1)} ms to natural process close with stdin writer open`);
      backend.watermark = -1; backend.registration = undefined;
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin.destroy();
    }
  }
}));

test("headless managed processes do not create a foreground relay", async () => fixture(async (root, env, backend) => {
  const child = Object.assign(new EventEmitter(), { pid: 918_316, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const result = runPiManagedProcess([], root, env, { primerPath: join(root, "primer.txt"), deployId: "d-headless", mode: "background" }, "inert", [], { spawnProcess: (() => child) as never, persistLine: () => {} });
  child.emit("close", 0); assert.equal((await result).metadata?.herdrCleanup, undefined); assert.equal(backend.requests.length, 0);
}));
