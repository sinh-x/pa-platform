import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { closeDb, createActivityEvent, appendActivityEvent, getDeployPaths, type ActivityEvent, type SpawnOpts, type ResumeOpts, type ToolReference } from "@pa-platform/pa-core";
import { DroidCodeAdapter, resolveDroidAutonomy, resolveDroidModel, resolveDefaultDroidModel } from "../adapter.js";
import { createDroidHooks, createDefaultDroidHooks, deployWithDroid } from "../deploy.js";
import { installDroidSafetyScript, installDroidSafetyPatterns } from "../plugins/pa-droid-safety.js";
import { DroidMessageType, AutonomyLevel, ToolConfirmationOutcome, type DroidSession, type DroidStreamMessage } from "@factory/droid-sdk";

const TEST_API_KEY = "changeme";

interface FakeSessionOptions {
  modelId: string;
  cwd: string;
  env: Record<string, string>;
  apiKey: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

interface FakeResumeOptions {
  apiKey: string;
  env: Record<string, string>;
  abortSignal?: AbortSignal;
}

function fakeSessionId(): string {
  return `ses_${Math.random().toString(36).slice(2, 10)}`;
}

function fakeStream(messages: DroidStreamMessage[]): DroidSession {
  const id = fakeSessionId();
  const session = {
    sessionId: id,
    initResult: { settings: { modelId: "test-model" }, cwd: "/test" },
    stream: async function* (): AsyncGenerator<DroidStreamMessage, void, undefined> {
      for (const msg of messages) yield msg;
    },
    interrupt: async () => {},
    close: async () => {},
    updateSettings: async () => ({}),
  } as unknown as DroidSession;
  return session;
}

function textDelta(text: string): DroidStreamMessage {
  return { type: "assistant_text_delta" as DroidMessageType, text } as unknown as DroidStreamMessage;
}

function textComplete(text: string): DroidStreamMessage {
  return { type: "assistant_text_complete" as DroidMessageType, text } as unknown as DroidStreamMessage;
}

function toolCall(name: string, input: Record<string, unknown>): DroidStreamMessage {
  return { type: "tool_call" as DroidMessageType, name, input } as unknown as DroidStreamMessage;
}

function toolResult(content: string): DroidStreamMessage {
  return { type: "tool_result" as DroidMessageType, content: [{ type: "text", text: content }] } as unknown as DroidStreamMessage;
}

function resultMsg(subtype: string): DroidStreamMessage {
  return { type: "result" as DroidMessageType, subtype } as unknown as DroidStreamMessage;
}

function errorMsg(message: string): DroidStreamMessage {
  return { type: "error" as DroidMessageType, message } as unknown as DroidStreamMessage;
}

describe("DroidCodeAdapter", () => {
  let root: string;
  let deployDir: string;
  let primerPath: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "dpa-test-"));
    deployDir = resolve(root, "deployments", "d-test01");
    mkdirSync(deployDir, { recursive: true });
    primerPath = resolve(deployDir, "primer.md");
    writeFileSync(primerPath, "# Test Primer\n\nDo the test work.", "utf-8");
  });

  after(() => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // best-effort cleanup
    }
  });

  it("has correct runtime name", () => {
    const adapter = new DroidCodeAdapter({ cwd: "/test" });
    assert.equal(adapter.name, "droid");
    assert.equal(adapter.sessionFileName, "session-id-droid.txt");
  });

  it("defaults model to deepseek-v4-pro", () => {
    const adapter = new DroidCodeAdapter({ cwd: "/test" });
    assert.equal(adapter.defaultModel, "deepseek-v4-pro");
  });

  it("uses PA_DPA_DEFAULT_MODEL override", () => {
    const adapter = new DroidCodeAdapter({ cwd: "/test", env: { PA_DPA_DEFAULT_MODEL: "gpt-5.5" } });
    assert.equal(adapter.defaultModel, "gpt-5.5");
  });

  it("produces tool reference", () => {
    const adapter = new DroidCodeAdapter({ cwd: "/test" });
    const ref = adapter.describeTools();
    assert.equal(ref.runtime, "droid");
    assert.ok(ref.markdown.includes("dpa"));
    assert.ok(ref.markdown.includes("Droid"));
  });

  it("installHooks is a no-op", () => {
    const adapter = new DroidCodeAdapter({ cwd: "/test" });
    adapter.installHooks("/target", { deploymentId: "d-test", deploymentDir: "/target", activityLogPath: "/target/activity.jsonl" });
    // No error means success
  });

  it("fails fast when FACTORY_API_KEY is missing", async () => {
    const adapter = new DroidCodeAdapter({ cwd: "/test", env: {} });
    const result = await adapter.spawn({
      primerPath,
      deployId: "d-test01",
      mode: "foreground",
      model: "deepseek-v4-pro",
      logFile: resolve(deployDir, "test.log"),
      env: {},
    });
    assert.equal(result.exitCode, 1);
    assert.ok(result.errorMessage?.includes("FACTORY_API_KEY"));
  });

  it("spawn creates session and captures activity", async () => {
    const messages: DroidStreamMessage[] = [
      textDelta("Analyzing "),
      textDelta("code..."),
      textComplete("Analyzing code..."),
      toolCall("Read", { filePath: "src/test.ts" }),
      toolResult("file content here"),
      resultMsg("success"),
    ];

    const adapter = new DroidCodeAdapter({
      cwd: "/test",
      env: { FACTORY_API_KEY: TEST_API_KEY },
      sessionFactory: async () => fakeStream(messages),
    });

    const result = await adapter.spawn({
      primerPath,
      deployId: "d-test01",
      mode: "foreground",
      model: "deepseek-v4-pro",
      logFile: resolve(deployDir, "test.log"),
      env: {},
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.sessionId, "sessionId should be captured");
    assert.ok(result.sessionId!.startsWith("ses_"));

    // Activity log should have events
    const activityPath = getDeployPaths("d-test01").activityLogPath;
    assert.ok(existsSync(activityPath), "activity log should exist");
    const content = readFileSync(activityPath, "utf-8");
    assert.ok(content.includes("text"), "activity log should contain text events");
    assert.ok(content.includes("tool_use") || content.includes("Read"), "activity log should contain tool_use events");
    assert.ok(content.includes("success"), "activity log should contain result");
  });

  it("saves session-id file on success", async () => {
    const messages: DroidStreamMessage[] = [
      textComplete("done"),
      resultMsg("success"),
    ];

    const adapter = new DroidCodeAdapter({
      cwd: "/test",
      env: { FACTORY_API_KEY: TEST_API_KEY },
      sessionFactory: async () => fakeStream(messages),
    });

    const result = await adapter.spawn({
      primerPath,
      deployId: "d-test01",
      mode: "foreground",
      model: "deepseek-v4-pro",
      logFile: resolve(deployDir, "test.log"),
      env: {},
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.sessionId);
  });

  it("recovers from stream errors", async () => {
    const session = fakeStream([]);
    session.stream = async function* (): AsyncGenerator<DroidStreamMessage, void, undefined> {
      yield textDelta("working...");
      throw new Error("stream crashed");
    };

    const adapter = new DroidCodeAdapter({
      cwd: "/test",
      env: { FACTORY_API_KEY: TEST_API_KEY },
      sessionFactory: async () => session,
    });

    const result = await adapter.spawn({
      primerPath,
      deployId: "d-test01",
      mode: "foreground",
      model: "deepseek-v4-pro",
      logFile: resolve(deployDir, "test.log"),
      env: {},
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errorMessage?.includes("stream crashed"));
  });

  it("extractActivity reads droid-output.jsonl", () => {
    const adapter = new DroidCodeAdapter({ cwd: "/test" });
    const outputPath = resolve(deployDir, "droid-output.jsonl");
    writeFileSync(outputPath, [
      JSON.stringify({ type: "text", body: "hello", deployId: "d-test01" }),
      JSON.stringify({ type: "tool_use", body: "Read file", deployId: "d-test01" }),
      JSON.stringify({ type: "error", body: "fail", deployId: "d-test01" }),
    ].join("\n") + "\n", "utf-8");

    const events = adapter.extractActivity(deployDir);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.kind, "text");
    assert.equal(events[1]?.kind, "tool_use");
    assert.equal(events[2]?.kind, "error");
  });

  it("extractActivity returns empty for missing file", () => {
    const adapter = new DroidCodeAdapter({ cwd: "/test" });
    const events = adapter.extractActivity("/nonexistent/path");
    assert.equal(events.length, 0);
  });

  it("runs injected runBackgroundCommand for background mode", async () => {
    let calledArgs: string[] | undefined;
    const adapter = new DroidCodeAdapter({
      cwd: "/test",
      env: { FACTORY_API_KEY: TEST_API_KEY },
      runBackgroundCommand: (args) => {
        calledArgs = args;
        return { pid: 4242 };
      },
      sessionFactory: async () => fakeStream([textComplete("done"), resultMsg("success")]),
    });

    const logFile = resolve(root, "bg-test.log");
    const result = await adapter.spawn({
      primerPath,
      deployId: "d-bgtest",
      mode: "background",
      model: "deepseek-v4-pro",
      logFile,
      env: {},
    });

    assert.equal(result.exitCode, 0);
    assert.ok(calledArgs, "runBackgroundCommand should be called");
    assert.equal(calledArgs![0], "deepseek-v4-pro");
    assert.equal(calledArgs![1], primerPath);
    assert.equal(result.metadata?.pid, 4242);
  });

  it("returns sessionId from injected runBackgroundCommand", async () => {
    const adapter = new DroidCodeAdapter({
      cwd: "/test",
      env: { FACTORY_API_KEY: TEST_API_KEY },
      runBackgroundCommand: () => ({ pid: 1234, sessionId: "ses_bg" }),
      sessionFactory: async () => fakeStream([textComplete("done"), resultMsg("success")]),
    });

    const logFile = resolve(root, "bg-session.log");
    const result = await adapter.spawn({
      primerPath,
      deployId: "d-bgsession",
      mode: "background",
      model: "deepseek-v4-pro",
      logFile,
      env: {},
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, "ses_bg");
  });

  it("background mode does not throw when runBackgroundCommand is injected", async () => {
    const adapter = new DroidCodeAdapter({
      cwd: "/test",
      env: { FACTORY_API_KEY: TEST_API_KEY },
      runBackgroundCommand: () => ({ pid: 5678 }),
      sessionFactory: async () => fakeStream([textComplete("done"), resultMsg("success")]),
    });

    const logFile = resolve(root, "bg-nothrow.log");
    let errorThrown = false;
    try {
      await adapter.spawn({
        primerPath,
        deployId: "d-bgnothrow",
        mode: "background",
        model: "deepseek-v4-pro",
        logFile,
        env: {},
      });
    } catch {
      errorThrown = true;
    }
    assert.equal(errorThrown, false, "background deploy should not throw");
  });
});

describe("resolveDroidModel", () => {
  it("returns explicit model as-is when no slash", () => {
    assert.equal(resolveDroidModel("claude-opus-4-8"), "claude-opus-4-8");
  });

  it("strips provider prefix from opencode-style model ids", () => {
    assert.equal(resolveDroidModel("deepseek/deepseek-v4-pro"), "deepseek-v4-pro");
  });

  it("uses mode runtimes.droid.model when no explicit model", () => {
    assert.equal(resolveDroidModel(undefined, { modeRuntimes: { model: "gpt-5.5" } }), "gpt-5.5");
  });

  it("uses team runtimes.droid.model as fallback after mode runtimes", () => {
    assert.equal(resolveDroidModel(undefined, { teamRuntimes: { model: "claude-sonnet-4-6" } }), "claude-sonnet-4-6");
  });

  it("mode runtimes wins over team runtimes", () => {
    assert.equal(resolveDroidModel(undefined, { modeRuntimes: { model: "gpt-5.5" }, teamRuntimes: { model: "claude-opus-4-8" } }), "gpt-5.5");
  });

  it("uses PA_DPA_DEFAULT_MODEL after runtimes", () => {
    assert.equal(resolveDroidModel(undefined, { env: { PA_DPA_DEFAULT_MODEL: "claude-sonnet-4-6" } }), "claude-sonnet-4-6");
  });

  it("mode runtimes wins over PA_DPA_DEFAULT_MODEL", () => {
    assert.equal(resolveDroidModel(undefined, { modeRuntimes: { model: "gpt-5.5" }, env: { PA_DPA_DEFAULT_MODEL: "claude-sonnet-4-6" } }), "gpt-5.5");
  });

  it("returns platform config default after env", () => {
    assert.equal(resolveDroidModel(undefined, { platformDefaults: { model: "gpt-5.5" } }), "gpt-5.5");
  });

  it("PA_DPA_DEFAULT_MODEL wins over platform config default", () => {
    assert.equal(resolveDroidModel(undefined, { platformDefaults: { model: "gpt-5.5" }, env: { PA_DPA_DEFAULT_MODEL: "claude-sonnet-4-6" } }), "claude-sonnet-4-6");
  });

  it("falls back to deepseek-v4-pro when nothing is set", () => {
    assert.equal(resolveDroidModel(undefined, {}), "deepseek-v4-pro");
  });

  it("explicit model wins over runtimes", () => {
    assert.equal(resolveDroidModel("gemini-3.5-flash", { modeRuntimes: { model: "gpt-5.5" } }), "gemini-3.5-flash");
  });

  it("explicit model wins over all other options (full precedence)", () => {
    assert.equal(resolveDroidModel("claude-haiku-4-5-20251001", {
      modeRuntimes: { model: "gpt-5.5" },
      teamRuntimes: { model: "claude-opus-4-8" },
      env: { PA_DPA_DEFAULT_MODEL: "claude-sonnet-4-6" },
      platformDefaults: { model: "minimax-m2.7" },
    }), "claude-haiku-4-5-20251001");
  });

  it("full precedence: mode runtimes > team runtimes > env > platform > deepseek", () => {
    assert.equal(resolveDroidModel(undefined, {
      teamRuntimes: { model: "claude-opus-4-8" },
      env: { PA_DPA_DEFAULT_MODEL: "claude-sonnet-4-6" },
      platformDefaults: { model: "minimax-m2.7" },
    }), "claude-opus-4-8");
  });
});

describe("resolveDefaultDroidModel", () => {
  it("returns deepseek-v4-pro by default", () => {
    assert.equal(resolveDefaultDroidModel({}), "deepseek-v4-pro");
  });

  it("returns env override", () => {
    assert.equal(resolveDefaultDroidModel({ PA_DPA_DEFAULT_MODEL: "gpt-5.5" }), "gpt-5.5");
  });
});

describe("resolveDroidAutonomy", () => {
  it("defaults to medium", () => {
    assert.equal(resolveDroidAutonomy({}), "medium");
  });

  it("cliFlag wins over env var (AC6)", () => {
    assert.equal(resolveDroidAutonomy({
      cliFlag: "low",
      env: { PA_DPA_AUTONOMY: "high" },
    }), "low");
  });

  it("cliFlag wins over mode runtimes", () => {
    assert.equal(resolveDroidAutonomy({
      cliFlag: "high",
      modeRuntimes: { autonomy: "low" },
    }), "high");
  });

  it("cliFlag wins over team runtimes", () => {
    assert.equal(resolveDroidAutonomy({
      cliFlag: "high",
      teamRuntimes: { autonomy: "low" },
    }), "high");
  });

  it("cliFlag wins over platform defaults", () => {
    assert.equal(resolveDroidAutonomy({
      cliFlag: "low",
      platformDefaults: { autonomy: "high" },
    }), "low");
  });

  it("uses PA_DPA_AUTONOMY env var", () => {
    assert.equal(resolveDroidAutonomy({ env: { PA_DPA_AUTONOMY: "medium" } }), "medium");
  });

  it("PA_DPA_AUTONOMY wins over runtimes", () => {
    assert.equal(resolveDroidAutonomy({
      env: { PA_DPA_AUTONOMY: "medium" },
      modeRuntimes: { autonomy: "low" },
    }), "medium");
  });

  it("mode runtimes win over team runtimes", () => {
    assert.equal(resolveDroidAutonomy({
      modeRuntimes: { autonomy: "low" },
      teamRuntimes: { autonomy: "high" },
    }), "low");
  });

  it("team runtimes win over platform defaults", () => {
    assert.equal(resolveDroidAutonomy({
      teamRuntimes: { autonomy: "medium" },
      platformDefaults: { autonomy: "high" },
    }), "medium");
  });

  it("platform defaults win over hard default", () => {
    assert.equal(resolveDroidAutonomy({ platformDefaults: { autonomy: "low" } }), "low");
  });

  it("full precedence: cliFlag > PA_DPA_AUTONOMY > mode runtime > team runtime > platform > medium", () => {
    assert.equal(resolveDroidAutonomy({
      cliFlag: "high",
      env: { PA_DPA_AUTONOMY: "medium" },
      modeRuntimes: { autonomy: "low" },
      teamRuntimes: { autonomy: "high" },
      platformDefaults: { autonomy: "low" },
    }), "high");
  });

  it("invalid cliFlag falls through to env var", () => {
    assert.equal(resolveDroidAutonomy({
      cliFlag: "invalid",
      env: { PA_DPA_AUTONOMY: "low" },
    }), "low");
  });

  it("invalid cliFlag falls through to mode runtimes", () => {
    assert.equal(resolveDroidAutonomy({
      cliFlag: "SUPER_HIGH",
      modeRuntimes: { autonomy: "medium" },
    }), "medium");
  });

  it("invalid cliFlag falls through to default when no other source", () => {
    assert.equal(resolveDroidAutonomy({ cliFlag: "nonsense" }), "medium");
  });

  it("valid cliFlag with mixed case is normalized", () => {
    assert.equal(resolveDroidAutonomy({
      cliFlag: "HIGH",
      env: { PA_DPA_AUTONOMY: "low" },
    }), "high");
  });
});

describe("createDroidHooks", () => {
  it("creates hooks with deploy function", () => {
    const hooks = createDefaultDroidHooks();
    assert.ok(hooks.deploy);
    assert.equal(typeof hooks.deploy, "function");
  });

  it("creates hooks with custom adapter", () => {
    const adapter = new DroidCodeAdapter({ cwd: "/test", env: { FACTORY_API_KEY: TEST_API_KEY } });
    const hooks = createDroidHooks(adapter);
    assert.ok(hooks.deploy);
  });
});

function runHookScript(scriptPath: string, input: Record<string, unknown>, env: Record<string, string>): { exitCode: number; stderr: string; activityPath: string } {
  const deployDir = env["PA_DEPLOYMENT_DIR"]!;
  const activityPath = join(deployDir, "activity.jsonl");
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    childEnv[key] = value;
  }
  // Clear parent-level PA env vars that would override test dir
  delete childEnv["PA_ACTIVITY_LOG"];
  childEnv["PA_DEPLOYMENT_DIR"] = deployDir;
  childEnv["PA_DEPLOYMENT_ID"] = env["PA_DEPLOYMENT_ID"]!;
  childEnv["FACTORY_DIR"] = childEnv["FACTORY_DIR"] ?? join(env["HOME"]!, ".factory");
  const result = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: childEnv,
    timeout: 5000,
  });
  return { exitCode: result.status ?? 0, stderr: result.stderr ?? "", activityPath };
}

