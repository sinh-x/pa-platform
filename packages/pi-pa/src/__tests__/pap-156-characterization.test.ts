import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { closeDb, readActivityEvents } from "@pa-platform/pa-core";
import { normalizePiEvent, PiAdapter, readPiBackgroundConfig, writePiSupervisorOwnership } from "../adapter.js";
import registerPiPaExtension from "../pi-extension/index.js";
import { writePiTerminalStatus } from "../terminal-status.js";

interface Pap156Fixture {
  id: string;
  repository: { kind: string; directoryPrefix: string; initialFiles: Record<string, string> };
  managedTools: string[];
  expected: {
    callerReturnWithinMs: number;
    supervisorFinalizationWithinMs: number;
    foregroundSettlementWithinMs: number;
    identifiedUses: number;
    matchingResults: number;
    unidentifiedDeltaActions: number;
    callIds: string[];
  };
  lifecycle: { ownershipFile: string; events: Array<Record<string, unknown>> };
  streamEvents: Array<Record<string, unknown>>;
  syntheticSensitiveValue: string;
  failureCases: Array<{ category: string; diagnostic: string }>;
}

class CharacterizationChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 78_001;
  unref(): void {}
}

class CharacterizationPty {
  readonly pid = 78_002;
  private onDataHandler?: (data: string) => void;
  private onExitHandler?: (event: { exitCode: number; signal: number }) => void;
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(handler: (data: string) => void): void { this.onDataHandler = handler; }
  onExit(handler: (event: { exitCode: number; signal: number }) => void): void { this.onExitHandler = handler; }
  emitData(data: string): void { this.onDataHandler?.(data); }
  emitExit(exitCode: number): void { this.onExitHandler?.({ exitCode, signal: 0 }); }
}

class CharacterizationInput extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
}

