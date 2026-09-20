import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRepositoryMutationLease, acquireRepositoryTicketSlot, appendRegistryEvent, closeDb, queryDeploymentStatus, releaseRepositoryMutationLease, releaseRepositoryTicketSlot, repositoryMutationLeasePath, repositoryTicketSlotPath, type RuntimeAdapter, type SpawnOpts } from "@pa-platform/pa-core";
import { deployWithPi } from "../deploy.js";
import { deriveTreehouseLeaseHolder, MAX_TREEHOUSE_JSON_BYTES, TreehouseClient, type TreehouseCommandResult } from "../treehouse.js";

function result(stdout: unknown, status = 0): TreehouseCommandResult {
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(typeof stdout === "string" ? stdout : JSON.stringify(stdout));
  return { status, stdout: bytes, stderr: Buffer.alloc(0) };
}

function git(args: string[], cwd: string): string { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function initializeRepo(path: string): void {
  mkdirSync(path);
  git(["init", "-b", "develop"], path);
  git(["config", "user.name", "Test"], path);
  git(["config", "user.email", "test@example.com"], path);
  writeFileSync(join(path, "README.md"), "initial\n");
  git(["add", "README.md"], path);
  git(["commit", "-m", "initial"], path);
}

test("Treehouse JSON boundary acquires from an exact v2.3.0 free row, reuses one lease, and rejects malformed evidence", () => {
  const calls: string[][] = [];
  const free = { name: "1", path: "/tmp/treehouse/free", status: "free", flavor: "git", lease_id: "", lease_holder: "", leased_at: null, processes: [] };
  const lease = { path: "/tmp/treehouse/one", status: "leased", leased: true, lease_id: "lease-1", lease_holder: "pa:registered:PAP-1", leased_at: "2026-09-17T00:00:00Z" };
  const acquire = new TreehouseClient({ run: (args) => {
    calls.push([...args]);
    return args[0] === "status" ? result([free]) : result(lease);
  } });
  assert.equal(deriveTreehouseLeaseHolder("registered", "PAP-1"), "pa:registered:PAP-1");
  assert.deepEqual(acquire.acquireOrReuse("/repo", "registered", "PAP-1"), { path: lease.path, leaseId: "lease-1", leaseHolder: "pa:registered:PAP-1", leasedAt: "2026-09-17T00:00:00Z" });
  assert.deepEqual(calls, [["status", "--json"], ["get", "--lease", "--lease-holder", "pa:registered:PAP-1", "--json"]]);

  let getCalled = false;
  const reuse = new TreehouseClient({ run: (args) => {
    if (args[0] === "get") getCalled = true;
    return result([lease]);
  } });
  assert.equal(reuse.acquireOrReuse("/repo", "registered", "PAP-1").leaseId, "lease-1");
  assert.equal(getCalled, false);

  const absentFlagLeased = new TreehouseClient({ run: () => result([{ ...lease, leased: undefined }]) });
  assert.equal(absentFlagLeased.status("/repo")[0]?.leased, true, "v2.3.0 status without the flag infers a lease only from complete metadata");
  const absentFlagFree = new TreehouseClient({ run: () => result([{ path: "/tmp/treehouse/free" }]) });
  assert.deepEqual(absentFlagFree.status("/repo"), [{ path: "/tmp/treehouse/free", leased: false }]);
  const exactFree = new TreehouseClient({ run: () => result([free]) });
  assert.deepEqual(exactFree.status("/repo"), [{ path: "/tmp/treehouse/free", leased: false }]);

  let invalidStatusCalls = 0;
  const invalidFree = new TreehouseClient({ run: () => {
    invalidStatusCalls += 1;
    return result([{ ...free, lease_id: "stale-lease" }]);
  } });
  assert.throws(() => invalidFree.acquireOrReuse("/repo", "registered", "PAP-1"), /non-leased state while retaining lease metadata/);
  assert.equal(invalidStatusCalls, 1, "contradictory status evidence rejects before get --lease");

  const rejected: Array<readonly [TreehouseClient, RegExp]> = [
    [new TreehouseClient({ run: () => result([lease, { ...lease, path: "/tmp/treehouse/two", lease_id: "lease-2" }]) }), /found 2 leases/],
    [new TreehouseClient({ run: () => result([lease, { ...lease }]) }), /repeats path/],
    [new TreehouseClient({ run: () => result([lease, { ...lease, path: "/tmp/treehouse/two", lease_holder: "pa:registered:PAP-2" }]) }), /repeats lease ID/],
    [new TreehouseClient({ run: () => result([{ ...lease, path: "relative" }]) }), /absolute normalized path/],
    [new TreehouseClient({ run: () => result([{ ...lease, leased: "yes" }]) }), /unexpected type/],
    [new TreehouseClient({ run: () => result([{ ...lease, unexpected: true }]) }), /unexpected field/],
    [new TreehouseClient({ run: () => result([{ ...lease, leased: false }]) }), /non-leased state while retaining lease metadata/],
    [new TreehouseClient({ run: () => result([{ ...lease, lease_holder: undefined }]) }), /leased entries require both lease_id and lease_holder/],
    [new TreehouseClient({ run: () => result([{ ...free, status: "leased" }]) }), /leased entries require both lease_id and lease_holder/],
    [new TreehouseClient({ run: () => result([{ ...free, leased: true }]) }), /contradicts status/],
    [new TreehouseClient({ run: () => result([{ ...lease, status: "free" }]) }), /non-leased state while retaining lease metadata/],
    [new TreehouseClient({ run: () => result({ worktrees: [lease] }) }), /one top-level array/],
    [new TreehouseClient({ run: () => result(null) }), /one top-level array/],
    [new TreehouseClient({ run: () => result([[lease]]) }), /status\[0\] is not an object/],
    [new TreehouseClient({ run: () => result("[") }), /not one valid UTF-8 JSON value/],
    [new TreehouseClient({ run: () => result(Buffer.from([0x5b, 0xc3, 0x28, 0x5d])) }), /not one valid UTF-8 JSON value/],
    [new TreehouseClient({ run: () => result(Buffer.concat([Buffer.from("[]"), Buffer.from([0])])) }), /contains NUL bytes/],
    [new TreehouseClient({ run: () => result(Buffer.alloc(MAX_TREEHOUSE_JSON_BYTES + 1, 0x20)) }), /exceeded 1048576 bytes/],
  ];
  for (const [client, pattern] of rejected) {
    assert.throws(() => client.acquireOrReuse("/repo", "registered", "PAP-1"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, pattern);
      assert.match(error.message, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
      assert.ok(error.message.length <= 2_000);
      return true;
    });
  }
  assert.equal(calls.some((args) => ["return", "prune", "destroy", "force"].includes(args[0] ?? "")), false, "PA never invokes destructive Treehouse lifecycle commands");
});

test("ticketed orchestrator acquires an exact free row and materializes the planned branch before spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-treehouse-planned-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const tickets = join(root, "tickets");
  const repo = join(root, "repo");
  const worktree = join(root, "leased");
  mkdirSync(config); mkdirSync(teams); mkdirSync(tickets);
  initializeRepo(repo);
  git(["worktree", "add", "--detach", worktree, "develop"], repo);
  const approvedBase = git(["rev-parse", "develop"], repo);
  writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\nrepos:\n  registered:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n    feature_branch_pattern: feature/<ticket>-<topic>\n`);
  writeFileSync(join(teams, "builder.yaml"), [
    "name: builder", "description: Builder", "objective: Build", "agents: []", "deploy_modes:",
    "  - id: orchestrator", "    label: Orchestrator", "    require_ticket: true",
  ].join("\n") + "\n");
  writeFileSync(join(tickets, "PAP-1.json"), JSON.stringify({ id: "PAP-1", project: "registered", title: "fixture", linkedBranches: [{ repo: "registered", branch: "feature/PAP-1-work", state: "planned", linkedAt: "2026-09-17T00:00:00Z", linkedBy: "requirements" }] }));
  const prior = Object.fromEntries(["PA_PLATFORM_CONFIG", "PA_PLATFORM_TEAMS", "PA_AI_USAGE_HOME", "PA_REGISTRY_DB"].map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  const priorCwd = process.cwd();
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.chdir(repo);
  let spawned: SpawnOpts | undefined;
  let spawnCount = 0;
  const adapter: RuntimeAdapter & { preflight(): Promise<void>; allocateSessionId(): string } = {
    name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "session", preflight: async () => {},
    installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "stub" }), extractActivity: () => [],
    spawn(opts) { spawned = opts; spawnCount += 1; return { sessionId: opts.sessionId ?? "session", exitCode: 0, metadata: { sessionId: opts.sessionId ?? "session" } }; },
    resume(opts) { return { sessionId: opts.sessionId, exitCode: 0, metadata: { sessionId: opts.sessionId } }; },
  };
  const free = { name: "1", path: worktree, status: "free", flavor: "git", lease_id: "", lease_holder: "", leased_at: null, processes: [] };
  const allocation = { name: "1", path: worktree, status: "leased", flavor: "git", lease_id: "lease-1", lease_holder: "pa:registered:PAP-1", leased_at: "2026-09-17T00:00:00Z" };
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const treehouse = new TreehouseClient({ run: (args, cwd) => {
    calls.push({ args: [...args], cwd });
    return args[0] === "status" ? result([free]) : result(allocation);
  } });
  const canonicalBefore = Buffer.concat([Buffer.from(git(["branch", "--show-current"], repo)), Buffer.from(git(["rev-parse", "HEAD"], repo)), execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: repo })]);
  try {
    const deployment = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-1", repo: "registered", timeout: 60 }, adapter, undefined, { treehouse });
    assert.equal(deployment.status, "success", deployment.reason);
    assert.equal(spawnCount, 1);
    assert.deepEqual(calls, [
      { args: ["status", "--json"], cwd: repo },
      { args: ["get", "--lease", "--lease-holder", "pa:registered:PAP-1", "--json"], cwd: repo },
    ]);
    assert.equal(spawned?.executionPlan?.repoRoot, repo);
    assert.equal(spawned?.executionPlan?.worktreeRoot, worktree);
    assert.equal(spawned?.executionPlan?.repositoryCwd, worktree);
    assert.equal(spawned?.executionPlan?.environment.PA_REPO, worktree);
    assert.equal(spawned?.executionPlan?.environment.PA_WORKTREE_ROOT, worktree);
    assert.equal(spawned?.executionPlan?.treehouse?.branch, "feature/PAP-1-work");
    assert.equal(spawned?.executionPlan?.treehouse?.baseSha, approvedBase);
    assert.equal(spawned?.executionPlan?.treehouse?.headSha, approvedBase);
    assert.equal(git(["branch", "--show-current"], worktree), "feature/PAP-1-work");
    const persisted = JSON.parse(readFileSync(join(tickets, "PAP-1.json"), "utf8")) as { linkedBranches: Array<{ state: string; baseSha?: string; headSha?: string }> };
    assert.equal(persisted.linkedBranches[0]?.state, "materialized");
    assert.equal(persisted.linkedBranches[0]?.baseSha, approvedBase);
    assert.equal(persisted.linkedBranches[0]?.headSha, approvedBase);
    assert.equal(existsSync(repositoryTicketSlotPath(repo, "PAP-1")), false);
    const canonicalAfter = Buffer.concat([Buffer.from(git(["branch", "--show-current"], repo)), Buffer.from(git(["rev-parse", "HEAD"], repo)), execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: repo })]);
    assert.deepEqual(canonicalAfter, canonicalBefore);
  } finally {
    process.chdir(priorCwd);
    closeDb();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("ticketed orchestrator admits legacy unknown-base evidence through immutable planning and terminal projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-treehouse-deploy-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const tickets = join(root, "tickets");
  const repo = join(root, "repo");
  const worktree = join(root, "leased");
  mkdirSync(config); mkdirSync(teams); mkdirSync(tickets);
  initializeRepo(repo);
  git(["worktree", "add", "--detach", worktree, "develop"], repo);
  const legacyHead = git(["rev-parse", "develop"], repo);
  git(["branch", "feature/PAP-1-work", legacyHead], repo);
  git(["checkout", "--no-guess", "feature/PAP-1-work"], worktree);
  writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\nrepos:\n  registered:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n    feature_branch_pattern: feature/<ticket>-<topic>\n`);
  writeFileSync(join(teams, "builder.yaml"), [
    "name: builder", "description: Builder", "objective: Build", "agents: []", "deploy_modes:",
    "  - id: orchestrator", "    label: Orchestrator", "    require_ticket: true",
    "  - id: implement", "    label: Implement", "    require_ticket: true",
  ].join("\n") + "\n");
  writeFileSync(join(tickets, "PAP-1.json"), JSON.stringify({ id: "PAP-1", project: "registered", title: "fixture", linkedBranches: [{ repo: "registered", branch: "feature/PAP-1-work", sha: legacyHead, linkedAt: "2026-09-17T00:00:00Z", linkedBy: "legacy" }] }));
  const prior = Object.fromEntries(["PA_PLATFORM_CONFIG", "PA_PLATFORM_TEAMS", "PA_AI_USAGE_HOME", "PA_REGISTRY_DB", "PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_REPO", "PA_WORKTREE_ROOT", "PA_TREEHOUSE_LEASE_ID", "PA_TREEHOUSE_LEASE_HOLDER", "PA_TICKET_SLOT", "PA_REPOSITORY_PERMIT"].map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  const priorCwd = process.cwd();
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.chdir(repo);
  let spawned: SpawnOpts | undefined;
  let spawnCount = 0;
  const adapter: RuntimeAdapter & { preflight(): Promise<void>; allocateSessionId(): string } = {
    name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "session", preflight: async () => {},
    installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "stub" }), extractActivity: () => [],
    spawn(opts) { spawned = opts; spawnCount += 1; return { sessionId: opts.sessionId ?? "session", exitCode: 0, metadata: { sessionId: opts.sessionId ?? "session" } }; },
    resume(opts) { return { sessionId: opts.sessionId, exitCode: 0, metadata: { sessionId: opts.sessionId } }; },
  };
  const leaseJson = { path: worktree, leased: true, lease_id: "lease-1", lease_holder: "pa:registered:PAP-1", leased_at: "2026-09-17T00:00:00Z" };
  const treehouse = new TreehouseClient({ run: () => result([leaseJson]) });
  const malformedTreehouse = new TreehouseClient({ run: () => result([{ ...leaseJson, path: "relative" }]) });
  const canonicalBefore = Buffer.concat([Buffer.from(git(["branch", "--show-current"], repo)), Buffer.from(git(["rev-parse", "HEAD"], repo)), execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: repo })]);
  try {
    const rejected = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-1", repo: "registered", timeout: 60 }, adapter, undefined, { treehouse: malformedTreehouse });
    assert.equal(rejected.status, "failed");
    assert.match(rejected.reason ?? "", /absolute normalized path/);
    assert.equal(spawned, undefined);
    assert.equal(existsSync(repositoryTicketSlotPath(repo, "PAP-1")), false);

    const deployment = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-1", repo: "registered", timeout: 60 }, adapter, undefined, { treehouse });
    assert.equal(deployment.status, "success");
    assert.ok(spawned?.executionPlan);
    const plan = spawned!.executionPlan!;
    assert.equal(plan.repoRoot, repo);
    assert.equal(plan.worktreeRoot, worktree);
    assert.equal(plan.repositoryCwd, worktree);
    assert.equal(plan.memoryDocumentRoot, worktree);
    assert.equal(plan.environment.PA_REPO, worktree);
    assert.equal(plan.environment.PA_WORKTREE_ROOT, worktree);
    assert.equal(plan.environment.PA_TREEHOUSE_LEASE_ID, "lease-1");
    assert.equal(plan.treehouse?.leaseHolder, "pa:registered:PAP-1");
    assert.equal(plan.treehouse?.branch, "feature/PAP-1-work");
    assert.equal(plan.treehouse?.baseSha, undefined, "immutable planning preserves the unknown legacy base");
    assert.equal(plan.treehouse?.headSha, legacyHead);
    assert.equal(Object.isFrozen(plan.treehouse), true);
    const primer = readFileSync(spawned!.primerPath, "utf8");
    assert.match(primer, /Immutable Treehouse Ticket Checkout Evidence/);
    assert.match(primer, new RegExp(`^repo_root: ${escapeRegExp(repo)}$`, "m"));
    assert.match(primer, new RegExp(`^cwd: ${escapeRegExp(worktree)}$`, "m"));
    assert.match(primer, new RegExp(`^repo: ${escapeRegExp(worktree)}$`, "m"));
    assert.match(primer, new RegExp(`^  PA_REPO: ${escapeRegExp(worktree)}$`, "m"));
    assert.match(primer, new RegExp(`state=materialized, base=unknown, head=${legacyHead}`));
    assert.equal(git(["branch", "--show-current"], worktree), "feature/PAP-1-work");
    const persistedAfterLaunch = JSON.parse(readFileSync(join(tickets, "PAP-1.json"), "utf8")) as { linkedBranches: Array<{ baseSha?: string; headSha: string }> };
    assert.equal(persistedAfterLaunch.linkedBranches[0]?.baseSha, undefined);
    assert.equal(persistedAfterLaunch.linkedBranches[0]?.headSha, legacyHead);
    const terminalStatus = queryDeploymentStatus(deployment.deploymentId!);
    assert.equal(terminalStatus?.branch_base_sha, undefined, "registry terminal projection preserves the unknown base");
    assert.equal(terminalStatus?.branch_head_sha, legacyHead);
    assert.equal(existsSync(repositoryTicketSlotPath(repo, "PAP-1")), false);
    const canonicalAfter = Buffer.concat([Buffer.from(git(["branch", "--show-current"], repo)), Buffer.from(git(["rev-parse", "HEAD"], repo)), execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: repo })]);
    assert.deepEqual(canonicalAfter, canonicalBefore);
    assert.equal(leaseJson.lease_id, "lease-1");

    process.chdir(repo);
    spawned = undefined;
    const canonicalStandalone = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-1", timeout: 60 }, adapter, undefined, { treehouse });
    assert.equal(canonicalStandalone.status, "failed");
    assert.match(canonicalStandalone.reason ?? "", /standalone implement.*canonical root/is);
    assert.equal(spawned, undefined);
    assert.ok((canonicalStandalone.reason ?? "").length <= 2_000);

    process.chdir(worktree);
    const standalone = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-1", timeout: 60 }, adapter, undefined, { treehouse });
    assert.equal(standalone.status, "success");
    assert.equal(spawned?.executionPlan?.treehouse?.authority, "standalone-implement");
    assert.equal(spawned?.executionPlan?.repositoryAdmission.slot, "implement");
    assert.equal(existsSync(repositoryTicketSlotPath(repo, "PAP-1")), false);
    assert.equal(existsSync(repositoryMutationLeasePath(worktree, "implement")), false);

    const parentDeploymentId = "d-acde12";
    const parentDir = join(root, "deployments", parentDeploymentId);
    mkdirSync(parentDir, { recursive: true });
    const parentSlotResult = acquireRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: repo, ticket: "PAP-1", deploymentId: parentDeploymentId, deploymentDirectory: parentDir });
    assert.equal(parentSlotResult.status, "acquired");
    if (parentSlotResult.status !== "acquired") return;
    const parentLease = acquireRepositoryMutationLease({ canonicalRepoKey: "registered", canonicalRepoRoot: repo, worktreeRoot: worktree, deploymentId: parentDeploymentId, deploymentDirectory: parentDir, runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", ticket: "PAP-1" });
    assert.equal(parentLease.status, "acquired");
    if (parentLease.status !== "acquired") return;
    const linked = JSON.parse(readFileSync(join(tickets, "PAP-1.json"), "utf8")) as { linkedBranches: Array<{ branch: string; baseSha?: string; headSha: string }> };
    const branch = linked.linkedBranches[0]!;
    appendRegistryEvent({
      deployment_id: parentDeploymentId, team: "builder", event: "started", timestamp: "2026-09-17T01:00:00Z", status: undefined,
      ticket_id: "PAP-1", mode: "orchestrator", runtime: "pi", repo: worktree, repo_root: repo, worktree_root: worktree,
      repository_slot: "orchestrator", builder_authority: "orchestrator", treehouse_path: worktree, treehouse_lease_id: "lease-1",
      treehouse_lease_holder: "pa:registered:PAP-1", branch_state: "materialized", branch_base_sha: branch.baseSha,
      branch_head_sha: branch.headSha, ticket_slot_id: parentSlotResult.slot.slotId, repository_permit: parentSlotResult.slot.repositoryPermit,
    });
    Object.assign(process.env, {
      PA_DEPLOYMENT_ID: parentDeploymentId, PA_DEPLOYMENT_DIR: parentDir, PA_TEAM: "builder", PA_MODE: "orchestrator",
      PA_TICKET_ID: "PAP-1", PA_REPO: repo, PA_WORKTREE_ROOT: worktree, PA_TREEHOUSE_LEASE_ID: "wrong-lease",
      PA_TREEHOUSE_LEASE_HOLDER: "pa:registered:PAP-1", PA_TICKET_SLOT: parentSlotResult.slot.slotId,
      PA_REPOSITORY_PERMIT: String(parentSlotResult.slot.repositoryPermit),
    });
    spawned = undefined;
    const beforeMismatchSpawns = spawnCount;
    const mismatchedChild = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-1", background: true, timeout: 60 }, adapter, undefined, { treehouse });
    assert.equal(mismatchedChild.status, "failed");
    assert.match(mismatchedChild.reason ?? "", /parented implement admission/);
    assert.equal(spawnCount, beforeMismatchSpawns);
    assert.ok((mismatchedChild.reason ?? "").length <= 2_000);

    process.env["PA_TREEHOUSE_LEASE_ID"] = "lease-1";
    const canonicalRootChild = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-1", background: true, timeout: 60 }, adapter, undefined, { treehouse });
    assert.equal(canonicalRootChild.status, "failed");
    assert.match(canonicalRootChild.reason ?? "", /parented implement admission/);
    assert.equal(spawnCount, beforeMismatchSpawns);
    process.env["PA_REPO"] = worktree;
    const parentedChild = await deployWithPi({ team: "builder", mode: "implement", ticket: "PAP-1", background: true, timeout: 60 }, adapter, undefined, { treehouse });
    assert.equal(parentedChild.status, "success", parentedChild.reason);
    assert.equal(spawned?.executionPlan?.treehouse?.authority, "parented-implement");
    assert.equal(spawned?.executionPlan?.treehouse?.parentDeploymentId, parentDeploymentId);
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: repo, worktreeRoot: worktree, ownershipToken: parentLease.lease.ownershipToken }).status, "released");
    assert.equal(releaseRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: repo, ticket: "PAP-1", slotToken: parentSlotResult.slot.slotToken, slotId: parentSlotResult.slot.slotId, repositoryPermit: parentSlotResult.slot.repositoryPermit }).status, "released");
    for (const key of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_REPO", "PA_WORKTREE_ROOT", "PA_TREEHOUSE_LEASE_ID", "PA_TREEHOUSE_LEASE_HOLDER", "PA_TICKET_SLOT", "PA_REPOSITORY_PERMIT"]) {
      const value = prior[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }

    process.chdir(repo);
    spawned = undefined;
    const beforeDriftSpawns = spawnCount;
    const driftAdapter = { ...adapter, preflight: async () => { git(["commit", "--allow-empty", "-m", "fixture pre-spawn drift"], worktree); } };
    const drifted = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-1", repo: "registered", timeout: 60 }, driftAdapter, undefined, { treehouse });
    assert.equal(drifted.status, "failed");
    assert.match(drifted.reason ?? "", /Treehouse launch evidence drifted|checkout branch, HEAD, or porcelain-v2 bytes changed/);
    assert.equal(spawnCount, beforeDriftSpawns);
    assert.equal(existsSync(repositoryTicketSlotPath(repo, "PAP-1")), false, "crash finalization releases only PA ticket evidence");
    assert.equal(existsSync(repositoryMutationLeasePath(worktree, "orchestrator")), false, "crash finalization releases matching PA ownership");
    assert.equal(leaseJson.lease_id, "lease-1", "Treehouse lease remains operator-owned after failure");
  } finally {
    process.chdir(priorCwd);
    closeDb();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
