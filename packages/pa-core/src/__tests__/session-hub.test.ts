import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { PA_OPENCODE_BINARY_ENV, resolveBinary, SessionManager, type SessionStreamEvent, type SessionStreamSink, type SessionEventNormalizer } from "../agent-api/ws/session-hub.js";
import { createActivityEvent } from "../activity/index.js";
import { getDeployPaths } from "../deploy/paths.js";
import { appendRegistryEvent, closeDb } from "../registry/index.js";

let sessionRoot: string;

// Even the generic default-env tests append lifecycle events. Isolate every
// test, not just managed-origin tests, without changing production inheritance.
beforeEach((t) => {
  const previous = process.env;
  const root = mkdtempSync(join(tmpdir(), "pa-session-origin-"));
  sessionRoot = root;
  closeDb();
  process.env = {
    ...previous,
    PA_PLATFORM_CONFIG: join(root, "config"),
    PA_PLATFORM_DATA: join(root, "data"),
    PA_AI_USAGE_HOME: root,
    PA_REGISTRY_DB: join(root, "registry.db"),
  };
  // Remove only the parent launch principal; denial tests install their own.
  delete process.env.PA_DEPLOYMENT_ID;
  delete process.env.PA_TEAM;
  delete process.env.PA_MODE;
  t.after(() => {
    try { closeDb(); }
    finally {
      process.env = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  mkdirSync(join(root, "config"));
});

function withSessionEnv(fn: (root: string) => void): void {
  fn(sessionRoot);
}

function snapshotFiles(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => {
    const path = join(entry.parentPath, entry.name);
    return { path, content: entry.isFile() ? readFileSync(path) : null };
  });
}

class FakeChild extends EventEmitter {
  readonly pid = 42001;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  killSignal?: string;
  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }
}

class CapturingSink implements SessionStreamSink {
  readonly events: SessionStreamEvent[] = [];
  send(event: SessionStreamEvent): void {
    this.events.push(event);
  }
}

interface FakeSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: unknown;
}

interface SpawnedCall {
  command: string;
  args: string[];
  opts: FakeSpawnOptions;
}

function createFakeSpawn(children: FakeChild[] = []): { fn: typeof import("node:child_process").spawn; children: FakeChild[]; calls: SpawnedCall[] } {
  const list = children;
  const calls: SpawnedCall[] = [];
  const fn = ((command: string, args: string[], opts: FakeSpawnOptions): FakeChild => {
    calls.push({ command, args, opts });
    const child = new FakeChild();
    list.push(child);
    return child as unknown as import("node:child_process").ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { fn, children: list, calls };
}

test("SessionManager.start spawns opencode with model, --dangerously-skip-permissions, --format json, and prompt", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3, now: () => new Date("2026-08-05T00:00:00.000Z") });
  const sink = new CapturingSink();
  const result = mgr.start({ model: "openai/gpt-5.5", prompt: "Hello" }, sink);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(children.length, 1);
  const record = result.session;
  assert.match(record.id, /^s/);
  assert.equal(record.model, "openai/gpt-5.5");
  assert.equal(record.status, "running");
  assert.equal(record.startedAt, "2026-08-05T00:00:00.000Z");
  const activityLogPath = getDeployPaths(record.deploymentId).activityLogPath;
  assert.equal(activityLogPath, join(sessionRoot, "deployments", record.deploymentId, "activity.jsonl"));
  assert.match(readFileSync(activityLogPath, "utf8"), /session_started/);
  mgr.cleanup();
  assert.match(readFileSync(activityLogPath, "utf8"), /session_stopping/);
});

test("SessionManager.list returns active session records", () => {
  const { fn } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  mgr.start({ prompt: "Hello" }, sink);
  mgr.start({ prompt: "World", model: "openai/gpt-5.5" }, sink);

  const records = mgr.list();
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.status === "running"));
  assert.ok(new Set(records.map((r) => r.id)).size === 2, "ids must be unique");
});

test("SessionManager.get returns record by id and undefined for unknown", () => {
  const { fn } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");
  const id = result.session.id;

  assert.deepEqual(mgr.get(id)?.id, id);
  assert.equal(mgr.get("unknown"), undefined);
});

