import { Type, type TSchema } from "typebox";
import { BulletinStore, closeDb, getDeploymentEvents, queryDeploymentStatus, queryDeploymentStatuses } from "@pa-platform/pa-core";
import { interceptToolCall } from "./safety.js";
export { interceptToolCall } from "./safety.js";
import { auditPiValueFromEnvironment } from "../diagnostics.js";
import { configurePiRegistryBinding } from "../native-host.js";
import { writePiTerminalStatus } from "../terminal-status.js";
import { boundJson } from "./tool-result.js";
import { createPaTicketTool } from "./ticket-tool.js";
import { registerTemplateModule } from "./template-tool.js";
import { registerJsonWorkflowModule } from "./workflow.js";
export { boundJson, MAX_TOOL_BYTES, MAX_TOOL_LINES } from "./tool-result.js";
import { registerQuestionModule } from "./question.js";
import { registerTodoModule } from "./todo.js";
import { registerContextUiModule } from "./context-ui.js";
import { registerGitContextUiModule } from "./git-context-ui.js";
import { registerDirtyBorrowApprovalModule } from "./dirty-borrow-approval.js";
import { registerChildReconciliationModule } from "../child-reconciliation.js";
import { registerExecutionCustodyModule, registerPhaseReportModule, registerPreparedWorkflowModule, registerWorkflowPolicyModule } from "./prepared-workflow.js";
import {
  registerBundledEditorsModule,
  createBundledEditorsModule,
  type BundledEditorFactory,
} from "./bundled-editors.js";

// PAP-145 modules adapt the MIT-licensed Pi 0.80.8 examples at
// examples/extensions/{question,todo,status-line,overlay-qa-tests}.ts.
export const PI_EXAMPLE_VERSION = "0.80.8";
export const PI_EXAMPLE_SOURCES = [
  "examples/extensions/question.ts",
  "examples/extensions/todo.ts",
  "examples/extensions/status-line.ts",
  "examples/extensions/overlay-qa-tests.ts",
] as const;

export interface PiToolCall { name?: string; toolName?: string; input: Record<string, unknown> }
export type PiTicketAction = "read" | "show" | "list" | "comment";
export interface PiTicketToolInput extends Record<string, unknown> {
  action: PiTicketAction;
  id?: string;
  author?: string;
  content?: string;
  search?: string;
}
export interface PiTextContent { type: "text"; text: string }
export interface PiToolResult<TDetails extends Record<string, unknown> = Record<string, unknown>> { content: PiTextContent[]; details: TDetails; isError?: boolean }
export interface PiToolTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}
export interface PiToolComponent { render: (width: number) => string[]; invalidate: () => void }
export interface PiToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>, TDetails extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TSchema;
  executionMode?: "parallel" | "sequential";
  execute: (toolCallId: string, input: TInput, signal: AbortSignal | undefined, onUpdate: ((result: PiToolResult<TDetails>) => void) | undefined, context: unknown) => Promise<PiToolResult<TDetails>>;
  renderCall?: (args: TInput, theme: PiToolTheme, context: unknown) => PiToolComponent;
  renderResult?: (result: PiToolResult<TDetails>, options: { expanded: boolean; isPartial?: boolean }, theme: PiToolTheme, context: unknown) => PiToolComponent;
}
export interface PiSafetyDecision { allowed: boolean; reason?: string }
export interface PiAgentMessage { role?: string; stopReason?: string; errorMessage?: string; content?: unknown }
export interface PiRuntime {
  registerTool?: <TInput extends Record<string, unknown>, TDetails extends Record<string, unknown>>(tool: PiToolDefinition<TInput, TDetails>) => void;
  on?: {
    (event: "tool_call", handler: (call: PiToolCall) => unknown): void;
    (event: "agent_end", handler: (event: { messages: PiAgentMessage[] }) => unknown): void;
    (event: string, handler: (event: unknown, context: unknown) => unknown): void;
  };
  registerCommand?: (name: string, options: { description: string; handler: (args: string, context: unknown) => unknown }) => void;
  registerShortcut?: (shortcut: string, options: { description: string; handler: (context: unknown) => unknown }) => void;
}
export type PiSessionShutdownHandler = (event: unknown, context: unknown) => unknown;
export interface PiSessionLifecycle {
  addShutdownStep(step: PiSessionShutdownHandler): void;
  trackRegistryAccess<T>(access: () => T | Promise<T>): Promise<T>;
  shutdown(event?: unknown, context?: unknown): Promise<void>;
}
export type PiExtensionModule = (pi: PiRuntime, lifecycle?: PiSessionLifecycle) => void;

