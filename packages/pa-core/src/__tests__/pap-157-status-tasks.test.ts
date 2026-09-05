import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEPLOYMENT_TASK_SNAPSHOT_VERSION,
  MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES,
  appendRegistryEvent,
  closeDb,
  createDeploymentTaskSnapshot,
  deploymentTaskSnapshotPath,
  runCoreCommand,
  writeDeploymentTaskSnapshot,
} from "../index.js";

const UPDATED_AT = "2026-08-29T12:34:56.000Z";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

async function withStatusEnv(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pap-157-status-"));
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousHome = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  try {
    await run(root);
  } finally {
    closeDb();
    if (previousRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previousRegistry;
    if (previousHome === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

function startDeployment(deploymentId: string, runtime: "pi" | "opencode" = "pi"): void {
  appendRegistryEvent({
    deployment_id: deploymentId,
    team: "builder",
    event: "started",
    timestamp: "2026-08-29T12:00:00.000Z",
    runtime,
    binary: runtime === "pi" ? "ppa" : "opa",
  });
}

function deploymentDir(root: string, deploymentId: string): string {
  const path = join(root, "deployments", deploymentId);
  mkdirSync(path, { recursive: true });
  return path;
}

test("default Pi detail renders ordered safe task evidence for running and completed deployments", async () => {
  await withStatusEnv(async (root) => {
    const deploymentId = "d-pap157-valid";
    startDeployment(deploymentId);
    const path = deploymentTaskSnapshotPath(deploymentDir(root, deploymentId));
    writeDeploymentTaskSnapshot(path, createDeploymentTaskSnapshot({
      deploymentId,
      updatedAt: UPDATED_AT,
      nextId: 9,
      tasks: [
        { id: 8, text: "Discover", status: "completed", order: 1, dependencies: [] },
        { id: 2, text: "Implement\n\u001b[31mnow\u001b[0m", status: "in_progress", order: 2, dependencies: [8] },
        { id: 7, text: "Verify", status: "pending", order: 3, dependencies: [8, 2] },
        { id: 5, text: "Cancelled", status: "cancelled", order: 4, dependencies: [8] },
      ],
    }));

    const running = capture();
    assert.equal(await runCoreCommand(["status", deploymentId], { io: running.io }), 0);
    const runningOutput = running.stdout.join("\n");
    assert.match(runningOutput, /Deployment: d-pap157-valid/);
    assert.match(runningOutput, /Status:\s+running/);
    assert.match(runningOutput, /Session tasks: 1\/4 completed/);
    assert.match(runningOutput, new RegExp(`Freshness: ${UPDATED_AT.replaceAll(".", "\\.")}`));
    assert.match(runningOutput, /✓ #8 Discover/);
    assert.match(runningOutput, /▶ #2 Implement now ← #8/);
    assert.match(runningOutput, /○ #7 Verify ← #8,#2/);
    assert.match(runningOutput, /− #5 Cancelled ← #8/);
    assert.ok(runningOutput.indexOf("#8 Discover") < runningOutput.indexOf("#2 Implement"));
    assert.ok(runningOutput.indexOf("#2 Implement") < runningOutput.indexOf("#7 Verify"));
    assert.equal((runningOutput.match(/▶/gu) ?? []).length, 1);
    assert.doesNotMatch(runningOutput, /\u001b|\u009b/);
    const taskRows = runningOutput.split("\n").filter((line) => /[○▶✓−] #\d+/.test(line));
    assert.ok(taskRows.every((line) => !/[\p{Cc}\p{Cf}]/u.test(line)));

    appendRegistryEvent({
      deployment_id: deploymentId,
      team: "builder",
      event: "completed",
      timestamp: "2026-08-29T12:40:00.000Z",
      status: "success",
      summary: "done",
      exit_code: 0,
    });
    const completed = capture();
    assert.equal(await runCoreCommand(["status", deploymentId], { io: completed.io }), 0);
    assert.match(completed.stdout.join("\n"), /Status:\s+success[\s\S]*Session tasks: 1\/4 completed/);
  });
});

test("default Pi detail renders zero tasks without treating evidence as unavailable", async () => {
  await withStatusEnv(async (root) => {
    const deploymentId = "d-pap157-empty";
    startDeployment(deploymentId);
    writeDeploymentTaskSnapshot(
      deploymentTaskSnapshotPath(deploymentDir(root, deploymentId)),
      createDeploymentTaskSnapshot({ deploymentId, updatedAt: UPDATED_AT, tasks: [], nextId: 1 }),
    );
    const captured = capture();
    assert.equal(await runCoreCommand(["status", deploymentId], { io: captured.io }), 0);
    const output = captured.stdout.join("\n");
    assert.match(output, /Session tasks: 0\/0 completed/);
    assert.match(output, /No session tasks/);
    assert.doesNotMatch(output, /Tasks unavailable/);
  });
});

test("default Pi detail handles every unavailable evidence class non-fatally with bounded reasons", async () => {
  await withStatusEnv(async (root) => {
    const scenarios: Array<{ name: string; expected: RegExp; prepare?: (path: string, deploymentId: string) => void }> = [
      { name: "missing", expected: /Tasks unavailable: snapshot file is missing/ },
      { name: "malformed", expected: /Tasks unavailable: snapshot is malformed/, prepare: (path) => writeFileSync(path, "{broken") },
      {
        name: "mismatched",
        expected: /Tasks unavailable: snapshot deployment ID does not match/,
        prepare: (path) => writeDeploymentTaskSnapshot(path, createDeploymentTaskSnapshot({ deploymentId: "d-other", updatedAt: UPDATED_AT, tasks: [], nextId: 1 })),
      },
      {
        name: "unsupported",
        expected: /Tasks unavailable: snapshot schema version is unsupported/,
        prepare: (path, deploymentId) => writeFileSync(path, JSON.stringify({ schemaVersion: DEPLOYMENT_TASK_SNAPSHOT_VERSION + 1, deploymentId, updatedAt: UPDATED_AT, tasks: [], nextId: 1 })),
      },
      {
        name: "oversized",
        expected: new RegExp(`Tasks unavailable: snapshot exceeds ${MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES} byte read limit`),
        prepare: (path) => writeFileSync(path, "x".repeat(MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES + 1)),
      },
      { name: "unreadable", expected: /Tasks unavailable: snapshot could not be read/, prepare: (path) => mkdirSync(path) },
    ];

    for (const scenario of scenarios) {
      const deploymentId = `d-pap157-${scenario.name}`;
      startDeployment(deploymentId);
      const path = deploymentTaskSnapshotPath(deploymentDir(root, deploymentId));
      scenario.prepare?.(path, deploymentId);
      const captured = capture();
      assert.equal(await runCoreCommand(["status", deploymentId], { io: captured.io }), 0, scenario.name);
      const output = captured.stdout.join("\n");
      assert.match(output, new RegExp(`Deployment: ${deploymentId}`), scenario.name);
      assert.match(output, scenario.expected, scenario.name);
      const section = output.slice(output.indexOf("Session tasks:"));
      assert.ok(Buffer.byteLength(section) <= 50 * 1024, scenario.name);
      assert.ok(section.split("\n").length <= 2_000, scenario.name);
      assert.equal(captured.stderr.length, 0, scenario.name);
    }
  });
});

test("non-Pi detail and Pi list/activity/wait/report/artifacts paths do not render task sections", async () => {
  await withStatusEnv(async (root) => {
    const nonPiId = "d-pap157-opencode";
    startDeployment(nonPiId, "opencode");
    writeDeploymentTaskSnapshot(
      deploymentTaskSnapshotPath(deploymentDir(root, nonPiId)),
      createDeploymentTaskSnapshot({
        deploymentId: nonPiId,
        updatedAt: UPDATED_AT,
        nextId: 2,
        tasks: [{ id: 1, text: "NON-PI-TASK-SENTINEL", status: "pending", order: 1, dependencies: [] }],
      }),
    );
    const nonPi = capture();
    assert.equal(await runCoreCommand(["status", nonPiId], { io: nonPi.io }), 0);
    assert.doesNotMatch(nonPi.stdout.join("\n"), /Session tasks|NON-PI-TASK-SENTINEL/);

    const piId = "d-pap157-alternate";
    startDeployment(piId);
    const dir = deploymentDir(root, piId);
    writeDeploymentTaskSnapshot(
      deploymentTaskSnapshotPath(dir),
      createDeploymentTaskSnapshot({
        deploymentId: piId,
        updatedAt: UPDATED_AT,
        nextId: 2,
        tasks: [{ id: 1, text: "PI-TASK-SENTINEL", status: "completed", order: 1, dependencies: [] }],
      }),
    );
    writeFileSync(join(dir, "artifact.txt"), "artifact");
    writeFileSync(join(dir, "activity.jsonl"), `${JSON.stringify({ deployId: piId, timestamp: UPDATED_AT, kind: "text", source: "pi", body: "activity sentinel" })}\n`);
    const reportDir = join(root, "agent-teams", "builder", "artifacts");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `${piId}-report.md`), `Report for ${piId}`);
    appendRegistryEvent({ deployment_id: piId, team: "builder", event: "completed", timestamp: "2026-08-29T12:40:00.000Z", status: "success", summary: "alternate done", exit_code: 0 });

    const detail = capture();
    assert.equal(await runCoreCommand(["status", piId], { io: detail.io }), 0);
    assert.match(detail.stdout.join("\n"), /Session tasks: 1\/1 completed[\s\S]*PI-TASK-SENTINEL/);

    for (const args of [
      ["status", "--recent", "2"],
      ["status", piId, "--activity"],
      ["status", piId, "--wait"],
      ["status", piId, "--report"],
      ["status", piId, "--artifacts"],
    ]) {
      const captured = capture();
      assert.equal(await runCoreCommand(args, { io: captured.io }), 0, args.join(" "));
      const output = captured.stdout.join("\n");
      assert.doesNotMatch(output, /Session tasks|PI-TASK-SENTINEL/, args.join(" "));
    }
  });
});