test("SessionManager enforces PA_MAX_SESSIONS limit at boundary", () => {
  const { fn } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 2 });
  const sink = new CapturingSink();
  const first = mgr.start({ prompt: "1" }, sink);
  const second = mgr.start({ prompt: "2" }, sink);
  const third = mgr.start({ prompt: "3" }, sink);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.equal(third.error, "Max sessions reached");
  assert.equal(third.limit, 2);
  assert.equal(mgr.activeCount, 2);
  assert.equal(mgr.limit, 2);
  assert.equal(mgr.atCapacity(), true);
});

test("SessionManager reads PA_MAX_SESSIONS from env when not passed explicitly", () => {
  const previous = process.env["PA_MAX_SESSIONS"];
  process.env["PA_MAX_SESSIONS"] = "5";
  try {
    const { fn } = createFakeSpawn();
    const mgr = new SessionManager({ spawnFn: fn });
    assert.equal(mgr.limit, 5);
  } finally {
    if (previous === undefined) delete process.env["PA_MAX_SESSIONS"];
    else process.env["PA_MAX_SESSIONS"] = previous;
  }
});

test("SessionManager falls back to default 3 when PA_MAX_SESSIONS is invalid", () => {
  const previous = process.env["PA_MAX_SESSIONS"];
  process.env["PA_MAX_SESSIONS"] = "not-a-number";
  try {
    const { fn } = createFakeSpawn();
    const mgr = new SessionManager({ spawnFn: fn });
    assert.equal(mgr.limit, 3);
  } finally {
    if (previous === undefined) delete process.env["PA_MAX_SESSIONS"];
    else process.env["PA_MAX_SESSIONS"] = previous;
  }
});

test("SessionManager.stop terminates the opencode child process and removes the session", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");
  const id = result.session.id;

  const stopResult = mgr.stop(id);
  assert.equal(stopResult.ok, true);
  if (!stopResult.ok) return;
  assert.equal(stopResult.status, "stopped");
  assert.equal(children[0]?.killed, true);
  assert.equal(children[0]?.killSignal, "SIGTERM");
  assert.equal(mgr.get(id), undefined);
  assert.equal(mgr.activeCount, 0);
});

test("SessionManager.stop returns error for unknown session id", () => {
  const { fn } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const result = mgr.stop("unknown");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "Session not found");
});

test("SessionManager streams JSONL stdout lines as structured event messages", () => {
  const normalizer: SessionEventNormalizer = (raw, deployId) => {
    const type = String(raw["type"] ?? "text");
    const kind = type === "thinking" ? "thinking" : "text";
    const text = (raw["text"] ?? raw["thinking"] ?? "") as string;
    return createActivityEvent({ deployId, kind, source: "opencode", body: String(text) });
  };
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3, now: () => new Date("2026-08-05T00:00:00.000Z"), normalizer });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");

  const child = children[0]!;
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", text: "Hello back" }) + "\n"));
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "thinking", thinking: "reasoning" }) + "\n"));

  const events = sink.events.filter((e) => e.type === "event");
  assert.equal(events.length, 2);
  assert.equal(events[0]?.timestamp, "2026-08-05T00:00:00.000Z");
  const firstData = events[0]?.data as Record<string, unknown>;
  assert.equal(firstData?.body, "Hello back");
  const secondData = events[1]?.data as Record<string, unknown>;
  assert.equal(secondData?.kind, "thinking");
});

test("SessionManager bounds and redacts normalizer-error fallback events", () => {
  const { fn, children } = createFakeSpawn();
  const normalizer: SessionEventNormalizer = () => { throw new Error("invalid timestamp"); };
  const mgr = new SessionManager({ spawnFn: fn, runtimeNormalizers: { opencode: normalizer }, env: { PA_API_KEY: "fallback-secret-value" } });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");
  children[0]!.stdout.emit("data", Buffer.from(JSON.stringify({ type: "message", body: "x".repeat(7000), authorization: "fallback-secret-value" }) + "\n"));
  const event = sink.events.find((item) => item.type === "event");
  assert.ok(event);
  assert.ok(JSON.stringify(event?.data).length <= 8192);
  assert.doesNotMatch(JSON.stringify(event?.data), /fallback-secret-value/);
  assert.ok(String((event?.data as Record<string, unknown>)?.body).length <= 500);
});

test("SessionManager emits end event when opencode process closes", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");

  const child = children[0]!;
  child.emit("close", 0);

  const endEvent = sink.events.find((e) => e.type === "end");
  assert.ok(endEvent);
  assert.deepEqual(endEvent?.data, { exitCode: 0 });
});

