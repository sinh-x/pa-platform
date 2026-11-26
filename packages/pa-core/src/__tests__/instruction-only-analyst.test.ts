import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeployMode, TeamConfig } from "../types.js";
import { appendRegistryEvent, closeDb, getDeploymentEvents } from "../registry/index.js";
import { repositoryIsolationSelection, assertRepositoryIsolationAvailable, assertRepositoryIsolationResumeAvailable, RepositoryIsolationUnavailableError } from "../deploy/repository-isolation.js";

const team: TeamConfig = { name: "analyst", objective: "Analyze only", agents: [] };
const mode: DeployMode = { id: "analyze", label: "Analyze", mode_type: "interactive" };
const ordinary = repositoryIsolationSelection(team, mode, { team: "analyst" }, "pi");

test("PAP-347 only resolved ordinary foreground Pi Analyst selects instruction-only execution", () => {
  assert.equal(ordinary.instructionOnly, true);
  assert.doesNotThrow(() => assertRepositoryIsolationAvailable(ordinary));
  for (const selection of [
    repositoryIsolationSelection(team, mode, { team: "analyst", background: true }, "pi"),
    repositoryIsolationSelection(team, mode, { team: "analyst", force: true }, "pi"),
    repositoryIsolationSelection(team, mode, { team: "analyst", ticketWorktree: true }, "pi"),
    repositoryIsolationSelection(team, mode, { team: "analyst", invocationChannel: "api" }, "pi"),
    repositoryIsolationSelection(team, mode, { team: "analyst" }, "opencode"),
    repositoryIsolationSelection(team, mode, { team: "alias" }, "pi"),
    repositoryIsolationSelection(team, { ...mode, id: "other" }, { team: "analyst" }, "pi"),
    repositoryIsolationSelection(team, { ...mode, document_profile: "pa-document-policy/v1" }, { team: "analyst" }, "pi"),
    repositoryIsolationSelection(team, { ...mode, capability_policy: { version: "pa-mode-capabilities/v1", allow: [] } }, { team: "analyst" }, "pi"),
    repositoryIsolationSelection(team, undefined, { team: "analyst" }, "pi"),
  ]) {
    assert.equal(selection.instructionOnly, false);
    assert.throws(() => assertRepositoryIsolationAvailable(selection), RepositoryIsolationUnavailableError);
  }
});

for (const scenario of ["ordinary", "terminal-without-mode", "binding", "note", "custody", "protected-ancestor", "cycle", "missing-ancestor", "wrong-runtime", "wrong-binary", "incomplete"]) {
  test(`PAP-347 ordinary Analyst continuation preserves native evidence: ${scenario}`, () => {
    const previous = process.env, root = mkdtempSync(join(tmpdir(), "pap347-lineage-")); closeDb();
    process.env = { ...previous, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
    try {
      const start = { deployment_id: "d-347abc", team: "analyst", mode: "analyze", event: "started" as const, timestamp: "2026-11-26T00:00:00Z", runtime: "pi" as const, binary: "ppa", repo: root, repo_root: root, worktree_root: root };
      appendRegistryEvent({ ...start,
        ...(scenario === "binding" ? { mode_capability_binding: "malformed-protection" } : {}),
        ...(scenario === "note" ? { note: "requirements-document-confirmation/v3" } : {}),
        ...(scenario === "custody" ? { repository_slot: "implement" as const } : {}),
        ...(scenario === "wrong-runtime" ? { runtime: "opencode" as const } : {}),
        ...(scenario === "wrong-binary" ? { binary: "opa" } : {}),
        ...(scenario === "incomplete" ? { repo_root: undefined } : {}),
        ...(["protected-ancestor", "missing-ancestor"].includes(scenario) ? { resumed_from_deployment_id: "d-347def" } : {}),
        ...(scenario === "cycle" ? { resumed_from_deployment_id: "d-347abc" } : {}),
      });
      if (scenario === "protected-ancestor") appendRegistryEvent({ ...start, deployment_id: "d-347def", note: "readonly-document-policy/v1" });
      if (scenario === "terminal-without-mode") appendRegistryEvent({ deployment_id: start.deployment_id, team: "analyst", event: "completed", timestamp: start.timestamp, status: "partial" });
      const before = getDeploymentEvents(start.deployment_id);
      if (scenario === "ordinary" || scenario === "terminal-without-mode") assert.doesNotThrow(() => assertRepositoryIsolationResumeAvailable(start.deployment_id, "pi", ordinary));
      else assert.throws(() => assertRepositoryIsolationResumeAvailable(start.deployment_id, "pi", ordinary), RepositoryIsolationUnavailableError);
      // No exception is available to API/OPA/raw callers without resolved context.
      assert.throws(() => assertRepositoryIsolationResumeAvailable(start.deployment_id, "pi"), RepositoryIsolationUnavailableError);
      assert.deepEqual(getDeploymentEvents(start.deployment_id), before);
    } finally { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); }
  });
}
