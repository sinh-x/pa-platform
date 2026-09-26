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
export const PA_CANONICAL_REPO_ROOT_ENV = "PA_REPO_ROOT";

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
  /** Current ticket, preferring the mutable registry projection when available. */
  ticket?: string;
  /** Immutable process-start ticket evidence. */
  launchTicket?: string;
  status?: string;
  projectionAvailable: boolean;
  stale: boolean;
}

export interface DeploymentProjection {
  status?: string;
  ticket?: string;
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
  deploymentLookup?: (id: string) => Promise<DeploymentProjection | undefined>;
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

  const [gitResult, deploymentResult] = await Promise.all([
    withDeadline(
      () => (dependencies.gitLookup ?? lookupGit)(input.cwd),
      deadlineMs,
      timers,
    ),
    deployment.id
      ? withDeadline(
          () => (dependencies.deploymentLookup ?? lookupDeployment)(deployment.id!),
          deadlineMs,
          timers,
        )
      : Promise.resolve(undefined),
  ]);
  const git: GitContext = gitResult.ok
    ? { ...gitResult.value, stale: false }
    : gitResult.timedOut && previous.git.available
      ? { ...previous.git, stale: true }
      : { available: false, stale: gitResult.timedOut };

  if (deploymentResult?.ok && deploymentResult.value) {
    deployment.status = deploymentResult.value.status;
    deployment.ticket = deploymentResult.value.ticket;
    deployment.projectionAvailable = true;
  } else if (deploymentResult?.timedOut) {
    if (previous.deployment.id === deployment.id) {
      deployment.status = previous.deployment.status;
      deployment.ticket = previous.deployment.ticket;
      deployment.launchTicket = previous.deployment.launchTicket;
      deployment.projectionAvailable = previous.deployment.projectionAvailable;
    }
    deployment.stale = true;
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
  private readonly inFlight = new Set<Promise<void>>();
  private running = false;
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
    this.schedulePending();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending = undefined;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.inFlight]);
  }

  private schedulePending(): void {
    if (this.disposed || !this.pending) return;
    const elapsed = this.lastRunAt === undefined ? this.intervalMs : this.now() - this.lastRunAt;
    if (!this.running && elapsed >= this.intervalMs) {
      if (this.timer !== undefined) this.clearTimer(this.timer);
      this.timer = undefined;
      this.runPending();
      return;
    }
    if (this.timer === undefined && elapsed < this.intervalMs) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        this.schedulePending();
      }, this.intervalMs - elapsed);
      this.timer.unref?.();
    }
  }

  private runPending(): void {
    if (this.disposed || this.running || !this.pending) return;
    const refresh = this.pending;
    this.pending = undefined;
    this.lastRunAt = this.now();
    this.running = true;
    let result: void | Promise<void>;
    try {
      result = refresh();
    } catch (error) {
      result = Promise.reject(error);
    }
    if (result === undefined) {
      this.running = false;
      this.schedulePending();
      return;
    }
    const tracked = Promise.resolve(result).then(() => undefined, () => undefined);
    this.inFlight.add(tracked);
    void tracked.finally(() => {
      this.inFlight.delete(tracked);
      this.running = false;
      this.schedulePending();
    });
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

async function lookupDeployment(id: string): Promise<DeploymentProjection | undefined> {
  const value = queryDeploymentStatus(id);
  if (!value) return undefined;
  return {
    status: value.status,
    ticket: nonEmpty(value.ticket_id),
  };
}

function deploymentFromEnvironment(env: NodeJS.ProcessEnv): DeploymentContext {
  const id = nonEmpty(env["PA_DEPLOYMENT_ID"]);
  if (!id) return { available: false, projectionAvailable: false, stale: false };
  const launchTicket = nonEmpty(env["PA_TICKET_ID"]);
  return {
    available: true,
    id,
    team: nonEmpty(env["PA_TEAM"]),
    mode: nonEmpty(env["PA_MODE"]),
    ticket: launchTicket,
    launchTicket,
    projectionAvailable: false,
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
  return {
    cwd,
    identity: nonEmpty(env[PA_CANONICAL_REPO_ROOT_ENV]) ?? nonEmpty(env["PA_REPO"]) ?? (basename(cwd) || cwd),
  };
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
