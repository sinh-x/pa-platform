import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  appendRegistryEvent, captureRepositoryGitSnapshot, closeDb, getDb, getDeployPaths, queryReadonlyHelperRegistry,
  ReadOnlyHelperFailure, readProcessFingerprint, repositoryMutationBorrowerPath, repositoryMutationLeasePath,
  repositoryReviewReservationPath, repositoryTicketSlotPath, resolveReadOnlyHelperContext, resolveRepoExecutionPath,
  withReadOnlyHelperContext, type DeploymentStatus, type ImplementationLaunchState, type ReadOnlyHelperRole,
  type RepositoryMutationBorrower, type RepositoryMutationLease, type RepositoryReviewReservation, type RepositoryTicketSlot,
  type RegistryEvent, type ReviewAuthorizationClaim, type RuntimeAdapter,
} from "@pa-platform/pa-core";
import { createPiHooks, createPiReadonlyHelperCapability, piReviewCheckoutCorrelation } from "../deploy.js";
import { TreehouseClient } from "../treehouse.js";
import { PI_PROCESS_IDENTITY_FILE, recordPiProcessIdentity } from "../process-identity.js";

const roles: ReadOnlyHelperRole[] = ["orchestrator", "parented-implement", "standalone-implement", "worker-consistency-only", "review-auto"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const protectedWrite = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); };

