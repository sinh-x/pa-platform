import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type OverlayHandle,
  type OverlayOptions,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import type { PiExtensionModule } from "./index.js";
import {
  GIT_CONTEXT_COMMIT_LIMIT,
  GIT_CONTEXT_FILE_LIMIT,
  GitContextRefreshScheduler,
  collectGitContext,
  persistGitContextReference,
  type GitBranch,
  type GitContextCollectionInput,
  type GitContextCollectorDependencies,
  type GitContextState,
  type GitRefreshReason,
} from "./git-context-state.js";

export const GIT_CONTEXT_MIN_WIDE_WIDTH = 120;
export const GIT_CONTEXT_COMMAND = "pa-git-context";
export const GIT_CONTEXT_SHORTCUT = "alt+g";

export interface GitContextRefreshSchedulerLike {
  firstOpen(refresh: (reason: GitRefreshReason) => void | Promise<void>): void;
  referenceChange(refresh: (reason: GitRefreshReason) => void | Promise<void>): void;
  event(refresh: (reason: GitRefreshReason) => void | Promise<void>): void;
  dispose(): void;
}

export interface GitContextUiModuleOptions {
  collector?: GitContextCollectorDependencies;
  collect?: typeof collectGitContext;
  persist?: typeof persistGitContextReference;
  schedulerFactory?: () => GitContextRefreshSchedulerLike;
  now?: () => number;
}

export function gitContextOverlayOptions(terminalWidth: number): OverlayOptions {
  const width = Math.max(1, Math.floor(terminalWidth));
  if (width >= GIT_CONTEXT_MIN_WIDE_WIDTH) {
    return {
      anchor: "right-center",
      width: Math.min(64, Math.max(48, Math.floor(width * 0.4))),
      maxHeight: "94%",
      margin: { right: 1 },
    };
  }
  return {
    anchor: "center",
    width: Math.max(1, width - 4),
    maxHeight: "94%",
    margin: 1,
  };
}

