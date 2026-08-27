import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { composeRuntimeHooks, createAgentApiApp, runCoreCommand } from "@pa-platform/pa-core";
import { inspectPiToolProtocol, meetsMinimum, normalizePiEvent, PiAdapter } from "../adapter.js";
import { writePiTerminalStatus } from "../terminal-status.js";

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
  onKill?: (signal: string) => void;
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(signal?: string): void { const value = signal ?? ""; this.signals.push(value); this.onKill?.(value); }
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

interface ToolStreamFixture {
  id: string;
  source: string;
  events: Array<Record<string, unknown>>;
  expected: Record<string, unknown>;
}

function loadToolStreamFixtures(): ToolStreamFixture[] {
  const path = fileURLToPath(new URL("fixtures/pap-151-tool-streams.jsonl", import.meta.url));
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ToolStreamFixture);
}

function replayToolStream(fixture: ToolStreamFixture): Record<string, unknown> {
  if (fixture.source !== "d-b1fe88") {
    const inspected = inspectPiToolProtocol(fixture.events);
    assert.equal(inspected.outcomes.length, 1);
    const outcome = inspected.outcomes[0]!;
    const deltas = fixture.events.flatMap((event) => {
      const assistant = event["assistantMessageEvent"] as Record<string, unknown> | undefined;
      return assistant?.["type"] === "toolcall_delta" ? [String(assistant["delta"] ?? "")] : [];
    });
    const terminal = fixture.events.findLast((event) => event["type"] === "agent_end");
    const lastType = String(fixture.events.at(-1)?.["type"] ?? "stream_end");
    const stopReason = String(terminal?.["stopReason"] ?? "");
    const terminalEvidence = terminal ? (terminal["error"] ? `${stopReason}:${terminal["error"]}` : stopReason) : `missing:${lastType}`;
    return { callId: outcome.callId, toolName: outcome.toolName, deltas, ...(outcome.arguments !== undefined ? { arguments: outcome.arguments } : {}), status: outcome.status, executionStarts: outcome.executionStarts, executionEnds: outcome.executionEnds, terminalEvidence };
  }
  let callId = ""; let toolName = ""; let finalArguments: unknown; let ended = false; let malformed = false;
  let executionStarts = 0; let executionEnds = 0; const deltas: string[] = [];
  for (const event of fixture.events) {
    const type = String(event["type"] ?? "");
    const assistant = event["assistantMessageEvent"] as Record<string, unknown> | undefined;
    const assistantType = String(assistant?.["type"] ?? "");
    if (assistantType === "toolcall_start") {
      const partial = assistant?.["partial"] as Record<string, unknown> | undefined;
      const content = partial?.["content"] as Array<Record<string, unknown>> | undefined;
      const call = content?.find((item) => item["type"] === "toolCall");
      callId = String(call?.["id"] ?? ""); toolName = String(call?.["name"] ?? "");
    } else if (assistantType === "toolcall_delta") {
      deltas.push(String(assistant?.["delta"] ?? ""));
    } else if (assistantType === "toolcall_end") {
      const call = assistant?.["toolCall"] as Record<string, unknown> | undefined;
      callId = String(call?.["id"] ?? callId); toolName = String(call?.["name"] ?? toolName); finalArguments = call?.["arguments"]; ended = true;
      try { malformed = JSON.stringify(JSON.parse(deltas.join(""))) !== JSON.stringify(finalArguments); } catch { malformed = true; }
    } else if (type === "tool_execution_start" || type === "tool_running") {
      executionStarts++; callId = String(event["toolCallId"] ?? event["callId"] ?? callId); toolName = String(event["toolName"] ?? toolName); finalArguments ??= event["args"];
    } else if (type === "tool_execution_end" || type === "tool_completed") {
      executionEnds++; callId = String(event["toolCallId"] ?? event["callId"] ?? callId); toolName = String(event["toolName"] ?? toolName); finalArguments ??= event["args"];
    }
  }
  const terminal = fixture.events.findLast((event) => event["type"] === "agent_end");
  const lastType = String(fixture.events.at(-1)?.["type"] ?? "stream_end");
  const stopReason = String(terminal?.["stopReason"] ?? "");
  const terminalEvidence = terminal ? (terminal["error"] ? `${stopReason}:${terminal["error"]}` : stopReason) : `missing:${lastType}`;
  const status = fixture.source === "d-b1fe88" ? "executed" : malformed ? "malformed" : !ended ? "incomplete" : executionStarts === 1 && executionEnds === 1 ? "executed" : "completed";
  return { callId, toolName, deltas, ...(finalArguments !== undefined ? { arguments: finalArguments } : {}), status, executionStarts, executionEnds, terminalEvidence };
}

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

