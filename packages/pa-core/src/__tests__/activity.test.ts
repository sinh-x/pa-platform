import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendActivityEvent, createActivityEvent, getActivityLogPath, readActivityEvents, readDeploymentActivity, summarizeActivity, writeActivityEvents } from "../index.js";

test("activity module writes, reads, and summarizes standard events", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-"));
  try {
    const deploymentDir = join(root, "d-activity");
    const logPath = getActivityLogPath("d-activity", deploymentDir);
    const events = [
      createActivityEvent({ deployId: "d-activity", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "hello", partType: "text" }),
      createActivityEvent({ deployId: "d-activity", timestamp: "2026-04-26T00:00:01.000Z", kind: "tool_use", source: "opencode", body: "Read" }),
    ];
    writeActivityEvents(events, logPath);
    appendActivityEvent(createActivityEvent({ deployId: "d-activity", timestamp: "2026-04-26T00:00:02.000Z", kind: "error", source: "opencode", body: "failed" }), logPath);
    const read = readDeploymentActivity("d-activity", deploymentDir);
    assert.equal(read.length, 3);
    const summary = summarizeActivity(read);
    assert.equal(summary.total, 3);
    assert.equal(summary.byKind.text, 1);
    assert.equal(summary.byKind.tool_use, 1);
    assert.equal(summary.byKind.error, 1);
    assert.equal(summary.bySource.opencode, 3);
    assert.equal(read[0]?.partType, "text");
    assert.equal(summary.firstTimestamp, "2026-04-26T00:00:00.000Z");
    assert.equal(summary.lastTimestamp, "2026-04-26T00:00:02.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readActivityEvents tolerates opencode plugin schema", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-plugin-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-plugin", agent: "opencode", event: "session_started", data: { session: "ses_abc" } }),
      JSON.stringify({ ts: 1714000001000, deploy_id: "d-plugin", agent: "opencode", event: "tool_call", data: { part: { type: "tool" }, tool: "Bash", description: "ls" } }),
      JSON.stringify({ ts: 1714000002000, deploy_id: "d-plugin", agent: "opencode", event: "tool_success", data: { tool: "Bash" } }),
      JSON.stringify({ ts: 1714000003000, deploy_id: "d-plugin", agent: "opencode", event: "session_error", data: { message: "boom" } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 4);
    assert.equal(events[0]?.deployId, "d-plugin");
    assert.equal(events[0]?.source, "opencode");
    assert.equal(events[0]?.kind, "text");
    assert.equal(events[0]?.timestamp, new Date(1714000000000).toISOString());
    assert.equal(events[1]?.kind, "tool_use");
    assert.equal(events[2]?.kind, "tool_result");
    assert.equal(events[3]?.kind, "error");
    assert.match(events[1]?.body ?? "", /tool_call/);
    assert.equal(events[1]?.partType, "tool");
    assert.deepEqual(events[1]?.metadata, { part: { type: "tool" }, tool: "Bash", description: "ls" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent maps message.part.updated by part content and type", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-part-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      // Text part
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-part", agent: "opencode", event: "message.part.updated", data: { part: { type: "text", content: "hello world" } } }),
      // Thinking part
      JSON.stringify({ ts: 1714000001000, deploy_id: "d-part", agent: "opencode", event: "message.part.updated", data: { part: { type: "thinking", content: "<thinking>reasoning</thinking>" } } }),
      // Tool use part
      JSON.stringify({ ts: 1714000002000, deploy_id: "d-part", agent: "opencode", event: "message.part.updated", data: { part: { type: "tool_use", content: "Bash ls" } } }),
      // Tool result part
      JSON.stringify({ ts: 1714000003000, deploy_id: "d-part", agent: "opencode", event: "message.part.updated", data: { part: { type: "tool_result", content: "file1.txt\nfile2.txt" } } }),
      // Error part
      JSON.stringify({ ts: 1714000004000, deploy_id: "d-part", agent: "opencode", event: "message.part.updated", data: { part: { type: "text", content: "error: something failed" } } }),
      // Reasoning content (auto-detected as thinking even without thinking type)
      JSON.stringify({ ts: 1714000005000, deploy_id: "d-part", agent: "opencode", event: "message.part.updated", data: { part: { type: "text", content: "<reasoning>deep thought</reasoning>" } } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 6);
    assert.equal(events[0]?.kind, "text");
    assert.equal(events[0]?.partType, "text");
    assert.equal(events[1]?.kind, "thinking");
    assert.equal(events[2]?.kind, "tool_use");
    assert.equal(events[3]?.kind, "tool_result");
    assert.equal(events[4]?.kind, "error");
    assert.equal(events[5]?.kind, "thinking");
    // Metadata preserved
    assert.deepEqual(events[0]?.metadata, { part: { type: "text", content: "hello world" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent maps file.edited to tool_result", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-file-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-file", agent: "opencode", event: "file.edited", data: { file: "src/index.ts", tool: "Edit" } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "tool_result");
    assert.match(events[0]?.body ?? "", /file.edited/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent maps lsp.client.diagnostics by severity", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-lsp-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      // Error diagnostic → error kind
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-lsp", agent: "opencode", event: "lsp.client.diagnostics", data: { diagnostics: [{ severity: 1, message: "undefined variable" }] } }),
      // Warning only → text kind
      JSON.stringify({ ts: 1714000001000, deploy_id: "d-lsp", agent: "opencode", event: "lsp.client.diagnostics", data: { diagnostics: [{ severity: 2, message: "unused import" }] } }),
      // No severity → text kind
      JSON.stringify({ ts: 1714000002000, deploy_id: "d-lsp", agent: "opencode", event: "lsp.client.diagnostics", data: { diagnostics: [{ message: "info message" }] } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.kind, "error");
    assert.equal(events[1]?.kind, "text");
    assert.equal(events[2]?.kind, "text");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent maps tool error to error kind", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-tool-err-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-tool-err", agent: "opencode", event: "tool_error", data: { tool: "Bash", message: "command failed" } }),
      JSON.stringify({ ts: 1714000001000, deploy_id: "d-tool-err", agent: "opencode", event: "tool.execute.after", data: { tool: "Bash", error: "exit code 1" } }),
      JSON.stringify({ ts: 1714000002000, deploy_id: "d-tool-err", agent: "opencode", event: "tool.execute.after", data: { tool: "Bash", exitCode: 1 } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.kind, "error");
    assert.equal(events[1]?.kind, "error");
    assert.equal(events[2]?.kind, "error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent maps zero exit codes to tool_result", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-tool-zero-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-tool-zero", agent: "opencode", event: "tool.execute.after", data: { tool: "Bash", exitCode: 0, result: "ok" } }),
      JSON.stringify({ ts: 1714000001000, deploy_id: "d-tool-zero", agent: "opencode", event: "tool.execute.after", data: { tool: "Bash", exit_code: 0, result: "ok" } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, "tool_result");
    assert.equal(events[1]?.kind, "tool_result");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent maps session events to text or error", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-session-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-session", agent: "opencode", event: "session.created", data: { session: "ses_abc" } }),
      JSON.stringify({ ts: 1714000001000, deploy_id: "d-session", agent: "opencode", event: "session.updated", data: {} }),
      JSON.stringify({ ts: 1714000002000, deploy_id: "d-session", agent: "opencode", event: "session.error", data: { message: "session crashed" } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.kind, "text");
    assert.equal(events[1]?.kind, "text");
    assert.equal(events[2]?.kind, "error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent applies secret masking to body", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-mask-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-mask", agent: "opencode", event: "tool_call", data: { token: "sk-secret123", tool: "Bash", description: "ls sk-secret123" } }),
      JSON.stringify({ ts: 1714000001000, deploy_id: "d-mask", agent: "opencode", event: "message.updated", data: { message: "Using bearer abc123 token" } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 2);
    assert.match(events[0]?.body ?? "", /\[REDACTED\]/);
    assert.match(events[0]?.body ?? "", /tool_call/);
    assert.match(events[1]?.body ?? "", /\[REDACTED\]/);
    // Original token not present in body
    assert.equal((events[0]?.body ?? "").includes("sk-secret123"), false);
    // But metadata preserves original (FR-4: preserve raw metadata)
    assert.equal(events[0]?.metadata && typeof events[0]?.metadata === "object" ? (events[0]?.metadata as Record<string, unknown>)["token"] : undefined, "sk-secret123");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent produces safe text for unknown events", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-unknown-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-unknown", agent: "opencode", event: "unknown.event.custom", data: { foo: "bar" } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "text");
    assert.match(events[0]?.body ?? "", /unknown.event.custom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent maps TUI and permission events to text", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-ui-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const lines = [
      JSON.stringify({ ts: 1714000000000, deploy_id: "d-ui", agent: "opencode", event: "tui.toast.show", data: { message: "Deploy started" } }),
      JSON.stringify({ ts: 1714000001000, deploy_id: "d-ui", agent: "opencode", event: "permission.asked", data: { tool: "Bash" } }),
      JSON.stringify({ ts: 1714000002000, deploy_id: "d-ui", agent: "opencode", event: "tui.command.execute", data: { command: "deploy" } }),
      JSON.stringify({ ts: 1714000003000, deploy_id: "d-ui", agent: "opencode", event: "installation.updated", data: { version: "1.0.0" } }),
    ].join("\n") + "\n";
    writeFileSync(logPath, lines);
    const events = readActivityEvents(logPath);
    assert.equal(events.length, 4);
    assert.equal(events[0]?.kind, "text");
    assert.equal(events[1]?.kind, "text");
    assert.equal(events[2]?.kind, "tool_use");
    assert.equal(events[3]?.kind, "text");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeActivityEvent summarizes documented opencode plugin events", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-activity-documented-"));
  try {
    const logPath = join(root, "activity.jsonl");
    const documentedEvents = [
      { event: "message.part.updated", data: { part: { type: "thinking", thinking: "reasoning with bearer abc123" } }, kind: "thinking", body: /part=thinking.*\[REDACTED\]/ },
      { event: "message.updated", data: { message: { role: "assistant" }, text: "final answer" }, kind: "text", body: /role=assistant.*final answer/ },
      { event: "message.part.removed", data: { partId: "p1", messageId: "m1" }, kind: "text", body: /partId=p1/ },
      { event: "message.removed", data: { messageId: "m1" }, kind: "text", body: /messageId=m1/ },
      { event: "tool.execute.before", data: { tool: "bash", args: { command: "pnpm test" } }, kind: "tool_use", body: /tool=bash.*pnpm test/ },
      { event: "tool.execute.after", data: { tool: "bash", result: "ok" }, kind: "tool_result", body: /tool=bash.*ok/ },
      { event: "tool.execute.after", data: { tool: "bash", error: "failed" }, kind: "error", body: /tool=bash.*failed/ },
      { event: "session.created", data: { sessionId: "ses_1", title: "new" }, kind: "text", body: /sessionId=ses_1/ },
      { event: "session.updated", data: { title: "renamed" }, kind: "text", body: /renamed/ },
      { event: "session.status", data: { status: "busy" }, kind: "text", body: /busy/ },
      { event: "session.idle", data: { status: "idle" }, kind: "text", body: /idle/ },
      { event: "session.compacted", data: { message: "compacted" }, kind: "text", body: /compacted/ },
      { event: "session.diff", data: { diff: "+ changed" }, kind: "text", body: /changed/ },
      { event: "session.deleted", data: { sessionId: "ses_1" }, kind: "text", body: /ses_1/ },
      { event: "session.error", data: { error: "session failed" }, kind: "error", body: /session failed/ },
      { event: "permission.asked", data: { tool: "bash", message: "allow?" }, kind: "text", body: /allow/ },
      { event: "permission.replied", data: { decision: "approved" }, kind: "text", body: /approved/ },
      { event: "todo.updated", data: { todos: [{ content: "one" }, { content: "two" }] }, kind: "text", body: /items=2/ },
      { event: "command.executed", data: { command: "deploy" }, kind: "tool_result", body: /deploy/ },
      { event: "file.edited", data: { file: "/repo/src/index.ts", tool: "edit" }, kind: "tool_result", body: /src\/index\.ts/ },
      { event: "file.watcher.updated", data: { file: "/repo/.env", change: "changed" }, kind: "text", body: /\[REDACTED_FILE\]/ },
      { event: "lsp.client.diagnostics", data: { diagnostics: [{ severity: 1, message: "type error" }, { severity: 2, message: "warning" }] }, kind: "error", body: /diagnostics=2.*type error/ },
      { event: "lsp.updated", data: { server: "tsserver", status: "ready" }, kind: "text", body: /tsserver/ },
      { event: "installation.updated", data: { version: "1.2.3" }, kind: "text", body: /1\.2\.3/ },
      { event: "server.connected", data: { url: "http://localhost:4096" }, kind: "text", body: /localhost/ },
      { event: "tui.prompt.append", data: { text: "user prompt" }, kind: "text", body: /user prompt/ },
      { event: "tui.command.execute", data: { command: "help" }, kind: "tool_use", body: /help/ },
      { event: "tui.toast.show", data: { title: "Notice", message: "saved" }, kind: "text", body: /Notice.*saved/ },
    ];
    writeFileSync(logPath, documentedEvents.map(({ event, data }, idx) => JSON.stringify({ ts: 1714000000000 + idx, deploy_id: "d-doc", agent: "opencode", event, data })).join("\n") + "\n");
    const events = readActivityEvents(logPath);
    assert.equal(events.length, documentedEvents.length);
    for (const [idx, expected] of documentedEvents.entries()) {
      assert.equal(events[idx]?.kind, expected.kind, expected.event);
      assert.match(events[idx]?.body ?? "", expected.body, expected.event);
      assert.ok((events[idx]?.body ?? "").length <= 500, expected.event);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