function loadFixture(): Pap156Fixture {
  const path = fileURLToPath(new URL("fixtures/pap-156-lifecycle.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Pap156Fixture;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function commandPath(command: string): string {
  const candidates = execFileSync("which", ["-a", command], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return candidates.find((candidate) => !candidate.includes("/node_modules/")) ?? candidates[0] ?? command;
}

function wrappedNode(command: "pi" | "ppa"): string {
  let current = realpathSync(commandPath(command));
  for (let depth = 0; depth < 4; depth += 1) {
    const text = readFileSync(current, "utf8");
    const targets = [...text.matchAll(/"([^"\n]+\/bin\/(?:node|\.pi-wrapped))"/g)].map((match) => match[1]!);
    const target = targets.at(-1);
    if (!target) break;
    if (target.endsWith("/bin/node")) return target;
    current = target;
  }
  throw new Error(`Could not resolve ${command} Node host from ${current}`);
}

function nativeLoad(node: string, registryDb: string, addonPath: string): { status: number | null; diagnostic: string } {
  const core = pathToFileURL(fileURLToPath(new URL("../../../pa-core/dist/index.js", import.meta.url))).href;
  const script = `const core = await import(${JSON.stringify(core)}); core.verifyRegistryNativeAddon(${JSON.stringify(addonPath)}); core.queryDeploymentStatuses();`;
  const result = spawnSync(node, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...process.env, PA_REGISTRY_DB: registryDb, PA_SQLITE_NATIVE_BINDING: addonPath },
    timeout: 10_000,
  });
  const raw = `${result.stderr || result.error?.message || result.stdout || "native load failed"}`;
  const diagnostic = `native-load: ${raw.replaceAll(loadFixture().syntheticSensitiveValue, "[REDACTED]")}`.slice(0, 2000);
  return { status: result.status, diagnostic };
}

function toolCallId(event: { metadata?: Record<string, unknown> }): string | undefined {
  const value = event.metadata?.["toolCallId"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

test("PAP-156 fixture is sanitized, bounded, complete, and uses only a clean temporary repository", () => {
  const fixturePath = fileURLToPath(new URL("fixtures/pap-156-lifecycle.json", import.meta.url));
  const fixtureText = readFileSync(fixturePath, "utf8");
  const fixture = loadFixture();
  assert.ok(Buffer.byteLength(fixtureText) <= 50 * 1024);
  assert.ok(fixtureText.split("\n").length <= 2000);
  assert.doesNotMatch(fixtureText, /Bearer\s+\S+|api[_-]?key|sk-[A-Za-z0-9]/i);
  assert.equal(fixture.repository.kind, "temporary-fixture-only");
  assert.deepEqual(fixture.managedTools, ["read", "bash", "question", "todo", "pa_ticket", "pa_bulletin", "pa_registry", "pa_status"]);
  assert.deepEqual(fixture.failureCases.map((item) => item.category), ["malformed-tool", "timeout", "process", "native-load", "launcher"]);
  const lifecycleEvent = (type: string): Record<string, unknown> => fixture.lifecycle.events.find((event) => event["type"] === type)!;
  const ready = lifecycleEvent("supervisor_ready");
  const launcherReturn = lifecycleEvent("launcher_return");
  const callerDeadline = lifecycleEvent("caller_deadline");
  const childExit = lifecycleEvent("child_exit");
  const overlap = lifecycleEvent("status_wait_poll");
  const terminal = lifecycleEvent("terminal");
  assert.equal(ready["state"], "active");
  assert.ok(Number(ready["atMs"]) <= Number(launcherReturn["atMs"]));
  assert.ok(Number(launcherReturn["atMs"]) <= fixture.expected.callerReturnWithinMs);
  assert.ok(Number(callerDeadline["atMs"]) > Number(launcherReturn["atMs"]));
  assert.ok(Number(overlap["atMs"]) >= Number(childExit["atMs"]));
  assert.equal(overlap["supervisorState"], "finalizing");
  assert.ok(Number(terminal["atMs"]) - Number(childExit["atMs"]) <= fixture.expected.supervisorFinalizationWithinMs);

  const repository = mkdtempSync(join(tmpdir(), fixture.repository.directoryPrefix));
  try {
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "fixture@example.invalid"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "PAP-156 Fixture"]);
    for (const [path, content] of Object.entries(fixture.repository.initialFiles)) writeFileSync(join(repository, path), content);
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "fixture baseline"]);
    const before = execFileSync("git", ["-C", repository, "status", "--porcelain=v1"], { encoding: "utf8" });
    fixture.streamEvents.map((event) => normalizePiEvent(event, fixture.id));
    const after = execFileSync("git", ["-C", repository, "status", "--porcelain=v1"], { encoding: "utf8" });
    assert.equal(before, "");
    assert.equal(after, before);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("background launch transfers ownership without retaining caller listeners or an in-process monitor", async () => {
  const fixture = loadFixture();
  const root = mkdtempSync(join(tmpdir(), "pap-156-background-"));
  const primer = join(root, "primer.md");
  writeFileSync(primer, "sanitized background objective");
  const child = new CharacterizationChild();
  const adapter = new PiAdapter({
    cwd: root,
    versionProbe: () => "0.80.8",
    supervision: {
      launchBackgroundRunner: ((_runnerPath, configPath) => {
        const config = readPiBackgroundConfig(configPath);
        writePiSupervisorOwnership(join(root, fixture.lifecycle.ownershipFile), {
          schemaVersion: 1,
          deploymentId: config.deploymentId,
          ownershipToken: config.ownershipToken,
          state: "active",
          ready: true,
          supervisorPid: child.pid,
          childPid: 78_002,
          updatedAt: new Date().toISOString(),
          finalizationDeadlineMs: 5000,
        });
        return child as never;
      }),
    },
  });

  const startedAt = performance.now();
  const result = await adapter.spawn({ primerPath: primer, deployId: fixture.id, mode: "background" });
  const elapsed = performance.now() - startedAt;
  try {
    assert.deepEqual(
      {
        returnedWithinDeadline: elapsed <= fixture.expected.callerReturnWithinMs,
        pending: result.metadata?.["pending"],
        supervisorReady: typeof result.metadata?.["supervisorPid"] === "number",
        launcherOwnsMonitor: result.metadata?.["monitor"] !== undefined,
        launcherStdoutListeners: child.stdout.listenerCount("data"),
        launcherStderrListeners: child.stderr.listenerCount("data"),
        launcherCloseListeners: child.listenerCount("close"),
      },
      {
        returnedWithinDeadline: true,
        pending: true,
        supervisorReady: true,
        launcherOwnsMonitor: false,
        launcherStdoutListeners: 0,
        launcherStderrListeners: 0,
        launcherCloseListeners: 0,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eight fixture calls project to eight identified uses and matching results while raw deltas remain retained", async () => {
  const fixture = loadFixture();
  const root = mkdtempSync(join(tmpdir(), "pap-156-activity-"));
  const deployDir = join(root, "deployments", fixture.id);
  const primer = join(deployDir, "primer.md");
  const previousHome = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_AI_USAGE_HOME"] = root;
  mkdirSync(deployDir, { recursive: true });
  writeFileSync(primer, "sanitized activity objective");
  const child = new CharacterizationChild();
  try {
    const adapter = new PiAdapter({ cwd: deployDir, versionProbe: () => "0.80.8", supervision: { spawnProcess: (() => child as never) as typeof spawn } });
    const resultPromise = adapter.spawn({ primerPath: primer, deployId: fixture.id, mode: "dry-run" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdout.emit("data", Buffer.from(`${fixture.streamEvents.map((event) => JSON.stringify(event)).join("\n")}\n`));
    child.emit("close", 0);
    assert.equal((await resultPromise).exitCode, 0);

    const raw = readFileSync(join(deployDir, "pi-output.jsonl"), "utf8");
    assert.match(raw, /toolcall_delta/);
    assert.match(raw, /pap156-call-read/);
    assert.doesNotMatch(raw, new RegExp(fixture.syntheticSensitiveValue));

    const activity = readActivityEvents(join(deployDir, "activity.jsonl"));
    const uses = activity.filter((event) => event.kind === "tool_use");
    const results = activity.filter((event) => event.kind === "tool_result");
    const unidentifiedDeltas = uses.filter((event) => event.partType === "toolcall_delta" && !toolCallId(event));
    const useIds = uses.map(toolCallId).filter((id): id is string => id !== undefined);
    const resultIds = results.map(toolCallId).filter((id): id is string => id !== undefined).sort();

    assert.deepEqual(
      {
        totalUses: uses.length,
        identifiedUses: useIds.length,
        matchingResults: resultIds.length,
        unidentifiedDeltaActions: unidentifiedDeltas.length,
        useIds,
        resultIds,
      },
      {
        totalUses: fixture.expected.identifiedUses,
        identifiedUses: fixture.expected.identifiedUses,
        matchingResults: fixture.expected.matchingResults,
        unidentifiedDeltaActions: fixture.expected.unidentifiedDeltaActions,
        useIds: fixture.expected.callIds,
        resultIds: [...fixture.expected.callIds].sort(),
      },
    );
  } finally {
    closeDb();
    restoreEnv("PA_AI_USAGE_HOME", previousHome);
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreground settlement is bounded when PTY exit is absent and process probes remain stale", async () => {
  const fixture = loadFixture();
  const root = mkdtempSync(join(tmpdir(), "pap-156-foreground-"));
  const primer = join(root, "primer.md");
  writeFileSync(primer, "sanitized foreground objective");
  writePiTerminalStatus(root, { type: "agent_end", stopReason: "stop", timestamp: "2026-08-29T00:00:00.000Z" });
  const pty = new CharacterizationPty();
  const input = new CharacterizationInput();
  const output = { write() { return true; } };
  let elapsedSinceRealExit = 0;
  const adapter = new PiAdapter({ cwd: root, versionProbe: () => "0.80.8", supervision: {
    spawnPty: () => pty as never,
    input: input as never,
    output: output as never,
    now: () => elapsedSinceRealExit,
    sleep: async (milliseconds) => { elapsedSinceRealExit += milliseconds; },
    processExists: () => elapsedSinceRealExit < 5100,
  } });

  try {
    const result = await adapter.spawn({ primerPath: primer, deployId: fixture.id, mode: "foreground" });
    assert.equal(result.exitCode, 0);
    assert.ok(elapsedSinceRealExit <= fixture.expected.foregroundSettlementWithinMs, `settlement took ${elapsedSinceRealExit}ms after real exit`);
    assert.equal(input.isRaw, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failure fixtures preserve causal categories while diagnostics stay bounded and redacted", () => {
  const fixture = loadFixture();
  for (const failure of fixture.failureCases) {
    const activity = normalizePiEvent({ type: "error", content: failure.diagnostic }, fixture.id, [fixture.syntheticSensitiveValue]);
    const terminal = failure.diagnostic.replaceAll(fixture.syntheticSensitiveValue, "[REDACTED]").slice(0, 2000);
    assert.match(activity.body, new RegExp(`^${failure.category}`));
    assert.match(terminal, new RegExp(`^${failure.category}`));
    assert.ok(activity.body.length <= 500);
    assert.ok(terminal.length <= 2000);
    assert.doesNotMatch(activity.body, new RegExp(fixture.syntheticSensitiveValue));
    assert.doesNotMatch(terminal, new RegExp(fixture.syntheticSensitiveValue));
  }
});

test("managed Pi fixture covers built-ins and every registered PA tool", () => {
  const fixture = loadFixture();
  const registered: string[] = [];
  registerPiPaExtension({ registerTool: (tool) => registered.push(tool.name) });
  assert.deepEqual(["read", "bash", ...registered].sort(), [...fixture.managedTools].sort());
});

test("native registry preflight loads under both the installed PPA Node 22 host and Pi host", () => {
  const fixture = loadFixture();
  const root = mkdtempSync(join(tmpdir(), "pap-156-native-load-"));
  try {
    const ppaNode = wrappedNode("ppa");
    const piNode = wrappedNode("pi");
    const packageOutput = dirname(dirname(realpathSync(commandPath("ppa"))));
    const ppaAddon = join(packageOutput, "share", "pa-platform", "native-addons", "node-22", "better_sqlite3.node");
    const piAddon = join(packageOutput, "share", "pa-platform", "native-addons", "pi-node-24", "better_sqlite3.node");
    assert.equal(existsSync(ppaAddon), true, `missing packaged Node 22 addon: ${ppaAddon}`);
    assert.equal(existsSync(piAddon), true, `missing packaged Pi-host addon: ${piAddon}`);
    const ppaLoad = nativeLoad(ppaNode, join(root, "ppa-registry.db"), ppaAddon);
    const piLoad = nativeLoad(piNode, join(root, "pi-registry.db"), piAddon);
    for (const outcome of [ppaLoad, piLoad]) {
      assert.match(outcome.diagnostic, /^native-load:/);
      assert.ok(outcome.diagnostic.length <= 2000);
      assert.doesNotMatch(outcome.diagnostic, new RegExp(fixture.syntheticSensitiveValue));
    }
    assert.equal(ppaLoad.status, 0, ppaLoad.diagnostic);
    assert.equal(piLoad.status, 0, piLoad.diagnostic);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
