import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExecutionCustodyService, ProtectedWorkflowStore, parseExecutionBinding, parseExecutionPlan, repositoryGitSnapshotDigest, workflowDigest,
  type ExecutionFailure, type ExecutionHolder, type ExecutionHost, type SourceVersion,
} from "@pa-platform/pa-core";
import { createPiExecutionModule, PiExecutionParams, PiFeatureUpdateParams, type PiExecutionBinding, type PiExecutionEndEvent } from "../pi-extension/prepared-workflow.js";
import { createPiSessionLifecycle, interceptToolCall, type PiRuntime, type PiToolDefinition } from "../pi-extension/index.js";
const sha = "a".repeat(40); const time = "2026-10-17T00:00:00.000Z";
const owner: ExecutionHolder = { deploymentId: "d-aaaaaa", process: { pid: 111, startTimeTicks: "123", bootId: "fixture" } };
const child: ExecutionHolder = { deploymentId: "d-bbbbbb", process: { pid: 222, startTimeTicks: "456", bootId: "fixture" } };
const source = (ref: string): SourceVersion => ({ ref: `fixture:${ref}`, version: "v1", sha256: workflowDigest(ref) });
const plan = () => parseExecutionPlan({ phaseId: "phase-3", scope: "bounded ticket", paths: ["src/file.ts"], requirements: ["FR6", "AC8"], prerequisites: [], checks: ["typecheck"], size: "bounded", complexity: "barrier", rationale: "Use one direct writer." });
function runtime() {
  const tools = new Map<string, PiToolDefinition>(); const handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
  const pi = { registerTool(tool: PiToolDefinition) { tools.set(tool.name, tool); }, on(name: string, handler: (event: unknown, context: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as PiRuntime;
  return { pi, tools, handlers, dispatch(name: string, event: unknown, context: unknown = { cwd: "/fixture/ticket" }) {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) { const value = handler(event, context); if (value !== undefined) result = value; }
    return result;
  } };
}
function setup(root: string) {
  const binding = parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: "b".repeat(64), lineageId: "fixture-lineage", repoKey: "fixture", repoRoot: "/fixture/canonical", worktreeRoot: "/fixture/ticket", ticket: "PAP-256", branch: "feature/PAP-256-fixture", initialHeadSha: sha, owner,
    bounds: { startedAt: time, deadlineAt: "2026-10-17T02:00:00.000Z", runtimeMinutes: 120, consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null } });
  let active = true; let bindingIdentity = workflowDigest("native-binding"); let actor = owner; let dead = false; let uncertain = false; let deny = false;
  let resultFailure: ExecutionFailure | null = null;
  const host: ExecutionHost = { locks: { repository: (run) => run(), worktree: (run) => run() },
    authorize() { if (deny) throw new Error("PRIVATE-POLICY-SENTINEL"); }, assertLive() { if (dead) throw new Error("stale actor"); }, verifyEvidence() {},
    assertHandover() { if (uncertain) throw new Error("live child or missing matching finalization"); }, now: () => time };
  const service = new ExecutionCustodyService(new ProtectedWorkflowStore(root), binding, host); service.initialize(owner);
  const r = runtime(); const lifecycle = createPiSessionLifecycle(() => undefined);
  const native: PiExecutionBinding = {
    bindingIdentity, service, actor,
    assertToolCall(call, context) {
      const cwd = (context as { cwd?: string }).cwd;
      if (cwd !== binding.worktreeRoot || (typeof call.input.path === "string" && call.input.path !== "src/file.ts")) throw new Error("out-of-scope PRIVATE-PATH");
      const safety = interceptToolCall(call); if (!safety.allowed) throw new Error("generic safety remains active");
    },
    resolveCheck(call) { return call.input.command === "corepack pnpm typecheck" ? "typecheck" : null; },
    resolveToolResult() { if (uncertain) throw new Error("PRIVATE-PROCESS-SENTINEL still alive"); return { evidence: source("native-exit-output"), failure: resultFailure }; },
    resolveHolder(ref) { if (ref.ref === "fixture:owner") return owner; if (ref.ref === "fixture:child") return child; throw new Error("unknown holder"); },
    resolveInventory(ref) { if (ref.ref !== "fixture:settle") throw new Error("unproven inventory"); return { branch: binding.branch, headSha: service.status(owner).candidateSha, porcelainV2Base64: "", snapshotSha256: repositoryGitSnapshotDigest(binding.branch, service.status(owner).candidateSha, Buffer.alloc(0)), paths: [], evidence: source("complete-inventory") }; },
    resolveRecovery() { return { originalFailure: source("original-failure"), diagnostic: source("diagnosis"), remedy: source("remedy"), rationale: "A native verified remedy.", recheck: resultFailure! }; },
    resolveCandidate() { return "c".repeat(40); },
    assertFeatureUpdate() { if (deny) throw new Error("PRIVATE-REMOTE-SENTINEL"); },
    runGit(args) {
      if (uncertain) throw new Error("PRIVATE-REMOTE-FAILURE");
      if (args[0] === "branch") return Buffer.from(`${binding.branch}\n`);
      if (args[0] === "rev-parse") return Buffer.from(`${sha}\n`);
      if (args[0] === "ls-remote") return Buffer.from(`${pushed ? sha : "d".repeat(40)}\trefs/heads/${binding.branch}\n`);
      if (args.includes("push")) { pushed = true; return Buffer.from("ok\n"); }
      throw new Error("unlisted Git command");
    }, recordFeatureUpdateIntent(candidateSha, expectedRemoteSha) { return source(`update-intent-${candidateSha}-${expectedRemoteSha}`); },
    recordFeatureUpdate() { return source("native-update-result"); },
  };
  let pushed = false;
  createPiExecutionModule({ env: { PA_TEAM: "builder", PA_MODE: "orchestrator" }, resolveBinding() { return active ? { ...native, bindingIdentity, actor } : null; } })(r.pi, lifecycle);
  const call = (id: string, name = "write", input: Record<string, unknown> = { path: "src/file.ts", content: "x" }, context?: unknown) => r.dispatch("tool_call", { toolCallId: id, toolName: name, input }, context);
  const end = (id: string, name = "write", isError = false) => r.dispatch("tool_execution_end", { toolCallId: id, toolName: name, result: { text: "model/tool claims are untrusted" }, isError } satisfies PiExecutionEndEvent);
  const execute = (input: Record<string, unknown>, name = "pa_execution", id = "control") => r.tools.get(name)!.execute(id, input, undefined, undefined, {});
  const select = (executor: "orchestrator-direct" | "implement-child" = "orchestrator-direct") => service.apply(owner, { action: "select", executor, holder: executor === "orchestrator-direct" ? owner : child, handover: source("native-handover") });
  const start = () => { service.apply(owner, { action: "plan", plan: plan() }); select(); };
  return { ...r, native, host, service, call, end, execute, start, select, lifecycle,
    setActive(value: boolean) { active = value; }, drift() { bindingIdentity = workflowDigest("drift"); }, setActor(value: ExecutionHolder) { actor = value; },
    setDead(value: boolean) { dead = value; }, setUncertain(value: boolean) { uncertain = value; }, setDeny(value: boolean) { deny = value; },
    fail() { resultFailure = { check: "typecheck", command: "corepack pnpm typecheck", exitCode: 2, candidateSha: sha, output: source("original-failure") }; } };
}
async function fixture(run: (f: ReturnType<typeof setup>) => unknown | Promise<unknown>) {
  const root = mkdtempSync(join(tmpdir(), "pap256-pi-execution-"));
  try { await run(setup(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("AC1 inactive default keeps legacy hooks unchanged; only builder tools register, schema has no authority/argv override", () => {
  for (const env of [{}, { PA_TEAM: "rogue-one", PA_MODE: "rogue-one" }, { PA_TEAM: "requirements", PA_MODE: "analyze" }]) {
    const r = runtime(); createPiExecutionModule({ env })(r.pi);
    assert.equal(r.tools.size, 0);
    assert.equal(r.dispatch("tool_call", { toolName: "write", input: { path: "src/file.ts" } }), undefined);
    assert.equal(r.dispatch("user_bash", { command: "echo fixture" }), undefined);
  }
  const r = runtime(); createPiExecutionModule({ env: { PA_TEAM: "builder", PA_MODE: "orchestrator" } })(r.pi);
  assert.deepEqual([...r.tools.keys()], ["pa_execution", "pa_feature_update"]);
  assert.doesNotMatch(JSON.stringify([PiExecutionParams, PiFeatureUpdateParams]), /pid|bootId|startTime|argv|repoRoot|worktreeRoot|token/);
});

test("AC7 bounded control tool persists plan before selection; model cannot select a process or clear a live operation", () => fixture(async (f) => {
  await assert.rejects(f.execute({ action: "select", executor: "orchestrator-direct", holder: source("owner"), handover: source("handover") }));
  const result = await f.execute({ action: "plan", plan: plan() }); assert.equal(result.details.state, "idle");
  await f.execute({ action: "select", executor: "orchestrator-direct", holder: source("owner"), handover: source("handover") });
  assert.equal(f.call("write"), undefined);
  await assert.rejects(f.execute({ action: "settle", evidence: source("settle") }));
  await assert.rejects(f.execute({ action: "finish", operationId: "write", evidence: source("fake-result") }));
  assert.equal(f.service.status(owner).operation?.id, "write");
}));

for (const name of ["write", "edit", "bash", "shell", "execute", "write_file", "edit_file", "apply_patch", "functions.write", "functions.bash", "pa_deploy", "mcp__unknown_mutator"]) {
  test(`AC8 real tool_call denies delegated parent at ${name} alias`, () => fixture((f) => {
    f.service.apply(owner, { action: "plan", plan: plan() }); f.select("implement-child");
    assert.equal((f.call("parent", name) as { block: boolean }).block, true);
    assert.equal(f.service.status(owner).operation, null);
    assert.equal(f.call("read", "read", { path: "src/file.ts" }), undefined);
    assert.equal(f.call("status", "pa_status", { id: "d-bbbbbb" }), undefined);
  }));
}

test("AC8 holder operation spans actual dispatch to verified native completion; simultaneous writes/handover reject", () => fixture((f) => {
  f.start(); assert.equal(f.call("first"), undefined);
  assert.equal((f.call("second", "edit") as { block: boolean }).block, true);
  assert.throws(() => f.service.apply(owner, { action: "settle", evidence: source("settle"), inventory: f.native.resolveInventory(source("settle")) }));
  assert.equal(f.service.status(owner).operation?.id, "first");
  f.end("first"); assert.equal(f.service.status(owner).operation, null);
  assert.equal(f.call("after", "edit"), undefined); f.end("after", "edit");
  assert.throws(() => f.dispatch("user_bash", { command: "touch other-file" }));
}));

test("AC8 canonical/out-of-plan paths, stale PID/session binding and forged completion never release custody", () => fixture((f) => {
  f.start();
  assert.equal((f.call("wrong-path", "write", { path: "/fixture/canonical/src/file.ts" }) as { block: boolean }).block, true);
  assert.equal((f.call("wrong-cwd", "write", { path: "src/file.ts" }, { cwd: "/fixture/canonical" }) as { block: boolean }).block, true);
  f.setDead(true); assert.equal((f.call("dead") as { block: boolean }).block, true); f.setDead(false);
  assert.equal(f.call("real"), undefined); f.end("forged"); assert.equal(f.service.status(owner).operation?.id, "real");
  f.drift(); assert.throws(() => f.end("real")); assert.equal(f.service.status(owner).operation?.id, "real");
}));

test("AC8 caller switching cannot close another holder; uncertain process or revoked binding retains barrier across shutdown", () => fixture(async (f) => {
  f.start(); f.call("retained");
  f.setActor(child); assert.throws(() => f.end("retained")); f.setActor(owner);
  f.setUncertain(true); assert.throws(() => f.end("retained"), (error: Error) => !error.message.includes("PRIVATE-PROCESS-SENTINEL"));
  f.setUncertain(false); f.setActive(false); assert.throws(() => f.end("retained"));
  assert.equal((f.call("revoked-write") as { block: boolean }).block, true); f.setActive(true);
  await f.lifecycle.shutdown(); assert.equal(f.service.status(owner).operation?.id, "retained");
}));

test("AC10 named phase checks are matched by native command mapping, not model pass flags", () => fixture(async (f) => {
  f.start();
  f.call("check", "bash", { command: "corepack pnpm typecheck", passed: true });
  assert.equal(f.service.status(owner).operation?.kind, "check");
  f.end("check", "bash");
  assert.ok(Object.hasOwn(f.service.status(owner).passedChecks, "typecheck"));
  f.call("ordinary", "bash", { command: "echo not-a-named-check", check: "typecheck", passed: true }); f.end("ordinary", "bash");
  assert.deepEqual(f.service.status(owner).passedChecks, {});
  const result = await f.execute({ action: "status" });
  assert.doesNotMatch(JSON.stringify(result), /bootId|startTimeTicks|\/fixture|PRIVATE|process/);
}));

test("AC10 failed native tool keeps original failure; a false success cannot close an error event", () => fixture((f) => {
  f.start(); f.call("check", "bash", { command: "corepack pnpm typecheck" });
  assert.throws(() => f.end("check", "bash", true)); assert.equal(f.service.status(owner).operation?.id, "check");
  f.fail(); f.end("check", "bash", true);
  assert.equal(f.service.status(owner).originalFailure?.exitCode, 2);
  assert.equal((f.call("bypass-recovery") as { block: boolean }).block, true);
}));

test("AC11 pa_feature_update uses fixed native port; shell force push stays denied", () => fixture(async (f) => {
  f.start();
  assert.equal(interceptToolCall({ toolName: "bash", input: { command: "git push --force origin HEAD" } }).allowed, false);
  assert.equal((f.call("raw-force", "bash", { command: "git push --force origin HEAD" }) as { block: boolean }).block, true);
  const result = await f.execute({ candidateSha: sha, expectedRemoteSha: "d".repeat(40) }, "pa_feature_update", "scoped-update");
  assert.equal(result.details.inFlight, false);
  await assert.rejects(f.execute({ candidateSha: sha, expectedRemoteSha: "d".repeat(40), remote: "other", argv: ["--force"] }, "pa_feature_update"));
}));

test("AC11 failed update preserves started operation and exact expected-head intent; no automatic retry or force escape", () => fixture(async (f) => {
  f.start(); f.setUncertain(true);
  await assert.rejects(f.execute({ candidateSha: sha, expectedRemoteSha: "d".repeat(40) }, "pa_feature_update", "failed-update"), (error: Error) => !error.message.includes("PRIVATE-REMOTE-FAILURE"));
  assert.equal(f.service.status(owner).operation?.id, "feature-update:failed-update");
  assert.match(f.service.status(owner).operation?.intent?.ref ?? "", /update-intent/);
  f.setUncertain(false);
  await assert.rejects(f.execute({ candidateSha: sha, expectedRemoteSha: "d".repeat(40) }, "pa_feature_update", "retry-update"));
}));

test("PAP-271 internal journal successor can use unchanged Pi hooks, but restart is never a public process-selection action", () => fixture(async f => {
  // Synthetic trusted handoff only: the default native adapter still has no
  // authenticated repository/capacity restart producer.
  f.start(); f.call("before"); f.end("before");
  const before = f.service.status(owner);
  f.host.assertRestart = () => undefined;
  f.service.restart(child, before.sequence, source("native-restart")); f.setActor(child);
  await assert.rejects(f.execute({ action: "restart", previousOwner: source("owner"), evidence: source("native-restart") }));
  assert.equal(f.call("after"), undefined); f.end("after");
  const next = f.service.status(child);
  assert.equal(next.binding.lineageId, before.binding.lineageId);
  assert.deepEqual(next.binding.owner, owner); assert.deepEqual(next.activeOwner, child);
  assert.equal(next.bounds.replacementsUsed, 1); assert.equal(next.bounds.deadlineAt, before.bounds.deadlineAt);
  assert.equal(next.operation, null);
  f.setActor(owner); assert.equal((f.call("retired") as { block: boolean }).block, true);
}));

test("PAP-271 Pi pending tool hook cannot finish an old operation after internal holder restart", () => fixture(f => {
  f.start(); f.call("unknown-before-restart");
  f.host.assertRestart = () => undefined;
  const before = f.service.status(owner);
  f.service.restart(child, before.sequence, source("native-restart")); f.setActor(child);
  assert.throws(() => f.end("unknown-before-restart"));
  assert.equal((f.call("retry-after-restart") as { block: boolean }).block, true);
  f.setActor(owner); assert.throws(() => f.end("unknown-before-restart"));
  assert.deepEqual(f.service.status(child).operation, before.operation);
  assert.deepEqual(f.service.status(child).custody, before.custody);
}));

test("AC1/AC8 inactive/mismatched/async bindings reject controls and cannot mint authority from environment", () => fixture(async (f) => {
  f.setActive(false); await assert.rejects(f.execute({ action: "plan", plan: plan() }));
  const r = runtime(); createPiExecutionModule({ env: { PA_TEAM: "builder", PA_MODE: "orchestrator", PA_PREPARED_ENABLED: "1" } })(r.pi);
  await assert.rejects(r.tools.get("pa_execution")!.execute("id", { action: "status" }, undefined, undefined, {}));
  const asyncRuntime = runtime(); createPiExecutionModule({ resolveBinding: (async () => f.native) as unknown as () => PiExecutionBinding })(asyncRuntime.pi);
  assert.equal((asyncRuntime.dispatch("tool_call", { toolCallId: "id", toolName: "write", input: {} }) as { block: boolean }).block, true);
}));
