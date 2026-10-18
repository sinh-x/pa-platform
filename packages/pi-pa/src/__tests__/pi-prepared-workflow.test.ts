import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import {
  PA_PI_EXECUTION_MODE_ENV, parsePreparationContract, parsePreparedReceipt, preparationIdentity,
  PreparedWorkflowService, ProtectedWorkflowStore, readNativePreparationRetry, TicketStore, withPreparedTicketCapacity, readProcessFingerprint,
  REPOSITORY_MUTATION_LEASE_FILE, REPOSITORY_IMPLEMENT_LEASE_FILE, REPOSITORY_MUTATION_BORROWER_FILE, REPOSITORY_REVIEW_RESERVATION_FILE,
  type DeploymentStatus, type PreparationAction, type PreparationContract, type PreparationHost, type PreparationOutcome, type SourceVersion,
} from "@pa-platform/pa-core";
import { TreehouseClient } from "../treehouse.js";
import { createPiSessionLifecycle, registerPaToolsModule, type PiToolDefinition } from "../pi-extension/index.js";
import {
  createPiPreparationHost, authenticatePiPreparationCaller, type PiPreparationCallerDependencies, createPiPreparationTool, createPiPreparedWorkflowModule, isInteractivePreparationEnvironment, PiPreparationParams,
  type PiPreparationBinding, type PiPreparationCaller, type PiPreparationContext, type PiPreparedWorkflowOptions,
} from "../pi-extension/prepared-workflow.js";

const time = "2026-10-17T00:00:00.000Z";
const sha = "a".repeat(40); const digest = "b".repeat(64);
const source = (ref: string): SourceVersion => ({ ref, version: "fixture", sha256: digest });
const env = { PA_TEAM: "requirements", PA_MODE: "analyze", [PA_PI_EXECUTION_MODE_ENV]: "foreground" };
const caller: PiPreparationCaller = Object.freeze({ deploymentId: "d-123abc", repoKey: "fixture", repoRoot: "/fixture/canonical", ticket: "PAP-256", callerIdentity: "c".repeat(64) });
function contract(): PreparationContract {
  return parsePreparationContract({ schemaVersion: "prepared-workflow/v1", policyVersion: "prepared-autonomy/v1", repoKey: caller.repoKey, repoRoot: caller.repoRoot,
    ticket: caller.ticket, branch: "feature/PAP-256-fixture", integrationTarget: "origin/develop", approvalBaseSha: sha,
    requirements: source("requirements:fixture"), uat: source("uat:fixture"), promotionEvidence: "promotion:fixture", signoffEvidence: "signoff:fixture",
    finalChecks: source("checks:fixture"), finalCheckCount: 13, matrix: source("requirements:fixture"), matrixApprovalEvidence: "matrix:fixture" });
}
const context = (select: NonNullable<PiPreparationContext["ui"]>["select"] = async (_title, choices) => choices[0]): PiPreparationContext => ({ mode: "tui", cwd: caller.repoRoot, ui: { select } });

