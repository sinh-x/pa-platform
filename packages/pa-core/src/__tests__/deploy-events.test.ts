import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRegistryEvent, closeDb, getDeploymentEvents } from "../index.js";
import { ensureTerminalRegistryMarker, OPA_WRAPPER_FALLBACK_SUMMARY } from "../deploy/events.js";

function withTempRegistry(fn: () => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-core-deploy-events-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    fn();
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("ensureTerminalRegistryMarker writes fallback completed event when terminal marker is missing", () => {
  withTempRegistry(() => {
    appendRegistryEvent({
      deployment_id: "d-missing-terminal",
      team: "builder",
      event: "started",
      timestamp: "2026-05-06T10:00:00Z",
    });

    const result = ensureTerminalRegistryMarker({ deploymentId: "d-missing-terminal", team: "builder" });
    assert.equal(result.wroteFallback, true);

    const events = getDeploymentEvents("d-missing-terminal");
    assert.equal(events.length, 2);
    const fallbackEvent = events[1];
    assert.equal(fallbackEvent?.event, "completed");
    assert.equal(fallbackEvent?.status, "partial");
    assert.equal(fallbackEvent?.fallback, true);
    assert.equal(fallbackEvent?.summary, OPA_WRAPPER_FALLBACK_SUMMARY);
  });
});

test("ensureTerminalRegistryMarker skips when completed terminal event exists", () => {
  withTempRegistry(() => {
    appendRegistryEvent({
      deployment_id: "d-completed-terminal",
      team: "builder",
      event: "started",
      timestamp: "2026-05-06T10:00:00Z",
    });
    appendRegistryEvent({
      deployment_id: "d-completed-terminal",
      team: "builder",
      event: "completed",
      timestamp: "2026-05-06T10:01:00Z",
      status: "success",
      summary: "agent completed",
    });

    const result = ensureTerminalRegistryMarker({ deploymentId: "d-completed-terminal", team: "builder" });
    assert.equal(result.wroteFallback, false);
    assert.equal(getDeploymentEvents("d-completed-terminal").length, 2);
  });
});

test("ensureTerminalRegistryMarker skips when crashed terminal event exists", () => {
  withTempRegistry(() => {
    appendRegistryEvent({
      deployment_id: "d-crashed-terminal",
      team: "builder",
      event: "started",
      timestamp: "2026-05-06T10:00:00Z",
    });
    appendRegistryEvent({
      deployment_id: "d-crashed-terminal",
      team: "builder",
      event: "crashed",
      timestamp: "2026-05-06T10:01:00Z",
      error: "spawn failed",
      exit_code: 1,
    });

    const result = ensureTerminalRegistryMarker({ deploymentId: "d-crashed-terminal", team: "builder" });
    assert.equal(result.wroteFallback, false);
    assert.equal(getDeploymentEvents("d-crashed-terminal").length, 2);
  });
});
