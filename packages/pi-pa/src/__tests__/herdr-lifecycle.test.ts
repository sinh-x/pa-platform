import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createHerdrReporter, herdrRequest, herdrSessionParams, herdrStateParams, HERDR_REQUEST_LIMIT_BYTES,
  registerHerdrLifecycleModule, resolveHerdrBinding, type HerdrSocket,
} from "../pi-extension/herdr-lifecycle.js";
import type { PiExtensionModule, PiRuntime } from "../pi-extension/index.js";

const socketFixture = async (run: (socketPath: string, root: string) => Promise<void> | void) => {
  const root = mkdtempSync(join(tmpdir(), "herdr-lifecycle-")), socketPath = join(root, "herdr.sock");
  const server: Server = createServer(socket => socket.destroy());
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    await run(socketPath, root);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
};

const selection = (socketPath: string): NodeJS.ProcessEnv => ({ PA_HERDR_LIFECYCLE: "1", HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p2Z" });

test("selection requires explicit opt-in, a complete binding, an exact same-user socket path", async () => socketFixture(async (socketPath, root) => {
  assert.deepEqual(resolveHerdrBinding(selection(socketPath)), { socketPath, paneId: "w1:p2Z" });
  assert.equal(resolveHerdrBinding({ ...selection(socketPath), PA_HERDR_LIFECYCLE: "0" }), undefined);
  assert.equal(resolveHerdrBinding({ ...selection(socketPath), HERDR_ENV: "0" }), undefined);
  assert.equal(resolveHerdrBinding({ ...selection(socketPath), HERDR_SOCKET_PATH: "relative.sock" }), undefined);
  assert.equal(resolveHerdrBinding({ ...selection(socketPath), HERDR_PANE_ID: "../shell" }), undefined);
  assert.equal(resolveHerdrBinding(selection(join(root, "missing.sock"))), undefined);
  const file = join(root, "ordinary.txt"); writeFileSync(file, "inert");
  assert.equal(resolveHerdrBinding(selection(file)), undefined, "not a socket");
  const alias = join(root, "alias.sock"); symlinkSync(socketPath, alias);
  assert.equal(resolveHerdrBinding(selection(alias)), undefined, "aliased spelling");
  assert.equal(resolveHerdrBinding(selection(socketPath), 424242), undefined, "foreign socket owner");
}));

test("payloads are fixed, bounded and drop unprintable text instead of reshaping it", () => {
  const binding = { socketPath: "/run/inert/herdr.sock", paneId: "w1:p2Z" };
  const session = herdrSessionParams(binding, { sessionId: "s-inert", sessionPath: "/tmp/session.jsonl", reason: "startup" }, 7);
  assert.deepEqual(session, { pane_id: "w1:p2Z", source: "herdr:pi", agent: "pi", seq: 7, session_start_source: "startup", agent_session_path: "/tmp/session.jsonl" });
  assert.deepEqual(herdrSessionParams(binding, { sessionId: "s-inert" }, 7)["agent_session_id"], "s-inert", "the session id is used only when no path is available");
  assert.deepEqual(herdrStateParams(binding, "working", 8, undefined, { sessionId: "s-inert" }),
    { pane_id: "w1:p2Z", source: "herdr:pi", agent: "pi", state: "working", seq: 8, agent_session_id: "s-inert" });
  assert.deepEqual(herdrStateParams(binding, "blocked", 9, "line one\nline two"), { pane_id: "w1:p2Z", source: "herdr:pi", agent: "pi", state: "blocked", seq: 9, message: "line one line two" });
  assert.equal(herdrSessionParams(binding, { sessionId: "bad\nid" }, 1)["agent_session_id"], undefined);
  assert.equal(herdrSessionParams(binding, { sessionId: "x".repeat(1025) }, 1)["agent_session_id"], undefined);
  const request = JSON.parse(herdrRequest("pane.report_agent", herdrStateParams(binding, "idle", 3))) as Record<string, unknown>;
  assert.equal(request["method"], "pane.report_agent");
  assert.match(String(request["id"]), /^herdr:pi:\d+:[0-9a-f-]{36}$/);
  assert.throws(() => herdrRequest("pane.report_agent", { pane_id: "w1:p2Z", message: "x".repeat(HERDR_REQUEST_LIMIT_BYTES) }), /bounded size/);
});

test("reporter sends one bounded request per payload, keeps only the latest state and never throws", async () => {
  const binding = { socketPath: "/run/inert/herdr.sock", paneId: "w1:p2Z" };
  const sent: string[] = []; let opened = 0; let destroyed = 0;
  const fake = (): HerdrSocket => {
    opened++;
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    return {
      on: (event, listener) => { (listeners[event] ??= []).push(listener); if (event === "connect") queueMicrotask(() => listener()); return undefined; },
      write: value => { sent.push(value); listeners["data"]?.forEach(listener => listener()); return true; },
      destroy: () => { destroyed++; },
    };
  };
  const reporter = createHerdrReporter(binding, { open: fake, timeoutMs: 100 });
  reporter.state("working"); reporter.state("blocked", "approval"); reporter.state("idle");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(opened, 2, "the in-flight state and the latest replacement each use one connection");
  assert.equal(destroyed, 2);
  const states = sent.map(payload => (JSON.parse(payload) as { params: { state: string } }).params.state);
  assert.deepEqual(states, ["working", "idle"], "the superseded blocked state is never reported after idle");
  reporter.session({ sessionId: "s-inert" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.parse(sent.at(-1)!).method, "pane.report_agent_session");
  const failing = createHerdrReporter(binding, { open: () => { throw new Error("inert socket failure"); } });
  assert.doesNotThrow(() => failing.state("working"));
  const silent = createHerdrReporter(binding, { open: () => { throw new Error("inert socket failure"); } });
  assert.doesNotThrow(() => silent.session({ sessionId: "s-inert" }));
  reporter.close(); reporter.state("working");
  const closedCount = opened;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(opened, closedCount, "closed reporter accepts no further work");
});

test("module registers only with a validated binding and reports lifecycle without prompt authority", async () => socketFixture(async socketPath => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const runtime = { on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); } } as unknown as PiRuntime;
  const old = { ...process.env };
  try {
    process.env.PA_HERDR_LIFECYCLE = "0"; process.env.HERDR_ENV = "1"; process.env.HERDR_SOCKET_PATH = socketPath; process.env.HERDR_PANE_ID = "w1:p2Z";
    (registerHerdrLifecycleModule as PiExtensionModule)(runtime, undefined);
    assert.equal(handlers.size, 0, "no registration without explicit selection");
    process.env.PA_HERDR_LIFECYCLE = "1";
    (registerHerdrLifecycleModule as PiExtensionModule)(runtime, undefined);
    assert.deepEqual([...handlers.keys()].sort(), ["agent_settled", "agent_start", "session_start"]);
    const context = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "s-inert", getSessionFile: () => "/tmp/session.jsonl" } };
    handlers.get("session_start")?.({ reason: "startup" }, context);
    handlers.get("agent_start")?.({}, context);
    handlers.get("agent_settled")?.({}, context);
    assert.equal(handlers.has("tool_call"), false, "no tool or prompt surface is registered");
  } finally { process.env = old; }
}));
