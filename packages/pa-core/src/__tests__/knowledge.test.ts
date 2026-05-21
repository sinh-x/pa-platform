import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEvaluatorResult, appendRegistryEvent, closeDb, listImprovementCandidates, listKnowledgeBoundaries } from "../index.js";

test("knowledge boundaries map each item type once", () => {
  const boundaries = listKnowledgeBoundaries();
  assert.equal(boundaries.length, 8);
  const unique = new Set(boundaries.map((item) => item.itemType));
  assert.equal(unique.size, 8);
  for (const boundary of boundaries) {
    assert.ok(boundary.primaryPurpose.length > 0);
    assert.ok(boundary.storageLocation.length > 0);
  }
});

test("improvement candidates extract from session logs and evaluator rows with dedupe", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-knowledge-"));
  const prevAiUsage = process.env["PA_AI_USAGE_HOME"];
  const prevRegistry = process.env["PA_REGISTRY_DB"];
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_REGISTRY_DB"] = join(root, "deployments", "registry.db");
  try {
    mkdirSync(join(root, "sessions", "2026", "05", "agent-team"), { recursive: true });
    writeFileSync(join(root, "sessions", "2026", "05", "agent-team", "log.md"), [
      "# AI Session Log",
      "> Agent: builder/team-manager",
      "",
      "## Self-Improvement",
      "### What could be improved?",
      "- tighten parser edge cases",
      "",
      "## Follow-up Tasks",
      "- [ ] PAP-432 implement parser hardening",
    ].join("\n"));

    appendRegistryEvent({ deployment_id: "d-1", team: "builder", event: "started", timestamp: "2026-05-21T00:00:00.000Z" });
    appendRegistryEvent({ deployment_id: "d-e1", team: "evaluator", event: "started", timestamp: "2026-05-21T00:00:30.000Z" });
    appendEvaluatorResult({
      target_deployment_id: "d-1",
      evaluator_deployment_id: "d-e1",
      summary: "finding summary",
      findings: "missing route coverage\nmissing route coverage",
      evidence_refs: ["deployments/d-1/primer.md"],
      rating: { source: "system", overall: 3, metrics: { quality: 3 } },
    });

    const candidates = listImprovementCandidates();
    assert.equal(candidates.some((item) => item.sourceType === "session-log"), true);
    assert.equal(candidates.some((item) => item.sourceType === "evaluator-artifact"), true);
    assert.equal(candidates.every((item) => item.status === "new" && item.decision === "pending"), true);
    const uniqueIds = new Set(candidates.map((item) => item.id));
    assert.equal(uniqueIds.size, candidates.length);
  } finally {
    closeDb();
    if (prevAiUsage === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = prevAiUsage;
    if (prevRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = prevRegistry;
    rmSync(root, { recursive: true, force: true });
  }
});
