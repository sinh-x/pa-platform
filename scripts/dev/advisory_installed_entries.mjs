// Private verifier driver only. Native admission below is explicitly synthetic;
// every public operation executes the exact selected installed binary/module.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const frame = JSON.parse(readFileSync(process.argv[2], "utf8"));
const core = await import(pathToFileURL(join(frame.share, "packages/pa-core/dist/index.js")).href);
const original = { ...process.env };
let observations = 0;
for (const runtime of ["pi", "opencode"]) {
  const root = join(frame.evidenceRoot, `public-${runtime}`), repo = join(root, "repo"), config = join(root, "config");
  for (const path of [repo, config]) mkdirSync(path, { recursive: true, mode: 0o700 });
  process.env = { ...original, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), PA_PLATFORM_CONFIG: config };
  delete process.env.PA_DEPLOYMENT_ID; delete process.env.PA_DEPLOYMENT_DIR;
  const git = (args, cwd = repo) => execFileSync("git", args, { cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
  git(["init", "-b", "develop"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "fixture.txt"), "fixture\n"); git(["add", "fixture.txt"]); git(["commit", "-m", "fixture"]);
  const worktree = runtime === "pi" ? join(root, "task") : repo;
  if (runtime === "pi") git(["worktree", "add", "-b", "feature/EX-1-fixture", worktree]);
  writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: repo, prefix: "EX" } } }), { mode: 0o600 });
  const binary = runtime === "pi" ? frame.ppa : frame.opa;
  const call = (action, command, expected, outcome) => {
    const args = ["operation", action, ...(command ? ["--command", command] : []), "--format", "pa-operation-result/v1"];
    const run = spawnSync(binary, args, { cwd: worktree, env: process.env, encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    assert.ifError(run.error); assert.equal(run.signal, null); assert.equal(run.status, expected); assert.equal(run.stderr, "");
    const result = core.parseOperationResult(run.stdout); assert.equal(result.outcome, outcome); observations++; return result;
  };
  call("capabilities", undefined, 0, "passed"); call("run", "pwd", 2, "unknown");
  const deploymentId = runtime === "pi" ? "d-112233" : "d-445566", deploymentDirectory = core.ensureDeployDir(deploymentId);
  const snapshot = core.captureRepositoryGitSnapshot(worktree);
  let correlation = {};
  if (runtime === "pi") {
    const slot = core.acquireRepositoryTicketSlot({ canonicalRepoKey: "example", canonicalRepoRoot: repo, ticket: "EX-1", deploymentId, deploymentDirectory });
    assert.equal(slot.status, "acquired");
    correlation = { ticketId: "EX-1", builderAuthority: "orchestrator", treehousePath: worktree, treehouseLeaseId: "disposable-fixture", treehouseLeaseHolder: "pa:example:EX-1", branchState: "materialized", branchBaseSha: snapshot.head, branchHeadSha: snapshot.head, ticketSlotId: slot.slot.slotId, repositoryPermit: slot.slot.repositoryPermit };
  }
  const lease = core.acquireRepositoryMutationLease({ canonicalRepoKey: "example", canonicalRepoRoot: repo, worktreeRoot: worktree, deploymentId, deploymentDirectory, runtime, team: "builder", mode: "orchestrator", ...(runtime === "pi" ? { ticket: "EX-1" } : {}) });
  assert.equal(lease.status, "acquired");
  core.emitStartedEvent({ deploymentId, team: "builder", mode: "orchestrator", runtime, binary: runtime === "pi" ? "ppa" : "opa", repo: worktree, repoRoot: repo, worktreeRoot: worktree, note: "pa-advisory-runtime/v1", ...correlation });
  core.emitPidEvent({ deploymentId, team: "builder", pid: process.pid });
  Object.assign(process.env, { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: deploymentDirectory });
  assert.equal(call("run", "exit 9", 1, "failed").process.exitCode, 9);
  call("run", "pwd", 0, "passed"); call("run", "rm fixture.txt", 3, "skipped"); call("run", "pwd", 0, "passed");
  const legacyId = runtime === "pi" ? "d-aabbcc" : "d-ddeeff";
  core.emitStartedEvent({ deploymentId: legacyId, team: "builder", mode: "orchestrator", runtime, binary: runtime === "pi" ? "ppa" : "opa", repo: worktree, repoRoot: repo, worktreeRoot: worktree });
  const before = JSON.stringify(core.getDeploymentEvents(legacyId));
  Object.assign(process.env, { PA_DEPLOYMENT_ID: legacyId, PA_DEPLOYMENT_DIR: core.ensureDeployDir(legacyId) });
  call("capabilities", undefined, 0, "passed"); call("run", "pwd", 2, "unknown");
  assert.equal(JSON.stringify(core.getDeploymentEvents(legacyId)), before);
  core.closeDb();
}
process.env = original;
console.log(JSON.stringify({ schemaVersion: "pa-advisory-public-observations/v1", observations, nativeAdmission: "synthetic-disposable-not-foreground-human", sourceFallback: false }));
