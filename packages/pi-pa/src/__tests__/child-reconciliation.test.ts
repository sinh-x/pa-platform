import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PA_PI_EXECUTION_MODE_ENV, REPOSITORY_CHILD_SETTLEMENT_FILE,
  acquireRepositoryMutationLease, appendRegistryEvent, captureRepositoryGitSnapshot, closeDb, getDeploymentEvents, getTicketsDir,
  inspectRepositoryMutationLease, queryDeploymentStatus, readProcessFingerprint, reconcileRepositoryTerminalChild,
  registerRepositoryMutationBorrower, repositoryMutationBorrowerPath,
} from "@pa-platform/pa-core";
import {
  CHILD_RECONCILIATION_USAGE, createChildReconciliationModule, inspectPiChildReconciliation,
  parseChildReconciliationArgs, runChildReconciliationCommand, type ChildReconciliationResult,
} from "../child-reconciliation.js";
import { createPiSessionLifecycle, type PiRuntime } from "../pi-extension/index.js";

// Tests cannot inherit the agent's deployment, registry, task or Git redirections.
for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key) && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
const sandbox = mkdtempSync(join(tmpdir(), "pi-child-reconciliation-"));
process.env.PA_AI_USAGE_HOME = sandbox;
process.env.PA_PLATFORM_CONFIG = join(sandbox, "absent-config");
process.env.PA_REGISTRY_DB = join(sandbox, "absent-state", "registry.db");
test.after(() => { closeDb(); rmSync(sandbox, { recursive: true, force: true }); });
const args = ["--parent-id", "d-238aaa", "--child-id", "d-238bbb", "--ticket", "PAP-238"];
const git = (cwd: string, argv: string[]) => execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(path)) : [[path, path.endsWith("registry.db-shm") ? "volatile-read-marks" : createHash("sha256").update(readFileSync(path)).digest("hex")]];
  }));
}
function blocked(result: ChildReconciliationResult) {
  assert.equal(result.outcome, "blocked"); assert.ok(result.diagnostic && result.diagnostic.length <= 2000);
  for (const field of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.ok(result.diagnostic.includes(`${field}:`));
  assert.doesNotMatch(JSON.stringify(result), /borrowerToken|ownershipToken|startTimeTicks|bootId/);
}

test("strict Pi-only grammar accepts only the exact tuple and bounded flags", () => {
  assert.deepEqual(parseChildReconciliationArgs(args), { parentId: "d-238aaa", childId: "d-238bbb", ticket: "PAP-238", apply: false, json: false });
  assert.equal(parseChildReconciliationArgs([...args, "--apply", "--json"]).apply, true);
  const invalid = [[], args.slice(0, -1), [...args, "--force"], [...args, "--actor", "sinh"], [...args, "--token", "secret"], [...args, "--snapshot", "{}"],
    [...args, "--status", "success"], [...args, "--repo", "/tmp"], [...args, "--json", "--json"], [...args, "--apply", "--apply"], [...args, "--ticket", "PAP-238"],
    args.map((value) => value === "d-238bbb" ? "d-238aaa" : value), args.map((value) => value === "PAP-238" ? "../PAP-238" : value),
    args.map((value) => value === "d-238aaa" ? "d-ABCDEF" : value), [...args, "--version"], [...args, "/tmp/path"], [...args, "--json=true"]];
  for (const argv of invalid) {
    assert.throws(() => parseChildReconciliationArgs(argv));
    const output: string[] = [];
    assert.equal(runChildReconciliationCommand(argv, { stdout: (s) => { output.push(s); }, stderr: (s) => { output.push(s); } }), 2);
    assert.ok(output.join("").includes(CHILD_RECONCILIATION_USAGE)); assert.doesNotMatch(output.join(""), /secret/);
  }
});

test("missing roots remain absent; shell apply, forged actor/environment and inspection create no state", () => {
  const before = snapshot(sandbox); const output: string[] = [];
  const io = { stdout: (s: string) => { output.push(s); }, stderr: (s: string) => { output.push(s); } };
  assert.equal(runChildReconciliationCommand([...args, "--json"], io), 1); blocked(JSON.parse(output.pop()!) as ChildReconciliationResult);
  process.env.PA_TEAM = "builder"; process.env.PA_MODE = "orchestrator"; process.env.PA_DEPLOYMENT_ID = "d-238aaa";
  process.env[PA_PI_EXECUTION_MODE_ENV] = "foreground";
  assert.equal(runChildReconciliationCommand([...args, "--apply", "--json"], io), 1); blocked(JSON.parse(output.pop()!) as ChildReconciliationResult);
  for (const key of ["PA_TEAM", "PA_MODE", "PA_DEPLOYMENT_ID", PA_PI_EXECUTION_MODE_ENV]) delete process.env[key];
  assert.deepEqual(snapshot(sandbox), before);
});

async function fixture() {
  const dir = mkdtempSync(join(sandbox, "case-")), canonical = join(dir, "canonical"), worktree = join(dir, "worktree"), config = join(dir, "config");
  mkdirSync(canonical); mkdirSync(config);
  git(canonical, ["init", "-b", "develop"]); git(canonical, ["config", "user.name", "Fixture"]); git(canonical, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(canonical, "a.txt"), "baseline\n"); git(canonical, ["add", "."]); git(canonical, ["commit", "-m", "baseline"]);
  git(canonical, ["worktree", "add", "-b", "feature/PAP-238-fixture", worktree]);
  writeFileSync(join(config, "config.yaml"), `config_dir: ${dir}\nrepos:\n  fixture:\n    path: ${canonical}\n    prefix: PAP\n`);
  closeDb(); process.env.PA_PLATFORM_CONFIG = config; process.env.PA_REGISTRY_DB = join(dir, "registry.db"); process.env.PA_AI_USAGE_HOME = dir;
  const launch = captureRepositoryGitSnapshot(worktree), gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]), common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const ticketDir = getTicketsDir(); mkdirSync(ticketDir, { recursive: true });
  const ticketPath = join(ticketDir, "PAP-238.json");
  writeFileSync(ticketPath, JSON.stringify({ id: "PAP-238", project: "fixture", title: "fixture", linkedBranches: [{ repo: "fixture", branch: launch.branch, state: "materialized", baseSha: launch.head, headSha: launch.head, sha: launch.head }] }));
  const binding = { repo: worktree, repo_root: canonical, worktree_root: worktree, ticket_id: "PAP-238", runtime: "pi" as const, binary: "ppa",
    treehouse_path: worktree, treehouse_lease_id: "fixture-lease", treehouse_lease_holder: "pa:fixture:PAP-238", branch_state: "materialized" as const,
    branch_base_sha: launch.head, branch_head_sha: launch.head, ticket_slot_id: "pa:fixture:PAP-238", repository_permit: 1 as const };
  appendRegistryEvent({ ...binding, deployment_id: "d-238aaa", team: "builder", mode: "orchestrator", builder_authority: "orchestrator", event: "started", timestamp: new Date().toISOString(), pid: process.pid });
  appendRegistryEvent({ ...binding, deployment_id: "d-238bbb", team: "builder", mode: "implement", builder_authority: "parented-implement", parent_deployment_id: "d-238aaa", event: "started", timestamp: new Date().toISOString() });
  const owner = acquireRepositoryMutationLease({ canonicalRepoKey: "fixture", canonicalRepoRoot: canonical, worktreeRoot: worktree, expectedGitDir: gitDir, expectedGitCommonDir: common,
    deploymentId: "d-238aaa", deploymentDirectory: join(dir, "parent"), runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", ticket: "PAP-238", gitSnapshot: launch });
  assert.equal(owner.status, "acquired"); if (owner.status !== "acquired") throw new Error("fixture owner denied");
  const child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdin.once('end',()=>process.exit(0))"], { stdio: ["pipe", "ignore", "ignore"] });
  assert.ok(child.pid); const birth = readProcessFingerprint(child.pid)!; assert.ok(birth);
  const registration = registerRepositoryMutationBorrower({ canonicalRepoKey: "fixture", canonicalRepoRoot: canonical, worktreeRoot: worktree,
    expectedGitDir: gitDir, expectedGitCommonDir: common, parentDeploymentId: "d-238aaa", deploymentId: "d-238bbb", deploymentDirectory: join(dir, "child"),
    runtime: "pi", team: "builder", mode: "implement", launchMode: "background", ticket: "PAP-238", branch: launch.branch, timeoutSeconds: 60,
    pid: child.pid, processFingerprint: birth, gitSnapshot: launch });
  // The fixture execution process exits normally, with birth observed while live.
  const runnerExit = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  child.stdin.end(); assert.equal(await runnerExit, 0);
  assert.equal(registration.status, "registered"); if (registration.status !== "registered") throw new Error("fixture borrower denied");
  // Native proof for the execution is collected from a second real normal
  // process; both runner and execution births/deaths are observed independently.
  const execution = spawn(process.execPath, ["-e", "setTimeout(()=>{},10)"], { stdio: "ignore" }); assert.ok(execution.pid);
  const executionBirth = readProcessFingerprint(execution.pid)!; assert.ok(executionBirth);
  const exitCode = await new Promise<number | null>((resolve) => execution.once("close", (code) => resolve(code))); assert.equal(exitCode, 0);
  writeFileSync(join(worktree, "a.txt"), "committed partial\n"); git(worktree, ["add", "a.txt"]); git(worktree, ["commit", "-m", "partial"]);
  appendRegistryEvent({ deployment_id: "d-238bbb", team: "builder", event: "completed", status: "partial", timestamp: new Date().toISOString(), summary: "original partial", exit_code: 0 });
  const final = captureRepositoryGitSnapshot(worktree);
  const interrupted = reconcileRepositoryTerminalChild({ canonicalRepoKey: "fixture", canonicalRepoRoot: canonical, worktreeRoot: worktree, repositoryGitDir: gitDir, repositoryGitCommonDir: common,
    parentDeploymentId: "d-238aaa", childDeploymentId: "d-238bbb", ticket: "PAP-238", borrowerToken: registration.borrower.borrowerToken,
    host: { verifyExecution: () => ({ termination: "normal-exit", rawOutcome: { source: "foreground", status: "success", exitCode: 0 }, processes: [executionBirth] }),
      readTicket: () => ({ branch: launch.branch, baseSha: launch.head, headSha: launch.head }), publishTicket: () => { throw new Error("unexpected effect"); },
      boundary: (stage) => { if (stage === "intent") throw new Error("isolated interruption after durable native intent"); } } });
  assert.equal(interrupted.outcome, "blocked"); assert.equal(existsSync(join(gitDir, REPOSITORY_CHILD_SETTLEMENT_FILE)), true);
  const env = { ...process.env, PA_DEPLOYMENT_ID: "d-238aaa", PA_TEAM: "builder", PA_MODE: "orchestrator", PA_TICKET_ID: "PAP-238", PA_REPO: worktree, PA_WORKTREE_ROOT: worktree, [PA_PI_EXECUTION_MODE_ENV]: "foreground" };
  const cwd = process.cwd(); process.chdir(worktree);
  return { dir, canonical, worktree, gitDir, launch, final, env, ticketPath, owner, token: registration.borrower.borrowerToken,
    dispose() { process.chdir(cwd); closeDb(); rmSync(dir, { recursive: true, force: true }); } };
}

test("source CLI dispatch preserves help, usage/denial exits and does not initialize missing state", () => {
  const dir = mkdtempSync(join(sandbox, "cli-"));
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url)), tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const env = { ...process.env, PA_REGISTRY_DB: join(dir, "absent", "registry.db"), PA_AI_USAGE_HOME: dir, PA_PLATFORM_CONFIG: join(dir, "absent-config") };
  const before = snapshot(dir);
  for (const [argv, exit] of [[ [...args, "--apply", "--json"], 1 ], [ [...args, "--version"], 2 ], [ ["--help"], 0 ]] as const) {
    const result = spawnSync(process.execPath, [tsx, cli, "pi", "reconcile-child", ...argv], { env, encoding: "utf8" });
    assert.equal(result.status, exit, result.stderr);
    if (exit === 1) blocked(JSON.parse(result.stdout) as ChildReconciliationResult);
    else assert.match(result.stdout + result.stderr, /ppa pi reconcile-child/);
    assert.deepEqual(snapshot(dir), before);
  }
});

