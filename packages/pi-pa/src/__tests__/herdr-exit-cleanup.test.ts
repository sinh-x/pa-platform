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
import { createHerdrExitCleanup, herdrExitCleanupMessage, HERDR_EXIT_BUDGET_MS, HERDR_MANAGED_AGENT } from "../herdr-exit-cleanup.js";
import { selectedPiEnvironment } from "../selected-pi-launch.js";

type Json = Record<string, any>;
const RELEASE = "pane.release_agent", STATE = "pane.report_agent", SESSION = "pane.report_agent_session";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const report = (seq: number, session = "A") => ({ pane_id: "w1:p315", source: "herdr:pi", agent: "pi", seq, agent_session_id: session, state: "idle" });
const metadata = (status: string, submitted: boolean, deathEvidence = "pty-exit", reason?: string) => ({ status, ...(reason ? { reason } : {}), submitted, deathEvidence });
function assertOutcome(actual: unknown, expected: Json): void {
  const { requestId, source, agent, elapsedMs, ...rest } = actual as Json;
  assert.deepEqual(rest, expected); assert.equal(agent, "ppa-pi");
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 750);
  assert.match(source, /^ppa:pi:[0-9a-f-]{36}$/);
  if (expected.submitted) assert.match(requestId, /^ppa-herdr:[0-9a-f-]{36}$/);
  else assert.equal(requestId, undefined);
}
function rawCall(path: string, frame: string | Buffer): Promise<Json> {
  return new Promise((resolve, reject) => {
    const socket = connect(path); let carry = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("fixture request timed out")); }, 2_000);
    const finish = () => { clearTimeout(timer); socket.destroy(); };
    socket.on("error", error => { finish(); reject(error); });
    socket.on("connect", () => socket.write(frame));
    socket.on("data", chunk => {
      carry += String(chunk); if (!carry.includes("\n")) return;
      try { const body = JSON.parse(carry.split("\n")[0]!); finish(); resolve(body); }
      catch (error) { finish(); reject(error); }
    });
    socket.on("end", () => { if (!carry.includes("\n")) { finish(); reject(new Error("fixture response ended")); } });
  });
}
const call = (path: string, method: string, params: Json = {}, id = `${method}:${Math.random()}`) => rawCall(path, `${JSON.stringify({ id, method, params })}\n`);

/** Source-derived protocol subset, not an installed-server substitute. Custom
 * state claims need no detected Pi; custom session refs are intentionally NOT
 * exposed by agent.get. Release's source+agent guard precedes its sequence guard.
 */
