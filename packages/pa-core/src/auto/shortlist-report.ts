import { AUTO_PROJECTS, AutoWaitlistError } from "./waitlist.js";
import { digest, object, oneOf, SHA256, strictJson, text } from "../workflows/contracts.js";

/** Unsigned explanatory model data, not the full native r003 session report.
 * Neither this data nor a syntactically valid choice request proves a human
 * interaction, a registered session, freshness, policy adoption or authority. */
export interface AutoShortlistAssessment {
  schemaVersion: "pa-auto-shortlist-assessment/v1";
  sessionId: string;
  snapshotSha256: string;
  goalSha256: string;
  policySha256: string;
  configSha256: string;
  assessments: Array<{ ticket: string; disposition: "shortlisted" | "not-shortlisted"; rationale: string }>;
  shortlist: Array<{
    ticket: string; goalAlignment: string; boundedOutcome: string; stage: string; nextRoute: string;
    alternatives: string; risksAndDependencies: string; verification: string;
  }>;
  rankingRationale: string;
  summary: string;
}
export interface AutoShortlistAssessmentContext {
  sessionId: string;
  snapshotSha256: string;
  goalSha256: string;
  policySha256: string;
  configSha256: string;
  eligibleTickets: readonly string[];
}
const ticketPattern = new RegExp(`^(?:${Object.values(AUTO_PROJECTS).join("|")})-\\d+$`);
const ticket = (value: unknown) => text(value, ticketPattern, 64);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identityFields = ["snapshotSha256", "goalSha256", "policySha256", "configSha256"] as const;
const prose = (value: unknown, max: number): string => {
  const result = text(value, undefined, max);
  if (/[\u2028\u2029]/u.test(result)) throw new Error();
  return result;
};

/** Exact metadata coverage and a bounded advisory shortlist only. No prefix or
 * filler fallback is allowed. This checks declared coverage, not whether the
 * session really read/reasoned over it or whether its prose is useful or safe
 * to publish. Session, source/privacy and effect owners still supply that proof. */
export function parseAutoShortlistAssessment(raw: Uint8Array, context: AutoShortlistAssessmentContext): AutoShortlistAssessment {
  try {
    const sessionId = text(context.sessionId, /^d-[a-f0-9]{6}$/);
    if (!Array.isArray(context.eligibleTickets) || context.eligibleTickets.length > 20_000) throw new Error();
    const expected = new Set(context.eligibleTickets.map(ticket));
    if (expected.size !== context.eligibleTickets.length) throw new Error();
    const r = object(strictJson(raw, 1_048_576), ["schemaVersion", "sessionId", ...identityFields, "assessments", "shortlist", "rankingRationale", "summary"]);
    if (r.schemaVersion !== "pa-auto-shortlist-assessment/v1" || r.sessionId !== sessionId) throw new Error();
    for (const key of identityFields) if (r[key] !== text(context[key], SHA256)) throw new Error();
    if (!Array.isArray(r.assessments) || r.assessments.length !== expected.size || !Array.isArray(r.shortlist) || r.shortlist.length > 10) throw new Error();
    const seen = new Set<string>();
    const assessments = r.assessments.map(value => {
      const row = object(value, ["ticket", "disposition", "rationale"]), id = ticket(row.ticket);
      if (!expected.has(id) || seen.has(id)) throw new Error();
      seen.add(id);
      return { ticket: id, disposition: oneOf(row.disposition, ["shortlisted", "not-shortlisted"]), rationale: prose(row.rationale, 2048) };
    });
    const recommended = new Set(assessments.filter(row => row.disposition === "shortlisted").map(row => row.ticket));
    const listed = new Set<string>();
    const shortlist = r.shortlist.map(value => {
      const row = object(value, ["ticket", "goalAlignment", "boundedOutcome", "stage", "nextRoute", "alternatives", "risksAndDependencies", "verification"]), id = ticket(row.ticket);
      if (!recommended.has(id) || listed.has(id)) throw new Error();
      listed.add(id);
      return { ticket: id, goalAlignment: prose(row.goalAlignment, 2048), boundedOutcome: prose(row.boundedOutcome, 2048),
        stage: prose(row.stage, 256), nextRoute: prose(row.nextRoute, 256), alternatives: prose(row.alternatives, 2048),
        risksAndDependencies: prose(row.risksAndDependencies, 2048), verification: prose(row.verification, 2048) };
    });
    if (listed.size !== recommended.size) throw new Error();
    return { schemaVersion: "pa-auto-shortlist-assessment/v1", sessionId,
      snapshotSha256: context.snapshotSha256, goalSha256: context.goalSha256, policySha256: context.policySha256, configSha256: context.configSha256,
      assessments, shortlist, rankingRationale: prose(r.rankingRationale, 4096), summary: prose(r.summary, 4096) };
  } catch { throw new AutoWaitlistError("AUTO_SOURCE"); }
}

/** Request data only. Cancel/default/timeout must produce NO request. In
 * particular, a requestId or ticket here is not native human-selection evidence. */
export interface AutoShortlistChoiceRequest {
  schemaVersion: "pa-auto-shortlist-choice-request/v1";
  requestId: string;
  shortlistVersion: string;
  shortlistSha256: string;
  ticket: string;
}
export interface AutoShortlistChoiceContext {
  /** Bytes of a prospective immutable native view, NOT a model-authored receipt.
   * Keeping the assessment inside the hashed view binds order and explanations
   * as well as identity. Actual publication/provenance remains the native owner. */
  view: Uint8Array;
  current: AutoShortlistAssessmentContext;
  now: string;
}
function utc(value: unknown): number {
  const s = text(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== s) throw new Error();
  return ms;
}
/** Pure preflight for a future genuine CLI owner; NEVER accepts a choice or
 * reserves an item. That owner must authenticate an explicit human interaction,
 * reread native view/source/goal/policy/config/owner facts under CAS and durably
 * reconcile the same request. Passing caller-supplied data is not that proof. */
export function parseAutoShortlistChoiceRequest(raw: Uint8Array, context: AutoShortlistChoiceContext): AutoShortlistChoiceRequest {
  try {
    const r = object(strictJson(raw, 65_536), ["schemaVersion", "requestId", "shortlistVersion", "shortlistSha256", "ticket"]);
    if (r.schemaVersion !== "pa-auto-shortlist-choice-request/v1") throw new Error();
    const requestId = text(r.requestId, /^operation-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    const shortlistVersion = text(r.shortlistVersion, uuid), shortlistSha256 = text(r.shortlistSha256, SHA256), id = ticket(r.ticket);
    const view = object(strictJson(context.view, 1_048_576), ["schemaVersion", "version", "scanCompletedAt", "generatedAt", "expiresAt", "assessment"]);
    if (view.schemaVersion !== "pa-auto-shortlist-view/v1" || view.version !== shortlistVersion || digest(context.view) !== shortlistSha256) throw new Error();
    const scanned = utc(view.scanCompletedAt), generated = utc(view.generatedAt), expires = utc(view.expiresAt), now = utc(context.now);
    if (generated < scanned || expires <= generated || expires > scanned + 30 * 60_000 || now < generated || now >= expires) throw new Error();
    const assessment = parseAutoShortlistAssessment(Buffer.from(JSON.stringify(view.assessment)), context.current);
    if (!assessment.shortlist.some(row => row.ticket === id)) throw new Error();
    return { schemaVersion: "pa-auto-shortlist-choice-request/v1", requestId, shortlistVersion, shortlistSha256, ticket: id };
  } catch { throw new AutoWaitlistError("AUTO_SOURCE"); }
}
