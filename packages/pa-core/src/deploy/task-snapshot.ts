import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const DEPLOYMENT_TASK_SNAPSHOT_FILE = "deployment-tasks.json";
export const DEPLOYMENT_TASK_SNAPSHOT_VERSION = 1;
export const MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export const DEPLOYMENT_TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type DeploymentTaskStatus = (typeof DEPLOYMENT_TASK_STATUSES)[number];

export interface DeploymentTask {
  id: number;
  text: string;
  status: DeploymentTaskStatus;
  order: number;
  dependencies: number[];
}

export interface DeploymentTaskSnapshot {
  schemaVersion: typeof DEPLOYMENT_TASK_SNAPSHOT_VERSION;
  deploymentId: string;
  updatedAt: string;
  tasks: DeploymentTask[];
  nextId: number;
}

export interface CreateDeploymentTaskSnapshotInput {
  deploymentId: string;
  updatedAt?: string;
  tasks: readonly DeploymentTask[];
  nextId: number;
}

export interface DeploymentTaskSnapshotWriteOptions {
  rename?: (source: string, destination: string) => void;
}

export function deploymentTaskSnapshotPath(deploymentDir: string): string {
  return resolve(deploymentDir, DEPLOYMENT_TASK_SNAPSHOT_FILE);
}

export function createDeploymentTaskSnapshot(input: CreateDeploymentTaskSnapshotInput): DeploymentTaskSnapshot {
  const candidate = {
    schemaVersion: DEPLOYMENT_TASK_SNAPSHOT_VERSION,
    deploymentId: input.deploymentId,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    tasks: input.tasks.map(cloneTask),
    nextId: input.nextId,
  };
  return validateDeploymentTaskSnapshot(candidate, input.deploymentId);
}

export function validateDeploymentTaskSnapshot(value: unknown, expectedDeploymentId: string): DeploymentTaskSnapshot {
  if (!isRecord(value)) throw malformed("snapshot must be an object");
  if (value["schemaVersion"] !== DEPLOYMENT_TASK_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported deployment task snapshot schema version: ${String(value["schemaVersion"])}`);
  }
  if (typeof value["deploymentId"] !== "string" || value["deploymentId"].length === 0) {
    throw malformed("deploymentId must be a non-empty string");
  }
  if (value["deploymentId"] !== expectedDeploymentId) {
    throw new Error(`Deployment task snapshot ID does not match ${expectedDeploymentId}`);
  }
  if (typeof value["updatedAt"] !== "string" || !isIsoTimestamp(value["updatedAt"])) {
    throw malformed("updatedAt must be an ISO timestamp");
  }
  if (!Array.isArray(value["tasks"])) throw malformed("tasks must be an array");
  if (!isPositiveInteger(value["nextId"])) throw malformed("nextId must be a positive integer");

  const tasks = value["tasks"].map((task, index) => validateTask(task, index));
  const ids = new Set<number>();
  for (const [index, task] of tasks.entries()) {
    if (ids.has(task.id)) throw malformed(`task #${task.id} is duplicated`);
    ids.add(task.id);
    if (task.order !== index + 1) throw malformed("tasks must be stored in complete order");
  }
  for (const task of tasks) {
    const dependencies = new Set<number>();
    for (const dependency of task.dependencies) {
      if (dependencies.has(dependency)) throw malformed(`task #${task.id} has duplicate dependencies`);
      dependencies.add(dependency);
      if (dependency === task.id) throw malformed(`task #${task.id} cannot depend on itself`);
      if (!ids.has(dependency)) throw malformed(`task #${task.id} has unknown dependency #${dependency}`);
    }
  }
  const maximumId = tasks.reduce((maximum, task) => Math.max(maximum, task.id), 0);
  if (value["nextId"] <= maximumId) throw malformed("nextId must be greater than every task ID");
  if (tasks.filter((task) => task.status === "in_progress").length > 1) {
    throw malformed("only one task may be in progress");
  }
  if (hasDependencyCycle(tasks)) throw malformed("task dependencies must not contain a cycle");

  return {
    schemaVersion: DEPLOYMENT_TASK_SNAPSHOT_VERSION,
    deploymentId: value["deploymentId"],
    updatedAt: value["updatedAt"],
    tasks: tasks.map(cloneTask),
    nextId: value["nextId"],
  };
}

export function parseDeploymentTaskSnapshot(text: string, expectedDeploymentId: string): DeploymentTaskSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed("file is not valid JSON");
  }
  return validateDeploymentTaskSnapshot(value, expectedDeploymentId);
}

export function readDeploymentTaskSnapshot(path: string, expectedDeploymentId: string): DeploymentTaskSnapshot {
  const size = statSync(path).size;
  if (size > MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES) throw oversized(size);
  const content = readFileSync(path);
  if (content.byteLength > MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES) throw oversized(content.byteLength);
  return parseDeploymentTaskSnapshot(content.toString("utf8"), expectedDeploymentId);
}

export function writeDeploymentTaskSnapshot(
  path: string,
  snapshot: DeploymentTaskSnapshot,
  options: DeploymentTaskSnapshotWriteOptions = {},
): void {
  const validated = validateDeploymentTaskSnapshot(snapshot, snapshot.deploymentId);
  const body = `${JSON.stringify(validated)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    (options.rename ?? renameSync)(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {
      // The original write error remains authoritative; a private temporary
      // file is safe to leave for later workspace cleanup.
    }
    throw error;
  }
}

function validateTask(value: unknown, index: number): DeploymentTask {
  if (!isRecord(value)) throw malformed(`task at index ${index} must be an object`);
  if (!isPositiveInteger(value["id"])) throw malformed(`task at index ${index} has an invalid id`);
  if (typeof value["text"] !== "string" || value["text"].trim().length === 0) {
    throw malformed(`task #${value["id"]} has invalid text`);
  }
  if (!isDeploymentTaskStatus(value["status"])) throw malformed(`task #${value["id"]} has an invalid status`);
  if (!isPositiveInteger(value["order"])) throw malformed(`task #${value["id"]} has an invalid order`);
  if (!Array.isArray(value["dependencies"]) || !value["dependencies"].every(isPositiveInteger)) {
    throw malformed(`task #${value["id"]} has invalid dependencies`);
  }
  return {
    id: value["id"],
    text: value["text"],
    status: value["status"],
    order: value["order"],
    dependencies: [...value["dependencies"]],
  };
}

function cloneTask(task: DeploymentTask): DeploymentTask {
  return { ...task, dependencies: [...task.dependencies] };
}

function hasDependencyCycle(tasks: DeploymentTask[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (id: number): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 1;
}

function isDeploymentTaskStatus(value: unknown): value is DeploymentTaskStatus {
  return typeof value === "string" && (DEPLOYMENT_TASK_STATUSES as readonly string[]).includes(value);
}

function isIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function malformed(reason: string): Error {
  return new Error(`Deployment task snapshot is malformed: ${reason}`);
}

function oversized(size: number): Error {
  return new Error(`Deployment task snapshot exceeds ${MAX_DEPLOYMENT_TASK_SNAPSHOT_BYTES} bytes (${size} bytes)`);
}
