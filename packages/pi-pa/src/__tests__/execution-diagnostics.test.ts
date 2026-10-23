import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendRegistryEvent, closeDb, ExecutionCustodyService, ProtectedWorkflowStore, executionFailure, parseExecutionBinding, projectExecution, workflowDigest,
  type ExecutionFailureCode, type ExecutionHolder, type SourceVersion,
} from "@pa-platform/pa-core";
import { createPiExecutionModule, type PiExecutionBinding } from "../pi-extension/prepared-workflow.js";
import { PiNativeExecutionAdapter } from "../execution-native.js";
import { PiPreparedNativeAuthority } from "../prepared-native.js";
import { createPiSessionLifecycle, type PiRuntime, type PiToolDefinition } from "../pi-extension/index.js";

const codes = ["EXECUTION_NOT_ADOPTED", "EXECUTION_BINDING_UNCERTAIN", "EXECUTION_CAPABILITY_UNSUPPORTED", "EXECUTION_CONTRACT_INVALID", "EXECUTION_STORAGE_REJECTED", "EXECUTION_CALLER_STALE", "EXECUTION_BINDING_CONFLICT", "EXECUTION_HOLDER_CONFLICT", "EXECUTION_UNKNOWN"] as const satisfies readonly ExecutionFailureCode[];
const stages = ["binding-resolution", "binding-resolution", "capability", "contract", "persistence", "caller", "binding-validation", "custody", "fallback"];
const actor: ExecutionHolder = { deploymentId: "d-aaaaaa", process: { pid: 123, startTimeTicks: "1", bootId: "fixture" } };
const source: SourceVersion = { ref: "fixture:holder", version: "fixture/v1", sha256: workflowDigest("holder") };
const time = "2026-10-17T00:00:00.000Z";
function assertDiagnostic(error: unknown, code: ExecutionFailureCode): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message, executionFailure(code).message);
  assert.ok(error.message.length <= 2000);
  for (const field of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(error.message.split(field).length, 2);
  assert.doesNotMatch(error.message, /PRIVATE|\/private\/|bootId|startTimeTicks|stack:/);
  return true;
}
async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pap263-diagnostics-"));
  try { await run(setup(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  const binding = parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: "b".repeat(64), lineageId: actor.deploymentId, repoKey: "fixture", repoRoot: "/fixture/canonical", worktreeRoot: "/fixture/ticket", ticket: "PAP-263", branch: "feature/PAP-263-fixture", initialHeadSha: "a".repeat(40), owner: actor,
    bounds: { startedAt: time, deadlineAt: "2026-10-17T02:00:00.000Z", runtimeMinutes: 120, consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null } });
  let failure: unknown; let failing = false; let active = true; let publications = 0; let dependent = 0;
  const store = new ProtectedWorkflowStore(root);
  const service = new ExecutionCustodyService(store, binding, { locks: { repository: (run) => run(), worktree: (run) => run() }, authorize() {}, assertLive() {}, verifyEvidence() {}, assertHandover() {}, now: () => time });
  service.initialize(actor);
  const unsupported = (): never => { dependent++; throw new Error("PRIVATE unsupported fixture port"); };
  const native: PiExecutionBinding = { bindingIdentity: workflowDigest("binding"), service, actor, assertToolCall() {}, resolveCheck: () => null,
    resolveToolResult: unsupported, resolveHolder: () => actor, resolveInventory: unsupported, resolveRecovery: unsupported, resolveCandidate: unsupported,
    assertFeatureUpdate: unsupported, runGit: unsupported, recordFeatureUpdateIntent: unsupported, recordFeatureUpdate: unsupported };
  const register = () => {
    const tools = new Map<string, PiToolDefinition>(); const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
    const pi = { registerTool(tool: PiToolDefinition) { tools.set(tool.name, tool); }, on(name: string, handler: (event: unknown, context: unknown) => unknown) { handlers.set(name, handler); } } as PiRuntime;
    const lifecycle = createPiSessionLifecycle(() => undefined);
    createPiExecutionModule({ env: { PA_TEAM: "builder", PA_MODE: "orchestrator" }, resolveBinding() { if (failing) throw failure; return active ? native : null; } })(pi, lifecycle);
    return { lifecycle, call: (input: Record<string, unknown>) => tools.get("pa_execution")!.execute("control", input, undefined, undefined, {}),
      hook: () => handlers.get("tool_call")!({ toolName: "write", toolCallId: "write", input: { path: "src/file.ts", content: "fixture" } }, {}) };
  };
  return { register, native, service, fail(value: unknown) { failing = true; failure = value; }, inactive() { active = false; },
    observe() { native.observe = () => { publications++; return source; }; }, counts: () => ({ publications, dependent }),
    snapshot: () => readdirSync(root).sort().map((name) => [name, readFileSync(join(root, name)).toString("base64")]) };
}