class Backend {
  requests: Json[] = [];
  watermarks = new Map<string, number>();
  recentPiExit = false;
  registration: Json | undefined;
  intercept?: (request: Json, socket: Socket, apply: () => void) => void;
  apply(request: Json, socket: Socket): void {
    let result: Json = {};
    const { method, params } = request;
    if (method === STATE) {
      if (params.source !== "herdr:pi" && !(this.recentPiExit && params.agent === "pi") && params.seq > (this.watermarks.get(params.source) ?? -1)) {
        this.watermarks.set(params.source, params.seq);
        // Native Herdr retains an omitted command for the SAME source, and
        // reconciles it away when a different source owns the pane.
        const resume = params.resume_argv ?? (this.registration?.source === params.source ? this.registration.resume_argv : undefined);
        this.registration = { pane_id: params.pane_id, agent: params.agent, source: params.source, state: params.state, resume_argv: resume };
      }
    } else if (method === SESSION) {
      // Custom session reports carry local relay facts, but create no authority.
    } else if (method === "agent.get") {
      if (!this.registration) { socket.end(`${JSON.stringify({ id: request.id, error: { code: "agent_not_found", message: "inert" } })}\n`); return; }
      result = { agent: { pane_id: this.registration.pane_id, agent: this.registration.agent, agent_status: this.registration.state, agent_session: null } };
    } else if (method === RELEASE) {
      const current = this.registration;
      if (current?.source === params.source && current.agent === params.agent && params.seq > (this.watermarks.get(params.source) ?? -1)) {
        this.watermarks.set(params.source, params.seq); this.registration = undefined;
      }
    } else if (method === "pane.clear_agent_authority") {
      throw new Error("managed cleanup must never issue shared-source clear");
    } else result = { echo: params };
    socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
  }
}
async function fixture(run: (root: string, env: NodeJS.ProcessEnv, backend: Backend) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-exit-")), path = join(root, "herdr.sock"), backend = new Backend(), sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); let carry = "";
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
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
}
class Pty {
  readonly pid = 918_315; readonly signals: string[] = []; readonly writes: string[] = [];
  data?: (value: string) => void; exit?: (event: { exitCode: number; signal?: number }) => void;
  onData(handler: Pty["data"]): void { this.data = handler; }
  onExit(handler: Pty["exit"]): void { this.exit = handler; }
  write(value: string): void { this.writes.push(value); }
  resize(): void {}
  kill(signal: string): void { this.signals.push(signal); }
}
class Input extends Readable {
  readonly isTTY = true; isRaw = false;
  _read(): void {}
  setRawMode(raw: boolean): void { this.isRaw = raw; }
}
async function foreground(root: string, env: NodeJS.ProcessEnv, options: { processExists?: () => boolean; fastClock?: boolean } = {}) {
  const pty = new Pty(), input = new Input(), output: string[] = [], primerPath = join(root, "primer.txt"); writeFileSync(primerPath, "inert fixture");
  let now = 0, spawned!: (env: NodeJS.ProcessEnv) => void;
  const ready = new Promise<NodeJS.ProcessEnv>(resolve => { spawned = resolve; });
  const adapter = new PiAdapter({ cwd: root, env, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: {
    spawnPty: (_file, _args, opts) => { spawned(opts.env); return pty as never; }, input: input as never,
    output: { write: (value: string) => { output.push(value); return true; } } as never,
    persistLine: () => {}, processExists: options.processExists ?? (() => true),
    ...(options.fastClock ? { now: () => now, sleep: async (ms: number) => { now += ms; await tick(); } } : {}),
  } });
  const result = adapter.spawn({ primerPath, deployId: "d-herdr-exit", mode: "foreground", sessionId: "same-conversation" });
  const childEnv = await Promise.race([ready, result.then(value => { throw new Error(`fixture Pi did not spawn: ${value.errorMessage ?? value.exitCode}`); })]);
  return { pty, input, result, output, childEnv };
}
async function registered(env: NodeJS.ProcessEnv, seq = 7) {
  const stage = (await createHerdrExitCleanup(env))!;
  await call(stage.environment.HERDR_SOCKET_PATH!, SESSION, report(seq));
  await call(stage.environment.HERDR_SOCKET_PATH!, STATE, report(seq + 1)); return stage;
}

test("advisory activity wording is plain, bounded and does not turn uncertainty into removal", () => {
  for (const status of ["verified-absent", "acknowledged", "skipped", "unconfirmed"] as const) {
    const body = herdrExitCleanupMessage({ status });
    assert.ok(body.length < 300); assert.doesNotMatch(body, /[\u001b\u0000]/);
    assert.match(body, /^Pi exited/);
    if (status !== "verified-absent") { assert.match(body, /inspect/i); assert.doesNotMatch(body, /entry is absent/); }
  }
});

test("no-Herdr, disabled, partial, invalid, aliased and filtered selected-host paths remain inert", async () => fixture(async (root, env) => {
  const alias = join(root, "alias.sock"); symlinkSync(env.HERDR_SOCKET_PATH!, alias);
  for (const candidate of [{}, { ...env, PA_HERDR_LIFECYCLE: "0" }, { ...env, HERDR_ENV: "0" }, { ...env, HERDR_PANE_ID: undefined },
    { ...env, HERDR_PANE_ID: "../other" }, { ...env, HERDR_SOCKET_PATH: alias }, { ...env, HERDR_SOCKET_PATH: join(root, "dead.sock") }]) assert.equal(await createHerdrExitCleanup(candidate), undefined);
  const environmentNames = JSON.parse(readFileSync(new URL("../../runtime/selected-pi-environment.json", import.meta.url), "utf8")) as string[];
  assert.equal(await createHerdrExitCleanup(selectedPiEnvironment({ schemaVersion: 1, entryFile: "/inert/entry", nodeFile: "/inert/node", packageRoot: "/inert/pi", addonFile: "/inert/addon", environmentNames }, env)), undefined);
}));

