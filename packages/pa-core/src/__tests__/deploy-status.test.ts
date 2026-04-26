import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, createAgentApiApp } from "../index.js";

function withApiEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pa-core-deploy-status-"));
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousAiUsage = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  return fn(root).finally(() => {
    closeDb();
    if (previousRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previousRegistry;
    if (previousAiUsage === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousAiUsage;
    rmSync(root, { recursive: true, force: true });
  });
}

test("deploy status API emits started, pid, completed, crashed events", async () => {
  await withApiEnv(async () => {
    const { app } = createAgentApiApp();
    const deployId = "d-status-test";

    // Emit started event
    const started = await app.request("/api/deploy/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: deployId, team: "builder", ticketId: "PAP-001" }),
    });
    assert.equal(started.status, 200);
    let body = await started.json();
    assert.equal(body.event, "started");

    // Emit pid event
    const pid = await app.request("/api/deploy/pid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: deployId, team: "builder", pid: 12345 }),
    });
    assert.equal(pid.status, 200);
    body = await pid.json();
    assert.equal(body.event, "pid");

    // Check status
    const status = await app.request(`/api/deploy/status/${deployId}`);
    assert.equal(status.status, 200);
    body = await status.json();
    assert.equal(body.status?.status, "running");
    assert.equal(body.status?.pid, 12345);

    // Emit completed event
    const completed = await app.request("/api/deploy/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: deployId, team: "builder", status: "success", summary: "done" }),
    });
    assert.equal(completed.status, 200);
    body = await completed.json();
    assert.equal(body.event, "completed");

    // Check final status
    const finalStatus = await app.request(`/api/deploy/status/${deployId}`);
    assert.equal(finalStatus.status, 200);
    body = await finalStatus.json();
    assert.equal(body.status?.status, "success");
  });
});

test("deploy status API emits crashed event", async () => {
  await withApiEnv(async () => {
    const { app } = createAgentApiApp();
    const deployId = "d-crash-test";

    // Emit started event
    await app.request("/api/deploy/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: deployId, team: "builder" }),
    });

    // Emit crashed event
    const crashed = await app.request("/api/deploy/crash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: deployId, team: "builder", error: "SIGSEGV", exitCode: 139 }),
    });
    assert.equal(crashed.status, 200);
    assert.equal((await crashed.json()).event, "crashed");

    // Check final status
    const finalStatus = await app.request(`/api/deploy/status/${deployId}`);
    assert.equal(finalStatus.status, 200);
    assert.equal((await finalStatus.json()).status?.status, "crashed");
  });
});

test("deploy status API rejects bad requests", async () => {
  await withApiEnv(async () => {
    const { app } = createAgentApiApp();

    // Missing deploymentId
    const bad1 = await app.request("/api/deploy/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: "builder" }),
    });
    assert.equal(bad1.status, 400);

    // Missing pid
    const bad2 = await app.request("/api/deploy/pid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: "d-1", team: "builder" }),
    });
    assert.equal(bad2.status, 400);

    // Not found status
    const notFound = await app.request("/api/deploy/status/d-nonexistent");
    assert.equal(notFound.status, 404);
  });
});

test("deploy paths helpers manage primer and deploy directories", async () => {
  await withApiEnv(async () => {
    const { ensureDeployDir, getDeployPaths, writePrimerFile, readPrimerFile } = await import("../index.js");
    const deployId = "d-paths-test";

    // ensureDeployDir creates the directory
    const dir = ensureDeployDir(deployId);
    assert.ok(dir.includes("d-paths-test"));

    // getDeployPaths returns all paths
    const paths = getDeployPaths(deployId);
    assert.ok(paths.deployDir.includes("d-paths-test"));
    assert.ok(paths.primerPath.endsWith(`${deployId}-primer.md`));
    assert.ok(paths.sessionPath.includes("sessions"));
    assert.ok(paths.activityLogPath.includes("activity.jsonl"));

    // writePrimerFile and readPrimerFile work
    const content = "# Primer\n\nTest content";
    writePrimerFile(deployId, content);
    const read = readPrimerFile(deployId);
    assert.equal(read, content);
  });
});