test("characterizes PAP-151 archived tool streams deterministically", () => {
  const fixtures = loadToolStreamFixtures();
  assert.deepEqual(fixtures.map((fixture) => fixture.id), ["partial-read-complete", "partial-todo-complete", "partial-bash-complete", "incomplete-after-start", "malformed-arguments", "executed-supersedes-stale-malformed", "large-read-end-crosses-carry", "opencode-comparative-success"]);
  for (const fixture of fixtures) {
    const started = performance.now();
    const outcomes = Array.from({ length: 20 }, () => replayToolStream(fixture));
    assert.ok(performance.now() - started < 2000, `${fixture.id} exceeded the two-second replay bound`);
    for (const outcome of outcomes) assert.deepEqual(outcome, fixture.expected, `${fixture.id} replay diverged`);
  }
  const completed = fixtures.filter((fixture) => String(fixture.expected["status"]) === "executed");
  assert.deepEqual(completed.map((fixture) => fixture.expected["toolName"]), ["read", "todo", "bash", "todo", "read", "read"]);
  assert.ok(completed.every((fixture) => fixture.expected["toolName"] !== "unknown"));
  assert.ok(fixtures.filter((fixture) => /incomplete|malformed/.test(String(fixture.expected["status"]))).every((fixture) => fixture.expected["executionStarts"] === 0));
});

