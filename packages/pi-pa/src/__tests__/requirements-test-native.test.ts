import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { RequirementsTestLaunch, RequirementsTestNativeAuthority, RequirementsTestNativeExecutor, RequirementsTestNativeOptions } from "../requirements-test-native.js";
import type { TestAuthorization, TestGitEvidence, TestResource, TestWorkflowEvent, TestEventData } from "../../../pa-core/src/deploy/requirements-test-workflow.js";

// This is SOURCE integration, not installed/pair/operator/human qualification.
// Real Git, protected publication, shared owner locks and barrier processes are
// exercised. Treehouse command replies and approval/result producers are isolated
// fixture ports. No synthetic positive flag is accepted as production authority.
const suiteRoot = mkdtempSync(join(tmpdir(), "pap265-native-source-"));
const saved = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("PA_") || key.startsWith("PI_") || key.startsWith("GIT_")) delete process.env[key];
process.env.PA_PLATFORM_CONFIG = join(suiteRoot, "config");
process.env.PA_PLATFORM_HOME = join(suiteRoot, "platform");
process.env.PA_PLATFORM_DATA = join(suiteRoot, "data");
process.env.PA_AI_USAGE_HOME = join(suiteRoot, "ai-usage");
process.env.HOME = suiteRoot;
for (const path of [process.env.PA_PLATFORM_CONFIG, process.env.PA_PLATFORM_HOME, process.env.PA_PLATFORM_DATA, process.env.PA_AI_USAGE_HOME]) mkdirSync(path, { recursive: true });
const core = await import("@pa-platform/pa-core");
const { RequirementsTestNativeService, assertNoRequirementsTestLegacyFallback, requestPiRequirementsTestNative, verifyRequirementsTestGit } = await import("../requirements-test-native.js");
const { TreehouseClient } = await import("../treehouse.js");
const { PiPreparedNativeAuthority } = await import("../prepared-native.js");
const { workflowDigest: digest, ProtectedWorkflowStore, TicketStore, readProcessFingerprint, parseTestAuthorization, assessTestWorkflow, withPreparedWorkflowLocks, withPreparedTicketCapacity, acquireRepositoryTicketSlot, captureRepositoryGitSnapshot } = core;
const source = (name: string) => ({ ref: `source-fixture:${name}`, version: "r001", sha256: digest(name) });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const waitFile = (path: string): void => {
  const end = Date.now() + 5000;
  while (!existsSync(path)) { if (Date.now() >= end) throw new Error("isolated process barrier timed out"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
};
const publish = (store: InstanceType<typeof ProtectedWorkflowStore>, id: string, value: unknown): void => {
  withPreparedWorkflowLocks({ repository: (run) => run(), worktree: (run) => run() }, (scope) => store.publish(scope, `${id}.intent.json`, value));
};
function packet(repo: string, base: string, ticket = "PAP-1"): TestAuthorization {
  const baseline = { id: "baseline", kind: "baseline", assertion: "Q2", reason: "preserved", controlFor: null, input: source("valid-input"), command: "node test/oracle.mjs --baseline", cwd: ".", environment: [], timeoutSeconds: 30, maxOutputBytes: 4096 };
  return parseTestAuthorization(JSON.stringify({ schemaVersion: "requirements-test-workflow/v1", kind: "authorization", operationId: digest(`${repo}:${ticket}`),
    repository: { key: "registered", root: repo, ticket, baseSha: base, selectedHeadSha: base, branch: `feature/${ticket}-oracle` },
    parent: { holder: { deploymentId: "d-111111", process: readProcessFingerprint(process.pid) }, runtime: "pi", team: "requirements", mode: "analyze", channel: "foreground", root: repo },
    contract: source("contract"), assertions: source("assertions"), pair: { runtimeSha: "b".repeat(40), configSha: "c".repeat(40), qualification: source("pair"), toolsAuditDecision: source("tools-audit-not-sandbox") },
    approvalOwner: "sinh", scope: "test-only", productBehavior: "forbidden", paths: [{ path: "test/oracle.mjs", role: "test", existence: "new", beforeSha256: null, actions: ["write", "edit"], rationale: "Q1/Q2 plus intact-values wrong-output control" }],
    checks: [baseline, { ...baseline, id: "feature", kind: "feature", assertion: "Q1", reason: "missing-through-T", command: "node test/oracle.mjs --feature" }, { ...baseline, id: "control", kind: "control", assertion: "Q1", reason: "missing-through-T", command: "node test/oracle.mjs --wrong-output", controlFor: "feature", input: source("intact-values-wrong-consumer-output") }], humanOnly: ["recipient-observation"],
    bounds: { startedAt: "2026-10-21T23:00:00.000Z", deadlineAt: "2026-10-22T01:00:00.000Z", runtimeMinutes: 120, consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null }, retryLimit: 3, retriesUsed: 0, elapsedMs: 0, cancellation: "retain", resume: "first-unproven", amendment: null }));
}
let serial = 0;
async function fixture(boundary?: RequirementsTestNativeOptions["boundary"]) {
  const root = join(suiteRoot, `f-${++serial}`); mkdirSync(root);
  const repo = join(root, "canonical"); mkdirSync(repo);
  git(repo, "init", "-b", "develop"); git(repo, "config", "user.name", "Source Test"); git(repo, "config", "user.email", "source-test@example.invalid");
  mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/product.txt"), "unchanged product baseline\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "initial"); const base = git(repo, "rev-parse", "HEAD");
  const worktree = join(root, "ticket"); git(repo, "worktree", "add", "--detach", worktree, base);
  writeFileSync(join(process.env.PA_PLATFORM_CONFIG!, "config.yaml"), `repos:\n  registered:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n`);
  const ticketsRoot = join(root, "tickets"); mkdirSync(ticketsRoot); const tickets = new TicketStore(ticketsRoot);
  const auth = packet(repo, base); let raw = JSON.stringify(auth);
  const ticketPath = join(ticketsRoot, "PAP-1.json");
  writeFileSync(ticketPath, JSON.stringify({ id: "PAP-1", project: "registered", title: "isolated source test", linkedBranches: [{ repo: "registered", branch: auth.repository.branch, state: "planned", linkedAt: "2026-10-21T23:00:00.000Z", linkedBy: "fixture" }] }));
  const nativeRoot = join(root, "native"); mkdirSync(nativeRoot, { mode: 0o700 }); const operationsRoot = join(nativeRoot, "operations"); mkdirSync(operationsRoot, { mode: 0o700 });
  const store = new ProtectedWorkflowStore(operationsRoot);
  const grantId = digest("isolated-unit-test-authorization");
  publish(store, grantId, { schemaVersion: "source-fixture-capture/v1", raw, sha256: digest(raw) });
  let history: string[] = []; let finalHash: string | null = null; let retryDecision: string | null = null;
  const authority: RequirementsTestNativeAuthority = {
    readAuthorization: () => raw,
    authorizationDecision: () => source("unit-modeled-test-decision"),
    assertAuthorization(value, sha) {
      const record = store.read(`${grantId}.intent.json`) as { raw: string; sha256: string };
      assert.equal(record.sha256, sha); assert.equal(record.raw, raw); assert.equal(value.operationId, auth.operationId);
      assert.deepEqual(value.parent.holder.process, readProcessFingerprint(process.pid));
    },
    assertRetainedAuthorization(value, sha) { assert.equal(value.operationId, auth.operationId); assert.equal(sha, digest(JSON.stringify(auth))); },
    readFinalHistory: () => history,
    assertFinalApproval(_auth, assessment) { assert.equal(finalHash, assessment.historySha256.at(-1)); assert.equal(assessment.state, "final-approved"); },
    readPreviousAuthorization() { throw new Error("no unit amendment approval captured"); },
    assertAmendment() { throw new Error("no unit amendment approval captured"); },
    assertCapacityRetry(_auth, decision) { assert.equal(decision.sha256, retryDecision); },
  };
  let leased = false; let allocationCount = 0; let failAllocation = false;
  const lease = { path: worktree, leaseId: "unit-lease", leaseHolder: "pa:registered:PAP-1" };
  const treehouse = new TreehouseClient({ run(args) {
    if (args[0] === "--version") return { status: 0, stdout: Buffer.from("v3.1.3\n"), stderr: Buffer.alloc(0) };
    if (args[0] === "status") return { status: 0, stdout: Buffer.from(JSON.stringify(leased ? [{ path: worktree, leased: true, lease_id: lease.leaseId, lease_holder: lease.leaseHolder }] : [])), stderr: Buffer.alloc(0) };
    assert.equal(args[0], "get"); allocationCount++; leased = true;
    if (failAllocation) throw Object.assign(new Error("source-fixture-allocation-canary"), { stdout: Buffer.from("private original stdout"), stderr: Buffer.from("private original stderr") });
    return { status: 0, stdout: Buffer.from(JSON.stringify({ path: worktree, leased: true, lease_id: lease.leaseId, lease_holder: lease.leaseHolder })), stderr: Buffer.alloc(0) };
  } });
  const processes = new Map<string, { child: ChildProcess; launch: RequirementsTestLaunch; started: string; terminal: string; parked: string }>();
  const effects = { prepare: 0, start: 0 };
  const executor: RequirementsTestNativeExecutor = {
    prepare(role, intent, resource) {
      effects.prepare++;
      const directory = join(root, `process-${effects.prepare}`); mkdirSync(directory, { mode: 0o700 });
      const parked = join(directory, "parked"); const started = join(directory, "started"); const terminal = join(directory, "terminal");
      // Native process, not a fixture-provided live/settled boolean. No inherited
      // deployment/ticket/tasks/credentials and no repository code is run here.
      const child = spawn(process.execPath, ["-e", `const fs=require('node:fs');fs.writeFileSync(process.argv[1],'parked');let text='';process.stdin.on('data',b=>{text+=b;let i;while((i=text.indexOf('\\n'))>=0){const s=text.slice(0,i);text=text.slice(i+1);if(s==='stop')process.exit(0);fs.writeFileSync(process.argv[2],s);}});`, parked, started], { cwd: resource.worktreeRoot, env: { PATH: process.env.PATH, HOME: suiteRoot, LANG: "C.UTF-8", TZ: "UTC" }, stdio: ["pipe", "ignore", "ignore"] });
      child.stdin!.on("error", () => undefined); waitFile(parked);
      const fp = readProcessFingerprint(child.pid!); assert.ok(fp);
      const holder = { deploymentId: `d-${(0x222222 + effects.prepare - 1).toString(16)}`, process: fp };
      const registry = source(`private-registry-${intent}`);
      const launch = { holder, deploymentDirectory: directory, registry };
      writeFileSync(join(directory, "registry.json"), JSON.stringify({ holder, role, resource, intent, state: "parked" }), { mode: 0o600 });
      processes.set(intent, { child, launch, started, terminal, parked }); return launch;
    },
    inspect(_role, intent) { const record = processes.get(intent); assert.ok(record, "unknown is not absence and cannot respawn"); return record.launch; },
    assertParked(launch, resource, role) {
      const record = [...processes.values()].find((row) => row.launch.holder.process.pid === launch.holder.process.pid); assert.ok(record);
      assert.deepEqual(readProcessFingerprint(launch.holder.process.pid), launch.holder.process);
      const registry = JSON.parse(readFileSync(join(launch.deploymentDirectory, "registry.json"), "utf8"));
      assert.deepEqual(registry.holder, launch.holder); assert.deepEqual(registry.resource, resource); assert.equal(registry.role, role); assert.equal(existsSync(record.started), false);
    },
    start(launch, intent) {
      effects.start++;
      const record = [...processes.values()].find((row) => row.launch.holder.process.pid === launch.holder.process.pid); assert.ok(record);
      record.child.stdin!.write(`${intent}\n`); waitFile(record.started); assert.equal(readFileSync(record.started, "utf8"), intent);
    },
    assertStarted(launch, intent) { assert.equal(readFileSync(join(launch.deploymentDirectory, "started"), "utf8"), intent); },
    assertSettled(launch) {
      assert.equal(readProcessFingerprint(launch.holder.process.pid), undefined);
      const record = JSON.parse(readFileSync(join(launch.deploymentDirectory, "terminal"), "utf8")); assert.deepEqual(record.holder, launch.holder); assert.equal(record.state, "terminal");
    },
  };
  const options = { store, authority, executor, tickets, treehouse, now: () => "2026-10-21T23:10:00.000Z", boundary };
  const service = new RequirementsTestNativeService(options);
  const stop = async (launch?: RequirementsTestLaunch, registry = true) => {
    for (const record of processes.values()) {
      if (launch && record.launch.holder.process.pid !== launch.holder.process.pid) continue;
      if (record.child.exitCode === null) { record.child.stdin!.write("stop\n"); await new Promise<void>((resolve) => record.child.once("exit", () => resolve())); }
      if (registry) writeFileSync(record.terminal, JSON.stringify({ holder: record.launch.holder, state: "terminal" }), { mode: 0o600 });
    }
  };
  const inventory = () => withPreparedTicketCapacity({ canonicalRepoKey: "registered", canonicalRepoRoot: repo }, (owner) => owner.inventory());
  const records = () => store.records().map((name) => store.read(name) as Record<string, unknown>).filter((row) => row.schemaVersion === "requirements-test-native/v1").sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const final = (resource: TestResource): TestGitEvidence => {
    mkdirSync(join(worktree, "test"), { recursive: true }); writeFileSync(join(worktree, "test/oracle.mjs"), "// modeled oracle source, not executed by phase 2\n");
    git(worktree, "add", "test/oracle.mjs"); git(worktree, "commit", "-m", "test: exact oracle source"); const head = git(worktree, "rev-parse", "HEAD");
    const sha256 = digest(readFileSync(join(worktree, "test/oracle.mjs")));
    const evidence: TestGitEvidence = { baseSha: base, initialHeadSha: base, testHeadSha: head, ancestry: [base], commits: [{ sha: head, parentSha: base, changes: [{ path: "test/oracle.mjs", previousPath: null, beforeSha256: null, afterSha256: sha256 }] }], files: [{ path: "test/oracle.mjs", sha256 }], porcelainV2Base64: "", inventory: source("source-fixture-git-inventory") };
    const launch = [...processes.values()][0]!.launch;
    const append = (data: TestEventData) => {
      const entry: TestWorkflowEvent = { schemaVersion: "requirements-test-workflow/v1", kind: "event", operationId: auth.operationId, authorizationSha256: digest(raw), sequence: history.length + 1, previousSha256: digest(history.at(-1) ?? raw), bounds: auth.bounds, retriesUsed: 0, elapsedMs: (history.length + 1) * 1000, evidence: source(`modeled-event-${history.length}`), data };
      history.push(JSON.stringify(entry));
    };
    append({ action: "authorized", owner: "sinh", decision: source("unit-modeled-test-decision") });
    const testIntent = digest(JSON.stringify([auth.operationId, "reservation"]));
    append({ action: "intent-recorded", intentId: testIntent });
    const row = inventory()[0]!; assert.ok("custody" in row);
    const start = records().find((record) => record.step === "test-start" && record.state === "observed")!.value as { launchSnapshot: unknown };
    append({ action: "test-holder-active", intentId: testIntent, resource, holder: launch.holder, inventory: [{ ...row, occupancy: "active", custody: { state: "implement-child", holder: launch.holder, inFlightOperation: null } }], registry: launch.registry, launchSnapshot: { ref: "requirements-test-native:launch-snapshot", version: "requirements-test-native/v1", sha256: digest(JSON.stringify(start.launchSnapshot)) } });
    append({ action: "test-settled", holder: launch.holder, settlement: source("unit-process-settlement"), git: evidence, results: auth.checks.map((check, index) => ({ checkId: check.id, command: check.command, cwd: check.cwd, environment: check.environment, candidateSha: head, input: check.input, process: launch.holder, stdout: source(`modeled-stdout-${index}`), stderr: source(`modeled-stderr-${index}`), assertionEvidence: source(`modeled-assertion-${index}`), exitCode: index === 0 ? 0 : 1, signal: null, disposition: "exited", startedElapsedMs: 3000 + index * 100, finishedElapsedMs: 3100 + index * 100, durationMs: 100, outputBytes: 100, truncated: false, observations: [{ assertion: check.assertion, outcome: index === 0 ? "satisfied" : "violated", reason: check.reason }] })) });
    const oracle = assessTestWorkflow(raw, history).oracle!;
    append({ action: "oracle-reviewed", oracle, reviewer: "sinh", delegation: null, decision: source("modeled-review-not-human-acceptance"), outcomeRationale: "Q1 through T", wrongOutputRationale: "intact source values, wrong output rejected" });
    append({ action: "final-approved", owner: "sinh", oracle, reviewSha256: digest(history.at(-1)!), pair: { requirements: source("final-requirements"), uat: source("final-uat"), matrix: { ...source("matrix"), ref: source("final-requirements").ref }, matrixApproval: source("matrix-approval"), finalChecks: source("13-checks"), finalCheckCount: 13 }, decision: source("modeled-whole-document-decision") });
    finalHash = digest(history.at(-1)!); return evidence;
  };
  return { root, repo, worktree, base, auth, raw: () => raw, replaceRaw: (value: string) => { raw = value; }, service, options, store, ticketsRoot, lease, inventory, records, final,
    effects, processes, stop, cleanup: async () => { await stop(); rmSync(root, { recursive: true, force: true }); }, allocationCount: () => allocationCount,
    setAllocationFailure: () => { failAllocation = true; }, setLeaseMissing: () => { leased = false; }, setRetryDecision: (value: string) => { retryDecision = value; },
    setHistory: (value: string[]) => { history = value; }, history: () => history };
}

test("AC1/AC2: inactive entry and forged environment/caller cannot select a new route", async () => {
  const f = await fixture();
  try {
    const before = f.inventory();
    for (const mode of ["analyze", "analyze-auto", "spike", "review", "orchestrator"]) {
      process.env.PA_TEAM = mode === "orchestrator" ? "builder" : "requirements"; process.env.PA_MODE = mode; process.env.PA_DEPLOYMENT_ID = "d-ffffff";
      process.env.PA_TICKET_ID = "PAP-1"; process.env.PA_REPO = f.repo; process.env.PA_WORKTREE_ROOT = f.repo; process.env.PA_PI_EXECUTION_MODE = "foreground";
      assert.throws(() => requestPiRequirementsTestNative({ mode: "tui", cwd: f.repo, sessionManager: { getSessionId: () => "forged" } }));
    }
    for (const key of Object.keys(process.env)) if (key.startsWith("PA_") && !["PA_PLATFORM_CONFIG", "PA_PLATFORM_HOME", "PA_PLATFORM_DATA", "PA_AI_USAGE_HOME"].includes(key)) delete process.env[key];
    assert.deepEqual(f.inventory(), before); assert.equal(f.allocationCount(), 0); assert.equal(f.effects.prepare, 0);
  } finally { await f.cleanup(); }
});
test("AC2: raw approval, ticket/branch, path/input/deadline drift reject before resource/branch/process effects", async () => {
  for (const mutation of ["approval", "branch", "path", "deadline", "source", "version"]) {
    const f = await fixture();
    try {
      const changed = JSON.parse(f.raw());
      if (mutation === "approval") changed.checks[0].command += " changed";
      if (mutation === "branch") { const path = join(f.ticketsRoot, "PAP-1.json"); const ticket = JSON.parse(readFileSync(path, "utf8")); ticket.linkedBranches[0].branch = "feature/PAP-1-other"; writeFileSync(path, JSON.stringify(ticket)); }
      if (mutation === "path") changed.paths[0].path = "../product.ts";
      if (mutation === "deadline") changed.bounds.deadlineAt = changed.bounds.startedAt;
      if (mutation === "source") changed.assertions.sha256 = digest("different-source");
      if (mutation === "version") changed.schemaVersion = "requirements-test-workflow/v2";
      if (mutation !== "branch") f.replaceRaw(JSON.stringify(changed));
      assert.throws(() => f.service.request(f.auth.operationId)); assert.equal(f.allocationCount(), 0); assert.equal(f.effects.prepare, 0); assert.equal(f.inventory().length, 0);
      assert.equal(git(f.worktree, "rev-parse", "HEAD"), f.base); assert.equal(git(f.worktree, "branch", "--show-current"), "");
    } finally { await f.cleanup(); }
  }
});
test("AC3/AC4: durable before-effect correlation, one real holder, shared retained reservation and read-only canonical parent", async () => {
  const f = await fixture();
  try {
    const before = captureRepositoryGitSnapshot(f.repo);
    const result = f.service.request(f.auth.operationId); const row = f.inventory()[0]!;
    assert.ok("purpose" in row); assert.equal(row.purpose, "requirements-test-workflow/v1"); assert.equal(row.occupancy, "active");
    assert.equal(f.allocationCount(), 1); assert.equal(f.effects.prepare, 1); assert.equal(f.effects.start, 1); assert.equal(f.inventory().length, 1);
    assert.equal(result.resource.repositoryPermit, row.repositoryPermit); assert.deepEqual(captureRepositoryGitSnapshot(f.repo), before);
    const records = f.records(); const intent = records.findIndex((row) => row.step === "test-start" && row.state === "intent");
    const process = records.findIndex((row) => row.step === "test-process" && row.state === "observed"); assert.ok(intent > process);
    const value = records[intent]!.value as { resource: TestResource; launch: RequirementsTestLaunch; launchSnapshot: { head: string } };
    assert.deepEqual(value.resource, result.resource); assert.equal(value.launchSnapshot.head, f.base); assert.ok(readProcessFingerprint(value.launch.holder.process.pid));
    const duplicate = acquireRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: f.repo, ticket: "PAP-1", deploymentId: "d-444444", deploymentDirectory: f.root });
    assert.equal(duplicate.status, "rejected"); assert.equal(duplicate.status === "rejected" && duplicate.reason, "duplicate-ticket");
    assert.throws(() => assertNoRequirementsTestLegacyFallback({ repoKey: "registered", repoRoot: f.repo, ticket: "PAP-1" }, new PiPreparedNativeAuthority({ root: join(f.root, "native") })));
  } finally { await f.cleanup(); }
});
test("AC4/AC11: old + prepared + test capacity share four permits; fifth needs exact native manual retry", async () => {
  const f = await fixture();
  try {
    acquireRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: f.repo, ticket: "PAP-2", deploymentId: "d-444444", deploymentDirectory: f.root });
    withPreparedTicketCapacity({ canonicalRepoKey: "registered", canonicalRepoRoot: f.repo }, (tx) => {
      for (const n of [3, 4, 5]) assert.equal(tx.reserve({ ticket: `PAP-${n}`, operationId: digest(`old-${n}`), reservationId: digest(`reservation-${n}`), retainedAt: f.auth.bounds.startedAt }).status, "reserved");
    });
    assert.throws(() => f.service.request(f.auth.operationId)); assert.equal(f.allocationCount(), 0); assert.equal(f.effects.prepare, 0);
    assert.equal(f.inventory().length, 4); assert.equal(f.service.status(f.auth.operationId).state, "blocked");
    const count = f.records().length; assert.throws(() => f.service.request(f.auth.operationId)); assert.equal(f.records().length, count, "no blind replay/full-capacity queue");
    const decision = source("explicit-native-manual-retry"); f.setRetryDecision(decision.sha256);
    f.service.retryCapacity(f.auth.operationId, decision); assert.throws(() => f.service.request(f.auth.operationId));
    const retry = f.records().find((row) => row.step === "capacity-retry")!.value as { retriesUsed: number }; assert.equal(retry.retriesUsed, 1);
    assert.equal(f.inventory().length, 4); assert.equal(f.allocationCount(), 0);
  } finally { await f.cleanup(); }
});
test("AC11/NFR4: third native no-progress failure blocks further manual retry without resetting history", async () => {
  const f = await fixture();
  try {
    withPreparedTicketCapacity({ canonicalRepoKey: "registered", canonicalRepoRoot: f.repo }, (tx) => {
      for (const n of [2, 3, 4, 5]) tx.reserve({ ticket: `PAP-${n}`, operationId: digest(`cap-${n}`), reservationId: digest(`cap-res-${n}`), retainedAt: f.auth.bounds.startedAt });
    });
    const decision = source("exact-capacity-retry"); f.setRetryDecision(decision.sha256);
    for (let count = 1; count <= 3; count++) {
      assert.throws(() => f.service.request(f.auth.operationId));
      if (count < 3) f.service.retryCapacity(f.auth.operationId, decision);
    }
    const count = f.records().length;
    assert.throws(() => f.service.retryCapacity(f.auth.operationId, decision)); assert.throws(() => f.service.request(f.auth.operationId));
    assert.equal(f.records().length, count); assert.equal(f.records().filter((row) => row.state === "failed").length, 3);
    assert.equal(f.effects.prepare, 0); assert.equal(f.allocationCount(), 0);
  } finally { await f.cleanup(); }
});
test("NFR3/NFR6: native stop projects five bounded fields, never raw port errors or canaries", async () => {
  const f = await fixture();
  try {
    const canary = "source-private-canary-".repeat(100);
    const service = new RequirementsTestNativeService({ ...f.options, authority: { ...f.options.authority, assertAuthorization() { throw new Error(canary); } } });
    assert.throws(() => service.request(f.auth.operationId), (error: unknown) => {
      assert.ok(error instanceof Error); assert.ok(error.message.length <= 2000); assert.ok(!error.message.includes(canary));
      for (const field of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.ok(error.message.includes(field)); return true;
    });
    assert.equal(f.effects.prepare, 0); assert.equal(f.allocationCount(), 0);
  } finally { await f.cleanup(); }
});
test("AC11: failed allocation retains private originals and same intent reconciles without a second get", async () => {
  const f = await fixture();
  try {
    f.setAllocationFailure(); assert.throws(() => f.service.request(f.auth.operationId));
    assert.equal(f.allocationCount(), 1); assert.equal(f.inventory().length, 1); assert.equal(f.effects.prepare, 0);
    const original = f.records().find((row) => row.step === "allocation" && row.state === "unknown"); assert.ok(JSON.stringify(original).includes("source-fixture-allocation-canary"));
    assert.ok(JSON.stringify(original).includes(Buffer.from("private original stderr").toString("base64")));
    const result = f.service.request(f.auth.operationId); assert.equal(result.state, "test-active"); assert.equal(f.allocationCount(), 1); assert.equal(f.effects.prepare, 1);
    assert.equal(f.service.status(f.auth.operationId).state, "blocked", "original uncertainty remains in immutable history, not erased by reconciliation");
    assert.ok(!JSON.stringify(f.service.status(f.auth.operationId)).includes("canary"));
  } finally { await f.cleanup(); }
});
for (const point of ["request:intent", "reservation:observed", "allocation:observed", "branch:observed", "test-process:observed", "test-start:intent", "test-start:observed"]) {
  test(`AC11: crash at ${point} preserves intent and never blindly repeats materialization/spawn/release`, async () => {
    let crashed = false; const f = await fixture((actual) => { if (!crashed && actual === point) { crashed = true; throw new Error("isolated crash"); } });
    try {
      assert.throws(() => f.service.request(f.auth.operationId));
      const prior = { allocation: f.allocationCount(), ...f.effects };
      const resumed = new RequirementsTestNativeService({ ...f.options, boundary: undefined });
      if (point === "test-start:intent") assert.throws(() => resumed.request(f.auth.operationId), "unproven release remains blocked, never replayed");
      else resumed.request(f.auth.operationId);
      assert.equal(f.allocationCount(), Math.max(prior.allocation, 1)); assert.equal(f.effects.prepare, Math.max(prior.prepare, 1));
      assert.equal(f.effects.start, point === "test-start:intent" ? 0 : 1); assert.equal(f.inventory().length, 1);
    } finally { await f.cleanup(); }
  });
}
test("AC11: live or missing-terminal registry cannot settle; actual death + terminal retains resources, idempotently", async () => {
  const f = await fixture();
  try {
    const resource = f.service.request(f.auth.operationId).resource;
    assert.throws(() => f.service.settleTest(f.auth.operationId));
    await f.stop(undefined, false); assert.throws(() => f.service.settleTest(f.auth.operationId));
    await f.stop(); f.service.settleTest(f.auth.operationId); const count = f.records().length;
    f.service.settleTest(f.auth.operationId); assert.equal(f.records().length, count);
    const row = f.inventory()[0]!; assert.ok("custody" in row); assert.equal(row.occupancy, "settled-retained"); assert.equal(row.custody.holder, null);
    assert.equal(git(f.worktree, "rev-parse", "HEAD"), f.base); assert.equal(resource.worktreeRoot, f.worktree); assert.ok(existsSync(f.worktree));
  } finally { await f.cleanup(); }
});
test("AC9/AC10: independently read actual Git/content + final chain, same-resource atomic product transfer at exact test HEAD", async () => {
  const f = await fixture();
  try {
    const resource = f.service.request(f.auth.operationId).resource; const evidence = f.final(resource);
    assert.throws(() => f.service.continueProduct(f.auth.operationId), "live author cannot hand off even with a modeled final chain");
    await f.stop(); f.service.settleTest(f.auth.operationId);
    const before = f.inventory()[0]!; const result = f.service.continueProduct(f.auth.operationId); const after = f.inventory()[0]!;
    assert.equal(result.initialHeadSha, evidence.testHeadSha); assert.deepEqual(result.resource, resource);
    assert.equal(before.repositoryPermit, after.repositoryPermit); assert.ok("reservationId" in before && "reservationId" in after); assert.equal(before.reservationId, after.reservationId);
    assert.equal(before.lineageId, after.lineageId); assert.equal(f.inventory().length, 1); assert.equal(f.allocationCount(), 1); assert.equal(f.effects.prepare, 2); assert.equal(f.effects.start, 2);
    assert.throws(() => f.service.request(f.auth.operationId)); assert.equal(f.effects.prepare, 2, "no mixed legacy/new second author");
  } finally { await f.cleanup(); }
});
for (const mutation of ["test-head", "product-commit", "missing-lease", "forged-history", "file-digest", "wrong-resource", "cancelled-intent"])  {
  test(`AC9/AC10: ${mutation} blocks product before process preparation; no legacy fallback`, async () => {
    const f = await fixture();
    try {
      const resource = f.service.request(f.auth.operationId).resource; const evidence = f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
      if (mutation === "test-head") { writeFileSync(join(f.worktree, "test/oracle.mjs"), "drift\n"); git(f.worktree, "add", "."); git(f.worktree, "commit", "-m", "drift"); }
      if (mutation === "product-commit") { writeFileSync(join(f.worktree, "src/product.txt"), "unauthorized\n"); git(f.worktree, "add", "."); git(f.worktree, "commit", "-m", "product drift"); }
      if (mutation === "missing-lease") f.setLeaseMissing();
      if (mutation === "cancelled-intent") f.service.cancel(f.auth.operationId);
      if (mutation === "forged-history") f.setHistory(f.history().slice(0, -1));
      if (mutation === "file-digest") { const altered = { ...evidence, files: [{ path: "test/oracle.mjs", sha256: digest("wrong") }] }; assert.throws(() => verifyRequirementsTestGit(f.auth, resource, altered)); f.setHistory([]); }
      if (mutation === "wrong-resource") { const changed = JSON.parse(f.history()[2]!); changed.data.resource.reservationId = digest("different-reservation"); const history = [...f.history()]; history[2] = JSON.stringify(changed); f.setHistory(history); }
      assert.throws(() => f.service.continueProduct(f.auth.operationId)); assert.equal(f.effects.prepare, 1); assert.equal(f.allocationCount(), 1); assert.equal(f.inventory().length, 1);
    } finally { await f.cleanup(); }
  });
}
for (const point of ["test-settlement:capacity-updated", "product-process:observed", "product-transfer:intent", "product-transfer:capacity-updated", "product-transfer:observed", "product-start:observed"]) {
  test(`AC10/AC11: settlement/transfer crash at ${point} reconciles same resource and holder without acquire/reserve/release replay`, async () => {
    let armed = false; let crashed = false;
    const f = await fixture((actual) => { if (armed && !crashed && actual === point) { crashed = true; throw new Error("isolated transfer crash"); } });
    try {
      const resource = f.service.request(f.auth.operationId).resource; f.final(resource); await f.stop(); armed = true;
      if (point.startsWith("test-settlement")) assert.throws(() => f.service.settleTest(f.auth.operationId));
      else { f.service.settleTest(f.auth.operationId); assert.throws(() => f.service.continueProduct(f.auth.operationId)); }
      const resumed = new RequirementsTestNativeService({ ...f.options, boundary: undefined });
      resumed.settleTest(f.auth.operationId); resumed.continueProduct(f.auth.operationId);
      assert.equal(f.inventory().length, 1); assert.equal(f.allocationCount(), 1); assert.equal(f.effects.prepare, 2); assert.equal(f.effects.start, 2);
    } finally { await f.cleanup(); }
  });
}
test("AC9/AC11: explicit new-version amendment preserves old commits, history, counters and the same resource/reservation/lineage", async () => {
  const f = await fixture();
  try {
    const resource = f.service.request(f.auth.operationId).resource; const evidence = f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
    const oldRecords = f.records(); const retained = assessTestWorkflow(f.raw(), f.history());
    const next = parseTestAuthorization(JSON.stringify({ ...f.auth, operationId: digest("approved-new-version-amendment"),
      repository: { ...f.auth.repository, selectedHeadSha: evidence.testHeadSha }, elapsedMs: retained.elapsedMs, bounds: retained.bounds,
      paths: f.auth.paths.map((path) => ({ ...path, existence: "existing", beforeSha256: evidence.files[0]!.sha256 })),
      amendment: { previousAuthorizationSha256: digest(f.raw()), contract: f.auth.contract, assertions: f.auth.assertions, repository: f.auth.repository,
        testHeadSha: evidence.testHeadSha, tests: evidence.files, changedPaths: ["test/oracle.mjs"], approval: source("explicit-amendment-approval") } }));
    const nextRaw = JSON.stringify(next);
    const authority: RequirementsTestNativeAuthority = { ...f.options.authority,
      readAuthorization: (id) => id === next.operationId ? nextRaw : f.raw(),
      authorizationDecision: () => source("separate-renewed-test-authorization"),
      assertAuthorization: (value, sha) => { assert.deepEqual(value, next); assert.equal(sha, digest(nextRaw)); },
      readPreviousAuthorization: () => f.raw(),
      assertAmendment: (previous, amended) => { assert.deepEqual(previous, f.auth); assert.deepEqual(amended, next); },
    };
    const resumed = new RequirementsTestNativeService({ ...f.options, authority });
    const renewed = resumed.request(next.operationId).resource;
    assert.equal(renewed.reservationId, resource.reservationId); assert.equal(renewed.repositoryPermit, resource.repositoryPermit); assert.equal(renewed.lineageId, resource.lineageId);
    assert.equal(f.inventory().length, 1); assert.equal(f.allocationCount(), 1); assert.equal(f.effects.prepare, 2);
    assert.equal(git(f.worktree, "rev-parse", "HEAD"), evidence.testHeadSha); assert.deepEqual(f.records().filter((row) => row.operationId === f.auth.operationId), oldRecords);
    assert.equal(next.bounds.deadlineAt, f.auth.bounds.deadlineAt); assert.equal(next.elapsedMs, retained.elapsedMs);
  } finally { await f.cleanup(); }
});
test("AC11/AC12: cancel retains original effects and prevents resumed test work, no return/delete/merge", async () => {
  const f = await fixture();
  try {
    f.service.request(f.auth.operationId); f.service.cancel(f.auth.operationId); const before = f.records().length;
    assert.throws(() => f.service.request(f.auth.operationId)); assert.equal(f.records().length, before); assert.equal(f.inventory().length, 1); assert.equal(f.effects.prepare, 1);
    assert.ok(existsSync(f.worktree)); assert.equal(git(f.worktree, "branch", "--show-current"), f.auth.repository.branch);
    await f.stop(); f.service.settleTest(f.auth.operationId); assert.equal(f.service.status(f.auth.operationId).state, "blocked");
  } finally { await f.cleanup(); }
});

after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(suiteRoot, { recursive: true, force: true }); });
