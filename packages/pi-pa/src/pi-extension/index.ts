import { BulletinStore, TicketStore, getDeploymentEvents, queryDeploymentStatus, queryDeploymentStatuses } from "@pa-platform/pa-core";
import { isBlockedFilePath, isDestructiveCommand } from "@pa-platform/pa-core";

export const MAX_TOOL_BYTES = 50 * 1024;
export const MAX_TOOL_LINES = 2000;

export interface PiToolCall { name: string; input: Record<string, unknown> }
export interface PiToolResult { content: string; isError?: boolean }
export interface PiToolDefinition {
  name: "pa_ticket" | "pa_bulletin" | "pa_registry" | "pa_status";
  description: string;
  parameters: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => PiToolResult;
}
export interface PiSafetyDecision { allowed: boolean; reason?: string }
export interface PiRuntime { registerTool?: (tool: PiToolDefinition) => void; on?: (event: "tool_call", handler: (call: PiToolCall) => unknown) => void }

export function interceptToolCall(call: PiToolCall): PiSafetyDecision {
  const values = flattenStrings(call.input);
  if ((call.name === "bash" || call.name === "shell" || call.name === "execute") && values.some(isDestructiveCommand)) {
    return { allowed: false, reason: "BLOCKED: destructive command detected by PA safety policy." };
  }
  if (values.some(isBlockedFilePath)) return { allowed: false, reason: "BLOCKED: sensitive file access is not allowed by PA safety policy." };
  return { allowed: true };
}

export function createPaTools(): PiToolDefinition[] {
  return [
    {
      name: "pa_ticket", description: "Read or comment on a PA ticket.",
      parameters: { type: "object", properties: { action: { enum: ["show", "list", "comment"] }, id: { type: "string" }, author: { type: "string" }, content: { type: "string" } }, required: ["action"] },
      execute: (input) => toolResult(() => ticketTool(input)),
    },
    {
      name: "pa_bulletin", description: "List active PA bulletins.",
      parameters: { type: "object", properties: { action: { const: "list" } }, required: ["action"] },
      execute: (input) => toolResult(() => { if (input.action !== "list") throw new Error("Only bulletin list is available."); return new BulletinStore().readActive(); }),
    },
    {
      name: "pa_registry", description: "Read bounded PA deployment registry data.",
      parameters: { type: "object", properties: { action: { enum: ["list", "show"] }, id: { type: "string" } }, required: ["action"] },
      execute: (input) => toolResult(() => registryTool(input)),
    },
    {
      name: "pa_status", description: "Read the status of one PA deployment.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: (input) => toolResult(() => { const id = stringInput(input, "id"); return queryDeploymentStatus(id) ?? { error: `Deployment not found: ${id}` }; }),
    },
  ];
}

export function createPaExtension(): { name: string; tools: PiToolDefinition[]; tool_call: (call: PiToolCall) => PiSafetyDecision } {
  return { name: "pi-pa", tools: createPaTools(), tool_call: interceptToolCall };
}

export default function registerPiPaExtension(pi: PiRuntime): void {
  for (const tool of createPaTools()) pi.registerTool?.(tool);
  pi.on?.("tool_call", (call) => {
    const decision = interceptToolCall(call);
    return decision.allowed ? undefined : { block: true, reason: decision.reason };
  });
}

function ticketTool(input: Record<string, unknown>): unknown {
  const store = new TicketStore();
  const action = stringInput(input, "action");
  if (action === "show") return store.get(stringInput(input, "id")) ?? { error: "Ticket not found" };
  if (action === "list") return store.list({ search: typeof input.search === "string" ? input.search : undefined });
  if (action === "comment") return store.comment(stringInput(input, "id"), stringInput(input, "author"), stringInput(input, "content"));
  throw new Error("Unsupported ticket action.");
}

function registryTool(input: Record<string, unknown>): unknown {
  const action = stringInput(input, "action");
  if (action === "show") { const id = stringInput(input, "id"); return { status: queryDeploymentStatus(id), events: getDeploymentEvents(id) }; }
  if (action === "list") return queryDeploymentStatuses();
  throw new Error("Unsupported registry action.");
}

function toolResult(read: () => unknown): PiToolResult {
  try { return { content: boundJson(read()) }; } catch (error) { return { isError: true, content: boundJson({ error: error instanceof Error ? error.message : String(error) }) }; }
}

export function boundJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const lines = json.split("\n");
  if (json.length <= MAX_TOOL_BYTES && lines.length <= MAX_TOOL_LINES) return json;
  const available = Math.min(MAX_TOOL_BYTES, lines.slice(0, MAX_TOOL_LINES).join("\n").length);
  return `${json.slice(0, Math.max(0, available - 180))}\n...[truncated; inspect the PA registry, ticket, or deployment artifact for the complete result]`;
}

function stringInput(input: Record<string, unknown>, key: string): string { const value = input[key]; if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required.`); return value; }
function flattenStrings(value: unknown): string[] { if (typeof value === "string") return [value]; if (Array.isArray(value)) return value.flatMap(flattenStrings); if (value && typeof value === "object") return Object.values(value).flatMap(flattenStrings); return []; }
