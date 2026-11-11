import { Type } from "typebox";
import { realpathSync } from "node:fs";
import {
  patchTicketPlanningInteraction, hasOtherTicketDeploymentAssociation, TicketPlanningIntentError, createTicketInteraction, readTicketInteraction, parseTicketIntakeOperation, ticketIntakeInterface, getAiUsageDir, getTicketsDir, TicketInteractionError, TicketCreateIntentError, TicketStore, ticketInteractionProfileSelected, MAX_INTERACTION_REQUEST_BYTES,
} from "@pa-platform/pa-core";
import { authenticatePiDocumentCaller } from "../document-session.js";
import type { PiWorkflowContext } from "../workflow-native.js";
import type { PiToolDefinition, PiToolResult } from "./index.js";

export function ticketIntakeFailure(error: unknown): PiToolResult {
  const failure = error instanceof TicketInteractionError || error instanceof TicketCreateIntentError || error instanceof TicketPlanningIntentError ? error : new TicketInteractionError("TICKET_INTERACTION_UNCERTAIN");
  return { content: [{ type: "text", text: failure.message }], details: { code: failure.code, effectState: "not-established" }, isError: true };
}
/** Additive finite family port. No caller/approval/root/executor/handler overrides.
 * The native registry/process/session owner is reauthenticated by the service
 * INSIDE TicketStore's mutex, not merely in the tool_call event. */
export function createPaTicketIntakeTool(initialCallerIdentity?: string): PiToolDefinition {
  return {
    name: "pa_ticket_intake", label: "PA Ticket Intake", executionMode: "sequential",
    description: "Describe this interface, inspect/reuse exact existing work, or create a requested idea ticket through the new native requirements interaction profile only. request is one strict raw pa-ticket-intake/v1 JSON object. action=capabilities takes only schemaVersion/action and returns actual supported schemas/defaults/limits without ticket effects or admission/installed claims. For action=create use stable requestId, kind=intake|companion, exact registered project, title; optional summary/description. Ordinary intake requires explicit type/priority/estimate/assignee and stays in this project. Explicit companion requires an existing primary ticket; defaults feature/medium/M/sinh. Search existing work first. action=inspect takes kind/project/ticket and returns bounded metadata plus a caller-bound complete-snapshot version. action=reuse also requires expectedVersion/expectedTitle/expectedType from inspection; it selects only that unchanged ticket, with no mutation, claim or primary reassociation. Retry the ORIGINAL request ID/content after response loss; changed content conflicts. Returns the real ticket ID without changing your primary association. action=patch-planning requires requestId, kind/project/ticket, expectedVersion and expectedSnapshotVersion from inspect (version and snapshotVersion), and a nonempty patch containing only title/summary/description/priority/estimate. Only eligible unclaimed idea/requirement-review without primary/Git evidence and without another current/historical deployment association is admitted. Caller, project and retained-owner observations repeat under the ticket mutex. A retained owner is not released by this port. Replay uses ORIGINAL ID, both versions and exact patch, and preserves later work. No arrays/tags/blockers/lifecycle/primary/Git/resource operations yet. Retained pa_ticket and document intake are unchanged; no shell fallback or supplied actor/approval/root.",
    parameters: Type.Object({ request: Type.String({ maxLength: MAX_INTERACTION_REQUEST_BYTES }) }, { additionalProperties: false }),
    execute: async (_id, input, signal, _update, rawContext) => {
      const authenticate = () => {
        try {
          if (signal?.aborted) throw new Error();
          const caller = authenticatePiDocumentCaller(rawContext as PiWorkflowContext);
          if (!ticketInteractionProfileSelected(caller) || caller.identitySha256 !== initialCallerIdentity) throw new Error();
          if (realpathSync(getAiUsageDir()) !== getAiUsageDir()) throw new Error();
          try { if (realpathSync(getTicketsDir()) !== getTicketsDir()) throw new Error(); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          return { profile: caller.profile!, deploymentId: caller.deploymentId, repoKey: caller.repoKey, ticket: caller.ticket, identitySha256: caller.identitySha256,
            ...(caller.capabilities ? { capabilities: caller.capabilities } : {}) };
        } catch { throw new TicketInteractionError("TICKET_INTERACTION_SESSION"); }
      };
      try {
        const caller = authenticate(); // No TicketStore construction/private-directory effect before native admission.
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new TicketInteractionError("TICKET_INTERACTION_INPUT");
        const fields = Object.getOwnPropertyDescriptors(input);
        if (Object.keys(fields).length !== 1 || !fields.request || !("value" in fields.request) || typeof fields.request.value !== "string") throw new TicketInteractionError("TICKET_INTERACTION_INPUT");
        const operation = parseTicketIntakeOperation(fields.request.value); // Reject raw input before private-directory construction.
        if (operation.action === "capabilities") return { content: [{ type: "text", text: JSON.stringify(ticketIntakeInterface(caller.profile)) }], details: {}, isError: false };
        // Inspection must not create a missing ticket directory. Creation alone
        // retains the existing owner constructor's directory initialization.
        if (operation.action !== "create") {
          try { if (realpathSync(getTicketsDir()) !== getTicketsDir()) throw new Error(); }
          catch { throw new TicketInteractionError("TICKET_INTERACTION_SELECTION"); }
        }
        const owner = { store: new TicketStore(), authenticate,
          assertPlanningOwner: (ticket: string, caller: { deploymentId: string }) => {
            try {
              if (hasOtherTicketDeploymentAssociation(ticket, caller.deploymentId)) throw new Error();
            } catch { throw new TicketInteractionError("TICKET_INTERACTION_OWNER"); }
          },
        };
        const result = operation.action === "create" ? createTicketInteraction(fields.request.value, owner)
          : operation.action === "patch-planning" ? patchTicketPlanningInteraction(fields.request.value, owner)
          : readTicketInteraction(fields.request.value, owner);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {}, isError: false };
      } catch (error) { return ticketIntakeFailure(error); }
    },
  };
}
