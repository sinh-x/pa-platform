import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAutoSelectionReport, type AutoSelectionReportContext } from "../auto/selection-report.js";
import { AutoWaitlistError } from "../auto/waitlist.js";

const context: AutoSelectionReportContext = { sessionId: "d-a1b2c3", snapshotSha256: "a".repeat(64), goalSha256: "b".repeat(64), policySha256: "c".repeat(64), eligibleTickets: ["PAP-1", "PAPC-2"] };
const report = () => ({ schemaVersion: "pa-auto-selection-assessment/v1", sessionId: context.sessionId, snapshotSha256: context.snapshotSha256, goalSha256: context.goalSha256, policySha256: context.policySha256,
  assessments: [{ ticket: "PAP-1", rationale: "The bounded task fits the observed goal." }, { ticket: "PAPC-2", rationale: "The alternative requires more prior work." }], selected: "PAP-1", conclusion: "The first candidate is a smaller local outcome." });
const parse = (value: unknown, ctx = context) => parseAutoSelectionReport(Buffer.from(JSON.stringify(value)), ctx);
const rejected = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof AutoWaitlistError && e.code === "AUTO_SOURCE" && !e.message.includes("private-sentinel"));

test("unsigned selector report accepts complete exact coverage or explicit no-pick, without granting authority", () => {
  assert.deepEqual(parse(report()), report());
  assert.equal(parse({ ...report(), selected: null, conclusion: "No candidate is suitable." }).selected, null);
  assert.equal(parse({ ...report(), selected: null, assessments: [] }, { ...context, eligibleTickets: [] }).selected, null);
});

test("selector assessment requires all pages, not only a ranked prefix", () => {
  const eligibleTickets = Array.from({ length: 250 }, (_, i) => `PAP-${i + 1}`);
  const assessments = eligibleTickets.map(ticket => ({ ticket, rationale: "Synthetic comparison." }));
  const large = { ...report(), assessments, selected: "PAP-250" };
  assert.equal(parse(large, { ...context, eligibleTickets }).assessments.length, 250);
  rejected(() => parse({ ...large, assessments: assessments.slice(0, 100) }, { ...context, eligibleTickets }));
});

test("selector report rejects omitted, extra, duplicate, blocked and malformed candidate identities", () => {
  for (const assessments of [[report().assessments[0]], [...report().assessments, report().assessments[0]], [report().assessments[0], report().assessments[0]], [{ ticket: "PAP-3", rationale: "other" }, report().assessments[1]]]) rejected(() => parse({ ...report(), assessments }));
  for (const selected of ["PAP-3", "PAPC-02-X", "private-sentinel", ""]) rejected(() => parse({ ...report(), selected }));
  rejected(() => parse(report(), { ...context, eligibleTickets: ["PAP-1", "PAP-1"] }));
});

test("selector report refuses untrusted authority fields, identity drift, unsafe content and malformed bytes", () => {
  for (const patch of [{ approved: true }, { sessionId: "d-deadbe" }, { snapshotSha256: "d".repeat(64) }, { goalSha256: "d".repeat(64) }, { policySha256: "d".repeat(64) }, { conclusion: "private-sentinel\n" }, { conclusion: "" }]) rejected(() => parse({ ...report(), ...patch }));
  rejected(() => parseAutoSelectionReport(Buffer.from('{"schemaVersion":"pa-auto-selection-assessment/v1","schemaVersion":"private-sentinel"}'), context));
  rejected(() => parseAutoSelectionReport(Buffer.from([0xff]), context));
  rejected(() => parseAutoSelectionReport(Buffer.alloc(1_048_577, 32), context));
});
