import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { composeRuntimeHooks, createAgentApiApp, runCoreCommand } from "@pa-platform/pa-core";
import { buildPiBackgroundArgs, inspectPiToolProtocol, meetsMinimum, normalizePiEvent, PiAdapter, projectPiActivity, readPiBackgroundConfig, writePiSupervisorOwnership } from "../adapter.js";
import { writePiTerminalStatus } from "../terminal-status.js";

class FakePiChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 42;
  unref(): void {}
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

class FakePiInput extends Readable {
  readonly isTTY = true;
  isRaw: boolean;
  pauseCalls = 0;
  constructor(isRaw = false) { super(); this.isRaw = isRaw; }
  _read(): void {}
  override pause(): this { this.pauseCalls += 1; return super.pause(); }
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

test("canonical activity collapses lifecycle and duplicate events without unidentified rows", () => {
  const fixture = loadToolStreamFixtures().find((item) => item.id === "partial-read-complete")!;
  const execution = fixture.events.filter((event) => String(event["type"] ?? "").startsWith("tool_execution_"));
  const sentinel = "canonical-sensitive-sentinel";
  const events = [...fixture.events, ...execution, { type: "tool_execution_start", toolName: "bash", args: { token: sentinel } }, { type: "tool_execution_end", toolName: "bash", result: "missing id" }];
  const activity = projectPiActivity(events, "d-canonical", [sentinel]);
  const uses = activity.filter((event) => event.kind === "tool_use");
  const results = activity.filter((event) => event.kind === "tool_result");
  assert.deepEqual(uses.map((event) => event.metadata?.["toolCallId"]), [fixture.expected["callId"]]);
  assert.deepEqual(results.map((event) => event.metadata?.["toolCallId"]), [fixture.expected["callId"]]);
  assert.equal(activity.some((event) => event.partType === "toolcall_delta"), false);
  assert.equal(activity.filter((event) => event.kind === "error" && /missing a call id/.test(event.body)).length, 2);
  assert.ok(activity.every((event) => event.body.length <= 500));
  assert.doesNotMatch(JSON.stringify(activity), new RegExp(sentinel));
});

test("split malformed oversized raw protocol stays causal, bounded, retained, and redacted", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-malformed-activity-"));
  const deployId = "d-malformed-activity";
  const dir = join(root, "deployments", deployId);
  const primer = join(dir, "primer.md");
  const sentinel = "malformed-activity-sensitive-sentinel";
  const previousHome = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_AI_USAGE_HOME"] = root;
  mkdirSync(dir, { recursive: true }); writeFileSync(primer, "work");
  try {
    const child = new FakePiChild();
    const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", secretValues: [sentinel], supervision: { spawnProcess: (() => child as never) as typeof spawn } });
    const resultPromise = adapter.spawn({ primerPath: primer, deployId, mode: "dry-run" });
    await nextTick();
    const malformed = `{\"type\":\"tool_execution_start\",\"toolName\":\"read\",\"args\":\"${"x".repeat(2_000)}${sentinel}\"\n`;
    child.stdout.emit("data", Buffer.from(malformed.slice(0, 900)));
    child.stdout.emit("data", Buffer.from(malformed.slice(900)));
    child.emit("close", 0);
    assert.equal((await resultPromise).exitCode, 0);
    const raw = readFileSync(join(dir, "pi-output.jsonl"), "utf8");
    const persistedActivity = readFileSync(join(dir, "activity.jsonl"), "utf8");
    const activity = adapter.extractActivity(dir);
    assert.match(raw, /tool_execution_start/);
    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.kind, "error");
    assert.match(activity[0]?.body ?? "", /^malformed-protocol:/);
    assert.ok((activity[0]?.body.length ?? Infinity) <= 500);
    for (const persisted of [raw, persistedActivity, JSON.stringify(activity)]) assert.doesNotMatch(persisted, new RegExp(sentinel));
  } finally {
    if (previousHome === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousHome;
  }
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
  assert.equal(activity.metadata?.["tool"], "read");
  assert.equal(activity.metadata?.["toolName"], "read");
  assert.equal(activity.metadata?.["toolCallId"], fixture.expected["callId"]);

  const rawEnd = fixture.events.find((event) => (event["assistantMessageEvent"] as Record<string, unknown> | undefined)?.["type"] === "toolcall_end")!;
  const completed = normalizePiEvent(rawEnd, "d-characterization");
  assert.equal(completed.partType, "toolcall_end");
  assert.equal(completed.metadata?.["tool"], "read");
  assert.equal(completed.metadata?.["toolName"], "read");
  assert.deepEqual(completed.metadata?.["args"], fixture.expected["arguments"]);

  const execution = normalizePiEvent(fixture.events.find((event) => event["type"] === "tool_execution_start")!, "d-characterization");
  assert.equal(execution.kind, "tool_use");
  assert.equal(execution.metadata?.["tool"], "read");
  assert.equal(execution.metadata?.["toolName"], "read");
});

