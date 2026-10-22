import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
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
    recordEvent(_scope, _auth, data) {
      // Pre-product approvals/results remain explicitly modeled fixture evidence.
      // Product chronology is emitted by the actual service at its effect boundary.
      if (!["product-intent", "product-consumed"].includes(data.action)) return;
      const prior = history.map((entry) => core.parseTestWorkflowEvent(entry)).find((entry) => entry.data.action === data.action);
      if (prior) { assert.deepEqual(prior.data, data); return; }
      const entry: TestWorkflowEvent = { schemaVersion: "requirements-test-workflow/v1", kind: "event", operationId: auth.operationId,
        authorizationSha256: digest(raw), sequence: history.length + 1, previousSha256: digest(history.at(-1) ?? raw), bounds: auth.bounds,
        retriesUsed: auth.retriesUsed, elapsedMs: (history.length + 1) * 1000, evidence: source(`service-product-event-${history.length}`), data };
      assessTestWorkflow(raw, [...history, JSON.stringify(entry)]); history.push(JSON.stringify(entry));
    },
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
  const effects = { prepare: 0, start: 0, cancel: 0 };
  const cancelled = new Set<string>();
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
    cancel(launch) {
      if (cancelled.has(launch.holder.deploymentId)) return;
      cancelled.add(launch.holder.deploymentId); effects.cancel++;
      if (JSON.stringify(readProcessFingerprint(launch.holder.process.pid)) === JSON.stringify(launch.holder.process)) process.kill(launch.holder.process.pid, "SIGTERM");
    },
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
      if (record.child.exitCode === null && record.child.signalCode === null) { record.child.stdin!.write("stop\n"); await new Promise<void>((resolve) => record.child.once("exit", () => resolve())); }
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
for (const asynchronous of [false, true]) {
  const route = asynchronous ? "async" : "sync";
  const executorFor = (f: Awaited<ReturnType<typeof fixture>>): RequirementsTestNativeExecutor => ({ ...f.options.executor,
    prepareAsync: async (...args) => f.options.executor.prepare(...args), startAsync: async (...args) => f.options.executor.start(...args) });
  test(`AC9/AC10 ${route}: product native chronology precedes process/release and replays idempotently at exact final approval`, async () => {
    const f = await fixture();
    try {
      const executor = executorFor(f);
      const prepare = executor.prepare, start = executor.start;
      executor.prepare = (role, ...args) => {
        if (role === "product") {
          assert.equal(assessTestWorkflow(f.raw(), f.history()).state, "product-intent");
          assert.equal(f.records().filter((entry) => entry.step === "product-process" && entry.state === "intent").length, 1);
          if (asynchronous) assert.equal(f.inventory()[0]!.occupancy, "settled-retained"); // sync ports already hold the capacity mutex
        }
        return prepare(role, ...args);
      };
      executor.start = (launch, ...args) => {
        if (launch.holder.deploymentId !== "d-222222") {
          assert.equal(assessTestWorkflow(f.raw(), f.history()).state, "product-consumed");
          const consumed = core.parseTestWorkflowEvent(f.history().at(-1)!).data; assert.ok(consumed.action === "product-consumed");
          const row = consumed.inventory[0]!; assert.ok("custody" in row); assert.equal(row.custody.state, "orchestrator-direct");
          assert.deepEqual(row.custody.holder, launch.holder);
          if (asynchronous) assert.deepEqual(f.inventory()[0], row);
        }
        return start(launch, ...args);
      };
      executor.prepareAsync = async (...args) => executor.prepare(...args);
      executor.startAsync = async (...args) => executor.start(...args);
      const service = new RequirementsTestNativeService({ ...f.options, executor });
      const resource = f.service.request(f.auth.operationId).resource; f.final(resource); await f.stop(); service.settleTest(f.auth.operationId);
      const approved = [...f.history()], before = f.inventory()[0]!;
      const continued = asynchronous ? await service.continueProductAsync(f.auth.operationId) : service.continueProduct(f.auth.operationId);
      const history = [...f.history()];
      assert.deepEqual(history.slice(0, approved.length), approved, "original final approval is immutable, not relabeled as consumption");
      assert.equal(assessTestWorkflow(f.raw(), history).state, "product-consumed");
      const intent = core.parseTestWorkflowEvent(history.at(-2)!).data;
      assert.equal(intent.action, "product-intent"); assert.ok(intent.action === "product-intent");
      assert.equal(intent.finalApprovalSha256, digest(approved.at(-1)!)); assert.equal(intent.initialHeadSha, continued.initialHeadSha);
      assert.equal(intent.intentId, digest(JSON.stringify([f.auth.operationId, "product-process"])));
      const resumed = new RequirementsTestNativeService({ ...f.options, executor });
      if (asynchronous) await resumed.continueProductAsync(f.auth.operationId); else resumed.continueProduct(f.auth.operationId);
      assert.deepEqual(f.history(), history); assert.equal(f.effects.prepare, 2); assert.equal(f.effects.start, 2);
      assert.equal(f.allocationCount(), 1); const after = f.inventory()[0]!;
      assert.ok("reservationId" in before && "reservationId" in after); assert.equal(after.reservationId, before.reservationId);
      assert.equal(after.repositoryPermit, before.repositoryPermit); assert.equal(after.lineageId, before.lineageId);
    } finally { await f.cleanup(); }
  });
  for (const point of ["product-intent:published", "product-start:intent", "product-consumed:published"]) {
    test(`AC9/AC11 ${route}: crash at ${point} never respawns or reissues an unproven product release`, async () => {
      let armed = false, crashed = false;
      const f = await fixture((actual) => { if (armed && !crashed && actual === point) { crashed = true; throw new Error("native-product-publication-response-loss"); } });
      try {
        const executor = executorFor(f), service = new RequirementsTestNativeService({ ...f.options, executor });
        const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); service.settleTest(f.auth.operationId); armed = true;
        if (asynchronous) await assert.rejects(service.continueProductAsync(f.auth.operationId)); else assert.throws(() => service.continueProduct(f.auth.operationId));
        assert.equal(crashed, true); const before = { ...f.effects };
        const resumed = new RequirementsTestNativeService({ ...f.options, executor, boundary: undefined });
        if (asynchronous) await assert.rejects(resumed.continueProductAsync(f.auth.operationId)); else assert.throws(() => resumed.continueProduct(f.auth.operationId));
        assert.deepEqual(f.effects, before); assert.equal(f.effects.prepare, point === "product-intent:published" ? 1 : 2);
        assert.equal(f.effects.start, 1, "no product code released after an uncertain pre-release boundary");
        assert.equal(f.inventory().length, 1); assert.equal(f.allocationCount(), 1); assert.equal(existsSync(f.worktree), true);
      } finally { await f.cleanup(); }
    });
  }
}
test("AC9: a missing/no-op native event producer blocks product before spawn, not just before release", async () => {
  for (const recordEvent of [undefined, () => {}]) {
    const f = await fixture();
    try {
      const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
      const service = new RequirementsTestNativeService({ ...f.options, authority: { ...f.options.authority, recordEvent } });
      assert.throws(() => service.continueProduct(f.auth.operationId)); assert.equal(f.effects.prepare, 1); assert.equal(f.effects.start, 1);
      assert.equal(assessTestWorkflow(f.raw(), f.history()).state, "final-approved");
    } finally { await f.cleanup(); }
  }
});
test("AC4/AC10: product replay authenticates its own reservation without freezing unrelated ticket capacity", async () => {
  const f = await fixture();
  try {
    const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
    f.service.continueProduct(f.auth.operationId); const history = [...f.history()];
    const added = acquireRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: f.repo, ticket: "PAP-2", deploymentId: "d-444444", deploymentDirectory: f.root });
    assert.equal(added.status, "acquired"); f.service.continueProduct(f.auth.operationId);
    assert.deepEqual(f.history(), history); assert.equal(f.inventory().length, 2); assert.equal(f.effects.prepare, 2); assert.equal(f.effects.start, 2);
    assert.equal(f.allocationCount(), 1);
  } finally { await f.cleanup(); }
});
test("AC4/AC10: conflicting active custody blocks product before parked process preparation", async () => {
  const f = await fixture();
  try {
    const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
    withPreparedTicketCapacity({ canonicalRepoKey: "registered", canonicalRepoRoot: f.repo }, (capacity) => {
      const row = capacity.inventory()[0]!; assert.ok("custody" in row);
      capacity.update(row, core.parseIdlePreparationReservation({ ...row, occupancy: "active", custody: { state: "orchestrator-direct", holder: f.auth.parent.holder, inFlightOperation: null } }));
    });
    assert.throws(() => f.service.continueProduct(f.auth.operationId)); assert.equal(f.effects.prepare, 1); assert.equal(f.effects.start, 1);
    assert.equal(f.allocationCount(), 1); assert.equal(assessTestWorkflow(f.raw(), f.history()).state, "final-approved");
  } finally { await f.cleanup(); }
});
test("AC11 async: cancellation during product prepare reconciles/cancels that exact pending process without respawn", async () => {
  const f = await fixture();
  try {
    const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
    const controller = new AbortController();
    const executor: RequirementsTestNativeExecutor = { ...f.options.executor,
      async prepareAsync(role, intent, resource) { const launch = f.options.executor.prepare(role, intent, resource); controller.abort(); return launch; },
      startAsync: async (...args) => f.options.executor.start(...args),
    };
    const service = new RequirementsTestNativeService({ ...f.options, executor });
    await assert.rejects(service.continueProductAsync(f.auth.operationId, controller.signal));
    assert.equal(f.effects.cancel, 1); await f.stop();
    const product = [...f.processes.values()].at(-1)!.launch;
    assert.equal(readProcessFingerprint(product.holder.process.pid), undefined);
    assert.equal(f.effects.prepare, 2); assert.equal(f.effects.start, 1); assert.equal(f.inventory()[0]!.occupancy, "settled-retained");
    const before = { ...f.effects }; await assert.rejects(service.continueProductAsync(f.auth.operationId)); assert.deepEqual(f.effects, before);
    assert.equal(f.allocationCount(), 1); assert.equal(service.status(f.auth.operationId).state, "blocked");
  } finally { await f.cleanup(); }
});
test("AC10/AC11: product cancellation targets the current holder; factual settlement retains resources and is idempotent", async () => {
  const f = await fixture();
  try {
    const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
    f.service.continueProduct(f.auth.operationId);
    const row = f.inventory()[0]!; assert.ok("custody" in row); const holder = row.custody.holder!;
    assert.throws(() => f.service.settleProduct(f.auth.operationId), "live PID or missing terminal registry cannot settle");
    f.service.cancel(f.auth.operationId); f.service.cancel(f.auth.operationId);
    assert.equal(f.effects.cancel, 1); assert.equal(f.service.status(f.auth.operationId).state, "blocked");
    await f.stop(undefined, false); assert.equal(readProcessFingerprint(holder.process.pid), undefined);
    assert.throws(() => f.service.settleProduct(f.auth.operationId), "process absence alone is not terminal registry");
    await f.stop(); const cancelledHistory = [...f.history()]; f.service.settleProduct(f.auth.operationId);
    const count = f.records().length; f.service.settleProduct(f.auth.operationId); assert.equal(f.records().length, count);
    assert.deepEqual(f.history(), cancelledHistory, "settlement creates neither approval nor product PASS");
    const after = f.inventory()[0]!; assert.ok("reservationId" in after && "reservationId" in row); assert.ok("custody" in after);
    assert.equal(after.occupancy, "settled-retained"); assert.equal(after.custody.state, "idle"); assert.equal(after.reservationId, row.reservationId);
    assert.equal(after.repositoryPermit, row.repositoryPermit); assert.equal(after.lineageId, row.lineageId);
    assert.equal(existsSync(resource.worktreeRoot), true); assert.equal(f.allocationCount(), 1);
    assert.throws(() => f.service.continueProduct(f.auth.operationId));
  } finally { await f.cleanup(); }
});
for (const point of ["product-settlement:intent", "product-settlement:capacity-updated", "product-settlement:observed"]) {
  test(`AC11: product terminal crash at ${point} resumes only the same settled process/reservation`, async () => {
    let armed = false, crashed = false;
    const f = await fixture((actual) => { if (armed && !crashed && actual === point) { crashed = true; throw new Error("native-product-terminal-response-loss"); } });
    try {
      const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
      f.service.continueProduct(f.auth.operationId); const before = f.inventory()[0]!;
      // Product code can change HEAD. Factual settlement must capture/retain it,
      // never reapply the pre-launch clean-test-HEAD gate or approve the changes.
      writeFileSync(join(f.worktree, "src/product.txt"), "SOURCE fixture product effect\n"); git(f.worktree, "add", "src/product.txt"); git(f.worktree, "commit", "-m", "source fixture product effect");
      await f.stop(); armed = true; assert.throws(() => f.service.settleProduct(f.auth.operationId)); assert.equal(crashed, true);
      const resumed = new RequirementsTestNativeService({ ...f.options, boundary: undefined }); resumed.settleProduct(f.auth.operationId);
      const after = f.inventory()[0]!; assert.equal(after.occupancy, "settled-retained"); assert.ok("reservationId" in after && "reservationId" in before);
      assert.equal(after.reservationId, before.reservationId); assert.equal(after.repositoryPermit, before.repositoryPermit);
      assert.equal(f.effects.prepare, 2); assert.equal(f.effects.start, 2); assert.equal(f.allocationCount(), 1);
      const settled = f.records().find((entry) => entry.step === "product-settlement" && entry.state === "observed")!;
      assert.equal((settled.value as { snapshot: { head: string } }).snapshot.head, git(f.worktree, "rev-parse", "HEAD"));
      assert.equal(readFileSync(join(f.worktree, "src/product.txt"), "utf8"), "SOURCE fixture product effect\n");
    } finally { await f.cleanup(); }
  });
}
for (const asynchronous of [false, true]) for (const released of [false, true]) {
  test(`AC11 ${asynchronous ? "async" : "sync"}: terminal release-response loss requires original start proof (${released ? "released" : "never released"}), no release replay`, async () => {
    const f = await fixture();
    try {
      const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
      const start: RequirementsTestNativeExecutor["start"] = (...args) => {
        if (released) f.options.executor.start(...args);
        throw new Error("SOURCE fixture lost release response");
      };
      const executor: RequirementsTestNativeExecutor = { ...f.options.executor, start,
        prepareAsync: async (...args) => f.options.executor.prepare(...args), startAsync: async (...args) => start(...args) };
      const service = new RequirementsTestNativeService({ ...f.options, executor });
      if (asynchronous) await assert.rejects(service.continueProductAsync(f.auth.operationId)); else assert.throws(() => service.continueProduct(f.auth.operationId));
      assert.equal(f.records().some((row) => row.step === "product-start" && row.state === "observed"), false);
      assert.equal(f.records().some((row) => row.step === "product-start" && row.state === "unknown"), true);
      if (released) {
        writeFileSync(join(f.worktree, "src/product.txt"), "source product effect after lost response\n");
        git(f.worktree, "add", "src/product.txt"); git(f.worktree, "commit", "-m", "source effect after release response loss");
      }
      await f.stop(); const effects = { ...f.effects }, history = [...f.history()];
      if (released) {
        service.settleProduct(f.auth.operationId); service.settleProduct(f.auth.operationId);
        assert.equal(f.inventory()[0]!.occupancy, "settled-retained");
        assert.equal(f.records().filter((row) => row.step === "product-start" && row.state === "observed").length, 1);
        assert.equal(f.records().filter((row) => row.step === "product-start" && row.state === "unknown").length, 1, "original uncertainty is not erased");
      } else {
        assert.throws(() => service.settleProduct(f.auth.operationId)); assert.equal(f.inventory()[0]!.occupancy, "active");
        assert.equal(f.records().some((row) => row.step === "product-start" && row.state === "observed"), false);
      }
      assert.deepEqual(f.effects, effects); assert.deepEqual(f.history(), history); assert.equal(f.effects.start, released ? 2 : 1); assert.equal(f.allocationCount(), 1);
    } finally { await f.cleanup(); }
  });
}
test("AC9 native final reader: only the authenticated exact final-approved prefix survives later product events", async () => {
  const f = await fixture();
  try {
    const { PiRequirementsTestAuthority } = await import("../requirements-test-native.js");
    const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
    const history = [...f.history()]; const final = JSON.parse(history.at(-1)!);
    const matrixApprovalEvidence = "SOURCE-ONLY-final-matrix-approval";
    final.data.pair.matrixApproval = { ref: "requirements-test-native:native-matrix-approval", version: "requirements-test-native/v1", sha256: digest(JSON.stringify(matrixApprovalEvidence)) };
    history[history.length - 1] = JSON.stringify(final); f.setHistory(history);
    let changed = false;
    class PreviewFixture extends PiPreparedNativeAuthority {
      override preview(): ReturnType<InstanceType<typeof PiPreparedNativeAuthority>["preview"]> {
        // Exact final-pair source reader is a fixture here. This test targets the
        // real prefix validation algorithm, not installed/signoff qualification.
        return { ...final.data.pair, matrixApprovalEvidence, requirements: changed ? source("changed-final-source") : final.data.pair.requirements } as ReturnType<InstanceType<typeof PiPreparedNativeAuthority>["preview"]>;
      }
    }
    class FinalReader extends PiRequirementsTestAuthority {
      override readAuthorization(): string { return f.raw(); }
      override readFinalHistory(): readonly string[] { return f.history(); }
    }
    const reader = new FinalReader({ native: new PreviewFixture({ root: join(f.root, "native") }) });
    const approved = assessTestWorkflow(f.raw(), f.history()); reader.assertFinalApproval(f.auth, approved);
    const service = new RequirementsTestNativeService({ ...f.options, authority: { ...f.options.authority, assertFinalApproval: (auth, assessment) => reader.assertFinalApproval(auth, assessment) } });
    service.continueProduct(f.auth.operationId); reader.assertFinalApproval(f.auth, approved);
    assert.equal(assessTestWorkflow(f.raw(), f.history()).state, "product-consumed");
    assert.throws(() => reader.assertFinalApproval(f.auth, assessTestWorkflow(f.raw(), f.history())), "consumption itself is not final signoff");
    assert.throws(() => reader.assertFinalApproval(f.auth, assessTestWorkflow(f.raw(), history.slice(0, -1))), "earlier oracle approval is not final signoff");
    const before = { ...f.effects }; changed = true;
    assert.throws(() => reader.assertFinalApproval(f.auth, approved)); assert.throws(() => service.continueProduct(f.auth.operationId));
    assert.deepEqual(f.effects, before); assert.equal(f.allocationCount(), 1);
  } finally { await f.cleanup(); }
});
for (const mutation of ["intent-id", "consumed-registry", "launch-snapshot", "missing-intent", "missing-consumed", "inventory-launch"]) {
  test(`AC9/AC10: copied/rehashed ${mutation} cannot replace native product publications`, async () => {
    const f = await fixture();
    try {
      const { resource } = f.service.request(f.auth.operationId); f.final(resource); await f.stop(); f.service.settleTest(f.auth.operationId);
      f.service.continueProduct(f.auth.operationId); const history = f.history().map((raw) => JSON.parse(raw));
      if (mutation === "missing-intent" || mutation === "missing-consumed") f.setHistory(f.history().slice(0, mutation === "missing-intent" ? 6 : 7));
      else {
        const last = history.at(-1)!;
        if (mutation === "intent-id") {
          for (const entry of history.slice(-2)) (entry.data as { intentId: string }).intentId = digest("copied-product-intent");
          last.previousSha256 = digest(JSON.stringify(history.at(-2)!));
        } else {
          assert.equal(last.data.action, "product-consumed"); assert.ok(last.data.action === "product-consumed");
          if (mutation === "consumed-registry") last.data.registry = source("copied-registry");
          if (mutation === "launch-snapshot") last.data.launchSnapshot = source("copied-launch-snapshot");
          if (mutation === "inventory-launch") (last.data.inventory[0] as { launch: { slotToken: string } }).launch.slotToken = "copied-native-slot-token";
        }
        f.setHistory(history.map((row) => JSON.stringify(row)));
        // Model replay accepts internally consistent copies; the production
        // service must reject their mismatch with its actual effect publications.
        assert.equal(assessTestWorkflow(f.raw(), f.history()).state, "product-consumed");
      }
      const before = { ...f.effects }; assert.throws(() => f.service.continueProduct(f.auth.operationId));
      assert.deepEqual(f.effects, before); assert.equal(f.allocationCount(), 1);
    } finally { await f.cleanup(); }
  });
}
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

