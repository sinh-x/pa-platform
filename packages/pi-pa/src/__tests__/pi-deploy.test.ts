import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDeployPaths, getDeploymentEvents, readActivityEvents, type RuntimeAdapter, type SpawnOpts, type SpawnResult } from "@pa-platform/pa-core";
import { PiAdapter } from "../adapter.js";
import { deployWithPi, piSessionCommand } from "../deploy.js";
import { resolvePiRuntimeConfig } from "../runtime-normalization.js";

function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }

function withPiEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ppa-deploy-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\n`);
  writeFileSync(join(teams, "builder.yaml"), [
    "name: builder",
    "description: Builder",
    "objective: Build",
    "agents:",
    "  - name: builder-agent",
    "    role: Builds",
    "deploy_modes:",
    "  - id: implement",
    "    label: Implement",
  ].join("\n") + "\n");
  const previous = Object.fromEntries(["PA_PLATFORM_CONFIG", "PA_PLATFORM_TEAMS", "PA_REGISTRY_DB", "PA_AI_USAGE_HOME", "PA_MAX_RUNTIME"].map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  delete process.env["PA_MAX_RUNTIME"];
  return fn(root).finally(() => {
    closeDb();
    for (const [key, value] of Object.entries(previous)) restore(key, value);
    rmSync(root, { recursive: true, force: true });
  });
}

function stubAdapter(options: { preflight?: () => Promise<void>; result?: (sessionId: string) => SpawnResult; onSpawn?: (opts: SpawnOpts) => void; onResume?: (opts: SpawnOpts) => void }): RuntimeAdapter & { preflight(): Promise<void>; allocateSessionId(): string } {
  const result = (sessionId: string) => options.result?.(sessionId) ?? { sessionId, exitCode: 0, metadata: { sessionId } };
  return {
    name: "pi",
    defaultModel: "",
    sessionFileName: "session-id-pi.txt",
    preflight: options.preflight ?? (async () => {}),
    allocateSessionId: () => "authoritative-session-id",
    installHooks() {},
    spawn(opts) { options.onSpawn?.(opts); return result(opts.sessionId ?? ""); },
    resume(opts) { options.onResume?.(opts); return result(opts.sessionId); },
    extractActivity() { return []; },
    describeTools() { return { runtime: "pi", markdown: "stub" }; },
  };
}

function assertTimeoutMetadata(opts: SpawnOpts, timeoutSeconds: number): void {
  assert.equal(opts.executionPlan?.timeoutSeconds, timeoutSeconds);
  assert.equal(readFileSync(opts.primerPath, "utf8").match(new RegExp(`timeout_seconds: ${timeoutSeconds}`, "g"))?.length, 1);
  assert.equal(getDeploymentEvents(opts.deployId)[0]?.effective_timeout_seconds, timeoutSeconds);
}

class ForegroundDeploymentPty extends EventEmitter {
  readonly pid = 77_001;
  readonly writes: string[] = [];
  private onDataHandler?: (data: string) => void;
  private onExitHandler?: (event: { exitCode: number; signal: number }) => void;
  constructor(private readonly onQuit: () => void) { super(); }
  write(data: string): void { this.writes.push(data); if (data === "/quit") this.onQuit(); }
  resize(): void {}
  kill(): void {}
  onData(handler: (data: string) => void): void { this.onDataHandler = handler; }
  onExit(handler: (event: { exitCode: number; signal: number }) => void): void { this.onExitHandler = handler; }
  emitData(data: string): void { this.onDataHandler?.(data); }
  emitExit(exitCode: number): void { this.onExitHandler?.({ exitCode, signal: 0 }); }
}

class ForegroundDeploymentInput extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
}

function nextTick(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

test("foreground PPA /quit settles without PTY onExit and emits one terminal registry event", async () => {
  await withPiEnv(async () => {
    let running = true;
    const input = new ForegroundDeploymentInput();
    const output = { write() { return true; } };
    const pty = new ForegroundDeploymentPty(() => { running = false; });
    const adapter = new PiAdapter({ cwd: tmpdir(), versionProbe: () => "0.80.8", supervision: {
      spawnPty: () => pty as never, input: input as never, output: output as never,
      processExists: () => running,
    } });
    const deploymentPromise = deployWithPi({ team: "builder", mode: "implement" }, adapter);
    await nextTick();
    input.emit("data", "/quit");
    const result = await deploymentPromise;
    assert.equal(result.status, "success");
    assert.deepEqual(pty.writes, ["/quit"]);
    assert.equal(input.isRaw, false);
    const terminalEvents = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0]?.event, "completed");
  });
});

test("new foreground Pi deployments omit the adapter deadline but retain timeout metadata", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.ok(captured);
    assert.equal(captured.mode, "foreground");
    assert.equal(Object.hasOwn(captured, "timeoutMs"), false);
    assert.equal(captured.timeoutMs, undefined);
    assertTimeoutMetadata(captured, 1800);
  });
});

test("new background Pi deployments omit the adapter deadline while retaining supervision metadata", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement", background: true, timeout: 2400 }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.ok(captured);
    assert.equal(captured.mode, "background");
    assert.equal(Object.hasOwn(captured, "timeoutMs"), false);
    assert.equal(captured.timeoutMs, undefined);
    assertTimeoutMetadata(captured, 2400);
  });
});

test("resumed and evaluator Pi deployments retain their resolved adapter deadlines", async () => {
  await withPiEnv(async () => {
    const captured: Array<{ kind: "spawn" | "resume"; opts: SpawnOpts }> = [];
    const adapter = stubAdapter({
      onSpawn: (opts) => { captured.push({ kind: "spawn", opts }); },
      onResume: (opts) => { captured.push({ kind: "resume", opts }); },
    });
    const initial = await deployWithPi({ team: "builder", mode: "implement", timeout: 1200 }, adapter);
    assert.equal(initial.status, "success");
    const resumed = await deployWithPi({ team: "builder", mode: "implement", resume: initial.deploymentId, timeout: 1200 }, adapter);
    assert.equal(resumed.status, "success");
    const evaluator = await deployWithPi({ team: "builder", mode: "implement", evaluateDeployment: "d-abcdef", timeout: 600 }, adapter);
    assert.equal(evaluator.status, "success");
    assert.equal(captured[1]?.kind, "resume");
    assert.equal(captured[1]?.opts.timeoutMs, 1_200_000);
    assertTimeoutMetadata(captured[1]!.opts, 1200);
    assert.equal(captured[2]?.kind, "spawn");
    assert.equal(captured[2]?.opts.timeoutMs, 600_000);
    assertTimeoutMetadata(captured[2]!.opts, 600);
  });
});

test("Pi preflight failure is controlled, actionable, and leaves no session file", async () => {
  await withPiEnv(async () => {
    let spawned = 0;
    const adapter = stubAdapter({
      preflight: async () => { throw new Error("Pi version probe timed out after 5ms."); },
      onSpawn: () => { spawned++; },
    });
    const result = await deployWithPi({ team: "builder", mode: "implement" }, adapter);
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /Pi version probe timed out after 5ms/);
    assert.equal(spawned, 0);
    assert.ok(result.deploymentId);
    const paths = getDeployPaths(result.deploymentId!);
    assert.equal(existsSync(join(paths.deployDir, "session-id-pi.txt")), false);
    assert.deepEqual(getDeploymentEvents(result.deploymentId!).map((event) => event.event), ["started", "completed"]);
    assert.equal(getDeploymentEvents(result.deploymentId!)[1]?.status, "failed");
    const errors = readActivityEvents(paths.activityLogPath).filter((event) => event.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.body ?? "", /Pi version probe timed out after 5ms/);
  });
});

test("Pi adapter failure without session metadata keeps its original reason", async () => {
  await withPiEnv(async () => {
    const adapter = stubAdapter({ result: () => ({ exitCode: 1, errorMessage: "model auth failed" }) });
    const result = await deployWithPi({ team: "builder", mode: "implement" }, adapter);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "model auth failed");
    assert.doesNotMatch(result.reason ?? "", /session id different/);
    assert.ok(result.deploymentId);
    const events = getDeploymentEvents(result.deploymentId!);
    assert.deepEqual(events.map((event) => event.event), ["started", "completed"]);
    assert.equal(events[1]?.summary, "ppa deploy failed: model auth failed");
    const error = readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath).find((event) => event.kind === "error");
    assert.match(error?.body ?? "", /model auth failed/);
  });
});

test("managed Pi outcomes emit one accurate bounded redacted terminal event", async () => {
  const secret = "configured-terminal-secret";
  const previous = process.env["PAP_151_API_KEY"];
  process.env["PAP_151_API_KEY"] = secret;
  try {
    const cases: Array<{ name: string; adapter: ReturnType<typeof stubAdapter>; event: "completed" | "crashed"; status?: "success" | "failed"; reason: RegExp }> = [
      { name: "success", adapter: stubAdapter({}), event: "completed", status: "success", reason: /ppa deploy completed/ },
      { name: "validation", adapter: stubAdapter({ preflight: async () => { throw new Error(`validation failed ${secret}`); } }), event: "completed", status: "failed", reason: /validation failed/ },
      { name: "malformed", adapter: stubAdapter({ result: () => ({ exitCode: 1, errorMessage: `Malformed Pi tool call todo ${secret}` }) }), event: "completed", status: "failed", reason: /Malformed Pi tool call/ },
      { name: "nonzero", adapter: stubAdapter({ result: () => ({ exitCode: 17, errorMessage: `pi exited with code 17 ${secret}` }) }), event: "completed", status: "failed", reason: /code 17/ },
      { name: "launcher", adapter: stubAdapter({ result: () => { throw new Error(`launcher exception ${secret}`); } }), event: "crashed", reason: /launcher exception/ },
    ];
    for (const item of cases) {
      await withPiEnv(async () => {
        const result = await deployWithPi({ team: "builder", mode: "implement" }, item.adapter);
        assert.equal(result.status, item.name === "success" ? "success" : "failed", item.name);
        const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
        assert.equal(terminal.length, 1, item.name);
        assert.equal(terminal[0]?.event, item.event, item.name);
        assert.notEqual(terminal[0]?.fallback, true, item.name);
        if (item.status) assert.equal(terminal[0]?.status, item.status, item.name);
        const diagnostic = String(terminal[0]?.summary ?? terminal[0]?.error ?? "");
        assert.match(diagnostic, item.reason, item.name);
        assert.ok(diagnostic.length <= 2000, item.name);
        assert.doesNotMatch(diagnostic, new RegExp(secret), item.name);
        for (const activity of readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath)) {
          assert.ok(activity.body.length <= 500, item.name);
          assert.doesNotMatch(activity.body, new RegExp(secret), item.name);
        }
      });
    }
  } finally {
    restore("PAP_151_API_KEY", previous);
  }
});

test("background terminal diagnostics cannot retain success status or exit zero", async () => {
  await withPiEnv(async () => {
    const adapter = stubAdapter({ result: (sessionId) => ({
      sessionId,
      exitCode: 0,
      metadata: {
        sessionId,
        pending: true,
        monitor: { completion: Promise.resolve({ status: 0, stdout: "", stderr: "", metadata: { terminalError: "Malformed Pi tool call todo" } }) },
      },
    }) });
    const result = await deployWithPi({ team: "builder", mode: "implement", background: true }, adapter);
    assert.equal(result.status, "pending");
    await nextTick();
    const terminal = getDeploymentEvents(result.deploymentId!).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.event, "completed");
    assert.equal(terminal[0]?.status, "failed");
    assert.equal(terminal[0]?.exit_code, 1);
    assert.match(terminal[0]?.summary ?? "", /^ppa deploy failed: Malformed Pi tool call todo$/);
    assert.notEqual(terminal[0]?.fallback, true);
  });
});

test("Pi successful results still require both authoritative session IDs", async () => {
  for (const resultFor of [
    () => ({ exitCode: 0, metadata: { sessionId: "authoritative-session-id" } }),
    () => ({ exitCode: 0, sessionId: "authoritative-session-id", metadata: {} }),
    () => ({ exitCode: 0, sessionId: "wrong-session-id", metadata: { sessionId: "authoritative-session-id" } }),
  ]) {
    await withPiEnv(async () => {
      const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({ result: resultFor }));
      assert.equal(result.status, "failed");
      assert.match(result.reason ?? "", /Pi adapter returned a session id different/);
      assert.ok(result.deploymentId);
      assert.equal(readFileSync(join(getDeployPaths(result.deploymentId!).deployDir, "session-id-pi.txt"), "utf8").trim(), "authoritative-session-id");
      assert.deepEqual(getDeploymentEvents(result.deploymentId!).map((event) => event.event), ["started", "crashed"]);
    });
  }
});

test("Pi Agent API session commands normalize OpenAI identifiers", () => {
  const command = piSessionCommand({ model: "openai/gpt-5.6-luna", prompt: "work", sessionId: "session", env: { PA_PROVIDER: "openai" }, session: { id: "unused", model: "", status: "running", startedAt: "", deploymentId: "", runtime: "pi" } });
  assert.deepEqual(command.args, ["--print", "--mode", "json", "--session-id", "session", "--model", "gpt-5.6-luna", "--provider", "openai-codex", "work"]);
});

test("managed Pi deployment passes normalized provider and model to the adapter", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement", provider: "openai", model: "openai/gpt-5.6-luna" }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.equal(captured?.model, "gpt-5.6-luna");
    assert.equal(captured?.env?.["PA_PROVIDER"], "openai-codex");
    assert.equal(captured?.env?.["PA_MODEL"], "gpt-5.6-luna");
    assert.match(readFileSync(captured!.primerPath, "utf8"), /PA_PROVIDER: openai-codex/);
    assert.match(readFileSync(captured!.primerPath, "utf8"), /PA_MODEL: gpt-5.6-luna/);
    const resolution = readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath)[0];
    assert.deepEqual(resolution?.metadata, { provider: "openai-codex", model: "gpt-5.6-luna", resolution: "cli" });
    const started = getDeploymentEvents(result.deploymentId!)[0];
    assert.equal(started?.provider, "openai-codex");
    assert.equal(started?.models?.team, "gpt-5.6-luna");
  });
});

test("active builder and requirements modes keep one normalized pair across Pi evidence", async () => {
  await withPiEnv(async (root) => {
    writeFileSync(join(root, "teams", "builder.yaml"), [
      "name: builder", "description: Builder", "objective: Build", "agents: []", "deploy_modes:",
      "  - id: implement", "    label: Implement", "    provider: openai", "    model: openai/gpt-5.6-sol",
      "  - id: orchestrator", "    label: Orchestrator", "    provider: openai", "    model: openai/gpt-5.6-sol",
    ].join("\n") + "\n");
    writeFileSync(join(root, "teams", "requirements.yaml"), [
      "name: requirements", "description: Requirements", "objective: Review", "agents: []", "deploy_modes:",
      "  - id: review-auto", "    label: Review Auto", "    provider: openai", "    model: openai/gpt-5.6-sol",
    ].join("\n") + "\n");
    const invocations: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const adapter = new PiAdapter({
      versionProbe: () => "0.80.8",
      runCommand: (args, opts) => {
        invocations.push({ args, env: opts.env });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    for (const [team, mode] of [["builder", "implement"], ["builder", "orchestrator"], ["requirements", "review-auto"]] as const) {
      const result = await deployWithPi({ team, mode }, adapter);
      assert.equal(result.status, "success");
      const invocation = invocations.at(-1)!;
      const modelIndex = invocation.args.indexOf("--model");
      const providerIndex = invocation.args.indexOf("--provider");
      assert.equal(invocation.args[modelIndex + 1], "gpt-5.6-sol");
      assert.equal(invocation.args[providerIndex + 1], "openai-codex");
      assert.equal(invocation.env["PA_PROVIDER"], "openai-codex");
      assert.equal(invocation.env["PA_MODEL"], "gpt-5.6-sol");
      const paths = getDeployPaths(result.deploymentId!);
      const primer = readFileSync(join(paths.deployDir, "primer.md"), "utf8");
      assert.match(primer, /PA_PROVIDER: openai-codex/);
      assert.match(primer, /PA_MODEL: gpt-5.6-sol/);
      const resolution = readActivityEvents(paths.activityLogPath)[0];
      assert.deepEqual(resolution?.metadata, { provider: "openai-codex", model: "gpt-5.6-sol", resolution: "mode" });
      const started = getDeploymentEvents(result.deploymentId!)[0];
      assert.equal(started?.provider, "openai-codex");
      assert.equal(started?.models?.team, "gpt-5.6-sol");
    }
  });
});

test("PPA defaults to Sol and uses one normalized pair for spawn, env, primer, and registry", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.equal(captured?.model, "gpt-5.6-sol");
    assert.equal(captured?.env?.["PA_PROVIDER"], "openai-codex");
    assert.equal(captured?.env?.["PA_MODEL"], "gpt-5.6-sol");
    assert.match(readFileSync(captured!.primerPath, "utf8"), /PA_PROVIDER: openai-codex/);
    assert.match(readFileSync(captured!.primerPath, "utf8"), /PA_MODEL: gpt-5.6-sol/);
    const resolution = readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath)[0];
    assert.equal(resolution?.body, "Resolved Pi runtime openai-codex/gpt-5.6-sol");
    assert.deepEqual(resolution?.metadata, { provider: "openai-codex", model: "gpt-5.6-sol", resolution: "default" });
    const started = getDeploymentEvents(result.deploymentId!)[0];
    assert.equal(started?.provider, "openai-codex");
    assert.equal(started?.models?.team, "gpt-5.6-sol");
  });
});

test("PPA rejects unsupported and provider-qualified mismatched pairs", () => {
  assert.throws(
    () => resolvePiRuntimeConfig(Object.freeze({ provider: "anthropic", model: "claude-sonnet-4-6", source: "mode" })),
    /provider field is unsupported.*anthropic\/claude-sonnet-4-6/,
  );
  assert.throws(
    () => resolvePiRuntimeConfig(Object.freeze({ provider: "openai", model: "anthropic/claude-sonnet-4-6", source: "mode" })),
    /provider and model fields do not match.*openai\/anthropic\/claude-sonnet-4-6/,
  );
});

test("PPA rejects partial and mismatched CLI pairs before Pi preflight or spawn", async () => {
  await withPiEnv(async () => {
    for (const item of [
      { request: { provider: "openai" }, reason: /--model is required when --provider is supplied/ },
      { request: { model: "openai\/gpt-5.6-luna" }, reason: /--provider is required when --model is supplied/ },
      { request: { provider: "openai", model: "deepseek\/deepseek-v4-pro" }, reason: /provider and model fields do not match/ },
    ]) {
      let preflights = 0;
      let spawns = 0;
      const adapter = stubAdapter({ preflight: async () => { preflights++; }, onSpawn: () => { spawns++; } });
      const result = await deployWithPi({ team: "builder", mode: "implement", ...item.request }, adapter);
      assert.equal(result.status, "failed");
      assert.match(result.reason ?? "", item.reason);
      assert.equal(preflights, 0);
      assert.equal(spawns, 0);
      assert.deepEqual(getDeploymentEvents(result.deploymentId!).map((event) => event.event), ["completed"]);
    }
  });
});