function isolated<T>(run: (root: string) => T): T {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PA_|PI_|GIT_)/.test(key)));
  for (const key of Object.keys(inherited)) delete process.env[key];
  closeDb();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pap249-helper-")));
  Object.assign(process.env, { PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), PA_PLATFORM_CONFIG: join(root, "config"),
    PA_PLATFORM_HOME: join(root, "platform"), PA_PLATFORM_DATA: join(root, "data"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  // Native ABI preparation belongs to the named check environment, not operator state.
  if (inherited.PA_SQLITE_NATIVE_BINDING) process.env.PA_SQLITE_NATIVE_BINDING = inherited.PA_SQLITE_NATIVE_BINDING;
  const cleanup = () => {
    closeDb(); for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
    Object.assign(process.env, inherited); rmSync(root, { recursive: true, force: true });
  };
  let result: T;
  try { result = run(root); } catch (error) { cleanup(); throw error; }
  if (result instanceof Promise) return result.finally(cleanup) as T;
  cleanup(); return result;
}

function fixture(root: string, role: ReadOnlyHelperRole) {
  const canonical = join(root, "canonical"), candidate = join(root, "candidate");
  mkdirSync(canonical); git(canonical, "init", "-q", "-b", "develop");
  git(canonical, "config", "user.name", "Helper fixture"); git(canonical, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(canonical, "identity"), "canonical\n"); git(canonical, "add", "identity"); git(canonical, "commit", "-qm", "fixture");
  const base = git(canonical, "rev-parse", "HEAD"), branch = "feature/ALT-7-helper";
  git(canonical, "worktree", "add", "-b", branch, candidate);
  writeFileSync(join(candidate, "identity"), "candidate\n"); git(candidate, "add", "identity"); git(candidate, "commit", "-qm", "candidate");
  const head = git(candidate, "rev-parse", "HEAD"), physical = (() => {
    mkdirSync(join(root, "config")); writeFileSync(join(root, "config", "repos.yaml"), `repos:\n  fixture:\n    path: ${canonical}\n    prefix: ALT\n  unrelated:\n    path: ${root}/unrelated\n    prefix: OTHER\n`);
    return resolveRepoExecutionPath(undefined, candidate, { allowLinkedWorktreeCwd: true });
  })();
  const ticketPath = join(root, "tickets", "ALT-7.json");
  const ticket = { id: "ALT-7", project: "fixture", status: "implementing", approvals: ["operator-approved"],
    title: "candidate board sentinel", summary: "fixture", priority: "medium", type: "task", assignee: "fixture", estimate: "S", tags: [],
    doc_refs: [], linkedCommits: [], comments: [], subTickets: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", resolvedAt: null,
    linkedBranches: [{ repo: "fixture", branch, state: "materialized", baseSha: base, headSha: head }] };
  protectedWrite(ticketPath, ticket);
  const snapshot = captureRepositoryGitSnapshot(candidate);
  const fingerprint = readProcessFingerprint(process.pid)!;
  assert.ok(fingerprint);
  const id = "d-249abc", parent = "d-249def", directory = getDeployPaths(id).deployDir;
  const mode = role === "review-auto" ? "review-auto" : role === "worker-consistency-only" ? "worker" : role === "orchestrator" ? "orchestrator" : "implement";
  const team = role === "review-auto" ? "requirements" : "builder";
  Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: directory, PA_TEAM: team, PA_MODE: mode, PA_TICKET_ID: "ALT-7", PA_REPO: candidate, PA_WORKTREE_ROOT: candidate });
  mkdirSync(directory, { recursive: true });
  assert.equal(recordPiProcessIdentity(id, directory, process.pid), true);
  const status: DeploymentStatus = { deploy_id: id, team, mode, status: "running", started_at: new Date().toISOString(), pid: process.pid, agents: [],
    runtime: "pi", binary: "ppa", ticket_id: "ALT-7", repo: candidate, repo_root: canonical, worktree_root: candidate };
  const binding = { builder_authority: role === "standalone-implement" ? "standalone-implement" as const : "orchestrator" as const,
    treehouse_path: candidate, treehouse_lease_id: "fixture-lease", treehouse_lease_holder: "pa:fixture:ALT-7", branch_state: "materialized" as const,
    branch_base_sha: base, branch_head_sha: head, ticket_slot_id: "pa:fixture:ALT-7", repository_permit: 1 as const };
  const ownerId = role === "parented-implement" ? parent : id;
  const owner: RepositoryMutationLease = { schemaVersion: 1, ownershipToken: "private-fixture-owner", canonicalRepoKey: "fixture", canonicalRepoRoot: canonical,
    worktreeRoot: candidate, repositoryGitDir: physical.gitDir, repositoryGitCommonDir: physical.gitCommonDir,
    slot: role === "standalone-implement" ? "implement" : "orchestrator", deploymentId: ownerId, deploymentDirectory: getDeployPaths(ownerId).deployDir,
    runtime: "pi", team: "builder", mode: role === "standalone-implement" ? "implement" : "orchestrator", processFingerprint: fingerprint,
    acquiredAt: status.started_at, preLaunchGitSnapshot: snapshot, ticket: "ALT-7" };
  const borrower: RepositoryMutationBorrower = { schemaVersion: 1, borrowerToken: "private-fixture-borrower", canonicalRepoKey: "fixture", canonicalRepoRoot: canonical,
    worktreeRoot: candidate, parentDeploymentId: parent, parentProcessFingerprint: fingerprint, deploymentId: id, deploymentDirectory: directory,
    runtime: "pi", team: "builder", mode: "implement", launchMode: "background", ticket: "ALT-7", branch,
    processFingerprint: fingerprint, registeredAt: status.started_at, timeoutSeconds: 1800, launchGitSnapshot: snapshot };
  const slot: RepositoryTicketSlot = { schemaVersion: 1, slotToken: "private-fixture-slot", slotId: "pa:fixture:ALT-7", canonicalRepoKey: "fixture", canonicalRepoRoot: canonical,
    ticket: "ALT-7", deploymentId: ownerId, deploymentDirectory: owner.deploymentDirectory, repositoryPermit: 1, processFingerprint: fingerprint, acquiredAt: status.started_at };
  const statuses = new Map<string, DeploymentStatus>([[id, status]]);
  if (role !== "worker-consistency-only" && role !== "review-auto") {
    Object.assign(status, binding, { builder_authority: role, ...(role === "parented-implement" ? { parent_deployment_id: parent } : {}) });
    protectedWrite(repositoryMutationLeasePath(candidate, owner.slot), owner);
    protectedWrite(repositoryTicketSlotPath(canonical, "ALT-7"), slot);
  }
  if (role === "worker-consistency-only") Object.assign(status, { branch_state: "materialized", branch_base_sha: base, branch_head_sha: head });
  if (role === "parented-implement") {
    statuses.set(parent, { ...status, ...binding, deploy_id: parent, mode: "orchestrator", parent_deployment_id: undefined });
    mkdirSync(owner.deploymentDirectory, { recursive: true });
    assert.equal(recordPiProcessIdentity(parent, owner.deploymentDirectory, process.pid), true);
    protectedWrite(repositoryMutationBorrowerPath(candidate), borrower);
  }
  const checkout = { kind: "existing-review-checkout" as const, repoKey: "fixture", repoRoot: canonical, worktreeRoot: candidate, ticket: "ALT-7",
    leaseId: "fixture-lease", leaseHolder: "pa:fixture:ALT-7", branch, branchState: "materialized" as const, baseSha: base, headSha: head, featureSha: head,
    repositoryGitDir: physical.gitDir, repositoryGitCommonDir: physical.gitCommonDir, gitSnapshot: snapshot,
    approvedReference: { sha: base, matrixSource: "requirements:agent-teams/requirements/artifacts/fixture.md", matrixAuthoritySha256: "a".repeat(64), matrixApprovalEvidence: "c-20000101000000001" } };
  const review: RepositoryReviewReservation = { schemaVersion: 1, reservationToken: "private-fixture-review", deploymentId: id,
    authorizationId: "review-auth:249abcde-1234-4123-8123-123456789abc", reservedAt: status.started_at, checkout };
  const claim: ReviewAuthorizationClaim = { deploymentId: id, authorizationId: review.authorizationId, ticketId: "ALT-7", branch, featureSha: head,
    matrixSource: checkout.approvedReference.matrixSource, matrixAuthoritySha256: checkout.approvedReference.matrixAuthoritySha256,
    matrixApprovalEvidence: checkout.approvedReference.matrixApprovalEvidence, claimedAt: status.started_at, active: true };
  if (role === "review-auto") { status.review_checkout = piReviewCheckoutCorrelation(checkout); protectedWrite(repositoryReviewReservationPath(candidate), review); }
  const counters = { ownershipUpdates: 0, capacityUpdates: 0, checkoutLifecycle: 0, branchMutations: 0, ticketChanges: 0, approvalChanges: 0, childLaunches: 0 };
  let treehouseRows: unknown = [{ path: candidate, leased: true, lease_id: "fixture-lease", lease_holder: "pa:fixture:ALT-7" }];
  const treehouse = new TreehouseClient({ run: (args) => {
    if (args.join(" ") !== "status --json") { counters.checkoutLifecycle++; throw new Error("prohibited lifecycle call"); }
    return { status: 0, stdout: Buffer.from(JSON.stringify(treehouseRows)), stderr: Buffer.alloc(0) };
  } });
  let lineage = true, queryCount = 0;
  const capability = createPiReadonlyHelperCapability({ treehouse, isProcessInLineage: () => lineage,
    queryRegistry: (deployId, authorizationId) => { queryCount++; return { status: statuses.get(deployId) ?? null, claim: authorizationId === review.authorizationId ? claim : null }; } });
  return { root, canonical, candidate, physical, id, parent, status, statuses, owner, borrower, slot, review, claim, ticket, ticketPath, treehouse, capability, counters,
    setRows: (value: unknown) => { treehouseRows = value; }, setLineage: (value: boolean) => { lineage = value; }, queries: () => queryCount };
}
type Fixture = ReturnType<typeof fixture>;

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else { const stat = lstatSync(path); result[path] = `${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}:${entry.isSymbolicLink() ? "symlink" : readFileSync(path).toString("base64")}`; }
  } };
  walk(root); return result;
}
function guarded(f: Fixture, operation: () => void): void {
  const before = files(f.root), registry = JSON.stringify([...f.statuses]), feature = JSON.stringify(f.ticket);
  const branch = git(f.candidate, "branch", "--show-current");
  operation();
  const after = files(f.root);
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[path] !== after[path]) {
    if (/pa-repository-mutation|reservation/.test(path)) f.counters.ownershipUpdates++;
    else if (/pa-ticket-builder-slots/.test(path)) f.counters.capacityUpdates++;
    else if (path === f.ticketPath) { f.counters.ticketChanges++; f.counters.approvalChanges++; }
    else assert.fail(`unexpected helper file write: ${path}`);
  }
  if (branch !== git(f.candidate, "branch", "--show-current")) f.counters.branchMutations++;
  assert.deepEqual(after, before, "all checkout, authority, config and feature evidence remains byte/metadata unchanged");
  assert.equal(JSON.stringify([...f.statuses]), registry); assert.equal(JSON.stringify(f.ticket), feature);
  assert.deepEqual(Object.values(f.counters), Array(7).fill(0));
}
function rejected(action: () => unknown, classification = "authority-rejected") {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReadOnlyHelperFailure); assert.equal(error.classification, classification);
    assert.equal(error.implementationLaunchState, "unknown"); assert.ok(error.message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.ok(error.message.includes(`${label}:`));
    assert.doesNotMatch(error.message, /private-fixture|review-auth:/); return true;
  });
}