test("persists sanitized streamed Pi output without reasoning signatures", async () => {
  const fixture = loadToolStreamFixtures().find((item) => item.id === "partial-read-complete")!;
  const root = mkdtempSync(join(tmpdir(), "pi-signature-"));
  const deployId = "d-signature";
  const deployDir = join(root, "deployments", deployId);
  const primer = join(deployDir, "primer.md");
  const signature = "archived-reasoning-envelope-value";
  const encrypted = "representative-encrypted-reasoning-value";
  const configured = "configured-sensitive-value";
  const logFile = join(deployDir, "pi.log");
  const previousHome = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_AI_USAGE_HOME"] = root;
  mkdirSync(deployDir, { recursive: true });
  writeFileSync(primer, "work");
  try {
    const child = new FakePiChild();
    const adapter = new PiAdapter({ cwd: deployDir, versionProbe: () => "0.80.8", secretValues: [configured], supervision: { spawnProcess: (() => child as never) as typeof spawn } });
    const resultPromise = adapter.spawn({ primerPath: primer, deployId, mode: "dry-run", logFile });
    await nextTick();
    const events = fixture.events.map((event, index) => index === 0 ? { ...event, safeReasoning: "bounded useful reasoning", archivedSignature: signature, thinkingSignature: { signature, encrypted_content: encrypted }, repeatedPayload: encrypted, diagnostic: configured } : event);
    child.stdout.emit("data", Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n"));
    child.stderr.emit("data", Buffer.from(`useful stderr diagnostic ${configured}\n`));
    child.emit("close", 0);
    assert.equal((await resultPromise).exitCode, 0);

    const output = readFileSync(join(deployDir, "pi-output.jsonl"), "utf8");
    const activity = readFileSync(join(deployDir, "activity.jsonl"), "utf8");
    const log = readFileSync(logFile, "utf8");
    for (const persisted of [output, activity, log]) {
      assert.doesNotMatch(persisted, /thinkingSignature|encrypted_content/i);
      assert.doesNotMatch(persisted, new RegExp([signature, encrypted, configured].join("|")));
    }
    assert.match(output, /bounded useful reasoning/);
    assert.match(log, /useful stderr diagnostic/);
    const knownTools = activity.trim().split("\n").map((line) => JSON.parse(line) as { metadata?: Record<string, unknown> }).map((event) => event.metadata?.["tool"]).filter(Boolean);
    assert.ok(knownTools.length > 0);
    assert.ok(knownTools.every((tool) => tool === "read"));
  } finally {
    if (previousHome === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousHome;
  }
});

test("captured Pi logs fail safe on malformed reasoning metadata and preserve diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-captured-redact-"));
  const primer = join(dir, "primer.md");
  const logFile = join(dir, "pi.log");
  const configured = "configured-captured-sensitive-value";
  const encrypted = "captured-encrypted-reasoning-value";
  writeFileSync(primer, "work");
  const stdout = [
    JSON.stringify({ type: "message", text: "useful JSON diagnostic", nested: { thinking_signature: { encryptedContent: encrypted } }, repeatedPayload: encrypted }),
    `useful malformed diagnostic {"thinkingSignature":{"encrypted_content":"${encrypted}"`,
    JSON.stringify({ type: "agent_end", stopReason: "stop", message: "completed" }),
  ].join("\n") + "\n";
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", secretValues: [configured], runCommand: () => ({ status: 0, stdout, stderr: `useful stderr ${configured}\n` }) });
  const result = await adapter.spawn({ primerPath: primer, deployId: "d-captured-redact", mode: "background", logFile });
  assert.equal(result.exitCode, 0);
  for (const persisted of [readFileSync(logFile, "utf8"), readFileSync(join(dir, "pi-output.jsonl"), "utf8")]) {
    assert.match(persisted, /useful JSON diagnostic|useful malformed diagnostic/);
    assert.doesNotMatch(persisted, /thinking[_-]?signature|encrypted[_-]?content/i);
    assert.doesNotMatch(persisted, new RegExp([configured, encrypted].join("|")));
  }
  assert.match(readFileSync(logFile, "utf8"), /useful stderr/);
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

test("foreground stdin flow owned by PPA is paused and raw state is restored on success, failure, and cleanup settlement", async () => {
  for (const item of [
    { name: "success", initialRaw: false, expectedExitCode: 0 },
    { name: "failure", initialRaw: true, expectedExitCode: 17 },
    { name: "cleanup", initialRaw: false, expectedExitCode: 0 },
  ] as const) {
    const pty = new FakePiPty(); const input = new FakePiInput(item.initialRaw); const output = new FakePiOutput();
    const dir = mkdtempSync(join(tmpdir(), `pi-foreground-stdin-${item.name}-`)); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
    let running = true;
    pty.onKill = (signal) => {
      if (item.name === "cleanup" && signal === "SIGTERM") {
        running = false;
        queueMicrotask(() => pty.emitExit(0));
      }
    };
    const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", nativeRegistryProbe: () => undefined, supervision: {
      spawnPty: () => pty as never, input: input as never, output: output as never,
      processExists: () => running,
    } });
    const resultPromise = adapter.spawn({ primerPath: primer, deployId: `d-foreground-stdin-${item.name}`, mode: "foreground" });
    await nextTick();
    assert.equal(input.readableFlowing, true, `${item.name}: PPA data listener did not initiate stdin flow`);
    assert.equal(input.listenerCount("data"), 1, `${item.name}: expected one PPA stdin listener`);
    assert.equal(input.isRaw, true, `${item.name}: foreground raw mode was not enabled`);

    if (item.name === "cleanup") input.emit("end");
    else { running = false; pty.emitExit(item.expectedExitCode); }

    const result = await resultPromise;
    assert.equal(result.exitCode, item.expectedExitCode, item.name);
    assert.equal(input.readableFlowing, false, `${item.name}: PPA-owned stdin flow remained active`);
    assert.equal(input.pauseCalls, 1, `${item.name}: PPA-owned stdin flow was not paused exactly once`);
    assert.equal(input.listenerCount("data"), 0, `${item.name}: PPA stdin listener remained attached`);
    assert.equal(input.isRaw, item.initialRaw, `${item.name}: prior raw mode was not restored`);
  }
});

