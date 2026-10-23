import { Type } from "typebox";
import { TicketStore } from "@pa-platform/pa-core";
import type { PiToolDefinition, PiTicketAction } from "./index.js";
import { boundJson } from "./tool-result.js";

/** Shared ticket port without importing the composed extension/editor graph. */
export function createPaTicketTool(): PiToolDefinition {
  return {
    name: "pa_ticket", label: "PA Ticket", description: "Read, show, list, or comment on a PA ticket.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("show"), Type.Literal("list"), Type.Literal("comment")]),
      id: Type.Optional(Type.String()),
      author: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      search: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, input) => ({ content: [{ type: "text", text: boundJson(ticketTool(input)) }], details: {} }),
  };
}

function ticketTool(input: Record<string, unknown>): unknown {
  const store = new TicketStore();
  const action = ticketActionInput(input);
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
