import { realpathSync } from "node:fs";
import { TicketStore, TicketStatusError, ticketStatusService, parseTicketStatusRequest, getAiUsageDir, getTicketsDir, resolveTrustedTicketMutationContext } from "@pa-platform/pa-core";
import { authenticatePiDocumentCaller, authenticatePiDocumentCliProcess, type PiDocumentCaller } from "./document-session.js";
import type { PiWorkflowContext } from "./workflow-native.js";

/** Both routes call the same owner with derived identity, never an actor override. */
export function executePiTicketStatus(raw: string, context?: PiWorkflowContext, initialIdentity?: string, signal?: AbortSignal): Record<string, unknown> {
  parseTicketStatusRequest(raw);
  const authenticate = () => {
    let caller: PiDocumentCaller;
    try {
      if (signal?.aborted) throw Error();
      caller = context ? authenticatePiDocumentCaller(context) : authenticatePiDocumentCliProcess();
      if (initialIdentity !== undefined && caller.identitySha256 !== initialIdentity) throw Error();
      if (realpathSync(getAiUsageDir()) !== getAiUsageDir() || realpathSync(getTicketsDir()) !== getTicketsDir()) throw Error();
    } catch { throw new TicketStatusError("TICKET_STATUS_SESSION"); }
    return caller;
  };
  const caller = authenticate();
  const store = new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: caller.deploymentId }, false));
  return ticketStatusService(raw, { store, authenticate });
}
export function runTicketStatusCommand(args: string[], io: { stdout(text: string): void; stderr(text: string): void }): number {
  if (args.length === 1 && args[0] === "--help") {
    io.stdout('Usage: ppa ticket-status --request <JSON>\nSelected fresh Pi requirements/analyze only. pa-ticket-status/v1: inspect(project,ticket), then set(project,ticket,requestId,expectedVersion,status). Administrative status only; no publication, queue, acceptance or launch. Preserve original request coordinates after an uncertain result.'); return 0;
  }
  try {
    if (args.length !== 2 || args[0] !== "--request") throw new TicketStatusError("TICKET_STATUS_INPUT");
    io.stdout(JSON.stringify(executePiTicketStatus(args[1]!))); return 0;
  } catch (error) {
    const failure = error instanceof TicketStatusError ? error : new TicketStatusError("TICKET_STATUS_UNCERTAIN");
    io.stderr(failure.message); return 1;
  }
}
