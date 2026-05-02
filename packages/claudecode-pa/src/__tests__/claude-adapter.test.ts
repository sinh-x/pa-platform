import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { closeDb, queryDeploymentStatuses, readActivityEvents, runCoreCommand, type ActivityEvent, type RuntimeAdapter, type SpawnResult } from "@pa-platform/pa-core";
import { spawnSync } from "node:child_process";
import { ClaudeCodeAdapter, claudeJsonToActivityEvent, createClaudeActivityWriter, createClaudeSessionIdParser, resolveClaudeModel, normalizeProvider } from "../adapter.js";
import { createClaudeHooks, createDefaultClaudeHooks } from "../deploy.js";
import { installPaClaudeHooks, PA_CLAUDE_HOOK_EVENTS, PA_CLAUDE_HOOKS_HANDLER_FILENAME, PA_CLAUDE_HOOKS_HANDLER_SOURCE, resolvePaClaudeHooksHandlerPath, resolvePaClaudeSettingsPath } from "../plugins/pa-claude-hooks.js";

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
    home: process.env["HOME"],
  };
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  // Pin HOME to the tmpdir so adapter.installHooks writes its hook artifacts under
  // <root>/.claude rather than the operator's real ~/.claude/settings.json.
  process.env["HOME"] = root;
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
    restore("HOME", previous.home);
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

function withTempHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "cpa-hooks-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function readSettingsJson(home: string): { hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>> } & Record<string, unknown> {
  const raw = readFileSync(join(home, ".claude", "settings.json"), "utf-8");
  return JSON.parse(raw) as { hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>> } & Record<string, unknown>;
}

function countEntriesWithCommand(entries: Array<{ hooks?: Array<{ command?: string }> }> | undefined, command: string): number {
  if (!entries) return 0;
  let count = 0;
  for (const entry of entries) {
    const inner = entry.hooks ?? [];
    if (inner.some((h) => h.command === command)) count += 1;
  }
  return count;
}

function runHandlerSubprocess(handlerPath: string, payload: unknown, env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(payload),
    env,
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("installPaClaudeHooks idempotency over 5 consecutive runs", () => {
  withTempHome((home) => {
    for (let i = 0; i < 5; i++) installPaClaudeHooks({ HOME: home });
    const handlerPath = resolvePaClaudeHooksHandlerPath({ HOME: home });
    assert.equal(handlerPath, join(home, ".claude", "hooks", PA_CLAUDE_HOOKS_HANDLER_FILENAME));
    assert.ok(existsSync(handlerPath));
    const settings = readSettingsJson(home);
    for (const eventName of PA_CLAUDE_HOOK_EVENTS) {
      assert.equal(countEntriesWithCommand(settings.hooks?.[eventName], handlerPath), 1, `expected exactly one ${eventName} entry for cpa handler after 5 runs`);
    }
  });
});

test("installPaClaudeHooks preserves pre-existing user hooks and unrelated keys", () => {
  withTempHome((home) => {
    const settingsPath = resolvePaClaudeSettingsPath({ HOME: home });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      theme: "dark",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/audit.sh" }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "/usr/local/bin/log-prompt.sh" }] },
        ],
      },
    }, null, 2));
    installPaClaudeHooks({ HOME: home });
    const settings = readSettingsJson(home);
    assert.equal(settings["theme"], "dark");
    const userPreEntry = settings.hooks?.PreToolUse?.find((entry) => (entry.hooks ?? []).some((h) => h.command === "/usr/local/bin/audit.sh"));
    assert.ok(userPreEntry, "pre-existing PreToolUse user hook must be retained");
    const userPromptEntry = (settings.hooks?.["UserPromptSubmit"] ?? []).find((entry) => (entry.hooks ?? []).some((h) => h.command === "/usr/local/bin/log-prompt.sh"));
    assert.ok(userPromptEntry, "unrelated UserPromptSubmit hook must be retained");
    const handlerPath = resolvePaClaudeHooksHandlerPath({ HOME: home });
    assert.equal(countEntriesWithCommand(settings.hooks?.PreToolUse, handlerPath), 1);
    assert.equal(countEntriesWithCommand(settings.hooks?.PostToolUse, handlerPath), 1);
    assert.equal(countEntriesWithCommand(settings.hooks?.Stop, handlerPath), 1);
  });
});

