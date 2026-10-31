import type Database from "better-sqlite3";
import { digest, ID, integer, literal, MAX_WORKFLOW_BYTES, MAX_WORKFLOW_RECORD_BYTES, object, reject, SHA256, strictJson, text } from "../workflows/contracts.js";

export interface StoredWorkflowEvent {
  schemaVersion: "pa-workflow-event/v1"; runId: string; eventId: string; expectedRevision: number;
  predecessor: string | null; type: "admitted" | "subject-revised" | "decision" | "revocation" | "intent" | "reconcile" | "result";
  data: Record<string, unknown>;
}
export interface WorkflowJournalEntry { revision: number; sha256: string; event: StoredWorkflowEvent }
/** Extends the existing registry transaction owner, not a file/resource ledger. No JSON import surface. */
export class RegistryWorkflowJournal {
  constructor(private readonly db: Database.Database) {}
  /** Bounded immutable adoption lookup. Presence is sticky even when authority is rejected/revoked. */
  runs(repoKey: string, ticket: string): string[] {
    const rows = this.db.prepare("SELECT run_id FROM workflow_events WHERE revision = 1 AND json_extract(body, '$.data.caller.repoKey') = ? AND json_extract(body, '$.data.caller.ticket') = ? ORDER BY rowid LIMIT 257").all(repoKey, ticket) as { run_id: string }[];
    if (rows.length > 256) reject("WORKFLOW_UNCERTAIN");
    return rows.map(row => text(row.run_id, ID));
  }
  read(runId: string): WorkflowJournalEntry[] {
    text(runId, ID);
    const rows = this.db.prepare("SELECT revision, predecessor, sha256, body FROM workflow_events WHERE run_id = ? ORDER BY revision").all(runId) as { revision: number; predecessor: string | null; sha256: string; body: string }[];
    let predecessor: string | null = null;
    return rows.map((row, index) => {
      const r = object(strictJson(Buffer.from(row.body), MAX_WORKFLOW_RECORD_BYTES), ["schemaVersion", "runId", "eventId", "expectedRevision", "predecessor", "type", "data"]);
      literal(r.schemaVersion, "pa-workflow-event/v1");
      if (r.runId !== runId || row.revision !== index + 1 || r.expectedRevision !== index || r.predecessor !== predecessor || row.predecessor !== predecessor || digest(row.body) !== row.sha256) reject("WORKFLOW_UNCERTAIN");
      text(r.eventId, ID); integer(r.expectedRevision, 0); text(row.sha256, SHA256);
      if (!["admitted", "subject-revised", "decision", "revocation", "intent", "reconcile", "result"].includes(String(r.type)) || !r.data || typeof r.data !== "object" || Array.isArray(r.data)) reject("WORKFLOW_UNCERTAIN");
      predecessor = row.sha256;
      return { revision: row.revision, sha256: row.sha256, event: r as unknown as StoredWorkflowEvent };
    });
  }
  snapshot(sha256: string): Uint8Array {
    text(sha256, SHA256);
    const row = this.db.prepare("SELECT raw FROM workflow_snapshots WHERE sha256 = ?").get(sha256) as { raw: Buffer } | undefined;
    if (!row || row.raw.byteLength > MAX_WORKFLOW_BYTES || digest(row.raw) !== sha256) reject("WORKFLOW_UNCERTAIN");
    return row.raw;
  }
  append(runId: string, expectedRevision: number, make: (entries: WorkflowJournalEntry[]) => Omit<StoredWorkflowEvent, "schemaVersion" | "runId" | "expectedRevision" | "predecessor">, snapshots: readonly Uint8Array[] = []): WorkflowJournalEntry {
    text(runId, ID); integer(expectedRevision, 0);
    return this.db.transaction(() => {
      const entries = this.read(runId); if (entries.length !== expectedRevision) reject("WORKFLOW_CONFLICT");
      const event: StoredWorkflowEvent = { ...make(entries), schemaVersion: "pa-workflow-event/v1", runId, expectedRevision, predecessor: entries.at(-1)?.sha256 ?? null };
      const body = JSON.stringify(event); strictJson(Buffer.from(body), MAX_WORKFLOW_RECORD_BYTES);
      for (const raw of snapshots) {
        if (raw.byteLength > MAX_WORKFLOW_BYTES) reject();
        const sha256 = digest(raw); this.db.prepare("INSERT OR IGNORE INTO workflow_snapshots (sha256, raw) VALUES (?, ?)").run(sha256, raw);
        if (digest(this.snapshot(sha256)) !== sha256) reject("WORKFLOW_UNCERTAIN");
      }
      const sha256 = digest(body); const revision = expectedRevision + 1;
      this.db.prepare("INSERT INTO workflow_events (run_id, revision, predecessor, sha256, body) VALUES (?, ?, ?, ?, ?)").run(runId, revision, event.predecessor, sha256, body);
      return { revision, sha256, event };
    }).immediate();
  }
}