test("foreground stdin cleanup preserves caller-owned flow and raw mode", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(true); const output = new FakePiOutput();
  const callerListener = (): void => {};
  input.on("data", callerListener);
  assert.equal(input.readableFlowing, true);
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-caller-stdin-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", nativeRegistryProbe: () => undefined, supervision: { spawnPty: () => pty as never, input: input as never, output: output as never } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-caller-stdin", mode: "foreground" });
  await nextTick();
  assert.equal(input.listenerCount("data"), 2);
  pty.emitExit(0);
  assert.equal((await resultPromise).exitCode, 0);
  assert.equal(input.listenerCount("data"), 1);
  assert.equal(input.readableFlowing, true);
  assert.equal(input.pauseCalls, 0);
  assert.equal(input.isRaw, true);
  input.off("data", callerListener);
  input.pause();
});

test("foreground stdin cleanup preserves a caller-paused flow state", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(true); const output = new FakePiOutput();
  input.pause();
  const pauseCallsBefore = input.pauseCalls;
  assert.equal(input.readableFlowing, false);
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-paused-stdin-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", nativeRegistryProbe: () => undefined, supervision: { spawnPty: () => pty as never, input: input as never, output: output as never } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-paused-stdin", mode: "foreground" });
  await nextTick();
  assert.equal(input.readableFlowing, false);
  assert.equal(input.listenerCount("data"), 1);
  pty.emitExit(0);
  assert.equal((await resultPromise).exitCode, 0);
  assert.equal(input.readableFlowing, false);
  assert.equal(input.pauseCalls, pauseCallsBefore);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.isRaw, true);
});