test("live role-specific helper observations are read-only and immediately reread", async (t) => {
  for (const role of roles) await t.test(role, () => isolated((root) => {
    const f = fixture(root, role); let operations = 0;
    guarded(f, () => {
      const auth = resolveReadOnlyHelperContext(undefined, f.candidate, f.capability);
      const beforeReread = f.queries();
      withReadOnlyHelperContext(auth, (context) => {
        operations++; assert.ok(f.queries() > beforeReread); assert.equal(context.role, role); assert.equal(context.access, "read-only");
        assert.equal(context.repoRoot, f.canonical); assert.equal(context.worktreeRoot, f.candidate);
        assert.equal(git(context.worktreeRoot, "branch", "--show-current"), "feature/ALT-7-helper");
        assert.equal(git(context.repoRoot, "branch", "--show-current"), "develop");
        assert.doesNotMatch(JSON.stringify(context), /private-fixture|review-auth:/);
      });
    }); assert.equal(operations, 1);
  }));
});

const negatives: Array<[string, (f: Fixture) => void]> = [
  ["missing locator", () => { delete process.env.PA_DEPLOYMENT_ID; }],
  ["malformed locator", () => { process.env.PA_DEPLOYMENT_ID = "forged"; }],
  ["environment-only", (f) => { f.statuses.clear(); }],
  ["ended deployment", (f) => { f.status.status = "success"; }],
  ["wrong ticket", () => { process.env.PA_TICKET_ID = "ALT-8"; }],
  ["wrong mode", (f) => { f.status.mode = "orchestrator"; process.env.PA_MODE = "orchestrator"; }],
  ["wrong runtime path", (f) => { f.status.worktree_root = f.canonical; }],
  ["crossed canonical domain", (f) => { f.status.repo_root = f.candidate; }],
  ["replayed process locator", (f) => { f.setLineage(false); }],
  ["wrong directory", (f) => { process.env.PA_DEPLOYMENT_DIR = f.canonical; }],
  ["Git override", (f) => { process.env.GIT_DIR = f.physical.gitDir; }],
  ["absent owner", (f) => { rmSync(repositoryMutationLeasePath(f.candidate)); }],
  ["malformed owner", (f) => { protectedWrite(repositoryMutationLeasePath(f.candidate), { schemaVersion: 1 }); }],
  ["oversized owner", (f) => { writeFileSync(repositoryMutationLeasePath(f.candidate), "x".repeat(65537)); }],
  ["insecure owner", (f) => { chmodSync(repositoryMutationLeasePath(f.candidate), 0o644); }],
  ["symlink owner", (f) => { const path = repositoryMutationLeasePath(f.candidate); rmSync(path); symlinkSync(f.ticketPath, path); }],
  ["stale owner fingerprint", (f) => { protectedWrite(repositoryMutationLeasePath(f.candidate), { ...f.owner, processFingerprint: { ...f.owner.processFingerprint, startTimeTicks: "0" } }); }],
  ["incomplete protected launch snapshot", (f) => { const { statusPorcelainV2Base64: _status, statusRecordCount: _count, statusEntries: _entries, digestSha256: _digest, ...legacy } = f.owner.preLaunchGitSnapshot; protectedWrite(repositoryMutationLeasePath(f.candidate), { ...f.owner, preLaunchGitSnapshot: legacy }); }],
  ["wrong owner ticket", (f) => { protectedWrite(repositoryMutationLeasePath(f.candidate), { ...f.owner, ticket: "ALT-8" }); }],
  ["wrong owner physical identity", (f) => { protectedWrite(repositoryMutationLeasePath(f.candidate), { ...f.owner, repositoryGitDir: f.canonical }); }],
  ["absent borrower", (f) => { rmSync(repositoryMutationBorrowerPath(f.candidate)); }],
  ["finalized/replayed borrower", (f) => { protectedWrite(repositoryMutationBorrowerPath(f.candidate), { ...f.borrower, finalizedAt: new Date().toISOString() }); }],
  ["wrong parent", (f) => { protectedWrite(repositoryMutationBorrowerPath(f.candidate), { ...f.borrower, parentDeploymentId: "d-aaaaaa" }); }],
  ["terminal parent", (f) => { f.statuses.get(f.parent)!.status = "success"; }],
  ["wrong capacity", (f) => { protectedWrite(repositoryTicketSlotPath(f.canonical, "ALT-7"), { ...f.slot, repositoryPermit: 2 }); }],
  ["missing lease", (f) => { f.setRows([]); }],
  ["wrong ticket lease", (f) => { f.setRows([{ path: f.candidate, leased: true, lease_id: "fixture-lease", lease_holder: "pa:fixture:ALT-8" }]); }],
  ["wrong ticket branch", (f) => { f.ticket.linkedBranches[0]!.branch = "feature/ALT-7-other"; protectedWrite(f.ticketPath, f.ticket); }],
  ["malformed ticket", (f) => { writeFileSync(f.ticketPath, "{bad"); }],
];
test("negative admission evidence rejects before substantive access and leaves all action counters zero", async (t) => {
  for (const [name, change] of negatives) await t.test(name, () => isolated((root) => {
    const f = fixture(root, "parented-implement"); change(f); let operations = 0;
    guarded(f, () => rejected(() => withReadOnlyHelperContext(f.capability.authenticate(f.candidate), () => { operations++; })));
    assert.equal(operations, 0);
  }));
});