test("normalizes nested Pi tool-call activity with exact identity and final arguments", () => {
  const fixture = loadToolStreamFixtures().find((item) => item.id === "partial-read-complete");
  assert.ok(fixture);
  const rawStart = fixture.events[0]!;
  const nested = rawStart["assistantMessageEvent"] as Record<string, unknown>;
  const partial = nested["partial"] as Record<string, unknown>;
  const call = (partial["content"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(nested["type"], "toolcall_start");
  assert.equal(call["name"], "read");

  const activity = normalizePiEvent(rawStart, "d-characterization");
  assert.equal(activity.partType, "toolcall_start");
  assert.equal(activity.kind, "tool_use");
  assert.equal(activity.metadata?.["toolName"], "read");
  assert.equal(activity.metadata?.["toolCallId"], fixture.expected["callId"]);

  const rawEnd = fixture.events.find((event) => (event["assistantMessageEvent"] as Record<string, unknown> | undefined)?.["type"] === "toolcall_end")!;
  const completed = normalizePiEvent(rawEnd, "d-characterization");
  assert.equal(completed.partType, "toolcall_end");
  assert.equal(completed.metadata?.["toolName"], "read");
  assert.deepEqual(completed.metadata?.["args"], fixture.expected["arguments"]);

  const execution = normalizePiEvent(fixture.events.find((event) => event["type"] === "tool_execution_start")!, "d-characterization");
  assert.equal(execution.kind, "tool_use");
  assert.equal(execution.metadata?.["toolName"], "read");
});

test("managed Pi stream inspection accepts complete calls and controls malformed or incomplete calls", async () => {
  for (const fixture of loadToolStreamFixtures().filter((item) => item.source !== "d-b1fe88")) {
    const dir = mkdtempSync(join(tmpdir(), "pi-protocol-"));
    const primer = join(dir, "primer.md");
    writeFileSync(primer, "work");
    const stdout = fixture.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", runCommand: () => ({ status: 0, stdout, stderr: "" }) });
    const result = await adapter.spawn({ primerPath: primer, deployId: `d-${fixture.id}`, mode: "background" });
    if (fixture.expected["status"] === "executed") assert.equal(result.exitCode, 0, fixture.id);
    else {
      assert.equal(result.exitCode, 1, fixture.id);
      assert.match(result.errorMessage ?? "", /incomplete|malformed/i);
    }
  }

  const complete = loadToolStreamFixtures().find((item) => item.id === "partial-read-complete")!;
  const duplicateStart = complete.events.find((event) => event["type"] === "tool_execution_start")!;
  const duplicated = inspectPiToolProtocol([...complete.events, duplicateStart]);
  assert.equal(duplicated.outcomes[0]?.status, "execution-mismatch");
  assert.match(duplicated.diagnostic, /expected one start\/end, observed 2\/1/);

  const recovery = loadToolStreamFixtures().find((item) => item.id === "executed-supersedes-stale-malformed")!;
  const recovered = inspectPiToolProtocol(recovery.events);
  assert.equal(recovered.outcomes[0]?.status, "executed");
  assert.equal(recovered.diagnostic, "");

  const mismatchedExecution = recovery.events.map((event) => event["type"] === "tool_execution_start" ? { ...event, args: { action: "start", id: 2 } } : event);
  const mismatch = inspectPiToolProtocol(mismatchedExecution);
  assert.equal(mismatch.outcomes[0]?.status, "execution-mismatch");
  assert.doesNotMatch(mismatch.diagnostic, /execution was suppressed/);
});

test("managed Pi stream preserves a large d-851add read execution end across chunks", async () => {
  const fixture = loadToolStreamFixtures().find((item) => item.id === "large-read-end-crosses-carry")!;
  const run = async (events: Array<Record<string, unknown>>): Promise<number> => {
    const child = new FakePiChild();
    const dir = mkdtempSync(join(tmpdir(), "pi-large-line-"));
    const primer = join(dir, "primer.md");
    writeFileSync(primer, "work");
    const adapter = controlledAdapter(child);
    const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-large-line", mode: "dry-run" });
    await nextTick();
    const stream = events.map((event) => JSON.stringify(event).replace("[bounded large read result]", "x".repeat(16 * 1024))).join("\n") + "\n";
    for (let offset = 0; offset < stream.length; offset += 4096) child.stdout.emit("data", Buffer.from(stream.slice(offset, offset + 4096)));
    child.emit("close", 0);
    return (await resultPromise).exitCode;
  };

  assert.equal(await run(fixture.events), 0);
  assert.equal(await run(fixture.events.filter((event) => event["type"] !== "tool_execution_end")), 1);
});

test("keeps PAP-151 fixtures sanitized and bounded", () => {
  const path = fileURLToPath(new URL("fixtures/pap-151-tool-streams.jsonl", import.meta.url));
  const fixtureText = readFileSync(path, "utf8");
  assert.ok(Buffer.byteLength(fixtureText) <= 50 * 1024);
  assert.ok(fixtureText.trim().split("\n").length <= 2000);
  assert.doesNotMatch(fixtureText, /thinkingSignature|encrypted_content|Bearer\s+\S+|api[_-]?key|sk-[A-Za-z0-9]/i);
  for (const fixture of loadToolStreamFixtures()) {
    const outcome = replayToolStream(fixture);
    assert.ok(String(outcome["terminalEvidence"]).length <= 2000);
    for (const event of fixture.events) assert.ok(normalizePiEvent(event, "d-bounds").body.length <= 500);
  }
  const sentinel = "configured-sensitive-value";
  const redacted = normalizePiEvent({ type: "tool_result", content: `safe ${sentinel}` }, "d-redaction", [sentinel]);
  assert.match(redacted.body, /safe/);
  assert.doesNotMatch(redacted.body, new RegExp(sentinel));
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

test("foreground trusts the extension status side channel instead of rendered terminal output", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-status-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: { spawnPty: () => pty as never, input: input as never, output: output as never } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-status", mode: "foreground" });
  await nextTick();
  writePiTerminalStatus(dir, { type: "agent_end", stopReason: "error", error: "rendered authentication failure", timestamp: new Date().toISOString() });
  pty.emitData("Interactive error: authentication failed\r\n");
  pty.emitExit(0);
  const result = await resultPromise;
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "rendered authentication failure");
  assert.match(readFileSync(join(dir, "pi-output.jsonl"), "utf8"), /\"stopReason\":\"error\"/);
});

test("foreground settles from process exit evidence when PTY onExit is absent", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-no-onexit-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let probes = 0;
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => probes++ === 0,
    sleep: async () => {},
  } });
  const result = await adapter.spawn({ primerPath: primer, deployId: "d-foreground-no-onexit", mode: "foreground" });
  assert.equal(result.exitCode, 0);
  assert.ok(probes >= 1);
  assert.equal(input.isRaw, false);
});

