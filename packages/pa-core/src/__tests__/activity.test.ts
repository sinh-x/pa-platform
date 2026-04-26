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
      createActivityEvent({ deployId: "d-activity", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "hello" }),
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
      JSON.stringify({ ts: 1714000001000, deploy_id: "d-plugin", agent: "opencode", event: "tool_call", data: { tool: "Bash", description: "ls" } }),
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
    assert.deepEqual(events[1]?.metadata, { tool: "Bash", description: "ls" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