test("installPaClaudeHooks creates handler script with shebang for node invocation", () => {
  withTempHome((home) => {
    installPaClaudeHooks({ HOME: home });
    const handlerPath = resolvePaClaudeHooksHandlerPath({ HOME: home });
    const source = readFileSync(handlerPath, "utf-8");
    assert.ok(source.startsWith("#!/usr/bin/env node"), "handler must be self-executable via env-resolved node");
    assert.equal(source, PA_CLAUDE_HOOKS_HANDLER_SOURCE);
  });
});

test("installPaClaudeHooks rejects malformed settings.json instead of clobbering", () => {
  withTempHome((home) => {
    const settingsPath = resolvePaClaudeSettingsPath({ HOME: home });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{ this is not json", "utf-8");
    assert.throws(() => installPaClaudeHooks({ HOME: home }), /cannot parse/);
    // The original file must remain untouched so the operator can fix it manually.
    assert.equal(readFileSync(settingsPath, "utf-8"), "{ this is not json");
  });
});

test("pa-activity handler appends tool.execute.before with masked command and preserves payload-shape", () => {
  withTempHome((home) => {
    installPaClaudeHooks({ HOME: home });
    const handlerPath = resolvePaClaudeHooksHandlerPath({ HOME: home });
    const deployDir = join(home, "deploy");
    mkdirSync(deployDir, { recursive: true });
    const activityPath = join(deployDir, "activity.jsonl");
    const command = "curl -H 'Authorization: Bearer sk-ant-secrettoken' https://api.example.com";
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: "abcdef12-3456-7890-abcd-ef1234567890",
      tool_name: "Bash",
      tool_input: { command },
    };
    const result = runHandlerSubprocess(handlerPath, payload, {
      ...process.env,
      HOME: home,
      PA_DEPLOYMENT_ID: "d-test1",
      PA_ACTIVITY_LOG: activityPath,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", "handler must not write to stdout — would mutate Claude Code's tool stream");
    const lines = readFileSync(activityPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]!) as { event: string; agent: string; deploy_id: string; data: { tool: string; args: { command: string }; summary: string } };
    assert.equal(event.event, "tool.execute.before");
    assert.equal(event.agent, "abcdef12");
    assert.equal(event.deploy_id, "d-test1");
    assert.equal(event.data.tool, "Bash");
    assert.match(event.data.args.command, /\*\*\*BEARER_MASKED\*\*\*/);
    assert.equal(event.data.args.command.includes("sk-ant-secrettoken"), false);
    assert.match(event.data.summary, /\*\*\*BEARER_MASKED\*\*\*/);
    // The handler reads the raw payload via stdin and writes a *derived* log entry. The
    // payload that Claude Code actually executes is unaffected — assert by checking we
    // never echoed the input back on stdout (which would mutate the tool stream).
  });
});

test("pa-activity handler appends tool.execute.after with masked result", () => {
  withTempHome((home) => {
    installPaClaudeHooks({ HOME: home });
    const handlerPath = resolvePaClaudeHooksHandlerPath({ HOME: home });
    const activityPath = join(home, "deploy", "activity.jsonl");
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: "abcdef12",
      tool_name: "Bash",
      tool_use_id: "tool_use_42",
      tool_response: { exitCode: 0, output: "Authorization: Bearer sk-ant-leaked" },
    };
    const result = runHandlerSubprocess(handlerPath, payload, {
      ...process.env,
      HOME: home,
      PA_DEPLOYMENT_ID: "d-test2",
      PA_ACTIVITY_LOG: activityPath,
    });
    assert.equal(result.status, 0);
    const event = JSON.parse(readFileSync(activityPath, "utf-8").trim()) as { event: string; data: { tool: string; tool_use_id: string; summary: string } };
    assert.equal(event.event, "tool.execute.after");
    assert.equal(event.data.tool_use_id, "tool_use_42");
    assert.match(event.data.summary, /exit_code=0/);
  });
});

