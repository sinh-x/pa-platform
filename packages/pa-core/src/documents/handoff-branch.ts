import type Database from "better-sqlite3";
import { digest, GIT_SHA, ID, integer, object, oneOf, parseWorkflowRequest, SHA256, text } from "../workflows/contracts.js";
import { documentGuard, documentPackageSha, documentReject, type DocumentPackage } from "./package-contract.js";
import { handoffBranchIntentSha, handoffReviewSubjectSha, parseHandoffBranchIntent, parseHandoffReviewSubject, type HandoffBranchIntent, type HandoffReviewSubject } from "./handoff-contract.js";

/** Inactive finite transaction core. No tool/CLI/native selection imports this
 * module. Trusted embedding ports are NOT public approval or caller overrides. */
export interface HandoffMaterializedLink { repo: string; branch: string; state: "materialized"; baseSha: string; headSha: string; sha: string }
export type HandoffRefObservation =
  | { state: "absent"; history: "never-created" | "uncertain" }
  | { state: "unknown" }
  | { state: "present"; headSha: string; evidenceSha256: string; owner: { kind: "operation"; id: string } | { kind: "lineage"; sha256: string } | { kind: "unproven" } };
export interface HandoffBranchHost {
  /** Must compose existing repository -> worktree -> ticket mutexes. Synchronous;
   * exclusion only, never reserve/acquire a resource. No human dialog here. */
  serialize<T>(run: () => T): T;
  authenticate(): { identitySha256: string; selectionSha256: string };
  assertAvailable(intent: HandoffBranchIntent): void;
  assertDecision(subjectSha256: string, decisionId: string): void;
  assertPublished(documentSubjectSha256: string): void;
  observeRef(intent: HandoffBranchIntent, operationId: string): HandoffRefObservation;
  isAncestor(baseSha: string, headSha: string): boolean;
  /** Native fixed-argv compare-and-create ONLY. Must durably correlate its Git
   * transaction with operationId. Never use a branch name as ownership proof. */
  createRef(intent: HandoffBranchIntent, operationId: string): void;
  inspectLink(intent: HandoffBranchIntent): { version: string; link: HandoffMaterializedLink | null };
  /** Same TicketStore mutex/audit and complete-ticket CAS. Must preserve existing
   * linkedAt/history, reject foreign/multiple links, and not infer original base. */
  materializeLink(intent: HandoffBranchIntent, expectedVersion: string, link: HandoffMaterializedLink): void;
}
interface BranchEvent {
  sequence: number; operationId: string; bindingSha256: string;
  kind: "intent" | "ref-intent" | "physical" | "linked" | "complete";
  ticketVersion: string; headSha: string | null; evidenceSha256: string | null;
}
function parseEvent(input: unknown): BranchEvent {
  return documentGuard(() => {
    const e = object(input, ["sequence", "operationId", "bindingSha256", "kind", "ticketVersion", "headSha", "evidenceSha256"]);
    return { sequence: integer(e.sequence, 1, 32), operationId: text(e.operationId, SHA256), bindingSha256: text(e.bindingSha256, SHA256),
      kind: oneOf(e.kind, ["intent", "ref-intent", "physical", "linked", "complete"]),
      ticketVersion: text(e.ticketVersion, SHA256), headSha: e.headSha === null ? null : text(e.headSha, GIT_SHA), evidenceSha256: e.evidenceSha256 === null ? null : text(e.evidenceSha256, SHA256) };
  });
}
/** Actual durable SQLite owner for the inactive core, separate from old document
 * events. Call only while the embedding owner holds all required mutexes. */