test("foreground error agent_end remains turn evidence until a fatal PTY exit", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-status-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let running = true; let settled = false;
  pty.onKill = (signal) => { if (signal === "SIGTERM" || signal === "SIGKILL") running = false; };
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never, processExists: () => running,
    sleep: async () => { await nextTick(); },
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-status", mode: "foreground" });
  resultPromise.then(() => { settled = true; });
  await nextTick();
  try {
    writePiTerminalStatus(dir, { type: "agent_end", stopReason: "error", error: "turn authentication failure", timestamp: new Date().toISOString() });
    pty.emitData("Interactive error: authentication failed\r\n");
    await nextTick();
    await nextTick();
    input.emit("data", Buffer.from("recover with another turn\n"));
    assert.equal(settled, false);
    assert.deepEqual(pty.signals, []);
    assert.deepEqual(pty.writes, ["recover with another turn\n"]);
  } finally {
    running = false;
    pty.emitExit(17);
  }
  const result = await resultPromise;
  assert.equal(result.exitCode, 17);
  assert.match(result.errorMessage ?? "", /Pi exited with code 17/);
  assert.ok((result.errorMessage?.length ?? Infinity) <= 2_000);
  assert.equal(input.isRaw, false);
});

test("foreground accepts a newer success marker when PTY onExit is absent", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-marker-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let now = 0; let sleeps = 0;
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => false,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
      if (sleeps++ === 0) writePiTerminalStatus(dir, { type: "agent_end", stopReason: "stop", timestamp: "2026-08-29T01:00:00.000Z" });
    },
  } });
  const result = await adapter.spawn({ primerPath: primer, deployId: "d-foreground-marker", mode: "foreground" });
  assert.equal(result.exitCode, 0);
  assert.ok(now < 5_000);
  assert.equal(input.isRaw, false);
});

test("foreground retains a delayed nonzero PTY exit after process disappearance", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-delayed-onexit-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let now = 0; let sleeps = 0;
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => false,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; if (++sleeps === 2) pty.emitExit(17); },
  } });
  const result = await adapter.spawn({ primerPath: primer, deployId: "d-foreground-delayed-onexit", mode: "foreground" });
  assert.equal(result.exitCode, 17);
  assert.match(result.errorMessage ?? "", /Pi exited with code 17/);
  assert.ok(now < 5_000);
  assert.equal(input.isRaw, false);
});

test("foreground fails causally when process exit has no authoritative status", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-unknown-exit-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let now = 0;
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => false,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  } });
  const result = await adapter.spawn({ primerPath: primer, deployId: "d-foreground-unknown-exit", mode: "foreground" });
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage ?? "", /^process-exit-status-unavailable:/);
  assert.ok(now < 5_000);
  assert.equal(input.isRaw, false);
});

test("fresh foreground launch removes a stale marker and does not settle while the child is alive", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-stale-marker-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  writePiTerminalStatus(dir, { type: "agent_end", stopReason: "stop", timestamp: "2026-08-28T01:00:00.000Z" });
  let running = true; let settled = false;
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => running,
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-stale-marker", mode: "foreground" });
  resultPromise.then(() => { settled = true; });
  await nextTick();
  assert.equal(existsSync(join(dir, "pi-terminal-status.json")), false);
  assert.equal(settled, false);
  running = false;
  pty.emitExit(0);
  assert.equal((await resultPromise).exitCode, 0);
});

test("foreground treats three agent_end markers as turn evidence and keeps the same PTY writable", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-turns-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let now = 0; let running = true; let settled = false;
  pty.onKill = (signal) => { if (signal === "SIGKILL") running = false; };
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => running,
    now: () => now, sleep: async (milliseconds) => { now += milliseconds; },
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-turns", mode: "foreground", sessionId: "one-live-session" });
  resultPromise.then(() => { settled = true; });
  await nextTick();

  for (let turn = 1; turn <= 3; turn += 1) {
    writePiTerminalStatus(dir, { type: "agent_end", stopReason: "stop", timestamp: `2026-08-30T00:00:0${turn}.000Z` });
    await nextTick();
    await nextTick();
    input.emit("data", Buffer.from(`next turn ${turn}\n`));
    assert.equal(settled, false, `agent_end turn ${turn} settled the live foreground session`);
    assert.deepEqual(pty.signals, [], `agent_end turn ${turn} requested PTY cleanup`);
    assert.deepEqual(pty.writes, Array.from({ length: turn }, (_, index) => `next turn ${index + 1}\n`));
    assert.equal(input.isRaw, true);
  }

  running = false;
  pty.emitExit(0);
  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "one-live-session");
  assert.equal(input.isRaw, false);
});

