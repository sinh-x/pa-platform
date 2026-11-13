import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADVISORY_RUNTIME_VERSION, acquireRepositoryMutationLease, acquireRepositoryTicketSlot, appendRegistryEvent, captureRepositoryGitSnapshot, closeDb, getDeployPaths, getTicketsDir,
  NativeExecutionEvidence, ProtectedWorkflowStore, readProcessFingerprint, repositoryMutationLeasePath, workflowDigest } from "@pa-platform/pa-core";
import { inspectPiTicketRecovery, parseTicketRecoveryInspectionArgs, runTicketRecoveryInspectionCommand, ticketRecoveryInspectionDiagnostic } from "../ticket-recovery.js";
import { TreehouseClient } from "../treehouse.js";
import { inspectTicketWorktreeRecovery, parseTicketWorktreeRecoveryArgs, refreshTicketWorktreeHead, runTicketWorktreeRecoveryCommand, ticketWorktreeRecoveryDiagnostic } from "../ticket-worktree-recovery.js";
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
  return { dir, canonical, worktree, gitDir, common, ticketPath, ownerPath, treehouse, stop, dispose: async () => { await stop(); closeDb(); rmSync(dir, { recursive: true, force: true }); } };
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
const workflowArgs = ["inspect", "--repo", "fixture", "--ticket", "PAP-297"];
const workflowRequest = () => parseTicketWorktreeRecoveryArgs(workflowArgs);
function advance(f: Awaited<ReturnType<typeof fixture>>) {
  git(f.worktree, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "descendant"]);
}
test("workflow grammar separates read-only inspect from exact metadata refresh and refuses proof/force overrides", () => {
  assert.equal(workflowRequest().action, "inspect");
  for (const bad of [[], ["apply", ...workflowArgs.slice(1)], [...workflowArgs, "--force"], [...workflowArgs, "--expected-observation", "0".repeat(64)],
    ["refresh-head", ...workflowArgs.slice(1)], [...workflowArgs, "--repo", "fixture"], workflowArgs.map(s => s === "fixture" ? "../fixture" : s),
    [...workflowArgs, "--actor", "operator"], [...workflowArgs, "--process-dead"], [...workflowArgs, "--json", "--json"]]) {
    assert.throws(() => parseTicketWorktreeRecoveryArgs(bad));
    const output: string[] = []; assert.equal(runTicketWorktreeRecoveryCommand(bad, { stdout: s => { output.push(s); }, stderr: s => { output.push(s); } }), 2);
    assert.doesNotMatch(output.join(""), /\.\.\/fixture/);
  }
});
test("workflow discovers the retained predecessor, keeps cleanup blocked and performs no writes", async () => {
  const f = await fixture();
  try {
    await f.stop(); closeDb(); const before = snapshot(f.dir);
    const result = inspectTicketWorktreeRecovery(workflowRequest(), { treehouse: f.treehouse, cwd: f.canonical });
    assert.equal(result.head, "matching"); assert.equal(result.execution, "retained"); assert.equal(result.capacity, "retained");
    assert.equal(result.recoveryCause, "proof-incomplete"); assert.equal(result.deploymentId, "d-297aaa"); assert.equal(result.outcome, "blocked");
    assert.match(result.inspectionCommand!, /ppa pi inspect-recovery --repo fixture --ticket PAP-297 --deployment-id d-297aaa/);
    assert.equal(result.refreshCommand, undefined); assert.deepEqual(snapshot(f.dir), before);
    assert.doesNotMatch(JSON.stringify(result), /ownershipToken|slotToken|startTimeTicks|bootId|fixture private command|dirty tracked|new\\nfile/);
    const again = inspectTicketWorktreeRecovery(workflowRequest(), { treehouse: f.treehouse, cwd: f.canonical });
    assert.equal(again.observationDigest, result.observationDigest);
    const linked = inspectTicketWorktreeRecovery(workflowRequest(), { treehouse: f.treehouse, cwd: f.worktree });
    assert.equal(linked.outcome, "unavailable"); assert.deepEqual(snapshot(f.dir), before);
  } finally { await f.dispose(); }
});
test("preview-bound descendant HEAD refresh preserves dirty checkout and all execution claims; replay does not reapply", async () => {
  const f = await fixture();
  try {
    await f.stop(); advance(f); closeDb();
    const dependencies = { treehouse: f.treehouse, cwd: f.canonical };
    const preview = inspectTicketWorktreeRecovery(workflowRequest(), dependencies);
    assert.equal(preview.head, "refreshable"); assert.equal(preview.outcome, "blocked"); assert.ok(preview.refreshCommand);
    const before = snapshot(f.dir), checkout = snapshot(f.worktree), metadata = snapshot(f.gitDir), canonical = snapshot(f.canonical);
    const request = parseTicketWorktreeRecoveryArgs(["refresh-head", ...workflowArgs.slice(1), "--expected-observation", preview.observationDigest!]);
    assert.equal(refreshTicketWorktreeHead({ ...request, expectedObservation: "0".repeat(64) }, dependencies).outcome, "blocked");
    assert.deepEqual(snapshot(f.dir), before);
    const result = refreshTicketWorktreeHead(request, dependencies);
    assert.equal(result.outcome, "head-refreshed", result.diagnostic); assert.equal(result.observationDigest, undefined); assert.equal(result.refreshCommand, undefined);
    assert.deepEqual(snapshot(f.worktree), checkout); assert.deepEqual(snapshot(f.gitDir), metadata); assert.deepEqual(snapshot(f.canonical), canonical);
    const ticket = JSON.parse(readFileSync(f.ticketPath, "utf8"));
    assert.equal(ticket.linkedBranches[0].baseSha, preview.baseSha); assert.equal(ticket.linkedBranches[0].headSha, preview.currentHeadSha); assert.equal(ticket.linkedBranches[0].sha, preview.currentHeadSha);
    assert.equal(snapshot(f.dir)[f.ownerPath], before[f.ownerPath]);
    const fresh = inspectTicketWorktreeRecovery(workflowRequest(), dependencies);
    assert.equal(fresh.head, "matching"); assert.equal(fresh.execution, "retained"); assert.equal(fresh.capacity, "retained"); assert.equal(fresh.recoveryCause, "proof-incomplete");
    const after = snapshot(f.dir); assert.equal(refreshTicketWorktreeHead(request, dependencies).outcome, "blocked"); assert.deepEqual(snapshot(f.dir), after);
  } finally { await f.dispose(); }
});
test("changed ticket, owner, lease or Git context cannot reuse a HEAD refresh preview", async () => {
  for (const change of ["ticket", "owner", "lease", "git-env", "head"] as const) {
    const f = await fixture();
    try {
      await f.stop(); advance(f); closeDb(); const dependencies = { treehouse: f.treehouse, cwd: f.canonical };
      const preview = inspectTicketWorktreeRecovery(workflowRequest(), dependencies);
      const request = parseTicketWorktreeRecoveryArgs(["refresh-head", ...workflowArgs.slice(1), "--expected-observation", preview.observationDigest!]);
      if (change === "ticket") { const ticket = JSON.parse(readFileSync(f.ticketPath, "utf8")); ticket.summary = "concurrent change"; writeFileSync(f.ticketPath, JSON.stringify(ticket)); }
      if (change === "owner") writeFileSync(f.ownerPath, readFileSync(f.ownerPath));
      if (change === "head") advance(f);
      if (change === "git-env") process.env.GIT_DIR = f.gitDir;
      if (change === "lease") dependencies.treehouse = new TreehouseClient({ run: argv => ({ status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(argv[0] === "--version" ? "v3.1.3\n" : JSON.stringify([{ path: f.worktree, status: "leased", leased: true, lease_id: "replacement", lease_holder: "pa:fixture:PAP-297", processes: [] }])) }) });
      const before = snapshot(f.dir), result = refreshTicketWorktreeHead(request, dependencies);
      assert.equal(result.outcome, "blocked", change); assert.equal(result.refreshCommand, undefined); assert.deepEqual(snapshot(f.dir), before);
    } finally { delete process.env.GIT_DIR; await f.dispose(); }
  }
});
test("refresh reauthenticates preview under existing capacity and ticket locks, rejecting an in-lock lease race", async () => {
  const f = await fixture();
  try {
    await f.stop(); advance(f); closeDb();
    const preview = inspectTicketWorktreeRecovery(workflowRequest(), { treehouse: f.treehouse, cwd: f.canonical });
    let statuses = 0, observedLocks = false;
    const treehouse = new TreehouseClient({ run: argv => {
      if (argv[0] === "--version") return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from("v3.1.3\n") };
      statuses++;
      if (statuses === 3) {
        for (const path of [join(f.common, "pa-ticket-builder-slots", "pa-ticket-builder-slots.lock"), join(getTicketsDir(), ".ticket-store-transaction.lock")]) {
          assert.equal(spawnSync("flock", ["--nonblock", path, "true"]).status, 1, path);
        }
        observedLocks = true;
      }
      return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify([{ path: f.worktree, status: "leased", leased: true, lease_id: statuses >= 3 ? "replacement" : "fixture-lease", lease_holder: "pa:fixture:PAP-297", processes: [] }])) };
    } });
    const ticket = readFileSync(f.ticketPath), owner = readFileSync(f.ownerPath), checkout = snapshot(f.worktree);
    const result = refreshTicketWorktreeHead(parseTicketWorktreeRecoveryArgs(["refresh-head", ...workflowArgs.slice(1), "--expected-observation", preview.observationDigest!]), { treehouse, cwd: f.canonical });
    assert.equal(observedLocks, true); assert.equal(result.outcome, "blocked"); assert.deepEqual(readFileSync(f.ticketPath), ticket); assert.deepEqual(readFileSync(f.ownerPath), owner); assert.deepEqual(snapshot(f.worktree), checkout);
  } finally { await f.dispose(); }
});
test("workflow supports HEAD-only preparation without claims, but orphaned capacity still prevents a readiness claim", async () => {
  for (const retainedCapacity of [false, true]) {
    const f = await fixture();
    try {
      await f.stop(); rmSync(f.ownerPath); closeDb();
      if (!retainedCapacity) rmSync(join(f.common, "pa-ticket-builder-slots"), { recursive: true });
      const dependencies = { treehouse: f.treehouse, cwd: f.canonical }, before = snapshot(f.dir);
      const result = inspectTicketWorktreeRecovery(workflowRequest(), dependencies);
      assert.equal(result.execution, "absent"); assert.equal(result.capacity, retainedCapacity ? "retained" : "absent");
      assert.equal(result.outcome, retainedCapacity ? "blocked" : "observed"); assert.match(result.diagnostic, retainedCapacity ? /not ready/ : /Launch admission was not checked/);
      assert.deepEqual(snapshot(f.dir), before);
      advance(f);
      const preview = inspectTicketWorktreeRecovery(workflowRequest(), dependencies);
      assert.equal(preview.head, "refreshable"); assert.ok(preview.refreshCommand);
      const refreshed = refreshTicketWorktreeHead(parseTicketWorktreeRecoveryArgs(["refresh-head", ...workflowArgs.slice(1), "--expected-observation", preview.observationDigest!]), dependencies);
      assert.equal(refreshed.outcome, "head-refreshed", refreshed.diagnostic);
      const after = inspectTicketWorktreeRecovery(workflowRequest(), dependencies);
      assert.equal(after.outcome, retainedCapacity ? "blocked" : "observed");
    } finally { await f.dispose(); }
  }
});
test("workflow refuses replaced ancestry and conflicting authority instead of offering HEAD refresh", async () => {
  for (const change of ["rewind", "sibling"] as const) {
    const f = await fixture();
    try {
      await f.stop(); advance(f); closeDb();
      if (change === "rewind") {
        const ticket = JSON.parse(readFileSync(f.ticketPath, "utf8")); ticket.linkedBranches[0].headSha = git(f.worktree, ["rev-parse", "HEAD"]); ticket.linkedBranches[0].sha = ticket.linkedBranches[0].headSha;
        writeFileSync(f.ticketPath, JSON.stringify(ticket)); git(f.worktree, ["update-ref", `refs/heads/${ticket.linkedBranches[0].branch}`, ticket.linkedBranches[0].baseSha]);
      } else {
        const owner = JSON.parse(readFileSync(f.ownerPath, "utf8")); owner.ticket = "PAP-298"; writeFileSync(f.ownerPath, JSON.stringify(owner));
      }
      const before = snapshot(f.dir), result = inspectTicketWorktreeRecovery(workflowRequest(), { treehouse: f.treehouse, cwd: f.canonical });
      assert.equal(change === "rewind" ? result.head : result.execution, "conflicting"); assert.equal(result.refreshCommand, undefined); assert.deepEqual(snapshot(f.dir), before);
    } finally { await f.dispose(); }
  }
});
test("workflow plain diagnostics have one bounded envelope and do not imply HEAD refresh releases execution claims", () => {
  process.env.NO_COLOR = "1";
  const base = { schemaVersion: "pa-ticket-worktree-recovery/v1" as const, outcome: "blocked" as const, repo: "r".repeat(80), ticket: "A".repeat(32) + "-" + "9".repeat(12),
    head: "refreshable" as const, execution: "retained" as const, capacity: "retained" as const, observationDigest: "0".repeat(64),
    refreshCommand: `ppa pi ticket-worktree refresh-head --repo ${"r".repeat(80)} --ticket ${"A".repeat(32)}-${"9".repeat(12)} --expected-observation ${"0".repeat(64)}` };
  assert.ok(ticketWorktreeRecoveryDiagnostic(base).includes(base.refreshCommand));
  assert.doesNotMatch(ticketWorktreeRecoveryDiagnostic({ ...base, refreshCommand: "evil\nCondition: secret" }), /evil|secret/);
  for (const output of [ticketWorktreeRecoveryDiagnostic(base), ticketWorktreeRecoveryDiagnostic(base, true), ticketWorktreeRecoveryDiagnostic({ ...base, outcome: "unavailable" }), ticketWorktreeRecoveryDiagnostic({ ...base, outcome: "refresh-uncertain" })]) {
    assert.ok(output.length <= 2000, String(output.length));
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(output.split(`${label}:`).length, 2);
    assert.doesNotMatch(output, /\x1b|--apply|--force/); assert.match(output, /Impact:/); assert.match(output, /Actor:/); assert.match(output, /New approval:/); assert.match(output, /Prerequisite:/);
  }
});
test("source CLI propagates inspect and conditional HEAD refresh JSON, exits and preserved execution blockers", async () => {
  const f = await fixture();
  try {
    await f.stop(); advance(f); closeDb();
    const binary = join(f.dir, "treehouse-fixture");
    writeFileSync(binary, `#!${process.execPath}\nconst args = process.argv.slice(2); if (args.length === 1 && args[0] === '--version') process.stdout.write('v3.1.3\\n'); else if (JSON.stringify(args) === JSON.stringify(['status','--json'])) process.stdout.write(${JSON.stringify(JSON.stringify([{ path: f.worktree, status: "leased", leased: true, lease_id: "fixture-lease", lease_holder: "pa:fixture:PAP-297", processes: [] }]))}); else process.exit(90);\n`);
    chmodSync(binary, 0o700);
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url)), tsx = createRequire(import.meta.url).resolve("tsx/cli");
    const run = (argv: string[]) => spawnSync(process.execPath, [tsx, cli, "pi", "ticket-worktree", ...argv], { cwd: f.canonical, env: { ...process.env, PA_TREEHOUSE_BINARY: binary, NO_COLOR: "1" }, encoding: "utf8", timeout: 30_000 });
    const before = snapshot(f.dir), checkout = snapshot(f.worktree), metadata = snapshot(f.gitDir);
    const inspected = run([...workflowArgs, "--json"]); assert.equal(inspected.status, 1, inspected.stderr);
    const preview = JSON.parse(inspected.stdout); assert.equal(preview.head, "refreshable"); assert.equal(inspected.stderr, ""); assert.deepEqual(snapshot(f.dir), before);
    const refreshed = run(["refresh-head", ...workflowArgs.slice(1), "--expected-observation", preview.observationDigest, "--json"]);
    assert.equal(refreshed.status, 0, refreshed.stderr + refreshed.stdout); assert.equal(JSON.parse(refreshed.stdout).outcome, "head-refreshed"); assert.equal(refreshed.stderr, "");
    assert.deepEqual(snapshot(f.worktree), checkout); assert.deepEqual(snapshot(f.gitDir), metadata);
    const after = run([...workflowArgs, "--json"]); assert.equal(after.status, 1, after.stderr);
    const result = JSON.parse(after.stdout); assert.equal(result.head, "matching"); assert.equal(result.execution, "retained"); assert.equal(result.recoveryCause, "proof-incomplete");
    assert.doesNotMatch(after.stdout, /ownershipToken|slotToken|startTimeTicks|fixture private command/);
  } finally { await f.dispose(); }
});
test("workflow source CLI dispatch exposes both routes but never an execution apply or missing-state initializer", () => {
  const dir = mkdtempSync(join(sandbox, "workflow-cli-"));
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url)), tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const env = { ...process.env, PA_REGISTRY_DB: join(dir, "absent", "registry.db"), PA_AI_USAGE_HOME: dir, PA_PLATFORM_CONFIG: join(dir, "absent-config") };
  for (const [argv, status] of [[ ["--help"], 0 ], [ [...workflowArgs, "--json"], 2 ], [ ["refresh-head", ...workflowArgs.slice(1), "--expected-observation", "0".repeat(64), "--json"], 1 ], [ [...workflowArgs, "--apply"], 2 ]] as const) {
    const before = snapshot(dir), result = spawnSync(process.execPath, [tsx, cli, "pi", "ticket-worktree", ...argv], { env, encoding: "utf8" });
    assert.equal(result.status, status, result.stderr); assert.deepEqual(snapshot(dir), before);
    if (argv.includes("--json")) assert.equal(JSON.parse(result.stdout).schemaVersion, "pa-ticket-worktree-recovery/v1");
    else assert.match(result.stdout + result.stderr, /ppa pi ticket-worktree/);
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