for (const scenario of ["long-text", "failure"] as const) test(`AC2/AC9 source integration: native capture, retry and keyless SDK ${scenario} retain exact private evidence`, async (t) => {
  const f = await fixture(); const previousRegistry = process.env.PA_REGISTRY_DB; let sdkChild: ChildProcess | undefined;
  let mode: "text" | "long-text" | "failure" | "redirect" | "hang" | "oversize" = "text";
  const requests: { url: string; authorization?: string; body: Record<string, unknown> }[] = [];
  // Deterministic source protocol fixture, NOT an actual model/provider canary,
  // installed qualification or a production service. No credentials are read.
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
    requests.push({ url: request.url!, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(parts).toString("utf8")) });
    if (mode === "redirect") { response.writeHead(302, { Location: "http://127.0.0.1:1/forbidden" }); response.end(); return; }
    if (mode === "failure") { response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "source-fixture-endpoint-failure" + ".".repeat(70_000) } })); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "hang") { response.flushHeaders(); return; }
    if (mode === "oversize") { response.end(Buffer.alloc(16_777_217, 32)); return; }
    response.end(`data: ${JSON.stringify({ id: "source-protocol", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "keyless source protocol observation" + (mode === "long-text" ? ".".repeat(70_000) : "") }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "source-protocol", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    core.closeDb(); process.env.PA_REGISTRY_DB = join(f.root, "capture-registry.db");
    const { PiRequirementsTestAuthority } = await import("../requirements-test-native.js");
    const usage = join(f.root, "capture-usage"), sourceRoot = join(usage, "agent-teams/requirements/artifacts"), ticketsRoot = join(usage, "tickets");
    mkdirSync(sourceRoot, { recursive: true }); mkdirSync(ticketsRoot);
    mkdirSync(join(usage, "deployments"), { mode: 0o700 });
    const sources = ["contract", "assertions", "valid-input", "wrong-input"].map((name) => {
      const path = `agent-teams/requirements/artifacts/${name}.md`, text = `source fixture ${name}; not installed/operator/human qualification\n`;
      writeFileSync(join(usage, path), text); return { ref: `requirements:${path}`, version: "r001", sha256: digest(text) };
    });
    const ticket = JSON.parse(readFileSync(join(f.ticketsRoot, "PAP-1.json"), "utf8")); ticket.doc_refs = sources.map((entry) => ({ type: "requirements", path: entry.ref.slice("requirements:".length) }));
    writeFileSync(join(ticketsRoot, "PAP-1.json"), JSON.stringify(ticket));
    const facts = { sourceSha: "b".repeat(40), configSha: "c".repeat(40), packageVersion: "source-fixture-only", storeRoot: f.root };
    const native = new PiPreparedNativeAuthority({ root: join(f.root, "native"), aiUsageRoot: usage, runtime: () => facts });
    const caller = { deploymentId: "d-111111", repoKey: "registered", repoRoot: f.repo, ticket: "PAP-1", callerIdentity: digest("native-ui-source-fixture") };
    const authority = new PiRequirementsTestAuthority({ native, runtime: () => facts, authenticate: () => caller });
    const context = { mode: "tui" as const, cwd: f.repo, sessionManager: { getSessionId: () => "source-fixture" }, ui: { select: async (_title: string, choices: string[]) => choices[0] } };
    assert.throws(() => authority.selection(caller), "missing qualification cannot select a route");
    const refs: Record<string, ReturnType<typeof source>> = {};
    for (const kind of ["native", "installed", "pairing", "toolsAuditDecision"]) {
      const id = digest(`explicit-synthetic-${kind}`), value = { schemaVersion: "requirements-test-qualification-evidence/v1", runtime: facts, kind, source: source(`SYNTHETIC-${kind}-NOT-ACTUAL-QUALIFICATION`), outcome: "qualified" };
      publish(f.store, id, value); refs[kind] = { ref: `requirements-test-qualification-evidence:${id}`, version: "requirements-test-qualification-evidence/v1", sha256: digest(JSON.stringify(value)) };
    }
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const transport = { schemaVersion: "requirements-test-model-transport/v1", runtime: facts, endpoint: `http://127.0.0.1:${address.port}/v1`, modelId: "source-fixture-only", contextWindow: 8192, maxTokens: 1024,
      process: readProcessFingerprint(process.pid)!, source: source("SYNTHETIC-TRANSPORT-NOT-ACTUAL-QUALIFICATION"), outcome: "qualified" };
    const modelId = digest("synthetic-keyless-transport"); publish(f.store, modelId, transport);
    const modelRef = { ref: `requirements-test-model-transport:${modelId}`, version: transport.schemaVersion, sha256: digest(JSON.stringify(transport)) };
    const qualificationId = digest(JSON.stringify(["requirements-test-native-qualification/v2", facts]));
    publish(f.store, qualificationId, { schemaVersion: "requirements-test-native-qualification/v2", runtime: facts, ...refs, modelTransport: modelRef });
    assert.equal(authority.selection(caller).active, false);
    await authority.select(context); // ONLY isolated synthetic policy, never real activation
    const selected = authority.selection(caller); assert.equal(selected.active, true);
    core.appendRegistryEvent({ deployment_id: caller.deploymentId, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", event: "started", timestamp: new Date().toISOString(), pid: process.pid,
      ticket_id: "PAP-1", repo: f.repo, repo_root: f.repo, worktree_root: f.repo });
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const auth = parseTestAuthorization(JSON.stringify({ ...f.auth, contract: sources[0], assertions: sources[1], pair: { ...f.auth.pair, qualification: selected.qualification, toolsAuditDecision: refs.toolsAuditDecision },
      checks: f.auth.checks.map((check) => ({ ...check, input: check.kind === "control" ? sources[3] : sources[2], environment: authority.environmentSources() })),
      bounds: { ...f.auth.bounds, startedAt, deadlineAt: new Date(Date.parse(startedAt) + 120 * 60_000).toISOString() } }));
    const raw = JSON.stringify(auth);
    await assert.rejects(authority.capture({ ...context, ui: { select: async () => "Cancel" } }, raw, "cancelled-capture"));
    assert.throws(() => authority.readAuthorization(auth.operationId));
    const captured = await authority.capture(context, raw, "exact-native-dialog"); assert.deepEqual(captured, auth);
    authority.assertAuthorization(auth, digest(raw)); assert.equal(authority.readAuthorization(auth.operationId), raw);
    const decision = authority.authorizationDecision(auth); assert.ok(decision.sha256);
    assert.equal(f.effects.prepare, 0); assert.equal(f.allocationCount(), 0); assert.equal(f.inventory().length, 0);
    await t.test("keyless transport parses strict bindings; URL/credential/version/runtime/bounds drift is not qualification", async () => {
      const { parseRequirementsTestModelTransport } = await import("../requirements-test-native.js");
      assert.deepEqual(parseRequirementsTestModelTransport(transport, facts), transport);
      for (const endpoint of ["https://remote.invalid/v1", "http://localhost:1234/v1", "http://127.0.0.1:1234/v1?token=x", "http://user:password@127.0.0.1:1234/v1", "http://127.0.0.1:80/v1", "http://127.0.0.1:99999/v1", "http://127.0.0.1:1234/other", "http://127.0.0.2:1234/v1"]) assert.throws(() => parseRequirementsTestModelTransport({ ...transport, endpoint }, facts));
      for (const delta of [{ apiKey: "forbidden" }, { headers: {} }, { schemaVersion: "legacy" }, { maxTokens: 0 }, { maxTokens: 32769 }, { maxTokens: 9000 }, { contextWindow: 0 }, { process: { ...transport.process, pid: 0 } }, { runtime: { ...facts, configSha: "0".repeat(40) } }, { modelId: "$ENV" }, { outcome: "pending" }]) assert.throws(() => parseRequirementsTestModelTransport({ ...transport, ...delta }, facts));
      assert.equal(requests.length, 0); assert.equal(f.allocationCount(), 0);
    });
    await t.test("genuine SDK uses only the qualified keyless endpoint; no auth, retries or redirects", async () => {
      const { createRequirementsTestModelRuntime } = await import("../background-runner.js");
      const { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
      const runtime = await createRequirementsTestModelRuntime(authority, auth, f.root);
      const { session } = await createAgentSession({ cwd: f.repo, agentDir: f.root, modelRuntime: runtime.modelRuntime, model: runtime.model, thinkingLevel: "off", noTools: "all", tools: [],
        sessionManager: SessionManager.inMemory(f.repo), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoader: { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "Source protocol fixture only.", getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {} } });
      try {
        await session.prompt("Observe only this isolated keyless protocol.", { expandPromptTemplates: false });
        assert.equal(session.getLastAssistantText(), "keyless source protocol observation");
        assert.equal(requests.length, 1); assert.equal(requests[0]!.authorization, undefined); assert.equal(requests[0]!.url, "/v1/chat/completions"); assert.equal(requests[0]!.body.model, transport.modelId);
        mode = "redirect"; const redirect = await runtime.modelRuntime.completeSimple(runtime.model, { messages: [{ role: "user", content: "reject redirects", timestamp: Date.now() }] });
        assert.equal(redirect.stopReason, "error"); assert.equal(requests.length, 2, "redirect must not trigger a second request or provider retry");
        mode = "failure"; const failure = await runtime.modelRuntime.completeSimple(runtime.model, { messages: [{ role: "user", content: "retain failure", timestamp: Date.now() }] });
        assert.equal(failure.stopReason, "error"); assert.equal(requests.length, 3, "503 must not retry");
        mode = "hang";
        const aborted = await runtime.modelRuntime.completeSimple(runtime.model, { messages: [{ role: "user", content: "cancel bounded request", timestamp: Date.now() }] }, { signal: AbortSignal.timeout(200) });
        assert.equal(aborted.stopReason, "aborted"); assert.equal(requests.length, 4);
        mode = "oversize";
        const oversized = await runtime.modelRuntime.completeSimple(runtime.model, { messages: [{ role: "user", content: "reject over-budget stream", timestamp: Date.now() }] });
        assert.equal(oversized.stopReason, "error"); assert.equal(requests.length, 5);
        mode = scenario;
      } finally { await session.abort(); session.dispose(); }
      assert.equal(f.allocationCount(), 0); assert.equal(f.inventory().length, 0);
    });
    const capacityService = new RequirementsTestNativeService({ ...f.options, authority, tickets: native.tickets(), now: () => new Date().toISOString() });
    await t.test("native retry rejects no failure, forged decisions and non-foreground capture without effects", async () => {
      await assert.rejects(authority.captureCapacityRetry(context, auth.operationId, "no-capacity-failure"));
      assert.throws(() => authority.assertCapacityRetry(auth, source("forged-decision"), source("forged-failure"), 1));
      assert.equal(f.allocationCount(), 0);
    });
    const occupied = [2, 3, 4, 5].map((n) => {
      const directory = join(f.root, `legacy-slot-${n}`); mkdirSync(directory);
      const row = acquireRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: f.repo, ticket: `PAP-${n}`, deploymentId: `d-44444${n}`, deploymentDirectory: directory });
      assert.equal(row.status, "acquired"); if (row.status !== "acquired") throw new Error("fixture capacity"); return row.slot;
    });
    assert.throws(() => capacityService.request(auth.operationId));
    const beforeRetry = f.records();
    await t.test("native retry cancellation, RPC and source drift preserve full-capacity failure and counters", async () => {
      await assert.rejects(authority.captureCapacityRetry({ ...context, mode: "rpc" }, auth.operationId, "rpc"));
      await assert.rejects(authority.captureCapacityRetry({ ...context, ui: { select: async () => "Cancel" } }, auth.operationId, "cancel"));
      const path = join(sourceRoot, "assertions.md"), original = readFileSync(path);
      try {
        await assert.rejects(authority.captureCapacityRetry({ ...context, ui: { select: async (_title, choices) => { writeFileSync(path, "changed while dialog open"); return choices[0]; } } }, auth.operationId, "drift"));
      } finally { writeFileSync(path, original); }
      assert.deepEqual(f.records(), beforeRetry); assert.equal(f.inventory().length, 4); assert.equal(f.allocationCount(), 0);
    });
    await t.test("native retry binds exact failure/raw authorization/bounds, consumes once and never queues", async () => {
      const retry = await authority.captureCapacityRetry(context, auth.operationId, "exact-manual-retry");
      const failureRow = f.records().at(-1)!;
      const failure = { ref: "requirements-test-native:capacity-failure", version: "requirements-test-native/v1", sha256: digest(JSON.stringify(failureRow)) };
      authority.assertCapacityRetry(auth, retry, failure, 1);
      for (const forged of [{ ...retry, version: "legacy" }, { ...retry, sha256: "0".repeat(64) }, { ...retry, ref: "requirements-test-capacity-retry:" + "0".repeat(64) }]) assert.throws(() => authority.assertCapacityRetry(auth, forged, failure, 1));
      assert.throws(() => authority.assertCapacityRetry(auth, retry, { ...failure, sha256: "0".repeat(64) }, 1));
      assert.throws(() => authority.assertCapacityRetry(auth, retry, failure, 2));
      capacityService.retryCapacity(auth.operationId, retry);
      assert.equal(capacityService.status(auth.operationId).state, "retained", "historical capacity failure is retained, not a new automatic retry or current blocker");
      assert.throws(() => capacityService.retryCapacity(auth.operationId, retry));
      await assert.rejects(authority.captureCapacityRetry(context, auth.operationId, "replay-used"));
      assert.equal(f.records().filter((row) => row.step === "capacity-retry").length, 1);
      assert.equal(f.allocationCount(), 0); assert.equal(f.effects.prepare, 0);
    });
    // Only the legacy owner releases its own isolated fixture slot. The retry
    // operation performs no release/reclaim and no automatic subsequent request.
    assert.equal(core.releaseRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: f.repo, ticket: occupied[0]!.ticket,
      slotToken: occupied[0]!.slotToken, slotId: occupied[0]!.slotId, repositoryPermit: occupied[0]!.repositoryPermit }).status, "released");
    // Source-only end-to-end owner composition: actual shared locks/store,
    // dedicated registry, real child and real keyless SDK. The synthetic
    // operator/pair and Treehouse replies above are NOT installed qualification.
    const { PiRestrictedTestExecutor } = await import("../background-runner.js");
    const reqModule = new URL("../requirements-test-native.ts", import.meta.url).href, preparedModule = new URL("../prepared-native.ts", import.meta.url).href, runnerModule = new URL("../background-runner.ts", import.meta.url).href;
    const executor = new PiRestrictedTestExecutor(authority, { spawnRunner(intentId, resource) {
      const program = `const {PiRequirementsTestAuthority}=await import(${JSON.stringify(reqModule)}); const {PiPreparedNativeAuthority}=await import(${JSON.stringify(preparedModule)}); const {runRequirementsTestHolder}=await import(${JSON.stringify(runnerModule)}); const facts=${JSON.stringify(facts)}; const native=new PiPreparedNativeAuthority({root:${JSON.stringify(join(f.root, "native"))},aiUsageRoot:${JSON.stringify(usage)},runtime:()=>facts}); const authority=new PiRequirementsTestAuthority({native,runtime:()=>facts}); try {await runRequirementsTestHolder(${JSON.stringify(intentId)},authority);} catch(error) {const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(join(f.root, "sdk-bootstrap-error.json"))},JSON.stringify({message:error.message,stack:error.stack}),{mode:0o600});process.exitCode=1;}`;
      sdkChild = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", program], { cwd: resource.worktreeRoot,
        env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", HOME: suiteRoot, PA_REGISTRY_DB: process.env.PA_REGISTRY_DB, PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: process.env.PA_PLATFORM_CONFIG }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
      return sdkChild;
    } });
    const service = new RequirementsTestNativeService({ ...f.options, authority, executor, tickets: native.tickets(), now: () => new Date().toISOString() });
    try { await service.requestAsync(auth.operationId); } catch (error) { assert.ok(error instanceof Error, "a fast terminal SDK failure can race the released acknowledgement"); }
    const until = Date.now() + 10_000;
    while (sdkChild?.pid && readProcessFingerprint(sdkChild.pid) && Date.now() < until) await new Promise((done) => setTimeout(done, 10));
    assert.ok(sdkChild?.pid, JSON.stringify(f.records().map((row) => ({ step: row.step, state: row.state, value: row.state === "unknown" ? row.value : undefined }))));
    assert.equal(readProcessFingerprint(sdkChild.pid), undefined, "actual SDK process must settle, not only registry");
    const launch = f.records().find((row) => row.step === "test-process" && row.state === "observed")?.value as RequirementsTestLaunch | undefined;
    assert.ok(launch, existsSync(join(f.root, "sdk-bootstrap-error.json")) ? readFileSync(join(f.root, "sdk-bootstrap-error.json"), "utf8") : "restricted SDK must park before any release");
    const status = core.queryDeploymentStatus(launch.holder.deploymentId); assert.equal(status?.status, scenario === "failure" ? "failed" : "partial"); assert.equal(status?.builder_authority, undefined); assert.equal(status?.requirements_test?.operationId, auth.operationId);
    executor.assertSettled(launch);
    const terminal = f.store.records().map((name) => f.store.read(name) as { kind?: string; payload?: { intentId: string; nativeDetail: { name: string; bytes: number; sha256: string }; failed: boolean; truncated: boolean } })
      .find((row) => row.kind === "requirements-test-runtime-terminal");
    assert.ok(terminal?.payload); assert.equal(terminal.payload.failed, scenario === "failure"); assert.equal(terminal.payload.truncated, false);
    if (scenario === "long-text") assert.ok(terminal.payload.nativeDetail.bytes > 65_536, "long original model conversation must not overflow the protected journal envelope");
    const { NativeExecutionEvidence } = await import("../native-execution-evidence.js");
    const originalEvidence = new NativeExecutionEvidence(f.store, join(f.root, "native/operations"), { repository: (run) => run(), worktree: (run) => run() });
    const original = JSON.parse(originalEvidence.blob(terminal.payload.nativeDetail).toString("utf8")) as { messages: { role: string; stopReason?: string; errorMessage?: string; content?: { type: string; text?: string }[] }[] };
    if (scenario === "failure") assert.ok(original.messages.some((message) => message.role === "assistant" && message.stopReason === "error" && message.errorMessage?.includes("source-fixture-endpoint-failure")));
    else assert.ok(original.messages.some((message) => message.role === "assistant" && message.stopReason === "stop" && message.content?.some((part) => part.type === "text" && part.text!.length > 65_536)));
    assert.throws(() => service.settleTest(auth.operationId), "neither a failed model nor a text-only protocol fixture with no tests can create an accepted oracle");
    assert.equal(f.inventory().find((row) => row.ticket === auth.repository.ticket)!.occupancy, "settled-retained"); assert.equal(f.allocationCount(), 1);
    await assert.rejects(service.continueProductAsync(auth.operationId)); assert.equal(f.allocationCount(), 1);
    await t.test("qualified keyless test capability does not mint a product holder or reuse legacy builder authority", async () => {
      const inventory = f.inventory(), records = f.store.records(), beforeRequests = requests.length;
      const resource = (f.records().find((row) => row.step === "test-start" && row.state === "observed")!.value as { resource: TestResource }).resource;
      await assert.rejects(executor.prepareAsync("product", digest("not-a-final-approved-product-intent"), resource));
      assert.throws(() => executor.inspect("product", digest("not-a-final-approved-product-intent"), resource));
      assert.throws(() => assertNoRequirementsTestLegacyFallback({ repoKey: auth.repository.key, repoRoot: auth.repository.root, ticket: auth.repository.ticket }, native));
      assert.deepEqual(f.inventory(), inventory); assert.deepEqual(f.store.records(), records); assert.equal(requests.length, beforeRequests); assert.equal(f.allocationCount(), 1);
    });
    const different = parseTestAuthorization(JSON.stringify({ ...auth, checks: auth.checks.map((check, index) => index ? check : { ...check, command: `${check.command} changed` }) }));
    assert.throws(() => authority.assertAuthorization(different, digest(JSON.stringify(different))));
    writeFileSync(join(sourceRoot, "assertions.md"), "material source drift\n");
    assert.throws(() => authority.assertAuthorization(auth, digest(raw)));
    authority.assertRetainedAuthorization(auth, digest(raw)); // retained history is not new work
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    assert.throws(() => authority.selection(caller), "a live PID with no exact listening socket is not a model transport");
    authority.assertRetainedAuthorization(auth, digest(raw));
  } finally {
    if (sdkChild?.pid && readProcessFingerprint(sdkChild.pid)) {
      sdkChild.kill("SIGTERM"); const until = Date.now() + 5_000;
      while (readProcessFingerprint(sdkChild.pid) && Date.now() < until) await new Promise((done) => setTimeout(done, 10));
      if (readProcessFingerprint(sdkChild.pid)) sdkChild.kill("SIGKILL");
      if (sdkChild.exitCode === null && sdkChild.signalCode === null) await new Promise<void>((done) => sdkChild!.once("exit", () => done()));
    }
    assert.equal(sdkChild?.pid ? readProcessFingerprint(sdkChild.pid) : undefined, undefined);
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    core.closeDb(); if (previousRegistry === undefined) delete process.env.PA_REGISTRY_DB; else process.env.PA_REGISTRY_DB = previousRegistry; await f.cleanup();
  }
});

