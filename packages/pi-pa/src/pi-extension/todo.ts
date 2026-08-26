/*
 * Adapted from the MIT-licensed Pi 0.80.8 todo extension example:
 * examples/extensions/todo.ts
 *
 * Intentional PA changes: full lifecycle actions, stable ordering, dependency
 * validation, one active task, strict terminal states, and monotonic IDs.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { PiExtensionModule, PiToolDefinition } from "./index.js";

export const TODO_ACTIONS = ["list", "add", "update", "start", "complete", "cancel", "reorder"] as const;
export type TodoAction = (typeof TODO_ACTIONS)[number];
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoTask {
  id: number;
  text: string;
  status: TodoStatus;
  order: number;
  dependencies: number[];
}

export interface TodoInput extends Record<string, unknown> {
  action: TodoAction;
  id?: number;
  text?: string;
  dependencies?: number[];
  beforeId?: number;
}

export interface TodoDetails extends Record<string, unknown> {
  action: TodoAction;
  tasks: TodoTask[];
  nextId: number;
  error?: string;
}

export const TodoParams = Type.Object({
  action: StringEnum(TODO_ACTIONS),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Task ID for update, start, complete, cancel, or reorder" })),
  text: Type.Optional(Type.String({ description: "Task text for add or update" })),
  dependencies: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Task IDs that must be completed first" })),
  beforeId: Type.Optional(Type.Integer({ minimum: 1, description: "For reorder, place the task before this task; omit to move it last" })),
});

export class TodoStore {
  private tasks: TodoTask[] = [];
  private nextId = 1;

  snapshot(action: TodoAction = "list", error?: string): TodoDetails {
    return {
      action,
      tasks: this.tasks.map(cloneTask),
      nextId: this.nextId,
      ...(error ? { error } : {}),
    };
  }

  restore(details: TodoDetails | undefined): void {
    if (!details || !Array.isArray(details.tasks) || !Number.isInteger(details.nextId) || details.nextId < 1) {
      this.tasks = [];
      this.nextId = 1;
      return;
    }
    this.tasks = details.tasks.map(cloneTask).sort((left, right) => left.order - right.order || left.id - right.id);
    this.nextId = details.nextId;
  }

  apply(input: TodoInput): TodoDetails {
    if (input.action === "list") return this.snapshot("list");

    const candidate = this.tasks.map(cloneTask);
    let candidateNextId = this.nextId;
    const reject = (message: string) => this.snapshot(input.action, message);
    const task = input.id === undefined ? undefined : candidate.find((item) => item.id === input.id);

    if (input.action !== "add" && input.id === undefined) return reject(`id is required for ${input.action}`);
    if (input.action !== "add" && !task) return reject(`Task #${input.id} not found`);

    switch (input.action) {
      case "add": {
        const text = normalizedText(input.text);
        if (!text) return reject("text is required for add");
        const dependencies = uniqueIds(input.dependencies ?? []);
        if (dependencies.includes(candidateNextId)) return reject(`Task #${candidateNextId} cannot depend on itself`);
        const invalid = unknownDependency(dependencies, candidate);
        if (invalid !== undefined) return reject(`Dependency #${invalid} not found`);
        candidate.push({ id: candidateNextId, text, status: "pending", order: candidate.length + 1, dependencies });
        candidateNextId++;
        break;
      }
      case "update": {
        if (isTerminal(task!.status)) return reject(`Task #${task!.id} is ${task!.status} and cannot be updated`);
        if (input.text === undefined && input.dependencies === undefined) return reject("text or dependencies is required for update");
        if (input.text !== undefined) {
          const text = normalizedText(input.text);
          if (!text) return reject("text must not be empty");
          task!.text = text;
        }
        if (input.dependencies !== undefined) {
          const dependencies = uniqueIds(input.dependencies);
          if (dependencies.includes(task!.id)) return reject(`Task #${task!.id} cannot depend on itself`);
          const invalid = unknownDependency(dependencies, candidate);
          if (invalid !== undefined) return reject(`Dependency #${invalid} not found`);
          task!.dependencies = dependencies;
          if (hasDependencyCycle(candidate)) return reject("Dependency cycle detected");
        }
        break;
      }
      case "start": {
        if (isTerminal(task!.status)) return reject(`Task #${task!.id} is ${task!.status} and cannot be started`);
        const blocked = incompleteDependency(task!, candidate);
        if (blocked !== undefined) return reject(`Dependency #${blocked} is not completed`);
        for (const item of candidate) if (item.status === "in_progress") item.status = "pending";
        task!.status = "in_progress";
        break;
      }
      case "complete": {
        if (isTerminal(task!.status)) return reject(`Task #${task!.id} is ${task!.status} and cannot be completed`);
        const blocked = incompleteDependency(task!, candidate);
        if (blocked !== undefined) return reject(`Dependency #${blocked} is not completed`);
        task!.status = "completed";
        break;
      }
      case "cancel": {
        if (isTerminal(task!.status)) return reject(`Task #${task!.id} is ${task!.status} and cannot be cancelled`);
        task!.status = "cancelled";
        break;
      }
      case "reorder": {
        if (isTerminal(task!.status)) return reject(`Task #${task!.id} is ${task!.status} and cannot be reordered`);
        if (input.beforeId === input.id) return reject(`Task #${task!.id} cannot be reordered before itself`);
        if (input.beforeId !== undefined && !candidate.some((item) => item.id === input.beforeId)) {
          return reject(`Task #${input.beforeId} not found`);
        }
        const from = candidate.findIndex((item) => item.id === task!.id);
        const [moved] = candidate.splice(from, 1);
        const to = input.beforeId === undefined ? candidate.length : candidate.findIndex((item) => item.id === input.beforeId);
        candidate.splice(to, 0, moved!);
        break;
      }
    }

    normalizeOrder(candidate);
    this.tasks = candidate;
    this.nextId = candidateNextId;
    return this.snapshot(input.action);
  }
}

export function reconstructTodoState(store: TodoStore, entries: unknown[]): void {
  let latest: TodoDetails | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "toolResult") continue;
    if (!("toolName" in message) || message.toolName !== "todo" || !("details" in message)) continue;
    const details = message.details;
    if (isTodoDetails(details)) latest = details;
  }
  store.restore(latest);
}

export function createTodoTool(store: TodoStore): PiToolDefinition<TodoInput, TodoDetails> {
  return {
    name: "todo",
    label: "Todo",
    description: "Manage session-local tasks with lifecycle, stable ordering, and dependencies. Text output is bounded to 50 KiB and 2,000 lines.",
    promptSnippet: "Plan and track session-local work with ordered, dependency-aware tasks",
    promptGuidelines: [
      "Use todo to keep multi-step work current; start one task at a time and complete it when verified.",
      "Use todo list before mutating tasks when task IDs or current state are uncertain.",
    ],
    parameters: TodoParams,
    executionMode: "sequential",

    async execute(_toolCallId, input) {
      const details = store.apply(input);
      const text = details.error ? `Todo error: ${details.error}` : describeMutation(details);
      return { content: [{ type: "text", text: boundTodoText(text) }], details };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
      if (args.text) text += ` ${theme.fg("dim", `\"${args.text}\"`)}`;
      if (args.dependencies?.length) text += ` ${theme.fg("dim", `depends on ${args.dependencies.map((id) => `#${id}`).join(", ")}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details;
      if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      if (details.tasks.length === 0) return new Text(theme.fg("dim", "No tasks"), 0, 0);
      const completed = details.tasks.filter((task) => task.status === "completed").length;
      let text = theme.fg("success", `✓ ${completed}/${details.tasks.length} completed`);
      const shown = expanded ? details.tasks : details.tasks.slice(0, 5);
      for (const task of shown) text += `\n${renderTask(task, theme)}`;
      if (!expanded && details.tasks.length > shown.length) text += `\n${theme.fg("dim", `... ${details.tasks.length - shown.length} more`)}`;
      return new Text(text, 0, 0);
    },
  };
}

export const registerTodoModule: PiExtensionModule = (pi) => {
  const store = new TodoStore();
  pi.on?.("session_start", (_event, rawContext) => {
    const context = rawContext as { sessionManager: { getBranch(): unknown[] } };
    reconstructTodoState(store, context.sessionManager.getBranch());
  });
  pi.on?.("session_tree", (_event, rawContext) => {
    const context = rawContext as { sessionManager: { getBranch(): unknown[] } };
    reconstructTodoState(store, context.sessionManager.getBranch());
  });
  pi.registerTool?.(createTodoTool(store));
};

export function boundTodoText(text: string): string {
  const truncated = truncateHead(text, {
    maxBytes: Math.max(1, DEFAULT_MAX_BYTES - 256),
    maxLines: Math.max(1, DEFAULT_MAX_LINES - 1),
  });
  if (!truncated.truncated) return text;
  return `${truncated.content}\n...[truncated todo result: ${truncated.outputLines} of ${truncated.totalLines} lines, ${truncated.outputBytes} of ${truncated.totalBytes} bytes]`;
}

function describeMutation(details: TodoDetails): string {
  if (details.action === "list") return formatTasks(details.tasks);
  const labels: Record<Exclude<TodoAction, "list">, string> = {
    add: "Task added",
    update: "Task updated",
    start: "Task started",
    complete: "Task completed",
    cancel: "Task cancelled",
    reorder: "Tasks reordered",
  };
  return `${labels[details.action]}\n${formatTasks(details.tasks)}`;
}

function formatTasks(tasks: TodoTask[]): string {
  if (tasks.length === 0) return "No tasks";
  return tasks.map((task) => {
    const status = { pending: " ", in_progress: ">", completed: "x", cancelled: "-" }[task.status];
    const dependencies = task.dependencies.length ? ` (depends on ${task.dependencies.map((id) => `#${id}`).join(", ")})` : "";
    return `[${status}] #${task.id} ${task.text}${dependencies}`;
  }).join("\n");
}

function renderTask(task: TodoTask, theme: { fg: (color: string, text: string) => string }): string {
  const marker = task.status === "completed" ? theme.fg("success", "✓")
    : task.status === "in_progress" ? theme.fg("accent", "▶")
      : task.status === "cancelled" ? theme.fg("warning", "−")
        : theme.fg("dim", "○");
  const dependencies = task.dependencies.length ? theme.fg("dim", ` ← ${task.dependencies.map((id) => `#${id}`).join(",")}`) : "";
  return `${marker} ${theme.fg("accent", `#${task.id}`)} ${theme.fg(task.status === "pending" || task.status === "in_progress" ? "muted" : "dim", task.text)}${dependencies}`;
}

function cloneTask(task: TodoTask): TodoTask {
  return { ...task, dependencies: [...task.dependencies] };
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

function unknownDependency(ids: number[], tasks: TodoTask[]): number | undefined {
  return ids.find((id) => !tasks.some((task) => task.id === id));
}

function incompleteDependency(task: TodoTask, tasks: TodoTask[]): number | undefined {
  return task.dependencies.find((id) => tasks.find((candidate) => candidate.id === id)?.status !== "completed");
}

function isTerminal(status: TodoStatus): boolean {
  return status === "completed" || status === "cancelled";
}

function normalizeOrder(tasks: TodoTask[]): void {
  tasks.forEach((task, index) => { task.order = index + 1; });
}

function hasDependencyCycle(tasks: TodoTask[]): boolean {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
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

function isTodoDetails(value: unknown): value is TodoDetails {
  if (!value || typeof value !== "object") return false;
  if (!("tasks" in value) || !Array.isArray(value.tasks) || !("nextId" in value) || !Number.isInteger(value.nextId)) return false;
  return value.tasks.every((task) => task && typeof task === "object" && "id" in task && Number.isInteger(task.id)
    && "text" in task && typeof task.text === "string" && "status" in task
    && ["pending", "in_progress", "completed", "cancelled"].includes(String(task.status))
    && "order" in task && Number.isInteger(task.order) && "dependencies" in task && Array.isArray(task.dependencies));
}
