import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { deploymentTaskStatusMarker, type AssociateDeploymentTicketInput } from "@pa-platform/pa-core";
import {
  CONTEXT_LOOKUP_DEADLINE_MS,
  CONTEXT_REFRESH_INTERVAL_MS,
  PA_CANONICAL_REPO_ROOT_ENV,
  ContextRefreshLimiter,
  collectContext,
  initialContextSnapshot,
  withDeadline,
  type PaContextSnapshot,
} from "../pi-extension/context-state.js";
import {
  CONTEXT_MIN_WIDTH,
  CONTEXT_WIDTH_PERCENT,
  ContextSidebarComponent,
  formatCompactContext,
  formatContextLines,
  registerContextUiModuleWithOptions,
} from "../pi-extension/context-ui.js";
import type { TodoDetails } from "../pi-extension/todo.js";

const TODO: TodoDetails = {
  action: "list",
  nextId: 3,
  tasks: [
    { id: 1, text: "Question", status: "completed", order: 1, dependencies: [] },
    { id: 2, text: "Context", status: "in_progress", order: 2, dependencies: [1] },
  ],
};

function managedSnapshot(): PaContextSnapshot {
  return {
    deployment: { available: true, id: "d-test", team: "builder", mode: "worker", ticket: "PAP-145", launchTicket: "PAP-145", status: "running", projectionAvailable: true, stale: false },
    model: { provider: "openai-codex", model: "gpt-5.4" },
    repository: { cwd: "/repo/pa-platform", identity: "pa-platform" },
    git: { available: true, branch: "feature/PAP-145", dirty: true, stale: false },
    todo: { tasks: TODO.tasks, total: 2, completed: 1, active: TODO.tasks[1] },
    updatedAt: Date.parse("2026-08-26T00:00:00.000Z"),
    stale: false,
  };
}

test("ordinary sessions retain model, repository, Git, and todo while PA is unavailable", async () => {
  const initial = initialContextSnapshot(
    { cwd: "/repo/demo", model: { provider: "anthropic", id: "claude" }, todo: TODO },
    { env: {}, now: () => 100 },
  );
  const snapshot = await collectContext(initial, { cwd: "/repo/demo", model: { provider: "anthropic", id: "claude" }, todo: TODO }, {
    env: {},
    now: () => 200,
    gitLookup: async () => ({ available: true, branch: "develop", dirty: false }),
  });
  assert.equal(snapshot.deployment.available, false);
  assert.deepEqual(snapshot.model, { provider: "anthropic", model: "claude" });
  assert.equal(snapshot.repository.identity, "demo");
  assert.equal(snapshot.git.branch, "develop");
  assert.equal(snapshot.todo.active?.text, "Context");
  assert.match(formatCompactContext(snapshot), /PA:unavailable/);
});

test("managed context reads PA identity and deployment status", async () => {
  const env = {
    PA_DEPLOYMENT_ID: "d-test",
    PA_TEAM: "builder",
    PA_MODE: "worker",
    PA_TICKET_ID: "PAP-145",
    PA_REPO: "pa-platform",
    PA_PROVIDER: "openai-codex",
    PA_MODEL: "gpt-5.4",
  };
  const initial = initialContextSnapshot({ cwd: "/repo" }, { env, now: () => 1 });
  const snapshot = await collectContext(initial, { cwd: "/repo" }, {
    env,
    now: () => 2,
    gitLookup: async () => ({ available: true, branch: "feature/PAP-145", dirty: true }),
    deploymentLookup: async () => ({ status: "running", ticket: "PAP-145" }),
  });
  assert.deepEqual(snapshot.deployment, {
    available: true,
    id: "d-test",
    team: "builder",
    mode: "worker",
    ticket: "PAP-145",
    launchTicket: "PAP-145",
    status: "running",
    projectionAvailable: true,
    stale: false,
  });
  assert.match(formatCompactContext(snapshot), /d-test\/builder\/worker\/PAP-145/);
  assert.match(formatCompactContext(snapshot), /git:feature\/PAP-145\*/);
});

