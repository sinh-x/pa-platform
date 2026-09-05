import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEPLOYMENT_TASK_SNAPSHOT_VERSION,
  MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES,
  createDeploymentTaskSnapshot,
  deploymentTaskSnapshotPath,
  parseDeploymentTaskSnapshot,
  readDeploymentTaskSnapshot,
  validateDeploymentTaskSnapshot,
  writeDeploymentTaskSnapshot,
  type DeploymentTaskSnapshot,
} from "../index.js";

const UPDATED_AT = "2026-08-29T12:34:56.000Z";

function snapshot(deploymentId = "d-task"): DeploymentTaskSnapshot {
  return createDeploymentTaskSnapshot({
    deploymentId,
    updatedAt: UPDATED_AT,
    nextId: 4,
    tasks: [
      { id: 1, text: "Discover", status: "completed", order: 1, dependencies: [] },
      { id: 2, text: "Implement", status: "in_progress", order: 2, dependencies: [1] },
      { id: 3, text: "Verify", status: "pending", order: 3, dependencies: [1, 2] },
    ],
  });
}

test("deployment task snapshot validates the complete versioned ordered contract", () => {
  const value = snapshot();
  assert.equal(value.schemaVersion, DEPLOYMENT_TASK_SNAPSHOT_VERSION);
  assert.equal(value.deploymentId, "d-task");
  assert.equal(value.updatedAt, UPDATED_AT);
  assert.equal(value.nextId, 4);
  assert.deepEqual(value.tasks.map(({ id, status, dependencies }) => ({ id, status, dependencies })), [
    { id: 1, status: "completed", dependencies: [] },
    { id: 2, status: "in_progress", dependencies: [1] },
    { id: 3, status: "pending", dependencies: [1, 2] },
  ]);
  assert.deepEqual(parseDeploymentTaskSnapshot(JSON.stringify(value), "d-task"), value);

  value.tasks[1]!.dependencies.push(3);
  assert.deepEqual(snapshot().tasks[1]!.dependencies, [1]);
});

test("deployment task snapshot rejects identity, version, and invalid task shapes", () => {
  const valid = snapshot() as DeploymentTaskSnapshot & Record<string, unknown>;
  assert.throws(() => validateDeploymentTaskSnapshot(valid, "d-other"), /does not match d-other/);
  assert.throws(() => validateDeploymentTaskSnapshot({ ...valid, schemaVersion: 2 }, "d-task"), /Unsupported.*version/);
  assert.throws(() => parseDeploymentTaskSnapshot("{broken", "d-task"), /not valid JSON/);

  const invalidValues: unknown[] = [
    { ...valid, updatedAt: "yesterday" },
    { ...valid, nextId: 3 },
    { ...valid, tasks: [{ ...valid.tasks[0], status: "blocked" }, ...valid.tasks.slice(1)] },
    { ...valid, tasks: [valid.tasks[1], valid.tasks[0], valid.tasks[2]] },
    { ...valid, tasks: [valid.tasks[0], { ...valid.tasks[1], dependencies: [99] }, valid.tasks[2]] },
    { ...valid, tasks: [valid.tasks[0], { ...valid.tasks[1], dependencies: [1, 1] }, valid.tasks[2]] },
    { ...valid, tasks: [valid.tasks[0], { ...valid.tasks[1], status: "in_progress" }, { ...valid.tasks[2], status: "in_progress" }] },
  ];
  for (const invalid of invalidValues) {
    assert.throws(() => validateDeploymentTaskSnapshot(invalid, "d-task"), /malformed/);
  }
});

test("deployment task snapshot reader rejects files larger than 5 MiB before parsing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pa-task-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = deploymentTaskSnapshotPath(root);
  writeFileSync(path, "x".repeat(MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES + 1));
  assert.throws(() => readDeploymentTaskSnapshot(path, "d-task"), /exceeds 5242880 bytes/);
});

test("deployment task snapshot writer atomically installs mode 0600 and preserves prior evidence on failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pa-task-write-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = deploymentTaskSnapshotPath(root);
  const prior = snapshot("d-task");
  writeDeploymentTaskSnapshot(path, prior);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readDeploymentTaskSnapshot(path, "d-task"), prior);

  const next = createDeploymentTaskSnapshot({
    deploymentId: "d-task",
    updatedAt: "2026-08-29T12:35:00.000Z",
    nextId: 2,
    tasks: [{ id: 1, text: "Replacement", status: "completed", order: 1, dependencies: [] }],
  });
  assert.throws(() => writeDeploymentTaskSnapshot(path, next, {
    rename: () => { throw new Error("injected replacement failure"); },
  }), /injected replacement failure/);
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(prior)}\n`);
  assert.deepEqual(readdirSync(root), ["deployment-tasks.json"]);
});
