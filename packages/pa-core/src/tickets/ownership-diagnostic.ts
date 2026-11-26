import { formatBoundedFiveFieldDiagnostic } from "../repos.js";

/** Original check observations, not diagnoses reconstructed from exception prose.
 * No ticket bodies, PIDs, paths, raw errors or caller-selected guidance enter this map. */
const causes = {
  "ticket-read": ["ticket record lookup", "The ticket record could not be read. Matching ticket scope is unknown.", "ticket runtime maintainer"],
  "ticket-scope": ["ticket project match", "The ticket record is missing or belongs to a different project. A matching target is required.", "ticket runtime maintainer"],
  "workflow-read": ["retained workflow lookup", "Retained workflow evidence could not be read or replayed. Ticket availability is unknown; document and competing-deployment checks were not evaluated.", "workflow runtime maintainer"],
  "workflow-retained": ["retained workflow lookup", "A retained workflow was found. This status-only route cannot take over that lineage; marker and competing-deployment checks were not evaluated.", "original workflow owner"],
  "workflow-pending": ["pending workflow operations", "Workflow replay found pending operations. Independent administration cannot cross unsettled workflow effects; document and competing-deployment checks were not evaluated.", "original workflow owner"],
  "marker-document-intent": ["workflow document intent guard", "The registry contains a document intent. This status route cannot create a second workflow lineage even if that intent failed. This does not prove a live deployment; competing-deployment checks were not evaluated.", "original document operation owner"],
  "marker-registry-read": ["workflow document registry guard", "The marker guard could not inspect the document registry. Pending document ownership is unknown; competing-deployment checks were not evaluated.", "document registry maintainer"],
  "marker-shape": ["workflow marker list", "The workflow reference list is not an array. Retained lineage cannot be established; later custody checks were not evaluated.", "workflow runtime maintainer"],
  "marker-unpaired": ["workflow marker pairing", "A workflow marker has no matching adopted run. Marker presence does not establish an owner or release; later custody checks were not evaluated.", "workflow runtime maintainer"],
  "marker-conflict": ["workflow marker pairing", "Multiple workflow markers or a marker differing from the adopted run were found. The guard cannot choose a lineage; later custody checks were not evaluated.", "workflow runtime maintainer"],
  "marker-project": ["workflow project match", "The marker guard found a ticket project mismatch. Matching project scope is required; competing-deployment checks were not evaluated.", "ticket runtime maintainer"],
  "marker-unproven": ["workflow marker eligibility", "The workflow marker guard rejected continuation. Its narrower cause is unavailable here; competing-deployment checks were not evaluated. This does not establish a live owner.", "workflow runtime maintainer"],
  "document-read": ["pending document work", "The document registry could not be inspected or replayed. Ticket availability is unknown, not a verified live owner; competing-deployment checks were not evaluated.", "document registry maintainer"],
  "document-pending": ["pending document work", "Document replay found pending publication or queue effects. Independent administration cannot cross those effects; competing-deployment checks were not evaluated.", "original document operation owner"],
  "deployment-read": ["competing deployment registry lookup", "The deployment registry lookup failed. Competing ownership is unknown; no process-release check was evaluated.", "deployment registry maintainer"],
  "deployment-limit": ["competing deployment count", "The registry returned more than 256 competing records. The bounded ownership check stopped before process-release checks; ticket availability is unproven.", "deployment registry maintainer"],
  "deployment-active": ["competing deployment lifecycle", "Another deployment is registered outside the terminal release states. Concurrent ticket changes could interfere with its work. This is registry state, not verified process identity.", "owning deployment operator"],
  "process-missing": ["terminal deployment process release", "A terminal deployment record has no usable process ID. Its terminal label alone does not prove release; process presence was not evaluated.", "deployment process maintainer"],
  "process-present": ["terminal deployment process release", "The recorded process entry still exists. The process may be the original owner or a reused ID; identity and release are unproven despite the terminal label.", "deployment process maintainer"],
  "process-unreadable": ["terminal deployment process release", "The process-entry lookup failed without proving the entry absent. Process release is unknown, not a verified live owner.", "deployment process maintainer"],
} as const;
export type TicketOwnershipCause = keyof typeof causes;
export const TICKET_OWNERSHIP_CAUSES = Object.freeze(Object.keys(causes) as TicketOwnershipCause[]);

/** Pure presentation over a finite vocabulary. Even malformed runtime arguments
 * cannot become public exception text, identifiers, commands or nested envelopes. */
export function renderTicketOwnershipDiagnostic(cause?: TicketOwnershipCause, deploymentId?: string): string {
  const fact = typeof cause === "string" && Object.hasOwn(causes, cause) ? causes[cause] : undefined;
  const [source, reason, owner] = fact ?? ["ticket custody evidence", "The deciding custody evidence is unavailable. Exact ownership and the narrower cause are unknown.", "ticket runtime maintainer"];
  // Registry deployment IDs are already public in the supported deployment views.
  // Do not accept paths, arbitrary labels or caller-provided owner descriptions.
  const reference = typeof deploymentId === "string" && /^d-[a-f0-9]{6}$/.test(deploymentId)
    && ["deployment-active", "process-missing", "process-present", "process-unreadable"].includes(cause ?? "")
    ? `. Registry deployment: ${deploymentId}` : "";
  const headline = "Ticket change stopped at the custody check; preserve the original request.\n";
  return headline + formatBoundedFiveFieldDiagnostic({
    condition: "The current custody-gated write was prevented. Earlier operation effects, if any, are not established by this check",
    source: `Ticket ownership check: ${source} (TICKET_STATUS_OWNER)`,
    reason: reason.replace(/\.$/, "") + reference,
    correction: cause === "deployment-active"
      ? "Wait for the owning deployment's supported lifecycle. Impact: none. Actor: operator. New approval: not required to wait. Prerequisite: preserve its records; waiting is not release"
      : `Ask the ${owner} to inspect the original evidence. Impact: none. Actor: operator. New approval: not required to ask. Prerequisite: preserve original records; repair needs separate authority`,
    resumeAction: "Retry only after the owning service establishes eligible ticket custody and reconciles any uncertain effects of the original operation. Preserve the same intent; admission is checked again",
  }, 2000 - headline.length).replace(/\. (Source|Reason|Correction|Resume Action): /g, "\n$1: ");
}