test("SessionManager emits error event on child spawn error", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");

  const child = children[0]!;
  child.emit("error", new Error("spawn failed"));

  const errorEvent = sink.events.find((e) => e.type === "error");
  assert.ok(errorEvent);
  assert.equal(errorEvent?.message, "spawn failed");
});

test("SessionManager.disconnect terminates the opencode child process (auto-cleanup on WebSocket disconnect)", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");
  const id = result.session.id;

  mgr.disconnect(id);
  assert.equal(children[0]?.killed, true);
  assert.equal(children[0]?.killSignal, "SIGTERM");
  assert.equal(mgr.get(id), undefined);
  assert.equal(mgr.activeCount, 0);
});

test("SessionManager.resume spawns opencode with --session for an exact recorded managed session", () => {
  withSessionEnv(() => {
    const deploymentId = "d-334abc", sessionId = "managed-opencode-session";
    appendRegistryEvent({ deployment_id: deploymentId, team: "builder", runtime: "opencode", event: "started", timestamp: new Date().toISOString() });
    const dir = getDeployPaths(deploymentId).deployDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session-id-opencode.txt"), sessionId, { mode: 0o600 });
    const { fn, children, calls } = createFakeSpawn();
    const mgr = new SessionManager({ env: {}, spawnFn: fn, maxSessions: 3 });
    const sink = new CapturingSink();
    const result = mgr.resume({ prompt: "continue", deploymentId, sessionId }, sink);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.session.status, "running");
    assert.equal(mgr.activeCount, 1);
    assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--session") + 1], sessionId);
    children[0]!.emit("close", 0);
    assert.equal(mgr.resume({ prompt: "continue again", sessionId }, sink).ok, true, "launcher-bound OPA resumes retain their managed origin");
    children[1]!.emit("close", 0);
    appendRegistryEvent({ deployment_id: deploymentId, team: "builder", runtime: "opencode", event: "pid", timestamp: new Date().toISOString(), resumed_from_deployment_id: "d-334def" });
    assert.equal(mgr.resume({ prompt: "continue", sessionId }, sink).ok, false, "same-server origin must recheck its recorded lineage");
    assert.equal(calls.length, 2);
  });
});

test("SessionManager.cleanup terminates all active sessions", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 5 });
  const sink = new CapturingSink();
  mgr.start({ prompt: "1" }, sink);
  mgr.start({ prompt: "2" }, sink);
  mgr.start({ prompt: "3" }, sink);

  assert.equal(mgr.activeCount, 3);
  mgr.cleanup();
  assert.equal(mgr.activeCount, 0);
  assert.equal(children.length, 3);
  assert.ok(children.every((c) => c.killed));
});

test("SessionManager handles line-buffered JSONL split across chunks", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");

  const child = children[0]!;
  const partial = JSON.stringify({ type: "text", text: "split" }).slice(0, 10);
  const rest = JSON.stringify({ type: "text", text: "split" }).slice(10);
  child.stdout.emit("data", Buffer.from(partial));
  child.stdout.emit("data", Buffer.from(rest + "\n"));

  const events = sink.events.filter((e) => e.type === "event");
  assert.equal(events.length, 1);
});

test("SessionManager emits non-JSON stdout lines as text events without throwing", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");

  const child = children[0]!;
  child.stdout.emit("data", Buffer.from("plain text line\n"));

  const events = sink.events.filter((e) => e.type === "event");
  assert.equal(events.length, 1);
  const data = events[0]?.data as Record<string, unknown>;
  assert.equal(data?.kind, "text");
  assert.equal(data?.body, "plain text line");
});

test("SessionManager does not emit events after termination", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");
  const id = result.session.id;

  mgr.stop(id);
  const beforeCount = sink.events.length;
  const child = children[0]!;
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", text: "late" }) + "\n"));

  assert.equal(sink.events.length, beforeCount);
});