export class RegistryHandoffBranchJournal {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS handoff_branch_events (operation_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(operation_id, sequence))");
  }
  events(operationId: string): BranchEvent[] {
    text(operationId, SHA256);
    const rows = this.db.prepare("SELECT payload FROM handoff_branch_events WHERE operation_id = ? ORDER BY sequence").all(operationId) as { payload: string }[];
    if (rows.length > 5) documentReject("DOCUMENT_UNCERTAIN");
    const kinds = ["intent", "ref-intent", "physical", "linked", "complete"];
    const events = rows.map(row => parseEvent(parseWorkflowRequest(row.payload)));
    for (const [index, event] of events.entries()) {
      if (event.sequence !== index + 1 || event.operationId !== operationId || event.kind !== kinds[index]
        || event.bindingSha256 !== events[0]!.bindingSha256 || event.ticketVersion !== events[0]!.ticketVersion
        || (index < 2 ? event.headSha !== null || event.evidenceSha256 !== null : event.headSha === null || event.evidenceSha256 === null)
        || index > 2 && (event.headSha !== events[2]!.headSha || event.evidenceSha256 !== events[2]!.evidenceSha256)) documentReject("DOCUMENT_UNCERTAIN");
    }
    return events;
  }
  append(operationId: string, bindingSha256: string, expected: number, kind: BranchEvent["kind"], ticketVersion: string, headSha: string | null = null, evidenceSha256: string | null = null): void {
    this.db.transaction(() => {
      if (this.events(operationId).length !== expected) documentReject("DOCUMENT_CONFLICT");
      const event = parseEvent({ sequence: expected + 1, operationId, bindingSha256, kind, ticketVersion, headSha, evidenceSha256 });
      this.db.prepare("INSERT INTO handoff_branch_events (operation_id, sequence, payload) VALUES (?, ?, ?)").run(operationId, event.sequence, JSON.stringify(event));
      this.events(operationId); // Validate ordering and complete readback before commit.
    }).immediate();
  }
}
export function completeHandoffBranch(journal: RegistryHandoffBranchJournal, host: HandoffBranchHost,
  rawSubject: HandoffReviewSubject, rawIntent: HandoffBranchIntent, document: DocumentPackage, rawDecisionId: string): Record<string, unknown> {
  const subject = parseHandoffReviewSubject(rawSubject), intent = parseHandoffBranchIntent(rawIntent), decisionId = text(rawDecisionId, ID);
  const subjectSha256 = handoffReviewSubjectSha(subject), intentSha256 = handoffBranchIntentSha(intent);
  if (!subject.effects.publish || !subject.effects.branchRef || subject.branchIntentSha256 !== intentSha256 || subject.documentSubjectSha256 !== documentPackageSha(document)
    || intent.ticket !== document.ticket || intent.repository.key !== document.repository.key || intent.repository.root !== document.repository.root
    || subject.callerIdentitySha256 !== intent.callerIdentitySha256 || subject.effects.queue && !document.effects.queue) documentReject("DOCUMENT_AUTHORITY");
  const operationId = digest(JSON.stringify(["pa-handoff-branch-operation/v1", subjectSha256, decisionId]));
  const bindingSha256 = digest(JSON.stringify([subjectSha256, intentSha256, decisionId]));
  return host.serialize(() => {
    const caller = () => {
      const current = host.authenticate();
      if (current.identitySha256 !== subject.callerIdentitySha256 || current.selectionSha256 !== subject.selectionSha256) documentReject("DOCUMENT_AUTHORITY");
    };
    const authorize = () => { caller(); host.assertAvailable(intent); host.assertDecision(subjectSha256, decisionId); host.assertPublished(subject.documentSubjectSha256); };
    caller();
    let events = journal.events(operationId);
    if (events.some(e => e.bindingSha256 !== bindingSha256)) documentReject("DOCUMENT_CONFLICT");
    let ticketVersion = events[0]?.ticketVersion;
    const append = (kind: BranchEvent["kind"], headSha: string | null = null, evidenceSha256: string | null = null) => {
      journal.append(operationId, bindingSha256, events.length, kind, ticketVersion!, headSha, evidenceSha256); events = journal.events(operationId);
    };
    const owned = (value: HandoffRefObservation): value is Extract<HandoffRefObservation, { state: "present" }> => value.state === "present"
      && (value.owner.kind === "operation" && value.owner.id === operationId
        || value.owner.kind === "lineage" && intent.action === "reuse" && value.owner.sha256 === intent.lineage?.operationSha256);
    const observe = () => {
      caller();
      const value = host.observeRef(intent, operationId);
      if (value.state === "present") {
        text(value.headSha, GIT_SHA); text(value.evidenceSha256, SHA256);
        if (!owned(value) || !host.isAncestor(intent.base.sha, value.headSha)) documentReject("DOCUMENT_CONFLICT");
      }
      return value;
    };
    if (!events.length) {
      authorize(); ticketVersion = text(host.inspectLink(intent).version, SHA256); append("intent");
    }
    if (events.length === 1) { authorize(); append("ref-intent"); }
    let physical = observe();
    if (events.length === 2) {
      if (physical.state === "unknown" || physical.state === "absent" && physical.history !== "never-created") documentReject("DOCUMENT_UNCERTAIN");
      if (physical.state === "absent") {
        if (intent.action !== "create") documentReject("DOCUMENT_CONFLICT");
        authorize(); host.createRef(intent, operationId);
        physical = observe();
        if (physical.state !== "present" || physical.headSha !== intent.base.sha) documentReject("DOCUMENT_UNCERTAIN");
      }
      if (physical.state !== "present") documentReject("DOCUMENT_UNCERTAIN");
      authorize(); append("physical", physical.headSha, physical.evidenceSha256);
    }
    const result = events[2]!;
    if (physical.state !== "present" || physical.headSha !== result.headSha || physical.evidenceSha256 !== result.evidenceSha256) documentReject("DOCUMENT_CONFLICT");
    const expected: HandoffMaterializedLink = { repo: intent.repository.key, branch: intent.branch, state: "materialized", baseSha: intent.base.sha, headSha: result.headSha!, sha: result.headSha! };
    const matches = (link: HandoffMaterializedLink | null) => link !== null && Object.entries(expected).every(([key, value]) => link[key as keyof HandoffMaterializedLink] === value);
    let link = host.inspectLink(intent);
    if (events.length === 3) {
      if (!matches(link.link)) {
        if (link.version !== ticketVersion) documentReject("DOCUMENT_CONFLICT");
        authorize(); host.materializeLink(intent, ticketVersion!, expected); link = host.inspectLink(intent);
      }
      if (!matches(link.link)) documentReject("DOCUMENT_UNCERTAIN");
      // Observing an already-written link can settle an old operation after
      // revocation; remaining external writes always require current authority.
      caller(); append("linked", result.headSha, result.evidenceSha256);
    }
    if (!matches(link.link)) documentReject("DOCUMENT_CONFLICT");
    const finalRef = observe();
    if (finalRef.state !== "present" || finalRef.headSha !== expected.headSha || finalRef.evidenceSha256 !== result.evidenceSha256) documentReject("DOCUMENT_CONFLICT");
    if (events.length === 4) { caller(); append("complete", result.headSha, result.evidenceSha256); }
    return { schemaVersion: "pa-handoff-branch-result/v1", operationId, subjectSha256, intentSha256, branch: expected,
      completion: "verified", checkout: "not-prepared-by-this-operation", queue: "not-performed-by-this-operation", launchReady: false, authorityGranted: false, productUat: "not-asserted" };
  });
}