test("foreground /quit remains graceful before bounded cleanup settles without onExit", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-quit-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let running = true; let gracefulExitCallback: (() => void) | undefined;
  const resizeListeners = process.stdout.listenerCount("resize");
  const sigintListeners = process.listenerCount("SIGINT");
  pty.onKill = (signal) => { if (signal === "SIGTERM") running = false; };
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => running, sleep: async () => {},
    setTimeout: (callback) => { gracefulExitCallback = callback; return {} as NodeJS.Timeout; }, clearTimeout: () => {},
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-quit", mode: "foreground" });
  await nextTick();
  input.emit("data", Buffer.from("/qu"));
  input.emit("data", Buffer.from("it"));
  assert.equal(gracefulExitCallback, undefined);
  input.emit("data", Buffer.from("\n"));
  assert.deepEqual(pty.writes, ["/qu", "it", "\n"]);
  assert.deepEqual(pty.signals, []);
  assert.equal(input.isRaw, true);
  assert.ok(gracefulExitCallback);
  gracefulExitCallback();
  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata?.cleanupVerified, true);
  assert.deepEqual(pty.signals, ["SIGTERM"]);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("close"), 0);
  assert.equal(process.stdout.listenerCount("resize"), resizeListeners);
  assert.equal(process.listenerCount("SIGINT"), sigintListeners);
});

test("foreground /quit cleanup requires an exact submitted logical line", async () => {
  for (const chunks of [
    ["/quit"],
    ["prefix ", "/quit", "\n"],
    ["ordinary text containing /quit is not a command\n"],
  ]) {
    const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
    const dir = mkdtempSync(join(tmpdir(), "pi-foreground-non-command-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
    let gracefulTimerArmed = false;
    const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
      spawnPty: () => pty as never, input: input as never, output: output as never,
      processExists: () => true,
      setTimeout: () => { gracefulTimerArmed = true; return {} as NodeJS.Timeout; }, clearTimeout: () => {},
    } });
    const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-non-command", mode: "foreground" });
    await nextTick();
    for (const chunk of chunks) input.emit("data", Buffer.from(chunk));
    await nextTick();
    assert.equal(gracefulTimerArmed, false, JSON.stringify(chunks));
    assert.deepEqual(pty.signals, [], JSON.stringify(chunks));
    assert.deepEqual(pty.writes, chunks, JSON.stringify(chunks));
    pty.emitExit(0);
    assert.equal((await resultPromise).exitCode, 0);
  }
});

test("foreground double interrupt window exits at 4999ms but starts a new sequence at 5000ms", async () => {
  const runSequence = async (secondAt: number): Promise<{ writes: string[]; signals: string[]; settled: boolean }> => {
    const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
    const dir = mkdtempSync(join(tmpdir(), `pi-foreground-interrupt-${secondAt}-`)); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
    let now = 0; let running = true; let settled = false;
    pty.onKill = (signal) => { if (signal === "SIGTERM" || signal === "SIGKILL") running = false; };
    const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
      spawnPty: () => pty as never, input: input as never, output: output as never,
      processExists: () => running, now: () => now, interruptNow: () => now, sleep: async () => {},
    } });
    const resultPromise = adapter.spawn({ primerPath: primer, deployId: `d-interrupt-${secondAt}`, mode: "foreground" });
    resultPromise.then(() => { settled = true; });
    await nextTick();
    try {
      input.emit("data", Buffer.from("\u0003"));
      now = secondAt;
      input.emit("data", Buffer.from("\u0003"));
      await nextTick();
      await nextTick();
      return { writes: [...pty.writes], signals: [...pty.signals], settled };
    } finally {
      running = false;
      pty.emitExit(0);
      await resultPromise;
    }
  };

  assert.deepEqual(await runSequence(4_999), { writes: ["\u0003"], signals: ["SIGTERM"], settled: true });
  assert.deepEqual(await runSequence(5_000), { writes: ["\u0003", "\u0003"], signals: [], settled: false });
});

