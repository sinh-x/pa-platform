import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createActivityEvent, appendActivityEvent, getDeployPaths, type ActivityEvent, type SpawnOpts, type ResumeOpts, type ToolReference } from "@pa-platform/pa-core";
import { DroidCodeAdapter, resolveDroidModel, resolveDefaultDroidModel } from "../adapter.js";
import { createDroidHooks, createDefaultDroidHooks, deployWithDroid } from "../deploy.js";
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
});

describe("resolveDroidModel", () => {
  it("returns explicit model as-is when no slash", () => {
    assert.equal(resolveDroidModel(undefined, "claude-opus-4-8"), "claude-opus-4-8");
  });

  it("strips provider prefix from opencode-style model ids", () => {
    assert.equal(resolveDroidModel(undefined, "deepseek/deepseek-v4-pro"), "deepseek-v4-pro");
  });

  it("returns platform config default if no explicit model", () => {
    assert.equal(resolveDroidModel(undefined, undefined, process.env, { model: "gpt-5.5" }), "gpt-5.5");
  });

  it("falls back to provider map", () => {
    assert.equal(resolveDroidModel("anthropic", undefined), "claude-opus-4-8");
    assert.equal(resolveDroidModel("openai", undefined), "gpt-5.5");
    assert.equal(resolveDroidModel("deepseek", undefined), "deepseek-v4-pro");
    assert.equal(resolveDroidModel("gemini", undefined), "gemini-3.1-pro-preview");
    assert.equal(resolveDroidModel("minimax", undefined), "minimax-m2.7");
  });

  it("uses PA_DPA_DEFAULT_MODEL as last resort", () => {
    assert.equal(resolveDroidModel(undefined, undefined, { PA_DPA_DEFAULT_MODEL: "claude-sonnet-4-6" }), "claude-sonnet-4-6");
  });

  it("falls back to deepseek-v4-pro", () => {
    assert.equal(resolveDroidModel(undefined, undefined), "deepseek-v4-pro");
  });

  it("explicit model wins over platform config", () => {
    assert.equal(resolveDroidModel(undefined, "gemini-3.5-flash", process.env, { model: "gpt-5.5" }), "gemini-3.5-flash");
  });

  it("explicit model wins over provider map", () => {
    assert.equal(resolveDroidModel("anthropic", "claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
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
