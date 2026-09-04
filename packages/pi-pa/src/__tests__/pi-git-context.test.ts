import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  GIT_CONTEXT_COLLECTION_DEADLINE_MS,
  GIT_CONTEXT_COMMIT_LIMIT,
  GIT_CONTEXT_FILE_LIMIT,
  GIT_CONTEXT_REFRESH_INTERVAL_MS,
  GitContextRefreshScheduler,
  collectGitContext,
  gitContextStatePath,
  loadGitContextReference,
  parseGitBranches,
  parseGitLog,
  parseGitNumstat,
  persistGitContextReference,
  resolveGitReference,
  type GitBranch,
  type GitCommandRunner,
  type GitContextCollectionInput,
  type GitContextState,
} from "../pi-extension/git-context-state.js";
import {
  GIT_CONTEXT_COMMAND,
  GIT_CONTEXT_MIN_WIDE_WIDTH,
  GIT_CONTEXT_SHORTCUT,
  GitContextPanelComponent,
  GitReferenceSelectorComponent,
  formatGitContextLines,
  gitContextOverlayOptions,
  registerGitContextUiModuleWithOptions,
  type GitContextRefreshSchedulerLike,
} from "../pi-extension/git-context-ui.js";

const OID = "a".repeat(40);
const BRANCHES: GitBranch[] = [
  { name: "develop", fullName: "refs/heads/develop", kind: "local", current: false },
  { name: "main", fullName: "refs/heads/main", kind: "local", current: false },
  { name: "origin/develop", fullName: "refs/remotes/origin/develop", kind: "remote", current: false },
  { name: "origin/main", fullName: "refs/remotes/origin/main", kind: "remote", current: false },
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepository(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "pi-git-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Pi Test");
  git(root, "config", "user.email", "pi@example.test");
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "branch", "develop");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  git(root, "update-ref", "refs/remotes/origin/develop", base);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "update-ref", "refs/custom/free-form", base);
  git(root, "tag", "release-test", base);
  git(root, "checkout", "-q", "-b", "feature/test");

  for (let index = 0; index < 25; index++) {
    writeFileSync(join(root, `file-${String(index).padStart(2, "0")}.txt`), `line ${index}\n`);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "feature-01");
  for (let index = 2; index <= 12; index++) {
    writeFileSync(join(root, "file-00.txt"), `extra ${index}\n`, { flag: "a" });
    git(root, "add", "file-00.txt");
    git(root, "commit", "-q", "-m", `feature-${String(index).padStart(2, "0")}`);
  }
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "worktree-only.txt"), "not committed\n");
  return root;
}

function scriptedRunner(overrides: Partial<Record<string, string | Error | "pending">> = {}, calls?: string[][]): GitCommandRunner {
  return async (_cwd, args) => {
    calls?.push([...args]);
    const key = args[0] === "rev-parse" && args.includes("--show-toplevel") ? "root" : args[0]!;
    const override = overrides[key];
    if (override === "pending") return new Promise<string>(() => {});
    if (override instanceof Error) throw override;
    if (typeof override === "string") return override;
    switch (key) {
      case "root": return "/repo\n";
      case "rev-parse": return `${OID}\n`;
      case "symbolic-ref": return "feature/test\n";
      case "for-each-ref": return "refs/heads/develop\0\nrefs/heads/feature/test\0\n";
      case "merge-base": return `${OID}\n`;
      case "rev-list": return "0\n";
      case "log":
      case "diff": return "";
      default: throw new Error(`Unexpected command: ${args.join(" ")}`);
    }
  };
}

async function scriptedCollection(overrides: Partial<Record<string, string | Error | "pending">> = {}, input: { explicitReference?: string } = {}): Promise<GitContextState> {
  return collectGitContext(undefined, { cwd: "/repo", ...input }, {
    runGit: scriptedRunner(overrides),
    canonicalize: async () => "/repo",
    loadReference: async () => undefined,
    now: () => 123,
    deadlineMs: 50,
  });
}