test("legacy narrative/absent proof and malformed retained record remain blocked without cleanup", async () => {
  const f = await fixture();
  try {
    const active = join(f.gitDir, REPOSITORY_CHILD_SETTLEMENT_FILE);
    writeFileSync(active, "{malformed-protected-fixture", { mode: 0o600 });
    const before = snapshot(f.dir); blocked(inspectPiChildReconciliation(parseChildReconciliationArgs(args)));
    assert.deepEqual(snapshot(f.dir), before);
    rmSync(active); rmSync(repositoryMutationBorrowerPath(f.worktree));
    const absent = snapshot(f.dir); const result = inspectPiChildReconciliation(parseChildReconciliationArgs(args));
    blocked(result); assert.match(result.diagnostic!, /legacy-proof-unavailable/); assert.deepEqual(snapshot(f.dir), absent);
  } finally { f.dispose(); }
});

test("corrupt existing registry is a redacted read failure with exit 2 and no allocation", async () => {
  const f = await fixture();
  try {
    closeDb(); const path = process.env.PA_REGISTRY_DB!;
    writeFileSync(path, readFileSync(path).subarray(0, 100));
    const before = snapshot(f.dir), output: string[] = [];
    assert.equal(runChildReconciliationCommand([...args, "--json"], { stdout: (text) => { output.push(text); }, stderr: (text) => { output.push(text); } }), 2);
    const result = JSON.parse(output[0]!) as ChildReconciliationResult; blocked(result); assert.equal(result.readFailure, true);
    assert.deepEqual(snapshot(f.dir), before);
  } finally { f.dispose(); }
});

