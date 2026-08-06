import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SessionManager, type SessionStreamEvent, type SessionStreamSink, type SessionEventNormalizer } from "../agent-api/ws/session-hub.js";
import { createActivityEvent } from "../activity/index.js";

class FakeChild extends EventEmitter {
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

function createFakeSpawn(children: FakeChild[] = []): { fn: typeof import("node:child_process").spawn; children: FakeChild[] } {
  const list = children;
  const fn = ((_command: string, _args: string[], _opts: FakeSpawnOptions): FakeChild => {
    const child = new FakeChild();
    list.push(child);
    return child as unknown as import("node:child_process").ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { fn, children: list };
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

test("SessionManager.resume spawns opencode with --session flag for existing opencode session id", () => {
  const { fn, children } = createFakeSpawn();
  const mgr = new SessionManager({ spawnFn: fn, maxSessions: 3 });
  const sink = new CapturingSink();
  const result = mgr.resume({ prompt: "continue", sessionId: "opencode-token-123" }, sink);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(children.length, 1);
  assert.equal(result.session.status, "running");
  assert.equal(mgr.activeCount, 1);
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