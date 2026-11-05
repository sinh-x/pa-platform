import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireRepositoryMutationLease, captureRepositoryGitSnapshot, releaseRepositoryMutationLease, beginAdvisoryRepositoryOperation, withAdvisoryRepositoryOwner } from "../deploy/repository-admission.js";
import { acquireRepositoryTicketSlot } from "../deploy/ticket-concurrency.js";
import { emitStartedEvent, emitPidEvent } from "../deploy/events.js";
import { ensureDeployDir } from "../deploy/paths.js";
import { closeDb } from "../registry/index.js";
import { ADVISORY_RUNTIME_VERSION, executeOperation, executeAdvisoryFile } from "../operations/service.js";
import { resolveAdvisoryOperationHost } from "../operations/host.js";
import { advisoryStartFromEvents } from "../operations/runtime.js";
import { AdvisoryFiles } from "../operations/files.js";
import { operationExitCode } from "../operations/result.js";
import type { RegistryEvent } from "../types.js";

function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function fixture(run: (f: { root: string; repo: string; worktree: string; context: { deploymentId: string; repoRoot: string; worktreeRoot: string }; token: string }) => Promise<void>): Promise<void> {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap277-integrity-"));
  for (const key of Object.keys(process.env)) if (key.startsWith("PA_") && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
  try {
    Object.assign(process.env, { PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), PA_PLATFORM_CONFIG: join(root, "config") });
    const repo = join(root, "repo"), worktree = join(root, "task"); mkdirSync(repo); mkdirSync(join(root, "config"));
    git(repo, "init", "-b", "develop"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repo, "fixture.txt"), "before\n"); git(repo, "add", "fixture.txt"); git(repo, "commit", "-m", "fixture");
    git(repo, "worktree", "add", "-b", "feature/EX-1-fixture", worktree);
    writeFileSync(join(root, "config/config.yaml"), JSON.stringify({ repos: { example: { path: repo, prefix: "EX" } } }));
    const deploymentId = "d-123abc", deploymentDirectory = ensureDeployDir(deploymentId);
    const slot = acquireRepositoryTicketSlot({ canonicalRepoKey: "example", canonicalRepoRoot: repo, ticket: "EX-1", deploymentId, deploymentDirectory });
    assert.equal(slot.status, "acquired"); if (slot.status !== "acquired") throw new Error("fixture slot");
    const snapshot = captureRepositoryGitSnapshot(worktree);
    const lease = acquireRepositoryMutationLease({ canonicalRepoKey: "example", canonicalRepoRoot: repo, worktreeRoot: worktree, deploymentId, deploymentDirectory, runtime: "pi", team: "builder", mode: "orchestrator", ticket: "EX-1" });
    assert.equal(lease.status, "acquired"); if (lease.status !== "acquired") throw new Error("fixture lease");
    emitStartedEvent({ deploymentId, team: "builder", mode: "orchestrator", runtime: "pi", binary: "ppa", repo: worktree, repoRoot: repo, worktreeRoot: worktree,
      ticketId: "EX-1", builderAuthority: "orchestrator", treehousePath: worktree, treehouseLeaseId: "fixture-lease", treehouseLeaseHolder: "pa:example:EX-1", branchState: "materialized", branchBaseSha: snapshot.head, branchHeadSha: snapshot.head,
      ticketSlotId: slot.slot.slotId, repositoryPermit: slot.slot.repositoryPermit, note: ADVISORY_RUNTIME_VERSION });
    emitPidEvent({ deploymentId, team: "builder", pid: process.pid });
    Object.assign(process.env, { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: deploymentDirectory }); process.chdir(worktree);
    await run({ root, repo, worktree, context: { deploymentId, repoRoot: repo, worktreeRoot: worktree }, token: lease.lease.ownershipToken });
  } finally { process.chdir(cwd); closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); }
}
test("native new-run owner: fail, inspect, atomic edit, rerun and local commit without setup/catalogue/plan", async () => fixture(async f => {
  const host = resolveAdvisoryOperationHost("pi")!;
  assert.ok(host); assert.equal(existsSync(join(f.worktree, ".pa")), false);
  const fail = await executeOperation('{"action":"run","command":"exit 12"}', "pi", host);
  assert.equal(fail.outcome, "failed"); assert.equal(operationExitCode(fail), 1);
  const original = JSON.stringify(fail);
  const file = await executeAdvisoryFile(host, "edit", { path: "fixture.txt" }, async files => { files.file(join(f.worktree, "fixture.txt"), "after\n"); return { complete: true }; });
  assert.equal(file.outcome, "passed"); assert.equal(readFileSync(join(f.worktree, "fixture.txt"), "utf8"), "after\n");
  for (const command of ["pwd", "exit 0", "git add -- fixture.txt", "git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m repaired"]) {
    assert.equal((await executeOperation(JSON.stringify({ action: "run", command }), "pi", host)).outcome, "passed", command);
  }
  assert.equal(JSON.stringify(fail), original);
  const denied = await executeOperation('{"action":"run","command":"rm fixture.txt"}', "pi", host);
  assert.equal(denied.enforcement, "denied"); assert.equal(existsSync(join(f.worktree, "fixture.txt")), true);
  assert.equal((await executeOperation('{"action":"run","command":"pwd"}', "pi", host)).outcome, "passed");
  const timeout = await executeOperation('{"action":"run","command":"sleep 5","timeoutSeconds":0.05}', "pi", host);
  assert.equal(timeout.completion, "timed-out"); assert.equal(operationExitCode(timeout), 124); assert.equal(timeout.process?.cleanup, "settled");
  assert.equal((await executeOperation('{"action":"run","command":"pwd"}', "pi", host)).outcome, "passed");
}));
test("32 real processes reserve the SAME existing lease operation: one winner,31 conflicts; uncertainty keeps custody,not reads", async () => fixture(async f => {
  const moduleUrl = new URL("../deploy/repository-admission.ts", import.meta.url).href;
  const script = `import { beginAdvisoryRepositoryOperation } from ${JSON.stringify(moduleUrl)};
    try { beginAdvisoryRepositoryOperation(JSON.parse(process.argv[1]), {id:'contender-'+process.pid,inputSha256:'a'.repeat(64),intentRef:'fixture:unsettled'}); console.log('winner'); }
    catch { console.log('conflict'); }`;
  const results = await Promise.all(Array.from({ length: 32 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script, JSON.stringify(f.context)], { cwd: f.worktree, env: process.env });
    let output = "", error = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
  })));
  assert.equal(results.filter(s => s === "winner").length, 1); assert.equal(results.filter(s => s === "conflict").length, 31);
  assert.throws(() => beginAdvisoryRepositoryOperation(f.context, { id: "second", inputSha256: "a".repeat(64), intentRef: "fixture:second" }));
  assert.equal(readFileSync(join(f.worktree, "fixture.txt"), "utf8"), "before\n");
  assert.ok(captureRepositoryGitSnapshot(f.worktree).head);
  assert.equal(withAdvisoryRepositoryOwner(f.context, lease => Boolean(lease.advisoryOperation)), true);
  assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: f.repo, worktreeRoot: f.worktree, ownershipToken: f.token }).status, "invalid-evidence");
}));
test("native path boundary refuses traversal,protected metadata,symlinks and hardlink aliases before mutation", async () => fixture(async f => {
  const files = new AdvisoryFiles(f.worktree), external = join(f.root, "external.txt"); writeFileSync(external, "private fixture");
  symlinkSync(external, join(f.worktree, "alias")); linkSync(external, join(f.worktree, "alias-hard"));
  for (const path of ["../external.txt", ".git/config", "../task/fixture.txt", ".env", "alias", "alias-hard"]) assert.throws(() => files.file(`${f.worktree}/${path}`, "changed"));
  assert.equal(readFileSync(external, "utf8"), "private fixture");
  assert.equal((await executeOperation('{"action":"run","command":"pwd"}', "pi", resolveAdvisoryOperationHost("pi"))).outcome, "passed");
}));
test("unmarked,pinned,resumed,ambiguous,rogue or spoofed projections never upgrade retained start bytes", () => {
  const start: RegistryEvent = { deployment_id: "d-123abc", team: "builder", event: "started", timestamp: "2026-11-05T00:00:00.000Z", repo: "/fixture", repo_root: "/fixture", worktree_root: "/fixture", runtime: "pi", binary: "ppa", note: ADVISORY_RUNTIME_VERSION };
  const cases: RegistryEvent[][] = [[{ ...start, note: undefined }], [{ ...start, note: "ordinary-native-execution/v1" }], [{ ...start, resumed_from_deployment_id: "d-111111" }], [{ ...start, parent_deployment_id: "d-111111" }], [{ ...start, rogue_one: true }], [start, start], [{ ...start, note: undefined }, { ...start, event: "updated" }]];
  for (const events of cases) { const before = JSON.stringify(events); assert.equal(advisoryStartFromEvents(events), null); assert.equal(JSON.stringify(events), before); }
  assert.equal(advisoryStartFromEvents([start]), start);
});