test("role separation and role-specific negative evidence", async (t) => {
  const cases: Array<[ReadOnlyHelperRole, string, (f: Fixture) => void]> = [
    ["orchestrator", "mismatched active borrower blocks parent helper", (f) => protectedWrite(repositoryMutationBorrowerPath(f.candidate), f.borrower)],
    ["standalone-implement", "missing standalone owner", (f) => rmSync(repositoryMutationLeasePath(f.candidate, "implement"))],
    ["standalone-implement", "invented parent", (f) => { f.status.parent_deployment_id = f.parent; }],
    ["worker-consistency-only", "worker cannot use implement lease", (f) => protectedWrite(repositoryMutationLeasePath(f.candidate, "implement"), { ...f.owner, mode: "worker", slot: "implement" })],
    ["worker-consistency-only", "worker cannot use borrower", (f) => protectedWrite(repositoryMutationBorrowerPath(f.candidate), f.borrower)],
    ["worker-consistency-only", "wrong selected SHA", (f) => { f.status.branch_head_sha = "b".repeat(40); }],
    ["worker-consistency-only", "no invented builder authority", (f) => { f.status.builder_authority = "standalone-implement"; }],
    ["review-auto", "absent reservation", (f) => rmSync(repositoryReviewReservationPath(f.candidate))],
    ["review-auto", "replayed reservation", (f) => protectedWrite(repositoryReviewReservationPath(f.candidate), { ...f.review, deploymentId: f.parent })],
    ["review-auto", "inactive authorization", (f) => { f.claim.active = false; }],
    ["review-auto", "wrong authorization consumer", (f) => { f.claim.deploymentId = f.parent; }],
    ["review-auto", "dirty candidate", (f) => writeFileSync(join(f.candidate, "untracked\nname"), "preserve")],
    ["review-auto", "builder implementation custody", (f) => protectedWrite(repositoryMutationBorrowerPath(f.candidate), f.borrower)],
    ["review-auto", "candidate SHA mismatch", (f) => { f.status.review_checkout = { ...f.status.review_checkout!, featureSha: "b".repeat(40) }; }],
  ];
  for (const [role, name, change] of cases) await t.test(`${role}: ${name}`, () => isolated((root) => {
    const f = fixture(root, role); change(f); let operations = 0;
    guarded(f, () => rejected(() => withReadOnlyHelperContext(f.capability.authenticate(f.candidate), () => { operations++; })));
    assert.equal(operations, 0);
  }));
});

test("immediate reread rejects evidence and Git drift for every role", async (t) => {
  for (const role of roles) for (const drift of ["registry", "Git", "authority"] as const) await t.test(`${role}: ${drift}`, () => isolated((root) => {
    const f = fixture(root, role); const auth = f.capability.authenticate(f.candidate);
    if (drift === "registry") f.status.status = "failed";
    else if (drift === "Git") writeFileSync(join(f.candidate, "new\nfile"), "preserved");
    else if (role === "review-auto") protectedWrite(repositoryReviewReservationPath(f.candidate), { ...f.review, reservationToken: "replacement-private" });
    else if (role === "worker-consistency-only") f.setRows([]);
    else protectedWrite(repositoryMutationLeasePath(f.candidate, f.owner.slot), { ...f.owner, ownershipToken: "replacement-private" });
    let operations = 0;
    guarded(f, () => rejected(() => withReadOnlyHelperContext(auth, () => { operations++; }))); assert.equal(operations, 0);
  }));
});

test("valid idle custody and active direct-child custody remain observational", async (t) => {
  for (const role of ["worker-consistency-only", "review-auto", "orchestrator"] as const) await t.test(role, () => isolated((root) => {
    const f = fixture(root, role);
    if (role === "orchestrator") {
      const child = { ...f.status, deploy_id: f.parent, mode: "implement", builder_authority: "parented-implement" as const, parent_deployment_id: f.id };
      f.statuses.set(f.parent, child);
      protectedWrite(repositoryMutationBorrowerPath(f.candidate), { ...f.borrower, deploymentId: f.parent, parentDeploymentId: f.id, deploymentDirectory: getDeployPaths(f.parent).deployDir });
    } else {
      const owner = { ...f.owner, deploymentId: f.parent, deploymentDirectory: getDeployPaths(f.parent).deployDir };
      f.statuses.set(f.parent, { ...f.status, deploy_id: f.parent, team: "builder", mode: "orchestrator", builder_authority: "orchestrator",
        treehouse_path: f.candidate, treehouse_lease_id: "fixture-lease", treehouse_lease_holder: "pa:fixture:ALT-7", branch_state: "materialized",
        branch_base_sha: f.review.checkout.baseSha, branch_head_sha: f.review.checkout.featureSha });
      protectedWrite(repositoryMutationLeasePath(f.candidate), owner);
    }
    const parentDirectory = getDeployPaths(f.parent).deployDir;
    mkdirSync(parentDirectory, { recursive: true });
    assert.equal(recordPiProcessIdentity(f.parent, parentDirectory, process.pid), true);
    guarded(f, () => withReadOnlyHelperContext(f.capability.authenticate(f.candidate), (context) => assert.equal(context.role, role)));
  }));
});