test("foreground double interrupt timing is independent of wall-clock adjustments", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-monotonic-interrupt-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let running = true;
  let wallTime = 10_000;
  const originalDateNow = Date.now;
  Date.now = () => wallTime;
  pty.onKill = (signal) => {
    if (signal === "SIGTERM") {
      running = false;
      pty.emitExit(0);
    }
  };
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => running,
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-monotonic-interrupt", mode: "foreground" });
  try {
    await nextTick();
    input.emit("data", Buffer.from("\u0003"));
    wallTime += 1_000_000_000;
    input.emit("data", Buffer.from("\u0003"));
    const result = await resultPromise;
    assert.equal(result.exitCode, 0);
    assert.deepEqual(pty.writes, ["\u0003"]);
    assert.deepEqual(pty.signals, ["SIGTERM"]);
    assert.equal(result.metadata?.cleanupVerified, true);
  } finally {
    Date.now = originalDateNow;
    running = false;
    pty.emitExit(0);
  }
});

test("foreground EOF and terminal close request bounded cleanup with zero residual listeners", async () => {
  const runClosure = async (event: "end" | "close"): Promise<void> => {
    const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
    const dir = mkdtempSync(join(tmpdir(), `pi-foreground-${event}-`)); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
    let now = 0; let running = true;
    const resizeListeners = process.stdout.listenerCount("resize");
    const sigintListeners = process.listenerCount("SIGINT");
    pty.onKill = (signal) => { if (signal === "SIGTERM" || signal === "SIGKILL") running = false; };
    const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
      spawnPty: () => pty as never, input: input as never, output: output as never,
      processExists: () => running, now: () => now, sleep: async (milliseconds) => { now += milliseconds; },
    } });
    const resultPromise = adapter.spawn({ primerPath: primer, deployId: `d-foreground-${event}`, mode: "foreground" });
    await nextTick();
    input.emit(event);
    const result = await resultPromise;
    assert.equal(result.exitCode, 0);
    assert.equal(result.metadata?.cleanupVerified, true);
    assert.deepEqual(pty.signals, ["SIGTERM"]);
    assert.ok(now <= 10_000);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(input.listenerCount("end"), 0);
    assert.equal(input.listenerCount("close"), 0);
    assert.equal(process.stdout.listenerCount("resize"), resizeListeners);
    assert.equal(process.listenerCount("SIGINT"), sigintListeners);
  };

  await runClosure("end");
  await runClosure("close");
});

test("foreground graceful cleanup preserves a nonzero PTY exit", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-graceful-nonzero-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let running = true;
  pty.onKill = (signal) => {
    if (signal === "SIGTERM") {
      running = false;
      pty.emitExit(17);
    }
  };
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => running,
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-graceful-nonzero", mode: "foreground" });
  await nextTick();
  input.emit("end");
  const result = await resultPromise;
  assert.equal(result.exitCode, 17);
  assert.equal(result.errorMessage, "Pi exited with code 17");
  assert.equal(result.metadata?.cleanupVerified, true);
  assert.deepEqual(pty.signals, ["SIGTERM"]);
  assert.equal(input.isRaw, false);
});

test("foreground graceful cleanup fails when the PTY child remains live through its deadline", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-graceful-deadline-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  let now = 0;
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never, input: input as never, output: output as never,
    processExists: () => true,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-graceful-deadline", mode: "foreground" });
  await nextTick();
  const cleanupStartedAt = now;
  input.emit("end");
  const result = await resultPromise;
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "Pi cleanup failed; PTY child exit was not confirmed before cleanup deadline");
  assert.equal(result.metadata?.cleanupVerified, false);
  assert.deepEqual(pty.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(now - cleanupStartedAt, 4_900);
  assert.equal(input.isRaw, false);
});