test("pa-activity handler emits session.stop record on Stop event (registry completion path)", () => {
  withTempHome((home) => {
    installPaClaudeHooks({ HOME: home });
    const handlerPath = resolvePaClaudeHooksHandlerPath({ HOME: home });
    const activityPath = join(home, "deploy", "activity.jsonl");
    const result = runHandlerSubprocess(handlerPath, {
      hook_event_name: "Stop",
      session_id: "abcdef12",
      stop_hook_active: false,
      transcript_path: "/tmp/transcript.jsonl",
    }, { ...process.env, HOME: home, PA_DEPLOYMENT_ID: "d-stop", PA_ACTIVITY_LOG: activityPath });
    assert.equal(result.status, 0);
    const event = JSON.parse(readFileSync(activityPath, "utf-8").trim()) as { event: string; agent: string; data: { transcript_path: string; stop_hook_active: boolean } };
    assert.equal(event.event, "session.stop");
    assert.equal(event.agent, "abcdef12");
    assert.equal(event.data.transcript_path, "/tmp/transcript.jsonl");
    assert.equal(event.data.stop_hook_active, false);
  });
});

test("pa-activity handler tolerates missing sensitive-patterns.conf with built-in fallback", () => {
  withTempHome((home) => {
    installPaClaudeHooks({ HOME: home });
    const handlerPath = resolvePaClaudeHooksHandlerPath({ HOME: home });
    // No sensitive-patterns.conf present in <home>/.claude/hooks/.
    assert.equal(existsSync(join(home, ".claude", "hooks", "sensitive-patterns.conf")), false);
    const activityPath = join(home, "deploy", "activity.jsonl");
    const command = "echo Authorization: Bearer sk-ant-fallback-only";
    const result = runHandlerSubprocess(handlerPath, {
      hook_event_name: "PreToolUse",
      session_id: "abcdef12",
      tool_name: "Bash",
      tool_input: { command },
    }, { ...process.env, HOME: home, PA_DEPLOYMENT_ID: "d-fb", PA_ACTIVITY_LOG: activityPath });
    assert.equal(result.status, 0);
    const event = JSON.parse(readFileSync(activityPath, "utf-8").trim()) as { data: { args: { command: string }; summary: string } };
    assert.match(event.data.args.command, /\*\*\*BEARER_MASKED\*\*\*/);
    assert.equal(event.data.args.command.includes("sk-ant-fallback-only"), false);
  });
});

test("pa-activity handler honors operator's sensitive-patterns.conf overrides", () => {
  withTempHome((home) => {
    installPaClaudeHooks({ HOME: home });
    const handlerPath = resolvePaClaudeHooksHandlerPath({ HOME: home });
    const patternsPath = join(home, ".claude", "hooks", "sensitive-patterns.conf");
    writeFileSync(patternsPath, [
      "# operator-defined patterns",
      "CUSTOM|MY_SECRET=[A-Za-z0-9]+",
      "BEARER|Authorization: Bearer [^ ]+",
    ].join("\n"));
    const activityPath = join(home, "deploy", "activity.jsonl");
    const result = runHandlerSubprocess(handlerPath, {
      hook_event_name: "PreToolUse",
      session_id: "abcdef12",
      tool_name: "Bash",
      tool_input: { command: "MY_SECRET=Abc123XYZ run-app" },
    }, { ...process.env, HOME: home, PA_DEPLOYMENT_ID: "d-cfg", PA_ACTIVITY_LOG: activityPath });
    assert.equal(result.status, 0);
    const event = JSON.parse(readFileSync(activityPath, "utf-8").trim()) as { data: { args: { command: string } } };
    assert.match(event.data.args.command, /\*\*\*CUSTOM_MASKED\*\*\*/);
    assert.equal(event.data.args.command.includes("Abc123XYZ"), false);
  });
});

test("ClaudeCodeAdapter.installHooks invokes installPaClaudeHooks on real adapter", async () => {
  await withCpaEnv(async (root) => {
    const adapter = new ClaudeCodeAdapter({ env: { ...process.env, HOME: root } as NodeJS.ProcessEnv });
    adapter.installHooks(join(root, "deploy"), { deploymentId: "d-wire", deploymentDir: join(root, "deploy"), activityLogPath: join(root, "deploy", "activity.jsonl") });
    const handlerPath = resolvePaClaudeHooksHandlerPath({ HOME: root });
    assert.ok(existsSync(handlerPath));
    const settings = readSettingsJson(root);
    for (const eventName of PA_CLAUDE_HOOK_EVENTS) {
      assert.equal(countEntriesWithCommand(settings.hooks?.[eventName], handlerPath), 1);
    }
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