test("branch parser exposes only concrete local/remote branches and detects remote default", () => {
  const parsed = parseGitBranches([
    "refs/heads/main\0",
    "refs/heads/develop\0",
    "refs/remotes/origin/main\0",
    "refs/remotes/origin/develop\0",
    "refs/remotes/origin/HEAD\0refs/remotes/origin/main",
    "refs/tags/v1\0",
    "refs/custom/free-form\0",
    "",
  ].join("\n"), "main");
  assert.deepEqual(parsed.branches.map(({ name, kind, current }) => ({ name, kind, current })), [
    { name: "develop", kind: "local", current: false },
    { name: "main", kind: "local", current: true },
    { name: "origin/develop", kind: "remote", current: false },
    { name: "origin/main", kind: "remote", current: false },
  ]);
  assert.equal(parsed.detectedDefault, "origin/main");
  assert.ok(!parsed.branches.some((branch) => branch.name.endsWith("/HEAD")));
});

test("reference resolution honors saved selection then exact default/develop/origin fallback without persistence", () => {
  assert.deepEqual(resolveGitReference(BRANCHES, { savedReference: "main", detectedDefault: "origin/main" }), {
    branch: BRANCHES[1], source: "saved", missingExplicit: false,
  });
  assert.equal(resolveGitReference(BRANCHES, { savedReference: "missing", detectedDefault: "origin/main" }).source, "default");
  assert.equal(resolveGitReference(BRANCHES.filter((branch) => branch.name !== "origin/main"), { detectedDefault: "missing" }).source, "develop");
  assert.equal(resolveGitReference(BRANCHES.filter((branch) => branch.name !== "origin/main" && branch.name !== "develop"), {}).source, "origin-develop");
  assert.deepEqual(resolveGitReference(BRANCHES.filter((branch) => branch.name === "main"), {}), { missingExplicit: false });
  assert.deepEqual(resolveGitReference(BRANCHES, { explicitReference: OID }), { branch: undefined, source: undefined, missingExplicit: true });
});

test("NUL parsers preserve metadata, unusual paths, renames, and binary markers", () => {
  assert.deepEqual(parseGitLog(["abc1234", "message with\ttab", "An Author", "2026-08-28T10:00:00+07:00", ""].join("\0")), [{
    hash: "abc1234",
    message: "message with\ttab",
    author: "An Author",
    date: "2026-08-28T10:00:00+07:00",
  }]);
  assert.deepEqual(parseGitNumstat([
    "2\t1\tline\nwith\ttab.txt",
    "3\t4\t", "old\nname.txt", "new\tname.txt",
    "-\t-\tbinary.dat",
    "",
  ].join("\0")), [
    { path: "line\nwith\ttab.txt", displayPath: "line\nwith\ttab.txt", additions: 2, deletions: 1, binary: false },
    { path: "new\tname.txt", oldPath: "old\nname.txt", displayPath: "old\nname.txt → new\tname.txt", additions: 3, deletions: 4, binary: false },
    { path: "binary.dat", displayPath: "binary.dat", additions: null, deletions: null, binary: true },
  ]);
});

