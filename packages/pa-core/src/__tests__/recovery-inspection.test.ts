import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeExecutionEvidence } from "../operations/evidence.js";
import { inspectRetainedAdvisoryOperation, inspectRetainedProcess } from "../operations/recovery-inspection.js";
import { ProtectedWorkflowStore, workflowDigest } from "../deploy/prepared-workflow.js";
import { readProcessFingerprint, type RepositoryMutationLease } from "../deploy/repository-admission.js";
import { getDeployPaths } from "../deploy/paths.js";
for (const key of Object.keys(process.env)) if (key.startsWith("PA_") && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
const sandbox = mkdtempSync(join(tmpdir(), "pa-recovery-inspection-"));
process.env.PA_AI_USAGE_HOME = sandbox;
test.after(() => rmSync(sandbox, { recursive: true, force: true }));
let sequence = 0;
function fixture(settled = false, publishResult = true) {
  const deploymentId = `d-${(++sequence).toString(16).padStart(6, "0")}`;
  const deploymentDirectory = getDeployPaths(deploymentId).deployDir;
  const root = join(deploymentDirectory, "operation-evidence"); mkdirSync(root, { recursive: true, mode: 0o700 });
  const evidence = new NativeExecutionEvidence(new ProtectedWorkflowStore(root), root, { repository: run => run(), worktree: run => run() });
  const operationId = "op-11111111-1111-4111-8111-111111111111", command = "sleep 1";
  const cwd = join(sandbox, "checkout");
  const intent = evidence.publish("advisory-operation-intent", { operationId, command, deploymentId, cwd });
  const process = readProcessFingerprint(globalThis.process.pid)!;
  const frame = evidence.publish("process-frame", { intent, process, groupId: process.pid, sessionId: process.pid,
    executable: "/fixture/bash", command, cwd, program: null, environment: {} });
  const facts = { frame, stdout: {}, stderr: {}, exitCode: null, signal: "SIGTERM", timedOut: true, aborted: false, outputLimitExceeded: false, groupSettled: settled };
  const result = publishResult ? evidence.publish("advisory-process-result", { operationId, intent, command, process: facts }) : undefined;
  const lease = { deploymentId, deploymentDirectory, worktreeRoot: cwd, canonicalRepoRoot: cwd,
    advisoryOperation: { id: operationId, caller: process, inputSha256: workflowDigest(command), intentRef: intent.ref } } as RepositoryMutationLease;
  return { root, evidence, intent, frame, facts, result, lease };
}
function snapshot(root: string) {
  return readdirSync(root).sort().map(name => { const path = join(root, name), stat = statSync(path); return [name, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, readFileSync(path).toString("base64")]; });
}
test("timeout with unknown cleanup stays unknown even with a fresh process observation", () => {
  const f = fixture(); const before = snapshot(f.root);
  const result = inspectRetainedAdvisoryOperation(f.lease);
  assert.equal(result.state, "unknown"); assert.equal(result.cause, "native-cleanup-unknown");
  assert.equal(result.tracking, "process-group-only"); assert.equal(result.timedOut, true); assert.equal(result.exitCode, null);
  assert.equal(result.caller, "live"); assert.equal(result.leader, "live");
  assert.deepEqual(snapshot(f.root), before);
  assert.doesNotMatch(JSON.stringify(result), /sleep|startTimeTicks|bootId|ownershipToken|stdout|command|checkout/);
});
test("native settled cleanup is a separate fact, never a passing check or reclaim grant", () => {
  const f = fixture(true), before = snapshot(f.root), result = inspectRetainedAdvisoryOperation(f.lease);
  assert.equal(result.state, "settled"); assert.equal(result.timedOut, true); assert.equal(result.exitCode, null);
  assert.equal(result.leader, "live"); assert.equal("eligible" in result, false); assert.equal("authority" in result, false);
  assert.deepEqual(snapshot(f.root), before);
});
test("missing result, missing directory and no operation are distinct without initialization", () => {
  const f = fixture(false, false), before = snapshot(f.root);
  assert.equal(inspectRetainedAdvisoryOperation(f.lease).cause, "result-missing"); assert.deepEqual(snapshot(f.root), before);
  rmSync(f.root, { recursive: true });
  assert.equal(inspectRetainedAdvisoryOperation(f.lease).state, "unavailable");
  assert.throws(() => statSync(f.root));
  assert.deepEqual(inspectRetainedAdvisoryOperation({} as RepositoryMutationLease), { state: "absent", cause: "no-operation" });
});
test("conflicting result, substituted intent and unprotected or aliased evidence fail closed", () => {
  for (const change of ["intent", "duplicate", "bytes", "mode", "symlink", "hardlink", "oversized"] as const) {
    const f = fixture(); const path = join(f.root, `${f.result!.sha256}.intent.json`);
    if (change === "intent") f.lease = { ...f.lease, advisoryOperation: { ...f.lease.advisoryOperation!, inputSha256: "0".repeat(64) } };
    if (change === "duplicate") f.evidence.publish("advisory-process-result", { operationId: f.lease.advisoryOperation!.id, intent: f.intent, command: "sleep 1", process: { ...f.facts, groupSettled: true } });
    if (change === "bytes") writeFileSync(path, "{}", { mode: 0o600 });
    if (change === "mode") chmodSync(path, 0o644);
    if (change === "symlink") { const original = readFileSync(path); rmSync(path); writeFileSync(join(sandbox, "symlink-target"), original, { mode: 0o600 }); symlinkSync(join(sandbox, "symlink-target"), path); }
    if (change === "hardlink") linkSync(path, join(f.root, "alias"));
    if (change === "oversized") writeFileSync(path, "x".repeat(2 * 1024 * 1024));
    const before = snapshot(f.root);
    assert.deepEqual(inspectRetainedAdvisoryOperation(f.lease), { state: "unavailable", cause: "evidence-invalid" }, change);
    assert.deepEqual(snapshot(f.root), before);
  }
});
test("process incarnation reuse is distinct from liveness and absent PID observation", () => {
  const current = readProcessFingerprint(process.pid)!;
  assert.equal(inspectRetainedProcess(current), "live");
  assert.equal(inspectRetainedProcess({ ...current, startTimeTicks: String(BigInt(current.startTimeTicks) + 1n) }), "reused");
});
