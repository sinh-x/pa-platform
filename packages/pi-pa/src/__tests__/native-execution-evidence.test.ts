import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProtectedWorkflowStore, workflowDigest } from "@pa-platform/pa-core";
import { NativeExecutionEvidence, NativeProcessEvidenceError, nativePublicText, runNativeExecutionProcess } from "../native-execution-evidence.js";

async function fixture(run: (evidence: NativeExecutionEvidence, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pap256-native-process-"));
  try { await run(new NativeExecutionEvidence(new ProtectedWorkflowStore(root), root, { repository: (action) => action(), worktree: (action) => action() }), root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const intent = (evidence: NativeExecutionEvidence) => evidence.publish("test-intent", { purpose: "isolated native backend test; not source authority" });

test("native frame precedes execution; exact stdout/stderr and exit defeat printed success claims", () => fixture(async (evidence, root) => {
  const source = intent(evidence);
  const result = await runNativeExecutionProcess({ evidence, intent: source, command: "printf 'exitCode=0 PASS'; printf 'actual stderr' >&2; exit 7", cwd: root, timeoutSeconds: 5 });
  assert.equal(result.exitCode, 7); assert.equal(result.groupSettled, true);
  assert.equal(evidence.blob(result.stdout).toString(), "exitCode=0 PASS"); assert.equal(evidence.blob(result.stderr).toString(), "actual stderr");
  const frame = evidence.read(result.frame, "process-frame") as { intent: unknown; groupId: number; process: { pid: number } };
  assert.deepEqual(frame.intent, source); assert.equal(frame.groupId, frame.process.pid);
  assert.throws(() => evidence.read({ ...result.frame, sha256: workflowDigest("forged") }, "process-frame"));
  assert.throws(() => evidence.blob({ ...result.stdout, name: "../../outside" }));
  assert.equal((readFileSync(join(root, result.stdout.name)).length), result.stdout.bytes);
}));

test("frame publication failure never releases the command and durably retains the original native error", () => fixture(async (evidence, root) => {
  const publish = evidence.publish.bind(evidence);
  evidence.publish = (kind, payload) => { if (kind === "process-frame") throw new Error("isolated injected frame persistence failure"); return publish(kind, payload); };
  try {
    await runNativeExecutionProcess({ evidence, intent: intent(evidence), command: "printf forbidden > never-run.txt", cwd: root, timeoutSeconds: 5 });
    assert.fail("missing frame must stop before command dispatch");
  } catch (error) {
    assert.ok(error instanceof NativeProcessEvidenceError);
    const raw = evidence.read(error.evidence, "process-unproven") as { groupSettled: boolean; stderr: Parameters<typeof evidence.blob>[0] };
    assert.equal(raw.groupSettled, false); assert.match(evidence.blob(raw.stderr).toString(), /isolated injected frame persistence failure/);
  }
  assert.equal(existsSync(join(root, "never-run.txt")), false);
}));

test("native timeout kills the recorded session/group, not a freshly sampled unrelated PID", () => fixture(async (evidence, root) => {
  const result = await runNativeExecutionProcess({ evidence, intent: intent(evidence), command: "sleep 10", cwd: root, timeoutSeconds: 0.05 });
  assert.equal(result.timedOut, true); assert.equal(result.groupSettled, true); assert.notEqual(result.exitCode, 0);
}));

test("native abort is retained separately from timeout and never converted to success", () => fixture(async (evidence, root) => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 40);
  try {
    const result = await runNativeExecutionProcess({ evidence, intent: intent(evidence), command: "sleep 10", cwd: root, timeoutSeconds: 5, signal: controller.signal });
    assert.equal(result.aborted, true); assert.equal(result.timedOut, false); assert.equal(result.groupSettled, true);
  } finally { clearTimeout(timer); }
}));

test("remaining background group members make the result unproven even after leader exit zero", () => fixture(async (evidence, root) => {
  const result = await runNativeExecutionProcess({ evidence, intent: intent(evidence), command: "sleep 10 >/dev/null 2>&1 & printf done; exit 0", cwd: root, timeoutSeconds: 5 });
  assert.equal(result.exitCode, 0); assert.equal(result.groupSettled, false);
  assert.equal(evidence.blob(result.stdout).toString(), "done");
}));

test("bounded output retains exact captured prefix and a distinct limit flag, never a passing check", () => fixture(async (evidence, root) => {
  const result = await runNativeExecutionProcess({ evidence, intent: intent(evidence), command: "printf '%0512d' 1", cwd: root, timeoutSeconds: 5, maximumOutputBytes: 256 });
  assert.equal(result.outputLimitExceeded, true); assert.equal(result.stdout.bytes, 256);
  assert.equal(evidence.blob(result.stdout).length, 256);
}));

test("whole-buffer public redaction leaves raw native bytes intact and withholds private-key bodies", () => {
  const secret = "native-private-cross-chunk-fixture";
  assert.equal(nativePublicText(`before ${secret} after`, [secret]), "before [REDACTED] after");
  const text = nativePublicText("-----BEGIN PRIVATE KEY-----\nNEVER-PUBLISH-THIS-BODY\n-----END PRIVATE KEY-----", []);
  assert.doesNotMatch(text, /NEVER-PUBLISH/); assert.match(text, /withheld/);
});
