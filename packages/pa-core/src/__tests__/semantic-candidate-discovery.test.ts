import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSemanticSourceMetadata, listSemanticFixtureQuestions, querySemanticCandidates, rebuildSemanticCandidateIndex, type SemanticCandidateIndex } from "../semantic/index.js";

function doc(type: "ticket" | "artifact" | "ticket-comment" | "session-log" | "registry-event" | "deployment" | "reflection" | "sinh-input" | "doc-ref", locator: string, link: string, title: string, content: string, authoredBy?: string) {
  return { metadata: buildSemanticSourceMetadata({ type, locator, link, authoredBy }), title, content };
}

test("semantic query ranks reflections in dedicated first section", () => {
  const index: SemanticCandidateIndex = {
    version: 1,
    generated_at: "2026-05-10T00:00:00.000Z",
    documents: [
      doc("reflection", "sinh-inputs/for-review/r1.md", "sinh-inputs/for-review/r1.md", "Reflection", "workflow pressure concern semantic briefing", "sinh"),
      doc("ticket", "PAP-058", "tickets/PAP-058", "PAP-058", "semantic briefing evaluator ticket"),
    ],
  };
  const result = querySemanticCandidates("workflow pressure semantic briefing", 5, index);
  assert.equal(result.reflections.length > 0, true);
  assert.equal(result.system.length > 0, true);
  assert.equal(result.reflections[0]?.metadata.section, "reflections");
});

test("semantic retrieval fixture reaches top-5 relevance for 8/10 questions", () => {
  const index: SemanticCandidateIndex = {
    version: 1,
    generated_at: "2026-05-10T00:00:00.000Z",
    documents: [
      doc("ticket", "PAP-058", "tickets/PAP-058", "PAP-058", "semantic briefing addendum candidate discovery phase two"),
      doc("reflection", "sinh-inputs/for-review/pressure.md", "sinh-inputs/for-review/pressure.md", "Pressure reflection", "sinh reflection workflow pressure intake concern", "sinh"),
      doc("deployment", "d-be7582", "deployments/d-be7582", "Deployment d-be7582", "deployment semantic briefing work pap-058"),
      doc("artifact", "agent-teams/builder/artifacts/pap-058.md", "agent-teams/builder/artifacts/pap-058.md", "Builder artifact", "builder artifact semantic evaluator orchestration report"),
      doc("session-log", "sessions/2026/05/log.md", "sessions/2026/05/log.md", "Session log", "independent evaluator pass semantic briefing"),
      doc("ticket-comment", "PAP-058#c1", "tickets/PAP-058#c1", "Ticket comment", "reflection-first ranking discussed in comment"),
      doc("doc-ref", "agent-teams/requirements/artifacts/addendum.md", "agent-teams/requirements/artifacts/addendum.md", "Addendum", "doc ref semantic candidate discovery phase"),
      doc("registry-event", "d-fail:completed", "deployments/d-fail", "Registry failed", "registry event failed partial outcomes"),
      doc("sinh-input", "sinh-inputs/ideas/intake.md", "sinh-inputs/ideas/intake.md", "Intake idea", "requirements intake personal inputs concern"),
      doc("deployment", "d-summary", "deployments/d-summary", "Deployment summary", "deployment status summary semantic briefing")
    ],
  };

  const expectations: Record<number, string> = {
    0: "tickets/PAP-058",
    1: "sinh-inputs/for-review/pressure.md",
    2: "deployments/d-be7582",
    3: "agent-teams/builder/artifacts/pap-058.md",
    4: "sessions/2026/05/log.md",
    5: "tickets/PAP-058#c1",
    6: "agent-teams/requirements/artifacts/addendum.md",
    7: "deployments/d-fail",
    8: "sinh-inputs/ideas/intake.md",
    9: "deployments/d-summary",
  };

  const questions = listSemanticFixtureQuestions();
  let hits = 0;
  for (let i = 0; i < questions.length; i++) {
    const results = querySemanticCandidates(questions[i] ?? "", 5, index);
    const topLinks = [...results.reflections, ...results.system].slice(0, 5).map((entry) => entry.metadata.link);
    if (topLinks.includes(expectations[i]!)) hits += 1;
  }
  assert.equal(hits >= 8, true);
});

test("semantic retrieval returns >=3 expected source categories for builder/evaluator workflows", () => {
  const index: SemanticCandidateIndex = {
    version: 1,
    generated_at: "2026-05-10T00:00:00.000Z",
    documents: [
      doc("ticket", "PAP-069", "tickets/PAP-069", "PAP-069", "builder implement phase semantic briefing orchestrator evaluator evidence"),
      doc("artifact", "agent-teams/builder/artifacts/phase4.md", "agent-teams/builder/artifacts/phase4.md", "Builder phase 4 artifact", "builder implement semantic briefing top-5 categories evidence"),
      doc("deployment", "d-7bc053", "deployments/d-7bc053", "Deployment d-7bc053", "builder orchestrator evaluate deployment success"),
      doc("registry-event", "d-7bc053:completed", "deployments/d-7bc053", "Registry completion", "registry event evaluator launched background"),
      doc("session-log", "sessions/2026/05/builder-log.md", "sessions/2026/05/builder-log.md", "Builder session", "semantic briefing builder implement orchestrator current context"),
      doc("doc-ref", "agent-teams/requirements/artifacts/phase4.md", "agent-teams/requirements/artifacts/phase4.md", "Requirements phase 4", "doc ref for semantic candidate discovery and evaluator context"),
      doc("ticket-comment", "PAP-069#c1", "tickets/PAP-069#c1", "Ticket comment", "phase 4 verification semantic tests complete"),
    ],
  };

  const expected = new Set(["ticket", "deployment", "artifact", "session-log", "registry-event", "doc-ref"]);
  const queries = [
    "builder implement semantic briefing",
    "orchestrator post deploy evaluate",
    "evaluator launch evidence",
    "builder current context semantic",
    "registry deployment evaluator",
    "phase semantic evidence builder",
  ];

  for (const query of queries) {
    const results = querySemanticCandidates(query, 5, index);
    const top = [...results.reflections, ...results.system].slice(0, 5);
    const categories = new Set(top.map((entry) => entry.metadata.type).filter((type) => expected.has(type)));
    assert.equal(categories.size >= 3, true, `query failed category threshold: ${query}`);
  }
});

test("candidate index build handles unreadable doc refs safely", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-semantic-"));
  const previous = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_AI_USAGE_HOME"] = root;
  try {
    const artifactDir = join(root, "agent-teams", "builder", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const unreadablePath = join(artifactDir, "unreadable.md");
    writeFileSync(unreadablePath, "blocked", "utf-8");
    chmodSync(unreadablePath, 0o000);
    const validPath = join(artifactDir, "valid.md");
    writeFileSync(validPath, "semantic evaluator note", "utf-8");

    const index = rebuildSemanticCandidateIndex();
    const unreadableDoc = index.documents.find((entry) => entry.metadata.link.endsWith("unreadable.md"));
    const validDoc = index.documents.find((entry) => entry.metadata.link.endsWith("valid.md"));

    assert.ok(unreadableDoc);
    assert.equal(unreadableDoc.content, "");
    assert.ok(validDoc);
    assert.equal(validDoc.content, "semantic evaluator note");
  } finally {
    if (previous === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
