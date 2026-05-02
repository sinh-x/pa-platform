import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { closeDb, queryDeploymentStatuses, readActivityEvents, runCoreCommand, type ActivityEvent, type RuntimeAdapter, type SpawnResult } from "@pa-platform/pa-core";
import { ClaudeCodeAdapter, claudeJsonToActivityEvent, createClaudeActivityWriter, createClaudeSessionIdParser, resolveClaudeModel, normalizeProvider } from "../adapter.js";
import { createClaudeHooks, createDefaultClaudeHooks } from "../deploy.js";

interface StubAdapterOpts {
  exitCode: number;
  errorMessage?: string;
}

function createStubAdapter(opts: StubAdapterOpts): RuntimeAdapter {
  return {
    name: "claude",
    defaultModel: "stub/model",
    sessionFileName: "session-id-claude.txt",
    installHooks() {},
    spawn(spawnOpts): SpawnResult {
      return { sessionId: spawnOpts.deployId, exitCode: opts.exitCode, ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}) };
    },
    resume(spawnOpts): SpawnResult {
      return { sessionId: spawnOpts.sessionId, exitCode: opts.exitCode, ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}) };
    },
    extractActivity(): ActivityEvent[] {
      return [];
    },
    describeTools() {
      return { runtime: "claude", markdown: "stub" };
    },
  };
}

function withCpaEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cpa-adapter-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n`);
  writeFileSync(join(teams, "daily.yaml"), `name: daily\ndescription: Daily\nobjective: Plan\nagents:\n  - name: team-manager\n    role: manage\ndeploy_modes:\n  - id: plan\n    label: Plan\n`);
  const previous = {
    config: process.env["PA_PLATFORM_CONFIG"],
    teams: process.env["PA_PLATFORM_TEAMS"],
    registry: process.env["PA_REGISTRY_DB"],
    aiUsage: process.env["PA_AI_USAGE_HOME"],
    maxRuntime: process.env["PA_MAX_RUNTIME"],
    cpaModel: process.env["PA_CPA_DEFAULT_MODEL"],
  };
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  delete process.env["PA_MAX_RUNTIME"];
  delete process.env["PA_CPA_DEFAULT_MODEL"];
  return fn(root).finally(() => {
    closeDb();
    restore("PA_PLATFORM_CONFIG", previous.config);
    restore("PA_PLATFORM_TEAMS", previous.teams);
    restore("PA_REGISTRY_DB", previous.registry);
    restore("PA_AI_USAGE_HOME", previous.aiUsage);
    restore("PA_MAX_RUNTIME", previous.maxRuntime);
    restore("PA_CPA_DEFAULT_MODEL", previous.cpaModel);
    rmSync(root, { recursive: true, force: true });
  });
}

function writeBuilderTeamConfig(root: string): void {
  writeFileSync(join(root, "teams", "builder.yaml"), [
    "name: builder",
    "description: Builder",
    "default_mode: implement",
    "objective: Build",
    "agents:",
    "  - name: builder-agent",
    "    role: Builds things",
    "deploy_modes:",
    "  - id: implement",
    "    label: Implement",
    "    mode_type: work",
    "    provider: anthropic",
    "    model: claude-sonnet-4-6",
    "  - id: review",
    "    label: Review",
    "    mode_type: review",
    "    provider: anthropic",
    "    model: claude-haiku-4-5-20251001",
  ].join("\n"));
}

function readDryRunBody(root: string, stdout: string[]): string {
  const deployId = stdout.join("\n").match(/d-[a-f0-9]{6}/)?.[0];
  assert.ok(deployId);
  const activity = readActivityEvents(join(root, "deployments", deployId, "activity.jsonl"));
  return activity.map((event) => event.body).join("\n");
}

test("resolveClaudeModel honors precedence (model > env > default)", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(resolveClaudeModel("anthropic", undefined, env), "claude-opus-4-7");
  assert.equal(resolveClaudeModel(undefined, undefined, env), "claude-opus-4-7");
  assert.equal(resolveClaudeModel("anthropic", "claude-sonnet-4-6", env), "claude-sonnet-4-6");
  assert.equal(resolveClaudeModel("anthropic", undefined, { PA_CPA_DEFAULT_MODEL: "claude-haiku-4-5-20251001" }), "claude-haiku-4-5-20251001");
  // CLI/argument model wins over env override.
  assert.equal(resolveClaudeModel("anthropic", "claude-sonnet-4-6", { PA_CPA_DEFAULT_MODEL: "claude-haiku-4-5-20251001" }), "claude-sonnet-4-6");
});

test("normalizeProvider accepts anthropic/undefined and rejects others", () => {
  assert.equal(normalizeProvider(undefined), "anthropic");
  assert.equal(normalizeProvider("anthropic"), "anthropic");
  assert.throws(() => normalizeProvider("openai"), /Unsupported cpa provider: openai/);
  assert.throws(() => normalizeProvider("minimax"), /Supported providers: anthropic/);
});

test("cpa tool guidance describes anthropic-only provider", () => {
  const guidance = new ClaudeCodeAdapter().describeTools().markdown;
  assert.match(guidance, /Runtime: Claude Code via `cpa`/);
  assert.match(guidance, /Use `pa-core serve` for Agent API server lifecycle/);
  assert.match(guidance, /Supported provider for `cpa deploy`: `anthropic`/);
  assert.match(guidance, /claude-opus-4-7/);
});

test("cpa dry-run generates primer with claude runtime and does not spawn claude", async () => {
  await withCpaEnv(async (root) => {
    const adapter = new ClaudeCodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--dry-run"], { hooks: createClaudeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } });
    assert.equal(code, 0);
    assert.deepEqual(stderr, []);
    const deployId = stdout.join("\n").match(/d-[a-f0-9]{6}/)?.[0];
    assert.ok(deployId);
    assert.ok(existsSync(join(root, "deployments", deployId, "primer.md")));
    assert.match(readFileSync(join(root, "deployments", deployId, "primer.md"), "utf-8"), /Runtime: claude/);
    assert.equal(queryDeploymentStatuses().length, 0);
  });
});

test("cpa dry-run picks up builder mode YAML model", async () => {
  await withCpaEnv(async (root) => {
    writeBuilderTeamConfig(root);
    const adapter = new ClaudeCodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];
    const code = await runCoreCommand(["deploy", "builder", "--mode", "implement", "--dry-run"], { hooks: createClaudeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
    assert.equal(code, 0);
    assert.match(readDryRunBody(root, stdout), /using claude-sonnet-4-6/);
  });
});

test("cpa dry-run defaults builder to implement mode YAML model", async () => {
  await withCpaEnv(async (root) => {
    writeBuilderTeamConfig(root);
    const adapter = new ClaudeCodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];
    const code = await runCoreCommand(["deploy", "builder", "--dry-run"], { hooks: createClaudeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
    assert.equal(code, 0);
    assert.match(readDryRunBody(root, stdout), /using claude-sonnet-4-6/);
  });
});

test("cpa rejects non-anthropic provider before spawning claude", async () => {
  await withCpaEnv(async () => {
    const adapter = new ClaudeCodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stderr: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "openai"], { hooks: createClaudeHooks(adapter), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
    assert.notEqual(code, 0);
    assert.match(stderr.join("\n"), /Unsupported cpa provider: openai/);
  });
});

test("cpa supports --list-modes and --validate", async () => {
  await withCpaEnv(async () => {
    const adapter = new ClaudeCodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const modesOut: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--list-modes"], { hooks: createClaudeHooks(adapter), io: { stdout: (line) => modesOut.push(line), stderr: () => {} } }), 0);
    assert.match(modesOut.join("\n"), /plan/);

    const validateOut: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--validate"], { hooks: createClaudeHooks(adapter), io: { stdout: (line) => validateOut.push(line), stderr: () => {} } }), 0);
    assert.match(validateOut.join("\n"), /Valid team config: daily/);
  });
});

test("cpa default hooks expose deploy without serve", () => {
  const hooks = createDefaultClaudeHooks();
  assert.equal(typeof hooks.deploy, "function");
  assert.equal(hooks.serve, undefined);
});

test("cpa background deploy records pid and session id", async () => {
  await withCpaEnv(async (root) => {
    let seenArgs: string[] = [];
    const adapter = new ClaudeCodeAdapter({
      runCommand: () => { throw new Error("foreground should not run"); },
      runBackgroundCommand: (args) => {
        seenArgs = args;
        return { pid: 4242, sessionId: "claude-session-bg" };
      },
    });
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--background"], { hooks: createClaudeHooks(adapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.equal(code, 0);
    assert.ok(seenArgs.includes("-p"));
    assert.ok(seenArgs.includes("--output-format"));
    assert.ok(seenArgs.includes("stream-json"));
    assert.ok(seenArgs.includes("--verbose"));
    assert.ok(seenArgs.includes("--dangerously-skip-permissions"));
    assert.ok(seenArgs.includes("--model"));
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.status, "running");
    assert.equal(deployment.pid, 4242);
    assert.equal(deployment.runtime, "claude");
    assert.equal(deployment.provider, "anthropic");
    assert.equal(readFileSync(join(root, "deployments", deployment.deploy_id, "session-id-claude.txt"), "utf-8"), "claude-session-bg");
  });
});

test("cpa --resume happy path passes --resume to claude", async () => {
  await withCpaEnv(async (root) => {
    const priorId = "d-prior1";
    const priorDir = join(root, "deployments", priorId);
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, "session-id-claude.txt"), "session-prior-token");
    let resumeArgs: string[] = [];
    const adapter = new ClaudeCodeAdapter({
      runCommand: () => { throw new Error("foreground should not run"); },
      runBackgroundCommand: (args) => {
        resumeArgs = args;
        return { pid: 4343, sessionId: "session-prior-token" };
      },
    });
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--background", "--resume", priorId], { hooks: createClaudeHooks(adapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.equal(code, 0);
    const resumeIdx = resumeArgs.indexOf("--resume");
    assert.notEqual(resumeIdx, -1);
    assert.equal(resumeArgs[resumeIdx + 1], "session-prior-token");
  });
});

test("cpa --resume errors when no session id was recorded", async () => {
  await withCpaEnv(async (root) => {
    const priorId = "d-noses";
    const priorDir = join(root, "deployments", priorId);
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, "primer.md"), "stub primer");
    const adapter = new ClaudeCodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stderr: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--resume", priorId], { hooks: createClaudeHooks(adapter), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
    assert.notEqual(code, 0);
    assert.match(stderr.join("\n"), /no claude session id recorded/);
  });
});

test("cpa --resume rejects opencode session files with redirect to opa", async () => {
  await withCpaEnv(async (root) => {
    const priorId = "d-openc";
    const priorDir = join(root, "deployments", priorId);
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, "session-id-opencode.txt"), "opencode-token");
    const adapter = new ClaudeCodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stderr: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--resume", priorId], { hooks: createClaudeHooks(adapter), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
    assert.notEqual(code, 0);
    assert.match(stderr.join("\n"), /was launched by opencode/);
    assert.match(stderr.join("\n"), /opa deploy --resume d-openc/);
  });
});

test("cpa foreground captures real claude stderr on non-zero exit", async () => {
  await withCpaEnv(async (root) => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const claude = join(bin, "claude");
    writeFileSync(claude, `#!/bin/sh
