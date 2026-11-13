import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADVISORY_RUNTIME_VERSION, acquireRepositoryMutationLease, acquireRepositoryTicketSlot, appendRegistryEvent, captureRepositoryGitSnapshot, closeDb, getDeployPaths, getTicketsDir,
  NativeExecutionEvidence, ProtectedWorkflowStore, readProcessFingerprint, repositoryMutationLeasePath, workflowDigest } from "@pa-platform/pa-core";
import { inspectPiTicketRecovery, parseTicketRecoveryInspectionArgs, runTicketRecoveryInspectionCommand, ticketRecoveryInspectionDiagnostic } from "../ticket-recovery.js";
import { TreehouseClient } from "../treehouse.js";
for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key) && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
const sandbox = mkdtempSync(join(tmpdir(), "pi-ticket-recovery-"));
process.env.PA_AI_USAGE_HOME = sandbox;
process.env.PA_PLATFORM_CONFIG = join(sandbox, "absent-config");
process.env.PA_REGISTRY_DB = join(sandbox, "absent-registry", "registry.db");
test.after(() => { closeDb(); rmSync(sandbox, { recursive: true, force: true }); });
const args = ["--repo", "fixture", "--ticket", "PAP-297", "--deployment-id", "d-297aaa"];
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(path)) : [[path, path.endsWith("registry.db-shm") ? "volatile-read-marks" : createHash("sha256").update(readFileSync(path)).digest("hex")]];
  }));
}
async function fixture() {
  const dir = mkdtempSync(join(sandbox, "case-")), canonical = join(dir, "canonical"), worktree = join(dir, "worktree"), config = join(dir, "config");
  mkdirSync(canonical); mkdirSync(config);
  git(canonical, ["init", "-b", "develop"]); git(canonical, ["config", "user.name", "Fixture"]); git(canonical, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(canonical, "a.txt"), "baseline\n"); git(canonical, ["add", "."]); git(canonical, ["commit", "-m", "baseline"]);
  git(canonical, ["worktree", "add", "-b", "feature/PAP-297-fixture", worktree]);
  writeFileSync(join(config, "config.yaml"), `config_dir: ${dir}\nrepos:\n  fixture:\n    path: ${canonical}\n    prefix: PAP\n`);
  closeDb(); process.env.PA_PLATFORM_CONFIG = config; process.env.PA_REGISTRY_DB = join(dir, "registry.db"); process.env.PA_AI_USAGE_HOME = dir;
  const launch = captureRepositoryGitSnapshot(worktree), gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]), common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const ticketDir = getTicketsDir(); mkdirSync(ticketDir, { recursive: true });
  const ticketPath = join(ticketDir, "PAP-297.json");
  writeFileSync(ticketPath, JSON.stringify({ id: "PAP-297", project: "fixture", linkedBranches: [{ repo: "fixture", branch: launch.branch, state: "materialized", baseSha: launch.head, headSha: launch.head, sha: launch.head }] }));
  const child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdin.once('end',()=>process.exit(0))"], { stdio: ["pipe", "ignore", "ignore"] });
  assert.ok(child.pid); const birth = readProcessFingerprint(child.pid)!; assert.ok(birth);
  const deploymentDirectory = getDeployPaths("d-297aaa").deployDir;
  const capacity = acquireRepositoryTicketSlot({ canonicalRepoKey: "fixture", canonicalRepoRoot: canonical, ticket: "PAP-297", deploymentId: "d-297aaa", deploymentDirectory, pid: child.pid, processFingerprint: birth });
  assert.equal(capacity.status, "acquired"); if (capacity.status !== "acquired") throw new Error("fixture capacity");
  const owner = acquireRepositoryMutationLease({ canonicalRepoKey: "fixture", canonicalRepoRoot: canonical, worktreeRoot: worktree,
    expectedGitDir: gitDir, expectedGitCommonDir: common, deploymentId: "d-297aaa", deploymentDirectory, runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", ticket: "PAP-297", gitSnapshot: launch, pid: child.pid, processFingerprint: birth });
  assert.equal(owner.status, "acquired"); if (owner.status !== "acquired") throw new Error("fixture owner");
  const binding = { repo: worktree, repo_root: canonical, worktree_root: worktree, ticket_id: "PAP-297", runtime: "pi" as const, binary: "ppa",
    treehouse_path: worktree, treehouse_lease_id: "fixture-lease", treehouse_lease_holder: "pa:fixture:PAP-297", branch_state: "materialized" as const,
    branch_base_sha: launch.head, branch_head_sha: launch.head, ticket_slot_id: capacity.slot.slotId, repository_permit: capacity.slot.repositoryPermit };
  appendRegistryEvent({ ...binding, deployment_id: "d-297aaa", team: "builder", mode: "orchestrator", builder_authority: "orchestrator", event: "started", timestamp: new Date().toISOString(), pid: child.pid, note: ADVISORY_RUNTIME_VERSION });
  appendRegistryEvent({ deployment_id: "d-297aaa", team: "builder", event: "completed", status: "failed", exit_code: 1, timestamp: new Date().toISOString(), summary: "original timeout and failed finalization" });
  const root = join(deploymentDirectory, "operation-evidence"); mkdirSync(root, { recursive: true, mode: 0o700 });
  const evidence = new NativeExecutionEvidence(new ProtectedWorkflowStore(root), root, { repository: run => run(), worktree: run => run() });
  const operationId = "op-11111111-1111-4111-8111-111111111111", command = "fixture private command";
  const intent = evidence.publish("advisory-operation-intent", { operationId, command, deploymentId: "d-297aaa", cwd: worktree });
  const frame = evidence.publish("process-frame", { intent, process: birth, groupId: birth.pid, sessionId: birth.pid, executable: "/fixture/bash", command, cwd: worktree, program: null, environment: {} });
  evidence.publish("advisory-process-result", { operationId, intent, command, process: { frame, stdout: {}, stderr: {}, exitCode: null, signal: "SIGTERM", timedOut: true, aborted: false, outputLimitExceeded: false, groupSettled: false } });
  const ownerPath = repositoryMutationLeasePath(worktree);
  writeFileSync(ownerPath, JSON.stringify({ ...owner.lease, directExecutionCustody: "active", advisoryOperation: { id: operationId, caller: birth, inputSha256: workflowDigest(command), intentRef: intent.ref } }), { mode: 0o600 });
  writeFileSync(join(worktree, "a.txt"), "dirty tracked\n"); writeFileSync(join(worktree, "new\nfile.bin"), Buffer.from([0, 1, 255]));
  const treehouse = new TreehouseClient({ run: argv => ({ status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(argv[0] === "--version" ? "v3.1.3\n" : JSON.stringify([{ path: worktree, status: "leased", leased: true, lease_id: "fixture-lease", lease_holder: "pa:fixture:PAP-297", processes: [] }])) }) });
  let closed = false;
  const stop = async () => { if (!closed) { const exit = new Promise(resolve => child.once("close", resolve)); child.stdin.end(); await exit; closed = true; } };
  return { dir, canonical, worktree, ticketPath, ownerPath, treehouse, stop, dispose: async () => { await stop(); closeDb(); rmSync(dir, { recursive: true, force: true }); } };
}
test("strict grammar refuses paths, force/apply/proof/actor overrides, duplicate flags and oversized identities", () => {
  assert.equal(parseTicketRecoveryInspectionArgs(args).repo, "fixture");
  for (const bad of [[], [...args, "--apply"], [...args, "--force"], [...args, "--json", "--json"], [...args, "--actor", "operator"], [...args, "--expected-evidence", "0".repeat(64)],
    args.map(s => s === "fixture" ? "/tmp/repo" : s), args.map(s => s === "PAP-297" ? "../PAP-297" : s), args.map(s => s === "d-297aaa" ? "d-ABCDEF" : s)]) {
    assert.throws(() => parseTicketRecoveryInspectionArgs(bad));
    const output: string[] = []; assert.equal(runTicketRecoveryInspectionCommand(bad, { stdout: s => { output.push(s); }, stderr: s => { output.push(s); } }), 2);
    assert.doesNotMatch(output.join(""), /\/tmp\/repo|\.\.\/PAP|d-ABCDEF/);
  }
});
test("plain diagnostics are pure bounded single envelopes with no executable apply advice", () => {
  process.env.NO_COLOR = "1";
  for (const cause of ["proof-incomplete", "live-process", "identity-conflict", "unsupported-history", "evidence-unavailable"] as const) {
    const output = ticketRecoveryInspectionDiagnostic(cause); assert.ok(output.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(output.split(`${label}:`).length, 2);
    assert.match(output, /Impact: read-only/); assert.match(output, /Actor: operator/); assert.match(output, /New approval: not required/); assert.match(output, /Prerequisite:/);
    assert.doesNotMatch(output, /\x1b|--apply|--force/);
  }
});
test("terminal status and empty Treehouse processes cannot hide a live native owner", async () => {
  const f = await fixture();
  try {
    const before = snapshot(f.dir), result = inspectPiTicketRecovery(parseTicketRecoveryInspectionArgs(args), { treehouse: f.treehouse, cwd: f.canonical });
    assert.equal(result.cause, "live-process", result.diagnostic); assert.equal(result.ownership, "matching"); assert.equal(result.capacity, "matching"); assert.equal(result.checkout, "matching");
    assert.equal(result.operation?.state, "unknown"); assert.equal(result.operation?.timedOut, true);
    assert.doesNotMatch(JSON.stringify(result), /ownershipToken|slotToken|startTimeTicks|bootId|fixture private command|dirty tracked/);
    assert.deepEqual(snapshot(f.dir), before);
  } finally { await f.dispose(); }
});
test("dead owner and empty group retain unknown cleanup, capacity and dirty checkout byte-for-byte", async () => {
  const f = await fixture();
  try {
    await f.stop(); closeDb(); const before = snapshot(f.dir);
    const result = inspectPiTicketRecovery(parseTicketRecoveryInspectionArgs(args), { treehouse: f.treehouse, cwd: f.canonical });
    assert.equal(result.cause, "proof-incomplete", result.diagnostic); assert.equal(result.operation?.state, "unknown"); assert.equal(result.operation?.group, "empty");
    assert.match(result.observationDigest!, /^[0-9a-f]{64}$/); assert.equal(result.outcome, "blocked");
    assert.deepEqual(snapshot(f.dir), before); // includes checkpointed registry: no WAL/SHM allocation
    const again = inspectPiTicketRecovery(parseTicketRecoveryInspectionArgs(args), { treehouse: f.treehouse, cwd: f.canonical });
    assert.equal(again.observationDigest, result.observationDigest); assert.deepEqual(snapshot(f.dir), before);
  } finally { await f.dispose(); }
});
test("canonical-only inspection rejects wrong ticket HEAD, replacement owner and linked CWD", async () => {
  for (const change of ["head", "owner", "linked-cwd"] as const) {
    const f = await fixture();
    try {
      if (change === "head") { const ticket = JSON.parse(readFileSync(f.ticketPath, "utf8")); ticket.linkedBranches[0].headSha = "0".repeat(40); writeFileSync(f.ticketPath, JSON.stringify(ticket)); }
      if (change === "owner") { const owner = JSON.parse(readFileSync(f.ownerPath, "utf8")); owner.deploymentId = "d-297bbb"; writeFileSync(f.ownerPath, JSON.stringify(owner)); }
      const before = snapshot(f.dir), result = inspectPiTicketRecovery(parseTicketRecoveryInspectionArgs(args), { treehouse: f.treehouse, cwd: change === "linked-cwd" ? f.worktree : f.canonical });
      assert.equal(result.cause, "identity-conflict"); assert.deepEqual(snapshot(f.dir), before);
    } finally { await f.dispose(); }
  }
});
test("source CLI dispatch exposes read-only help, refuses apply, and does not initialize missing state", () => {
  const dir = mkdtempSync(join(sandbox, "cli-"));
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url)), tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const env = { ...process.env, PA_REGISTRY_DB: join(dir, "absent", "registry.db"), PA_AI_USAGE_HOME: dir, PA_PLATFORM_CONFIG: join(dir, "absent-config") };
  for (const [argv, status] of [[ ["--help"], 0 ], [ [...args, "--json"], 2 ], [ [...args, "--apply"], 2 ]] as const) {
    const before = snapshot(dir), result = spawnSync(process.execPath, [tsx, cli, "pi", "inspect-recovery", ...argv], { env, encoding: "utf8" });
    assert.equal(result.status, status, result.stderr); assert.deepEqual(snapshot(dir), before);
    if (argv.includes("--json")) assert.equal(JSON.parse(result.stdout).outcome, "unavailable");
    else assert.match(result.stdout + result.stderr, /ppa pi inspect-recovery/);
  }
});
