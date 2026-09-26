/*
 * Adapted from the MIT-licensed Pi 0.80.8 status-line and overlay examples:
 * examples/extensions/status-line.ts and examples/extensions/overlay-qa-tests.ts
 *
 * The PA variant uses additive status (never a custom footer) and an initially
 * hidden, responsive right-side context overlay.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { associateDeploymentTicket, deploymentTaskStatusMarker } from "@pa-platform/pa-core";
import { Key, matchesKey, truncateToWidth, visibleWidth, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import type { PiExtensionModule, PiSessionLifecycle } from "./index.js";
import type { TodoDetails } from "./todo.js";
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
export const CONTEXT_MIN_WIDTH = 120;
export const CONTEXT_WIDTH_PERCENT = 68;

export interface ContextUiModuleOptions {
  collector?: ContextCollectorDependencies;
  limiter?: ContextRefreshLimiter;
  lifecycle?: PiSessionLifecycle;
  associateTicket?: typeof associateDeploymentTicket;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export function registerContextUiModuleWithOptions(pi: Parameters<PiExtensionModule>[0], options: ContextUiModuleOptions = {}): void {
  let currentContext: ExtensionContext | undefined;
  let refreshInput: ContextRefreshInput = { cwd: process.cwd() };
  let snapshot = initialContextSnapshot(refreshInput, options.collector);
  let sidebar: ContextSidebarComponent | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let overlayHidden = true;
  let periodicRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const limiter = options.limiter ?? new ContextRefreshLimiter();
  const associateTicket = options.associateTicket ?? associateDeploymentTicket;

  const publish = () => {
    if (!currentContext?.hasUI) return;
    currentContext.ui.setStatus(CONTEXT_STATUS_ID, formatCompactContext(snapshot));
    sidebar?.requestRender();
  };

  const requestRefresh = (patch: Partial<ContextRefreshInput> = {}) => {
    if (disposed) return;
    refreshInput = {
      ...refreshInput,
      ...patch,
      model: patch.model ?? refreshInput.model,
      todo: patch.todo ?? refreshInput.todo,
    };
    limiter.request(async () => {
      snapshot = await collectContext(snapshot, refreshInput, options.collector);
      publish();
    });
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
    else overlayHandle?.unfocus({ target: null });
  };

  const ensureOverlay = (context: ExtensionContext) => {
    if (overlayHandle || context.mode !== "tui") return;
    overlayHidden = false;
    void context.ui.custom<void>(
      (tui, theme, _keybindings, _done) => {
        sidebar = new ContextSidebarComponent(tui, theme, () => snapshot, () => setOverlayVisible(false));
        return sidebar;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-right",
          width: `${CONTEXT_WIDTH_PERCENT}%`,
          minWidth: 42,
          maxHeight: "90%",
          margin: { right: 1 },
          visible: (terminalWidth) => terminalWidth >= CONTEXT_MIN_WIDTH,
        },
        onHandle: (handle) => {
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

    snapshot = await collectContext(snapshot, refreshInput, options.collector);
    publish();
    if (!snapshot.deployment.projectionAvailable) {
      context.ui.notify("PA ticket interaction is unavailable because the registry projection could not be read.", "warning");
      return;
    }
    if (snapshot.deployment.stale) {
      context.ui.notify("PA ticket interaction is unavailable while the registry projection is stale.", "warning");
      return;
    }

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

    try {
      const operation = () => associateTicket({
        deploymentId: snapshot.deployment.id!,
        ticketId: targetTicket,
        expectedTicketId: currentTicket ?? null,
        actor: deploymentActor(snapshot),
        reason,
      });
      const result = options.lifecycle
        ? await options.lifecycle.trackRegistryAccess(operation)
        : operation();
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
    stopPeriodicRefresh();
    const settlement = limiter.dispose();
    try {
      currentContext?.ui.setStatus(CONTEXT_STATUS_ID, undefined);
      overlayHandle?.hide();
    } finally {
      overlayHandle = undefined;
      sidebar = undefined;
      currentContext = undefined;
      await settlement;
    }
  };

  if (options.lifecycle) options.lifecycle.addShutdownStep(cleanup);
  else pi.on?.("session_shutdown", cleanup);
}

export const registerContextUiModule: PiExtensionModule = (pi, lifecycle) => registerContextUiModuleWithOptions(pi, { lifecycle });

export function formatCompactContext(snapshot: PaContextSnapshot): string {
  const parts: string[] = [];
  if (snapshot.deployment.available) {
    const identity = [snapshot.deployment.id, snapshot.deployment.team, snapshot.deployment.mode, snapshot.deployment.ticket]
      .filter(Boolean)
      .join("/");
    parts.push(`PA:${identity || "available"}${snapshot.deployment.stale ? "~" : ""}`);
  } else {
    parts.push("PA:unavailable");
  }
  const model = [snapshot.model.provider, snapshot.model.model].filter(Boolean).join("/");
  if (model) parts.push(model);
  parts.push(snapshot.repository.identity);
  if (snapshot.git.available) parts.push(`git:${snapshot.git.branch ?? "detached"}${snapshot.git.dirty ? "*" : ""}${snapshot.git.stale ? "~" : ""}`);
  else parts.push(`git:unavailable${snapshot.git.stale ? "~" : ""}`);
  const active = snapshot.todo.active ? ` #${snapshot.todo.active.id}:${snapshot.todo.active.text}` : "";
  parts.push(`todo:${snapshot.todo.completed}/${snapshot.todo.total}${active}`);
  return parts.join(" • ");
}

export function formatContextLines(snapshot: PaContextSnapshot): string[] {
  const deployment = snapshot.deployment.available
    ? [
        `Deployment: ${snapshot.deployment.id ?? "unavailable"}${snapshot.deployment.stale ? " (stale)" : ""}`,
        `Team / mode: ${snapshot.deployment.team ?? "unavailable"} / ${snapshot.deployment.mode ?? "unavailable"}`,
        `Current ticket: ${snapshot.deployment.ticket ?? "none"}${snapshot.deployment.projectionAvailable ? " (registry)" : " (launch fallback)"}`,
        `Launch ticket (environment): ${snapshot.deployment.launchTicket ?? "none"}`,
        `Deployment status: ${snapshot.deployment.status ?? "unavailable"}`,
      ]
    : ["Deployment: unavailable"];
  const taskLines = snapshot.todo.tasks.length > 0
    ? snapshot.todo.tasks.map((task) => `${deploymentTaskStatusMarker(task.status)} #${task.id} ${task.text}`)
    : ["No session tasks"];
  return [
    ...deployment,
    `Provider / model: ${snapshot.model.provider ?? "unavailable"} / ${snapshot.model.model ?? "unavailable"}`,
    `Repository: ${snapshot.repository.identity}`,
    `Path: ${snapshot.repository.cwd}`,
    `Git: ${snapshot.git.available ? `${snapshot.git.branch ?? "detached"}${snapshot.git.dirty ? " (dirty)" : " (clean)"}` : "unavailable"}${snapshot.git.stale ? " (stale)" : ""}`,
    `Freshness: ${new Date(snapshot.updatedAt).toISOString()}${snapshot.stale ? " (stale)" : ""}`,
    `Tasks: ${snapshot.todo.completed}/${snapshot.todo.total} completed`,
    ...taskLines,
  ];
}

export class ContextSidebarComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly getSnapshot: () => PaContextSnapshot,
    private readonly hide: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "alt+i")) this.hide();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const renderWidth = Math.max(1, width);
    const innerWidth = Math.max(1, renderWidth - 2);
    const border = (text: string) => this.theme.fg("border", text);
    const pad = (text: string) => {
      const truncated = truncateToWidth(text, innerWidth, "…");
      return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
    };
    const rows = formatContextLines(this.getSnapshot());
    const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
    lines.push(border("│") + pad(this.theme.fg("accent", this.theme.bold(" PA Context"))) + border("│"));
    lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
    for (const row of rows) lines.push(border("│") + pad(` ${row}`) + border("│"));
    lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
    lines.push(border("│") + pad(this.theme.fg("dim", " Esc or Alt+I to hide")) + border("│"));
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
    this.cachedWidth = width;
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
