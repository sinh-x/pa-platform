import { formatBoundedFiveFieldDiagnostic } from "../repos.js";
import { JsonWorkflowError, type WorkflowErrorCode } from "./contracts.js";

const facts = {
  "record-read": ["ticket record read", "The ticket record could not be read. Marker eligibility is unknown"],
  "registry-read": ["document registry read", "The document registry could not be inspected. Pending document ownership is unknown, not a verified conflict"],
  "document-intent": ["retained document intent", "The registry contains a document intent for this ticket. The marker guard prohibits a second workflow lineage even if that intent failed; this does not prove the operation is currently running"],
  "marker-shape": ["workflow marker list", "The ticket workflow reference list is not an array. Retained lineage cannot be established"],
  "marker-unpaired": ["workflow marker pairing", "A ticket workflow marker exists without a matching adopted run. Marker presence alone cannot establish its owner or release"],
  "marker-conflict": ["workflow marker pairing", "Multiple workflow markers or a marker that differs from the adopted run were found. The guard cannot choose a lineage"],
  "project-mismatch": ["workflow project match", "The ticket record does not match the requested project. Cross-project lineage is not permitted"],
} as const;
export type WorkflowMarkerCause = keyof typeof facts;
/** Internal original-check carrier. Private storage preserves Error's existing
 * enumerable keys; public workflow result fields/schema remain unchanged. */
export class WorkflowMarkerError extends JsonWorkflowError {
  #markerCause: WorkflowMarkerCause;
  get markerCause(): WorkflowMarkerCause { return this.#markerCause; }
  constructor(code: WorkflowErrorCode, cause: WorkflowMarkerCause) {
    super(code);
    this.#markerCause = cause;
    const [source, reason] = facts[cause];
    const headline = "Workflow continuation stopped at the ticket marker check.\n";
    this.message = headline + formatBoundedFiveFieldDiagnostic({
      condition: "The current marker-gated action cannot continue; this check does not establish effects of earlier operations",
      source: `Workflow marker check: ${source} (${code})`, reason,
      correction: "Ask the workflow/document runtime maintainer to inspect the original lineage. Impact: none. Actor: operator. New approval: not required to ask. Prerequisite: preserve records; repair needs separate authority",
      resumeAction: "Continue only when the owning service establishes matching eligible lineage and reconciles original uncertain effects. Admission is checked again; do not replace an intent or delete its evidence",
    }, 2000 - headline.length).replace(/\. (Source|Reason|Correction|Resume Action): /g, "\n$1: ");
  }
}