function fixture(action: (value: {
  root: string; store: ProtectedWorkflowStore; service: PreparedWorkflowService; binding: PiPreparationBinding;
  options: PiPreparedWorkflowOptions; effects: Map<PreparationAction, number>;
  controls: { capacity: boolean; failed: boolean; active: boolean; caller: PiPreparationCaller; bindingIdentity: string; native: SourceVersion | null };
}) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-preparation-fixture-")); const store = new ProtectedWorkflowStore(root);
  const effects = new Map<PreparationAction, number>(); const facts = new Map<PreparationAction, PreparationOutcome>();
  const controls = { capacity: false, failed: false, active: true, caller, bindingIdentity: digest, native: null as SourceVersion | null };
  let service: PreparedWorkflowService;
  const host: PreparationHost = {
    locks: { repository: (run) => run(), worktree: (run) => run() }, now: () => time,
    authorize(operation, input, evidence) {
      if (!controls.active || JSON.stringify(input) !== JSON.stringify(contract())) throw new Error("PRIVATE-HOST-SENTINEL");
      if (operation === "retry") {
        assert.ok(evidence);
        const status = service.status(contract()); assert.ok(status.failure);
        readNativePreparationRetry(store, evidence, { operationId: preparationIdentity(contract()), bindingIdentity: controls.bindingIdentity,
          callerIdentity: controls.caller.callerIdentity, deploymentId: controls.caller.deploymentId, preparationAttempt: status.attempt, failureSha256: status.failure.sha256 });
        controls.native = evidence;
      }
    },
    inspect(step) { const found = facts.get(step); return found?.state === "observed" ? found : { state: "absent" }; },
    perform(step, input) {
      effects.set(step, (effects.get(step) ?? 0) + 1);
      const result = { state: controls.capacity && step === "reservation" ? "capacity" as const : controls.failed && step === "branch" ? "failed" as const : "observed" as const,
        evidence: source(`resource:${step}-${input.attempt}`) };
      facts.set(step, result); return result;
    },
    resolveReceipt(input) { return parsePreparedReceipt({ schemaVersion: "prepared-receipt/v1", operationId: input.operationId, receiptId: digest, state: "ready", contract: input.contract,
      preparationBaseSha: sha, preparedHeadSha: sha, worktreeRoot: "/fixture/prepared", leaseRef: "lease:fixture", capacityRef: "capacity:fixture", custodyRef: "custody:fixture",
      ticketReread: input.results["ticket-reread"], observedAt: time, nextOwner: "builder" }); },
  };
  service = new PreparedWorkflowService(store, host);
  const binding: PiPreparationBinding = { contract: contract(), bindingIdentity: digest, service };
  const options: PiPreparedWorkflowOptions = { env, authenticateCaller: () => controls.caller,
    resolveBinding: () => controls.active ? { ...binding, bindingIdentity: controls.bindingIdentity } : null,
    now: () => time, createEventId: () => "12345678-1234-4234-8234-123456789abc" };
  return Promise.resolve().then(() => action({ root, store, service, binding, options, effects, controls }))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

// These are actual extension execute/registration calls with isolated trusted hosts,
// not claims that live activation, promotion resolution or production allocation ran.
test("AC2: bounded Pi schema admits only request/status/retry, never roots/argv/receipts/enable/consume", () => {
  for (const action of ["request", "status", "retry"]) assert.equal(Check(PiPreparationParams, { action }), true);
  for (const value of [{ action: "consume" }, { action: "activate" }, { action: "request", enabled: true }, { action: "request", contract: contract() },
    { action: "status", root: "/tmp/other" }, { action: "retry", approval: "sinh" }, { action: "retry", argv: ["sh"] }, {}]) assert.equal(Check(PiPreparationParams, value), false);
});

test("AC1: absent production binding reports inactive and rejects request/retry without intent or effects", () => fixture(async ({ root, options, effects }) => {
  const tool = createPiPreparationTool({ ...options, resolveBinding: () => null });
  const inactive = await tool.execute("status", { action: "status" }, undefined, undefined, context());
  assert.equal(inactive.details.state, "inactive"); assert.equal(inactive.details.automationAvailable, false);
  for (const action of ["request", "retry"] as const) await assert.rejects(tool.execute(action, { action }, undefined, undefined, context()), /Condition:/);
  assert.equal(readdirSync(root).length, 0); assert.equal(effects.size, 0);
}));

test("AC2: actual Pi request uses only the resolver's authenticated contract and publishes an allowlisted public receipt", () => fixture(async ({ options, effects }) => {
  const tool = createPiPreparationTool(options);
  const ready = await tool.execute("request", { action: "request" }, undefined, undefined, context());
  assert.equal(ready.details.state, "ready"); assert.equal(ready.details.receipt?.state, "ready");
  assert.equal(effects.size, 5);
  assert.doesNotMatch(JSON.stringify(ready), /PRIVATE-HOST-SENTINEL|startTimeTicks|bootId|callerIdentity|bindingIdentity/);
  const repeated = await tool.execute("request-again", { action: "request" }, undefined, undefined, context());
  assert.deepEqual(repeated.details, ready.details); assert.ok([...effects.values()].every((count) => count === 1));
  await assert.rejects(tool.execute("forged", { action: "request", root: "/tmp/override" } as never, undefined, undefined, context()), /Condition:/);
}));

test("AC4: actual Pi retry captures and persists one fresh native decision bound to exact failed attempt", () => fixture(async ({ options, service, store, controls, effects }) => {
  controls.capacity = true;
  const tool = createPiPreparationTool(options);
  assert.equal((await tool.execute("request", { action: "request" }, undefined, undefined, context())).details.state, "not-ready-capacity");
  let dialogs = 0;
  const ctx = context(async (title, choices) => { dialogs += 1; assert.match(title, /unchanged approved sources/); assert.equal(choices.length, 2); controls.capacity = false; return choices[0]; });
  const ready = await tool.execute("native-retry", { action: "retry" }, undefined, undefined, ctx);
  assert.equal(ready.details.state, "ready"); assert.equal(ready.details.attempt, 2); assert.equal(dialogs, 1);
  assert.equal(effects.get("reservation"), 2); assert.ok(controls.native);
  const native = readNativePreparationRetry(store, controls.native, { operationId: preparationIdentity(contract()), bindingIdentity: digest,
    callerIdentity: caller.callerIdentity, deploymentId: caller.deploymentId, preparationAttempt: 1, failureSha256: digest });
  assert.equal(native.toolCallId, "native-retry"); assert.equal(native.preparationAttempt, 1);
  await assert.rejects(tool.execute("retry-ready", { action: "retry" }, undefined, undefined, ctx));
  assert.equal(dialogs, 1); // no unnecessary setup/retry prompt once ready
  assert.throws(() => service.retry(contract(), controls.native!));
}));

for (const choice of [undefined, "Do not retry", "sinh approved", "Retry this unchanged preparation once\nextra"]) {
  test(`AC4: native retry cancellation/non-exact choice ${JSON.stringify(choice)} creates no retry authority`, () => fixture(async ({ options, controls, root, effects }) => {
    controls.capacity = true; const tool = createPiPreparationTool(options);
    await tool.execute("request", { action: "request" }, undefined, undefined, context());
    const before = readdirSync(root).sort();
    const result = await tool.execute("retry", { action: "retry" }, undefined, undefined, context(async () => choice));
    assert.equal(result.details.state, "cancelled"); assert.deepEqual(readdirSync(root).sort(), before); assert.equal(effects.get("reservation"), 1);
  }));
}

test("native UI abort is forwarded and cannot persist or retry after a late approval", () => fixture(async ({ options, controls, root }) => {
  controls.capacity = true; const tool = createPiPreparationTool(options); const abort = new AbortController();
  await tool.execute("request", { action: "request" }, undefined, undefined, context()); const before = readdirSync(root).sort();
  const result = await tool.execute("retry", { action: "retry" }, abort.signal, undefined, context(async (_title, choices, dialog) => {
    assert.equal(dialog?.signal, abort.signal); abort.abort(); return choices[0];
  }));
  assert.equal(result.details.state, "cancelled"); assert.deepEqual(readdirSync(root).sort(), before);
}));

for (const drift of ["revocation", "binding", "caller", "source"] as const) {
  test(`AC2/AC4: ${drift} during native UI rejects before retry-event persistence`, () => fixture(async ({ options, binding, controls, root, effects }) => {
    controls.capacity = true;
    let sourceDrift = false;
    const tool = createPiPreparationTool({ ...options, resolveBinding: () => controls.active ? { ...binding, bindingIdentity: controls.bindingIdentity,
      contract: sourceDrift ? { ...contract(), signoffEvidence: "changed:source" } : contract() } : null });
    await tool.execute("request", { action: "request" }, undefined, undefined, context()); const before = readdirSync(root).sort();
    await assert.rejects(tool.execute("retry", { action: "retry" }, undefined, undefined, context(async (_title, choices) => {
      if (drift === "revocation") controls.active = false;
      if (drift === "binding") controls.bindingIdentity = "d".repeat(64);
      if (drift === "caller") controls.caller = { ...caller, callerIdentity: "e".repeat(64) };
      if (drift === "source") sourceDrift = true;
      return choices[0];
    })), /Condition:/);
    assert.deepEqual(readdirSync(root).sort(), before); assert.equal(effects.get("reservation"), 1);
  }));
}

test("two concurrent Pi mutations cannot overlap a pending native retry dialog", () => fixture(async ({ options, controls, effects }) => {
  controls.capacity = true; const tool = createPiPreparationTool(options);
  await tool.execute("request", { action: "request" }, undefined, undefined, context());
  let resolveChoice: (value: string | undefined) => void = () => { throw new Error("dialog missing"); };
  const waiting = tool.execute("retry-one", { action: "retry" }, undefined, undefined, context(() => new Promise((resolve) => { resolveChoice = resolve; })));
  await assert.rejects(tool.execute("retry-two", { action: "retry" }, undefined, undefined, context()), /Condition:/);
  await assert.rejects(tool.execute("request-two", { action: "request" }, undefined, undefined, context()), /Condition:/);
  assert.equal((await tool.execute("status", { action: "status" }, undefined, undefined, context())).details.state, "not-ready-capacity");
  resolveChoice(undefined); assert.equal((await waiting).details.state, "cancelled"); assert.equal(effects.get("reservation"), 1);
}));

for (const mode of ["rpc", "json", "print"] as const) {
  test(`native preparation is unavailable in ${mode}, even with forged active environment/binding`, () => fixture(async ({ options, root }) => {
    const tool = createPiPreparationTool(options);
    await assert.rejects(tool.execute("request", { action: "request" }, undefined, undefined, { ...context(), mode }), /Condition:/);
    assert.equal(readdirSync(root).length, 0);
  }));
}

for (const patch of [{ PA_MODE: "analyze-auto" }, { PA_MODE: "spike" }, { PA_TEAM: "rogue-one", PA_MODE: "rogue-one" }, { PA_TEAM: "builder", PA_MODE: "orchestrator" }, { [PA_PI_EXECUTION_MODE_ENV]: "background" }]) {
  test(`mode-scoped preparation registration rejects ${JSON.stringify(patch)}`, () => {
    assert.equal(isInteractivePreparationEnvironment({ ...env, ...patch }), false);
    const registered: string[] = [];
    createPiPreparedWorkflowModule({ env: { ...env, ...patch } })({ registerTool: (tool) => registered.push(tool.name) });
    assert.deepEqual(registered, []);
  });
}

test("actual PA module dispatch registers the bounded tool only for foreground interactive requirements", () => {
  const keys = ["PA_TEAM", "PA_MODE", PA_PI_EXECUTION_MODE_ENV]; const previous = keys.map((key) => process.env[key]);
  try {
    Object.assign(process.env, env);
    const tools = new Map<string, PiToolDefinition>();
    registerPaToolsModule({ registerTool: (tool) => tools.set(tool.name, tool as PiToolDefinition) });
    assert.ok(tools.has("pa_preparation")); assert.equal(Check(tools.get("pa_preparation")!.parameters, { action: "retry", source: "forged" }), false);
    process.env.PA_MODE = "analyze-auto";
    const other: string[] = []; registerPaToolsModule({ registerTool: (tool) => other.push(tool.name) });
    assert.equal(other.includes("pa_preparation"), false);
  } finally { for (const [index, key] of keys.entries()) { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; } }
});

test("default native guard does not mistake environment fields for a runtime binding", async () => {
  const tool = createPiPreparationTool({ env: { ...env, PA_PREPARED_ACTIVE: "1" } });
  await assert.rejects(tool.execute("status", { action: "status" }, undefined, undefined, context()), /Condition:/);
});

test("native guard checks registry, canonical roots, process incarnation/lineage and session instead of trusting environment", () => {
  const nativeEnv = { ...env, PA_DEPLOYMENT_ID: caller.deploymentId, PA_TICKET_ID: caller.ticket, PA_REPO: caller.repoRoot, PA_WORKTREE_ROOT: caller.repoRoot };
  const status: DeploymentStatus = { deploy_id: caller.deploymentId, team: "requirements", mode: "analyze", runtime: "pi", status: "running", started_at: time,
    agents: [], pid: 100, ticket_id: caller.ticket, repo: caller.repoRoot, repo_root: caller.repoRoot, worktree_root: caller.repoRoot };
  const nativeContext = { ...context(), sessionManager: { getSessionId: () => "fixture-session" } };
  const dependencies: PiPreparationCallerDependencies = {
    getDeploymentStatus: () => status,
    resolveRepository: (root) => ({ repoKey: caller.repoKey, repoRoot: root, worktreeRoot: root, repositoryCwd: root }),
    physicalRoot: (root) => root, cwd: () => caller.repoRoot, pid: 101,
    fingerprint: (pid) => ({ pid, startTimeTicks: "123", bootId: "PRIVATE-PROCESS-SENTINEL" }), inLineage: () => true,
  };
  const authenticated = authenticatePiPreparationCaller(nativeContext, nativeEnv, dependencies);
  assert.equal(authenticated.deploymentId, caller.deploymentId); assert.equal(authenticated.repoRoot, caller.repoRoot);
  assert.match(authenticated.callerIdentity, /^[0-9a-f]{64}$/); assert.doesNotMatch(JSON.stringify(authenticated), /PRIVATE-PROCESS-SENTINEL|startTimeTicks|bootId/);
  for (const patch of [{ deploy_id: "d-999999" }, { status: "dead" }, { runtime: "opencode" }, { mode: "analyze-auto" }, { team: "builder" }, { ticket_id: "PAP-999" }, { pid: undefined },
    { repo: "/other" }, { worktree_root: "/other" }, { repo_root: "/other" }, { builder_authority: "orchestrator" }, { treehouse_path: "/other" },
    { repository_permit: 1 }, { ticket_slot_id: "private" }, { rogue_one: true }]) {
    assert.throws(() => authenticatePiPreparationCaller(nativeContext, nativeEnv, { ...dependencies, getDeploymentStatus: () => ({ ...status, ...patch }) as DeploymentStatus }));
  }
  for (const patch of [{ PA_REPO: "/other" }, { PA_WORKTREE_ROOT: "/other" }, { PA_MODE: "spike" }, { PA_TICKET_ID: "PAP-999" }]) {
    assert.throws(() => authenticatePiPreparationCaller(nativeContext, { ...nativeEnv, ...patch }, dependencies));
  }
  assert.throws(() => authenticatePiPreparationCaller({ ...nativeContext, cwd: "/other" }, nativeEnv, dependencies));
  assert.throws(() => authenticatePiPreparationCaller({ ...nativeContext, sessionManager: undefined }, nativeEnv, dependencies));
  assert.throws(() => authenticatePiPreparationCaller(nativeContext, nativeEnv, { ...dependencies, physicalRoot: () => "/other" }));
  assert.throws(() => authenticatePiPreparationCaller(nativeContext, nativeEnv, { ...dependencies, cwd: () => "/other" }));
  assert.throws(() => authenticatePiPreparationCaller(nativeContext, nativeEnv, { ...dependencies, inLineage: () => false }));
  assert.throws(() => authenticatePiPreparationCaller(nativeContext, nativeEnv, { ...dependencies, fingerprint: () => undefined }));
  assert.throws(() => authenticatePiPreparationCaller(nativeContext, nativeEnv, { ...dependencies, resolveRepository: () => ({ repoKey: caller.repoKey, repoRoot: "/other", worktreeRoot: "/other", repositoryCwd: "/other" }) }));
});

test("asynchronous binding/caller resolution is rejected, not mistaken for active authority", () => fixture(async ({ options, root }) => {
  const badBinding = createPiPreparationTool({ ...options, resolveBinding: (async () => { throw new Error("PRIVATE-ASYNC-BINDING"); }) as never });
  await assert.rejects(badBinding.execute("request", { action: "request" }, undefined, undefined, context()), /Condition:/);
  const badCaller = createPiPreparationTool({ ...options, authenticateCaller: (async () => { throw new Error("PRIVATE-ASYNC-CALLER"); }) as never });
  await assert.rejects(badCaller.execute("request", { action: "request" }, undefined, undefined, context()), /Condition:/);
  assert.equal(readdirSync(root).length, 0);
}));

test("registry lifetime tracking rejects calls after session shutdown", () => fixture(async ({ options }) => {
  let closed = 0; const lifecycle = createPiSessionLifecycle(() => { closed += 1; });
  const tool = createPiPreparationTool(options, lifecycle);
  await lifecycle.shutdown(); assert.equal(closed, 1);
  await assert.rejects(tool.execute("request", { action: "request" }, undefined, undefined, context()), /Condition:/);
}));

test("status projection never spreads protected host extras into public details", () => fixture(async ({ options, service }) => {
  const original = service.status.bind(service);
  service.status = (input) => ({ ...original(input), privateToken: "PRIVATE-PROJECTION-SENTINEL", processFingerprint: { pid: 42 } });
  const result = await createPiPreparationTool(options).execute("status", { action: "status" }, undefined, undefined, context());
  assert.equal(result.details.state, "not-requested"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-PROJECTION-SENTINEL|privateToken|processFingerprint/);
}));

/** Real local Git/capacity/worktree owners; only native approval and Treehouse allocation are isolated fakes. */
function resourceFixture(action: (fixture: {
  root: string; repo: string; checkout: string; approvedBase: string; developHead: string; input: PreparationContract;
  tickets: TicketStore; service: PreparedWorkflowService; restart: () => PreparedWorkflowService;
  git: (args: readonly string[], cwd?: string) => Buffer;
  controls: { leased: boolean; poolFull: boolean; active: boolean; crashAfterGet: boolean; crashAfterBranch: boolean; gets: number; branches: number; calls: string[][] };
}) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-preparation-resources-")); const repo = join(root, "repo"); const checkout = join(root, "slot");
  const config = join(root, "config"); const ticketRoot = join(root, "tickets"); const protectedRoot = join(root, "protected");
  for (const path of [repo, config, ticketRoot, protectedRoot]) mkdirSync(path, { mode: 0o700 });
  const previous = process.env.PA_PLATFORM_CONFIG;
  const git = (args: readonly string[], cwd = repo): Buffer => execFileSync("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const controls = { leased: false, poolFull: false, active: true, crashAfterGet: false, crashAfterBranch: false, gets: 0, branches: 0, calls: [] as string[][] };
  let input: PreparationContract; let tickets: TicketStore; let approvedBase: string; let developHead: string;
  const setup = () => {
    git(["init", "-b", "develop"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.test"]);
    writeFileSync(join(repo, "README.md"), "approved base\n"); git(["add", "README.md"]); git(["commit", "-m", "approved base"]);
    approvedBase = git(["rev-parse", "HEAD"]).toString().trim();
    git(["clone", "--bare", repo, join(root, "remote.git")], root); git(["remote", "add", "origin", join(root, "remote.git")]);
    writeFileSync(join(repo, "README.md"), "develop advanced after approval\n"); git(["commit", "-am", "later develop"]); git(["push", "origin", "develop"]);
    developHead = git(["rev-parse", "HEAD"]).toString().trim();
    git(["worktree", "add", "--detach", checkout, approvedBase]);
    writeFileSync(join(config, "config.yaml"), `repos:\n  fixture:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n    feature_branch_pattern: feature/<ticket>-<topic>\n`);
    process.env.PA_PLATFORM_CONFIG = config;
    tickets = new TicketStore(ticketRoot);
    writeFileSync(join(ticketRoot, "PAP-256.json"), JSON.stringify({ id: "PAP-256", project: "fixture", title: "prepared fixture",
      linkedBranches: [{ repo: "fixture", branch: "feature/PAP-256-fixture", state: "planned", linkedAt: time, linkedBy: "fixture" }] }));
    input = parsePreparationContract({ ...contract(), repoRoot: repo, approvalBaseSha: approvedBase });
  };
  const treehouse = new TreehouseClient({ run: (args, cwd) => {
    assert.equal(cwd, repo);
    const result = (value: unknown) => ({ status: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) });
    if (args[0] === "--version") return { status: 0, stdout: Buffer.from("v3.1.3\n"), stderr: Buffer.alloc(0) };
    const lease = { path: checkout, leased: true, lease_id: "fixture-lease", lease_holder: "pa:fixture:PAP-256" };
    if (args[0] === "status") return result(controls.leased ? [lease] : controls.poolFull ? [{ ...lease, lease_id: "other-lease", lease_holder: "pa:fixture:PAP-999" }] : [{ path: checkout, leased: false }]);
    assert.deepEqual(args, ["get", "--lease", "--lease-holder", "pa:fixture:PAP-256", "--json"]);
    controls.gets += 1; controls.leased = true;
    if (controls.crashAfterGet) { controls.crashAfterGet = false; throw new Error("fixture crash after allocation"); }
    return result(lease);
  } });
  const runGit = (args: readonly string[], cwd: string): Buffer => {
    controls.calls.push([...args]); const result = git(args, cwd);
    if (args[0] === "checkout" && args.includes("-b")) {
      controls.branches += 1;
      if (controls.crashAfterBranch) { controls.crashAfterBranch = false; throw new Error("fixture crash after branch before ticket promotion"); }
    }
    return result;
  };
  const restart = () => new PreparedWorkflowService(new ProtectedWorkflowStore(protectedRoot), createPiPreparationHost(input, {
    authorize() { if (!controls.active) throw new Error("inactive fixture authority"); },
    assertCurrentBindings(value) { if (!controls.active || JSON.stringify(value) !== JSON.stringify(input)) throw new Error("stale fixture authority"); },
    treehouse, ticketStore: tickets, runGit, now: () => time,
    resolveConsumer(value) {
      if (value.ref !== "lineage:builder") throw new Error("wrong fixture consumer");
      const process = readProcessFingerprint(globalThis.process.pid); if (!process) throw new Error("fixture process unavailable");
      return { lineageId: "lineage:fixture", holder: { deploymentId: "d-abc123", process } };
    },
  }));
  return Promise.resolve().then(setup).then(() => action({ root, repo, checkout, approvedBase: approvedBase!, developHead: developHead!, input: input!, tickets: tickets!, service: restart(), restart, git, controls }))
    .finally(() => { if (previous === undefined) delete process.env.PA_PLATFORM_CONFIG; else process.env.PA_PLATFORM_CONFIG = previous; rmSync(root, { recursive: true, force: true }); });
}

test("AC3/AC6/AC12 fixed host: exact approved base despite newer develop, one allocation/materialization, same-reservation consume and canonical dirt preserved", () => resourceFixture(({ repo, checkout, input, service, approvedBase, developHead, git, controls }) => {
  writeFileSync(join(repo, "unrelated.txt"), "preserved canonical dirt\n");
  const before = git(["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  const ready = service.request(input); assert.equal(ready.state, "ready"); assert.equal(ready.receipt?.preparationBaseSha, approvedBase);
  assert.equal(ready.receipt?.preparedHeadSha, approvedBase); assert.notEqual(approvedBase, developHead);
  assert.equal(git(["rev-parse", "HEAD"], checkout).toString().trim(), approvedBase);
  assert.equal(controls.gets, 1); assert.equal(controls.branches, 1);
  assert.deepEqual(service.request(input), ready); assert.equal(controls.gets, 1); assert.equal(controls.branches, 1);
  assert.equal(controls.calls.filter((args) => args[0] === "fetch").length, 1);
  assert.ok(controls.calls.some((args) => JSON.stringify(args) === JSON.stringify(["fetch", "--", "origin", "refs/heads/develop:refs/remotes/origin/develop"])));
  const reserved = withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, (tx) => tx.inventory());
  const consumed = service.consume(input, source("lineage:builder")); assert.equal(consumed.state, "consumed");
  const active = withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, (tx) => tx.inventory());
  assert.equal(active.length, 1); assert.equal(active[0]!.repositoryPermit, reserved[0]!.repositoryPermit);
  assert.equal("reservationId" in active[0]! && "reservationId" in reserved[0]! && active[0].reservationId, "reservationId" in reserved[0]! && reserved[0].reservationId);
  assert.deepEqual(service.consume(input, source("lineage:builder")), consumed);
  assert.throws(() => service.consume(input, source("lineage:other")));
  assert.equal(controls.gets, 1); assert.equal(controls.branches, 1);
  assert.deepEqual(git(["status", "--porcelain=v2", "-z", "--untracked-files=all"]), before);
  assert.equal(git(["rev-parse", "HEAD"]).toString().trim(), developHead);
}));

test("AC4 fixed host: a fifth ticket is capacity-not-ready before Treehouse get or branch/fetch effects", () => resourceFixture(({ repo, input, service, controls }) => {
  withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, (tx) => {
    for (let index = 1; index <= 4; index += 1) tx.reserve({ ticket: `PAP-${index}`, operationId: index.toString(16).padStart(64, "0"),
      reservationId: (index + 100).toString(16).padStart(64, "0"), retainedAt: time });
  });
  const full = service.request(input); assert.equal(full.state, "not-ready-capacity"); assert.deepEqual(full.completedActions, []);
  assert.equal(controls.gets, 0); assert.equal(controls.branches, 0); assert.equal(controls.calls.length, 0);
  assert.equal(withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, (tx) => tx.inventory()).length, 4);
}));

test("AC4 fixed host: physical pool full retains one reservation and only an explicit later retry allocates", () => resourceFixture(({ repo, input, service, controls }) => {
  controls.poolFull = true;
  const full = service.request(input); assert.equal(full.state, "not-ready-capacity"); assert.equal(controls.gets, 0); assert.equal(controls.branches, 0);
  assert.equal(withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, (tx) => tx.inventory()).length, 1);
  controls.poolFull = false; assert.deepEqual(service.request(input), full); assert.equal(controls.gets, 0);
  const retried = service.retry(input, source("fixture-native:retry")); assert.equal(retried.state, "ready"); assert.equal(retried.attempt, 2);
  assert.equal(controls.gets, 1); assert.equal(controls.branches, 1);
  assert.equal(withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, (tx) => tx.inventory()).length, 1);
}));

