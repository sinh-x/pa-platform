import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, repositoryTicketSlotPath, type RuntimeAdapter, type SpawnOpts } from "@pa-platform/pa-core";
import { deployWithPi } from "../deploy.js";
import { deriveTreehouseLeaseHolder, TreehouseClient, type TreehouseCommandResult } from "../treehouse.js";

function result(stdout: unknown, status = 0): TreehouseCommandResult {
  return { status, stdout: Buffer.from(typeof stdout === "string" ? stdout : JSON.stringify(stdout)), stderr: Buffer.alloc(0) };
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

  const duplicate = new TreehouseClient({ run: () => result({ worktrees: [lease, { ...lease, path: "/tmp/treehouse/two", lease_id: "lease-2" }] }) });
  assert.throws(() => duplicate.acquireOrReuse("/repo", "registered", "PAP-1"), /found 2 leases/);
  const malformed = new TreehouseClient({ run: () => result({ worktrees: [{ ...lease, path: "relative" }] }) });
  assert.throws(() => malformed.status("/repo"), /absolute normalized path/);
  const truncated = new TreehouseClient({ run: () => result('{"worktrees":[') });
  assert.throws(() => truncated.status("/repo"), /not one valid UTF-8 JSON value/);
});

test("ticketed orchestrator uses immutable Treehouse checkout plan and finalizes only PA evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-treehouse-deploy-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const tickets = join(root, "tickets");
  const repo = join(root, "repo");
  const worktree = join(root, "leased");
  mkdirSync(config); mkdirSync(teams); mkdirSync(tickets);
  initializeRepo(repo);
  git(["worktree", "add", "--detach", worktree, "develop"], repo);
  writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\nrepos:\n  registered:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n    feature_branch_pattern: feature/<ticket>-<topic>\n`);
  writeFileSync(join(teams, "builder.yaml"), [
    "name: builder", "description: Builder", "objective: Build", "agents: []", "deploy_modes:",
    "  - id: orchestrator", "    label: Orchestrator", "    require_ticket: true",
  ].join("\n") + "\n");
  writeFileSync(join(tickets, "PAP-1.json"), JSON.stringify({ id: "PAP-1", project: "registered", title: "fixture", linkedBranches: [{ repo: "registered", branch: "feature/PAP-1-work", state: "planned", linkedAt: "2026-09-17T00:00:00Z", linkedBy: "test" }] }));
  const prior = Object.fromEntries(["PA_PLATFORM_CONFIG", "PA_PLATFORM_TEAMS", "PA_AI_USAGE_HOME", "PA_REGISTRY_DB"].map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  const priorCwd = process.cwd();
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.chdir(repo);
  let spawned: SpawnOpts | undefined;
  const adapter: RuntimeAdapter & { preflight(): Promise<void>; allocateSessionId(): string } = {
    name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "session", preflight: async () => {},
    installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "stub" }), extractActivity: () => [],
    spawn(opts) { spawned = opts; return { sessionId: opts.sessionId ?? "session", exitCode: 0, metadata: { sessionId: opts.sessionId ?? "session" } }; },
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
    assert.equal(Object.isFrozen(plan.treehouse), true);
    assert.match(readFileSync(spawned!.primerPath, "utf8"), /Immutable Treehouse Ticket Checkout Evidence/);
    assert.equal(git(["branch", "--show-current"], worktree), "feature/PAP-1-work");
    assert.equal(readFileSync(join(tickets, "PAP-1.json"), "utf8").includes('"state": "materialized"'), true);
    assert.equal(existsSync(repositoryTicketSlotPath(repo, "PAP-1")), false);
    const canonicalAfter = Buffer.concat([Buffer.from(git(["branch", "--show-current"], repo)), Buffer.from(git(["rev-parse", "HEAD"], repo)), execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: repo })]);
    assert.deepEqual(canonicalAfter, canonicalBefore);
    assert.equal(leaseJson.lease_id, "lease-1");
  } finally {
    process.chdir(priorCwd);
    closeDb();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