test("AC3/AC4: async parked composition releases both owners across await and publishes custody before release", async () => {
  const f = await fixture();
  try {
    let inspectedDuringPrepare = false; let inspectedDuringRelease = false;
    const executor: RequirementsTestNativeExecutor = { ...f.options.executor,
      async prepareAsync(role, intent, resource) {
        assert.equal(f.inventory().length, 1); inspectedDuringPrepare = true;
        await new Promise((done) => setTimeout(done, 25));
        return f.options.executor.prepare(role, intent, resource);
      },
      async startAsync(launch, intent) {
        const row = f.inventory()[0]!; assert.ok("custody" in row); assert.deepEqual(row.custody.holder, launch.holder);
        assert.ok(f.records().some((record) => record.step === "test-start" && record.state === "intent")); inspectedDuringRelease = true;
        await new Promise((done) => setTimeout(done, 25)); f.options.executor.start(launch, intent);
      },
    };
    const service = new RequirementsTestNativeService({ ...f.options, executor });
    const first = await service.requestAsync(f.auth.operationId);
    assert.equal(first.state, "test-active"); assert.equal(inspectedDuringPrepare, true); assert.equal(inspectedDuringRelease, true);
    await service.requestAsync(f.auth.operationId);
    assert.equal(f.effects.prepare, 1); assert.equal(f.effects.start, 1); assert.equal(f.allocationCount(), 1);
    await f.stop(); service.settleTest(f.auth.operationId); assert.equal(f.inventory()[0]!.occupancy, "settled-retained");
  } finally { await f.cleanup(); }
});
for (const point of ["test-process:observed", "test-start:intent", "test-start:observed"]) {
  test(`AC11: async ${point} response loss never replays spawn or an unproven release`, async () => {
    let crashed = false; const f = await fixture((actual) => { if (!crashed && actual === point) { crashed = true; throw new Error("source-async-response-loss"); } });
    try {
      const executor: RequirementsTestNativeExecutor = { ...f.options.executor, prepareAsync: async (...args) => f.options.executor.prepare(...args), startAsync: async (...args) => f.options.executor.start(...args) };
      const service = new RequirementsTestNativeService({ ...f.options, executor });
      await assert.rejects(service.requestAsync(f.auth.operationId));
      const resumed = new RequirementsTestNativeService({ ...f.options, executor, boundary: undefined });
      if (point === "test-start:intent") await assert.rejects(resumed.requestAsync(f.auth.operationId));
      else await resumed.requestAsync(f.auth.operationId);
      assert.equal(f.effects.prepare, 1); assert.equal(f.effects.start, point === "test-start:intent" ? 0 : 1); assert.equal(f.allocationCount(), 1);
    } finally { await f.cleanup(); }
  });
}
test("AC10: async continuation transfers the actual retained reservation after process/registry settlement, without acquire", async () => {
  const f = await fixture();
  try {
    const executor: RequirementsTestNativeExecutor = { ...f.options.executor, prepareAsync: async (...args) => f.options.executor.prepare(...args), startAsync: async (...args) => f.options.executor.start(...args) };
    const service = new RequirementsTestNativeService({ ...f.options, executor });
    const { resource } = await service.requestAsync(f.auth.operationId); const evidence = f.final(resource);
    await assert.rejects(service.continueProductAsync(f.auth.operationId));
    await f.stop(); service.settleTest(f.auth.operationId); const before = f.inventory()[0]!;
    const continued = await service.continueProductAsync(f.auth.operationId); const after = f.inventory()[0]!;
    assert.equal(continued.initialHeadSha, evidence.testHeadSha); assert.deepEqual(continued.resource, resource);
    assert.ok("reservationId" in before && "reservationId" in after); assert.equal(before.reservationId, after.reservationId); assert.equal(before.repositoryPermit, after.repositoryPermit); assert.equal(before.lineageId, after.lineageId);
    assert.equal(f.allocationCount(), 1); assert.equal(f.effects.prepare, 2); assert.equal(f.effects.start, 2);
  } finally { await f.cleanup(); }
});

