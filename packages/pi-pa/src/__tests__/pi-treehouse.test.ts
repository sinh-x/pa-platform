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

function initializeRepo(path: string): void {
  mkdirSync(path);
  git(["init", "-b", "develop"], path);
  git(["config", "user.name", "Test"], path);
  git(["config", "user.email", "test@example.com"], path);
  writeFileSync(join(path, "README.md"), "initial\n");
  git(["add", "README.md"], path);
  git(["commit", "-m", "initial"], path);
}

test("Treehouse JSON boundary acquires on zero, reuses one, and rejects duplicate or malformed evidence", () => {
  const calls: string[][] = [];
  const lease = { path: "/tmp/treehouse/one", leased: true, lease_id: "lease-1", lease_holder: "pa:registered:PAP-1", leased_at: "2026-09-17T00:00:00Z" };
  const acquire = new TreehouseClient({ run: (args) => {
    calls.push([...args]);
    return args[0] === "status" ? result({ worktrees: [] }) : result(lease);
  } });
  assert.equal(deriveTreehouseLeaseHolder("registered", "PAP-1"), "pa:registered:PAP-1");
  assert.deepEqual(acquire.acquireOrReuse("/repo", "registered", "PAP-1"), { path: lease.path, leaseId: "lease-1", leaseHolder: "pa:registered:PAP-1", leasedAt: "2026-09-17T00:00:00Z" });
  assert.deepEqual(calls, [["status", "--json"], ["get", "--lease", "--lease-holder", "pa:registered:PAP-1", "--json"]]);

  let getCalled = false;
  const reuse = new TreehouseClient({ run: (args) => {
    if (args[0] === "get") getCalled = true;
    return result({ worktrees: [lease] });
  } });
  assert.equal(reuse.acquireOrReuse("/repo", "registered", "PAP-1").leaseId, "lease-1");
  assert.equal(getCalled, false);

  const absentFlagLeased = new TreehouseClient({ run: () => result({ worktrees: [{ ...lease, leased: undefined }] }) });
  assert.equal(absentFlagLeased.status("/repo")[0]?.leased, true, "v2.3.0 status without the flag infers a lease only from complete metadata");
  const absentFlagFree = new TreehouseClient({ run: () => result({ worktrees: [{ path: "/tmp/treehouse/free" }] }) });
  assert.deepEqual(absentFlagFree.status("/repo"), [{ path: "/tmp/treehouse/free", leased: false }]);
  for (const fixture of [
    { ...lease, leased: false },
    { ...lease, lease_holder: undefined },
  ]) {
    assert.throws(
      () => new TreehouseClient({ run: () => result({ worktrees: [fixture] }) }).status("/repo"),
      /declares leased=false while retaining lease metadata|leased entries require both lease_id and lease_holder/,
    );
  }

  const rejected = [
    new TreehouseClient({ run: () => result({ worktrees: [lease, { ...lease, path: "/tmp/treehouse/two", lease_id: "lease-2" }] }) }),
    new TreehouseClient({ run: () => result({ worktrees: [lease, { ...lease }] }) }),
    new TreehouseClient({ run: () => result({ worktrees: [{ ...lease, path: "relative" }] }) }),
    new TreehouseClient({ run: () => result({ worktrees: [{ ...lease, leased: "yes" }] }) }),
    new TreehouseClient({ run: () => result('{"worktrees":[') }),
    new TreehouseClient({ run: () => result(Buffer.concat([Buffer.from('{"worktrees":[]}'), Buffer.from([0])])) }),
    new TreehouseClient({ run: () => result(Buffer.alloc(MAX_TREEHOUSE_JSON_BYTES + 1, 0x20)) }),
  ];
  const patterns = [/found 2 leases/, /repeats path/, /absolute normalized path/, /unexpected type/, /not one valid UTF-8 JSON value/, /contains NUL bytes/, /exceeded 1048576 bytes/];
  for (const [index, client] of rejected.entries()) {
    assert.throws(() => client.acquireOrReuse("/repo", "registered", "PAP-1"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, patterns[index]!);
      assert.match(error.message, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
      assert.ok(error.message.length <= 2_000);
      return true;
    });
  }
  assert.equal(calls.some((args) => args[0] === "return"), false, "PA never invokes Treehouse return automatically");
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
  const treehouse = new TreehouseClient({ run: () => result({ worktrees: [leaseJson] }) });
  const malformedTreehouse = new TreehouseClient({ run: () => result({ worktrees: [{ ...leaseJson, path: "relative" }] }) });
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
    assert.equal(plan.environment.PA_REPO, repo);
    assert.equal(plan.environment.PA_WORKTREE_ROOT, worktree);
    assert.equal(plan.environment.PA_TREEHOUSE_LEASE_ID, "lease-1");
    assert.equal(plan.treehouse?.leaseHolder, "pa:registered:PAP-1");
    assert.equal(plan.treehouse?.branch, "feature/PAP-1-work");
    assert.equal(plan.treehouse?.baseSha, undefined, "immutable planning preserves the unknown legacy base");
    assert.equal(plan.treehouse?.headSha, legacyHead);
    assert.equal(Object.isFrozen(plan.treehouse), true);
    const primer = readFileSync(spawned!.primerPath, "utf8");
    assert.match(primer, /Immutable Treehouse Ticket Checkout Evidence/);
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