test("registry projection replaces the displayed current ticket without mutating launch evidence", async () => {
  const env = {
    PA_DEPLOYMENT_ID: "d-external",
    PA_TEAM: "requirements",
    PA_MODE: "analyze",
    PA_TICKET_ID: "PAP-OLD",
  };
  const initial = initialContextSnapshot({ cwd: "/repo" }, { env, now: () => 1 });
  const snapshot = await collectContext(initial, { cwd: "/repo" }, {
    env,
    now: () => 2,
    gitLookup: async () => ({ available: false }),
    deploymentLookup: async () => ({ status: "running", ticket: "PAP-NEW" }),
  });
  assert.equal(snapshot.deployment.ticket, "PAP-NEW");
  assert.equal(snapshot.deployment.launchTicket, "PAP-OLD");
  assert.equal(snapshot.deployment.projectionAvailable, true);
  assert.equal(env.PA_TICKET_ID, "PAP-OLD");
  assert.match(formatContextLines(snapshot).join("\n"), /Current ticket: PAP-NEW \(registry\)/);
  assert.match(formatContextLines(snapshot).join("\n"), /Launch ticket \(environment\): PAP-OLD/);
});

test("managed Alt+I separates canonical repository identity from worktree Path and Git", async () => {
  const canonicalRoot = "/registered/pa-platform";
  const worktreeRoot = "/treehouse/PAP-221/pa-platform";
  const env = {
    PA_DEPLOYMENT_ID: "d-worktree",
    PA_REPO: worktreeRoot,
    PA_WORKTREE_ROOT: worktreeRoot,
    [PA_CANONICAL_REPO_ROOT_ENV]: canonicalRoot,
  };
  let gitLookupCwd = "";
  const initial = initialContextSnapshot({ cwd: worktreeRoot }, { env, now: () => 1 });
  const snapshot = await collectContext(initial, { cwd: worktreeRoot }, {
    env,
    now: () => 2,
    gitLookup: async (cwd) => {
      gitLookupCwd = cwd;
      return { available: true, branch: "feature/PAP-221-worktree", dirty: true };
    },
    deploymentLookup: async () => "running",
  });

  assert.equal(snapshot.repository.identity, canonicalRoot);
  assert.equal(snapshot.repository.cwd, worktreeRoot);
  assert.equal(gitLookupCwd, worktreeRoot);
  const lines = formatContextLines(snapshot);
  assert.ok(lines.includes(`Repository: ${canonicalRoot}`));
  assert.ok(lines.includes(`Path: ${worktreeRoot}`));
  assert.ok(lines.includes("Git: feature/PAP-221-worktree (dirty)"));
});

test("500 ms lookup deadline abandons late values and retains stale prior data", async () => {
  assert.equal(CONTEXT_LOOKUP_DEADLINE_MS, 500);
  const prior = managedSnapshot();
  const snapshot = await collectContext(prior, { cwd: "/repo/pa-platform" }, {
    env: { PA_DEPLOYMENT_ID: "d-test" },
    deadlineMs: 5,
    gitLookup: async () => new Promise(() => {}),
    deploymentLookup: async () => new Promise(() => {}),
  });
  assert.equal(snapshot.git.branch, prior.git.branch);
  assert.equal(snapshot.git.stale, true);
  assert.equal(snapshot.deployment.status, "running");
  assert.equal(snapshot.deployment.ticket, "PAP-145");
  assert.equal(snapshot.deployment.launchTicket, "PAP-145");
  assert.equal(snapshot.deployment.projectionAvailable, true);
  assert.equal(snapshot.deployment.stale, true);
  assert.equal(snapshot.stale, true);
  assert.match(formatContextLines(snapshot).join("\n"), /stale/);
});

test("withDeadline distinguishes timeout and successful completion", async () => {
  const timedOut = await withDeadline(async () => new Promise<string>(() => {}), 2);
  assert.deepEqual(timedOut, { ok: false, timedOut: true });
  const completed = await withDeadline(async () => "ok", 50);
  assert.deepEqual(completed, { ok: true, value: "ok", timedOut: false });
});