test("Pi sessions use the Pi command and retain runtime provenance for cross-runtime resume", () => {
  const { fn, children, calls } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, runtimes: { pi: {} }, maxSessions: 3 });
  const sink = new CapturingSink();
  const started = mgr.start({ runtime: "pi", prompt: "Continue" }, sink);
  assert.equal(started.ok, true); if (!started.ok) return;
  assert.equal(calls[0]?.command, "pi");
  assert.deepEqual(calls[0]?.args.slice(0, 5), ["--print", "--mode", "json", "--session-id", started.session.id]);
  const resumed = mgr.resume({ sessionId: started.session.id, prompt: "Wrong runtime" }, sink);
  assert.equal(resumed.ok, false);
  if (!resumed.ok) assert.match(resumed.error, /'ppa'/);
  children[0]?.emit("close", 0);
});

test("Pi WebSocket output bounds and redacts secrets across chunks and malformed lines", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, runtimes: { pi: {} }, env: { PA_API_KEY: "split-secret-value" }, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.start({ runtime: "pi", prompt: "Hello" }, sink);
  assert.equal(result.ok, true);
  const child = children[0]!;
  child.stdout.emit("data", Buffer.from('{"type":"text","text":"split-secret-'));
  child.stdout.emit("data", Buffer.from('value"}\n' + "x".repeat(1000) + "\n"));
  child.stderr.emit("data", Buffer.from("split-secret-value\n"));
  const events = sink.events.filter((event) => event.type === "event");
  assert.ok(events.length >= 3);
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    assert.ok(String(data.body ?? "").length <= 500);
    assert.doesNotMatch(JSON.stringify(data), /split-secret-value/);
  }
  child.emit("close", 0);
});

test("resolveBinary returns explicitPath when provided (takes precedence over dev mode env var)", () => {
  const previous = process.env[PA_OPENCODE_BINARY_ENV];
  process.env[PA_OPENCODE_BINARY_ENV] = "/env/bin/opencode";
  try {
    assert.equal(
      resolveBinary({ devMode: true, explicitPath: "/explicit/opencode", env: process.env }),
      "/explicit/opencode",
    );
  } finally {
    if (previous === undefined) delete process.env[PA_OPENCODE_BINARY_ENV];
    else process.env[PA_OPENCODE_BINARY_ENV] = previous;
  }
});

test("resolveBinary reads PA_OPENCODE_BINARY env var in dev mode", () => {
  const previous = process.env[PA_OPENCODE_BINARY_ENV];
  process.env[PA_OPENCODE_BINARY_ENV] = "/custom/bin/opencode";
  try {
    assert.equal(
      resolveBinary({ devMode: true, env: process.env }),
      "/custom/bin/opencode",
    );
  } finally {
    if (previous === undefined) delete process.env[PA_OPENCODE_BINARY_ENV];
    else process.env[PA_OPENCODE_BINARY_ENV] = previous;
  }
});

test("resolveBinary falls back to 'opencode' on PATH in dev mode when env var unset", () => {
  const previous = process.env[PA_OPENCODE_BINARY_ENV];
  delete process.env[PA_OPENCODE_BINARY_ENV];
  try {
    assert.equal(resolveBinary({ devMode: true, env: process.env }), "opencode");
  } finally {
    if (previous !== undefined) process.env[PA_OPENCODE_BINARY_ENV] = previous;
  }
});

test("resolveBinary ignores PA_OPENCODE_BINARY env var in production mode (devMode=false) — zero behavior change (FR4)", () => {
  const previous = process.env[PA_OPENCODE_BINARY_ENV];
  process.env[PA_OPENCODE_BINARY_ENV] = "/should/be/ignored/opencode";
  try {
    assert.equal(resolveBinary({ devMode: false, env: process.env }), "opencode");
  } finally {
    if (previous === undefined) delete process.env[PA_OPENCODE_BINARY_ENV];
    else process.env[PA_OPENCODE_BINARY_ENV] = previous;
  }
});

test("resolveBinary treats empty/whitespace PA_OPENCODE_BINARY as unset (falls back to PATH)", () => {
  const previous = process.env[PA_OPENCODE_BINARY_ENV];
  process.env[PA_OPENCODE_BINARY_ENV] = "   ";
  try {
    assert.equal(resolveBinary({ devMode: true, env: process.env }), "opencode");
  } finally {
    if (previous === undefined) delete process.env[PA_OPENCODE_BINARY_ENV];
    else process.env[PA_OPENCODE_BINARY_ENV] = previous;
  }
});

