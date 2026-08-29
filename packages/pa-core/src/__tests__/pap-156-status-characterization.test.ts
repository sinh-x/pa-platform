import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRegistryEvent, closeDb, getDeploymentEvents, reconcileTerminalRegistryEvent, runCoreCommand } from "../index.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

test("status wait defers stale child PID authority while a ready Pi supervisor is finalizing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap-156-status-overlap-"));
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousHome = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  const deploymentId = "d-pap156-overlap";
  const deployDir = join(root, "deployments", deploymentId);
  mkdirSync(deployDir, { recursive: true });
  writeFileSync(join(deployDir, "pi-supervisor.json"), JSON.stringify({
    schemaVersion: 1,
    deploymentId,
    state: "finalizing",
    ready: true,
    supervisorPid: process.pid,
    childPid: 999999,
    updatedAt: "2026-08-29T00:00:04.500Z",
    finalizationDeadlineMs: 5000,
  }));

  try {
    appendRegistryEvent({
      deployment_id: deploymentId,
      team: "builder",
      event: "started",
      timestamp: "2026-08-29T00:00:00.000Z",
      runtime: "pi",
      binary: "ppa",
      pid: 999999,
      effective_timeout_seconds: 120,
    });
    const captured = capture();
    let clock = 0;
    let sleeps = 0;
    let requestedDelay = 0;
    const code = await runCoreCommand(["status", deploymentId, "--wait"], {
      io: captured.io,
      clock: () => clock,
      sleep: async (milliseconds) => {
        sleeps++;
        requestedDelay = milliseconds;
        clock += 250;
        reconcileTerminalRegistryEvent({
          deployment_id: deploymentId,
          team: "builder",
          event: "completed",
          timestamp: "2026-08-29T00:00:04.750Z",
          status: "success",
          summary: "supervisor finalized legitimate success",
          exit_code: 0,
        });
      },
    });

    const terminal = getDeploymentEvents(deploymentId).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.deepEqual(
      {
        code,
        sleeps,
        finalizationPollWithinMs: requestedDelay <= 5000,
        terminalCount: terminal.length,
        terminalEvent: terminal[0]?.event,
        terminalStatus: terminal[0]?.status,
        stalePidReplacedAuthority: /status wait detected stale pid/.test(JSON.stringify(terminal)),
        reportedLegitimateSuccess: /success - supervisor finalized legitimate success/.test(captured.stdout.join("\n")),
      },
      {
        code: 0,
        sleeps: 1,
        finalizationPollWithinMs: true,
        terminalCount: 1,
        terminalEvent: "completed",
        terminalStatus: "success",
        stalePidReplacedAuthority: false,
        reportedLegitimateSuccess: true,
      },
    );
  } finally {
    closeDb();
    restoreEnv("PA_REGISTRY_DB", previousRegistry);
    restoreEnv("PA_AI_USAGE_HOME", previousHome);
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent status waiters retain the supervisor result as the single terminal authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap-156-status-concurrent-"));
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousHome = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  const deploymentId = "d-pap156-concurrent";
  const deployDir = join(root, "deployments", deploymentId);
  mkdirSync(deployDir, { recursive: true });
  writeFileSync(join(deployDir, "pi-supervisor.json"), JSON.stringify({
    schemaVersion: 1,
    deploymentId,
    ownershipToken: "concurrent-owner",
    state: "finalizing",
    ready: true,
    supervisorPid: process.pid,
    childPid: 999998,
    updatedAt: "2026-08-29T00:00:04.500Z",
    finalizationDeadlineMs: 5000,
  }));

  try {
    appendRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "started", timestamp: "2026-08-29T00:00:00.000Z", runtime: "pi", binary: "ppa", pid: 999998, effective_timeout_seconds: 120 });
    const outputs = [capture(), capture()];
    const codes = await Promise.all(outputs.map((captured) => runCoreCommand(["status", deploymentId, "--wait"], {
      io: captured.io,
      clock: () => 0,
      sleep: async () => {
        reconcileTerminalRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "completed", timestamp: "2026-08-29T00:00:04.750Z", status: "success", summary: "supervisor retained concurrent authority", exit_code: 0 });
      },
    })));
    const terminal = getDeploymentEvents(deploymentId).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.deepEqual(codes, [0, 0]);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.status, "success");
    assert.doesNotMatch(JSON.stringify(terminal), /stale pid/);
    assert.ok(outputs.every((captured) => /success - supervisor retained concurrent authority/.test(captured.stdout.join("\n"))));
  } finally {
    closeDb();
    restoreEnv("PA_REGISTRY_DB", previousRegistry);
    restoreEnv("PA_AI_USAGE_HOME", previousHome);
    rmSync(root, { recursive: true, force: true });
  }
});

test("status wait reports supervisor death and terminates its orphan child", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap-156-supervisor-death-"));
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousHome = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  const deploymentId = "d-pap156-orphan";
  const deployDir = join(root, "deployments", deploymentId);
  mkdirSync(deployDir, { recursive: true });
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  assert.ok(child.pid);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  writeFileSync(join(deployDir, "pi-supervisor.json"), JSON.stringify({ schemaVersion: 1, deploymentId, ownershipToken: "dead-owner", state: "active", ready: true, supervisorPid: 999999, childPid: child.pid, updatedAt: new Date().toISOString(), finalizationDeadlineMs: 5000 }));
  try {
    appendRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "started", timestamp: "2026-08-29T00:00:00.000Z", runtime: "pi", binary: "ppa", pid: child.pid, effective_timeout_seconds: 120 });
    const captured = capture();
    const code = await runCoreCommand(["status", deploymentId, "--wait"], { io: captured.io, clock: Date.now, sleep: async () => {} });
    assert.equal(code, 1);
    const terminal = getDeploymentEvents(deploymentId).filter((event) => event.event === "completed" || event.event === "crashed");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.event, "crashed");
    assert.match(terminal[0]?.error ?? "", /Pi supervisor pid 999999 exited before finalizing child pid/);
    await Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), new Promise<void>((_, reject) => setTimeout(() => reject(new Error("orphan child was not terminated")), 1000))]);
  } finally {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already terminated */ }
    closeDb();
    restoreEnv("PA_REGISTRY_DB", previousRegistry);
    restoreEnv("PA_AI_USAGE_HOME", previousHome);
    rmSync(root, { recursive: true, force: true });
  }
});