test("refresh limiter coalesces bursts to at most one refresh per 2,000 ms and disposes timers", async () => {
  assert.equal(CONTEXT_REFRESH_INTERVAL_MS, 2_000);
  let now = 0;
  let scheduled: (() => void) | undefined;
  let scheduledDelay: number | undefined;
  let cleared = 0;
  const fakeSetTimer = ((callback: () => void, delay?: number) => {
    scheduled = callback;
    scheduledDelay = delay;
    return 1 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  const fakeClearTimer = (() => { cleared++; }) as typeof clearTimeout;
  const limiter = new ContextRefreshLimiter(2_000, () => now, fakeSetTimer, fakeClearTimer);
  const runs: number[] = [];

  limiter.request(() => { runs.push(now); });
  limiter.request(() => { runs.push(now); });
  limiter.request(() => { runs.push(now); });
  assert.deepEqual(runs, [0]);
  assert.equal(scheduledDelay, 2_000);
  now = 2_000;
  scheduled?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, [0, 2_000]);

  limiter.request(() => { runs.push(now); });
  assert.equal(scheduledDelay, 2_000);
  await limiter.dispose();
  assert.ok(cleared >= 1);
  now = 4_000;
  scheduled?.();
  assert.deepEqual(runs, [0, 2_000]);
});

test("refresh limiter stops new scheduling and awaits an active context refresh", async () => {
  const order: string[] = [];
  let release: (() => void) | undefined;
  const limiter = new ContextRefreshLimiter();
  limiter.request(async () => {
    order.push("refresh-start");
    await new Promise<void>((resolve) => { release = resolve; });
    order.push("refresh-settled");
  });

  const disposal = limiter.dispose().then(() => { order.push("disposed"); });
  limiter.request(() => { order.push("late-refresh"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["refresh-start"]);
  release?.();
  await disposal;
  assert.deepEqual(order, ["refresh-start", "refresh-settled", "disposed"]);
});

test("refresh limiter never overlaps and runs the latest coalesced request after settlement", async () => {
  let now = 0;
  let release: (() => void) | undefined;
  const order: string[] = [];
  const limiter = new ContextRefreshLimiter(CONTEXT_REFRESH_INTERVAL_MS, () => now);
  limiter.request(async () => {
    order.push("first-start");
    await new Promise<void>((resolve) => { release = resolve; });
    order.push("first-end");
  });
  now = CONTEXT_REFRESH_INTERVAL_MS;
  limiter.request(() => { order.push("superseded"); });
  limiter.request(() => { order.push("latest"); });
  assert.deepEqual(order, ["first-start"]);

  release?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start", "first-end", "latest"]);
  await limiter.dispose();
});

test("idle periodic refresh publishes an external ticket within 2,500 ms and lifecycle cleanup owns one timer", async () => {
  const events = new Map<string, (event: unknown, context: unknown) => unknown>();
  let command: ((args: string, context: unknown) => unknown) | undefined;
  let shutdownStep: ((event: unknown, context: unknown) => unknown) | undefined;
  let periodicCallback: (() => void) | undefined;
  let intervalDelay: number | undefined;
  let intervalCreates = 0;
  let intervalClears = 0;
  let intervalUnrefs = 0;
  let lookupCalls = 0;
  let projectedTicket = "PAP-OLD";
  let sidebar: ContextSidebarComponent | undefined;
  let sidebarRenders = 0;
  const statuses: Array<string | undefined> = [];
  const intervalHandle = { unref: () => { intervalUnrefs++; } } as unknown as ReturnType<typeof setInterval>;
  const fakeSetInterval = ((callback: () => void, delay: number) => {
    intervalCreates++;
    periodicCallback = callback;
    intervalDelay = delay;
    return intervalHandle;
  }) as unknown as typeof setInterval;
  const fakeClearInterval = ((handle: ReturnType<typeof setInterval>) => {
    assert.equal(handle, intervalHandle);
    intervalClears++;
  }) as typeof clearInterval;
  const lifecycle = {
    addShutdownStep(step: (event: unknown, context: unknown) => unknown) { shutdownStep = step; },
    async trackRegistryAccess<T>(access: () => T | Promise<T>): Promise<T> { return await access(); },
    async shutdown(): Promise<void> {},
  };

  registerContextUiModuleWithOptions({
    on: ((name: string, handler: (event: unknown, context: unknown) => unknown) => events.set(name, handler)) as never,
    registerCommand: (_name, options) => { command = options.handler; },
  }, {
    lifecycle,
    limiter: new ContextRefreshLimiter(0),
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    collector: {
      env: { PA_DEPLOYMENT_ID: "d-idle", PA_TEAM: "requirements", PA_MODE: "analyze", PA_TICKET_ID: "PAP-LAUNCH" },
      gitLookup: async () => ({ available: false }),
      deploymentLookup: async () => {
        lookupCalls++;
        return { status: "running", ticket: projectedTicket };
      },
    },
  });

  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    sessionManager: { getBranch: () => [] },
    ui: {
      setStatus: (_id: string, value: string | undefined) => statuses.push(value),
      notify() {},
      custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => ContextSidebarComponent, options: { onHandle: (handle: unknown) => void }) => {
        sidebar = factory(
          { requestRender: () => { sidebarRenders++; } },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          {},
          () => {},
        );
        options.onHandle({ setHidden() {}, focus() {}, unfocus() {}, hide() {} });
      },
    },
  };

  events.get("session_start")?.({}, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(statuses.at(-1) ?? "", /PAP-OLD/);
  assert.equal(intervalDelay, CONTEXT_REFRESH_INTERVAL_MS);
  assert.equal(intervalDelay! + CONTEXT_LOOKUP_DEADLINE_MS, 2_500);
  assert.equal(intervalCreates, 1);
  assert.equal(intervalUnrefs, 1);

  events.get("session_start")?.({ reason: "reload" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(intervalCreates, 2);
  assert.equal(intervalClears, 1, "session reload replaces rather than duplicates the owned timer");
  command?.("", context);
  await new Promise((resolve) => setImmediate(resolve));

  projectedTicket = "PAP-EXTERNAL";
  periodicCallback?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(statuses.at(-1) ?? "", /PAP-EXTERNAL/);
  assert.match(sidebar?.render(120).join("\n") ?? "", /Current ticket: PAP-EXTERNAL \(registry\)/);
  assert.ok(sidebarRenders > 0);

  const callsBeforeCleanup = lookupCalls;
  await shutdownStep?.({ type: "session_shutdown", reason: "quit" }, context);
  assert.equal(intervalClears, 2);
  assert.equal(statuses.at(-1), undefined);
  projectedTicket = "PAP-AFTER-SHUTDOWN";
  periodicCallback?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookupCalls, callsBeforeCleanup);
  assert.doesNotMatch(statuses.filter((value): value is string => typeof value === "string").at(-1) ?? "", /PAP-AFTER-SHUTDOWN/);
});

test("compact and expanded rendering expose required context within supplied width", () => {
  const snapshot = managedSnapshot();
  const compact = formatCompactContext(snapshot);
  assert.match(compact, /PA:d-test/);
  assert.match(compact, /openai-codex\/gpt-5.4/);
  assert.match(compact, /pa-platform/);
  assert.match(compact, /git:feature\/PAP-145\*/);
  assert.match(compact, /todo:1\/2 #2:Context/);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = new ContextSidebarComponent(
    { requestRender() {} } as never,
    theme as never,
    () => snapshot,
    () => {},
  );
  for (const width of [1, 20, 42, 80]) {
    for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
    component.invalidate();
  }
  assert.match(formatContextLines(snapshot).join("\n"), /Deployment status: running/);
  assert.match(formatContextLines(snapshot).join("\n"), /▶ #2 Context/);
});

test("Alt+I task rows retain all four lifecycle markers from the shared core mapping", () => {
  const snapshot = managedSnapshot();
  const statuses = ["pending", "in_progress", "completed", "cancelled"] as const;
  snapshot.todo = {
    tasks: statuses.map((status, index) => ({ id: index + 1, text: status, status, order: index + 1, dependencies: [] })),
    total: statuses.length,
    completed: 1,
    active: undefined,
  };
  const taskLines = formatContextLines(snapshot).filter((line) => /^.[ ]#\d+/.test(line));
  assert.deepEqual(taskLines, statuses.map((status, index) => `${deploymentTaskStatusMarker(status)} #${index + 1} ${status}`));
  assert.deepEqual(taskLines, [
    "○ #1 pending",
    "▶ #2 in_progress",
    "✓ #3 completed",
    "− #4 cancelled",
  ]);
});

test("ticket command attaches and explicitly confirms replacement using the exact projected ticket", async () => {
  let command: ((args: string, context: unknown) => unknown) | undefined;
  let projectedTicket: string | undefined;
  const inputs: AssociateDeploymentTicketInput[] = [];
  const inputTitles: string[] = [];
  const confirmations: Array<[string, string]> = [];
  const notifications: Array<[string, string | undefined]> = [];
  registerContextUiModuleWithOptions({
    registerCommand: (_name, options) => { command = options.handler; },
  }, {
    limiter: new ContextRefreshLimiter(0),
    collector: {
      env: { PA_DEPLOYMENT_ID: "d-ticket", PA_TEAM: "requirements", PA_MODE: "analyze" },
      gitLookup: async () => ({ available: false }),
      deploymentLookup: async () => ({ status: "running", ticket: projectedTicket }),
    },
    associateTicket: (input) => {
      inputs.push(input);
      const previousTicketId = projectedTicket ?? null;
      projectedTicket = input.ticketId;
      return {
        deploymentId: input.deploymentId,
        previousTicketId,
        requestedTicketId: input.ticketId,
        currentTicketId: input.ticketId,
        actor: input.actor.trim(),
        reason: input.reason.trim(),
        writeOccurred: previousTicketId !== input.ticketId,
      };
    },
  });
  const reasons = ["  ticket established  ", "replace after review"];
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    sessionManager: { getBranch: () => [] },
    ui: {
      input: async (title: string) => { inputTitles.push(title); return reasons.shift(); },
      confirm: async (title: string, message: string) => { confirmations.push([title, message]); return true; },
      notify: (message: string, level?: string) => { notifications.push([message, level]); },
      setStatus() {},
    },
  };

  await command?.("ticket PAP-001", context);
  assert.equal(inputs[0]?.expectedTicketId, null);
  assert.equal(inputs[0]?.actor, "requirements/analyze");
  assert.equal(inputs[0]?.reason, "  ticket established  ");
  assert.match(inputTitles[0] ?? "", /Current: none\nTarget: PAP-001/);
  assert.equal(confirmations.length, 0, "ticketless attach does not require replacement confirmation");

  await command?.("ticket PAP-002", context);
  assert.equal(inputs[1]?.expectedTicketId, "PAP-001");
  assert.match(inputTitles[1] ?? "", /Current: PAP-001\nTarget: PAP-002/);
  assert.match(confirmations[0]?.[1] ?? "", /Current: PAP-001\nTarget: PAP-002/);
  assert.match(notifications.at(-1)?.[0] ?? "", /PA current ticket: PAP-002 .*association written/);
});

test("ticket command cancellation, prompt close, and non-TUI use perform no association", async () => {
  let command: ((args: string, context: unknown) => unknown) | undefined;
  let associationCalls = 0;
  const notifications: string[] = [];
  let reason: string | undefined;
  registerContextUiModuleWithOptions({
    registerCommand: (_name, options) => { command = options.handler; },
  }, {
    limiter: new ContextRefreshLimiter(0),
    collector: {
      env: { PA_DEPLOYMENT_ID: "d-ticket", PA_TEAM: "requirements", PA_MODE: "analyze", PA_TICKET_ID: "PAP-LAUNCH" },
      gitLookup: async () => ({ available: false }),
      deploymentLookup: async () => ({ status: "running", ticket: "PAP-CURRENT" }),
    },
    associateTicket: (input) => {
      associationCalls += 1;
      return { deploymentId: input.deploymentId, previousTicketId: "PAP-CURRENT", requestedTicketId: input.ticketId, currentTicketId: input.ticketId, actor: input.actor, reason: input.reason, writeOccurred: true };
    },
  });
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    sessionManager: { getBranch: () => [] },
    ui: {
      input: async () => reason,
      confirm: async () => false,
      notify: (message: string) => { notifications.push(message); },
      setStatus() {},
    },
  };

  await command?.("ticket PAP-NEW", context);
  reason = "   ";
  await command?.("ticket PAP-NEW", context);
  reason = "replacement declined";
  await command?.("ticket PAP-NEW", context);
  await command?.("ticket PAP-NEW", { ...context, mode: "print", hasUI: false });
  assert.equal(associationCalls, 0);
  assert.ok(notifications.some((message) => /cancelled; no changes were written/.test(message)));
  assert.ok(notifications.some((message) => /requires a non-empty reason/.test(message)));
  assert.equal(notifications.at(-1), "PA ticket interaction is unavailable outside TUI mode.");
});

test("command and Alt+I toggle the same initially hidden responsive right overlay", async () => {
  const events = new Map<string, (event: unknown, context: unknown) => unknown>();
  let command: ((args: string, context: unknown) => unknown) | undefined;
  let shortcut: ((context: unknown) => unknown) | undefined;
  const hidden: boolean[] = [];
  let focused = 0;
  let unfocused = 0;
  let hiddenPermanently = 0;
  let overlayOptions: { anchor?: string; width?: number | string; minWidth?: number; margin?: number | { right?: number }; visible?: (width: number, height: number) => boolean } | undefined;
  const statuses: Array<string | undefined> = [];

  registerContextUiModuleWithOptions({
    on: ((name: string, handler: (event: unknown, context: unknown) => unknown) => events.set(name, handler)) as never,
    registerCommand: (_name, options) => { command = options.handler; },
    registerShortcut: (_key, options) => { shortcut = options.handler; },
  }, {
    collector: {
      env: {},
      gitLookup: async () => ({ available: false }),
      deploymentLookup: async () => undefined,
    },
  });

  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo/demo",
    model: { provider: "anthropic", id: "claude" },
    sessionManager: { getBranch: () => [] },
    ui: {
      setStatus: (_id: string, value: string | undefined) => statuses.push(value),
      notify() {},
      custom: async (_factory: unknown, options: { overlayOptions: typeof overlayOptions; onHandle: (handle: unknown) => void }) => {
        overlayOptions = options.overlayOptions;
        options.onHandle({
          setHidden: (value: boolean) => hidden.push(value),
          focus: () => { focused++; },
          unfocus: () => { unfocused++; },
          hide: () => { hiddenPermanently++; },
        });
      },
    },
  };

  events.get("session_start")?.({}, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(statuses.at(-1)?.includes("PA:unavailable"));
  assert.equal(hidden.length, 0); // initially hidden: overlay has not been created

  command?.("", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overlayOptions?.anchor, "top-right");
  assert.equal(CONTEXT_WIDTH_PERCENT, 34 * 2);
  assert.equal(overlayOptions?.width, `${CONTEXT_WIDTH_PERCENT}%`);
  assert.equal(overlayOptions?.minWidth, 42);
  assert.deepEqual(overlayOptions?.margin, { right: 1 });
  assert.equal(overlayOptions?.visible?.(CONTEXT_MIN_WIDTH - 1, 40), false);
  assert.equal(overlayOptions?.visible?.(CONTEXT_MIN_WIDTH, 40), true);
  assert.ok(statuses.at(-1)?.includes("PA:unavailable"), "narrow terminals retain the compact status fallback");
  assert.equal(focused, 1);

  shortcut?.(context);
  assert.deepEqual(hidden, [true]);
  assert.equal(unfocused, 1);
  command?.("", context);
  assert.deepEqual(hidden, [true, false]);
  assert.equal(focused, 2);

  events.get("session_shutdown")?.({}, context);
  assert.equal(statuses.at(-1), undefined);
  assert.equal(hiddenPermanently, 1);
});