export function registerGitContextUiModuleWithOptions(
  pi: Parameters<PiExtensionModule>[0],
  options: GitContextUiModuleOptions = {},
): void {
  const collect = options.collect ?? collectGitContext;
  const persist = options.persist ?? persistGitContextReference;
  const makeScheduler = options.schedulerFactory ?? (() => new GitContextRefreshScheduler());
  const now = options.now ?? Date.now;

  let currentContext: ExtensionContext | undefined;
  let collectionInput: GitContextCollectionInput = { cwd: process.cwd() };
  let state: GitContextState = unavailableState(now());
  let scheduler: GitContextRefreshSchedulerLike | undefined;
  let panel: GitContextPanelComponent | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let overlayHidden = true;
  let overlayCreationPending = false;
  let selectorDone: ((result: string | null) => void) | undefined;
  let selectorRun = 0;
  let disposed = false;
  let sessionGeneration = 0;

  const ensureScheduler = () => {
    scheduler ??= makeScheduler();
    return scheduler;
  };

  const publish = () => {
    if (disposed) return;
    panel?.requestRender();
  };

  const refresh = async (_reason: GitRefreshReason) => {
    const generation = sessionGeneration;
    const next = await collect(state, collectionInput, options.collector);
    if (disposed || generation !== sessionGeneration) return;
    state = next;
    publish();
  };

  const requestRefresh = (reason: GitRefreshReason) => {
    const activeScheduler = ensureScheduler();
    if (reason === "first-open") activeScheduler.firstOpen(refresh);
    else if (reason === "reference-change") activeScheduler.referenceChange(refresh);
    else activeScheduler.event(refresh);
  };

  const cancelSelector = () => {
    selectorRun++;
    const done = selectorDone;
    selectorDone = undefined;
    done?.(null);
  };

  const restorePanelFocus = () => {
    if (!disposed && !overlayHidden) overlayHandle?.focus();
  };

  const selectReference = async () => {
    const context = currentContext;
    const snapshot = snapshotFromState(state);
    if (disposed || !context || context.mode !== "tui") return;
    if (!snapshot || snapshot.branches.length === 0) {
      if (context.hasUI) context.ui.notify("Git reference choices are unavailable until a collection succeeds.", "warning");
      restorePanelFocus();
      return;
    }
    if (selectorDone) return;

    const run = ++selectorRun;
    const selected = await context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      selectorDone = done;
      return new GitReferenceSelectorComponent(tui, theme, snapshot.branches, snapshot.reference.name, done);
    });
    if (run !== selectorRun) return;
    selectorDone = undefined;
    restorePanelFocus();
    if (selected === null || disposed) return;

    const generation = sessionGeneration;
    const saved = await persist(snapshot.repositoryRoot, selected, snapshot.branches);
    if (disposed || generation !== sessionGeneration) return;
    if (!saved) {
      if (context.hasUI) context.ui.notify(`Could not persist Git reference ${selected}.`, "warning");
      return;
    }
    collectionInput = { cwd: collectionInput.cwd, explicitReference: selected };
    requestRefresh("reference-change");
  };

  const setOverlayVisible = (visible: boolean) => {
    overlayHidden = !visible;
    if (!visible) cancelSelector();
    overlayHandle?.setHidden(!visible);
    if (visible) overlayHandle?.focus();
    else overlayHandle?.unfocus({ target: null });
  };

  const ensureOverlay = (context: ExtensionContext) => {
    if (overlayHandle || overlayCreationPending || context.mode !== "tui") return;
    const generation = sessionGeneration;
    overlayCreationPending = true;
    overlayHidden = false;
    let terminalWidth = GIT_CONTEXT_MIN_WIDE_WIDTH;
    void context.ui.custom<void>(
      (tui, theme, _keybindings, _done) => {
        terminalWidth = tui.terminal.columns;
        const createdPanel = new GitContextPanelComponent(tui, theme, () => state, () => setOverlayVisible(false), () => {
          void selectReference();
        });
        if (!disposed && generation === sessionGeneration) panel = createdPanel;
        return createdPanel;
      },
      {
        overlay: true,
        overlayOptions: () => gitContextOverlayOptions(terminalWidth),
        onHandle: (handle) => {
          if (disposed || generation !== sessionGeneration) {
            handle.hide();
            return;
          }
          overlayHandle = handle;
          overlayCreationPending = false;
          if (overlayHidden) handle.setHidden(true);
          else handle.focus();
          requestRefresh("first-open");
        },
      },
    ).catch((error: unknown) => {
      if (generation !== sessionGeneration) return;
      overlayCreationPending = false;
      panel = undefined;
      overlayHandle = undefined;
      if (!disposed && context.hasUI) {
        const detail = error instanceof Error ? error.message : String(error);
        context.ui.notify(`Could not open PA Git context: ${detail}`, "warning");
      }
    });
  };

  const toggle = (rawContext: unknown) => {
    const context = rawContext as ExtensionContext;
    if (context.mode !== "tui") {
      if (context.hasUI) context.ui.notify("PA Git context requires TUI mode.", "warning");
      return;
    }
    disposed = false;
    currentContext = context;
    collectionInput = { ...collectionInput, cwd: context.cwd };
    if (!overlayHandle) {
      ensureOverlay(context);
      return;
    }
    setOverlayVisible(overlayHidden);
  };

  const teardown = () => {
    disposed = true;
    sessionGeneration++;
    cancelSelector();
    scheduler?.dispose();
    scheduler = undefined;
    overlayHandle?.hide();
    overlayHandle = undefined;
    panel = undefined;
    overlayCreationPending = false;
    overlayHidden = true;
    currentContext = undefined;
  };

  pi.registerCommand?.(GIT_CONTEXT_COMMAND, {
    description: "Toggle the PA Git context panel",
    handler: (_args, context) => toggle(context),
  });
  pi.registerShortcut?.(GIT_CONTEXT_SHORTCUT, {
    description: "Toggle the PA Git context panel",
    handler: (context) => toggle(context),
  });

  pi.on?.("session_start", (_event, rawContext) => {
    teardown();
    disposed = false;
    currentContext = rawContext as ExtensionContext;
    collectionInput = { cwd: currentContext.cwd };
    state = unavailableState(now());
    scheduler = makeScheduler();
  });

  for (const eventName of ["session_tree", "turn_end"] as const) {
    pi.on?.(eventName, (_event, rawContext) => {
      currentContext = rawContext as ExtensionContext;
      collectionInput = { ...collectionInput, cwd: currentContext.cwd };
      if (overlayHandle && !disposed) requestRefresh("event");
    });
  }

  pi.on?.("session_shutdown", () => teardown());
}

export const registerGitContextUiModule: PiExtensionModule = (pi) => registerGitContextUiModuleWithOptions(pi);