test("SessionManager spawns from binaryPath option when provided (AC1)", () => {
  const { fn, calls } = createFakeSpawn();
  const mgr = new SessionManager({
    spawnFn: fn,
    maxSessions: 3,
    binaryPath: "/explicit/path/to/opencode",
  });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);

  assert.equal(result.ok, true);
  assert.equal(calls[0]?.command, "/explicit/path/to/opencode");
});

test("SessionManager spawns from PA_OPENCODE_BINARY env var in dev mode (FR3/AC1)", () => {
  const previous = process.env[PA_OPENCODE_BINARY_ENV];
  process.env[PA_OPENCODE_BINARY_ENV] = "/dev/bin/opencode";
  try {
    const { fn, calls } = createFakeSpawn();
    const mgr = new SessionManager({
      spawnFn: fn,
      maxSessions: 3,
      devMode: true,
      env: process.env,
    });
    const sink = new CapturingSink();
    const result = mgr.start({ prompt: "Hello" }, sink);

    assert.equal(result.ok, true);
    assert.equal(calls[0]?.command, "/dev/bin/opencode");
  } finally {
    if (previous === undefined) delete process.env[PA_OPENCODE_BINARY_ENV];
    else process.env[PA_OPENCODE_BINARY_ENV] = previous;
  }
});

test("SessionManager falls back to 'opencode' on PATH in dev mode when PA_OPENCODE_BINARY unset (FR3 fallback)", () => {
  const previous = process.env[PA_OPENCODE_BINARY_ENV];
  delete process.env[PA_OPENCODE_BINARY_ENV];
  try {
    const { fn, calls } = createFakeSpawn();
    const mgr = new SessionManager({
      spawnFn: fn,
      maxSessions: 3,
      devMode: true,
      env: process.env,
    });
    const sink = new CapturingSink();
    const result = mgr.start({ prompt: "Hello" }, sink);

    assert.equal(result.ok, true);
    assert.equal(calls[0]?.command, "opencode");
  } finally {
    if (previous !== undefined) process.env[PA_OPENCODE_BINARY_ENV] = previous;
  }
});

test("SessionManager production mode (no devMode, no binaryPath) spawns 'opencode' — identical to current behavior (NFR1/AC6)", () => {
  const previous = process.env[PA_OPENCODE_BINARY_ENV];
  process.env[PA_OPENCODE_BINARY_ENV] = "/should/be/ignored/opencode";
  try {
    const { fn, calls } = createFakeSpawn();
    const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3, env: process.env });
    const sink = new CapturingSink();
    const result = mgr.start({ prompt: "Hello" }, sink);

    assert.equal(result.ok, true);
    assert.equal(calls[0]?.command, "opencode");
  } finally {
    if (previous === undefined) delete process.env[PA_OPENCODE_BINARY_ENV];
    else process.env[PA_OPENCODE_BINARY_ENV] = previous;
  }
});

test("SessionManager ENOENT error includes attempted binary path in async error event (FR5/AC4)", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({
    spawnFn: fn,
    maxSessions: 3,
    binaryPath: "/missing/opencode",
  });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);
  if (!result.ok) throw new Error("expected start to succeed");

  const child = children[0]!;
  const enoent = Object.assign(new Error("spawn /missing/opencode ENOENT"), { code: "ENOENT" });
  child.emit("error", enoent);

  const errorEvent = sink.events.find((e) => e.type === "error");
  assert.ok(errorEvent, "expected an error event");
  assert.ok(errorEvent?.message?.includes("/missing/opencode"), "error message must include the attempted binary path");
  assert.ok(errorEvent?.message?.includes("ENOENT"), "error message must mention ENOENT");
});

test("SessionManager ENOENT on sync spawn throw returns error including attempted binary path (FR5/AC4)", () => {
  const throwFn = ((): import("node:child_process").ChildProcess => {
    throw Object.assign(new Error("spawn /missing/opencode ENOENT"), { code: "ENOENT" });
  }) as unknown as typeof import("node:child_process").spawn;
  const mgr = new SessionManager({
    spawnFn: throwFn,
    maxSessions: 3,
    binaryPath: "/missing/opencode",
  });
  const sink = new CapturingSink();
  const result = mgr.start({ prompt: "Hello" }, sink);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.error.includes("/missing/opencode"), "error must include attempted binary path");
  assert.ok(result.error.includes("ENOENT"), "error must mention ENOENT");
});

