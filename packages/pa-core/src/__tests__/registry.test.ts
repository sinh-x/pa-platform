import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendRegistryEvent, closeDb, getDeploymentEvents, queryDeploymentStatus } from "../index.js";

test("registry appends WAL-backed events and materializes deployment status", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-test", team: "builder", event: "started", timestamp: "2026-04-26T10:00:00Z", agents: ["team-manager"], runtime: "opencode", binary: "opa" });
    appendRegistryEvent({ deployment_id: "d-test", team: "builder", event: "completed", timestamp: "2026-04-26T10:01:00Z", status: "success", summary: "ok" });
    assert.equal(getDeploymentEvents("d-test").length, 2);
    const status = queryDeploymentStatus("d-test");
    assert.equal(status?.status, "success");
    assert.equal(status?.runtime, "opencode");
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