test("collector canonicalizes a nested worktree and returns exact committed 10/20 limits", async (t) => {
  const root = makeRepository(t);
  const state = await collectGitContext(undefined, { cwd: join(root, "nested") });
  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;
  assert.equal(state.snapshot.repositoryRoot, realpathSync(root));
  assert.equal(state.snapshot.activeBranch, "feature/test");
  assert.equal(state.snapshot.reference.name, "origin/main");
  assert.equal(state.snapshot.referenceSource, "default");
  assert.equal(state.snapshot.commitTotal, 12);
  assert.equal(state.snapshot.commits.length, GIT_CONTEXT_COMMIT_LIMIT);
  assert.equal(state.snapshot.commitTruncated, 2);
  assert.equal(state.snapshot.commits[0]?.message, "feature-12");
  assert.equal(state.snapshot.commits[0]?.author, "Pi Test");
  assert.match(state.snapshot.commits[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.snapshot.fileTotal, 25);
  assert.equal(state.snapshot.files.length, GIT_CONTEXT_FILE_LIMIT);
  assert.equal(state.snapshot.fileTruncated, 5);
  assert.equal(state.snapshot.additions, 36);
  assert.equal(state.snapshot.deletions, 0);
  assert.ok(!state.snapshot.files.some((file) => file.path === "worktree-only.txt"));
  assert.ok(!state.snapshot.branches.some((branch) => ["origin/HEAD", "release-test", "custom/free-form"].includes(branch.name)));
  assert.equal(await loadGitContextReference(root), undefined);
  assert.ok(!readdirSync(root).includes(CONFIG_DIR_NAME));

  assert.equal(await persistGitContextReference(root, "develop", state.snapshot.branches), true);
  const restored = await collectGitContext(undefined, { cwd: root });
  assert.equal(restored.status, "ready");
  if (restored.status === "ready") {
    assert.equal(restored.snapshot.reference.name, "develop");
    assert.equal(restored.snapshot.referenceSource, "saved");
  }
});

test("project-local state ignores missing/malformed values and atomically restores concurrent valid selections", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-git-persistence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = gitContextStatePath(root);
  assert.equal(statePath, join(root, CONFIG_DIR_NAME, "pa-git-context.json"));
  assert.equal(await loadGitContextReference(root), undefined);
  mkdirSync(join(root, CONFIG_DIR_NAME));
  writeFileSync(statePath, "{ malformed");
  assert.equal(await loadGitContextReference(root), undefined);
  writeFileSync(statePath, JSON.stringify({ version: 1, reference: 42 }));
  assert.equal(await loadGitContextReference(root), undefined);

  const writes = await Promise.all([
    persistGitContextReference(root, "main", BRANCHES, { uniqueId: () => "first" }),
    persistGitContextReference(root, "origin/main", BRANCHES, { uniqueId: () => "second" }),
  ]);
  assert.deepEqual(writes, [true, true]);
  assert.ok(["main", "origin/main"].includes((await loadGitContextReference(root)) ?? ""));
  assert.equal(await persistGitContextReference(root, OID, BRANCHES), false);
  assert.ok(["main", "origin/main"].includes((await loadGitContextReference(root)) ?? ""));
  assert.deepEqual(readdirSync(join(root, CONFIG_DIR_NAME)), ["pa-git-context.json"]);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).version, 1);
});

test("collector models every initial edge state and retains only prior error/timeout snapshots as stale", async () => {
  assert.equal((await scriptedCollection({ root: new Error("fatal: not a git repository") })).status, "non-git");
  assert.equal((await scriptedCollection({ "symbolic-ref": new Error("not symbolic") })).status, "detached-head");
  assert.equal((await scriptedCollection({ "rev-parse": new Error("unknown revision") })).status, "unborn-head");
  assert.equal((await scriptedCollection({}, { explicitReference: "missing" })).status, "missing-ref");
  assert.equal((await scriptedCollection({ "for-each-ref": "" })).status, "unavailable");
  assert.equal((await scriptedCollection({ "merge-base": new Error("no merge base") })).status, "missing-merge-base");
  assert.equal((await scriptedCollection({ "for-each-ref": new Error("Git exploded") })).status, "git-error");

  const timeout = await collectGitContext(undefined, { cwd: "/repo" }, {
    runGit: scriptedRunner({ root: "pending" }),
    canonicalize: async () => "/repo",
    deadlineMs: 5,
    now: () => 200,
  });
  assert.equal(GIT_CONTEXT_COLLECTION_DEADLINE_MS, 2_000);
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.stale, false);

  const ready = await scriptedCollection();
  assert.equal(ready.status, "ready");
  const staleError = await collectGitContext(ready, { cwd: "/repo" }, {
    runGit: scriptedRunner({ root: new Error("Git unavailable") }),
    canonicalize: async () => "/repo",
    now: () => 300,
  });
  assert.equal(staleError.status, "stale");
  if (staleError.status === "stale") assert.equal(staleError.cause, "git-error");
  const staleTimeout = await collectGitContext(ready, { cwd: "/repo" }, {
    runGit: scriptedRunner({ root: "pending" }),
    canonicalize: async () => "/repo",
    deadlineMs: 5,
    now: () => 400,
  });
  assert.equal(staleTimeout.status, "stale");
  if (staleTimeout.status === "stale" && ready.status === "ready") {
    assert.equal(staleTimeout.cause, "timeout");
    assert.equal(staleTimeout.snapshot, ready.snapshot);
  }
});

