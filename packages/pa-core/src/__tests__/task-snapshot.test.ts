import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEPLOYMENT_TASK_SNAPSHOT_VERSION,
  MAX_DEPLOYMENT_TASK_SECTION_BYTES,
  MAX_DEPLOYMENT_TASK_SECTION_LINES,
  MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES,
  createDeploymentTaskSnapshot,
  deploymentTaskSnapshotPath,
  deploymentTaskStatusMarker,
  formatDeploymentTaskSection,
  formatDeploymentTasksUnavailable,
  parseDeploymentTaskSnapshot,
  readDeploymentTaskSnapshot,
  sanitizeDeploymentTaskText,
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

test("task section renders shared lifecycle markers, active state, dependencies, freshness, and stable order", () => {
  const value = createDeploymentTaskSnapshot({
    deploymentId: "d-render",
    updatedAt: UPDATED_AT,
    nextId: 9,
    tasks: [
      { id: 8, text: "Complete", status: "completed", order: 1, dependencies: [] },
      { id: 2, text: "Active", status: "in_progress", order: 2, dependencies: [8] },
      { id: 7, text: "Pending", status: "pending", order: 3, dependencies: [8, 2] },
      { id: 5, text: "Cancelled", status: "cancelled", order: 4, dependencies: [8] },
    ],
  });
  assert.deepEqual(
    ["pending", "in_progress", "completed", "cancelled"].map((status) => deploymentTaskStatusMarker(status as "pending" | "in_progress" | "completed" | "cancelled")),
    ["○", "▶", "✓", "−"],
  );
  assert.equal(formatDeploymentTaskSection(value), [
    "Session tasks: 1/4 completed",
    `  Freshness: ${UPDATED_AT}`,
    "  ✓ #8 Complete",
    "  ▶ #2 Active ← #8",
    "  ○ #7 Pending ← #8,#2",
    "  − #5 Cancelled ← #8",
  ].join("\n"));
});

test("task section renders zero tasks and sanitizes multiline, control, ANSI, and bidi text to one safe row", () => {
  const empty = createDeploymentTaskSnapshot({ deploymentId: "d-empty", updatedAt: UPDATED_AT, tasks: [], nextId: 1 });
  assert.equal(formatDeploymentTaskSection(empty), `Session tasks: 0/0 completed\n  Freshness: ${UPDATED_AT}\n  No session tasks`);

  const hostile = "alpha\n\u001b[31mred\u001b[0m\tzero\u0000\u202Eend\u001b]0;title\u0007";
  assert.equal(sanitizeDeploymentTaskText(hostile), "alpha red zero end");
  const section = formatDeploymentTaskSection(createDeploymentTaskSnapshot({
    deploymentId: "d-hostile",
    updatedAt: UPDATED_AT,
    nextId: 2,
    tasks: [{ id: 1, text: hostile, status: "pending", order: 1, dependencies: [] }],
  }));
  assert.equal(section.split("\n").length, 3);
  assert.match(section, /○ #1 alpha red zero end$/);
  assert.doesNotMatch(section, /\u001b|\u009b/);
  assert.doesNotMatch(section.split("\n").at(-1) ?? "", /\p{Cc}|\p{Cf}/u);

  const unavailable = formatDeploymentTasksUnavailable(`bad\n\u001b[31m${"x".repeat(500)}`);
  assert.equal(unavailable.split("\n").length, 2);
  assert.ok(Buffer.byteLength(unavailable) < 1_000);
  assert.doesNotMatch(unavailable, /\u001b/);
});

test("task section enforces exact 2,000-line boundary with an omission notice", () => {
  const makeTasks = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    text: "x",
    status: "pending" as const,
    order: index + 1,
    dependencies: [],
  }));
  const exact = formatDeploymentTaskSection(createDeploymentTaskSnapshot({
    deploymentId: "d-lines-exact",
    updatedAt: UPDATED_AT,
    tasks: makeTasks(MAX_DEPLOYMENT_TASK_SECTION_LINES - 2),
    nextId: MAX_DEPLOYMENT_TASK_SECTION_LINES - 1,
  }));
  assert.equal(exact.split("\n").length, MAX_DEPLOYMENT_TASK_SECTION_LINES);
  assert.doesNotMatch(exact, /omitted/);

  const oversized = formatDeploymentTaskSection(createDeploymentTaskSnapshot({
    deploymentId: "d-lines-over",
    updatedAt: UPDATED_AT,
    tasks: makeTasks(MAX_DEPLOYMENT_TASK_SECTION_LINES - 1),
    nextId: MAX_DEPLOYMENT_TASK_SECTION_LINES,
  }));
  assert.equal(oversized.split("\n").length, MAX_DEPLOYMENT_TASK_SECTION_LINES);
  assert.match(oversized, /2 tasks omitted: task section limit/);
});

test("task section enforces exact 50 KiB boundary with an omission notice", () => {
  const renderWithText = (text: string) => formatDeploymentTaskSection(createDeploymentTaskSnapshot({
    deploymentId: "d-bytes",
    updatedAt: UPDATED_AT,
    nextId: 2,
    tasks: [{ id: 1, text, status: "pending", order: 1, dependencies: [] }],
  }));
  const oneByte = renderWithText("x");
  const exactText = "x".repeat(1 + MAX_DEPLOYMENT_TASK_SECTION_BYTES - Buffer.byteLength(oneByte));
  const exact = renderWithText(exactText);
  assert.equal(Buffer.byteLength(exact), MAX_DEPLOYMENT_TASK_SECTION_BYTES);
  assert.doesNotMatch(exact, /omitted/);

  const oversized = renderWithText(`${exactText}x`);
  assert.ok(Buffer.byteLength(oversized) <= MAX_DEPLOYMENT_TASK_SECTION_BYTES);
  assert.match(oversized, /1 task omitted: task section limit/);
});
