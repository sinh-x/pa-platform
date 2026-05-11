import test from "node:test";
import assert from "node:assert/strict";
import { buildSemanticSourceMetadata, createSemanticSourceId, isApprovedSemanticPath, listApprovedSemanticSourceRoots } from "../semantic/index.js";

test("semantic source ids are stable for approved source types", () => {
  const ticketId = createSemanticSourceId({ type: "ticket", locator: "PAP-058" });
  const ticketIdAgain = createSemanticSourceId({ type: "ticket", locator: "pap-058" });
  const artifactId = createSemanticSourceId({ type: "artifact", locator: "agent-teams/builder/artifacts/2026-05-10-report.md" });
  assert.equal(ticketId, ticketIdAgain);
  assert.notEqual(ticketId, artifactId);
});

test("semantic source metadata marks Sinh reflections as reflection-first", () => {
  const reflection = buildSemanticSourceMetadata({
    type: "reflection",
    locator: "sinh-inputs/for-review/2026-05-10-reflection.md",
    link: "sinh-inputs/for-review/2026-05-10-reflection.md",
    authoredBy: "sinh",
  });
  const systemArtifact = buildSemanticSourceMetadata({
    type: "artifact",
    locator: "agent-teams/builder/artifacts/2026-05-10-report.md",
    link: "agent-teams/builder/artifacts/2026-05-10-report.md",
  });
  assert.equal(reflection.reflection_first, true);
  assert.equal(reflection.section, "reflections");
  assert.equal(systemArtifact.reflection_first, false);
  assert.equal(systemArtifact.section, "system");
});

test("approved semantic paths are constrained to scoped roots", () => {
  const roots = listApprovedSemanticSourceRoots();
  assert.equal(roots.length > 0, true);
  assert.equal(isApprovedSemanticPath("/home/sinh/.ssh/id_rsa"), false);
  assert.equal(isApprovedSemanticPath("/home/sinh/.config/opencode/config.json"), false);
});