test("inspection of a checkpointed closed registry creates no sidecar files", async () => {
  const f = await fixture();
  try {
    closeDb(); const before = snapshot(f.dir);
    const result = inspectPiChildReconciliation(parseChildReconciliationArgs(args));
    assert.equal(result.outcome, "eligible", result.diagnostic);
    assert.deepEqual(snapshot(f.dir), before);
  } finally { f.dispose(); }
});

test("one native confirmation in flight excludes another; shutdown cancels it without publication", async () => {
  const f = await fixture(), lifecycle = createPiSessionLifecycle(() => {});
  try {
    let input!: (event: unknown, context: unknown) => unknown; let prompts = 0; const output: string[] = [];
    createChildReconciliationModule({ env: f.env })({ on: (_event: string, handler: typeof input) => { input = handler; } } as PiRuntime, lifecycle);
    let started!: () => void; const opened = new Promise<void>((resolve) => { started = resolve; });
    const context = { mode: "tui", cwd: f.worktree, isIdle: () => true, sessionManager: { getSessionId: () => "fixture-session" }, ui: {
      notify: (text: string) => { output.push(text); }, select: async (_title: string, _choices: string[], options?: { signal?: AbortSignal }) => {
        prompts++; started(); return new Promise<undefined>((resolve) => options!.signal!.addEventListener("abort", () => resolve(undefined), { once: true }));
      },
    } };
    const event = { source: "interactive", text: `ppa pi reconcile-child ${[...args, "--apply", "--json"].join(" ")}` };
    const before = snapshot(f.dir), first = input(event, context); await opened;
    await input(event, context); blocked(JSON.parse(output.pop()!) as ChildReconciliationResult); assert.equal(prompts, 1);
    await lifecycle.shutdown(); await first;
    blocked(JSON.parse(output.pop()!) as ChildReconciliationResult); assert.deepEqual(snapshot(f.dir), before);
  } finally { await lifecycle.shutdown(); f.dispose(); }
});

