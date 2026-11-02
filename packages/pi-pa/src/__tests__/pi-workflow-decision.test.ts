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
  let reads = 0; const views: string[] = [];
  const capture = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async (title, choices) => { views.push(title); return choices[0]; } } }, () => { reads++; return caller; });
  const result = await capture(request);
  assert.equal(reads, 2); assert.equal(result.outcome, "approved"); assert.match(result.principal, /^local-uid:/);
  const displayed = views.join("\n"); assert.match(displayed, /review the exact implementation plan/); assert.doesNotMatch(displayed, /"schemaVersion"/);
  for (const value of [subject.requirements.ref, subject.uat.ref, subject.handoff.baseSha, subject.handoff.branch, request.subjectSha256, ...subject.scope.files, ...subject.requestedPermissions, ...subject.scope.excludedEffects]) assert.ok(displayed.includes(value), value);
  for (const view of views.slice(0, -1)) { assert.ok(view.split("\n").length <= 10); assert.ok(view.split("\n").slice(1).every(line => line.length <= 72)); }
  assert.match(result.evidence.ref, /^native-workflow-capture:/); assert.equal(result.evidence.version, "v2");
});
test("nonforeground, stale caller, cancellation and explicit named revoke stay distinct", async () => {
  for (const mode of ["rpc", "json", "print"] as const) await assert.rejects(createPiWorkflowCapture({ mode, cwd: "/canonical/example" }, () => caller)(request), /WORKFLOW_AUTHORITY/);
  let reads = 0;
  const stale = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async (_title, choices) => choices[0] } }, () => ++reads === 1 ? caller : { ...caller, identitySha256: "b".repeat(64) });
  await assert.rejects(stale(request), /WORKFLOW_CONFLICT/);
  const cancelled = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async () => undefined } }, () => caller);
  assert.equal((await cancelled(request)).outcome, "cancelled");
  const revokeViews: string[] = [];
  const revoke = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async (title, choices) => { revokeViews.push(title); return choices[0]; } } }, () => caller);
  assert.equal((await revoke({ ...request, action: "revoke", decisionId: "decision-original" })).outcome, "approved");
  assert.match(revokeViews.join("\n"), /decision-original/);
});
test("review cannot approve before every scope page, technical details are optional, and final outcomes stay distinct", async () => {
  for (const [choice, outcome] of [["Reject exact package", "rejected"], ["Request changes", "changes-requested"], ["Cancel", "cancelled"]] as const) {
    let pages = 0;
    const result = await createPiWorkflowCapture({ mode: "tui", cwd: caller.repoRoot, ui: { select: async (_title, choices) => {
      if (choices.includes("Continue review")) { pages++; assert.equal(choices.some(c => c.startsWith("Approve")), false); return "Continue review"; }
      return choice;
    } } }, () => caller)(request);
    assert.ok(pages > 1); assert.equal(result.outcome, outcome);
  }
  let technical = false, finalQuestions = 0;
  const result = await createPiWorkflowCapture({ mode: "tui", cwd: caller.repoRoot, ui: { select: async (title, choices) => {
    if (choices.includes("Continue review")) { if (title.startsWith("Technical bindings")) technical = true; return "Continue review"; }
    return finalQuestions++ === 0 ? "View exact technical bindings" : choices[0];
  } } }, () => caller)(request);
  assert.equal(result.outcome, "approved"); assert.equal(technical, true); assert.equal(finalQuestions, 2);
  let calls = 0;
  const cancelled = await createPiWorkflowCapture({ mode: "tui", cwd: caller.repoRoot, ui: { select: async () => { calls++; return "Cancel"; } } }, () => caller)(request);
  assert.equal(cancelled.outcome, "cancelled"); assert.equal(calls, 1);
});

test("cancelled recovery explicitly presents the prior decision and requires a new foreground response", async () => {
  const views: string[] = [];
  const capture = createPiWorkflowCapture({ mode: "tui", cwd: caller.repoRoot, ui: { select: async (title, choices) => { views.push(title); return choices[0]; } } }, () => caller);
  const recovered = await capture({ ...request, action: "recover", revision: 2, decisionId: "decision-cancelled" });
  assert.equal(recovered.outcome, "approved"); assert.match(views[0]!, /Resume cancelled/); assert.match(views.join("\n"), /decision-cancelled/);
  assert.match(views.join("\n"), /Previous cancellation stays\s+in history/);
  const cancelled = await createPiWorkflowCapture({ mode: "tui", cwd: caller.repoRoot, ui: { select: async () => undefined } }, () => caller)({ ...request, action: "recover", decisionId: "decision-cancelled" });
  assert.equal(cancelled.outcome, "cancelled");
});

test("aborted native review cannot issue authority before opening or after a final approve response", async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(createPiWorkflowCapture({ mode: "tui", cwd: caller.repoRoot, ui: { select: async () => { assert.fail("must not open aborted review"); } } }, () => caller, before.signal)(request), /cancelled-native-request/);
  const during = new AbortController();
  await assert.rejects(createPiWorkflowCapture({ mode: "tui", cwd: caller.repoRoot, ui: { select: async (_title, choices, options) => {
    assert.equal(options?.signal, during.signal);
    if (choices[0]?.startsWith("Approve")) during.abort();
    return choices[0];
  } } }, () => caller, during.signal)(request), /cancelled-native-request/);
});

test("readable primary review lists every finite check without repeating raw matrix hashes", async () => {
  const scope = { ...subject.scope, checks: Array.from({ length: 9 }, (_, i) => ({ matrixSource: subject.matrix.ref, matrixSha256: subject.matrix.sha256, commandId: `command-${i}` })) };
  const views: string[] = [];
  await createPiWorkflowCapture({ mode: "tui", cwd: caller.repoRoot, ui: { select: async (title, choices) => { views.push(title); return choices[0]; } } }, () => caller)({ ...request, subject: { ...subject, scope } });
  const primary = views.join("\n");
  for (const check of scope.checks) assert.ok(primary.includes(check.commandId));
  assert.equal(primary.includes(subject.matrix.sha256), false); assert.ok(primary.includes(request.subjectSha256));
  assert.ok(primary.includes(subject.matrix.ref)); assert.match(primary, /technical details/);
});

test("oversized native requests are refused, not truncated into a partial approval", async () => {
  const capture = createPiWorkflowCapture({ mode: "tui", cwd: "/canonical/example", ui: { select: async () => { throw new Error("must not open"); } } }, () => caller);
  await assert.rejects(capture({ ...request, subject: { ...subject, scope: { ...subject.scope, files: ["x".repeat(65_536)] } } }), /WORKFLOW_CONTRACT/);
});
