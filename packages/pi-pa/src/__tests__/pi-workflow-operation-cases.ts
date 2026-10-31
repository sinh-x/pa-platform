import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionCustodyService, ProtectedWorkflowStore, parseExecutionBinding, parseExecutionPlan, workflowDigest, type ExecutionHolder, type ExecutionHost } from "@pa-platform/pa-core";
import { NativeExecutionEvidence } from "../native-execution-evidence.js";
import { readPiSourceOperation } from "../workflow-source.js";

// Actor/provenance verification only. Synthetic host and tool payloads are NOT
// real execution, native restart admission, source progression or human capture.
const owner: ExecutionHolder = { deploymentId: "d-aaaaaa", process: { pid: 100, startTimeTicks: "10", bootId: "fixture" } };
const next: ExecutionHolder = { deploymentId: "d-bbbbbb", process: { pid: 200, startTimeTicks: "20", bootId: "fixture" } };
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap271-operation-proof-"));
  try { run(setup(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  const time = "2026-10-30T00:00:00.000Z", sha = "a".repeat(40), source = { ref: "fixture:handover", version: "v1", sha256: workflowDigest("handover") };
  const binding = parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: "b".repeat(64), lineageId: owner.deploymentId,
    repoKey: "fixture", repoRoot: "/fixture/repo", worktreeRoot: "/fixture/linked", ticket: "PAP-271", branch: "feature/PAP-271-fixture", initialHeadSha: sha, owner,
    bounds: { startedAt: time, deadlineAt: "2026-10-30T02:00:00.000Z", runtimeMinutes: 120, consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null } });
  const locks = { repository: <T>(run: () => T) => run(), worktree: <T>(run: () => T) => run() }, store = new ProtectedWorkflowStore(root);
  const evidence = new NativeExecutionEvidence(store, root, locks);
  const host: ExecutionHost = { locks, authorize() {}, assertLive() {}, verifyEvidence() {}, assertHandover() {}, assertRestart() {}, now: () => time };
  const service = new ExecutionCustodyService(store, binding, host); service.initialize(owner);
  service.apply(owner, { action: "plan", plan: parseExecutionPlan({ phaseId: "source", scope: "proof fixture", paths: ["file.ts"], requirements: ["AC-15"], prerequisites: [], checks: ["check"], size: "bounded", complexity: "restart", rationale: "Keep exact operation actors." }) });
  service.apply(owner, { action: "select", executor: "orchestrator-direct", holder: owner, handover: source });
  const payload = (id: string, actor: ExecutionHolder) => ({ executionId: service.executionId, actor, operationId: id, toolName: "bash", inputSha256: workflowDigest(id), command: "fixture-check", before: {} });
  const result = (intent: unknown) => evidence.publish("tool-result", { intent, after: {}, process: null, exitCode: 0, scopeValid: true, error: null, settlementError: null, sdkError: null, unprovenProcess: null });
  const operation = (id: string, actor: ExecutionHolder, options: { reportedActor?: ExecutionHolder; reportedId?: string; foreignIntent?: boolean; finish?: boolean } = {}) => {
    const intent = evidence.publish("tool-intent", payload(options.reportedId ?? id, options.reportedActor ?? actor));
    const registered = options.foreignIntent ? evidence.publish("tool-intent", payload(`foreign-${id}`, actor)) : intent;
    service.apply(actor, { action: "begin", operation: { id, kind: "check", check: "check", intent: registered } });
    const proof = result(intent);
    if (options.finish !== false) service.apply(actor, { action: "finish", operationId: id, evidence: proof, failure: null });
    return proof;
  };
  const restart = () => service.restart(next, service.status(owner).sequence, source);
  const files = () => store.records().map(name => [name, readFileSync(join(root, name), "utf8")]);
  return { store, binding, evidence, service, operation, restart, files, result, payload };
}

test("source operation proof accepts exact historical/successor actors, not the latest holder projected backwards", () => fixture(f => {
  const original = f.operation("original", owner); f.restart(); const successor = f.operation("successor", next), files = f.files();
  assert.deepEqual(readPiSourceOperation(f.store, f.evidence, f.binding, original).intent.actor, owner);
  assert.deepEqual(readPiSourceOperation(f.store, f.evidence, f.binding, successor).intent.actor, next);
  assert.deepEqual(f.binding.owner, owner); assert.deepEqual(f.files(), files);
}));

for (const kind of ["retired", "latest-over-history", "wrong-id", "foreign-intent", "unfinished", "unissued"] as const) {
  test(`source operation proof rejects ${kind} payload despite a protected native-evidence envelope`, () => fixture(f => {
    if (kind === "retired") f.restart();
    const proof = kind === "unissued" ? f.result(f.evidence.publish("tool-intent", f.payload("unissued", owner)))
      : f.operation("operation", kind === "retired" ? next : owner, {
        reportedActor: kind === "retired" ? owner : kind === "latest-over-history" ? next : undefined,
        reportedId: kind === "wrong-id" ? "foreign-operation" : undefined,
        foreignIntent: kind === "foreign-intent", finish: kind !== "unfinished",
      });
    if (kind === "latest-over-history") f.restart();
    const files = f.files(); assert.throws(() => readPiSourceOperation(f.store, f.evidence, f.binding, proof)); assert.deepEqual(f.files(), files);
  }));
}

test("source operation proof rejects reused result refs across operations and foreign bindings", () => fixture(f => {
  const proof = f.operation("original", owner);
  f.service.apply(owner, { action: "begin", operation: { id: "reused", kind: "check", check: "check", intent: null } });
  f.service.apply(owner, { action: "finish", operationId: "reused", evidence: proof, failure: null });
  assert.throws(() => readPiSourceOperation(f.store, f.evidence, f.binding, proof));
  assert.throws(() => readPiSourceOperation(f.store, f.evidence, { ...f.binding, lineageId: "foreign-lineage" }, proof));
}));