test("PiAdapter.run rejects zero status with a cleanup error or unverified cleanup", async () => {
  for (const item of [
    { name: "error", raw: { status: 0, stdout: "", stderr: "", spawnError: new Error("cleanup remained unverified") }, message: "cleanup remained unverified" },
    { name: "unverified", raw: { status: 0, stdout: "", stderr: "", metadata: { cleanupVerified: false } }, message: "Pi cleanup failed: PTY child exit was not verified" },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), `pi-foreground-zero-${item.name}-`)); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
    const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", runCommand: () => item.raw });
    const result = await adapter.spawn({ primerPath: primer, deployId: `d-foreground-zero-${item.name}`, mode: "foreground" });
    assert.equal(result.exitCode, 1, item.name);
    assert.equal(result.errorMessage, item.message, item.name);
  }
});

test("foreground terminal restoration failure remains causal and bounded", async () => {
  const pty = new FakePiPty(); const input = new FakePiInput(); const output = new FakePiOutput();
  const originalSetRawMode = input.setRawMode.bind(input);
  input.setRawMode = ((raw: boolean) => {
    if (!raw) throw new Error("raw mode restore failed");
    return originalSetRawMode(raw);
  }) as typeof input.setRawMode;
  const dir = mkdtempSync(join(tmpdir(), "pi-foreground-restore-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work");
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.80.8", supervision: { spawnPty: () => pty as never, input: input as never, output: output as never } });
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-foreground-restore", mode: "foreground" });
  await nextTick(); pty.emitExit(0);
  const result = await resultPromise;
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage ?? "", /^terminal-restoration: raw mode restore failed$/);
  assert.ok((result.errorMessage?.length ?? Infinity) <= 2_000);
  assert.equal(input.listenerCount("data"), 0);
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
  const reasoningValue = "foreground-encrypted-reasoning-value";
  const structuredLine = `${JSON.stringify({ type: "message", text: "useful foreground diagnostic", thinkingSignature: { encrypted_content: reasoningValue }, repeatedPayload: reasoningValue })}\n`;
  const malformedLine = `useful malformed foreground {"encrypted_content":"${reasoningValue}"\n`;
  const oversizedMalformedLine = `useful oversized foreground ${"q".repeat(17_000)}{"thinkingSignature":{"signature":"${reasoningValue}"}\n`;
  const terminalLine = `${structuredLine}${malformedLine}${oversizedMalformedLine}${"x".repeat(8188)}${configuredValue} ${shapedPrefix} ${shapedValue} ${assignedPrefix}=${assignedValue} ${"z".repeat(9000)}\n`;
  for (const character of terminalLine) pty.emitData(character);
  pty.emitExit(0);
  assert.equal((await resultPromise).exitCode, 0);
  const persisted = readFileSync(logFile, "utf8");
  assert.doesNotMatch(persisted, /thinkingSignature|encrypted_content/i);
  assert.doesNotMatch(persisted, new RegExp([configuredValue, shapedValue, assignedValue, reasoningValue].join("|")));
  assert.match(persisted, /useful foreground diagnostic/);
  assert.match(persisted, /useful malformed foreground/);
  assert.match(persisted, /useful oversized foreground/);
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

  const backgroundRunner = new FakePiChild();
  let backgroundArgs: string[] = [];
  const background = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.80.8", supervision: {
    launchBackgroundRunner: ((_runnerPath, configPath) => {
      const config = readPiBackgroundConfig(configPath);
      backgroundArgs = buildPiBackgroundArgs(config);
      writePiSupervisorOwnership(join(dirname(configPath), "pi-supervisor.json"), {
        schemaVersion: 1,
        deploymentId: config.deploymentId,
        ownershipToken: config.ownershipToken,
        state: "active",
        ready: true,
        supervisorPid: backgroundRunner.pid,
        childPid: 43,
        updatedAt: new Date().toISOString(),
        finalizationDeadlineMs: 5000,
      });
      return backgroundRunner as never;
    }),
  } });
  const started = await background.spawn({ primerPath: primer, deployId: "d-background", mode: "background" });
  assert.equal(started.metadata?.pending, true);
  assert.equal(started.metadata?.monitor, undefined);
  assert.equal(started.metadata?.supervisorPid, backgroundRunner.pid);
  assert.deepEqual(backgroundArgs.slice(0, 5), ["--print", "--mode", "json", "--session-id", started.sessionId]);
  assert.equal(backgroundRunner.stdout.listenerCount("data"), 0);
  assert.equal(groupGone, true);
});
