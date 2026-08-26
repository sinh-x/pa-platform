import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  TodoParams,
  TodoStore,
  boundTodoText,
  createTodoTool,
  reconstructTodoState,
  type TodoDetails,
  type TodoTask,
} from "../pi-extension/todo.js";

function tasks(store: TodoStore): TodoTask[] {
  return store.snapshot().tasks;
}

function add(store: TodoStore, text: string, dependencies?: number[]): TodoDetails {
  return store.apply({ action: "add", text, ...(dependencies ? { dependencies } : {}) });
}

function resultEntry(details: TodoDetails): unknown {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "todo", details },
  };
}

test("todo schema exposes the approved lifecycle and strict typed fields", () => {
  const tool = createTodoTool(new TodoStore());
  for (const action of ["list", "add", "update", "start", "complete", "cancel", "reorder"]) {
    assert.equal(Check(TodoParams, { action }), true);
  }
  assert.equal(Check(TodoParams, { action: "toggle" }), false);
  assert.equal(Check(TodoParams, { action: "start", id: 0 }), false);
  assert.equal(tool.name, "todo");
  assert.equal(tool.executionMode, "sequential");
});

test("todo lifecycle keeps monotonic IDs, complete snapshots, and stable order", () => {
  const store = new TodoStore();
  assert.deepEqual(store.apply({ action: "list" }), { action: "list", tasks: [], nextId: 1 });
  add(store, "Question");
  add(store, "Todo");
  const third = add(store, "Context");
  assert.equal(third.nextId, 4);
  assert.deepEqual(third.tasks.map(({ id, text, order, status }) => ({ id, text, order, status })), [
    { id: 1, text: "Question", order: 1, status: "pending" },
    { id: 2, text: "Todo", order: 2, status: "pending" },
    { id: 3, text: "Context", order: 3, status: "pending" },
  ]);

  store.apply({ action: "update", id: 2, text: "Session todo" });
  store.apply({ action: "start", id: 2 });
  store.apply({ action: "reorder", id: 3, beforeId: 1 });
  store.apply({ action: "complete", id: 2 });
  const final = store.apply({ action: "cancel", id: 1 });
  assert.deepEqual(final.tasks.map(({ id, text, order, status }) => ({ id, text, order, status })), [
    { id: 3, text: "Context", order: 1, status: "pending" },
    { id: 1, text: "Question", order: 2, status: "cancelled" },
    { id: 2, text: "Session todo", order: 3, status: "completed" },
  ]);
  assert.equal(add(store, "Packaging").tasks.at(-1)?.id, 4);
});

test("starting a second task returns the prior active task to pending", () => {
  const store = new TodoStore();
  add(store, "First");
  add(store, "Second");
  store.apply({ action: "start", id: 1 });
  const second = store.apply({ action: "start", id: 2 });
  assert.equal(second.tasks.find((task) => task.id === 1)?.status, "pending");
  assert.equal(second.tasks.find((task) => task.id === 2)?.status, "in_progress");
  assert.equal(second.tasks.filter((task) => task.status === "in_progress").length, 1);
});