test("managed source registers a hidden Pi and preserves native resume without custom session metadata", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!, endpoint = stage.environment.HERDR_SOCKET_PATH!;
  await call(endpoint, SESSION, { ...report(7), agent_session_path: "/tmp/native-session.jsonl" });
  assert.equal(backend.registration, undefined);
  await call(endpoint, STATE, { ...report(8), agent_session_path: "/tmp/native-session.jsonl", resume_argv: ["untrusted-command"] });
  assert.match(backend.registration!.source, /^ppa:pi:[0-9a-f-]{36}$/);
  assert.deepEqual(backend.registration!.resume_argv, ["pi", "--session", "/tmp/native-session.jsonl"]);
  assert.equal((await call(env.HERDR_SOCKET_PATH!, "agent.get", { target: "w1:p315" })).result.agent.agent_session, null);
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
}));

test("managed ppa-pi identity remains self-reported after a previous detected Pi exit", async () => fixture(async (_root, env, backend) => {
  backend.recentPiExit = true;
  const stage = await registered(env);
  assert.equal(backend.registration!.agent, "ppa-pi");
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
}));

test("release uses original binding and later sequence; duplicate exit shares one completion", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env), endpoint = stage.environment.HERDR_SOCKET_PATH!, source = backend.registration!.source;
  env.HERDR_PANE_ID = "replacement"; env.HERDR_SOCKET_PATH = "/other.sock";
  const first = stage.afterVerifiedExit("pty-exit"); assert.equal(stage.afterVerifiedExit("confirmed-process-gone"), first);
  assertOutcome(await first, metadata("verified-absent", true)); assert.equal(existsSync(endpoint), false);
  const releases = backend.requests.filter(request => request.method === RELEASE);
  assert.equal(releases.length, 1); assert.deepEqual(releases[0]!.params, { pane_id: "w1:p315", source, agent: HERDR_MANAGED_AGENT, seq: 9 });
  assert.deepEqual(backend.requests.map(request => request.method), [SESSION, STATE, RELEASE, "agent.get"]); stage.dispose();
}));

test("counter reset and stale session reports cannot lower retirement or overwrite resume", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!;
  for (const [session, seq] of [["A", 10], ["B", 12], ["A", 11], ["C", 12], ["B", 1]] as const) await call(stage.environment.HERDR_SOCKET_PATH!, STATE, report(seq, session));
  assert.deepEqual(backend.registration!.resume_argv, ["pi", "--session", "B"]);
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
  assert.equal(backend.requests.find(request => request.method === RELEASE)!.params.seq, 13);
}));

test("unsupported resume text is omitted rather than rejected or executed", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!;
  await call(stage.environment.HERDR_SOCKET_PATH!, STATE, { ...report(1), agent_session_path: "/tmp/quote's-session.jsonl" });
  assert.equal(backend.registration!.resume_argv, undefined);
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
}));

test("new references cannot retain the previous conversation's native recovery command", async context => {
  for (const replacement of [
    { agent_session_path: `/${"x".repeat(1100)}`, valid: true },
    { agent_session_path: "/tmp/quote's-session.jsonl", valid: false },
    { agent_session_path: "", valid: false },
    { agent_session_path: "/tmp/control\u0080.jsonl", valid: false },
    { agent_session_id: "x".repeat(513), valid: false },
  ]) await context.test(JSON.stringify(replacement), () => fixture(async (_root, env, backend) => {
    const stage = await registered(env), sourceA = backend.registration!.source;
    const { valid, ...reference } = replacement;
    await call(stage.environment.HERDR_SOCKET_PATH!, STATE, { pane_id: "w1:p315", source: "herdr:pi", agent: "pi", state: "idle", seq: 9, ...reference });
    assert.notEqual(backend.registration!.source, sourceA, "new state rebinds without an unregister operation");
    assert.deepEqual(backend.registration!.resume_argv, valid ? ["pi", "--session", reference.agent_session_path] : undefined);
    assert.equal(backend.requests.some(request => request.method === RELEASE), false);
    assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
  }));
});