test("SessionManager.register creates a session record without spawning a child process (FR1)", () => {
  const { fn, calls } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3, now: () => new Date("2026-08-08T00:00:00.000Z") });
  const result = mgr.register("d-abc123", "ollama-cloud/deepseek-v4-pro");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(calls.length, 0, "register must not spawn a child process");
  assert.match(result.session.id, /^s/);
  assert.equal(result.session.deploymentId, "d-abc123");
  assert.equal(result.session.model, "ollama-cloud/deepseek-v4-pro");
  assert.equal(result.session.status, "running");
  assert.equal(result.session.startedAt, "2026-08-08T00:00:00.000Z");
  assert.equal(mgr.activeCount, 1);
  assert.equal(mgr.get(result.session.id)?.deploymentId, "d-abc123");
});

test("SessionManager.register uses default model when model not provided (FR1)", () => {
  const { fn } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3, defaultModel: "openai/gpt-5.5" });
  const result = mgr.register("d-test456");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.session.model, "openai/gpt-5.5");
});

test("SessionManager.register appears in list alongside WebSocket sessions (FR4/NFR4 combined count)", () => {
  const { fn } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 5 });
  const sink = new CapturingSink();
  mgr.start({ prompt: "ws-prompt" }, sink);
  const regResult = mgr.register("d-deploy789", "minimax/abab-7");

  assert.equal(regResult.ok, true);
  const records = mgr.list();
  assert.equal(records.length, 2);
  const deploySession = records.find((r) => r.deploymentId === "d-deploy789");
  assert.ok(deploySession, "deploy session must appear in list");
  assert.equal(deploySession?.model, "minimax/abab-7");
  assert.equal(deploySession?.status, "running");
});

test("SessionManager.register respects maxSessions limit (FR1/NFR4)", () => {
  const { fn } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 2 });
  const first = mgr.register("d-1");
  const second = mgr.register("d-2");
  const third = mgr.register("d-3");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.equal(third.error, "Max sessions reached");
  assert.equal(third.limit, 2);
  assert.equal(mgr.atCapacity(), true);
});

test("SessionManager.register combined with WebSocket sessions respects shared maxSessions limit (NFR4)", () => {
  const { fn } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 2 });
  const sink = new CapturingSink();
  const ws1 = mgr.start({ prompt: "ws-1" }, sink);
  const reg1 = mgr.register("d-deploy-1");
  const overflow = mgr.start({ prompt: "ws-2" }, sink);

  assert.equal(ws1.ok, true);
  assert.equal(reg1.ok, true);
  assert.equal(overflow.ok, false, "combined count must hit limit");
  if (overflow.ok) return;
  assert.equal(overflow.limit, 2);
});

test("SessionManager.stop handles registered deploy sessions with null child (FR5)", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const regResult = mgr.register("d-stop-test");
  if (!regResult.ok) throw new Error("expected register to succeed");
  const id = regResult.session.id;

  const stopResult = mgr.stop(id);
  assert.equal(stopResult.ok, true);
  if (!stopResult.ok) return;
  assert.equal(stopResult.status, "stopped");
  assert.equal(children.length, 0, "no child process was spawned");
  assert.equal(mgr.get(id), undefined);
  assert.equal(mgr.activeCount, 0);
});

test("SessionManager.cleanup removes registered deploy sessions (FR7/AC5)", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 5 });
  const sink = new CapturingSink();
  mgr.start({ prompt: "ws-1" }, sink);
  mgr.register("d-cleanup-1");
  mgr.register("d-cleanup-2");

  assert.equal(mgr.activeCount, 3);
  mgr.cleanup();
  assert.equal(mgr.activeCount, 0);
  assert.equal(children.length, 1, "only the WebSocket session had a child process");
  assert.ok(children[0]?.killed, "WebSocket child was terminated");
});