test("orchestrator accepts reconciled child commits without rewriting immutable launch registry evidence", () => isolated((root) => {
  const f = fixture(root, "orchestrator");
  writeFileSync(join(f.candidate, "completed-phase"), "phase\n");
  git(f.candidate, "add", "completed-phase"); git(f.candidate, "commit", "-qm", "child phase");
  const snapshot = captureRepositoryGitSnapshot(f.candidate);
  protectedWrite(repositoryMutationLeasePath(f.candidate), { ...f.owner, authorityGitSnapshot: snapshot,
    authorityUpdatedAt: new Date().toISOString(), authorityChildDeploymentId: f.parent });
  guarded(f, () => withReadOnlyHelperContext(f.capability.authenticate(f.candidate), (context) => assert.equal(context.role, "orchestrator")));
}));

test("missing evidence command is command-unavailable, never an inferred authority/launch failure", () => isolated((root) => {
  const f = fixture(root, "orchestrator");
  const missing = new TreehouseClient({ run: () => ({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: Object.assign(new Error("synthetic missing executable"), { code: "ENOENT" }) }) });
  const capability = createPiReadonlyHelperCapability({ treehouse: missing, queryRegistry: (id) => ({ status: f.statuses.get(id) ?? null, claim: null }) });
  guarded(f, () => rejected(() => capability.authenticate(f.candidate), "command-unavailable"));
}));