test("an absent reference in a new session clears recovery, while state-only absence retains its session", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env), endpoint = stage.environment.HERDR_SOCKET_PATH!, initialSource = backend.registration!.source;
  const noRef = { pane_id: "w1:p315", source: "herdr:pi", agent: "pi", state: "idle" };
  await call(endpoint, STATE, { ...noRef, seq: 9 });
  assert.equal(backend.registration!.source, initialSource);
  assert.deepEqual(backend.registration!.resume_argv, ["pi", "--session", "A"]);
  await call(endpoint, SESSION, { ...noRef, seq: 10, session_start_source: "new" });
  await call(endpoint, STATE, { ...noRef, seq: 11 });
  assert.notEqual(backend.registration!.source, initialSource); assert.equal(backend.registration!.resume_argv, undefined);
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
}));

test("malformed method, deeply nested owned input and invalid UTF-8 cannot kill or rewrite the supervisor", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!, endpoint = stage.environment.HERDR_SOCKET_PATH!;
  await rawCall(endpoint, '{"id":"object-method","method":{"toString":null},"params":{}}\n');
  assert.deepEqual(backend.requests[0]!.method, { toString: null }, "opaque malformed request remains server-owned");
  const deep = `{"id":"deep","method":"${STATE}","params":${JSON.stringify(report(1)).slice(0, -1)},"nested":${"[".repeat(8000)}0${"]".repeat(8000)}}}\n`;
  assert.equal((await rawCall(endpoint, deep)).error.code, "invalid_lifecycle_report");
  const valid = Buffer.from(`${JSON.stringify({ id: "bad-utf8", method: STATE, params: { ...report(2), message: "MARKER" } })}\n`), offset = valid.indexOf("MARKER");
  const invalid = Buffer.concat([valid.subarray(0, offset), Buffer.from([0xff]), valid.subarray(offset + 6)]);
  assert.equal((await rawCall(endpoint, invalid)).error.code, "invalid_lifecycle_report");
  assert.equal(backend.requests.length, 1, "invalid frames are never normalized into accepted managed reports");
  await call(endpoint, STATE, report(3)); assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
}));

test("session-only and noncanonical/duplicate-key frames cannot manufacture managed state ownership", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!, endpoint = stage.environment.HERDR_SOCKET_PATH!;
  const duplicate = `{"id":"bad","method":"${STATE}","params":${JSON.stringify(report(1))},"params":${JSON.stringify(report(2))}}\n`;
  assert.equal((await rawCall(endpoint, duplicate)).error.code, "invalid_lifecycle_report");
  await call(endpoint, SESSION, report(3)); assert.equal(backend.requests.length, 1);
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("skipped", false, "pty-exit", "not-reported"));
}));

test("sequence exhaustion never submits a guessed maximum", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!; await call(stage.environment.HERDR_SOCKET_PATH!, STATE, report(Number.MAX_SAFE_INTEGER));
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("unconfirmed", false, "pty-exit", "sequence-exhausted"));
  assert.equal(backend.requests.some(request => request.method === RELEASE), false);
}));

test("active report settles before release; unsent/late local reports are fenced", async () => fixture(async (_root, env, backend) => {
  let release!: () => void; const active = new Promise<void>(resolve => { release = resolve; });
  backend.intercept = (request, _socket, apply) => { if (request.method === STATE) void active.then(apply); else apply(); };
  const stage = (await createHerdrExitCleanup(env))!;
  const sent = call(stage.environment.HERDR_SOCKET_PATH!, STATE, report(11)).catch(() => {});
  while (!backend.requests.length) await tick();
  const queued = call(stage.environment.HERDR_SOCKET_PATH!, STATE, report(12)).catch(() => {}); await tick();
  const complete = stage.afterVerifiedExit("pty-exit"); assert.equal(backend.requests.some(request => request.method === RELEASE), false);
  release(); assertOutcome(await complete, metadata("verified-absent", true)); await Promise.all([sent, queued]);
  assert.deepEqual(backend.requests.filter(request => request.method === STATE).map(request => request.params.seq), [11]);
  await assert.rejects(call(stage.environment.HERDR_SOCKET_PATH!, STATE, report(99))); assert.equal(backend.registration, undefined);
}));

test("uncertain report consumes one total 500 ms budget without destructive submission", async context => fixture(async (_root, env, backend) => {
  backend.intercept = () => {}; const stage = (await createHerdrExitCleanup(env))!;
  const pending = call(stage.environment.HERDR_SOCKET_PATH!, STATE, report(1)).catch(() => {}); while (!backend.requests.length) await tick();
  const before = performance.now(), result = await stage.afterVerifiedExit("pty-exit"), elapsed = performance.now() - before;
  assertOutcome(result, metadata("unconfirmed", false, "pty-exit", "report-uncertain"));
  assert.ok(elapsed >= HERDR_EXIT_BUDGET_MS - 20 && elapsed < 750, `total deadline: ${elapsed} ms`); assert.equal(backend.requests.length, 1);
  await pending; context.diagnostic(`pending-report total: ${elapsed.toFixed(1)} ms`);
}));