test("collector subprocess surface is fixed, validated, and read-only", async () => {
  const calls: string[][] = [];
  const state = await collectGitContext(undefined, { cwd: "/repo", explicitReference: "develop" }, {
    runGit: scriptedRunner({}, calls),
    canonicalize: async () => "/repo",
    now: () => 1,
  });
  assert.equal(state.status, "ready");
  assert.deepEqual(calls.map((args) => args[0]), [
    "rev-parse", "rev-parse", "symbolic-ref", "for-each-ref", "merge-base", "rev-list", "log", "diff",
  ]);
  const forbidden = new Set(["fetch", "checkout", "switch", "stage", "add", "commit", "reset"]);
  assert.ok(calls.every((args) => !args.some((arg) => forbidden.has(arg))));
  assert.deepEqual(calls[4]?.slice(0, 2), ["merge-base", "refs/heads/develop"]);
  assert.deepEqual(calls[7]?.slice(0, 5), ["diff", "--numstat", "-z", "--find-renames", `${OID}..HEAD`]);
});

test("first-open, reference-change, and event hooks coalesce to one start per 10 seconds and dispose", () => {
  assert.equal(GIT_CONTEXT_REFRESH_INTERVAL_MS, 10_000);
  let now = 0;
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  let clears = 0;
  const fakeSetTimer = ((handler: () => void, timeout?: number) => {
    callback = handler;
    delay = timeout;
    return 1 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  const fakeClearTimer = (() => { clears++; }) as typeof clearTimeout;
  const scheduler = new GitContextRefreshScheduler(10_000, () => now, fakeSetTimer, fakeClearTimer);
  const starts: Array<{ at: number; reason: string }> = [];
  const refresh = (reason: string) => { starts.push({ at: now, reason }); };

  scheduler.firstOpen(refresh);
  scheduler.event(refresh);
  scheduler.referenceChange(refresh);
  assert.deepEqual(starts, [{ at: 0, reason: "first-open" }]);
  assert.equal(delay, 10_000);
  now = 10_000;
  callback?.();
  assert.deepEqual(starts, [
    { at: 0, reason: "first-open" },
    { at: 10_000, reason: "reference-change" },
  ]);
  scheduler.event(refresh);
  scheduler.dispose();
  assert.ok(clears >= 1);
  now = 20_000;
  callback?.();
  assert.equal(starts.length, 2);
});

function uiReadyState(reference = "main"): GitContextState {
  const branches = BRANCHES.map((branch) => ({ ...branch }));
  const selected = branches.find((branch) => branch.name === reference) ?? branches[1]!;
  return {
    status: "ready",
    stale: false,
    snapshot: {
      repositoryRoot: "/repo",
      activeBranch: "feature/PAP-149-wide-界面",
      reference: selected,
      referenceSource: reference === "main" ? "saved" : "explicit",
      branches,
      mergeBase: OID,
      commits: Array.from({ length: 12 }, (_, index) => ({
        hash: `c${String(index).padStart(6, "0")}`,
        message: `commit ${index} with a long message and unicode 界面`,
        author: `Author ${index}`,
        date: "2026-08-28T10:00:00+07:00",
      })),
      commitTotal: 12,
      commitTruncated: 2,
      files: Array.from({ length: 25 }, (_, index) => ({
        path: `src/long/path/file-${index}-界面.ts`,
        displayPath: `src/long/path/file-${index}-界面.ts`,
        additions: index + 1,
        deletions: index,
        binary: false,
      })),
      fileTotal: 25,
      fileTruncated: 5,
      additions: 325,
      deletions: 300,
      collectedAt: 123,
    },
  };
}

const TEST_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const REQUIRED_WIDTHS = [40, 80, 119, 120, 160] as const;

test("Git panel and SelectList selector are width-safe at 40, 80, 119, 120, and 160 columns", () => {
  const state = uiReadyState();
  const panel = new GitContextPanelComponent(
    { requestRender() {} } as never,
    TEST_THEME as never,
    () => state,
    () => {},
    () => {},
  );
  const selector = new GitReferenceSelectorComponent(
    { requestRender() {} } as never,
    TEST_THEME as never,
    BRANCHES,
    "main",
    () => {},
  );

  for (const width of REQUIRED_WIDTHS) {
    assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width), `panel overflow at ${width}`);
    assert.ok(selector.render(width).every((line) => visibleWidth(line) <= width), `selector overflow at ${width}`);
    panel.invalidate();
    selector.invalidate();
  }

  const content = formatGitContextLines(state);
  assert.match(content.join("\n"), /Active: feature\/PAP-149-wide-界面/);
  assert.match(content.join("\n"), /Reference: main \(saved\)/);
  assert.match(content.join("\n"), /Commits: 10\/12 shown • 2 truncated/);
  assert.equal(content.filter((line) => /^  c\d{6} /.test(line)).length, GIT_CONTEXT_COMMIT_LIMIT);
  assert.match(content.join("\n"), /Diff: \+325 -300/);
  assert.match(content.join("\n"), /Files: 20\/25 shown • 5 truncated/);
  assert.equal(content.filter((line) => /^  \+\d+ -\d+ /.test(line)).length, GIT_CONTEXT_FILE_LIMIT);

  assert.equal(GIT_CONTEXT_MIN_WIDE_WIDTH, 120);
  for (const width of [40, 80, 119]) {
    const layout = gitContextOverlayOptions(width);
    assert.equal(layout.anchor, "center");
    assert.equal(layout.width, width - 4);
  }
  for (const width of [120, 160]) assert.equal(gitContextOverlayOptions(width).anchor, "right-center");
});

