import { Type } from "typebox";
import { realpathSync } from "node:fs";
import {
  createTicketInteraction, parseTicketIntakeRequest, getAiUsageDir, getTicketsDir, TicketInteractionError, TicketCreateIntentError, TicketStore, TICKET_INTERACTIONS_PROFILE, MAX_INTERACTION_REQUEST_BYTES,
} from "@pa-platform/pa-core";
import { authenticatePiDocumentCaller } from "../document-session.js";
import type { PiWorkflowContext } from "../workflow-native.js";
import type { PiToolDefinition, PiToolResult } from "./index.js";

export function ticketIntakeFailure(error: unknown): PiToolResult {
  const failure = error instanceof TicketInteractionError || error instanceof TicketCreateIntentError ? error : new TicketInteractionError("TICKET_INTERACTION_UNCERTAIN");
  return { content: [{ type: "text", text: failure.message }], details: { code: failure.code, effectState: "not-established" }, isError: true };
}
/** Additive finite family port. No caller/approval/root/executor/handler overrides.
 * The native registry/process/session owner is reauthenticated by the service
 * INSIDE TicketStore's mutex, not merely in the tool_call event. */
export function createPaTicketIntakeTool(initialCallerIdentity?: string): PiToolDefinition {
  return {
    name: "pa_ticket_intake", label: "PA Ticket Intake", executionMode: "sequential",
    description: "Create a requested idea ticket through the new native requirements interaction profile only. request is one strict raw pa-ticket-intake/v1 JSON object: action=create, stable requestId, kind=intake|companion, exact registered project, title; optional summary/description. Ordinary intake requires explicit type/priority/estimate/assignee and stays in this project. Explicit companion requires an existing primary ticket; defaults feature/medium/M/sinh. Search existing work first. Retry the ORIGINAL request ID/content after response loss; changed content conflicts. Returns the real ticket ID without changing your primary association. No reuse-selection/planning/lifecycle/primary/Git/resource operations yet. Retained pa_ticket and document intake are unchanged; no shell fallback or supplied actor/approval/root.",
    parameters: Type.Object({ request: Type.String({ maxLength: MAX_INTERACTION_REQUEST_BYTES }) }, { additionalProperties: false }),
    execute: async (_id, input, signal, _update, rawContext) => {
      const authenticate = () => {
        try {
          if (signal?.aborted) throw new Error();
          const caller = authenticatePiDocumentCaller(rawContext as PiWorkflowContext);
          if (caller.profile !== TICKET_INTERACTIONS_PROFILE || caller.identitySha256 !== initialCallerIdentity) throw new Error();
          if (realpathSync(getAiUsageDir()) !== getAiUsageDir()) throw new Error();
          try { if (realpathSync(getTicketsDir()) !== getTicketsDir()) throw new Error(); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          return { profile: caller.profile, deploymentId: caller.deploymentId, repoKey: caller.repoKey, ticket: caller.ticket, identitySha256: caller.identitySha256 };
        } catch { throw new TicketInteractionError("TICKET_INTERACTION_SESSION"); }
      };
      try {
        authenticate(); // No TicketStore construction/private-directory effect before native admission.
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new TicketInteractionError("TICKET_INTERACTION_INPUT");
        const fields = Object.getOwnPropertyDescriptors(input);
        if (Object.keys(fields).length !== 1 || !fields.request || !("value" in fields.request) || typeof fields.request.value !== "string") throw new TicketInteractionError("TICKET_INTERACTION_INPUT");
        parseTicketIntakeRequest(fields.request.value); // Reject raw input before private-directory construction.
        const result = createTicketInteraction(fields.request.value, { store: new TicketStore(), authenticate });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {}, isError: false };
      } catch (error) { return ticketIntakeFailure(error); }
    },
  };
}