describe("droid safety hook tool summaries", () => {
  let hookRoot: string;
  let deployDir: string;
  let scriptPath: string;

  before(() => {
    hookRoot = mkdtempSync(join(tmpdir(), "dpa-hook-test-"));
    const homeDir = join(hookRoot, "home");
    const factoryDir = join(homeDir, ".factory");
    mkdirSync(factoryDir, { recursive: true });
    deployDir = join(hookRoot, "deployments", "d-test-hook");
    mkdirSync(deployDir, { recursive: true });
    scriptPath = installDroidSafetyScript({ HOME: homeDir });
    installDroidSafetyPatterns({ HOME: homeDir });
  });

  after(() => {
    try { rmSync(hookRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best-effort */ }
  });

  function baseEnv(): Record<string, string> {
    return {
      HOME: join(hookRoot, "home"),
      PA_DEPLOYMENT_ID: "d-test-hook",
      PA_DEPLOYMENT_DIR: deployDir,
    };
  }

  function readLastActivityLine(): Record<string, unknown> | undefined {
    const p = join(deployDir, "activity.jsonl");
    if (!existsSync(p)) return undefined;
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    if (lines.length === 0) return undefined;
    return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  }

  function readActivityLineCount(): number {
    const p = join(deployDir, "activity.jsonl");
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf-8").split("\n").filter(Boolean).length;
  }

  it("summarizes Task tool with subagent_type and description", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "worker", description: "Fix login bug" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.tool, "Task");
    assert.ok(String(data.summary).includes("worker"), `summary should include subagent_type: ${data.summary}`);
    assert.ok(String(data.summary).includes("Fix login bug"), `summary should include description: ${data.summary}`);
  });

  it("summarizes Skill tool with skill name", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: { skill: "pa-startup" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.tool, "Skill");
    assert.ok(String(data.summary).includes("pa-startup"), `summary should include skill name: ${data.summary}`);
  });

  it("summarizes AskUser with questionnaire first line", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "AskUser",
      tool_input: { questionnaire: "1. [question] Which approach?\n[topic] Approach\n[option] A\n[option] B" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.tool, "AskUser");
    assert.ok(String(data.summary).includes("Which approach?"), `summary should include first question line: ${data.summary}`);
    assert.ok(!String(data.summary).includes("[topic]"), `summary should NOT include topic line: ${data.summary}`);
  });

  it("summarizes ExitSpecMode with plan title", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "ExitSpecMode",
      tool_input: { plan: "## Implementation Plan\n\nPhase 1: Do the thing", title: "" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.tool, "ExitSpecMode");
    assert.ok(String(data.summary).includes("Implementation Plan"), `summary should include plan title: ${data.summary}`);
  });

  it("summarizes ToolSearch with query", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "ToolSearch",
      tool_input: { query: "select:figma_mcp" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.tool, "ToolSearch");
    assert.ok(String(data.summary).includes("select:figma_mcp"), `summary should include query: ${data.summary}`);
  });

  it("summarizes GenerateDroid with description", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "GenerateDroid",
      tool_input: { description: "A security review droid" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.tool, "GenerateDroid");
    assert.ok(String(data.summary).includes("security review"), `summary should include description: ${data.summary}`);
  });

  it("preserves existing Execute summary", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Execute",
      tool_input: { command: "pnpm build" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.tool, "Execute");
    assert.ok(String(data.summary).includes("pnpm build"));
  });

  it("extracts exit code from response.exitCode", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "Execute",
      tool_input: { command: "pnpm build" },
      tool_response: { exitCode: 1, result: "build failed" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.kind, "error");
    assert.equal(data.exitCode, 1);
  });

  it("extracts exit code from response.result.exitCode", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "Execute",
      tool_input: { command: "pnpm test" },
      tool_response: { result: { exitCode: 2, stdout: "fail" } },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.kind, "error");
    assert.equal(data.exitCode, 2);
  });

  it("extracts exit code from response.result.metadata.exitCode", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "Execute",
      tool_input: { command: "pnpm lint" },
      tool_response: { result: { metadata: { exitCode: 3 }, stdout: "errors" } },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.kind, "error");
    assert.equal(data.exitCode, 3);
  });

  it("classifies zero exit code as info (not error)", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "Execute",
      tool_input: { command: "pnpm build" },
      tool_response: { exitCode: 0, result: "build ok" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.kind, "info");
    assert.equal(data.exitCode, 0);
  });

  it("normalizes string exitCode to number in PostToolUse", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "Execute",
      tool_input: { command: "pnpm build" },
      tool_response: { exitCode: "0", result: "build ok" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 0);
    assert.equal(readActivityLineCount(), before + 1);
    const line = readLastActivityLine();
    const data = line!.data as Record<string, unknown>;
    assert.equal(data.kind, "info");
    assert.equal(data.exitCode, 0);
  });

  it("blocks destructive commands with exit code 2", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Execute",
      tool_input: { command: "rm -rf /important" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("BLOCKED"), `stderr should contain BLOCKED: ${result.stderr}`);
    // No new activity written for blocked calls
    assert.equal(readActivityLineCount(), before);
  });

  it("blocks sensitive file access with exit code 2", () => {
    const before = readActivityLineCount();
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/home/user/.env" },
    };
    const result = runHookScript(scriptPath, input, baseEnv());
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("BLOCKED"), `stderr should contain BLOCKED: ${result.stderr}`);
    assert.equal(readActivityLineCount(), before);
  });
});