test("Git panel renders all named unavailable states and stale prior data without fabrication", () => {
  for (const status of ["non-git", "detached-head", "unborn-head", "missing-ref", "missing-merge-base", "git-error", "timeout", "unavailable"] as const) {
    const lines = formatGitContextLines({ status, stale: false, checkedAt: 1, detail: "detail\nline" });
    assert.equal(lines[0], `State: ${status}`);
    assert.match(lines[1] ?? "", /detail↵line/);
    assert.ok(!lines.some((line) => /^(Active|Reference|Commits|Files|Diff):/.test(line)));
  }
  const ready = uiReadyState();
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const stale: GitContextState = {
    status: "stale",
    stale: true,
    snapshot: ready.snapshot,
    cause: "timeout",
    checkedAt: 2,
  };
  const lines = formatGitContextLines(stale);
  assert.equal(lines[0], "State: stale (timeout)");
  assert.match(lines.join("\n"), /Reference: main/);
});

test("Alt+G and command share one overlay; selector cancel restores focus and selection persists then refreshes", async () => {
  const events = new Map<string, (event: unknown, context: unknown) => unknown>();
  const commands = new Map<string, (args: string, context: unknown) => unknown>();
  const shortcuts = new Map<string, (context: unknown) => unknown>();
  const refreshReasons: string[] = [];
  let schedulerDisposals = 0;
  const scheduler: GitContextRefreshSchedulerLike = {
    firstOpen: (refresh) => { refreshReasons.push("first-open"); void refresh("first-open"); },
    referenceChange: (refresh) => { refreshReasons.push("reference-change"); void refresh("reference-change"); },
    event: (refresh) => { refreshReasons.push("event"); void refresh("event"); },
    dispose: () => { schedulerDisposals++; },
  };
  const collectionInputs: GitContextCollectionInput[] = [];
  const persisted: string[] = [];
  let overlayCount = 0;
  let panel: GitContextPanelComponent | undefined;
  let selector: GitReferenceSelectorComponent | undefined;
  let overlayHidden = false;
  let focusCount = 0;
  let unfocusCount = 0;
  let overlayHides = 0;
  let selectorCompletions = 0;
  const notifications: string[] = [];
  const overlayHandle = {
    setHidden: (hidden: boolean) => { overlayHidden = hidden; },
    isHidden: () => overlayHidden,
    focus: () => { focusCount++; overlayHidden = false; },
    unfocus: () => { unfocusCount++; },
    isFocused: () => !overlayHidden,
    hide: () => { overlayHides++; overlayHidden = true; },
  };
  const tui = { terminal: { columns: 160 }, requestRender() {} };

  registerGitContextUiModuleWithOptions({
    on: ((name: string, handler: (event: unknown, context: unknown) => unknown) => events.set(name, handler)) as never,
    registerCommand: (name, definition) => commands.set(name, definition.handler),
    registerShortcut: (key, definition) => shortcuts.set(key, definition.handler),
  }, {
    schedulerFactory: () => scheduler,
    collect: async (_previous, input) => {
      collectionInputs.push({ ...input });
      return uiReadyState(input.explicitReference ?? "main");
    },
    persist: async (_root, reference, branches) => {
      assert.ok(branches.some((branch) => branch.name === reference));
      persisted.push(reference);
      return true;
    },
    now: () => 1,
  });

  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: (factory: (tuiValue: unknown, theme: unknown, keybindings: unknown, done: (result: string | null) => void) => unknown, customOptions?: {
        overlay?: boolean;
        overlayOptions?: (() => { anchor?: string; width?: number | string });
        onHandle?: (handle: typeof overlayHandle) => void;
      }) => new Promise<string | null>((resolve) => {
        const component = factory(tui, TEST_THEME, {}, (result) => {
          if (!customOptions?.overlay) selectorCompletions++;
          resolve(result);
        });
        if (customOptions?.overlay) {
          overlayCount++;
          panel = component as GitContextPanelComponent;
          assert.deepEqual(customOptions.overlayOptions?.().anchor, "right-center");
          customOptions.onHandle?.(overlayHandle);
        } else {
          selector = component as GitReferenceSelectorComponent;
        }
      }),
    },
  };

  events.get("session_start")?.({}, context);
  commands.get(GIT_CONTEXT_COMMAND)?.("", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overlayCount, 1);
  assert.deepEqual(refreshReasons, ["first-open"]);
  assert.equal(collectionInputs.length, 1);

  panel?.handleInput("r");
  assert.ok(selector);
  selector?.handleInput("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selectorCompletions, 1);
  assert.ok(focusCount >= 2);
  assert.deepEqual(persisted, []);

  selector = undefined;
  panel?.handleInput("r");
  selector?.handleInput("\x1b[B");
  selector?.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persisted, ["origin/develop"]);
  assert.equal(collectionInputs.at(-1)?.explicitReference, "origin/develop");
  assert.ok(refreshReasons.includes("reference-change"));

  shortcuts.get(GIT_CONTEXT_SHORTCUT)?.(context);
  assert.equal(overlayHidden, true);
  assert.equal(unfocusCount, 1);
  commands.get(GIT_CONTEXT_COMMAND)?.("", context);
  assert.equal(overlayCount, 1);
  assert.equal(overlayHidden, false);

  events.get("turn_end")?.({}, context);
  events.get("session_tree")?.({}, context);
  assert.equal(refreshReasons.filter((reason) => reason === "event").length, 2);

  panel?.handleInput("r");
  events.get("session_shutdown")?.({}, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(schedulerDisposals >= 1);
  assert.equal(overlayHides, 1);
  assert.equal(selectorCompletions, 3);
  assert.deepEqual(notifications, []);
});

test("Git context toggles warn safely and create no custom component outside TUI mode", () => {
  let command: ((args: string, context: unknown) => unknown) | undefined;
  let shortcut: ((context: unknown) => unknown) | undefined;
  let customCalls = 0;
  const notifications: string[] = [];
  registerGitContextUiModuleWithOptions({
    registerCommand: (_name, definition) => { command = definition.handler; },
    registerShortcut: (_key, definition) => { shortcut = definition.handler; },
  });
  const ui = {
    notify: (message: string) => notifications.push(message),
    custom: () => { customCalls++; throw new Error("must not open"); },
  };

  command?.("", { mode: "rpc", hasUI: true, cwd: "/repo", ui });
  shortcut?.({ mode: "json", hasUI: false, cwd: "/repo", ui });
  command?.("", { mode: "print", hasUI: false, cwd: "/repo", ui });
  assert.equal(customCalls, 0);
  assert.deepEqual(notifications, ["PA Git context requires TUI mode."]);
});
