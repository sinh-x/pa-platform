import { AUTO_PROJECTS, AutoWaitlistError } from "./waitlist.js";
import { object, SHA256, strictJson, text } from "../workflows/contracts.js";

/** Unsigned model-authored assessment only, NOT the full r002 session report.
 * This parser does not reserve a cycle, authenticate a PPA session, read goals,
 * persist evidence, attest reasoning or authorize a pick. */
export interface AutoSelectionReport {
  schemaVersion: "pa-auto-selection-assessment/v1";
  sessionId: string;
  snapshotSha256: string;
  goalSha256: string;
  policySha256: string;
  assessments: Array<{ ticket: string; rationale: string }>;
  selected: string | null;
  conclusion: string;
}
export interface AutoSelectionReportContext {
  sessionId: string;
  snapshotSha256: string;
  goalSha256: string;
  policySha256: string;
  eligibleTickets: readonly string[];
}
const ticketPattern = new RegExp(`^(?:${Object.values(AUTO_PROJECTS).join("|")})-\\d+$`);
const ticket = (v: unknown) => text(v, ticketPattern, 64);

/** A complete report is data for subsequent native evidence/CAS checks, never a
 * decision. The caller must obtain context from actual trusted owners and recheck
 * it immediately before any effect. No prefix, top-N or duplicate assessment is
 * accepted as full candidate coverage. No exception echoes the input. */
export function parseAutoSelectionReport(raw: Uint8Array, context: AutoSelectionReportContext): AutoSelectionReport {
  try {
    const sessionId = text(context.sessionId, /^d-[a-f0-9]{6}$/);
    const snapshotSha256 = text(context.snapshotSha256, SHA256);
    const goalSha256 = text(context.goalSha256, SHA256);
    const policySha256 = text(context.policySha256, SHA256);
    if (!Array.isArray(context.eligibleTickets) || context.eligibleTickets.length > 20_000) throw new Error();
    const expected = new Set(context.eligibleTickets.map(ticket));
    if (expected.size !== context.eligibleTickets.length) throw new Error();
    const r = object(strictJson(raw, 1_048_576), ["schemaVersion", "sessionId", "snapshotSha256", "goalSha256", "policySha256", "assessments", "selected", "conclusion"]);
    if (r.schemaVersion !== "pa-auto-selection-assessment/v1" || r.sessionId !== sessionId || r.snapshotSha256 !== snapshotSha256
      || r.goalSha256 !== goalSha256 || r.policySha256 !== policySha256 || !Array.isArray(r.assessments) || r.assessments.length !== expected.size) throw new Error();
    const seen = new Set<string>();
    const assessments = r.assessments.map(value => {
      const row = object(value, ["ticket", "rationale"]), id = ticket(row.ticket);
      if (!expected.has(id) || seen.has(id)) throw new Error();
      seen.add(id); return { ticket: id, rationale: text(row.rationale, undefined, 2048) };
    });
    const selected = r.selected === null ? null : ticket(r.selected);
    if (selected !== null && !expected.has(selected)) throw new Error();
    return { schemaVersion: "pa-auto-selection-assessment/v1", sessionId, snapshotSha256, goalSha256, policySha256,
      assessments, selected, conclusion: text(r.conclusion, undefined, 4096) };
  } catch { throw new AutoWaitlistError("AUTO_SOURCE"); }
}