test("AC3 fixed host: allocation succeeds before a crash; fresh service observes it without a second get", () => resourceFixture(({ input, service, restart, controls }) => {
  controls.crashAfterGet = true; assert.throws(() => service.request(input));
  assert.equal(service.status(input).state, "uncertain-blocked"); assert.equal(controls.gets, 1);
  assert.equal(restart().request(input).state, "ready"); assert.equal(controls.gets, 1); assert.equal(controls.branches, 1);
}));

test("AC3/AC5 fixed host: crash after exact branch creation resumes only ticket publication, not branch construction", () => resourceFixture(({ input, service, restart, tickets, controls }) => {
  controls.crashAfterBranch = true; assert.throws(() => service.request(input));
  assert.equal(tickets.get(input.ticket)!.linkedBranches[0]!.state, "planned"); assert.equal(controls.branches, 1);
  const ready = restart().request(input); assert.equal(ready.state, "ready"); assert.equal(controls.branches, 1); assert.equal(controls.gets, 1);
  assert.equal(tickets.get(input.ticket)!.linkedBranches[0]!.state, "materialized");
}));

test("AC5 fixed host: changed branch after interrupted creation is preserved, never reset into approval", () => resourceFixture(({ checkout, input, service, restart, git, controls }) => {
  controls.crashAfterBranch = true; assert.throws(() => service.request(input));
  writeFileSync(join(checkout, "unknown.txt"), "unknown accepted ownership\n"); git(["add", "unknown.txt"], checkout); git(["commit", "-m", "unknown work"], checkout);
  const unknownHead = git(["rev-parse", "HEAD"], checkout).toString().trim();
  assert.throws(() => restart().request(input)); assert.equal(controls.branches, 1);
  assert.equal(git(["rev-parse", "HEAD"], checkout).toString().trim(), unknownHead); assert.equal(readFileSync(join(checkout, "unknown.txt"), "utf8"), "unknown accepted ownership\n");
}));

