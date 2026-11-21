import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendRegistryEvent, closeDb, getDb, queryReadonlyDeploymentStatus, queryReadonlyOrdinaryResume } from "../index.js";

for (const scenario of ["ordinary", "protected-ancestor", "missing-ancestor", "cycle", "ambiguous-start", "changed-roots", "malformed-start", "malformed-status"] as const) {
  test(`PAP-329 ordinary resume reads raw original lineage: ${scenario}`, () => {
    const prior = { ...process.env }, root = mkdtempSync(join(tmpdir(), "pap329-resume-")), path = join(root, "registry.db");
    closeDb();
    try {
      process.env.PA_REGISTRY_DB = path;
      process.env.PA_AI_USAGE_HOME = root;
      const start = (id: string, parent?: string) => appendRegistryEvent({
        deployment_id: id, team: "builder", mode: "implement", event: "started", timestamp: "2026-11-21T09:00:00Z",
        runtime: "pi", binary: "ppa", repo: "/fixture/repo", repo_root: "/fixture/repo", worktree_root: "/fixture/repo", ticket_id: "EX-1",
        ...(parent ? { resumed_from_deployment_id: parent } : {}),
      });
      start("d-329001"); start("d-329002", "d-329001"); start("d-329003", "d-329002");
      const db = getDb();
      // Deliberately corrupt only this disposable registry. No operator data is used.
      if (scenario === "protected-ancestor") db.prepare("UPDATE registry_events SET note = 'requirements-document/v1' WHERE deployment_id = 'd-329001'").run();
      if (scenario === "missing-ancestor") {
        db.prepare("DELETE FROM registry_events WHERE deployment_id = 'd-329001'").run();
        db.prepare("DELETE FROM deployments WHERE deployment_id = 'd-329001'").run();
      }
      if (scenario === "cycle") {
        db.prepare("UPDATE registry_events SET resumed_from_deployment_id = 'd-329003' WHERE deployment_id = 'd-329001'").run();
        db.prepare("UPDATE deployments SET resumed_from_deployment_id = 'd-329003' WHERE deployment_id = 'd-329001'").run();
      }
      if (scenario === "ambiguous-start") db.prepare("INSERT INTO registry_events (deployment_id, team, event, timestamp) VALUES ('d-329001', 'builder', 'started', '2026-11-21T09:01:00Z')").run();
      if (scenario === "changed-roots") db.prepare("UPDATE deployments SET worktree_root = '/other/repo' WHERE deployment_id = 'd-329001'").run();
      if (scenario === "malformed-start") db.prepare("UPDATE registry_events SET builder_authority = 'orchestrator' WHERE deployment_id = 'd-329001'").run();
      if (scenario === "malformed-status") {
        db.prepare("UPDATE deployments SET builder_authority = 'orchestrator' WHERE deployment_id = 'd-329001'").run();
        assert.equal(queryReadonlyDeploymentStatus("d-329001", true)?.builder_authority, undefined, "display projection omits malformed custody");
      }
      closeDb();
      const before = readFileSync(path), files = readdirSync(root).sort();
      if (scenario === "ordinary") assert.equal(queryReadonlyOrdinaryResume("d-329003").deploy_id, "d-329003");
      else assert.throws(() => queryReadonlyOrdinaryResume("d-329003"));
      assert.deepEqual(readFileSync(path), before);
      assert.deepEqual(readdirSync(root).sort(), files);
    } finally { closeDb(); process.env = prior; rmSync(root, { recursive: true, force: true }); }
  });
}