for (const [index, code] of codes.entries()) {
  test(`PAP-263 trusted boundary ${code}: both controls preserve only first-proven static stage`, () => fixture(async (f) => {
    const r = f.register(); const before = f.snapshot();
    f.fail(executionFailure(code));
    for (const input of [{ action: "status" }, { action: "observe", kind: "holder" }]) {
      for (let repeat = 0; repeat < 2; repeat++) await assert.rejects(r.call(input), (error) => assertDiagnostic(error, code));
    }
    assert.match(executionFailure(code).message, new RegExp(`${code}/${stages[index]}`));
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.counts(), { publications: 0, dependent: 0 });
  }));
}

test("PAP-263 never-adopted controls deny without writes; ordinary hook remains unchanged", () => fixture(async (f) => {
  f.inactive(); const r = f.register(); const before = f.snapshot();
  for (const input of [{ action: "status" }, { action: "observe", kind: "holder" }]) await assert.rejects(r.call(input), (error) => assertDiagnostic(error, "EXECUTION_NOT_ADOPTED"));
  assert.equal(r.hook(), undefined); assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.counts(), { publications: 0, dependent: 0 });
}));

test("PAP-263 retained adoption loss and shutdown never fall back or erase journal/counters/barrier", () => fixture(async (f) => {
  const r = f.register(); await r.call({ action: "status" });
  const before = f.snapshot(); f.inactive();
  for (const input of [{ action: "status" }, { action: "observe", kind: "holder" }]) await assert.rejects(r.call(input), (error) => assertDiagnostic(error, "EXECUTION_BINDING_UNCERTAIN"));
  assert.equal((r.hook() as { block: boolean }).block, true); await r.lifecycle.shutdown(); assert.deepEqual(f.snapshot(), before);
}));

test("PAP-263 capability is checked before publication; valid status and observe retain shapes/effects", () => fixture(async (f) => {
  const r = f.register(); const before = f.snapshot();
  assert.deepEqual((await r.call({ action: "status" })).details, projectExecution(f.service.status(actor)));
  await assert.rejects(r.call({ action: "observe", kind: "holder" }), (error) => assertDiagnostic(error, "EXECUTION_CAPABILITY_UNSUPPORTED"));
  assert.deepEqual(f.counts(), { publications: 0, dependent: 0 }); assert.deepEqual(f.snapshot(), before);
  f.observe(); assert.deepEqual((await r.call({ action: "observe", kind: "holder" })).details, { evidence: source });
  assert.deepEqual(f.counts(), { publications: 1, dependent: 0 }); assert.deepEqual(f.snapshot(), before);
}));

test("PAP-263 untrusted exceptions and malicious model data cannot launder authentic codes", () => fixture(async (f) => {
  const sentinel = "PRIVATE /private/token process-fingerprint stack:";
  let getters = 0; const hostile = () => { getters++; throw executionFailure("EXECUTION_HOLDER_CONFLICT"); };
  const fake = Object.defineProperties({}, { code: { get: hostile }, message: { get: hostile }, stack: { get: hostile } });
  for (const value of [new Error(sentinel), { code: "EXECUTION_CALLER_STALE", message: sentinel }, fake, new Proxy({}, { get: hostile, getPrototypeOf: hostile }), "x".repeat(20000)]) {
    f.fail(value); const r = f.register();
    await assert.rejects(r.call({ action: "status" }), (error) => assertDiagnostic(error, "EXECUTION_UNKNOWN"));
  }
  assert.equal(getters, 0);
  // Separate active binding: model reflection throws even an authentic error.
  await fixture(async (fresh) => {
    const r = fresh.register(); const before = fresh.snapshot();
    for (const input of [Object.defineProperty({}, "action", { get: hostile }), new Proxy({}, { ownKeys: hostile }), { action: "plan", plan: Object.defineProperty({}, "paths", { get: hostile }) }]) {
      await assert.rejects(r.call(input), (error) => assertDiagnostic(error, "EXECUTION_UNKNOWN"));
    }
    assert.equal(getters, 1); // only unavoidable Proxy reflection, never accessor execution
    assert.deepEqual(fresh.snapshot(), before); assert.deepEqual(fresh.counts(), { publications: 0, dependent: 0 });
  });
}));