echo "claude auth failed: invalid token" >&2
echo "context: refresh failed" >&2
exit 9
`, "utf-8");
    chmodSync(claude, 0o755);
    const previousPath = process.env["PATH"];
    process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
    const previousStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await runCoreCommand(["deploy", "daily", "--mode", "plan"], { hooks: createClaudeHooks(new ClaudeCodeAdapter()), io: { stdout: () => {}, stderr: () => {} } });
      assert.notEqual(code, 0);
      const deployment = queryDeploymentStatuses()[0]!;
      assert.equal(deployment.status, "failed");
      assert.match(deployment.summary ?? "", /exit 9/);
      assert.match(deployment.summary ?? "", /claude auth failed: invalid token/);
      const activity = readFileSync(join(root, "deployments", deployment.deploy_id, "activity.jsonl"), "utf-8").trim().split("\n");
      const errorLine = activity.map((row) => JSON.parse(row) as Record<string, unknown>).find((row) => row["kind"] === "error");
      assert.ok(errorLine, "expected an error-kind activity event");
      assert.match(String(errorLine["body"]), /claude auth failed: invalid token/);
      assert.equal(existsSync(join(root, "deployments", deployment.deploy_id, "session-id-claude.txt")), false);
    } finally {
      process.stderr.write = previousStderrWrite;
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
    }
  });
});

test("cpa stub deploy emits terminal activity event", async () => {
  await withCpaEnv(async (root) => {
    const adapter = createStubAdapter({ exitCode: 0 });
    const stdout: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan"], { hooks: createClaudeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
    assert.equal(code, 0);
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.runtime, "claude");
    assert.equal(deployment.provider, "anthropic");
    const activity = readFileSync(join(root, "deployments", deployment.deploy_id, "activity.jsonl"), "utf-8").trim().split("\n");
    const terminal = JSON.parse(activity.at(-1)!) as Record<string, unknown>;
    assert.equal(terminal["kind"], "text");
    assert.match(String(terminal["body"]), /claude exited with code 0/);
  });
});

test("cpa stub deploy emits error event and registry summary on failure", async () => {
  await withCpaEnv(async (root) => {
    const adapter = createStubAdapter({ exitCode: 3, errorMessage: "model auth failed" });
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan"], { hooks: createClaudeHooks(adapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.notEqual(code, 0);
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.status, "failed");
    assert.match(deployment.summary ?? "", /exit 3/);
    assert.match(deployment.summary ?? "", /model auth failed/);
    const activity = readFileSync(join(root, "deployments", deployment.deploy_id, "activity.jsonl"), "utf-8").trim().split("\n");
    const errorLine = activity.map((row) => JSON.parse(row) as Record<string, unknown>).find((row) => row["kind"] === "error");
    assert.ok(errorLine);
    assert.match(String(errorLine["body"]), /model auth failed/);
  });
});

test("claude JSONL maps assistant text to text activity", () => {
  const event = claudeJsonToActivityEvent({
    type: "assistant",
    session_id: "abcdef12-3456-7890-abcd-ef1234567890",
    message: { content: [{ type: "text", text: "hello world" }] },
  }, "d-live");
  assert.equal(event.deployId, "d-live");
  assert.equal(event.kind, "text");
  assert.equal(event.partType, "text");
  assert.equal(event.source, "abcdef12");
  assert.equal(event.body, "hello world");
});

test("claude JSONL maps thinking and tool_use parts", () => {
  const thinking = claudeJsonToActivityEvent({
    type: "assistant",
    session_id: "ses1",
    message: { content: [{ type: "thinking", thinking: "let me think" }] },
  }, "d-live");
  assert.equal(thinking.kind, "thinking");
  assert.match(thinking.body, /let me think/);

  const toolUse = claudeJsonToActivityEvent({
    type: "assistant",
    session_id: "ses1",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
  }, "d-live");
  assert.equal(toolUse.kind, "tool_use");
  assert.match(toolUse.body, /Bash ls -la/);
});

test("claude JSONL maps system init and result success", () => {
  const init = claudeJsonToActivityEvent({ type: "system", subtype: "init", session_id: "abcdef12-xxxx" }, "d-live");
  assert.equal(init.kind, "text");
  assert.match(init.body, /system init/);

  const result = claudeJsonToActivityEvent({ type: "result", subtype: "success", result: "all good", session_id: "ses1" }, "d-live");
  assert.equal(result.kind, "text");
  assert.match(result.body, /all good/);

  const errorResult = claudeJsonToActivityEvent({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "ses1" }, "d-live");
  assert.equal(errorResult.kind, "error");
});

test("claude JSONL masks sensitive tokens in stream bodies", () => {
  const longSecret = `Bearer abc123 ${"x".repeat(700)}`;
  const event = claudeJsonToActivityEvent({
    type: "assistant",
    session_id: "ses1",
    message: { content: [{ type: "thinking", thinking: longSecret }] },
  }, "d-live");
  assert.equal(event.kind, "thinking");
  assert.match(event.body, /\[REDACTED\]/);
  assert.equal(event.body.includes("abc123"), false);
  assert.ok(event.body.length <= 500);
});

test("createClaudeActivityWriter appends split JSONL chunks", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-activity-"));
  try {
    const activityPath = join(root, "activity.jsonl");
    mkdirSync(dirname(activityPath), { recursive: true });
    const writer = createClaudeActivityWriter("d-live", activityPath);
    const line = JSON.stringify({ type: "assistant", session_id: "abcdef12", message: { content: [{ type: "text", text: "hi" }] } });
    writer.write(line.slice(0, 18));
    writer.write(line.slice(18) + "\n");
    writer.flush();
    const rows = readFileSync(activityPath, "utf-8").trim().split("\n").map((row) => JSON.parse(row) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["kind"], "text");
    assert.equal(rows[0]?.["body"], "hi");
    assert.equal(rows[0]?.["source"], "abcdef12");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createClaudeSessionIdParser handles chunks split mid-line", () => {
  const line = JSON.stringify({ type: "system", subtype: "init", session_id: "abcdef12-3456-7890-abcd-ef1234567890" });
  const parser = createClaudeSessionIdParser();
  parser.write(line.slice(0, 18));
  parser.write(line.slice(18) + "\n");
  assert.equal(parser.flush(), "abcdef12-3456-7890-abcd-ef1234567890");
});

test("createClaudeSessionIdParser ignores partial session_id matches across chunks", () => {
  const parser = createClaudeSessionIdParser();
  parser.write('{"session_id":"ses_par');
  parser.write('tial_complete"}\n');
  assert.equal(parser.flush(), "ses_partial_complete");
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