export function createPiSessionLifecycle(closeRegistry: () => void = closeDb): PiSessionLifecycle {
  const shutdownSteps: PiSessionShutdownHandler[] = [];
  const registryAccess = new Set<Promise<unknown>>();
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;

  return {
    addShutdownStep(step) {
      if (closing) throw new Error("Pi session shutdown has already started.");
      shutdownSteps.push(step);
    },
    trackRegistryAccess<T>(access: () => T | Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new Error("Pi session is shutting down."));
      let tracked: Promise<T>;
      try {
        tracked = Promise.resolve(access());
      } catch (error) {
        tracked = Promise.reject(error);
      }
      registryAccess.add(tracked);
      void tracked.then(
        () => registryAccess.delete(tracked),
        () => registryAccess.delete(tracked),
      );
      return tracked;
    },
    shutdown(event?: unknown, context?: unknown): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      shutdownPromise = (async () => {
        const disposal = shutdownSteps.map((step) => {
          try { return Promise.resolve(step(event, context)); }
          catch (error) { return Promise.reject(error); }
        });
        await Promise.allSettled(disposal);
        await Promise.allSettled([...registryAccess]);
        closeRegistry();
      })();
      return shutdownPromise;
    },
  };
}

export function registerPiSessionModules(
  pi: PiRuntime,
  lifecycle: PiSessionLifecycle,
  modules: readonly PiExtensionModule[] = PI_PA_MODULES,
): void {
  const moduleRuntime = captureModuleShutdownHandlers(pi, lifecycle);
  for (const registerModule of modules) registerModule(moduleRuntime, lifecycle);
  pi.on?.("session_shutdown", (event, context) => lifecycle.shutdown(event, context));
}

