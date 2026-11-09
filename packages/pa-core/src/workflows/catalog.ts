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
export function assertWorkflowMarkerReferences(refs: unknown, runId: string | null): void {
  if (refs !== undefined && !Array.isArray(refs)) reject("WORKFLOW_UNCERTAIN");
  const markers = (Array.isArray(refs) ? refs : []).filter(ref => ref && typeof ref === "object" && ref.type === "workflow");
  if (!runId && markers.length) reject("WORKFLOW_UNCERTAIN");
  if (markers.length > 1 || markers.some(ref => ref.path !== `registry-workflow:${runId}`)) reject("WORKFLOW_CONFLICT");
}
export function assertWorkflowMarkerAvailable(repoKey: string, ticket: string, found: boolean, store = new TicketStore(), runId?: string): void {
  const record = store.get(ticket);
  // Document publication/queue intents are owned by the SAME registry, not a
  // model marker. A second workflow lineage may not bypass even a failed intent.
  // Draft snapshots/decisions alone do not freeze independent graph preparation.
  let registryPresent = false;
  try { lstatSync(getRegistryDbPath()); registryPresent = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject("WORKFLOW_UNCERTAIN"); }
  if (registryPresent) {
    const db = openReadonlyRegistryDatabase(true);
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_events'").get();
      if (table && db.prepare("SELECT 1 FROM document_events WHERE repo_key = ? AND ticket = ? AND json_extract(body, '$.data.kind') = 'intent' LIMIT 1").get(repoKey, ticket)) reject("WORKFLOW_CONFLICT");
    } finally { db.close(); }
  }
  if (!found) {
    if (record?.doc_refs.some(ref => ref.type === "workflow")) reject("WORKFLOW_UNCERTAIN");
    return; // unselected legacy identity remains with its original owner
  }
  if (record?.project !== repoKey) reject("WORKFLOW_AUTHORITY");
  if (runId) assertWorkflowMarkerReferences(record.doc_refs, runId);
}
