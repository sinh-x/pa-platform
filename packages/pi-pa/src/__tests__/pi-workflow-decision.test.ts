import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewBundle, WorkflowCaller } from "@pa-platform/pa-core";
import { createPiWorkflowCapture } from "../workflow-native.js";
const caller: WorkflowCaller = { deploymentId: "d-abcdef", repoKey: "example", repoRoot: "/canonical/example", ticket: "EX-1", team: "requirements", mode: "analyze", identitySha256: "a".repeat(64) };
const subject: ReviewBundle = { schemaVersion: "pa-review-bundle/v1", subjectId: "synthetic-package", revision: 1,
  requirements: { schemaVersion: "pa-workflow-evidence-ref/v1", ref: "requirements:example.md", version: "r001", sha256: "a".repeat(64) },
  uat: { schemaVersion: "pa-workflow-evidence-ref/v1", ref: "uat:example.md", version: "r001", sha256: "b".repeat(64) },
  matrix: { schemaVersion: "pa-workflow-evidence-ref/v1", ref: "requirements:example.md", version: "r001", sha256: "c".repeat(64) },
  repository: { key: "example", root: "/canonical/example" }, ticket: "EX-1", route: { team: "builder", mode: "orchestrator" },
  handoff: { type: "fresh", baseSha: "d".repeat(40), branch: "feature/EX-1-example", branchAction: "create" }, workflow: { id: "software", version: "r001", sha256: "e".repeat(64) },
  scope: { requirements: ["FR-01"], acceptanceCriteria: ["AC-01"], files: ["src/example.ts"], directories: [], newPaths: [], checks: [], excludedEffects: ["remote.push", "checkout.return"] },
  requestedPermissions: ["artifact.publish-pair", "ticket.queue.advance", "source.edit-scoped", "check.execute-scoped", "repair.same-scope", "git.commit-local"] };
const request = { action: "package" as const, runId: "wf-synthetic", revision: 1, subject, subjectSha256: "f".repeat(64) };
test("synthetic UI fixture displays exact subject/permissions; outcome and principal are not model inputs", async () => {
  let reads = 0; let view = "";
  const capture = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async (title, choices) => { view = title; return choices[0]; } } }, () => { reads++; return caller; });
  const result = await capture(request);
  assert.equal(reads, 2); assert.equal(result.outcome, "approved"); assert.match(result.principal, /^local-uid:/);
  const displayed = JSON.parse(view); assert.deepEqual(displayed.subject, subject); assert.equal(displayed.subjectSha256, request.subjectSha256);
  assert.match(result.evidence.ref, /^native-workflow-capture:/);
});
test("nonforeground, stale caller, cancellation and explicit named revoke stay distinct", async () => {
  for (const mode of ["rpc", "json", "print"] as const) await assert.rejects(createPiWorkflowCapture({ mode, cwd: "/canonical/example" }, () => caller)(request), /WORKFLOW_AUTHORITY/);
  let reads = 0;
  const stale = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async (_title, choices) => choices[0] } }, () => ++reads === 1 ? caller : { ...caller, identitySha256: "b".repeat(64) });
  await assert.rejects(stale(request), /WORKFLOW_CONFLICT/);
  const cancelled = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async () => undefined } }, () => caller);
  assert.equal((await cancelled(request)).outcome, "cancelled");
  const revoke = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async (title, choices) => { assert.match(title, /decision-original/); return choices[0]; } } }, () => caller);
  assert.equal((await revoke({ ...request, action: "revoke", decisionId: "decision-original" })).outcome, "approved");
});
test("oversized native requests are refused, not truncated into a partial approval", async () => {
  const capture = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async () => { throw new Error("must not open"); } } }, () => caller);
  await assert.rejects(capture({ ...request, subject: { ...subject, scope: { ...subject.scope, files: ["x".repeat(65_536)] } } }), /WORKFLOW_CONTRACT/);
});