for (const name of [REPOSITORY_MUTATION_LEASE_FILE, REPOSITORY_IMPLEMENT_LEASE_FILE, REPOSITORY_MUTATION_BORROWER_FILE, REPOSITORY_REVIEW_RESERVATION_FILE]) {
  test(`AC5/AC6 fixed host: any retained ${name} blocks preparation without cleanup`, () => resourceFixture(({ checkout, input, service, git, controls }) => {
    const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], checkout).toString().trim();
    writeFileSync(join(gitDir, name), "unknown retained authority\n", { mode: 0o600 });
    assert.throws(() => service.request(input)); assert.equal(controls.branches, 0); assert.equal(readFileSync(join(gitDir, name), "utf8"), "unknown retained authority\n");
  }));
}

test("fixed host refuses an async source-binding gate before any allocation or reservation", () => resourceFixture(({ root, repo, input, controls }) => {
  const authority = join(root, "async-authority"); mkdirSync(authority, { mode: 0o700 });
  const service = new PreparedWorkflowService(new ProtectedWorkflowStore(authority), createPiPreparationHost(input, {
    authorize() {}, assertCurrentBindings: async () => { throw new Error("PRIVATE-ASYNC-SOURCE-BINDING"); }, now: () => time,
  }));
  assert.throws(() => service.request(input), /Condition:/);
  assert.equal(controls.gets, 0); assert.equal(controls.branches, 0);
  assert.equal(withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, (tx) => tx.inventory()).length, 0);
}));

test("AC6 fixed host: candidate drift after ready invalidates consumption, leaving the resource and reservation intact", () => resourceFixture(({ repo, checkout, input, service, tickets, git }) => {
  service.request(input);
  writeFileSync(join(checkout, "candidate.txt"), "new candidate\n"); git(["add", "candidate.txt"], checkout); git(["commit", "-m", "candidate changed"], checkout);
  tickets.update(input.ticket, { add_linked_branch: { repo: "fixture", branch: input.branch, linkedBy: "fixture" } }, "fixture");
  assert.throws(() => service.consume(input, source("lineage:builder")));
  assert.equal(service.status(input).state, "uncertain-blocked");
  const rows = withPreparedTicketCapacity({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo }, (tx) => tx.inventory());
  assert.equal(rows.length, 1); assert.equal("occupancy" in rows[0]! && rows[0].occupancy, "idle-ready");
}));
