/*
 * Adapted from the MIT-licensed Pi 0.80.8 status-line and overlay examples:
 * examples/extensions/status-line.ts and examples/extensions/overlay-qa-tests.ts
 *
 * The PA variant uses additive status (never a custom footer) and an initially
 * hidden, responsive right-side context overlay.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { associateDeploymentTicket, deploymentTaskStatusMarker } from "@pa-platform/pa-core";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import type { PiExtensionModule, PiSessionLifecycle } from "./index.js";
import { readerContextOverlayOptions } from "./context-overlay-layout.js";
import { contextText, CONTEXT_VIEW_LIMIT } from "./context-text.js";
import type { TodoDetails } from "./todo.js";
import { ContextNativeReader, type ContextTicketSummary } from "./context-reader.js";
import { ContextTicketReader, type ContextTicketBinding, type ContextTicketState } from "./context-ticket.js";
import {
  CONTEXT_REFRESH_INTERVAL_MS,
  ContextRefreshLimiter,
  collectContext,
  initialContextSnapshot,
  todoDetailsFromBranch,
  type ContextCollectorDependencies,
  type ContextRefreshInput,
  type PaContextSnapshot,
} from "./context-state.js";

export const CONTEXT_STATUS_ID = "pa-context";

export interface ContextUiModuleOptions {
  collector?: ContextCollectorDependencies;
  limiter?: ContextRefreshLimiter;
  lifecycle?: PiSessionLifecycle;
  associateTicket?: typeof associateDeploymentTicket;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  ticketLookup?: (binding: ContextTicketBinding) => Promise<ContextTicketSummary | undefined>;
}

export function registerContextUiModuleWithOptions(pi: Parameters<PiExtensionModule>[0], options: ContextUiModuleOptions = {}): void {
  let currentContext: ExtensionContext | undefined;
  let refreshInput: ContextRefreshInput = { cwd: process.cwd() };
  let snapshot = initialContextSnapshot(refreshInput, options.collector);
  let sidebar: ContextSidebarComponent | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let overlayHidden = true;
  let overlayDone: (() => void) | undefined;
  let periodicRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const limiter = options.limiter ?? new ContextRefreshLimiter();
  const associateTicket = options.associateTicket ?? associateDeploymentTicket;
  const nativeReader = new ContextNativeReader();
  const detailNativeReader = new ContextNativeReader();
  const collector = { ...options.collector, nativeReader };
  let observationGeneration = 0;
  let refreshFlight: Promise<void> | undefined;
  let refreshPending = false;
  const ticketReader = new ContextTicketReader(options.ticketLookup ?? (binding => detailNativeReader.read<ContextTicketSummary>({ kind: "ticket", ...binding })), () => sidebar?.requestRender());

  const publish = () => {
    if (disposed) return;
    ticketReader.observe(snapshot);
    if (!currentContext?.hasUI) return;
    currentContext.ui.setStatus(CONTEXT_STATUS_ID, formatCompactContext(snapshot));
    sidebar?.requestRender();
  };

  // All observations, including command preflight, share one coalescing lane.
  const refreshNow = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    refreshPending = true;
    if (refreshFlight) return refreshFlight;
    refreshFlight = (async () => {
      while (refreshPending && !disposed) {
        refreshPending = false;
        const generation = observationGeneration;
        const next = await collectContext(snapshot, refreshInput, collector);
        if (!disposed && generation === observationGeneration) {
          snapshot = next;
          publish();
        }
      }
    })().finally(() => { refreshFlight = undefined; });
    return refreshFlight;
  };

  const requestRefresh = (patch: Partial<ContextRefreshInput> = {}) => {
    if (disposed) return;
    refreshInput = {
      ...refreshInput,
      ...patch,
      model: patch.model ?? refreshInput.model,
      todo: patch.todo ?? refreshInput.todo,
    };
    limiter.request(refreshNow);
  };

  const stopPeriodicRefresh = () => {
    if (periodicRefreshTimer === undefined) return;
    (options.clearInterval ?? clearInterval)(periodicRefreshTimer);
    periodicRefreshTimer = undefined;
  };

  const startPeriodicRefresh = () => {
    stopPeriodicRefresh();
    if (disposed || !snapshot.deployment.id) return;
    periodicRefreshTimer = (options.setInterval ?? setInterval)(requestRefresh, CONTEXT_REFRESH_INTERVAL_MS);
    periodicRefreshTimer.unref?.();
  };

  const setOverlayVisible = (visible: boolean) => {
    overlayHidden = !visible;
    overlayHandle?.setHidden(!visible);
    if (visible) overlayHandle?.focus();
    else overlayHandle?.unfocus();
    ticketReader.setOpen(visible && sidebar?.activeTab === "ticket");
    if (!visible) detailNativeReader.abort();
  };

  const ensureOverlay = (context: ExtensionContext) => {
    if (overlayHandle || context.mode !== "tui") return;
    overlayHidden = false;
    const overlayGeneration = observationGeneration;
    void context.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        if (disposed || overlayGeneration !== observationGeneration) {
          done();
          return { render: () => [], invalidate() {} };
        }
        overlayDone = () => done();
        sidebar = new ContextSidebarComponent(tui, theme, () => snapshot, () => setOverlayVisible(false), {
          getTicketState: () => ticketReader.state,
          onTab: tab => {
            ticketReader.setOpen(!overlayHidden && tab === "ticket");
            if (tab !== "ticket") detailNativeReader.abort();
          },
          retry: () => ticketReader.retry(),
          isFocused: () => overlayHandle?.isFocused?.() ?? true,
        });
        return sidebar;
      },
      {
        overlay: true,
        overlayOptions: {
          ...readerContextOverlayOptions(),
          visible: (width, height) => {
            const visible = readerContextOverlayOptions().visible!(width, height);
            ticketReader.setOpen(visible && !overlayHidden && sidebar?.activeTab === "ticket");
            if (!visible) detailNativeReader.abort();
            return visible;
          },
        },
        onHandle: (handle) => {
          if (disposed || overlayGeneration !== observationGeneration) { handle.setHidden(true); return; }
          overlayHandle = handle;
          handle.focus();
        },
      },
    );
  };

  const toggle = (rawContext: unknown) => {
    const context = rawContext as ExtensionContext;
    if (context.mode !== "tui") {
      context.ui.notify("PA context sidebar requires TUI mode.", "warning");
      return;
    }
    currentContext = context;
    if (!overlayHandle) {
      ensureOverlay(context);
      return;
    }
    setOverlayVisible(overlayHidden);
  };

  const associateContextTicket = async (targetTicket: string, context: ExtensionContext): Promise<void> => {
    if (context.mode !== "tui") {
      context.ui.notify("PA ticket interaction is unavailable outside TUI mode.", "warning");
      return;
    }
    currentContext = context;
    refreshInput = {
      ...refreshInput,
      cwd: context.cwd,
      model: context.model ? { provider: context.model.provider, id: context.model.id } : refreshInput.model,
    };
    if (!snapshot.deployment.id) {
      context.ui.notify("PA ticket interaction requires a managed deployment.", "warning");
      return;
    }

    await refreshNow();
    if (disposed) return;
    if (!snapshot.deployment.projectionAvailable) {
      context.ui.notify("PA ticket interaction is unavailable because the registry projection could not be read.", "warning");
      return;
    }
    if (snapshot.deployment.stale) {
      context.ui.notify("PA ticket interaction is unavailable while the registry projection is stale.", "warning");
      return;
    }

    const associationGeneration = observationGeneration;
    const deploymentId = snapshot.deployment.id;
    const currentTicket = snapshot.deployment.ticket;
    const currentLabel = currentTicket ?? "none";
    const reason = await context.ui.input(
      `Associate deployment ticket\nCurrent: ${currentLabel}\nTarget: ${targetTicket}`,
      "Required reason (1-1000 characters)",
    );
    if (reason === undefined) {
      context.ui.notify("PA ticket association cancelled; no changes were written.", "info");
      return;
    }
    if (reason.trim().length === 0) {
      context.ui.notify("PA ticket association requires a non-empty reason; no changes were written.", "warning");
      return;
    }
    if (currentTicket && currentTicket !== targetTicket) {
      const confirmed = await context.ui.confirm(
        "Replace current deployment ticket?",
        `Current: ${currentTicket}\nTarget: ${targetTicket}\nReason: ${reason.trim()}`,
      );
      if (!confirmed) {
        context.ui.notify("PA ticket association cancelled; no changes were written.", "info");
        return;
      }
    }

    if (disposed || associationGeneration !== observationGeneration) return;
    try {
      const operation = () => associateTicket({
        deploymentId: deploymentId!,
        ticketId: targetTicket,
        expectedTicketId: currentTicket ?? null,
        actor: deploymentActor(snapshot),
        reason,
      });
      const result = options.lifecycle
        ? await options.lifecycle.trackRegistryAccess(operation)
        : operation();
      if (disposed || associationGeneration !== observationGeneration) return;
      observationGeneration++;
      snapshot = {
        ...snapshot,
        deployment: {
          ...snapshot.deployment,
          ticket: result.currentTicketId,
          projectionAvailable: true,
          stale: false,
        },
        stale: snapshot.git.stale,
      };
      publish();
      context.ui.notify(
        `PA current ticket: ${result.currentTicketId} (previous: ${result.previousTicketId ?? "none"}; ${result.writeOccurred ? "association written" : "already current"}).`,
        "info",
      );
    } catch (error) {
      context.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.registerCommand?.("pa-context", {
    description: "Toggle PA context or associate a ticket with: /pa-context ticket <ticket-id>",
    handler: async (args, rawContext) => {
      const trimmed = args.trim();
      if (!trimmed) {
        toggle(rawContext);
        return;
      }
      const parts = trimmed.split(/\s+/);
      const context = rawContext as ExtensionContext;
      if (parts.length !== 2 || parts[0] !== "ticket" || !parts[1]) {
        context.ui.notify("Usage: /pa-context ticket <ticket-id>", "warning");
        return;
      }
      await associateContextTicket(parts[1], context);
    },
  });
  pi.registerShortcut?.("alt+i", {
    description: "Toggle the PA context sidebar",
    handler: (context) => toggle(context),
  });

  pi.on?.("session_start", (_event, rawContext) => {
    disposed = false;
    observationGeneration++;
    currentContext = rawContext as ExtensionContext;
    const context = currentContext;
    refreshInput = {
      cwd: context.cwd,
      model: context.model ? { provider: context.model.provider, id: context.model.id } : undefined,
      todo: todoDetailsFromBranch(context.sessionManager.getBranch()) ?? emptyTodoDetails(),
    };
    snapshot = initialContextSnapshot(refreshInput, options.collector);
    publish();
    requestRefresh();
    startPeriodicRefresh();
  });

  pi.on?.("model_select", (rawEvent, rawContext) => {
    currentContext = rawContext as ExtensionContext;
    const event = rawEvent as { model?: { provider?: string; id?: string } };
    requestRefresh({ model: event.model });
  });

  pi.on?.("tool_result", (rawEvent, rawContext) => {
    currentContext = rawContext as ExtensionContext;
    const event = rawEvent as { toolName?: string; details?: unknown };
    if (event.toolName === "todo" && isTodoDetails(event.details)) requestRefresh({ todo: event.details });
  });

  pi.on?.("session_tree", (_event, rawContext) => {
    currentContext = rawContext as ExtensionContext;
    requestRefresh({ todo: todoDetailsFromBranch(currentContext.sessionManager.getBranch()) ?? emptyTodoDetails() });
  });

  pi.on?.("turn_end", (_event, rawContext) => {
    currentContext = rawContext as ExtensionContext;
    requestRefresh();
  });

  const cleanup = async () => {
    if (disposed) return;
    disposed = true;
    observationGeneration++;
    refreshPending = false;
    ticketReader.setOpen(false);
    nativeReader.abort();
    detailNativeReader.abort();
    stopPeriodicRefresh();
    const settlement = limiter.dispose();
    try {
      currentContext?.ui.setStatus(CONTEXT_STATUS_ID, undefined);
      overlayDone?.();
    } finally {
      overlayHandle = undefined;
      overlayDone = undefined;
      sidebar = undefined;
      currentContext = undefined;
      await settlement;
      await refreshFlight;
    }
  };

  if (options.lifecycle) options.lifecycle.addShutdownStep(cleanup);
  else pi.on?.("session_shutdown", cleanup);
}

export const registerContextUiModule: PiExtensionModule = (pi, lifecycle) => registerContextUiModuleWithOptions(pi, { lifecycle });

export function formatCompactContext(snapshot: PaContextSnapshot): string {
  const parts: string[] = [];
  if (snapshot.deployment.available) {
    const identity = [snapshot.deployment.id, snapshot.deployment.team, snapshot.deployment.mode,
      snapshot.deployment.projectionAvailable && !snapshot.deployment.stale ? snapshot.deployment.ticket : undefined]
      .filter(Boolean)
      .join("/");
    parts.push(`PA:${identity || "available"}${!snapshot.deployment.projectionAvailable || snapshot.deployment.stale ? "/ticket:unavailable" : !snapshot.deployment.ticket ? "/ticket:none" : ""}`);
  } else {
    parts.push("PA:unavailable");
  }
  const model = [snapshot.model.provider, snapshot.model.model].filter(Boolean).join("/");
  if (model) parts.push(model);
  if (snapshot.deployment.available) {
    parts.push(`repo:${normalizeCompactRepositoryValue(snapshot.repository.key ?? "unavailable")}`);
    parts.push(`cwd:${normalizeCompactRepositoryValue(snapshot.repository.cwd)}`);
  } else {
    parts.push(snapshot.repository.identity);
  }
  if (snapshot.git.available) parts.push(`git:${snapshot.git.branch ?? "detached"}${snapshot.git.dirty ? "*" : ""}${snapshot.git.stale ? "~" : ""}`);
  else parts.push(`git:unavailable${snapshot.git.stale ? "~" : ""}`);
  const active = snapshot.todo.active ? ` #${snapshot.todo.active.id}:${snapshot.todo.active.text}` : "";
  parts.push(`todo:${snapshot.todo.completed}/${snapshot.todo.total}${active}`);
  return normalizeCompactRepositoryValue(parts.join(" • "));
}

export function formatContextLines(snapshot: PaContextSnapshot): string[] {
  const deployment = snapshot.deployment.available
    ? [
        `Deployment: ${snapshot.deployment.id ?? "unavailable"}${snapshot.deployment.stale ? " (stale)" : ""}`,
        `Team / mode: ${snapshot.deployment.team ?? "unavailable"} / ${snapshot.deployment.mode ?? "unavailable"}`,
        `Current ticket: ${snapshot.deployment.projectionAvailable && !snapshot.deployment.stale ? `${snapshot.deployment.ticket ?? "none"} (registry)` : `unavailable${snapshot.deployment.lastVerifiedTicket ? ` (last verified: ${snapshot.deployment.lastVerifiedTicket}; stale)` : ""}`}`,
        `Launch ticket (environment): ${snapshot.deployment.launchTicket ?? "none"}`,
        `Deployment status: ${snapshot.deployment.status ?? "unavailable"}`,
        `Launch objective: ${contextText(snapshot.deployment.objective ?? "unavailable (not recorded or not yet verified)")}`,
      ]
    : ["Deployment: unavailable"];
  const taskLines = snapshot.todo.tasks.length > 0
    ? [...snapshot.todo.tasks.slice(0, 256).map((task) => `${deploymentTaskStatusMarker(task.status)} #${task.id} ${contextText(task.text)}`),
        ...(snapshot.todo.tasks.length > 256 ? ["[task list truncated after 256 tasks]"] : [])]
    : ["No session tasks"];
  return [
    ...deployment,
    `Provider / model: ${snapshot.model.provider ?? "unavailable"} / ${snapshot.model.model ?? "unavailable"}`,
    `Repository: ${snapshot.repository.root}`,
    `Path: ${snapshot.repository.cwd}`,
    `Git: ${snapshot.git.available ? `${snapshot.git.branch ?? "detached"}${snapshot.git.dirty ? " (dirty)" : " (clean)"}` : "unavailable"}${snapshot.git.stale ? " (stale)" : ""}`,
    `Freshness: ${new Date(snapshot.updatedAt).toISOString()}${snapshot.stale ? " (stale)" : ""}`,
    `Tasks: ${snapshot.todo.completed}/${snapshot.todo.total} completed`,
    ...taskLines,
  ];
}

export interface ContextSidebarOptions {
  getTicketState?: () => ContextTicketState;
  onTab?: (tab: "context" | "ticket") => void;
  retry?: () => void;
  isFocused?: () => boolean;
}

export function formatTicketLines(snapshot: PaContextSnapshot, state: ContextTicketState): string[] {
  const d = snapshot.deployment;
  const identity = d.projectionAvailable && !d.stale ? d.ticket ?? "none" : "unavailable (verification lost)";
  const lines = [`Current ticket: ${identity}`, `Project: ${d.project ?? "unavailable"}`];
  if (!d.available) return [...lines, "Ticket details require a managed deployment."];
  if (!d.projectionAvailable || d.stale || state.status === "withheld") return [...lines, "Details withheld until current-ticket verification returns."];
  if (!d.ticket || state.status === "none") return [...lines, "No associated ticket. No action is required."];
  if (state.status === "loading") return [...lines, "Reading current ticket; you can keep editing after Esc."];
  if (state.status !== "ready" || state.ticket.id !== d.ticket || state.ticket.project !== d.project)
    return [...lines, "Ticket details unavailable. Press r to retry this read; association is unchanged."];
  const t = state.ticket;
  return [...lines, `Read at: ${new Date(state.readAt).toISOString()}`, `Title: ${t.title}`, `Status: ${t.status}`,
    `Priority: ${t.priority}`, `Assignee: ${t.assignee || "unassigned"}`, `Summary:\n${t.summary || "(empty)"}`,
    `Description:\n${t.description || "(empty)"}`];
}

export class ContextSidebarComponent {
  activeTab: "context" | "ticket" = "context";
  private offsets = { context: 0, ticket: 0 };
  private pageSize = 1;
  private rowCount = 0;
  private layoutText?: string;
  private layoutWidth?: number;
  private layoutRows: string[] = [];
  private cachedWidth?: number;
  private cachedHeight?: number;
  private cachedLines?: string[];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly getSnapshot: () => PaContextSnapshot,
    private readonly hide: () => void,
    private readonly options: ContextSidebarOptions = {},
  ) {}

  handleInput(data: string): void {
    if ((this.tui.terminal?.columns ?? 120) < 100 || (this.tui.terminal?.rows ?? 40) < 6 || this.options.isFocused?.() === false) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, "alt+i")) { this.hide(); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
      this.activeTab = this.activeTab === "context" ? "ticket" : "context";
      this.options.onTab?.(this.activeTab);
    } else if (data === "r" && this.activeTab === "ticket") this.options.retry?.();
    else if (matchesKey(data, Key.up)) this.offsets[this.activeTab]--;
    else if (matchesKey(data, Key.down)) this.offsets[this.activeTab]++;
    else if (matchesKey(data, Key.pageUp)) this.offsets[this.activeTab] -= this.pageSize;
    else if (matchesKey(data, Key.pageDown)) this.offsets[this.activeTab] += this.pageSize;
    else if (matchesKey(data, Key.home)) this.offsets[this.activeTab] = 0;
    else if (matchesKey(data, Key.end)) this.offsets[this.activeTab] = this.rowCount;
    else return;
    this.offsets[this.activeTab] = Math.max(0, this.offsets[this.activeTab]);
    this.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(1, Math.floor((this.tui.terminal?.rows ?? 40) * 0.9));
    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height) return this.cachedLines;
    const renderWidth = Math.max(1, width);
    const innerWidth = Math.max(1, renderWidth - 2);
    const border = (text: string) => this.theme.fg("border", text);
    const pad = (text: string) => {
      const truncated = truncateToWidth(text, innerWidth, "…");
      return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
    };
    const snapshot = this.getSnapshot();
    const logical = this.activeTab === "context" ? formatContextLines(snapshot)
      : formatTicketLines(snapshot, this.options.getTicketState?.() ?? { status: "withheld" });
    const text = contextText(logical.join("\n"), CONTEXT_VIEW_LIMIT);
    if (this.layoutText !== text || this.layoutWidth !== innerWidth) {
      this.layoutRows = text.split("\n").flatMap(line => wrapTextWithAnsi(line, Math.max(1, innerWidth - 1)));
      this.layoutText = text;
      this.layoutWidth = innerWidth;
    }
    const rows = this.layoutRows;
    this.rowCount = rows.length;
    this.pageSize = Math.max(1, height - 4);
    this.offsets[this.activeTab] = Math.max(0, Math.min(this.offsets[this.activeTab], Math.max(0, rows.length - this.pageSize)));
    const offset = this.offsets[this.activeTab];
    const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
    const tabTitle = this.activeTab === "context" ? " PA [Context] / Ticket" : ` PA Context / [Ticket] ${snapshot.deployment.ticket ?? "unavailable"}`;
    lines.push(border("│") + pad(this.theme.fg("accent", this.theme.bold(contextText(tabTitle)))) + border("│"));
    for (const row of rows.slice(offset, offset + this.pageSize)) lines.push(border("│") + pad(` ${row}`) + border("│"));
    lines.push(border("│") + pad(this.theme.fg("dim", ` ${offset + 1}-${Math.min(rows.length, offset + this.pageSize)}/${rows.length} Tab view | ↑↓ PgUp/PgDn | r retry | Esc hide`)) + border("│"));
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = lines.map((line) => truncateToWidth(line, renderWidth));
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

function normalizeCompactRepositoryValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, "?");
}

function deploymentActor(snapshot: PaContextSnapshot): string {
  const identity = [snapshot.deployment.team, snapshot.deployment.mode].filter(Boolean).join("/");
  return identity || `pi/${snapshot.deployment.id ?? "session"}`;
}

function isTodoDetails(value: unknown): value is TodoDetails {
  return Boolean(value && typeof value === "object" && "tasks" in value && Array.isArray(value.tasks) && "nextId" in value);
}

function emptyTodoDetails(): TodoDetails {
  return { action: "list", tasks: [], nextId: 1 };
}
