import { Type } from "typebox";
import { TicketStore, workflowObject, workflowError } from "@pa-platform/pa-core";
import type { PiToolDefinition, PiTicketAction } from "./index.js";
import { boundJson } from "./tool-result.js";
import { projectPlannedActual, type PlannedActualHost } from "@pa-platform/pa-core/tickets/planned-actual";
import { nativePlannedActualHost } from "../phase-report-native.js";

/** Shared ticket port without importing the composed extension/editor graph. */
export function createPaTicketTool(options: { store?: TicketStore; plannedActualHost?: PlannedActualHost } = {}): PiToolDefinition {
  return {
    name: "pa_ticket", label: "PA Ticket", description: "Read, show, list, or comment on a PA ticket. With read/show, plannedActual=true discovers exact accessible comparisons; reference+candidate reads the selected native Planned/Actual binding. No latest selection or acceptance authority is inferred.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("show"), Type.Literal("list"), Type.Literal("comment")]),
      id: Type.Optional(Type.String()),
      author: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      search: Type.Optional(Type.String()),
      plannedActual: Type.Optional(Type.Boolean()),
      reference: Type.Optional(Type.String()),
      candidate: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, input) => ({ content: [{ type: "text", text: boundJson(await ticketTool(input, options)) }], details: {} }),
  };
}

async function ticketTool(input: Record<string, unknown>, options: { store?: TicketStore; plannedActualHost?: PlannedActualHost }): Promise<unknown> {
  const store = options.store ?? new TicketStore();
  const action = ticketActionInput(input);
  if ((action === "read" || action === "show") && (input.plannedActual === true || Object.hasOwn(input, "reference") || Object.hasOwn(input, "candidate"))) {
    workflowObject(input, ["action", "id", ...(Object.hasOwn(input, "plannedActual") ? ["plannedActual"] : []), ...(Object.hasOwn(input, "reference") ? ["reference"] : []), ...(Object.hasOwn(input, "candidate") ? ["candidate"] : [])]);
    if (Object.hasOwn(input, "plannedActual") && typeof input.plannedActual !== "boolean") throw workflowError();
    if (Object.hasOwn(input, "reference") !== Object.hasOwn(input, "candidate")) throw workflowError();
    if (Object.hasOwn(input, "reference") && (typeof input.reference !== "string" || typeof input.candidate !== "string")) throw workflowError();
    const ticket = store.get(stringInput(input, "id"));
    if (!ticket) return { state: "missing", actuals: [], unmatched: [], issues: [] };
    return projectPlannedActual(ticket, typeof input.reference === "string" ? input.reference : undefined, typeof input.candidate === "string" ? input.candidate : undefined, options.plannedActualHost ?? nativePlannedActualHost());
  }
  if (action === "read" || action === "show") return store.get(stringInput(input, "id")) ?? { error: "Ticket not found" };
  if (action === "list") return store.list({ search: typeof input.search === "string" ? input.search : undefined });
  return store.comment(stringInput(input, "id"), stringInput(input, "author"), stringInput(input, "content"));
}

function ticketActionInput(input: Record<string, unknown>): PiTicketAction {
  const action = stringInput(input, "action");
  if (action === "read" || action === "show" || action === "list" || action === "comment") return action;
  throw new Error(`Unsupported ticket action "${action}". Accepted actions: read, show, list, comment.`);
}

function stringInput(input: Record<string, unknown>, key: string): string { const value = input[key]; if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required.`); return value; }
