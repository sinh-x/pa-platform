/** Typed append-only refusals. Never include private journal/error text. */
export type TicketCommentCode = "TICKET_COMMENT_PENDING" | "TICKET_COMMENT_UNPROVEN" | "TICKET_COMMENT_UNCERTAIN";
export class TicketCommentError extends Error {
  constructor(readonly code: TicketCommentCode) {
    const uncertain = code === "TICKET_COMMENT_UNCERTAIN";
    const reason = code === "TICKET_COMMENT_PENDING"
      ? "An unfinished ticket write depends on the complete original snapshot. Appending would prevent its exact recovery."
      : code === "TICKET_COMMENT_UNPROVEN"
        ? "Relevant ticket, audit or journal evidence is unreadable, invalid or not known to be compatible with an append."
        : "The comment or its audit could not be verified after persistence started; a partial effect is possible.";
    super(`${uncertain ? "Comment outcome unknown. Do not submit it again yet." : "Comment not added; the append did not start."}\nCondition: ${uncertain ? "Comment persistence is unsettled." : "The comment-only append is blocked before writing."}\nSource: Ticket comment append safety check (${code}).\nReason: ${reason}\nCorrection: Ask the original ticket operation owner to inspect the same ticket, audit and retained intent. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: preserve original request IDs, versions and content; do not delete evidence or transfer custody.\nResume Action: ${uncertain ? "Establish the original comment outcome before any further append; never blindly replay an uncertain write." : "Request the append only after the original owner proves recovery complete or evidence compatible; comment admission will be checked again."} A comment grants no status, workflow or execution authority.`);
  }
}
export const commentFail = (code: TicketCommentCode): never => { throw new TicketCommentError(code); };