export function formatGitContextLines(state: GitContextState): string[] {
  if (state.status !== "ready" && state.status !== "stale") {
    const lines = [`State: ${state.status}`];
    if (state.detail) lines.push(`Detail: ${singleLine(state.detail)}`);
    return lines;
  }

  const snapshot = state.snapshot;
  const commits = snapshot.commits.slice(0, GIT_CONTEXT_COMMIT_LIMIT);
  const files = snapshot.files.slice(0, GIT_CONTEXT_FILE_LIMIT);
  const commitTruncated = Math.max(snapshot.commitTruncated, snapshot.commitTotal - commits.length);
  const fileTruncated = Math.max(snapshot.fileTruncated, snapshot.fileTotal - files.length);
  const lines = [
    state.status === "stale" ? `State: stale (${state.cause})` : "State: ready",
    `Active: ${singleLine(snapshot.activeBranch)}`,
    `Reference: ${singleLine(snapshot.reference.name)} (${snapshot.referenceSource})`,
    `Commits: ${commits.length}/${snapshot.commitTotal} shown${commitTruncated > 0 ? ` • ${commitTruncated} truncated` : ""}`,
  ];
  for (const commit of commits) {
    lines.push(`  ${singleLine(commit.hash)} ${singleLine(commit.message)} — ${singleLine(commit.author)} · ${singleLine(commit.date)}`);
  }
  lines.push(`Diff: +${snapshot.additions} -${snapshot.deletions}`);
  lines.push(`Files: ${files.length}/${snapshot.fileTotal} shown${fileTruncated > 0 ? ` • ${fileTruncated} truncated` : ""}`);
  for (const file of files) {
    const counts = file.binary ? "binary" : `+${file.additions ?? 0} -${file.deletions ?? 0}`;
    lines.push(`  ${counts} ${singleLine(file.displayPath)}`);
  }
  return lines;
}

export class GitContextPanelComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly getState: () => GitContextState,
    private readonly hide: () => void,
    private readonly selectReference: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, GIT_CONTEXT_SHORTCUT)) this.hide();
    else if (matchesKey(data, "r")) this.selectReference();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const rows = formatGitContextLines(this.getState());
    this.cachedLines = frameLines(this.theme, "PA Git Context", [
      ...rows,
      "",
      "r reference • Esc or Alt+G hide",
    ], width);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}

export class GitReferenceSelectorComponent {
  private readonly selectList: SelectList;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    branches: readonly GitBranch[],
    currentReference: string,
    done: (result: string | null) => void,
  ) {
    const items: SelectItem[] = branches.map((branch) => ({
      value: branch.name,
      label: branch.name,
      description: branch.kind === "local" ? "local branch" : "local remote-tracking branch",
    }));
    this.selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    const selectedIndex = items.findIndex((item) => item.value === currentReference);
    if (selectedIndex >= 0) this.selectList.setSelectedIndex(selectedIndex);
    this.selectList.onSelect = (item) => done(item.value);
    this.selectList.onCancel = () => done(null);
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const renderWidth = Math.max(0, Math.floor(width));
    if (renderWidth === 0) return [];
    if (renderWidth < 3) return [truncateToWidth("Git refs", renderWidth, "")];
    const innerWidth = renderWidth - 2;
    return frameLines(this.theme, "Select Git Reference", [
      ...this.selectList.render(innerWidth),
      "",
      "↑↓ navigate • Enter select • Esc cancel",
    ], renderWidth);
  }

  invalidate(): void {
    this.selectList.invalidate();
  }
}

function frameLines(theme: Theme, title: string, rows: readonly string[], width: number): string[] {
  const renderWidth = Math.max(0, Math.floor(width));
  if (renderWidth === 0) return [];
  if (renderWidth === 1) return rows.length === 0 ? [" "] : rows.map((row) => truncateToWidth(row, 1, ""));
  const innerWidth = renderWidth - 2;
  const border = (text: string) => theme.fg("border", text);
  const fit = (text: string) => {
    const truncated = truncateToWidth(text, innerWidth, "…");
    return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
  };
  const titleText = truncateToWidth(` ${title} `, innerWidth, "");
  const titleWidth = visibleWidth(titleText);
  const left = Math.max(0, Math.floor((innerWidth - titleWidth) / 2));
  const right = Math.max(0, innerWidth - titleWidth - left);
  const lines = [border(`╭${"─".repeat(left)}`) + theme.fg("accent", theme.bold(titleText)) + border(`${"─".repeat(right)}╮`)];
  for (const row of rows) lines.push(border("│") + fit(` ${row}`) + border("│"));
  lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
  return lines.map((line) => truncateToWidth(line, renderWidth, ""));
}

function unavailableState(checkedAt: number): GitContextState {
  return { status: "unavailable", stale: false, checkedAt };
}

function snapshotFromState(state: GitContextState) {
  return state.status === "ready" || state.status === "stale" ? state.snapshot : undefined;
}

function singleLine(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, "↵")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}