function captureModuleShutdownHandlers(pi: PiRuntime, lifecycle: PiSessionLifecycle): PiRuntime {
  if (!pi.on) return pi;
  const forward = pi.on.bind(pi) as (event: string, handler: PiSessionShutdownHandler) => void;
  const on = ((event: string, handler: PiSessionShutdownHandler): void => {
    if (event === "session_shutdown") lifecycle.addShutdownStep(handler);
    else forward(event, handler);
  }) as NonNullable<PiRuntime["on"]>;
  return new Proxy(pi, {
    get(target, property) {
      if (property === "on") return on;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createPaTools(lifecycle?: PiSessionLifecycle): PiToolDefinition[] {
  const ticket = createPaTicketTool();
  return [
    ticket,
    {
      name: "pa_bulletin", label: "PA Bulletin", description: "List active PA bulletins.",
      parameters: Type.Object({ action: Type.String() }),
      execute: async (_toolCallId, input, _signal, _onUpdate, _context) => toolResult(() => { if (input.action !== "list") throw new Error("Only bulletin list is available."); return new BulletinStore().readActive(); })
    },
    {
      name: "pa_registry", label: "PA Registry", description: "Read bounded PA deployment registry data.",
      parameters: Type.Object({ action: Type.String(), id: Type.Optional(Type.String()) }),
      execute: async (_toolCallId, input, _signal, _onUpdate, _context) => trackedRegistryResult(lifecycle, () => registryTool(input))
    },
    {
      name: "pa_status", label: "PA Status", description: "Read the status of one PA deployment.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_toolCallId, input, _signal, _onUpdate, _context) => trackedRegistryResult(lifecycle, () => { const id = stringInput(input, "id"); return queryDeploymentStatus(id) ?? { error: `Deployment not found: ${id}` }; })
    },
  ];
}

export function createPaExtension(): { name: string; tools: PiToolDefinition[]; tool_call: (call: PiToolCall) => PiSafetyDecision } {
  return { name: "pi-pa", tools: createPaTools(), tool_call: interceptToolCall };
}

export const registerPaToolsModule: PiExtensionModule = (pi, lifecycle) => {
  for (const tool of createPaTools(lifecycle)) pi.registerTool?.(tool);
  registerDirtyBorrowApprovalModule(pi, lifecycle);
  registerChildReconciliationModule(pi, lifecycle);
  registerPreparedWorkflowModule(pi, lifecycle);
  registerWorkflowPolicyModule(pi, lifecycle);
  registerPhaseReportModule(pi, lifecycle);
  pi.on?.("tool_call", (call) => {
    const decision = interceptToolCall(call);
    return decision.allowed ? undefined : { block: true, reason: decision.reason };
  });
  registerExecutionCustodyModule(pi, lifecycle);
  pi.on?.("agent_end", (event) => {
    const deployDir = process.env.PA_DEPLOYMENT_DIR;
    if (deployDir) persistTerminalStatus(event.messages, deployDir, process.env);
  });
};

export const PI_PA_NON_EDITOR_MODULES: readonly PiExtensionModule[] = [
  registerPaToolsModule,
  registerTemplateModule,
  registerJsonWorkflowModule,
  registerQuestionModule,
  registerTodoModule,
  registerContextUiModule,
  registerGitContextUiModule,
];

export function createPiPaModules(editorFactories: readonly BundledEditorFactory[]): readonly PiExtensionModule[] {
  return [createBundledEditorsModule(editorFactories), ...PI_PA_NON_EDITOR_MODULES];
}

export const PI_PA_MODULES: readonly PiExtensionModule[] = [
  registerBundledEditorsModule,
  ...PI_PA_NON_EDITOR_MODULES,
];

export default function registerPiPaExtension(pi: PiRuntime): void {
  configurePiRegistryBinding();
  registerPiSessionModules(pi, createPiSessionLifecycle());
}

export function persistTerminalStatus(messages: PiAgentMessage[], deployDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const message = [...messages].reverse().find((candidate) => candidate.role === "assistant" && typeof candidate.stopReason === "string");
  if (!message?.stopReason) return;
  const diagnostic = message.stopReason === "error"
    ? (message.errorMessage || assistantText(message.content) || "Pi agent terminated with an error").slice(-2000)
    : undefined;
  const status = {
    type: "agent_end" as const,
    stopReason: message.stopReason,
    ...(diagnostic ? { error: diagnostic } : {}),
    timestamp: new Date().toISOString(),
  };
  writePiTerminalStatus(deployDir, status);
  auditPiValueFromEnvironment(env, "terminal-status", status);
  if (diagnostic) auditPiValueFromEnvironment(env, "extension-diagnostic", diagnostic);
}

function registryTool(input: Record<string, unknown>): unknown {
  const action = stringInput(input, "action");
  if (action === "show") { const id = stringInput(input, "id"); return { status: queryDeploymentStatus(id), events: getDeploymentEvents(id) }; }
  if (action === "list") return queryDeploymentStatuses();
  throw new Error("Unsupported registry action.");
}

function toolResult(read: () => unknown): PiToolResult {
  return { content: [{ type: "text", text: boundJson(read()) }], details: {} };
}

function trackedRegistryResult(lifecycle: PiSessionLifecycle | undefined, read: () => unknown): Promise<PiToolResult> {
  return lifecycle ? lifecycle.trackRegistryAccess(() => toolResult(read)) : Promise.resolve(toolResult(read));
}

function stringInput(input: Record<string, unknown>, key: string): string { const value = input[key]; if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required.`); return value; }
function assistantText(value: unknown): string { if (typeof value === "string") return value; if (Array.isArray(value)) return value.map((item) => item && typeof item === "object" && "text" in item && typeof item.text === "string" ? item.text : "").filter(Boolean).join(" "); return ""; }
