import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPiVimMode from "#pi-pa-vimmode";
import registerProperBase from "#pi-pa-proper-base";
import type { PiExtensionModule, PiRuntime, PiSessionShutdownHandler } from "./index.js";

export const BUNDLED_EDITOR_FACTORIES = ["pi-vimmode@0.9.0", "proper-base@0.5.0"] as const;

const PROPER_WRAPPED = Symbol.for("pi-proper-history.wrapped");
const VIM_TUI_EVENTS = new Set(["session_start", "resources_discover", "agent_end"]);
const PROPER_TUI_EVENTS = new Set(["session_start"]);

type PiEventHandler = PiSessionShutdownHandler;
type PiCommandOptions = {
  description: string;
  handler: (args: string, context: unknown) => unknown;
};
type HandlerObserver = (event: string, handler: PiEventHandler) => void;
type CommandAdapter = (name: string, options: PiCommandOptions) => PiCommandOptions;

interface BundledApiOptions {
  tuiEvents: ReadonlySet<string>;
  observeHandler?: HandlerObserver;
  adaptCommand?: CommandAdapter;
  adaptContext?: (context: unknown) => unknown;
}

/**
 * Register both reviewed upstream factories through the one pi-pa runtime.
 * Vim installs first; proper-base then resolves that factory as its base and
 * remains the outer editor wrapper.
 */
export const registerBundledEditorsModule: PiExtensionModule = (pi) => {
  let properSessionStart: PiEventHandler | undefined;

  registerPiVimMode(createBundledApi(pi, {
    tuiEvents: VIM_TUI_EVENTS,
    adaptContext: (context) => wrapVimLifecycleContext(context, () => properSessionStart),
    adaptCommand: (name, options) => name === "vimmode"
      ? wrapVimModeCommand(options, () => properSessionStart)
      : options,
  }));

  registerProperBase(createBundledApi(pi, {
    tuiEvents: PROPER_TUI_EVENTS,
    observeHandler: (event, handler) => {
      if (event === "session_start") properSessionStart = handler;
    },
  }));
};

function createBundledApi(pi: PiRuntime, options: BundledApiOptions): ExtensionAPI {
  const on = (event: string, handler: PiEventHandler): void => {
    const adapted: PiEventHandler = options.adaptContext
      ? (value, context) => handler(value, options.adaptContext?.(context))
      : handler;
    const guarded = options.tuiEvents.has(event) ? tuiOnly(adapted) : adapted;
    options.observeHandler?.(event, guarded);
    pi.on?.(event, guarded);
  };
  const registerCommand = (name: string, command: PiCommandOptions): void => {
    pi.registerCommand?.(name, options.adaptCommand?.(name, command) ?? command);
  };

  return new Proxy(pi as object, {
    get(target, property) {
      if (property === "on") return on;
      if (property === "registerCommand") return registerCommand;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;
}

function tuiOnly(handler: PiEventHandler): PiEventHandler {
  return (event, context) => isTuiContext(context) ? handler(event, context) : undefined;
}

function isTuiContext(context: unknown): boolean {
  return Boolean(context && typeof context === "object" && "mode" in context && context.mode === "tui");
}

function wrapVimLifecycleContext(
  context: unknown,
  properSessionStart: () => PiEventHandler | undefined,
): unknown {
  if (!isTuiContext(context) || !context || typeof context !== "object" || !("ui" in context)) return context;
  const ui = context.ui;
  if (!ui || typeof ui !== "object" || !("setEditorComponent" in ui) || typeof ui.setEditorComponent !== "function") return context;
  const setEditorComponent = ui.setEditorComponent.bind(ui) as (factory: unknown) => void;
  const wrappedUi = new Proxy(ui, {
    get(target, property) {
      if (property === "setEditorComponent") {
        return (factory: unknown): void => {
          setEditorComponent(factory);
          const rewrap = properSessionStart();
          if (rewrap) void Promise.resolve(rewrap({ type: "session_start", reason: "reload" }, context)).catch(() => undefined);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(context, {
    get(target, property) {
      if (property === "ui") return wrappedUi;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function wrapVimModeCommand(
  command: PiCommandOptions,
  properSessionStart: () => PiEventHandler | undefined,
): PiCommandOptions {
  return {
    ...command,
    handler: async (args, context) => {
      const action = args.trim().toLowerCase() || "toggle";
      const changesEditor = action === "toggle" || action === "on" || action === "off";
      if (changesEditor && isTuiContext(context)) unwrapProperEditor(context);
      const result = await command.handler(args, context);
      if (changesEditor && isTuiContext(context)) {
        await properSessionStart()?.({ type: "session_start", reason: "reload" }, context);
      }
      return result;
    },
  };
}

function unwrapProperEditor(context: unknown): void {
  if (!context || typeof context !== "object" || !("ui" in context)) return;
  const ui = context.ui;
  if (!ui || typeof ui !== "object" || !("getEditorComponent" in ui) || !("setEditorComponent" in ui)) return;
  if (typeof ui.getEditorComponent !== "function" || typeof ui.setEditorComponent !== "function") return;
  const current: unknown = ui.getEditorComponent();
  if (typeof current !== "function" || !(PROPER_WRAPPED in current)) return;
  const base = (current as Record<symbol, unknown>)[PROPER_WRAPPED];
  ui.setEditorComponent(typeof base === "function" ? base : undefined);
}