for (const scenario of ["approve", "decline", "session-drift", "git-drift", "rpc", "extension", "not-idle", "wrong-pid", "closing", "missing-ui", "rpc-context", "streaming", "image", "dialog-throws", "inspect"] as const) test(`native input adapter: ${scenario}`, async () => {
  const f = await fixture(); const lifecycle = createPiSessionLifecycle(() => {});
  try {
    let input!: (event: unknown, context: unknown) => unknown; let session = "fixture-session"; let prompts = 0; const output: string[] = [];
    const pi = { on(event: string, handler: typeof input) { assert.equal(event, "input"); input = handler; } } as PiRuntime;
    createChildReconciliationModule({ env: f.env })(pi, lifecycle);
    const before = snapshot(f.dir);
    const observed = inspectPiChildReconciliation(parseChildReconciliationArgs(args)); assert.equal(observed.outcome, "eligible", observed.diagnostic);
    assert.deepEqual(snapshot(f.dir), before, "inspection has no durable effects");
    if (scenario === "wrong-pid") appendRegistryEvent({ deployment_id: "d-238aaa", team: "builder", event: "pid", timestamp: new Date().toISOString(), pid: process.pid + 1 });
    const afterSetup = snapshot(f.dir);
    if (scenario === "closing") await lifecycle.shutdown();
    const context = { mode: scenario === "rpc-context" ? "rpc" : "tui", cwd: f.worktree, isIdle: () => scenario !== "not-idle", sessionManager: { getSessionId: () => session }, ui: {
      notify: (text: string) => { output.push(text); },
      ...(scenario === "missing-ui" ? {} : { select: async (title: string, choices: string[]) => {
        if (scenario === "dialog-throws") throw new Error("PRIVATE-DIALOG-ERROR-SECRET");
        prompts++; assert.match(title, new RegExp(f.final.head)); assert.match(title, new RegExp(f.launch.head)); assert.match(title, /snapshotDigest/);
        assert.doesNotMatch(title, new RegExp(f.token));
        if (scenario === "session-drift") session = "new-session";
        if (scenario === "git-drift") writeFileSync(join(f.worktree, "a.txt"), "drift\n");
        return scenario === "decline" ? choices[1] : choices[0];
      } }),
    } };
    const event = { source: scenario === "rpc" ? "rpc" : scenario === "extension" ? "extension" : "interactive",
      ...(scenario === "streaming" ? { streamingBehavior: "steer" } : {}), ...(scenario === "image" ? { images: [{}] } : {}),
      text: `ppa pi reconcile-child ${[...args, ...(scenario === "inspect" ? [] : ["--apply"]), "--json"].join(" ")}` };
    if (scenario === "closing") {
      await assert.rejects(async () => input(event, context));
      assert.deepEqual(snapshot(f.dir), afterSetup);
      return;
    }
    assert.deepEqual(await input(event, context), { action: "handled" });
    const result = JSON.parse(output.pop()!) as ChildReconciliationResult;
    assert.doesNotMatch(output.join("") + JSON.stringify(result), /PRIVATE-DIALOG-ERROR-SECRET/);
    assert.equal(result.mode, scenario === "inspect" ? "inspect" : "apply");
    if (scenario === "inspect") {
      assert.equal(result.outcome, "eligible"); assert.equal(prompts, 0); assert.deepEqual(snapshot(f.dir), afterSetup);
    } else if (scenario === "approve") {
      assert.equal(prompts, 1); assert.equal(result.outcome, "reconciled", result.diagnostic);
      assert.equal(queryDeploymentStatus("d-238bbb")?.status, "partial");
      assert.equal(queryDeploymentStatus("d-238aaa")?.branch_head_sha, f.final.head);
      assert.equal(existsSync(repositoryMutationBorrowerPath(f.worktree)), false);
      const parent = inspectRepositoryMutationLease(f.canonical, { worktreeRoot: f.worktree, getProcessFingerprint: readProcessFingerprint }).lease!;
      assert.equal(parent.authorityChildDeploymentId, "d-238bbb"); assert.deepEqual(parent.authorityGitSnapshot, f.final);
      assert.equal((JSON.parse(readFileSync(f.ticketPath, "utf8")) as { linkedBranches: Array<{ headSha: string }> }).linkedBranches[0]?.headSha, f.final.head);
      assert.deepEqual(await input(event, context), { action: "handled" });
      assert.equal((JSON.parse(output.pop()!) as ChildReconciliationResult).outcome, "already-reconciled");
      assert.equal(getDeploymentEvents("d-238aaa").filter((item) => item.note?.startsWith("direct-child-authority:")).length, 1);
    } else {
      blocked(result); assert.equal(existsSync(repositoryMutationBorrowerPath(f.worktree)), true);
      if (scenario !== "git-drift") assert.deepEqual(snapshot(f.dir), afterSetup, "denied apply has no durable authority/file effects");
    }
  } finally { await lifecycle.shutdown(); f.dispose(); }
});