test("dependency validation rejects unknown IDs, self-dependencies, cycles, and incomplete completion atomically", () => {
  const store = new TodoStore();
  add(store, "Foundation");
  add(store, "Feature", [1]);

  const assertRejectedWithoutMutation = (mutation: Parameters<TodoStore["apply"]>[0], pattern: RegExp) => {
    const before = store.snapshot();
    const rejected = store.apply(mutation);
    assert.match(rejected.error ?? "", pattern);
    assert.deepEqual(rejected.tasks, before.tasks);
    assert.equal(rejected.nextId, before.nextId);
  };

  assertRejectedWithoutMutation({ action: "add", text: "Unknown", dependencies: [99] }, /#99/);
  assertRejectedWithoutMutation({ action: "update", id: 1, dependencies: [1] }, /itself/);
  assertRejectedWithoutMutation({ action: "update", id: 1, dependencies: [2] }, /cycle/i);
  assertRejectedWithoutMutation({ action: "complete", id: 2 }, /#1 is not completed/);
  assertRejectedWithoutMutation({ action: "start", id: 2 }, /#1 is not completed/);

  store.apply({ action: "complete", id: 1 });
  assert.equal(store.apply({ action: "complete", id: 2 }).tasks.find((task) => task.id === 2)?.status, "completed");
});

test("cancelled dependencies remain unsatisfied and terminal tasks reject every mutation", () => {
  const store = new TodoStore();
  add(store, "Dependency");
  add(store, "Dependent", [1]);
  store.apply({ action: "cancel", id: 1 });
  assert.match(store.apply({ action: "complete", id: 2 }).error ?? "", /not completed/);

  for (const mutation of [
    { action: "update", id: 1, text: "Reopen" },
    { action: "start", id: 1 },
    { action: "complete", id: 1 },
    { action: "cancel", id: 1 },
    { action: "reorder", id: 1 },
  ] as const) {
    const before = store.snapshot();
    const rejected = store.apply(mutation);
    assert.match(rejected.error ?? "", /cancelled/);
    assert.deepEqual(rejected.tasks, before.tasks);
  }
});

test("unknown targets and invalid reorder operations retain the prior snapshot", () => {
  const store = new TodoStore();
  add(store, "One");
  add(store, "Two");
  const before = store.snapshot();
  for (const mutation of [
    { action: "start", id: 99 },
    { action: "reorder", id: 1, beforeId: 99 },
    { action: "reorder", id: 1, beforeId: 1 },
  ] as const) {
    const rejected = store.apply(mutation);
    assert.ok(rejected.error);
    assert.deepEqual(rejected.tasks, before.tasks);
    assert.equal(rejected.nextId, before.nextId);
  }
});

test("active-branch reconstruction selects the latest todo snapshot and isolates sessions", () => {
  const source = new TodoStore();
  const first = add(source, "Question");
  const second = add(source, "Todo");
  const restored = new TodoStore();

  reconstructTodoState(restored, [
    resultEntry(first),
    { type: "message", message: { role: "toolResult", toolName: "bash", details: second } },
    resultEntry(second),
  ]);
  assert.deepEqual(tasks(restored).map((task) => task.text), ["Question", "Todo"]);
  assert.equal(restored.snapshot().nextId, 3);

  reconstructTodoState(restored, [resultEntry(first)]); // tree navigation to the earlier leaf
  assert.deepEqual(tasks(restored).map((task) => task.text), ["Question"]);
  assert.equal(restored.snapshot().nextId, 2);

  reconstructTodoState(restored, []); // new or separate session
  assert.deepEqual(tasks(restored), []);
  assert.equal(restored.snapshot().nextId, 1);
});

test("rejected tool mutations still return complete details and bounded text", async () => {
  const store = new TodoStore();
  const tool = createTodoTool(store);
  add(store, "x".repeat(60_000));
  for (let index = 0; index < 2_100; index++) add(store, `task-${index}`);

  const listed = await tool.execute("todo-list", { action: "list" }, undefined, undefined, undefined);
  assert.equal(listed.details.tasks.length, 2_101);
  assert.equal(listed.details.nextId, 2_102);
  assert.ok(Buffer.byteLength(listed.content[0]!.text, "utf8") <= 50 * 1024);
  assert.ok(listed.content[0]!.text.split("\n").length <= 2_000);
  assert.match(listed.content[0]!.text, /truncated todo result/);
  assert.match(boundTodoText("z".repeat(60_000)), /truncated todo result/);

  const rejected = await tool.execute("todo-error", { action: "update", id: 9_999, text: "missing" }, undefined, undefined, undefined);
  assert.ok(rejected.details.error);
  assert.equal(rejected.details.tasks.length, 2_101);
});
