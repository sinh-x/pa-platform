import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSemanticBriefingBundle,
  buildSemanticSourceMetadata,
  enforceSemanticConfirmationGate,
  renderSemanticBriefingBundle,
  type SemanticCandidateIndex,
  querySemanticCandidates,
} from "../semantic/index.js";

function doc(type: "ticket" | "artifact" | "reflection", locator: string, link: string, title: string, content: string, authoredBy?: string) {
  return { metadata: buildSemanticSourceMetadata({ type, locator, link, authoredBy }), title, content };
}

test("semantic briefing renderer keeps reflections first and grouped", () => {
  const index: SemanticCandidateIndex = {
    version: 1,
    generated_at: "2026-05-10T00:00:00.000Z",
    documents: [
      doc("reflection", "sinh-inputs/for-review/r1.md", "sinh-inputs/for-review/r1.md", "Reflection 1", "workflow pressure get up to date", "sinh"),
      doc("ticket", "PAP-058", "tickets/PAP-058", "PAP-058", "semantic briefing renderer confirmation gate"),
      doc("artifact", "agent-teams/builder/artifacts/report.md", "agent-teams/builder/artifacts/report.md", "Report", "bundle evidence map details"),
    ],
  };
  const result = querySemanticCandidates("workflow get up to date semantic briefing", 5, index);
  const bundle = buildSemanticBriefingBundle(result);
  const rendered = renderSemanticBriefingBundle(bundle);
  assert.match(rendered, /- reflections:/);
  assert.match(rendered, /- ticket:/);
  assert.match(rendered, /Evidence map:/);
  assert.match(rendered, /Confirmation gate:/);
});

test("semantic briefing marks summary claims with missing evidence", () => {
  const bundle = buildSemanticBriefingBundle({ query: "q", reflections: [], system: [] }, {
    summaryClaims: [
      { claim: "Claim with evidence", sourceLink: "tickets/PAP-058" },
      { claim: "Claim without evidence" },
    ],
  });
  const rendered = renderSemanticBriefingBundle(bundle);
  assert.match(rendered, /Claim with evidence -> tickets\/PAP-058/);
  assert.match(rendered, /Claim without evidence -> missing evidence/);
});

test("semantic briefing emits exactly one confirmation question", () => {
  const index: SemanticCandidateIndex = {
    version: 1,
    generated_at: "2026-05-10T00:00:00.000Z",
    documents: [
      doc("ticket", "PAP-069", "tickets/PAP-069", "PAP-069", "builder implement semantic briefing evaluate"),
    ],
  };
  const result = querySemanticCandidates("builder implement orchestrator evaluate", 5, index);
  const rendered = renderSemanticBriefingBundle(buildSemanticBriefingBundle(result));
  const questionMarks = rendered.match(/\?/g) ?? [];
  assert.equal(questionMarks.length, 1);
  assert.match(rendered, /Should I continue with deeper analysis now\?/);
});

test("semantic confirmation gate carries proposal, evidence, option implications, and exact decision", () => {
  const result = querySemanticCandidates("builder implement orchestrator evaluate", 5, {
    version: 1,
    generated_at: "2026-05-10T00:00:00.000Z",
    documents: [
      doc("ticket", "PAP-069", "tickets/PAP-069", "PAP-069", "builder implement semantic briefing evaluate"),
    ],
  });
  const rendered = renderSemanticBriefingBundle(buildSemanticBriefingBundle(result));
  const questionMarks = rendered.match(/\?/g) ?? [];

  assert.ok(rendered.includes("Proposal:") || rendered.includes("propose"));
  assert.match(rendered, /Evidence|Findings/);
  assert.match(rendered, /Implication|impact|means/i);
  assert.match(rendered, /Decision:/i);
  assert.equal(questionMarks.length, 1);
  assert.ok(rendered.length <= 1500, `confirmation payload is ${rendered.length} characters`);
});

test("semantic confirmation gate blocks writes before confirmation", () => {
  const blocked = enforceSemanticConfirmationGate(false, ["ticket", "status", "notes"]);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /blocked before confirmation/);

  const clear = enforceSemanticConfirmationGate(false, []);
  assert.equal(clear.allowed, true);
});

test("semantic confirmation payload bounds long and adversarial input", () => {
  const bundle = buildSemanticBriefingBundle({
    query: `${"query? ".repeat(500)}?`,
    reflections: [],
    system: [],
  }, { summaryClaims: [{ claim: `${"finding? ".repeat(500)}?` }] });
  assert.ok(bundle.confirmation_question.length <= 1500);
  assert.equal((bundle.confirmation_question.match(/\?/g) ?? []).length, 1);
});
