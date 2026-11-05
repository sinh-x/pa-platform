import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeExecutionEvidence, ProtectedWorkflowStore, runCoreCommand, parseOperationResult, type AdvisoryOperationHost } from "@pa-platform/pa-core";

test("actual OPA/PPA CLI dispatch shares neutral executor and result exits without native-parity claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap277-opa-"));
  try {
    const evidence = new NativeExecutionEvidence(new ProtectedWorkflowStore(root), root, { repository: f => f(), worktree: f => f() });
    const host: AdvisoryOperationHost = { runtime: "opencode", cwd: root, evidence, privateValues: [], begin: (id, command) => evidence.publish("test-intent", { id, command }), finish: () => {} };
    let output = "";
    const call = async (args: string[], managed = true) => { output = ""; return runCoreCommand(["operation", ...args, "--format", "pa-operation-result/v1"], { binaryName: "opa", operationHost: managed ? host : null, io: { stdout: s => { output += s; }, stderr: s => { throw new Error(s); } } }); };
    assert.equal(await call(["run", "--command", "exit 19"]), 1);
    const failed = parseOperationResult(output); assert.equal(failed.process?.exitCode, 19); assert.equal(failed.outcome, "failed");
    assert.equal(await call(["run", "--command", "pwd"]), 0);
    assert.equal(parseOperationResult(output).outcome, "passed");
    assert.equal(await call(["run", "--command", "rm fixture"]), 3);
    assert.equal(parseOperationResult(output).enforcement, "denied");
    assert.equal(await call(["run", "--command", "pwd"], false), 2);
    assert.equal(parseOperationResult(output).capability, "unavailable");
    assert.equal(await call(["capabilities"], false), 0);
    assert.match(output, /"native":false/);
    assert.equal(await runCoreCommand(["operation", "capabilities", "--format", "pa-operation-result/v1"], { binaryName: "ppa", io: { stdout: s => { output = s; } } }), 0);
    assert.match(output, /"runtime":"pi"/);
    assert.equal(await call(["run", "--command", "pwd"]), 0);
    assert.equal(failed.process?.exitCode, 19);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