async function nativeFixture(options: { marker?: string; declared?: string; mode?: string; insecure?: boolean }, run: (adapter: PiNativeExecutionAdapter, directory: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pap263-native-boundary-")); const previous = process.env;
  closeDb();
  try {
    const directory = join(root, "deployments/d-263aaa"); mkdirSync(directory, { recursive: true });
    const teams = join(root, "teams"); mkdirSync(teams);
    writeFileSync(join(teams, "builder.yaml"), "name: builder\ndescription: Fixture\nobjective: Fixture\nagents: []\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n  - id: implement\n    label: Legacy bootstrap\n");
    process.env = { ...previous, PA_PLATFORM_TEAMS: teams, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), PA_DEPLOYMENT_ID: "d-263aaa", PA_DEPLOYMENT_DIR: directory, PA_TEAM: "builder", PA_MODE: options.mode ?? "orchestrator" };
    appendRegistryEvent({ deployment_id: "d-263aaa", team: "builder", mode: process.env.PA_MODE, runtime: "pi", binary: "ppa", event: "started", timestamp: time, ...(options.declared === undefined ? {} : { note: `prepared-native-consumption/v1:${options.declared}` }) });
    if (options.marker !== undefined) { const path = join(directory, "prepared-consumption.json"); writeFileSync(path, options.marker, { mode: 0o600 }); if (options.insecure) chmodSync(path, 0o644); }
    await run(new PiNativeExecutionAdapter({ authority: new PiPreparedNativeAuthority({ root: join(root, "authority"), aiUsageRoot: root }) }), directory);
  } finally { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); }
}
const consumed = Object.fromEntries(["schemaVersion", "deploymentId", "repoKey", "repoRoot", "ticket", "operationId", "receiptId", "grantId", "consumer", "worktreeRoot", "branch", "baseSha", "headSha", "ticketSlotId", "repositoryPermit"].map((key) => [key, "fixture"]));
for (const [name, options, code] of [
  ["lost marker", { declared: "a".repeat(64) }, "EXECUTION_BINDING_UNCERTAIN"],
  ["lost locator", { marker: JSON.stringify(consumed) }, "EXECUTION_BINDING_UNCERTAIN"],
  ["malformed locator", { declared: "PRIVATE" }, "EXECUTION_BINDING_UNCERTAIN"],
  ["insecure marker", { marker: JSON.stringify(consumed), insecure: true }, "EXECUTION_STORAGE_REJECTED"],
  ["malformed stored JSON", { marker: "PRIVATE invalid JSON" }, "EXECUTION_STORAGE_REJECTED"],
  ["invalid contract fields", { marker: JSON.stringify({ schemaVersion: "PRIVATE" }) }, "EXECUTION_CONTRACT_INVALID"],
  ["unsupported child execution", { marker: JSON.stringify(consumed), declared: workflowDigest(JSON.stringify(consumed)), mode: "implement" }, "EXECUTION_CAPABILITY_UNSUPPORTED"],
] as const) {
  test(`PAP-263 native proving boundary: ${name}`, () => nativeFixture(options, async (adapter) => {
    const tools = new Map<string, PiToolDefinition>();
    createPiExecutionModule({ nativeAdapter: adapter })({ registerTool(tool: PiToolDefinition) { tools.set(tool.name, tool); }, on() {} } as PiRuntime);
    for (const input of [{ action: "status" }, { action: "observe", kind: "holder" }]) await assert.rejects(tools.get("pa_execution")!.execute("control", input, undefined, undefined, { cwd: process.cwd() }), (error) => assertDiagnostic(error, code));
  }));
}

test("PAP-263 native never-adopted null is distinct from insufficient caller evidence", () => nativeFixture({}, async (adapter) => {
  assert.equal(adapter.resolve({ cwd: process.cwd() }, true), null);
  delete process.env.PA_DEPLOYMENT_ID;
  assert.throws(() => adapter.resolve({}, true), (error) => assertDiagnostic(error, "EXECUTION_UNKNOWN"));
  assert.equal(adapter.resolve({}), null); // legacy hook decision unchanged
}));

test("PAP-263 native authenticated marker reaches identity check before capability/publication", () => nativeFixture({ marker: JSON.stringify(consumed), declared: workflowDigest(JSON.stringify(consumed)) }, async (adapter) => {
  assert.throws(() => adapter.resolve({ cwd: "/private/PRIVATE" }), (error) => assertDiagnostic(error, "EXECUTION_BINDING_CONFLICT"));
}));

test("PAP-263 shutdown stale-caller denial precedes unsupported observation", () => fixture(async (f) => {
  const r = f.register(); await r.call({ action: "status" }); const before = f.snapshot(); await r.lifecycle.shutdown();
  await assert.rejects(r.call({ action: "observe", kind: "holder" }), (error) => assertDiagnostic(error, "EXECUTION_CALLER_STALE"));
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.counts(), { publications: 0, dependent: 0 });
}));
