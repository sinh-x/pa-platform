import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PA_SAFETY_ACTIVITY_PLUGIN_SOURCE } from "../plugins/pa-safety-activity.js";
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

test("generated OpenCode hooks delegate shell to the shared public owner and keep protected denials local", async () => {
  // Source hook unit port, not installed/native-authentication qualification.
  const root = mkdtempSync(join(tmpdir(), "pap277-opa-hook-")), env = { ...process.env };
  try {
    Object.assign(process.env, { PA_DEPLOYMENT_ID: "d-123abc", PA_DEPLOYMENT_DIR: root, PA_ACTIVITY_LOG: join(root, "activity.jsonl") });
    const port = join(root, "port.mjs");
    writeFileSync(port, `export { nativePublicText } from ${JSON.stringify(import.meta.resolve("@pa-platform/pa-core"))}; export const readAdvisoryStart = () => ({}); export const resolveAdvisoryOperationHost = () => ({}); export const trustedNativeExecutable = () => '/nix/store/fixture/opa'; export const parseOperationResult = () => { throw Error('unknown'); };`);
    const plugin = join(root, "plugin.mjs");
    writeFileSync(plugin, PA_SAFETY_ACTIVITY_PLUGIN_SOURCE.replace(/import \* as paOperations from [^\n]+/, `import * as paOperations from ${JSON.stringify(pathToFileURL(port).href)}`));
    const loaded = await import(pathToFileURL(plugin).href) as { PaSafetyActivityPlugin(): Promise<Record<string, (input: unknown, output: unknown) => Promise<void>>> };
    const hooks = await loaded.PaSafetyActivityPlugin();
    const command = `printf '%s' "it's fine"`;
    const output = { args: { command } };
    await hooks["tool.execute.before"]!({ tool: "bash" }, output);
    assert.ok(output.args.command.startsWith("'/nix/store/fixture/opa' operation run --command "));
    assert.match(output.args.command, /--format pa-operation-result\/v1$/);
    assert.ok(output.args.command.includes(`'"'"'`), "apostrophes remain inert shell operands");
    await assert.rejects(() => hooks["tool.execute.before"]!({ tool: "bash" }, { args: { command: "rm fixture.txt" } }), /SAFETY_DIRECT_DELETION/);
    await hooks["tool.execute.before"]!({ tool: "read" }, { args: { filePath: "README.md" } });
    await assert.rejects(() => hooks["tool.execute.before"]!({ tool: "read" }, { args: { filePath: ".env" } }), /SAFETY_PROTECTED_PATH/);
    const after: { output: string; metadata?: Record<string, unknown> } = { output: "printed success without native facts" };
    await hooks["tool.execute.after"]!({ tool: "bash" }, after);
    assert.equal(after.metadata?.paOperationObservation, "unavailable");
    process.env.TEST_PRIVATE_TOKEN = "fixture-env-secret-should-not-log";
    await hooks["tool.execute.before"]!({ tool: "read" }, { args: { filePath: "README.md", note: process.env.TEST_PRIVATE_TOKEN } });
    assert.ok(!readFileSync(join(root, "activity.jsonl"), "utf8").includes(process.env.TEST_PRIVATE_TOKEN));
  } finally { process.env = env; rmSync(root, { recursive: true, force: true }); }
});
