import { lexer, type Tokens } from "marked";
import { workflowObject, workflowSha, workflowText, workflowTimestamp } from "../deploy/prepared-workflow.js";
import { renderReadingMarkdown } from "../artifacts/render.js";
import { ArtifactPolicyError } from "../artifacts/policy.js";
import { DocumentPackageError } from "../documents/package-contract.js";
import type { TicketStore } from "./store.js";
import type { Ticket } from "./types.js";
import { ContentReviewService, type ContentReviewHost, type ContentReviewView } from "../documents/content-review.js";
import type { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import { verifyLocalReviewOrigin } from "../documents/local-review.js";
import type Database from "better-sqlite3";
import { inspectFullDocumentReader } from "../documents/reader-publication.js";
import { documentText, validateDocumentBytes } from "../documents/package-tools.js";
import type { DocumentPackage } from "../documents/package-contract.js";

export interface PlannedApprovalOwner {
  schemaVersion: "pa-content-review-subject/v1" | "pa-handoff-review/v1" | "pa-handoff-review/v2";
  subjectSha256: string; decisionId: string | null; scope: "content" | { publish: boolean; branchRef: boolean; queue: boolean };
}
export interface PlannedReviewView {
  reference: string; subject: Pick<ContentReviewView["subject"], "documentSubjectSha256" | "deliverySha256">;
  document: DocumentPackage; presentation: Record<string, unknown>; documents: ContentReviewView["documents"];
  history: ContentReviewView["history"]; approvalOwner?: PlannedApprovalOwner;
}
/** Existing owners only. Never request, issue, authorize effects, or synthesize a
 * content-only subject for a retained combined approval. v1's native capture and
 * v2's original saved origin remain validated by their original journal owners. */
export async function readPlannedReview(db: Database.Database, journal: RegistryHandoffReviewJournal, tickets: TicketStore, host: ContentReviewHost, reference: string): Promise<PlannedReviewView> {
  const match = /^(?:review:)?([a-f0-9]{64})$/.exec(reference); if (!match) throw new Error("Invalid Planned reference");
  const sha = match[1]!, selected = journal.publicationSubject(sha);
  let view: PlannedReviewView;
  if (selected.subject.schemaVersion === "pa-content-review-subject/v1") {
    view = { ...await new ContentReviewService(journal, host).show(`review:${sha}`), reference };
  } else {
    if (!selected.intent) throw new Error("Missing original combined intent");
    host.assertDocument(selected.document);
    if (selected.subject.schemaVersion === "pa-handoff-review/v2") verifyLocalReviewOrigin(db, tickets, selected.subject, selected.intent);
    const presentation = await inspectFullDocumentReader(selected.document, host.artifactRoot, digest => journal.documents.snapshot(digest), selected.subject.deliverySha256);
    const documents = selected.document.members.map(member => {
      const raw = journal.documents.snapshot(member.sha256); validateDocumentBytes(member, raw);
      return { id: member.id, mediaType: member.mediaType, sha256: member.sha256, content: member.mediaType.startsWith("text/") ? documentText(raw) : null };
    });
    view = { reference, subject: selected.subject, document: selected.document, presentation, documents, history: journal.events(sha) };
  }
  const capture = view.history.filter(e => e.kind === "requested" && e.request.operation === "capture").at(-1);
  view.approvalOwner = { schemaVersion: selected.subject.schemaVersion, subjectSha256: sha, decisionId: capture?.kind === "requested" ? capture.request.decisionId : null,
    scope: selected.subject.schemaVersion === "pa-content-review-subject/v1" ? "content" : selected.subject.effects };
  return view;
}

export type UnavailableState = "missing" | "denied" | "integrity-failure" | "conflict" | "unknown" | "checking";
export interface Unavailable { state: UnavailableState }
/** Finite native failure facts only. Saved approval never turns unreadable delivery
 * into verified content; arbitrary exceptions/flags remain unknown and undisclosed. */
export function plannedActualReadFailure(error: unknown): Unavailable {
  if (error instanceof ArtifactPolicyError && error.diagnostic === "ARTIFACT_STALE") return { state: "integrity-failure" };
  if (error instanceof DocumentPackageError && error.code === "DOCUMENT_AUTHORITY") return { state: "denied" };
  if (error instanceof DocumentPackageError && error.code === "DOCUMENT_CONFLICT") return { state: "conflict" };
  return { state: "unknown" };
}
export interface AcceptanceRow { id: string; expectation: string }
export interface PlannedRecord {
  reference: string; repository: { key: string; root: string }; ticket: string; subjectSha256: string; revision: number;
  manifestSha256: string; deliverySha256: string; state: "approved" | "draft"; entry: string; rows: readonly AcceptanceRow[];
  approvalOwner?: PlannedApprovalOwner;
}
export interface ComparisonBinding {
  repository: PlannedRecord["repository"]; ticket: string; subjectSha256: string; revision: number; manifestSha256: string; candidateSha: string;
}
export interface ActualObservation {
  ac: string; observation: string; disposition: "matches" | "deviates" | "unmet" | "unverified";
  difference: string; impact: string; owner: string;
}
export interface ComparisonEvidence {
  class: "source" | "installed" | "independent" | "browser" | "human-uat";
  state: "passed" | "failed" | "not-run" | "pending" | "unknown";
  locator: string | null; observedAt: string | null; coverage: readonly string[]; trust: "native" | "local-unverified" | "not-observed";
  applicability?: "current" | "historical" | "unverified"; candidateSha?: string;
}
/** Owner-authenticated metadata for the existing immutable report, NOT another report. */
export interface ActualRecord {
  locator: string; binding: ComparisonBinding; plannedReference: string; reportId: string; reportSourceSha256: string;
  reportPath: string; ownerPath: string; outcome: "success" | "partial" | "failed" | "interrupted"; scope: string;
  observations: readonly ActualObservation[]; actualOnly: readonly string[]; evidence: readonly ComparisonEvidence[];
}
/** Trusted owner ports. Tool input cannot implement these ports or import evidence. */
export interface PlannedActualHost {
  /** Existing native review/document membership only, independent of Actual attachments. */
  discoverPlans(ticket: Pick<Ticket, "id" | "project">): Promise<{ references: readonly string[]; issues: readonly Unavailable[] }>;
  resolvePlan(reference: string): Promise<PlannedRecord | Unavailable>;
  resolveActual(locator: string): Promise<ActualRecord | Unavailable>;
}
const unavailable = ["missing", "denied", "integrity-failure", "conflict", "unknown", "checking"] as const;
const classes = ["source", "installed", "independent", "browser", "human-uat"] as const;
const dispositions = ["matches", "deviates", "unmet", "unverified"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function text(value: unknown): string {
  const result = workflowText(value);
  if (result.length > 8192 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error("Invalid comparison text");
  return result;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid comparison list"); return value.map(parse);
}
function ac(value: unknown): string { const id = text(value); if (!/^AC-[0-9]{1,4}$/.test(id)) throw new Error("Invalid acceptance identity"); return id; }
export function parseActualObservations(value: unknown): readonly ActualObservation[] {
  const result = list(value, item => {
    const r = workflowObject(item, ["ac", "observation", "disposition", "difference", "impact", "owner"]);
    const disposition = dispositions.find(d => d === r.disposition); if (!disposition) throw new Error("Invalid disposition");
    return { ac: ac(r.ac), observation: text(r.observation), disposition, difference: text(r.difference), impact: text(r.impact), owner: text(r.owner) };
  });
  if (new Set(result.map(r => r.ac)).size !== result.length) throw new Error("Conflicting acceptance observations"); return result;
}
export function parseActualOnly(value: unknown): readonly string[] { return list(value, text); }
export function parseComparisonBinding(value: unknown): ComparisonBinding {
  const r = workflowObject(value, ["repository", "ticket", "subjectSha256", "revision", "manifestSha256", "candidateSha"]);
  const repo = workflowObject(r.repository, ["key", "root"]); const ticket = text(r.ticket);
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket) || !Number.isSafeInteger(r.revision) || Number(r.revision) < 1) throw new Error("Invalid comparison binding");
  return { repository: { key: text(repo.key), root: text(repo.root) }, ticket, subjectSha256: workflowSha(r.subjectSha256), revision: Number(r.revision), manifestSha256: workflowSha(r.manifestSha256), candidateSha: workflowSha(r.candidateSha, 40) };
}
export function parseActualRecord(value: unknown): ActualRecord {
  const r = workflowObject(value, ["locator", "binding", "plannedReference", "reportId", "reportSourceSha256", "reportPath", "ownerPath", "outcome", "scope", "observations", "actualOnly", "evidence"]);
  const outcome = (["success", "partial", "failed", "interrupted"] as const).find(s => s === r.outcome); if (!outcome) throw new Error("Invalid report outcome");
  const locator = text(r.locator); parseComparisonLocator(locator);
  return { locator, binding: parseComparisonBinding(r.binding), plannedReference: text(r.plannedReference), reportId: workflowSha(r.reportId), reportSourceSha256: workflowSha(r.reportSourceSha256), reportPath: text(r.reportPath), ownerPath: text(r.ownerPath), outcome, scope: text(r.scope), observations: parseActualObservations(r.observations), actualOnly: parseActualOnly(r.actualOnly), evidence: list(r.evidence, item => {
    const e = workflowObject(item, ["class", "state", "locator", "observedAt", "coverage", "trust", ...["applicability", "candidateSha"].filter(key => item !== null && typeof item === "object" && Object.hasOwn(item, key))]);
    const kind = classes.find(c => c === e.class), state = (["passed", "failed", "not-run", "pending", "unknown"] as const).find(s => s === e.state), trust = (["native", "local-unverified", "not-observed"] as const).find(t => t === e.trust);
    if (!kind || !state || !trust || (state === "passed" || state === "failed") && (!e.locator || !e.observedAt || trust === "not-observed")) throw new Error("Invalid comparison evidence");
    const applicability = e.applicability === undefined ? kind === "source" ? "unverified" : "current" : (["current", "historical", "unverified"] as const).find(a => a === e.applicability);
    if (!applicability) throw new Error("Invalid evidence applicability");
    return { class: kind, state, trust, applicability, ...(e.candidateSha === undefined ? {} : { candidateSha: workflowSha(e.candidateSha, 40) }), locator: e.locator === null ? null : text(e.locator), observedAt: e.observedAt === null ? null : workflowTimestamp(e.observedAt), coverage: list(e.coverage, ac) };
  }) };
}
/** Exact retained phase-report reading recipe; no rendering or file publication authority. */
export function verifyPhaseReportReading(source: Buffer, html: Buffer, sourcePath: string): boolean {
  return renderReadingMarkdown(source, sourcePath, ["report.md", "diff.patch"]).html.equals(html);
}
export function parseComparisonLocator(value: string): { deploymentId: string; digest: string } {
  const m = /^\/(?:[^/\u0000-\u001f]+\/)*planned-actual-(d-[a-f0-9]{6})-([a-f0-9]{64})\.json$/.exec(value);
  if (!m) throw new Error("Invalid comparison locator"); return { deploymentId: m[1]!, digest: m[2]! };
}
/** Preserve complete Markdown blocks, not a regex-selected prefix of an AC.
 * Only top-level criteria count; fenced/quoted/nested examples cannot mint rows. */
export function extractAcceptanceRows(markdown: string): readonly AcceptanceRow[] {
  const rows: AcceptanceRow[] = [];
  let paragraph: AcceptanceRow | undefined;
  const add = (id: string, expectation: string) => {
    const row = { id: ac(id), expectation }; rows.push(row); return row;
  };
  for (const token of lexer(markdown)) {
    if (token.type === "heading") { paragraph = undefined; continue; }
    if (token.type === "list") {
      const criteria = (token as Tokens.List).items.map(item => /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(AC-\d{1,4}):[ \t]+([^\n]+)([\s\S]*)$/.exec(item.raw));
      if (criteria.some(Boolean)) {
        paragraph = undefined;
        if (criteria.some(match => !match)) throw new Error("Mixed acceptance list requires explicit criterion boundaries");
        for (const match of criteria) if (match) add(match[1]!, match[2]! + match[3]!);
        continue;
      }
    }
    // Complete raw table rows remain the expectation, including all columns.
    if (token.type === "table" || token.type === "paragraph") {
      const lines = token.raw.split("\n");
      const table = lines.map(line => /^\|[ \t]*(AC-\d{1,4})[ \t]*\|.+\|[ \t]*$/.exec(line));
      if (table.some(Boolean)) {
        paragraph = undefined;
        for (const [index, match] of table.entries()) if (match) add(match[1]!, lines[index]!);
        continue;
      }
      if (token.type === "paragraph" && /^ {0,3}AC-\d{1,4}:[ \t]+/.test(token.raw)) {
        for (const line of lines) {
          const match = /^ {0,3}(AC-\d{1,4}):[ \t]+(.+)$/.exec(line);
          if (match) paragraph = add(match[1]!, match[2]!);
          else if (paragraph) paragraph.expectation += `\n${line}`;
        }
        continue;
      }
    }
    // A paragraph criterion owns subsequent blocks until an explicit heading or
    // next criterion. Keep nested list/table/code text; never recursively parse it.
    if (paragraph) paragraph.expectation += token.raw;
  }
  for (const row of rows) {
    row.expectation = row.expectation.replace(/\n+$/, "");
    text(row.expectation.replace(/[\n\r\t]/g, " "));
  }
  if (rows.length > 128 || new Set(rows.map(r => r.id)).size !== rows.length) throw new Error("Conflicting acceptance criteria"); return rows;
}
function isUnavailable(value: PlannedRecord | ActualRecord | Unavailable): value is Unavailable { return "state" in value && unavailable.some(s => s === value.state); }
export function bindingForPlan(plan: PlannedRecord, candidateSha: string): ComparisonBinding {
  return parseComparisonBinding({ repository: plan.repository, ticket: plan.ticket, subjectSha256: plan.subjectSha256, revision: plan.revision, manifestSha256: plan.manifestSha256, candidateSha });
}
export interface ActualProjection {
  locator: string; binding: ComparisonBinding; reportId: string; reportSourceSha256: string; reportPath: string; ownerPath: string; scope: string; outcome: ActualRecord["outcome"];
  narrativeTrust: "agent-labelled-not-acceptance"; rows: readonly (AcceptanceRow & Omit<ActualObservation, "ac">)[]; actualOnly: readonly string[]; evidence: readonly ComparisonEvidence[];
}
export interface PlannedActualProjection {
  state: UnavailableState | "no-plan" | "selection-required" | "draft" | "no-handback" | "unmatched" | "available";
  choices?: { reference: string; state: PlannedRecord["state"]; candidate?: string; reportId?: string }[];
  planned?: PlannedRecord; actuals: ActualProjection[]; unmatched: { locator: string; state: "binding-mismatch" }[];
  issues: { state: UnavailableState }[];
}
/** Read-only; never selects a latest plan or candidate and never exposes denied owner data. */
export async function projectPlannedActual(ticket: Ticket, reference: string | undefined, candidate: string | undefined, host: PlannedActualHost): Promise<PlannedActualProjection> {
  const result: PlannedActualProjection = { state: "no-plan", actuals: [], unmatched: [], issues: [] };
  if (reference === undefined) {
    result.choices = [];
    let mismatchedPlan = false;
    try {
      if (ticket.doc_refs.length > 256) throw new Error("Too many ticket references");
      for (const ref of comparisonRefs(ticket)) {
        const actual = await resolveActualSafely(host, ref.path);
        if (isUnavailable(actual)) { result.issues.push({ state: actual.state }); continue; }
        if (actual.locator !== ref.path || actual.binding.ticket !== ticket.id || actual.binding.repository.key !== ticket.project) { result.unmatched.push({ locator: ref.path, state: "binding-mismatch" }); continue; }
        const plan = await resolvePlanSafely(host, actual.plannedReference);
        if (isUnavailable(plan)) { result.issues.push({ state: plan.state }); continue; }
        if (!planBelongsToTicket(plan, actual.plannedReference, ticket) || !same(bindingForPlan(plan, actual.binding.candidateSha), actual.binding)) { result.unmatched.push({ locator: ref.path, state: "binding-mismatch" }); continue; }
        const choice = { reference: plan.reference, state: plan.state, candidate: actual.binding.candidateSha, reportId: actual.reportId };
        if (!result.choices.some(c => same(c, choice))) result.choices.push(choice);
      }
    } catch { result.issues.push({ state: "unknown" }); }
    // Attachment failure must not suppress independent native Planned discovery.
    try {
      const discovered = await host.discoverPlans({ id: ticket.id, project: ticket.project });
      if (discovered.references.length > 1024 || discovered.issues.length > 1024) throw new Error("Too many Planned references");
      result.issues.push(...discovered.issues.map(issue => ({ state: issue.state })));
      for (const reference of new Set(discovered.references)) {
        const plan = await resolvePlanSafely(host, text(reference));
        if (isUnavailable(plan)) { result.issues.push({ state: plan.state }); continue; }
        if (!planBelongsToTicket(plan, reference, ticket)) { mismatchedPlan = true; continue; }
        if (!result.choices.some(choice => choice.reference === reference)) result.choices.push({ reference, state: plan.state });
      }
    } catch { result.issues.push({ state: "unknown" }); }
    result.state = result.issues[0]?.state ?? (result.choices.length ? "selection-required" : result.unmatched.length || mismatchedPlan ? "unmatched" : "no-plan");
    return result;
  }
  try {
    const plan = await resolvePlanSafely(host, text(reference));
    if (isUnavailable(plan)) return { ...result, state: plan.state };
    if (!planBelongsToTicket(plan, reference, ticket)) return { ...result, state: "unmatched" };
    if (plan.state !== "approved") return { ...result, state: "draft", planned: plan };
    const binding = candidate === undefined ? undefined : bindingForPlan(plan, workflowSha(candidate, 40));
    const candidateChoices: NonNullable<PlannedActualProjection["choices"]> = [];
    if (!binding) result.choices = candidateChoices;
    if (!plan.rows.length) return { ...result, state: "integrity-failure" };
    result.planned = plan; result.state = "no-handback";
    if (ticket.doc_refs.length > 256) throw new Error("Too many ticket references");
    for (const ref of comparisonRefs(ticket)) {
      const actual = await resolveActualSafely(host, ref.path);
      if (isUnavailable(actual)) { result.issues.push({ state: actual.state }); continue; }
      if (actual.locator !== ref.path || actual.plannedReference !== reference || !same(actual.binding, binding ?? bindingForPlan(plan, actual.binding.candidateSha))) { result.unmatched.push({ locator: ref.path, state: "binding-mismatch" }); continue; }
      if (actual.observations.some(o => !plan.rows.some(r => r.id === o.ac))) { result.issues.push({ state: "conflict" }); continue; }
      if (!binding) {
        const choice = { reference, state: plan.state, candidate: actual.binding.candidateSha, reportId: actual.reportId };
        if (!candidateChoices.some(c => same(c, choice))) candidateChoices.push(choice);
        continue;
      }
      const previous = result.actuals.find(r => r.reportId === actual.reportId);
      const baseline: ComparisonEvidence[] = classes.filter(kind => kind === "human-uat" || !actual.evidence.some(e => e.class === kind && e.applicability === "current")).map(kind => ({ class: kind, state: "not-run", locator: null, observedAt: null, coverage: [], trust: "not-observed" }));
      const evidence = previous?.evidence ?? baseline;
      const appended = [...evidence, ...actual.evidence.filter(e => !evidence.some(p => same(e, p)))];
      if (previous) {
        if (previous.reportSourceSha256 !== actual.reportSourceSha256 || !same(previous.rows, rows(plan, actual)) || !same(previous.actualOnly, actual.actualOnly)) { result.issues.push({ state: "conflict" }); continue; }
        previous.evidence = appended;
      } else result.actuals.push({ locator: actual.locator, binding: actual.binding, reportId: actual.reportId, reportSourceSha256: actual.reportSourceSha256, reportPath: actual.reportPath, ownerPath: actual.ownerPath, scope: actual.scope, outcome: actual.outcome, narrativeTrust: "agent-labelled-not-acceptance", rows: rows(plan, actual), actualOnly: actual.actualOnly, evidence: appended });
    }
    for (const a of result.actuals) for (const kind of classes) {
      const observations = a.evidence.filter(e => e.class === kind && e.applicability === "current");
      if (observations.some(e => e.state === "passed" && observations.some(o => o.state === "failed" && (kind !== "source" || e.locator === o.locator) && (e.coverage.length === 0 || o.coverage.length === 0 || e.coverage.some(id => o.coverage.includes(id)))))) result.issues.push({ state: "conflict" });
    }
    for (const a of result.actuals) for (const b of result.actuals) {
      if (a === b) continue;
      if (a.rows.some(row => row.disposition === "matches" && b.rows.some(other => other.id === row.id && (other.disposition === "deviates" || other.disposition === "unmet")))) result.issues.push({ state: "conflict" });
    }
    result.state = result.issues.some(i => i.state === "conflict") ? "conflict" : result.issues[0]?.state ?? (result.actuals.length ? "available" : result.choices?.length ? "selection-required" : result.unmatched.length ? "unmatched" : "no-handback");
    return result;
  } catch { return { state: "unknown", actuals: [], unmatched: [], issues: [{ state: "unknown" }] }; }
}
function planBelongsToTicket(plan: PlannedRecord, reference: string, ticket: Ticket): boolean {
  return plan.reference === reference && plan.ticket === ticket.id && plan.repository.key === ticket.project;
}
async function resolveActualSafely(host: PlannedActualHost, locator: string): Promise<ActualRecord | Unavailable> {
  let result: ActualRecord | Unavailable;
  try { result = await host.resolveActual(locator); } catch { return { state: "unknown" }; }
  try { return isUnavailable(result) ? { state: result.state } : parseActualRecord(result); } catch { return { state: "integrity-failure" }; }
}
async function resolvePlanSafely(host: PlannedActualHost, reference: string): Promise<PlannedRecord | Unavailable> {
  try { return await host.resolvePlan(reference); } catch { return { state: "unknown" }; }
}
function comparisonRefs(ticket: Ticket) {
  return ticket.doc_refs.filter(r => r.type === "attachment" && /\/planned-actual-d-[a-f0-9]{6}-[a-f0-9]{64}\.json$/.test(r.path));
}
function rows(plan: PlannedRecord, actual: ActualRecord): ActualProjection["rows"] {
  return plan.rows.map(row => { const observation = actual.observations.find(o => o.ac === row.id); return { ...row, observation: observation?.observation ?? "No observation recorded.", disposition: observation?.disposition ?? "unverified", difference: observation?.difference ?? "Unverified", impact: observation?.impact ?? "Unknown", owner: observation?.owner ?? "Builder" }; });
}
/** Existing ticket mutex and audited ref owner. No primary, status or signed byte mutation. */
export async function attachPlannedActual(store: TicketStore, ticketId: string, locator: string, host: PlannedActualHost, authorize: () => void): Promise<void> {
  authorize(); const actual = await host.resolveActual(locator);
  if (isUnavailable(actual)) throw new Error("Actual attachment unavailable");
  const parsed = parseActualRecord(actual); if (parsed.locator !== locator) throw new Error("Exact attachment locator required");
  const plan = await host.resolvePlan(parsed.plannedReference);
  if (isUnavailable(plan) || plan.state !== "approved" || !same(bindingForPlan(plan, parsed.binding.candidateSha), parsed.binding)) throw new Error("Exact attachment binding required");
  store.withWorkflowTransaction(() => {
    authorize(); const ticket = store.get(ticketId);
    if (!ticket || ticket.id !== parsed.binding.ticket || ticket.project !== parsed.binding.repository.key) throw new Error("Exact ticket required");
    const refs = [{ type: "orch", path: parsed.ownerPath }, { type: "impl", path: parsed.reportPath }, { type: "attachment", path: parsed.locator }];
    for (const ref of refs) {
      const existing = ticket.doc_refs.filter(r => r.path === ref.path);
      if (existing.length > 1 || existing.some(r => r.type !== ref.type || r.primary)) throw new Error("Conflicting attachment");
    }
    const missing = refs.filter(ref => !ticket.doc_refs.some(r => r.path === ref.path));
    if (missing.length) {
      authorize(); const addedAt = new Date().toISOString();
      store.update(ticketId, { doc_refs: [...ticket.doc_refs, ...missing.map(ref => ({ ...ref, primary: false, addedAt, addedBy: "native/planned-actual" }))] }, "native/planned-actual");
    }
    const after = store.get(ticketId);
    if (!after || refs.some(ref => !after.doc_refs.some(r => r.path === ref.path && r.type === ref.type && !r.primary))) throw new Error("Attachment readback failed");
  });
}
