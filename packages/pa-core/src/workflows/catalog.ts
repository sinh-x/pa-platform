import { lstatSync } from "node:fs";
import { getRegistryDbPath } from "../paths.js";
import { openReadonlyRegistryDatabase } from "../registry/db.js";
import { RegistryWorkflowJournal } from "../registry/workflows.js";
import { TicketStore } from "../tickets/store.js";
import { reject } from "./contracts.js";
import { replayWorkflow, requireDecision, type WorkflowState } from "./service.js";

/** Read-only adoption lookup, never a newest-JSON/legacy-prose authority import.
 * Multiple runs require an explicit linked revision implementation, not a guessed latest winner. */
export function adoptedWorkflow(journal: RegistryWorkflowJournal, repoKey: string, ticket: string): WorkflowState | null {
  const ids = journal.runs(repoKey, ticket);
  if (ids.length > 1) reject("WORKFLOW_CONFLICT");
  return ids.length ? replayWorkflow(journal, ids[0]!) : null;
}
export function packageDecision(state: WorkflowState): string {
  const decisions = state.decisions.filter(d => d.subjectSha256 === state.subjectSha256 && d.outcome === "approved" && !state.revoked.includes(d.decisionId));
  if (decisions.length !== 1) reject("WORKFLOW_AUTHORITY");
  requireDecision(state, decisions[0]!.decisionId, []); return decisions[0]!.decisionId;
}
/** Missing/unreadable adopted state cannot be replaced with legacy parsing. */
export function withExistingWorkflowJournal<T>(read: (journal: RegistryWorkflowJournal | null) => T): T {
  try { lstatSync(getRegistryDbPath()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return read(null); return reject("WORKFLOW_SOURCE"); }
  const db = openReadonlyRegistryDatabase(true);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_events'").get();
    return read(table ? new RegistryWorkflowJournal(db) : null);
  } finally { db.close(); }
}
export function assertWorkflowMarkerAvailable(repoKey: string, ticket: string, found: boolean, store = new TicketStore()): void {
  const record = store.get(ticket);
  if (!found) {
    if (record?.doc_refs.some(ref => ref.type === "workflow")) reject("WORKFLOW_UNCERTAIN");
    return; // unselected legacy identity remains with its original owner
  }
  if (record?.project !== repoKey) reject("WORKFLOW_AUTHORITY");
}