for (const runtime of ["pi", "opencode"] as const) {
  test(`${runtime} default-env manager honors deliberate inherited principals in the isolated fixture`, () => {
    const deploymentId = "d-334abc";
    appendRegistryEvent({ deployment_id: deploymentId, team: "analyst", runtime, event: "started", timestamp: new Date().toISOString() });
    closeDb();
    for (const principal of [
      { PA_TEAM: "analyst", PA_MODE: "implement" },
      { PA_TEAM: "requirements", PA_MODE: "analyze" },
      { PA_TEAM: "builder", PA_MODE: "implement", PA_DEPLOYMENT_ID: deploymentId },
    ]) {
      Object.assign(process.env, principal);
      const { fn, calls } = createFakeSpawn();
      const mgr = new SessionManager({ spawnFn: fn, runtimes: { pi: {} } });
      const sink = new CapturingSink();
      const before = snapshotFiles(sessionRoot);
      assert.throws(() => mgr.assertExecutionAvailable({ prompt: "fixture", runtime }), /REPOSITORY_ISOLATION_UNAVAILABLE/);
      const result = mgr.start({ prompt: "fixture", runtime }, sink);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /REPOSITORY_ISOLATION_UNAVAILABLE/);
      assert.equal(mgr.activeCount, 0);
      assert.deepEqual(calls, []);
      assert.deepEqual(sink.events, []);
      assert.deepEqual(snapshotFiles(sessionRoot), before, "denial must not write lifecycle or registry state");
      delete process.env.PA_TEAM;
      delete process.env.PA_MODE;
      delete process.env.PA_DEPLOYMENT_ID;
    }
  });

  test(`${runtime} central ingress rejects restrictive originals, overlays, merged identity and unknown resumes before allocation`, () => {
    for (const [base, overlay] of [[{ PA_TEAM: "analyst" }, { PA_TEAM: "builder" }], [{ PA_TEAM: "builder" }, { PA_TEAM: "analyst" }], [{ PA_TEAM: "requirements" }, { PA_MODE: "analyze" }]]) {
      const { fn, calls } = createFakeSpawn();
      let commands = 0;
      const mgr = new SessionManager({ env: base, spawnFn: fn, runtimes: { pi: {} }, runtimeCommands: { [runtime]: () => { commands++; throw Error("not admitted"); } } });
      const sink = new CapturingSink();
      assert.throws(() => mgr.assertExecutionAvailable({ prompt: "test", runtime, env: overlay }), /REPOSITORY_ISOLATION_UNAVAILABLE/);
      const result = mgr.start({ prompt: "test", runtime, env: overlay }, sink);
      assert.equal(result.ok, false); if (result.ok) return;
      assert.match(result.error, /REPOSITORY_ISOLATION_UNAVAILABLE/); assert.ok(result.error.length <= 2000);
      assert.equal(mgr.activeCount, 0); assert.equal(calls.length, 0); assert.equal(commands, 0); assert.deepEqual(sink.events, []);
      // Observational registration remains independent of execution admission.
      assert.equal(mgr.register("retained", undefined, runtime).ok, true); mgr.cleanup();
    }
    const { fn, calls } = createFakeSpawn();
    const mgr = new SessionManager({ env: {}, spawnFn: fn, runtimes: { pi: {} } });
    assert.equal(mgr.resume({ prompt: "continue", runtime, sessionId: "unknown-native-session" }, new CapturingSink()).ok, false);
    assert.equal(mgr.activeCount, 0); assert.equal(calls.length, 0);
  });
}

test("Pi same-server launch-bound native origin admits unprotected resume, not caller assertions", () => {
  withSessionEnv(() => {
    const { fn, children, calls } = createFakeSpawn();
    const mgr = new SessionManager({ env: {}, spawnFn: fn, runtimes: { pi: {} } });
    const sink = new CapturingSink();
    const started = mgr.start({ prompt: "original", runtime: "pi", env: { PA_TEAM: "builder", PA_MODE: "implement" } }, sink);
    assert.equal(started.ok, true); if (!started.ok) return;
    children[0]!.emit("close", 0);
    assert.equal(mgr.resume({ prompt: "continue", runtime: "pi", sessionId: started.session.id }, sink).ok, true);
    assert.equal(calls.length, 2);
    mgr.cleanup();
    assert.equal(mgr.resume({ prompt: "continue", runtime: "pi", sessionId: started.session.id, env: { PA_TEAM: "analyst" } }, sink).ok, false);
    assert.equal(calls.length, 2);
  });
});