describe("droid safety hook masking", () => {
  let hookRoot: string;
  let deployDir: string;
  let scriptPath: string;

  before(() => {
    hookRoot = mkdtempSync(join(tmpdir(), "dpa-mask-test-"));
    const homeDir = join(hookRoot, "home");
    const factoryDir = join(homeDir, ".factory");
    mkdirSync(factoryDir, { recursive: true });
    deployDir = join(hookRoot, "deployments", "d-test-mask");
    mkdirSync(deployDir, { recursive: true });
    scriptPath = installDroidSafetyScript({ HOME: homeDir });
    installDroidSafetyPatterns({ HOME: homeDir });
  });

  after(() => {
    try { rmSync(hookRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best-effort */ }
  });

  function baseEnv(): Record<string, string> {
    return {
      HOME: join(hookRoot, "home"),
      PA_DEPLOYMENT_ID: "d-test-mask",
      PA_DEPLOYMENT_DIR: deployDir,
    };
  }

  function readActivitySummary(): string {
    const p = join(deployDir, "activity.jsonl");
    if (!existsSync(p)) return "";
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    if (lines.length === 0) return "";
    const data = (JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>).data as Record<string, unknown>;
    return String(data.summary ?? "");
  }

  it("masks API key field names in summaries", () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Execute",
      tool_input: { command: "curl -H 'api_key=TESTKEY123' https://api.example.com" },
    };
    runHookScript(scriptPath, input, baseEnv());
    const summary = readActivitySummary();
    assert.ok(summary.includes("REDACTED"), `summary should redact api_key field name: ${summary}`);
    assert.ok(!summary.includes("api_key"), `summary should NOT contain raw api_key: ${summary}`);
  });

  it("masks bearer tokens with value", () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Execute",
      tool_input: { command: "curl -H 'Authorization: Bearer test_token_12345' https://api.example.com" },
    };
    runHookScript(scriptPath, input, baseEnv());
    const summary = readActivitySummary();
    assert.ok(summary.includes("REDACTED"), `summary should redact bearer token: ${summary}`);
    assert.ok(!summary.includes("test_token"), `summary should NOT contain raw bearer value: ${summary}`);
  });

  it("masks sk-ant keys", () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Execute",
      tool_input: { command: "export TEST_VAR=" + String.fromCharCode(115,107,45,97,110,116,45) + "test01-xxxxxxxxxxxxxxxxxxxx" },
    };
    runHookScript(scriptPath, input, baseEnv());
    const summary = readActivitySummary();
    assert.ok(summary.includes("REDACTED"), `summary should redact sk-ant key: ${summary}`);
    assert.ok(!summary.includes(String.fromCharCode(115,107,45,97,110,116,45)), `summary should NOT contain raw sk-ant pattern: ${summary}`);
  });

  it("masks fk- keys (FK_KEY pattern)", () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Execute",
      tool_input: { command: "export TEST_VAR=" + String.fromCharCode(102,107,45) + "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
    };
    runHookScript(scriptPath, input, baseEnv());
    const summary = readActivitySummary();
    assert.ok(summary.includes("REDACTED"), `summary should redact fk key: ${summary}`);
    assert.ok(!summary.includes(String.fromCharCode(102,107,45)), `summary should NOT contain raw fk key: ${summary}`);
  });

  it("masks password field names in summaries", () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Execute",
      tool_input: { command: "mysql -u root -password=test123456" },
    };
    runHookScript(scriptPath, input, baseEnv());
    const summary = readActivitySummary();
    assert.ok(summary.includes("REDACTED"), `summary should redact password field: ${summary}`);
    assert.ok(!summary.includes("password"), `summary should NOT contain raw password field: ${summary}`);
  });
});

function withDpaEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "dpa-deploy-env-"));
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
    home: process.env["HOME"],
  };
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["HOME"] = root;
  return fn(root).finally(() => {
    closeDb();
    restoreEnv("PA_PLATFORM_CONFIG", previous.config);
    restoreEnv("PA_PLATFORM_TEAMS", previous.teams);
    restoreEnv("PA_REGISTRY_DB", previous.registry);
    restoreEnv("PA_AI_USAGE_HOME", previous.aiUsage);
    restoreEnv("HOME", previous.home);
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("dpa deploy memory-doc injection (MIN-3/FR-4)", () => {
  it("droid dry-run retains full memory-doc bodies (droid native load unconfirmed, OQ-1)", async () => {
    await withDpaEnv(async (root) => {
      writeFileSync(join(root, "repo", "CLAUDE.md"), "# Repo Memory\nKeep this content visible to droid.\n");
      const adapter = new DroidCodeAdapter({ cwd: join(root, "repo"), env: { FACTORY_API_KEY: TEST_API_KEY } });
      const result = await deployWithDroid({ team: "daily", mode: "plan", dryRun: true, repo: "pa-platform" }, adapter);
      assert.equal(result.status, "pending");
      const deploymentId = result.deploymentId;
      assert.ok(deploymentId);
      const primerPath = join(root, "deployments", deploymentId, "primer.md");
      assert.ok(existsSync(primerPath), "primer must be written on dry-run");
      const primer = readFileSync(primerPath, "utf-8");
      assert.match(primer, /## Memory Docs/);
      assert.match(primer, /<memory-doc path=.*CLAUDE\.md">/);
      // droid defaults to FULL injection (MEMORY_DOC_POINTER_MODE = false, OQ-1 unconfirmed)
      assert.match(primer, /Keep this content visible to droid/);
      assert.doesNotMatch(primer, /loaded natively by droid/);
    });
  });
});

describe("dpa deploy env-vars injection (MIN-C)", () => {
  it("droid dry-run deployment-context block includes pa_env_vars subsection", async () => {
    await withDpaEnv(async (root) => {
      writeFileSync(join(root, "repo", "CLAUDE.md"), "# Repo Memory\nKeep this content visible to droid.\n");
      const adapter = new DroidCodeAdapter({ cwd: join(root, "repo"), env: { FACTORY_API_KEY: TEST_API_KEY } });
      const result = await deployWithDroid({ team: "daily", mode: "plan", dryRun: true, repo: "pa-platform", ticket: "DG-211", provider: "deepseek", model: "deepseek-v4-pro", teamModel: "deepseek-chat", agentModel: "deepseek-coder" }, adapter);
      assert.equal(result.status, "pending");
      const deploymentId = result.deploymentId;
      assert.ok(deploymentId);
      const primerPath = join(root, "deployments", deploymentId, "primer.md");
      const primer = readFileSync(primerPath, "utf-8");
      assert.match(primer, /pa_env_vars:/);
      assert.match(primer, /PA_DEPLOYMENT_ID: d-[a-f0-9]{6}/);
      assert.match(primer, /PA_DEPLOYMENT_DIR: .+deployments\/d-[a-f0-9]{6}/);
      assert.match(primer, /PA_ACTIVITY_LOG: .+activity\.jsonl/);
      assert.match(primer, /PA_TEAM: daily/);
      assert.match(primer, /PA_MODE: plan/);
      assert.match(primer, /PA_TICKET_ID: DG-211/);
      assert.match(primer, /PA_REPO:/);
      assert.match(primer, /PA_PROVIDER: deepseek/);
      assert.match(primer, /PA_MODEL: deepseek-v4-pro/);
      assert.match(primer, /PA_TEAM_MODEL: deepseek-chat/);
      assert.match(primer, /PA_AGENT_MODEL: deepseek-coder/);
    });
  });
});
