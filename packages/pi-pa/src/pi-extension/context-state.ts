/*
 * Adapted from the MIT-licensed Pi 0.80.8 status-line example:
 * examples/extensions/status-line.ts
 *
 * PA additions collect deployment, repository/Git, model, freshness, and todo
 * context with explicit rate and query deadlines.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { queryDeploymentStatus } from "@pa-platform/pa-core";
import type { TodoDetails, TodoTask } from "./todo.js";

const execFileAsync = promisify(execFile);
export const CONTEXT_REFRESH_INTERVAL_MS = 2_000;
export const CONTEXT_LOOKUP_DEADLINE_MS = 500;

export interface GitContext {
  available: boolean;
  branch?: string;
  dirty?: boolean;
  stale: boolean;
}

export interface DeploymentContext {
  available: boolean;
  id?: string;
  team?: string;
  mode?: string;
  ticket?: string;
  status?: string;
  stale: boolean;
}

export interface ModelContext {
  provider?: string;
  model?: string;
}

export interface RepositoryContext {
  cwd: string;
  identity: string;
}

export interface TodoContext {
  tasks: TodoTask[];
  total: number;
  completed: number;
  active?: TodoTask;
}

export interface PaContextSnapshot {
  deployment: DeploymentContext;
  model: ModelContext;
  repository: RepositoryContext;
  git: GitContext;
  todo: TodoContext;
  updatedAt: number;
  stale: boolean;
}

export interface ContextRefreshInput {
  cwd: string;
  model?: { provider?: string; id?: string };
  todo?: TodoDetails;
}

export interface ContextCollectorDependencies {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  gitLookup?: (cwd: string) => Promise<Omit<GitContext, "stale">>;
  deploymentLookup?: (id: string) => Promise<string | undefined>;
  deadlineMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function initialContextSnapshot(input: ContextRefreshInput, dependencies: ContextCollectorDependencies = {}): PaContextSnapshot {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? Date.now;
  return {
    deployment: deploymentFromEnvironment(env),
    model: modelContext(input.model, env),
    repository: repositoryContext(input.cwd, env),
    git: { available: false, stale: false },
    todo: todoContext(input.todo),
    updatedAt: now(),
    stale: false,
  };
}

export async function collectContext(
  previous: PaContextSnapshot,
  input: ContextRefreshInput,
  dependencies: ContextCollectorDependencies = {},
): Promise<PaContextSnapshot> {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? Date.now;
  const deadlineMs = dependencies.deadlineMs ?? CONTEXT_LOOKUP_DEADLINE_MS;
  const timers = { setTimer: dependencies.setTimer ?? setTimeout, clearTimer: dependencies.clearTimer ?? clearTimeout };
  const deployment = deploymentFromEnvironment(env);

  const gitResult = await withDeadline(
    () => (dependencies.gitLookup ?? lookupGit)(input.cwd),
    deadlineMs,
    timers,
  );
  const git: GitContext = gitResult.ok
    ? { ...gitResult.value, stale: false }
    : gitResult.timedOut && previous.git.available
      ? { ...previous.git, stale: true }
      : { available: false, stale: gitResult.timedOut };

  if (deployment.id) {
    const deploymentResult = await withDeadline(
      () => (dependencies.deploymentLookup ?? lookupDeployment)(deployment.id!),
      deadlineMs,
      timers,
    );
    if (deploymentResult.ok) deployment.status = deploymentResult.value;
    else if (deploymentResult.timedOut) {
      deployment.status = previous.deployment.id === deployment.id ? previous.deployment.status : undefined;
      deployment.stale = true;
    }
  }

  return {
    deployment,
    model: modelContext(input.model, env),
    repository: repositoryContext(input.cwd, env),
    git,
    todo: input.todo ? todoContext(input.todo) : previous.todo,
    updatedAt: now(),
    stale: git.stale || deployment.stale,
  };
}

export type DeadlineResult<T> =
  | { ok: true; value: T; timedOut: false }
  | { ok: false; timedOut: boolean; error?: unknown };

export async function withDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
  timers: { setTimer: typeof setTimeout; clearTimer: typeof clearTimeout } = { setTimer: setTimeout, clearTimer: clearTimeout },
): Promise<DeadlineResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timer = timers.setTimer(() => resolve({ ok: false, timedOut: true }), deadlineMs);
  });
  const work = Promise.resolve()
    .then(operation)
    .then<DeadlineResult<T>>((value) => ({ ok: true, value, timedOut: false }))
    .catch<DeadlineResult<T>>((error: unknown) => ({ ok: false, timedOut: false, error }));
  const result = await Promise.race([work, timeout]);
  if (timer !== undefined) timers.clearTimer(timer);
  return result;
}

export class ContextRefreshLimiter {
  private lastRunAt: number | undefined;
  private pending: (() => void | Promise<void>) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly intervalMs = CONTEXT_REFRESH_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly setTimer: typeof setTimeout = setTimeout,
    private readonly clearTimer: typeof clearTimeout = clearTimeout,
  ) {}

  request(refresh: () => void | Promise<void>): void {
    if (this.disposed) return;
    this.pending = refresh;
    const elapsed = this.lastRunAt === undefined ? this.intervalMs : this.now() - this.lastRunAt;
    if (elapsed >= this.intervalMs) {
      this.runPending();
      return;
    }
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        this.runPending();
      }, this.intervalMs - elapsed);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private runPending(): void {
    if (this.disposed || !this.pending) return;
    const refresh = this.pending;
    this.pending = undefined;
    this.lastRunAt = this.now();
    void refresh();
  }
}

export function todoDetailsFromBranch(entries: unknown[]): TodoDetails | undefined {
  let latest: TodoDetails | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "toolResult") continue;
    if (!("toolName" in message) || message.toolName !== "todo" || !("details" in message)) continue;
    const details = message.details;
    if (details && typeof details === "object" && "tasks" in details && Array.isArray(details.tasks) && "nextId" in details) {
      latest = details as TodoDetails;
    }
  }
  return latest;
}

async function lookupGit(cwd: string): Promise<Omit<GitContext, "stale">> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1", "--branch"], {
      timeout: CONTEXT_LOOKUP_DEADLINE_MS,
      maxBuffer: 256 * 1024,
    });
    const [heading = "", ...changes] = stdout.split("\n");
    const branch = heading.replace(/^##\s*/, "").split("...")[0]?.trim() || undefined;
    return { available: true, branch, dirty: changes.some(Boolean) };
  } catch {
    return { available: false };
  }
}