test("AC5/AC6/AC7 source-native: genuine Pi SDK definitions enforce exact file/check actions; no builtin shell/delegation or sandbox claim", async () => {
  const f = await fixture();
  try {
    const { RequirementsTestTools, requirementsTestFile } = await import("../native-execution-tools.js");
    const { NativeExecutionEvidence } = await import("../native-execution-evidence.js");
    const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const evidenceRoot = join(f.root, "sdk-evidence"); mkdirSync(evidenceRoot, { mode: 0o700 });
    const evidence = new NativeExecutionEvidence(new ProtectedWorkflowStore(evidenceRoot), evidenceRoot, { repository: (run) => run(), worktree: (run) => run() });
    const { resource } = f.service.request(f.auth.operationId);
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const auth = parseTestAuthorization(JSON.stringify({ ...f.auth, bounds: { ...f.auth.bounds, startedAt, deadlineAt: new Date(Date.parse(startedAt) + 120 * 60_000).toISOString() } }));
    const exclude = git(f.worktree, "rev-parse", "--git-path", "info/exclude"); const originalExclude = readFileSync(exclude, "utf8");
    writeFileSync(exclude, `${originalExclude}\ntest/oracle.mjs\n`);
    assert.throws(() => new RequirementsTestTools(JSON.stringify(auth), resource, evidence, () => {}, () => ({})), "ignored approved paths cannot evade complete Git audit");
    writeFileSync(exclude, originalExclude); // isolated fixture setup only, not runtime repair
    const native = new RequirementsTestTools(JSON.stringify(auth), resource, evidence, () => {
      const row = f.inventory()[0]!; assert.ok("custody" in row); assert.ok(row.custody.holder); assert.deepEqual(readProcessFingerprint(row.custody.holder.process.pid), row.custody.holder.process);
    }, () => ({ PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC" }));
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(f.root, "no-model-catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
    const { session } = await createAgentSession({ cwd: f.worktree, agentDir: f.root, resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Isolated SDK source fixture; no provider prompt, credential or production effects.", getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
    }, tools: native.tools.map((tool) => tool.name), noTools: "builtin", customTools: native.tools, modelRuntime, sessionManager: SessionManager.inMemory(f.worktree), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
    try {
      assert.deepEqual([...session.getActiveToolNames()].sort(), ["check", "edit", "read", "write"]);
      assert.equal(session.getActiveToolNames().includes("bash"), false);
      const execute = async (name: string, id: string, input: unknown) => {
        const tool = session.agent.state.tools.find((entry) => entry.name === name); assert.ok(tool); return tool.execute(id, input as never);
      };
      for (const input of [{ path: "src/product.txt", content: "forbidden" }, { path: "../escape", content: "forbidden" }, { path: join(f.worktree, "test/oracle.mjs"), content: "forbidden" }, { path: "test/oracle.mjs", content: "forbidden", env: { TOKEN: "not-a-grant" } }]) await assert.rejects(execute("write", `deny-${JSON.stringify(input)}`, input));
      assert.equal(existsSync(join(f.worktree, "test/oracle.mjs")), false);
      const code = `const kind = process.argv[2]; console.log(JSON.stringify({ schemaVersion: 'requirements-test-assertion/v1', assertion: kind === '--baseline' ? 'Q2' : 'Q1', outcome: kind === '--baseline' ? 'satisfied' : 'violated', reason: kind === '--baseline' ? 'preserved' : 'missing-through-T' })); process.exitCode = kind === '--baseline' ? 0 : 1;\n`;
      await execute("write", "sdk-write", { path: "test/oracle.mjs", content: code });
      await execute("edit", "sdk-edit", { path: "test/oracle.mjs", edits: [{ oldText: "const kind", newText: "// approved fixture\nconst kind" }] });
      for (const id of ["baseline", "feature", "control"]) {
        const result = await execute("check", `sdk-check-${id}`, { checkId: id });
        assert.equal((result.details as { exitCode: number }).exitCode, id === "baseline" ? 0 : 1);
        assert.equal((result.details as { productPass: boolean }).productPass, false);
      }
      await assert.rejects(execute("check", "unapproved-command", { checkId: "baseline", command: "printf bypass" }));
      assert.equal(readFileSync(join(f.worktree, "src/product.txt"), "utf8"), "unchanged product baseline\n");
      const proof = native.settled(); assert.ok(proof.sha256);
      const rows = evidence.store.records().map((name) => evidence.store.read(name) as { kind: string }); assert.equal(rows.filter((row) => row.kind === "requirements-test-check").length, 3);
      symlinkSync(join(f.worktree, "src/product.txt"), join(f.root, "alias"));
      assert.throws(() => requirementsTestFile(f.worktree, ["test/oracle.mjs"], join(f.root, "alias"), "forbidden"));
      const hard = join(f.worktree, "test/hard.mjs"); linkSync(join(f.worktree, "src/product.txt"), hard);
      assert.throws(() => requirementsTestFile(f.worktree, ["test/hard.mjs"], hard, "forbidden"));
    } finally { session.dispose(); }
  } finally { await f.cleanup(); }
});

after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(suiteRoot, { recursive: true, force: true }); });