for (const runtime of ["pi", "opencode"] as const) {
  for (const output of ["id", "sessionID", "regex"] as const) {
    test(`${runtime} stdout ${output} cannot qualify an old protected session for resume`, () => {
      withSessionEnv(root => {
        const sessionId = "old-protected-session", deploymentId = "d-334abc";
        appendRegistryEvent({ deployment_id: deploymentId, team: "analyst", runtime, event: "started", timestamp: new Date().toISOString() });
        const dir = getDeployPaths(deploymentId).deployDir;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `session-id-${runtime}.txt`), sessionId, { mode: 0o600 });
        const { fn, children, calls } = createFakeSpawn();
        const mgr = new SessionManager({ env: {}, spawnFn: fn, runtimes: { pi: {} } });
        const sink = new CapturingSink();
        assert.equal(mgr.start({ prompt: "ordinary fresh session", runtime }, sink).ok, true);
        // Two JSON lines force the observational parser's regex fallback on its
        // concatenated carry. Neither arbitrary top-level ids nor text are authority.
        const text = output === "regex"
          ? JSON.stringify({ text: `session: ${sessionId}` }) + '\n{"text":"tail"}\n'
          : JSON.stringify({ [output]: sessionId }) + "\n";
        children[0]!.stdout.emit("data", Buffer.from(text));
        children[0]!.emit("close", 0);
        assert.ok(sink.events.some(event => event.type === "event"), "output remains observable");
        const before = snapshotFiles(root), rejectedSink = new CapturingSink();
        const opts = { prompt: "continue", runtime, sessionId };
        assert.throws(() => mgr.assertExecutionAvailable(opts), /REPOSITORY_ISOLATION_UNAVAILABLE/);
        const rejected = mgr.resume(opts, rejectedSink);
        assert.equal(rejected.ok, false);
        if (!rejected.ok) assert.match(rejected.error, /^Execution not started: repository-isolation scope is unavailable\./);
        assert.deepEqual(mgr.list(), []);
        assert.equal(calls.length, 1);
        assert.deepEqual(rejectedSink.events, []);
        assert.deepEqual(snapshotFiles(root), before, "rejection must not write lifecycle logs or allocate deployment state");
        const next = mgr.start({ prompt: "ordinary fresh session", runtime }, sink);
        assert.equal(next.ok, true);
        if (next.ok) assert.equal(next.session.id.split("-").at(-1), "2", "rejection must not allocate a session id");
        mgr.cleanup();
      });
    });
  }
}

test("fresh opaque OPA stdout ids without a recorded owner remain explicitly unqualified for resume", () => {
  withSessionEnv(root => {
    const { fn, children, calls } = createFakeSpawn();
    const mgr = new SessionManager({ env: {}, spawnFn: fn });
    const sink = new CapturingSink();
    assert.equal(mgr.start({ prompt: "fresh" }, sink).ok, true);
    children[0]!.stdout.emit("data", Buffer.from('{"sessionID":"opaque-fresh-session"}\n'));
    children[0]!.emit("close", 0);
    const before = snapshotFiles(root);
    const result = mgr.resume({ prompt: "continue", sessionId: "opaque-fresh-session" }, sink);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /REPOSITORY_ISOLATION_UNAVAILABLE/);
    assert.equal(calls.length, 1);
    assert.equal(mgr.activeCount, 0);
    assert.deepEqual(snapshotFiles(root), before);
  });
});

for (const argument of ["matching", "foreign", "missing", "duplicate"] as const) {
  test(`Pi custom command ${argument} session-id argument qualifies only an exact launch-bound token`, () => {
    withSessionEnv(() => {
      const { fn, children, calls } = createFakeSpawn();
      const foreignId = "unrelated-native-session";
      const mgr = new SessionManager({
        env: {}, spawnFn: fn, runtimes: { pi: {} },
        runtimeCommands: { pi: ({ session, sessionId, prompt }) => ({ binary: "pi", args: [
          "--print", "--mode", "json",
          ...(argument === "missing" ? [] : ["--session-id", argument === "foreign" ? foreignId : sessionId ?? session.id]),
          ...(argument === "duplicate" ? ["--session-id", foreignId] : []), prompt,
        ] }) },
      });
      const sink = new CapturingSink();
      const started = mgr.start({ runtime: "pi", prompt: "fresh" }, sink);
      assert.equal(started.ok, true); if (!started.ok) return;
      children[0]!.emit("close", 0);
      assert.equal(mgr.resume({ runtime: "pi", prompt: "continue", sessionId: foreignId }, sink).ok, false);
      assert.equal(mgr.resume({ runtime: "pi", prompt: "continue", sessionId: started.session.id }, sink).ok, argument === "matching");
      assert.equal(calls.length, argument === "matching" ? 2 : 1);
      mgr.cleanup();
    });
  });
}
