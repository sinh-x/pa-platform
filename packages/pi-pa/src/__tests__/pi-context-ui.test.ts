import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  CONTEXT_LOOKUP_DEADLINE_MS,
  CONTEXT_REFRESH_INTERVAL_MS,
  ContextRefreshLimiter,
  collectContext,
  initialContextSnapshot,
  withDeadline,
  type PaContextSnapshot,
} from "../pi-extension/context-state.js";
import {
  CONTEXT_MIN_WIDTH,
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
    deployment: { available: true, id: "d-test", team: "builder", mode: "worker", ticket: "PAP-145", status: "running", stale: false },
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
    deploymentLookup: async () => "running",
  });
  assert.deepEqual(snapshot.deployment, {
    available: true,
    id: "d-test",
    team: "builder",
    mode: "worker",
    ticket: "PAP-145",
    status: "running",
    stale: false,
  });
  assert.match(formatCompactContext(snapshot), /d-test\/builder\/worker\/PAP-145/);
  assert.match(formatCompactContext(snapshot), /git:feature\/PAP-145\*/);
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

test("refresh limiter coalesces bursts to at most one refresh per 2,000 ms and disposes timers", () => {
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
  assert.deepEqual(runs, [0, 2_000]);

  limiter.request(() => { runs.push(now); });
  assert.equal(scheduledDelay, 2_000);
  limiter.dispose();
  assert.ok(cleared >= 1);
  now = 4_000;
  scheduled?.();
  assert.deepEqual(runs, [0, 2_000]);
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

test("command and Alt+I toggle the same initially hidden responsive right overlay", async () => {
  const events = new Map<string, (event: unknown, context: unknown) => unknown>();
  let command: ((args: string, context: unknown) => unknown) | undefined;
  let shortcut: ((context: unknown) => unknown) | undefined;
  const hidden: boolean[] = [];
  let focused = 0;
  let unfocused = 0;
  let hiddenPermanently = 0;
  let overlayOptions: { anchor?: string; visible?: (width: number, height: number) => boolean } | undefined;
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
  assert.equal(overlayOptions?.anchor, "right-center");
  assert.equal(overlayOptions?.visible?.(CONTEXT_MIN_WIDTH - 1, 40), false);
  assert.equal(overlayOptions?.visible?.(CONTEXT_MIN_WIDTH, 40), true);
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
