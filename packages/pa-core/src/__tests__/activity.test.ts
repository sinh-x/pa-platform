import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendActivityEvent, createActivityEvent, getActivityLogPath, readDeploymentActivity, summarizeActivity, writeActivityEvents } from "../index.js";

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
