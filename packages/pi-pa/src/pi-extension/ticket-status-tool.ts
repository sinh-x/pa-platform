import { Type } from "typebox";
import { TicketStatusError } from "@pa-platform/pa-core";
import { executePiTicketStatus } from "../ticket-status.js";
import type { PiToolDefinition } from "./index.js";
import type { PiWorkflowContext } from "../workflow-native.js";
export function createTicketStatusTool(identity: string): PiToolDefinition {
  return { name: "pa_ticket_status", label: "PA Ticket Status", executionMode: "sequential",
    description: "Administrative ticket status through the common native/CLI owner. One strict pa-ticket-status/v1 JSON request. inspect: schemaVersion,action=inspect,project,ticket; returns complete snapshot version and recognized statuses. set: also requestId,expectedVersion,status. Same-project only. Native caller, lifecycle, competing/uncertain ownership and CAS rechecked under the ticket mutex. Preserve ORIGINAL ID/version/status after response loss; inspect/reconcile original work, never replace uncertain intent. Same-status is a durable no-op. Does not change assignee, publish, queue, approve, accept UAT, launch or grant source/Git rights. CLI equivalent: ppa ticket-status --request '<same JSON>'. Retained pa_ticket/intake schemas are unchanged.",
    parameters: Type.Object({ request: Type.String({ maxLength: 65536 }) }, { additionalProperties: false }),
    execute: async (_id, input, signal, _update, context) => {
      try {
        if (Object.keys(input).length !== 1 || typeof input.request !== "string") throw new TicketStatusError("TICKET_STATUS_INPUT");
        return { content: [{ type: "text", text: JSON.stringify(executePiTicketStatus(input.request, context as PiWorkflowContext, identity, signal)) }], details: {} };
      } catch (error) {
        const failure = error instanceof TicketStatusError ? error : new TicketStatusError("TICKET_STATUS_UNCERTAIN");
        return { content: [{ type: "text", text: failure.message }], details: { code: failure.code, effectState: "not-established" }, isError: true };
      }
    },
  };
}