test("distinct failure classes and explicit launch outcomes preserve feature lifecycle/approvals", () => isolated((root) => {
  const f = fixture(root, "orchestrator");
  guarded(f, () => {
    for (const classification of ["helper-incompatible", "authority-rejected", "command-unavailable"] as const) {
      for (const launch of ["launched", "not-launched", "unknown"] satisfies ImplementationLaunchState[]) {
        const failure = new ReadOnlyHelperFailure(classification, launch, "synthetic helper / missing diagnostic command (exit 127)", "r".repeat(10000));
        assert.equal(failure.classification, classification); assert.equal(failure.implementationLaunchState, launch);
        assert.ok(failure.message.length <= 2000); assert.match(failure.message, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
      }
    }
    rejected(() => resolveReadOnlyHelperContext(undefined, f.candidate), "helper-incompatible");
    const adapter: RuntimeAdapter = { name: "pi", async spawn() { f.counters.childLaunches++; throw new Error("no child launch allowed"); } } as RuntimeAdapter;
    assert.ok(createPiHooks(adapter).readOnlyHelperContext);
    assert.equal(f.ticket.status, "implementing"); assert.deepEqual(f.ticket.approvals, ["operator-approved"]);
  });
}));

test("canonical and explicit selectors do not consume the PPA capability; no global linked default", () => isolated((root) => {
  const f = fixture(root, "orchestrator"); let calls = 0;
  const forbidden = { authenticate: () => { calls++; throw new Error("must not authenticate explicit canonical selectors"); } };
  guarded(f, () => {
    const canonical = resolveReadOnlyHelperContext(undefined, f.canonical, forbidden);
    assert.equal(canonical.context.worktreeRoot, f.canonical);
    const explicit = resolveReadOnlyHelperContext("fixture", f.candidate, forbidden);
    withReadOnlyHelperContext(explicit, (context) => assert.equal(context.worktreeRoot, f.canonical));
    assert.throws(() => resolveRepoExecutionPath(undefined, f.candidate));
    assert.throws(() => resolveRepoExecutionPath(f.candidate, f.candidate, { allowLinkedWorktreeCwd: true }));
    assert.equal(calls, 0);
  });
}));

function persistRegistryFixture(f: Fixture): void {
  for (const status of f.statuses.values()) {
    const event: RegistryEvent = { deployment_id: status.deploy_id, event: "started", timestamp: status.started_at,
      team: status.team, mode: status.mode, runtime: status.runtime, binary: status.binary, ticket_id: status.ticket_id,
      repo: status.repo, repo_root: status.repo_root, worktree_root: status.worktree_root,
      builder_authority: status.builder_authority, parent_deployment_id: status.parent_deployment_id,
      treehouse_path: status.treehouse_path, treehouse_lease_id: status.treehouse_lease_id, treehouse_lease_holder: status.treehouse_lease_holder,
      branch_state: status.branch_state, branch_base_sha: status.branch_base_sha, branch_head_sha: status.branch_head_sha,
      ticket_slot_id: status.ticket_slot_id, repository_permit: status.repository_permit, review_checkout: status.review_checkout };
    appendRegistryEvent(event);
    appendRegistryEvent({ deployment_id: status.deploy_id, team: status.team, event: "pid", timestamp: status.started_at, pid: status.pid });
  }
  if (f.status.mode === "review-auto") {
    const c = f.claim;
    getDb().prepare(`INSERT INTO review_authorization_claims (authorization_id, deployment_id, ticket_id, branch, feature_sha,
      matrix_source, matrix_authority_sha256, matrix_approval_evidence, claimed_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(c.authorizationId, c.deploymentId, c.ticketId, c.branch, c.featureSha, c.matrixSource, c.matrixAuthoritySha256, c.matrixApprovalEvidence, c.claimedAt);
  }
  // Fixture-only preparation avoids measuring SQLite journal setup as a helper write.
  getDb().pragma("journal_mode = DELETE");
}
function builtCli(f: Fixture) {
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  assert.ok(readFileSync(cli).length, "build the candidate PPA CLI before contract verification");
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const treehouse = join(bin, "treehouse");
  writeFileSync(treehouse, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'status --json') process.exit(89);\nprocess.stdout.write(${JSON.stringify(JSON.stringify([{ path: f.candidate, leased: true, lease_id: "fixture-lease", lease_holder: "pa:fixture:ALT-7" }]))});\n`, { mode: 0o700 });
  return (args: string[], environment: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: f.candidate, encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1", ...environment } });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

test("built candidate PPA CLI authenticates every role and reads the selected branch/project/ownership, with zero lifecycle actions", async (t) => {
  for (const role of roles) await t.test(role, () => isolated((root) => {
    const f = fixture(root, role);
    protectedWrite(join(root, "tickets", "OTHER-1.json"), { ...f.ticket, id: "OTHER-1", project: "unrelated", title: "unrelated board sentinel", linkedBranches: [] });
    persistRegistryFixture(f); const run = builtCli(f);
    const events = getDb().prepare("SELECT * FROM registry_events").all();
    guarded(f, () => {
      const branch = run(["branch", "validate"]);
      assert.equal(branch.code, 0, branch.stderr); assert.equal(branch.stdout, ""); assert.equal(branch.stderr, "");
      const board = run(["board"]);
      assert.equal(board.code, 0, board.stderr); assert.match(board.stdout, /candidate board sentinel/); assert.doesNotMatch(board.stdout, /unrelated board sentinel/);
      const inspection = run(["repository", "inspect"]);
      assert.equal(inspection.code, 0, inspection.stderr); assert.match(inspection.stdout, new RegExp(`role=${role}`));
      assert.ok(inspection.stdout.includes(`repo_root=${f.canonical} worktree_root=${f.candidate}`));
      assert.match(inspection.stdout, ["worker-consistency-only", "review-auto"].includes(role) ? /state=absent.*Owner: unavailable/s : /state=live/);
      for (const args of [["branch", "create", "ALT-7", "--topic", "forbidden"], ["repository", "quarantine", "--expected-evidence", `v1-${"a".repeat(64)}`]]) {
        const mutation = run(args); assert.equal(mutation.code, 1); assert.match(mutation.stderr, /linked Git working tree/);
      }
    });
    assert.deepEqual(getDb().prepare("SELECT * FROM registry_events").all(), events);
  }));
});

test("built CLI rejects ended/replayed/forged locators and missing commands without substantive helper output", async (t) => {
  for (const failure of ["ended", "replay", "environment-only", "missing-command", "missing-git"] as const) await t.test(failure, () => isolated((root) => {
    const f = fixture(root, "orchestrator"); persistRegistryFixture(f); const run = builtCli(f);
    if (failure === "ended") appendRegistryEvent({ deployment_id: f.id, team: "builder", event: "completed", timestamp: new Date().toISOString(), status: "failed" });
    if (failure === "replay") {
      // An unrelated but live PID cannot authorize this test child's process lineage.
      getDb().prepare("UPDATE deployments SET pid = 1 WHERE deployment_id = ?").run(f.id);
    }
    if (failure === "environment-only") process.env.PA_DEPLOYMENT_ID = "d-000000";
    if (failure === "missing-command") rmSync(join(root, "bin", "treehouse"));
    // Ensure an unrelated installed treehouse cannot satisfy the missing-command case.
    if (failure === "missing-command") writeFileSync(join(root, "bin", "treehouse"), `#!${process.execPath}\nprocess.exit(127);\n`, { mode: 0o700 });
    guarded(f, () => {
      for (const args of [["branch", "validate"], ["board"], ["repository", "inspect"]]) {
        const result = run(args, failure === "missing-git" ? { PATH: join(root, "bin") } : {});
        assert.equal(result.code, 1); assert.equal(result.stdout, "");
        assert.match(result.stderr, failure.startsWith("missing-") ? /command-unavailable/ : /authority-rejected/);
        assert.match(result.stderr, /implementation unknown/); assert.ok(result.stderr.trim().length <= 2000);
        for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.ok(result.stderr.includes(`${label}:`));
      }
    });
  }));
});

test("every role rejects stale PID incarnations with default process checks and built CLI", async (t) => {
  for (const role of roles) {
    for (const kind of ["absent", "incarnation", "boot", "pid", "deployment", "malformed", "insecure", "symlink", "oversized"] as const) {
      await t.test(`${role}: ${kind}`, () => isolated((root) => {
        const f = fixture(root, role);
        const path = join(getDeployPaths(f.id).deployDir, PI_PROCESS_IDENTITY_FILE);
        const identity = JSON.parse(readFileSync(path, "utf8"));
        // Retain a stale running registry (and review reservation/claim) whose
        // numeric PID is now the live test ancestor. Never refresh its anchor.
        f.status.started_at = "2000-01-01T00:00:00.000Z";
        f.claim.claimedAt = f.status.started_at;
        if (role === "review-auto") protectedWrite(repositoryReviewReservationPath(f.candidate), { ...f.review, reservedAt: f.status.started_at });
        if (kind === "absent") rmSync(path);
        else if (kind === "incarnation") protectedWrite(path, { ...identity, processFingerprint: { ...identity.processFingerprint, startTimeTicks: "0" } });
        else if (kind === "boot") protectedWrite(path, { ...identity, processFingerprint: { ...identity.processFingerprint, bootId: "00000000-0000-0000-0000-000000000000" } });
        else if (kind === "pid") protectedWrite(path, { ...identity, processFingerprint: { ...identity.processFingerprint, pid: 1 } });
        else if (kind === "deployment") protectedWrite(path, { ...identity, deploymentId: f.parent });
        else if (kind === "malformed") protectedWrite(path, { ...identity, processFingerprint: { pid: process.pid } });
        else if (kind === "insecure") chmodSync(path, 0o644);
        else if (kind === "symlink") { rmSync(path); symlinkSync(f.ticketPath, path); }
        else writeFileSync(path, "x".repeat(4097));
        persistRegistryFixture(f); const run = builtCli(f);
        const capability = createPiReadonlyHelperCapability({ treehouse: f.treehouse });
        let substantiveCalls = 0;
        guarded(f, () => {
          rejected(() => withReadOnlyHelperContext(capability.authenticate(f.candidate), () => { substantiveCalls++; }));
          for (const args of [["branch", "validate"], ["board"], ["repository", "inspect"]]) {
            const result = run(args);
            assert.equal(result.code, 1); assert.equal(result.stdout, "");
            assert.match(result.stderr, /authority-rejected/); assert.match(result.stderr, /implementation unknown/);
            assert.ok(result.stderr.trim().length <= 2000);
            assert.doesNotMatch(result.stderr, /private-fixture|startTimeTicks|bootId|review-auth:/);
          }
        });
        assert.equal(substantiveCalls, 0);
      }));
    }
  }
});

test("every role's immediate reread rejects replaced launch anchors before substantive access", async (t) => {
  for (const role of roles) await t.test(role, () => isolated((root) => {
    const f = fixture(root, role);
    persistRegistryFixture(f);
    const capability = createPiReadonlyHelperCapability({ treehouse: f.treehouse });
    const auth = capability.authenticate(f.candidate);
    const path = join(getDeployPaths(f.id).deployDir, PI_PROCESS_IDENTITY_FILE);
    const identity = JSON.parse(readFileSync(path, "utf8"));
    protectedWrite(path, { ...identity, processFingerprint: { ...identity.processFingerprint, startTimeTicks: "0" } });
    let substantiveCalls = 0;
    guarded(f, () => rejected(() => withReadOnlyHelperContext(auth, () => { substantiveCalls++; })));
    assert.equal(substantiveCalls, 0);
  }));
});

// A real four-process tree models parent supervisor -> parent Pi -> child
// supervisor -> child Pi. Commands run underneath the selected Pi process; no
// process/lineage dependency seams are used by these built-CLI regressions.
async function roleProcesses() {
  const source = `
    const { spawn, spawnSync } = require('node:child_process');
    const index = Number(process.argv[1]);
    const child = index < 3 ? spawn(process.execPath, ['-e', process.execArgv[1], String(index + 1)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }) : undefined;
    const ready = (pids) => process.send({ ready: [process.pid, ...pids] });
    if (child) child.on('message', (message) => message.ready ? ready(message.ready) : process.send(message));
    else ready([]);
    process.on('message', (message) => {
      if (message.target !== index) { child.send(message); return; }
      const result = spawnSync(process.execPath, message.args, { cwd: message.cwd, env: message.env, encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024 });
      process.send({ result: { code: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message, signal: result.signal } });
    });
    process.on('disconnect', () => { if (child?.connected) child.disconnect(); process.exit(0); });
  `;
  const controller = spawn(process.execPath, ["-e", source, "0"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const receive = <T>(key: string): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { controller.off("message", onMessage); reject(new Error(`role process ${key} timed out`)); }, 40_000);
    const onMessage = (message: unknown) => {
      const row = message as Record<string, T>;
      if (row[key] !== undefined) { clearTimeout(timer); controller.off("message", onMessage); resolve(row[key]!); }
    };
    controller.on("message", onMessage);
  });
  try {
    const pids = await receive<number[]>("ready");
    assert.equal(new Set(pids).size, 4);
    return { pids, async run(target: number, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
      const pending = receive<{ code: number; stdout: string; stderr: string; error?: string; signal: string | null }>("result");
      controller.send({ target, args, cwd, env });
      const result = await pending;
      assert.equal(result.error, undefined); assert.equal(result.signal, null);
      return result;
    }, async close() {
      const exited = new Promise<void>((resolve) => controller.once("exit", () => resolve()));
      controller.disconnect(); await exited;
    } };
  } catch (error) { controller.kill(); throw error; }
}

test("built CLI binds distinct historical supervisor and Pi-child incarnations for all roles", async (t) => {
  for (const scenario of [...roles, "orchestrator-active-borrower"] as const) await t.test(scenario, () => isolated(async (root) => {
    const activeBorrower = scenario === "orchestrator-active-borrower";
    const role = activeBorrower ? "orchestrator" : scenario;
    const f = fixture(root, role), processes = await roleProcesses();
    try {
      const [ownerSupervisor, ownerPi, borrowerSupervisor, borrowerPi] = processes.pids as [number, number, number, number];
      const parented = role === "parented-implement", optionalOwner = role === "worker-consistency-only" || role === "review-auto";
      const target = parented || optionalOwner ? 3 : 1;
      f.status.pid = processes.pids[target];
      assert.equal(recordPiProcessIdentity(f.id, getDeployPaths(f.id).deployDir, f.status.pid!), true);
      const ownerId = parented || optionalOwner ? f.parent : f.id;
      const ownerDirectory = getDeployPaths(ownerId).deployDir;
      mkdirSync(ownerDirectory, { recursive: true });
      assert.equal(recordPiProcessIdentity(ownerId, ownerDirectory, ownerPi), true);
      const owner = { ...f.owner, deploymentId: ownerId, deploymentDirectory: ownerDirectory,
        processFingerprint: readProcessFingerprint(ownerSupervisor)! };
      protectedWrite(repositoryMutationLeasePath(f.candidate, owner.slot), owner);
      if (parented || optionalOwner) f.statuses.set(ownerId, { ...f.status, deploy_id: ownerId, pid: ownerPi, team: "builder", mode: "orchestrator",
        builder_authority: "orchestrator", parent_deployment_id: undefined, review_checkout: undefined,
        treehouse_path: f.candidate, treehouse_lease_id: "fixture-lease", treehouse_lease_holder: "pa:fixture:ALT-7",
        branch_state: "materialized", branch_base_sha: f.review.checkout.baseSha, branch_head_sha: f.review.checkout.headSha,
        ticket_slot_id: f.slot.slotId, repository_permit: f.slot.repositoryPermit });
      if (!optionalOwner) protectedWrite(repositoryTicketSlotPath(f.canonical, "ALT-7"), { ...f.slot,
        processFingerprint: owner.processFingerprint });
      if (parented) protectedWrite(repositoryMutationBorrowerPath(f.candidate), { ...f.borrower,
        parentProcessFingerprint: owner.processFingerprint, processFingerprint: readProcessFingerprint(borrowerSupervisor)! });
      if (activeBorrower) {
        const childDirectory = getDeployPaths(f.parent).deployDir;
        mkdirSync(childDirectory, { recursive: true });
        assert.equal(recordPiProcessIdentity(f.parent, childDirectory, borrowerPi), true);
        f.statuses.set(f.parent, { ...f.status, deploy_id: f.parent, pid: borrowerPi, mode: "implement",
          builder_authority: "parented-implement", parent_deployment_id: f.id });
        protectedWrite(repositoryMutationBorrowerPath(f.candidate), { ...f.borrower, deploymentId: f.parent,
          deploymentDirectory: childDirectory, parentDeploymentId: f.id, parentProcessFingerprint: owner.processFingerprint,
          processFingerprint: readProcessFingerprint(borrowerSupervisor)! });
      }
      persistRegistryFixture(f); builtCli(f);
      const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
      const environment = { ...process.env, NO_COLOR: "1", PATH: `${join(root, "bin")}:${process.env.PATH}` };
      const run = (args: string[]) => processes.run(target, [cli, ...args], f.candidate, environment);
      const before = files(root), events = getDb().prepare("SELECT * FROM registry_events").all();
      for (const args of [["branch", "validate"], ["board"], ["repository", "inspect"]]) {
        const result = await run(args); assert.equal(result.code, 0, result.stderr);
        if (args[0] === "board") assert.match(result.stdout, /candidate board sentinel/);
        if (args[0] === "repository") assert.ok(result.stdout.includes(`role=${role}`));
      }
      assert.deepEqual(files(root), before, "real-process helper reads must not change any fixture evidence");
      assert.deepEqual(getDb().prepare("SELECT * FROM registry_events").all(), events);
      // Even optional owners must retain both historical child identity and live
      // supervisor ancestry. A live numeric PID alone is never an anchor.
      const ownerAnchor = join(ownerDirectory, PI_PROCESS_IDENTITY_FILE), bytes = readFileSync(ownerAnchor);
      for (const bad of ["missing-owner-anchor", "replayed-owner-incarnation", "wrong-supervisor-lineage"] as const) {
        if (bad === "missing-owner-anchor") rmSync(ownerAnchor);
        else if (bad === "replayed-owner-incarnation") {
          const value = JSON.parse(bytes.toString());
          protectedWrite(ownerAnchor, { ...value, processFingerprint: { ...value.processFingerprint, startTimeTicks: "0" } });
        } else protectedWrite(repositoryMutationLeasePath(f.candidate, owner.slot), { ...owner, processFingerprint: readProcessFingerprint(borrowerPi)! });
        const rejectedBefore = files(root);
        const result = await run(["branch", "validate"]);
        assert.equal(result.code, 1, `${role}: ${bad}`); assert.equal(result.stdout, ""); assert.match(result.stderr, /authority-rejected/);
        assert.deepEqual(files(root), rejectedBefore);
        protectedWrite(ownerAnchor, JSON.parse(bytes.toString()));
        protectedWrite(repositoryMutationLeasePath(f.candidate, owner.slot), owner);
      }
      if (parented) {
        // Registry/anchor agree on a live Pi, but it is not below the recorded
        // borrower supervisor. This must fail independently of PID equality.
        getDb().prepare("UPDATE deployments SET pid = ? WHERE deployment_id = ?").run(ownerPi, f.id);
        assert.equal(recordPiProcessIdentity(f.id, getDeployPaths(f.id).deployDir, ownerPi), true);
        const result = await run(["branch", "validate"]);
        assert.equal(result.code, 1); assert.match(result.stderr, /borrower Pi child is outside/);
      }
    } finally { await processes.close(); }
  }));
});

test("production registry probe is existing-only and read-only, with no migrations or invented launch", () => isolated((root) => {
  assert.throws(() => queryReadonlyHelperRegistry("d-249abc"));
  assert.deepEqual(readdirSync(root), [], "missing registry probe creates nothing");
  const f = fixture(root, "orchestrator");
  appendRegistryEvent({ deployment_id: f.id, team: "builder", mode: "orchestrator", runtime: "pi", binary: "ppa", event: "started", timestamp: f.status.started_at,
    ticket_id: "ALT-7", repo: f.candidate, repo_root: f.canonical, worktree_root: f.candidate, builder_authority: "orchestrator",
    treehouse_path: f.candidate, treehouse_lease_id: "fixture-lease", treehouse_lease_holder: "pa:fixture:ALT-7", branch_state: "materialized",
    branch_base_sha: f.status.branch_base_sha, branch_head_sha: f.status.branch_head_sha, ticket_slot_id: "pa:fixture:ALT-7", repository_permit: 1 });
  appendRegistryEvent({ deployment_id: f.id, team: "builder", event: "pid", timestamp: f.status.started_at, pid: process.pid });
  const db = getDb(); const before = db.prepare("SELECT * FROM registry_events").all();
  const capability = createPiReadonlyHelperCapability({ treehouse: f.treehouse });
  withReadOnlyHelperContext(capability.authenticate(f.candidate), (context) => assert.equal(context.role, "orchestrator"));
  assert.deepEqual(db.prepare("SELECT * FROM registry_events").all(), before);
  assert.equal(queryReadonlyHelperRegistry(f.id).status?.status, "running");
}));