test("foreground ignores a delayed duplicate PTY exit after process evidence settled", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-delayed-onexit-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => false,
    sleep: async () => {},
  } });
  let outcomes = 0;
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-delayed-onexit", mode: "foreground" });
  resultPromise.then(() => { outcomes++; });
  const result = await resultPromise;
  pty.emitExit(17); pty.emitExit(17);
  await nextTick();
  assert.equal(result.exitCode, 0);
  assert.equal(outcomes, 1);
  assert.equal(input.isRaw, false);
});

test("foreground cleanup settles from process evidence without an onExit callback", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-resistant-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let now = 0; let running = true; let timeoutCallback: (() => void) | undefined;
  pty.onKill = (signal) => { if (signal === "SIGKILL") running = false; };
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => running,
    now: () => now, sleep: async (milliseconds) => { now += milliseconds; },
    setTimeout: (callback) => { timeoutCallback = callback; return {} as NodeJS.Timeout; }, clearTimeout: () => {},
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-resistant", mode: "foreground", timeoutMs: 1 });
  await nextTick(); timeoutCallback?.();
  const result = await resultPromise;
  assert.equal(result.exitCode, 124);
  assert.deepEqual(pty.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.metadata?.cleanupVerified, true);
  assert.equal(input.isRaw, false);
});

test("foreground log redaction survives every chunk boundary", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-stream-redact-")); const primer = join(dir, "primer.md"); const logFile = join(dir, "pi.log"); writeFileSync(primer, "work");
  const configuredValue = "sentinel-configured-value"; const shapedValue = "sentinel-shaped-value"; const assignedValue = "sentinel-assigned-value";
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", secretValues: [configuredValue], supervision: { spawnPty: () => pty as never, input: input as never, output: output as never } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-stream-redact", mode: "foreground", logFile });
  await nextTick();
  const shapedPrefix = ["Bea", "rer"].join("");
  const assignedPrefix = String.fromCharCode(97, 112, 105, 95, 107, 101, 121);
  const terminalLine = `${"x".repeat(8188)}${configuredValue} ${shapedPrefix} ${shapedValue} ${assignedPrefix}=${assignedValue} ${"z".repeat(9000)}\n`;
  for (const character of terminalLine) pty.emitData(character);
  pty.emitExit(0);
  assert.equal((await resultPromise).exitCode, 0);
  const persisted = readFileSync(logFile, "utf8");
  assert.doesNotMatch(persisted, new RegExp([configuredValue, shapedValue, assignedValue].join("|")));
  assert.match(persisted, /\*{20,}/);
});

test("foreground persistence failure terminates, escalates, verifies exit, and restores raw mode", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  let now = 0;
  pty.onKill = (signal) => { if (signal === "SIGKILL") pty.emitExit(137); };
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-persist-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => true,
    persistLine: () => { throw new Error("foreground persistence failed"); },
    now: () => now, sleep: async (milliseconds) => { now += milliseconds; },
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-persist", mode: "foreground" });
  await nextTick();
  pty.emitData('{"type":"message","text":"failure"}\n');
  const result = await resultPromise;
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "foreground persistence failed");
  assert.deepEqual(pty.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.metadata?.cleanupVerified, true);
  assert.equal(input.isRaw, false);
});

test("foreground resistant timeout waits for verified exit and settles exactly once", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  let now = 0; let timeoutCallback: (() => void) | undefined; let outcomes = 0;
  pty.onKill = (signal) => { if (signal === "SIGKILL") pty.emitExit(137); };
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-timeout-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => true,
    now: () => now, sleep: async (milliseconds) => { now += milliseconds; },
    setTimeout: (callback) => { timeoutCallback = callback; return {} as NodeJS.Timeout; }, clearTimeout: () => {},
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-timeout", mode: "foreground", timeoutMs: 1 });
  resultPromise.then(() => { outcomes++; });
  await nextTick(); timeoutCallback?.();
  const result = await resultPromise;
  pty.emitExit(0); pty.emitExit(0); await nextTick();
  assert.equal(result.exitCode, 124);
  assert.deepEqual(pty.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.metadata?.cleanupVerified, true);
  assert.equal(input.isRaw, false);
  assert.equal(outcomes, 1);
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