async function lookupDeployment(id: string): Promise<string | undefined> {
  const value = queryDeploymentStatus(id) as { status?: unknown } | undefined;
  return typeof value?.status === "string" ? value.status : undefined;
}

function deploymentFromEnvironment(env: NodeJS.ProcessEnv): DeploymentContext {
  const id = nonEmpty(env["PA_DEPLOYMENT_ID"]);
  if (!id) return { available: false, stale: false };
  return {
    available: true,
    id,
    team: nonEmpty(env["PA_TEAM"]),
    mode: nonEmpty(env["PA_MODE"]),
    ticket: nonEmpty(env["PA_TICKET_ID"]),
    stale: false,
  };
}

function modelContext(model: ContextRefreshInput["model"], env: NodeJS.ProcessEnv): ModelContext {
  return {
    provider: nonEmpty(model?.provider) ?? nonEmpty(env["PA_PROVIDER"]),
    model: nonEmpty(model?.id) ?? nonEmpty(env["PA_MODEL"]),
  };
}

function repositoryContext(cwd: string, env: NodeJS.ProcessEnv): RepositoryContext {
  return { cwd, identity: nonEmpty(env["PA_REPO"]) ?? (basename(cwd) || cwd) };
}

function todoContext(details: TodoDetails | undefined): TodoContext {
  const tasks = details?.tasks.map((task) => ({ ...task, dependencies: [...task.dependencies] })) ?? [];
  return {
    tasks,
    total: tasks.length,
    completed: tasks.filter((task) => task.status === "completed").length,
    active: tasks.find((task) => task.status === "in_progress"),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
