import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendRegistryEvent, closeDb, queryEvaluatorResultsByTargetDeployment, runEvaluatorPass } from "../index.js";

test("evaluator pass collects evidence and marks missing entries", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-evaluator-"));
  const previousAiUsage = process.env["PA_AI_USAGE_HOME"];
  const previousDb = process.env["PA_REGISTRY_DB"];
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_REGISTRY_DB"] = join(root, "deployments", "registry.db");
  try {
    mkdirSync(join(root, "deployments", "d-target"), { recursive: true });
    writeFileSync(join(root, "deployments", "d-target", "primer.md"), "# Primer");
    writeFileSync(join(root, "deployments", "d-target", "activity.jsonl"), "{}\n");
    appendRegistryEvent({ deployment_id: "d-target", team: "builder", event: "started", timestamp: "2026-05-10T09:00:00Z", ticket_id: "PAP-058", objective: "Evaluate deployment", primer: "deployments/d-target/primer.md" });
    appendRegistryEvent({ deployment_id: "d-target", team: "builder", event: "completed", timestamp: "2026-05-10T09:05:00Z", status: "success", rating: { source: "agent", overall: 4 } });
    appendRegistryEvent({ deployment_id: "d-eval", team: "builder", event: "started", timestamp: "2026-05-10T09:10:00Z" });

    const result = runEvaluatorPass("d-target", "d-eval");
    assert.equal(result.target_deployment_id, "d-target");
    assert.equal(result.evaluator_deployment_id, "d-eval");
    assert.equal(result.rating.metrics.human_agency !== undefined, true);
    assert.equal(result.evidence_refs.some((ref) => ref.startsWith("missing:")), true);

    const saved = queryEvaluatorResultsByTargetDeployment("d-target");
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.evaluator_deployment_id, "d-eval");
  } finally {
    closeDb();
    if (previousAiUsage === undefined) delete process.env["PA_AI_USAGE_HOME"]; else process.env["PA_AI_USAGE_HOME"] = previousAiUsage;
    if (previousDb === undefined) delete process.env["PA_REGISTRY_DB"]; else process.env["PA_REGISTRY_DB"] = previousDb;
    rmSync(root, { recursive: true, force: true });
  }
});
