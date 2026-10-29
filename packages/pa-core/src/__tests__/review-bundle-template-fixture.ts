// Synthetic unsigned package data only. No real ticket, evidence, decision or run.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../templates/schema.js";
import { PACKAGE_PERMISSIONS, type ReviewBundle } from "../workflows/contracts.js";
import { templateFixture } from "./template-fixture.js";
export function reviewBundleFixture(kind: "fresh" | "amendment" = "fresh", ticket = "FIX-070") {
  const ref = (ref: string) => ({ schemaVersion: "pa-workflow-evidence-ref/v1" as const, ref, version: "r001", sha256: "a".repeat(64) });
  const requirements = ref("requirements:agent-teams/requirements/artifacts/synthetic-package.md");
  const bundle: ReviewBundle = {
    schemaVersion: "pa-review-bundle/v1", subjectId: "synthetic-package", revision: 1,
    requirements, uat: ref("uat:agent-teams/requirements/artifacts/synthetic-package-uat.md"), matrix: { ...requirements },
    repository: { key: "fixture-repo", root: "/fixture/canonical" }, ticket, route: { team: "builder", mode: "orchestrator" },
    handoff: kind === "fresh" ? { type: "fresh", branch: `feature/${ticket}-fixture`, baseSha: "b".repeat(40), branchAction: "create" }
      : { type: "amendment", branch: `feature/${ticket}-fixture`, baseSha: "b".repeat(40), featureSha: "c".repeat(40), branchAction: "reuse" },
    workflow: { id: "requirements-to-builder", version: "r001", sha256: "d".repeat(64) },
    scope: { requirements: ["FR-1"], acceptanceCriteria: ["AC-1"], files: ["src/example.ts"], directories: [], newPaths: [],
      checks: [{ matrixSource: requirements.ref, matrixSha256: requirements.sha256, commandId: "synthetic-check" }], excludedEffects: ["remote.push", "checkout.return"] },
    requestedPermissions: [...PACKAGE_PERMISSIONS],
  };
  const f = templateFixture(), source = "{{bundle}}", path = "skills/templates/review-bundle.md";
  writeFileSync(join(f.root, path), source);
  f.registry.entries.push({ id: "review-bundle", revision: "r001", purpose: "Synthetic structural package fixture", owner: "fixture/config",
    contexts: [{ runtime: "pi", team: "*", mode: "*" }], source: { path, sha256: digest(source), selector: null },
    bindings: { bundle: { type: "json", required: true } }, validation: { kind: "review-bundle", sections: [] },
    capabilities: { render: true, validate: true, reason: "Unsigned structural fixture only", authorityGate: "Real authority remains separately authenticated" } });
  return { ...f, selection: f.save(), bundle, request: { action: "render", id: "review-bundle", version: "r001", bindings: { bundle } } };
}
