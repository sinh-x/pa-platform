import { randomUUID } from "node:crypto";
import { digest } from "../workflows/contracts.js";
import { buildAutoWaitlist, type AutoProject } from "../auto/waitlist.js";
import { RegistryAutoShortlists, type AutoChoiceRecord, type AutoPublishedShortlist, type AutoReasoningCycle, type AutoReasoningSessionEvidence, type AutoShortlistChoiceHost } from "../auto/shortlist-journal.js";
import type Database from "better-sqlite3";

export const asBytes = (value: unknown) => Buffer.from(JSON.stringify(value));
export function shortlistFixture(db: Database.Database) {
  const store = new RegistryAutoShortlists(db);
  const snapshot = buildAutoWaitlist({ observedAt: "2026-11-14T03:00:00.000Z", completedAt: "2026-11-14T03:00:00.000Z",
    projects: [{ key: "pa-platform", prefix: "PAP", canonicalRoot: "/synthetic/runtime" }, { key: "pa-platform-config", prefix: "PAPC", canonicalRoot: "/synthetic/config" }],
    tickets: Array.from({ length: 13 }, (_, i) => ({ id: i % 2 ? `PAPC-${i + 1}` : `PAP-${i + 1}`, project: (i % 2 ? "pa-platform-config" : "pa-platform") as AutoProject,
      title: "Synthetic finite work", priority: "medium" as const, status: "idea" as const, createdAt: "2026-11-14T02:00:00.000Z", ticketSha256: digest(`ticket-${i}`), archived: false,
      unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "missing" as const } })) });
  const snapshotBytes = asBytes(snapshot), goalEvidence = asBytes({ ref: "operator-focus:test", date: "2026-11-14", text: "A bounded synthetic goal." });
  const context = { sessionId: "d-a1b2c3", snapshotSha256: digest(snapshotBytes), goalSha256: digest(goalEvidence), policySha256: "c".repeat(64), configSha256: "d".repeat(64), eligibleTickets: snapshot.entries.filter(e => e.route !== "observe").map(e => e.id) };
  const input = { snapshot: snapshotBytes, goalEvidence, request: asBytes({ context, fixture: true }), context, deadlineAt: "2026-11-14T03:10:00.000Z" };
  let now = "2026-11-14T03:00:00.000Z";
  const capture = async (request: AutoChoiceRecord, shortlist: AutoPublishedShortlist, ticket: string | null = shortlist.report.assessment.shortlist[2]!.ticket) => {
    const principal = "local-uid:fixture", interactionId = `interaction-${randomUUID()}`;
    return { ticket, principal, interactionId, evidence: asBytes({ schemaVersion: "pa-auto-shortlist-human-choice/v1", method: "ppa-auto-foreground", requestId: request.requestId,
      viewVersion: shortlist.version, viewSha256: shortlist.sha256, ticket, principal, interactionId }) };
  };
  const host: AutoShortlistChoiceHost = { authenticate: () => "e".repeat(64), now: () => now, reobserve: () => structuredClone(context), assertSession() {}, capture };
  const session = (cycle: AutoReasoningCycle, outputBytes: number): AutoReasoningSessionEvidence => ({ deploymentId: cycle.context.sessionId, operationId: cycle.operationId, requestSha256: cycle.requestSha256,
    provider: "fixture", model: "fixture-model", configRevision: "f".repeat(40), resourcesSha256: cycle.context.configSha256, startedAt: cycle.createdAt, completedAt: "2026-11-14T03:01:00.000Z",
    sourceRequests: 0, contextBytes: 100, outputBytes, cleanup: "settled", cleanupScope: "observed-process-group-no-escaped-descendant-guarantee" });
  const assessment = (count = 10) => ({ schemaVersion: "pa-auto-shortlist-assessment/v1", sessionId: context.sessionId, snapshotSha256: context.snapshotSha256, goalSha256: context.goalSha256, policySha256: context.policySha256, configSha256: context.configSha256,
    assessments: context.eligibleTickets.map((ticket, i) => ({ ticket, disposition: i < count ? "shortlisted" : "not-shortlisted", rationale: "Synthetic assessment for the observed goal." })),
    shortlist: context.eligibleTickets.slice(0, count).map(ticket => ({ ticket, goalAlignment: "Goal fit.", boundedOutcome: "Finite useful outcome.", stage: "Needs requirements.", nextRoute: "Draft requirements.", alternatives: "Compare all eligible items.", risksAndDependencies: "Recheck source dependencies.", verification: "Use the actual registered matrix." })), rankingRationale: "Advisory comparison, not automatic choice.", summary: "No ticket selected." });
  const saved = (count = 10) => {
    let cycle = store.claim(store.reserve(input, host), host);
    const raw = asBytes(assessment(count)); cycle = store.captureOutput(cycle, raw, host);
    cycle = store.saveReport(cycle, session(cycle, raw.length), host);
    now = "2026-11-14T03:02:00.000Z";
    return { cycle, shortlist: store.publish(cycle, "2026-11-14T03:30:00.000Z", host) };
  };
  return { store, snapshot, input, context, host, capture, session, assessment, saved, setNow: (value: string) => { now = value; } };
}
