import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeExecutionEvidence, ProtectedWorkflowStore, executeOperation, operationExitCode, type AdvisoryOperationHost } from "@pa-platform/pa-core";
import { createOperationModule } from "../pi-extension/operation-tool.js";
import type { PiRuntime, PiToolDefinition } from "../pi-extension/index.js";

test("actual Pi operation tool: failed check then safe diagnosis and recheck, no plan/catalogue/order", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap277-pi-"));
  try {
    const evidence = new NativeExecutionEvidence(new ProtectedWorkflowStore(root), root, { repository: f => f(), worktree: f => f() });
    const completed: string[] = [];
    const host: AdvisoryOperationHost = { runtime: "pi", cwd: root, evidence, privateValues: [],
      begin: (operationId, command) => evidence.publish("test-intent", { operationId, command }), finish: id => { completed.push(id); } };
    let tool: PiToolDefinition | undefined;
    createOperationModule(() => host)({ registerTool: (value) => { tool = value as PiToolDefinition; } } as PiRuntime);
    const run = async (command: string) => tool!.execute("host-assigned-id", { request: JSON.stringify({ action: "run", command }) }, undefined, undefined, {});
    const failed = await run("exit 17");
    assert.equal(failed.isError, false);
    const first = (failed.details.operation as Awaited<ReturnType<typeof executeOperation>>);
    assert.equal(first.outcome, "failed"); assert.equal(first.process?.exitCode, 17); assert.equal(operationExitCode(first), 1);
    const read = await run("pwd"); assert.equal((read.details.operation as typeof first).outcome, "passed");
    const pass = await run("exit 0"); assert.equal((pass.details.operation as typeof first).outcome, "passed");
    assert.equal(first.outcome, "failed"); assert.equal(completed.length, 3);
    const denial = await run("rm fixture.txt"); assert.equal((denial.details.operation as typeof first).enforcement, "denied");
    assert.equal(completed.length, 3);
    assert.equal((await run("pwd")).isError, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("missing optional host/config is local unavailable; discovery and subsequent tool calls remain callable", async () => {
  const missing = await executeOperation('{"action":"run","command":"pwd"}', "pi", null);
  assert.equal(missing.capability, "unavailable"); assert.equal(operationExitCode(missing), 2);
  const discovery = await executeOperation('{"action":"capabilities"}', "pi", null);
  assert.equal(discovery.outcome, "passed");
  assert.equal((await executeOperation('{"action":"run","command":"pwd","passed":true}', "pi", null)).completion, "error");
  assert.equal((await executeOperation('{"action":"capabilities"}', "pi", null)).outcome, "passed");
});