test("atomic source guard preserves a different registration without a check-then-clear", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env); backend.registration = { pane_id: "w1:p315", agent: "pi", source: "other-incarnation", state: "idle" };
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("acknowledged", true, "pty-exit", "still-listed"));
  assert.equal(backend.registration.source, "other-incarnation");
}));

test("missing real socket cannot receive release for the old server", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env); unlinkSync(env.HERDR_SOCKET_PATH!);
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("unconfirmed", false, "pty-exit", "socket-error"));
  assert.equal(backend.requests.some(request => request.method === RELEASE), false);
}));

test("OK without disappearance is acknowledged, never verified removal", async () => fixture(async (_root, env, backend) => {
  const stage = await registered(env);
  backend.intercept = (request, socket, apply) => request.method === RELEASE ? socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`) : apply();
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("acknowledged", true, "pty-exit", "still-listed"));
}));

test("rejected, malformed, wrong-id, partial, oversized and timed-out release replies never retry", async context => {
  for (const failure of ["rejected", "malformed", "wrong-id", "partial", "oversized", "timeout"] as const) await context.test(failure, () => fixture(async (_root, env, backend) => {
    const stage = await registered(env);
    backend.intercept = (request, socket, apply) => {
      if (request.method !== RELEASE) { apply(); return; }
      if (failure === "rejected") socket.end(`${JSON.stringify({ id: request.id, error: { code: "no", message: "inert" } })}\n`);
      if (failure === "malformed") socket.end("not-json\n");
      if (failure === "wrong-id") socket.end(`${JSON.stringify({ id: "foreign", result: {} })}\n`);
      if (failure === "partial") socket.end('{"id":');
      if (failure === "oversized") socket.end("x".repeat(70_000));
    };
    const before = performance.now(), result = await stage.afterVerifiedExit("pty-exit");
    assert.equal(result.status, "unconfirmed"); assert.equal(result.submitted, true); assert.ok(performance.now() - before < 750);
    assert.equal(backend.requests.filter(request => request.method === RELEASE).length, 1); assert.equal(existsSync(stage.environment.HERDR_SOCKET_PATH!), false);
  }));
});

test("release and readback share one deadline", async context => fixture(async (_root, env, backend) => {
  const stage = await registered(env);
  backend.intercept = (request, _socket, apply) => { if (request.method === RELEASE) setTimeout(apply, 300); else if (request.method !== "agent.get") apply(); };
  const before = performance.now(), result = await stage.afterVerifiedExit("pty-exit"), elapsed = performance.now() - before;
  assertOutcome(result, metadata("acknowledged", true, "pty-exit", "timeout")); assert.ok(elapsed < 750); context.diagnostic(`release + readback: ${elapsed.toFixed(1)} ms`);
}));

test("delayed A release preserves B with lower/equal/higher counters and the same conversation", async context => {
  for (const counter of [1, 8, 100]) await context.test(String(counter), () => fixture(async (_root, env, backend) => {
    const a = await registered(env); let applyOld!: () => void;
    backend.intercept = (request, _socket, apply) => { if (request.method === RELEASE) applyOld = apply; else apply(); };
    const oldResult = await a.afterVerifiedExit("pty-exit"); assertOutcome(oldResult, metadata("unconfirmed", true, "pty-exit", "timeout"));
    const b = (await createHerdrExitCleanup(env))!; await call(b.environment.HERDR_SOCKET_PATH!, STATE, report(counter));
    const bSource = backend.registration!.source; assert.notEqual(bSource, oldResult.source); applyOld();
    assert.equal(backend.registration!.source, bSource, "server must compare source BEFORE sequencing");
    backend.intercept = undefined; assertOutcome(await b.afterVerifiedExit("pty-exit"), metadata("verified-absent", true));
  }));
});

test("existing non-lifecycle requests and large replies pass through unchanged", async () => fixture(async (_root, env, backend) => {
  const stage = (await createHerdrExitCleanup(env))!, params = { target: "other-pane", text: "inert".repeat(15_000) };
  assert.deepEqual(await call(stage.environment.HERDR_SOCKET_PATH!, "inert.echo", params, "preserved-id"), { id: "preserved-id", result: { echo: params } });
  assert.deepEqual(backend.requests[0], { id: "preserved-id", method: "inert.echo", params });
  assertOutcome(await stage.afterVerifiedExit("pty-exit"), metadata("skipped", false, "pty-exit", "not-reported"));
}));

test("opaque forwarding preserves half-close and buffered replies to slow consumers", async context => {
  for (const halfClose of [false, true]) await context.test(String(halfClose), () => fixture(async (_root, env, backend) => {
    const stage = (await createHerdrExitCleanup(env))!, expected = Buffer.from(`${JSON.stringify({ id: "large", result: { text: "x".repeat(4 * 1024 * 1024) } })}\n`);
    backend.intercept = (_request, socket) => { setTimeout(() => socket.end(expected), 25); };
    try {
      const actual = await new Promise<Buffer>((resolve, reject) => {
        const socket = connect(stage.environment.HERDR_SOCKET_PATH!), chunks: Buffer[] = [];
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("opaque response timed out")); }, 2_000);
        socket.on("error", error => { clearTimeout(timer); socket.destroy(); reject(error); });
        socket.on("connect", () => { const frame = `${JSON.stringify({ id: "large", method: "inert.large", params: {} })}\n`; if (halfClose) socket.end(frame); else socket.write(frame); socket.pause(); setTimeout(() => socket.resume(), 75); });
        socket.on("data", (chunk: Buffer) => chunks.push(chunk)); socket.on("end", () => { clearTimeout(timer); socket.destroy(); resolve(Buffer.concat(chunks)); });
      });
      assert.equal(actual.equals(expected), true);
    } finally { stage.dispose(); }
  }));
});

test("supervisor awaits retirement before returning and preserves normal/crash/signal status", async context => {
  for (const [exitCode, signal] of [[0, 0], [7, 0], [143, 15], [137, 9]] as const) await context.test(`${exitCode}/${signal}`, () => fixture(async (root, env, backend) => {
    const { pty, input, result, output, childEnv } = await foreground(root, env); await call(childEnv.HERDR_SOCKET_PATH!, STATE, report(10));
    let release!: () => void, settlements = 0; const pending = new Promise<void>(resolve => { release = resolve; });
    backend.intercept = (request, _socket, apply) => { if (request.method === RELEASE) void pending.then(apply); else apply(); };
    void result.then(() => { settlements++; }); pty.exit?.({ exitCode, signal }); pty.exit?.({ exitCode: 0 });
    while (!backend.requests.some(request => request.method === RELEASE)) await tick(); assert.equal(settlements, 0);
    release(); const value = await result; assert.equal(settlements, 1); assert.equal(value.exitCode, exitCode);
    assertOutcome(value.metadata?.herdrCleanup, metadata("verified-absent", true)); assert.equal(value.metadata?.normalExit, signal === 0);
    const observations = readFileSync(join(root, "activity.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(observations.length, 1); assert.equal(observations[0].partType, "herdr_cleanup");
    assert.equal(observations[0].metadata.source, (value.metadata?.herdrCleanup as Json).source);
    assert.equal(observations[0].metadata.status, "verified-absent");
    assert.deepEqual(pty.signals, []); assert.deepEqual(output, []); assert.equal(input.isRaw, false); assert.equal(input.listenerCount("data"), 0); input.destroy();
  }));
});

test("live idle/working/blocked and new/resume/fork stay listed until actual exit", async () => fixture(async (root, env, backend) => {
  const { pty, input, result, childEnv } = await foreground(root, env); let settled = false; void result.then(() => { settled = true; }); let seq = 0;
  for (const reason of ["startup", "new", "resume", "fork"]) for (const state of ["idle", "working", "blocked"]) {
    await call(childEnv.HERDR_SOCKET_PATH!, SESSION, { ...report(++seq), session_start_source: reason });
    await call(childEnv.HERDR_SOCKET_PATH!, STATE, { ...report(++seq), state });
    assert.equal(backend.registration!.state, state); pty.data?.('{"type":"agent_end"}\n'); assert.equal(settled, false);
    assert.equal(backend.requests.some(request => request.method === RELEASE), false);
  }
  input.emit("data", "/quit\n"); await tick(); assert.equal(settled, false); pty.exit?.({ exitCode: 0 }); assert.equal((await result).exitCode, 0); input.destroy();
}));

test("EOF and confirmed-death fallbacks keep truthful status; unproven death cannot release", async context => {
  for (const scenario of ["eof", "unknown-status", "confirmed-cancellation", "unproven"] as const) await context.test(scenario, () => fixture(async (root, env, backend) => {
    let running = true; const { pty, input, result, childEnv } = await foreground(root, env, { processExists: () => running, fastClock: scenario !== "eof" });
    await call(childEnv.HERDR_SOCKET_PATH!, STATE, report(5));
    if (scenario === "unknown-status") running = false;
    else { input.emit("end"); if (scenario === "eof") { await tick(); pty.exit?.({ exitCode: 0 }); } if (scenario === "confirmed-cancellation") running = false; }
    const value = await result;
    if (scenario === "unproven") { assert.equal(value.metadata?.herdrCleanup, undefined); assert.equal(backend.requests.some(request => request.method === RELEASE), false); }
    else { assertOutcome(value.metadata?.herdrCleanup, metadata("verified-absent", true, scenario === "eof" ? "pty-exit" : "confirmed-process-gone")); assert.equal(value.exitCode, scenario === "unknown-status" ? 1 : 0); if (scenario === "unknown-status") assert.match(value.errorMessage!, /^process-exit-status-unavailable:/); }
    input.destroy();
  }));
});

test("open-stdin natural exit remains below 1000 ms for responsive/dead/unresponsive cleanup", { timeout: 30_000 }, async context => fixture(async (_root, env, backend) => {
  for (const mode of ["responsive", "dead", "unresponsive"]) for (const shape of ["valid-json", "non-json", "different-json"]) {
    backend.intercept = (request, socket, apply) => { if (request.method === RELEASE && mode !== "responsive") { if (mode === "dead") socket.destroy(); } else apply(); };
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("fixtures/foreground-open-stdin-child.ts", import.meta.url)), shape], { env: { ...env, PAP315_FIXTURE_HERDR_REPORT: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let carry = "", stderr = "", evidenceAt = 0; const settlements: Json[] = [];
    child.stdout.on("data", bytes => { const lines = (carry + String(bytes)).split("\n"); carry = lines.pop() ?? ""; for (const line of lines) { let event: Json; try { event = JSON.parse(line); } catch { continue; } if (event.type === "child-exit-evidence") { evidenceAt = performance.now(); assert.equal(child.stdin.writableEnded, false); } else if (event.type === "adapter-settled") settlements.push(event); } });
    child.stderr.on("data", bytes => { stderr += String(bytes); }); let timer: NodeJS.Timeout | undefined;
    try {
      const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      const code = await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("open-stdin fixture timed out")), 10_000); })]);
      assert.equal(code, 0, stderr); const elapsed = performance.now() - evidenceAt; assert.ok(evidenceAt > 0 && elapsed < 1_000, `natural exit: ${elapsed} ms`);
      assert.equal(settlements.length, 1); assert.equal(settlements[0]!.dataListeners, 0); assert.equal(settlements[0]!.readableFlowing, false); assert.equal(child.stdin.writableEnded, false);
      assert.equal(settlements[0]!.herdrCleanup.submitted, true); assert.equal(settlements[0]!.herdrCleanup.status, mode === "responsive" ? "verified-absent" : "unconfirmed");
      context.diagnostic(`${mode}/${shape}: ${elapsed.toFixed(1)} ms to natural close`); backend.registration = undefined;
    } finally { if (timer) clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); child.stdin.destroy(); }
  }
}));

test("headless managed processes create no foreground relay", async () => fixture(async (root, env, backend) => {
  const child = Object.assign(new EventEmitter(), { pid: 918_316, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const result = runPiManagedProcess([], root, env, { primerPath: join(root, "primer.txt"), deployId: "d-headless", mode: "background" }, "inert", [], { spawnProcess: (() => child) as never, persistLine: () => {} });
  child.emit("close", 0); assert.equal((await result).metadata?.herdrCleanup, undefined); assert.equal(backend.requests.length, 0);
}));
