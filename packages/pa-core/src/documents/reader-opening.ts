import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { digest, object, oneOf, parseWorkflowRequest, SHA256, text } from "../workflows/contracts.js";
import { documentGuard, documentReject } from "./package-contract.js";

/** Inactive bound-entry opener core. It accepts ONLY delivery identity. The
 * native embedding must independently derive/verify the local entry and fixed
 * trusted launcher; no caller URL/path/program/argv/environment/callback port. */
export type ReaderOpeningState = "unavailable" | "failed" | "cancelled" | "uncertain" | "open-requested";
export interface ReaderOpeningObservation {
  state: ReaderOpeningState;
  evidenceSha256: string;
  cleanup: "not-needed" | "owned-active" | "settled" | "unknown";
}
export interface ReaderOpeningHost {
  serialize<T>(run: () => T): T;
  authenticate(): { identitySha256: string; selectionSha256: string };
  verifyDelivery(deliverySha256: string): void;
  available(): boolean;
  requestOpen(deliverySha256: string, originalOperationId: string): ReaderOpeningObservation;
  /** Observe/reconcile the SAME original request. May not blindly spawn another
   * browser. Unknown child/cleanup never implies an absent request. */
  reconcile(deliverySha256: string, originalOperationId: string): ReaderOpeningObservation;
}
interface OpenRecord {
  operationId: string; callerSha256: string; selectionSha256: string; deliverySha256: string;
  result: ReaderOpeningObservation;
}
function parseRecord(value: unknown): OpenRecord {
  return documentGuard(() => {
    const row = object(value, ["operationId", "callerSha256", "selectionSha256", "deliverySha256", "result"]);
    const result = object(row.result, ["state", "evidenceSha256", "cleanup"]);
    const record: OpenRecord = { operationId: text(row.operationId, SHA256), callerSha256: text(row.callerSha256, SHA256), selectionSha256: text(row.selectionSha256, SHA256), deliverySha256: text(row.deliverySha256, SHA256),
      result: { state: oneOf(result.state, ["unavailable", "failed", "cancelled", "uncertain", "open-requested"]), evidenceSha256: text(result.evidenceSha256, SHA256), cleanup: oneOf(result.cleanup, ["not-needed", "owned-active", "settled", "unknown"]) } };
    if (record.result.cleanup === "unknown" && record.result.state !== "uncertain") documentReject("DOCUMENT_UNCERTAIN");
    return record;
  });
}
export class RegistryReaderOpeningJournal {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS handoff_reader_opening_events (operation_id TEXT NOT NULL, sequence INTEGER NOT NULL, caller_sha256 TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(operation_id, sequence))");
  }
  records(operationId: string): OpenRecord[] {
    text(operationId, SHA256);
    const rows = this.db.prepare("SELECT sequence, payload FROM handoff_reader_opening_events WHERE operation_id = ? ORDER BY sequence").all(operationId) as { sequence: number; payload: string }[];
    if (rows.length > 32) documentReject("DOCUMENT_UNCERTAIN");
    return rows.map((row, index) => {
      const record = parseRecord(parseWorkflowRequest(row.payload));
      if (row.sequence !== index + 1 || record.operationId !== operationId) documentReject("DOCUMENT_UNCERTAIN");
      return record;
    });
  }
  unsettled(callerSha256: string): string[] {
    text(callerSha256, SHA256);
    const rows = this.db.prepare("SELECT DISTINCT operation_id FROM handoff_reader_opening_events WHERE caller_sha256 = ?").all(callerSha256) as { operation_id: string }[];
    if (rows.length > 128) documentReject("DOCUMENT_UNCERTAIN");
    return rows.filter(row => this.records(row.operation_id).at(-1)!.result.state === "uncertain").map(row => row.operation_id);
  }
  unsettledDelivery(deliverySha256: string): string[] {
    text(deliverySha256, SHA256);
    const rows = this.db.prepare("SELECT DISTINCT operation_id FROM handoff_reader_opening_events WHERE json_extract(payload, '$.deliverySha256') = ?").all(deliverySha256) as { operation_id: string }[];
    if (rows.length > 128) documentReject("DOCUMENT_UNCERTAIN");
    return rows.filter(row => {
      const result = this.records(row.operation_id).at(-1)!.result;
      return result.state === "uncertain" || result.cleanup === "owned-active";
    }).map(row => row.operation_id);
  }
  append(record: OpenRecord, expected: number): void {
    const parsed = parseRecord(record);
    this.db.transaction(() => {
      const previous = this.records(parsed.operationId);
      if (previous.length !== expected) documentReject("DOCUMENT_CONFLICT");
      if ((parsed.result.state === "uncertain" || parsed.result.cleanup === "owned-active")
        && this.unsettledDelivery(parsed.deliverySha256).some(id => id !== parsed.operationId)) documentReject("DOCUMENT_UNCERTAIN");
      if (previous.some(row => row.callerSha256 !== parsed.callerSha256 || row.selectionSha256 !== parsed.selectionSha256 || row.deliverySha256 !== parsed.deliverySha256)) documentReject("DOCUMENT_CONFLICT");
      this.db.prepare("INSERT INTO handoff_reader_opening_events (operation_id, sequence, caller_sha256, payload) VALUES (?, ?, ?, ?)").run(parsed.operationId, expected + 1, parsed.callerSha256, JSON.stringify(parsed));
    }).immediate();
  }
}
/** A successful open request is NOT viewing, confirmation, publication or UAT. */
export function openBoundDocumentReader(journal: RegistryReaderOpeningJournal, host: ReaderOpeningHost, rawDeliverySha256: string): Record<string, unknown> {
  const deliverySha256 = text(rawDeliverySha256, SHA256);
  return host.serialize(() => {
    const caller = host.authenticate(), callerSha256 = text(caller.identitySha256, SHA256), selectionSha256 = text(caller.selectionSha256, SHA256);
    const operationId = digest(JSON.stringify(["pa-document-reader-opening/v1", callerSha256, selectionSha256, deliverySha256]));
    const current = () => {
      const now = host.authenticate();
      if (now.identitySha256 !== callerSha256 || now.selectionSha256 !== selectionSha256) documentReject("DOCUMENT_AUTHORITY");
      host.verifyDelivery(deliverySha256);
    };
    current();
    let records = journal.records(operationId);
    const same = () => { if (records.some(record => record.callerSha256 !== callerSha256 || record.selectionSha256 !== selectionSha256 || record.deliverySha256 !== deliverySha256)) documentReject("DOCUMENT_CONFLICT"); };
    same();
    if (journal.unsettled(callerSha256).some(id => id !== operationId) || journal.unsettledDelivery(deliverySha256).some(id => id !== operationId)) documentReject("DOCUMENT_UNCERTAIN");
    const save = (result: ReaderOpeningObservation) => {
      current(); journal.append({ operationId, callerSha256, selectionSha256, deliverySha256, result }, records.length); records = journal.records(operationId);
    };
    if (records.at(-1)?.result.state === "unavailable" && host.available()) {
      save({ state: "uncertain", cleanup: "unknown", evidenceSha256: digest(JSON.stringify([operationId, "opening-intent"])) });
      save(host.requestOpen(deliverySha256, operationId));
    } else if (!records.length) {
      if (!host.available()) save({ state: "unavailable", cleanup: "not-needed", evidenceSha256: digest("native-local-launcher-unavailable") });
      else {
        // Durable uncertain intent BEFORE any possible launch. A thrown/lost
        // reply leaves this identity pending, never an invitation to relaunch.
        save({ state: "uncertain", cleanup: "unknown", evidenceSha256: digest(JSON.stringify([operationId, "opening-intent"])) });
        const result = host.requestOpen(deliverySha256, operationId); save(result);
      }
    } else if (records.at(-1)!.result.state === "uncertain" || records.at(-1)!.result.state === "open-requested" && records.at(-1)!.result.cleanup === "owned-active") {
      const result = host.reconcile(deliverySha256, operationId);
      // Stable observations do not consume the journal's finite budget. Active
      // child settlement is reobserved through the original operation only.
      if (!isDeepStrictEqual(result, records.at(-1)!.result)) save(result);
    }
    current();
    return { schemaVersion: "pa-document-reader-opening/v1", operationId, deliverySha256, ...records.at(-1)!.result,
      observation: "not-performed", approval: "not-issued", productUat: "not-asserted" };
  });
}
