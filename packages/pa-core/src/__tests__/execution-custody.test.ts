import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExecutionCustodyService, parseExecutionBinding, parseExecutionPlan, parseExecutionRecoveryInventory, projectExecution, updateFeatureWithExpectedHead,
  type ExecutionBinding, type ExecutionCommand, type ExecutionFailure, type ExecutionHolder, type ExecutionHost, type PhaseExecutionPlan,
} from "../deploy/execution-custody.js";
import { ProtectedWorkflowStore, workflowDigest, type SourceVersion } from "../deploy/prepared-workflow.js";
import { repositoryGitSnapshotDigest } from "../deploy/repository-admission.js";

const time = "2026-10-17T00:00:00.000Z";
const sha = "a".repeat(40);
const owner: ExecutionHolder = { deploymentId: "d-aaaaaa", process: { pid: 111, startTimeTicks: "123", bootId: "boot" } };
const child: ExecutionHolder = { deploymentId: "d-bbbbbb", process: { pid: 222, startTimeTicks: "456", bootId: "boot" } };
const reviewer: ExecutionHolder = { deploymentId: "d-cccccc", process: { pid: 333, startTimeTicks: "789", bootId: "boot" } };
const source = (name: string): SourceVersion => ({ ref: `fixture:${name}`, version: "v1", sha256: workflowDigest(name) });
function binding(): ExecutionBinding {
  return parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: "b".repeat(64), lineageId: "lineage-1", repoKey: "fixture", repoRoot: "/fixture/canonical", worktreeRoot: "/fixture/ticket", ticket: "PAP-256", branch: "feature/PAP-256-fixture", initialHeadSha: sha, owner,
    bounds: { startedAt: time, deadlineAt: "2026-10-17T02:00:00.000Z", runtimeMinutes: 120, consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null } });
}
export function executionPlan(): PhaseExecutionPlan {
  return parseExecutionPlan({ phaseId: "phase-3", scope: "ticket execution", paths: ["src/file.ts"], requirements: ["FR6", "AC8"], prerequisites: [source("phase-2")], checks: ["typecheck"], size: "bounded", complexity: "concurrency", rationale: "Direct work is bounded; delegate when scope expands." });
}
function inventory(raw = Buffer.alloc(0), headSha = sha) {
  const branch = binding().branch;
  return parseExecutionRecoveryInventory({ branch, headSha, porcelainV2Base64: raw.toString("base64"), snapshotSha256: repositoryGitSnapshotDigest(branch, headSha, raw), paths: [], evidence: source("inventory") });
}
function fixture(run: (f: ReturnType<typeof setup>) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pap256-execution-"));
  try { run(setup(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  const store = new ProtectedWorkflowStore(root);
  let now = time; let deny = false; let live = true; let handover = true; let evidence = true;
  const calls: string[] = [];
  const host: ExecutionHost = {
    locks: { repository: (run) => { calls.push("repository"); return run(); }, worktree: (run) => { calls.push("worktree"); return run(); } },
    authorize(_binding, _actor, command) { calls.push(typeof command === "string" ? command : command.action); if (deny) throw new Error("PRIVATE-POLICY"); },
    assertLive() { if (!live) throw new Error("stale process/registry"); },
    verifyEvidence() { if (!evidence) throw new Error("missing authoritative bytes"); },
    assertHandover() { if (!handover) throw new Error("live child or unsettled matching finalization"); }, now: () => now,
  };
  const service = new ExecutionCustodyService(store, binding(), host);
  service.initialize(owner);
  const apply = (command: ExecutionCommand, actor = owner) => service.apply(actor, command);
  const plan = () => apply({ action: "plan", plan: executionPlan() });
  const select = (executor: "orchestrator-direct" | "implement-child" | "review-reserved" = "orchestrator-direct", holder = executor === "orchestrator-direct" ? owner : child) => apply({ action: "select", executor, holder, handover: source("handover") });
  const settle = () => apply({ action: "settle", evidence: source("settle"), inventory: inventory(Buffer.alloc(0), service.status(owner).candidateSha) });
  const begin = (id: string, kind: "write" | "check" = "write", actor = owner) => apply({ action: "begin", operation: { id, kind, check: kind === "check" ? "typecheck" : null, intent: null } }, actor);
  const finish = (id: string, failure: ExecutionFailure | null = null, actor = owner) => apply({ action: "finish", operationId: id, evidence: source(`result-${id}`), failure }, actor);
  return { root, host, store, service, apply, plan, select, settle, begin, finish, calls,
    setNow: (value: string) => { now = value; }, setDeny: (value: boolean) => { deny = value; }, setLive: (value: boolean) => { live = value; },
    setHandover: (value: boolean) => { handover = value; }, setEvidence: (value: boolean) => { evidence = value; } };
}
const failure = (candidateSha = sha): ExecutionFailure => ({ check: "typecheck", command: "corepack pnpm typecheck", exitCode: 2, candidateSha, output: source("original-failed-output") });
function failed(f: ReturnType<typeof setup>) {
  f.plan(); f.select(); f.begin("failed-check", "check"); f.finish("failed-check", failure()); f.settle();
}

test("AC7 plan and rationale precede judgment-based selection; strict input never grants authority", () => fixture((f) => {
  assert.throws(() => f.select());
  for (const patch of [{ rationale: "" }, { paths: ["../escape"] }, { paths: ["src/*"] }, { extra: true }, { prerequisites: [{ ...source("a"), token: "PRIVATE" }] }]) assert.throws(() => parseExecutionPlan({ ...executionPlan(), ...patch }));
  const planned = f.plan(); assert.equal(planned.custody.state, "idle");
  assert.equal(f.select().custody.state, "orchestrator-direct");
  assert.throws(() => f.plan());
  assert.deepEqual(f.calls.slice(0, 2), ["repository", "worktree"]);
  assert.throws(() => f.apply({ action: "begin", operation: { id: "forged", kind: "write", check: null, intent: null }, extra: true } as ExecutionCommand));
}));

test("native completion binds an observed commit and invalidates old checks without rewriting launch/bounds", () => fixture((f) => {
  f.plan(); f.select(); f.begin("before", "check"); f.finish("before");
  f.begin("commit");
  const next = f.apply({ action: "finish", operationId: "commit", evidence: source("native-commit-result"), failure: null, candidateSha: "c".repeat(40) });
  assert.equal(next.candidateSha, "c".repeat(40)); assert.deepEqual(next.passedChecks, {}); assert.deepEqual(next.acceptance, {});
  assert.equal(next.binding.initialHeadSha, sha); assert.deepEqual(next.bounds, binding().bounds);
  assert.equal(projectExecution(next).checkCount, 0);
  assert.throws(() => f.apply({ action: "finish", operationId: "commit", evidence: source("forged"), failure: null, candidateSha: "c" }));
}));

test("native non-check failures preserve actual multiline commands and require a fresh matching action result", () => fixture((f) => {
  f.plan(); f.select();
  f.apply({ action: "begin", operation: { id: "failed-shell", kind: "shell", check: null, intent: null } });
  const original: ExecutionFailure = { check: "@operation:shell", command: "printf original\\n\nexit 2", exitCode: 2, candidateSha: sha, output: source("raw-original") };
  f.finish("failed-shell", original); f.settle();
  assert.equal(f.service.status(owner).originalFailure?.command, original.command);
  assert.throws(() => f.apply({ action: "resolve", evidence: source("fictional-pass") }));
  f.apply({ action: "attempt", recovery: { originalFailure: original.output, diagnostic: null, remedy: null, rationale: null, recheck: original } });
  f.select(); f.apply({ action: "begin", operation: { id: "recheck-shell", kind: "shell", check: null, intent: null } }); f.finish("recheck-shell"); f.settle();
  assert.equal(projectExecution(f.service.status(owner)).checkCount, 0);
  f.apply({ action: "resolve", evidence: source("result-recheck-shell") });
  assert.equal(f.service.status(owner).originalFailure, null);
  assert.throws(() => parseExecutionPlan({ ...executionPlan(), checks: ["@operation:write"] }));
}));

test("AC8 exact holder only, stale identities and parent writer rejected; in-flight operations bar transfer", () => fixture((f) => {
  f.plan(); f.select("implement-child");
  assert.throws(() => f.begin("parent"));
  assert.throws(() => f.begin("stale", "write", { ...child, process: { ...child.process, startTimeTicks: "999" } }));
  f.begin("child-write", "write", child);
  assert.throws(() => f.begin("parallel", "write", child)); assert.throws(() => f.settle()); assert.throws(() => f.select());
  assert.throws(() => f.finish("wrong", null, child)); assert.throws(() => f.finish("child-write"));
  f.finish("child-write", null, child);
  f.setHandover(false); assert.throws(() => f.settle()); f.setHandover(true);
  f.settle(); f.select(); assert.equal(f.begin("parent-now").custody.inFlightOperation, "parent-now");
}));

test("AC8 crash/restart retains started barrier; no automatic shutdown/timeout clearance or operation-id replay", () => fixture((f) => {
  f.plan(); f.select(); f.begin("started");
  const restarted = new ExecutionCustodyService(f.store, binding(), f.host);
  assert.equal(restarted.initialize(owner).operation?.id, "started");
  assert.throws(() => restarted.apply(owner, { action: "settle", evidence: source("fake-close"), inventory: inventory() }));
  f.finish("started"); assert.throws(() => f.begin("started"));
  assert.equal(restarted.status(owner).operation, null);
}));

test("AC8/AC10 authority callbacks cannot return Boolean/Promise or authorize stale caller", () => fixture((f) => {
  f.setDeny(true); assert.throws(() => f.plan()); f.setDeny(false);
  f.setLive(false); assert.throws(() => f.plan()); f.setLive(true);
  f.setEvidence(false); assert.throws(() => f.plan()); f.setEvidence(true);
  const service = new ExecutionCustodyService(f.store, binding(), { ...f.host, authorize: (() => true) as unknown as ExecutionHost["authorize"] });
  assert.throws(() => service.status(owner));
  const asyncHost = new ExecutionCustodyService(f.store, binding(), { ...f.host, assertLive: (async () => undefined) as unknown as ExecutionHost["assertLive"] });
  assert.throws(() => asyncHost.status(owner));
  assert.equal(f.service.status(owner).sequence, 0);
}));

test("AC9 complete NUL inventory classifies both rename endpoints, unknown/unmerged/aliases reject", () => {
  const branch = binding().branch;
  const raw = Buffer.from(`2 R. N... 100644 100644 100644 ${sha} ${sha} R100 new name.ts\0old\nname.ts\0? untracked.bin\0`);
  const input = { branch, headSha: sha, porcelainV2Base64: raw.toString("base64"), snapshotSha256: repositoryGitSnapshotDigest(branch, sha, raw),
    paths: [{ path: "new name.ts", classification: "ticket-produced" }, { path: "old\nname.ts", classification: "ticket-preserved" }, { path: "untracked.bin", classification: "ticket-produced" }], evidence: source("complete-inventory") };
  // Control characters require owning reconciliation; never silently drop a path.
  assert.throws(() => parseExecutionRecoveryInventory(input));
  const safeRaw = Buffer.from(raw.toString().replace("old\nname", "old name"));
  const safe = { ...input, porcelainV2Base64: safeRaw.toString("base64"), snapshotSha256: repositoryGitSnapshotDigest(branch, sha, safeRaw), paths: input.paths.map((p) => ({ ...p, path: p.path.replace("old\nname", "old name") })) };
  assert.equal(parseExecutionRecoveryInventory(safe).paths.length, 3);
  assert.throws(() => parseExecutionRecoveryInventory({ ...safe, paths: safe.paths.slice(1) }));
  assert.throws(() => parseExecutionRecoveryInventory({ ...safe, paths: [...safe.paths, safe.paths[0]] }));
  assert.throws(() => parseExecutionRecoveryInventory({ ...safe, snapshotSha256: "0".repeat(64) }));
  assert.throws(() => parseExecutionRecoveryInventory({ ...safe, paths: safe.paths.map((p) => ({ ...p, classification: "unknown" })) }));
  const unmerged = Buffer.from(`u UU N... 100644 100644 100644 100644 ${sha} ${sha} ${sha} conflict.ts\0`);
  assert.throws(() => parseExecutionRecoveryInventory({ ...safe, porcelainV2Base64: unmerged.toString("base64"), snapshotSha256: repositoryGitSnapshotDigest(branch, sha, unmerged) }));
});

test("AC10 third no-progress attempt escalates, original failure and independent caps survive restart/replan/rebase", () => fixture((f) => {
  failed(f);
  const attempt = () => f.apply({ action: "attempt", recovery: { originalFailure: failure().output, diagnostic: null, remedy: null, rationale: null, recheck: failure(f.service.status(owner).candidateSha) } });
  assert.equal(attempt().bounds.consecutiveNoProgress, 1);
  f.plan(); f.apply({ action: "candidate", candidateSha: "c".repeat(40), mapping: source("rebase-map") });
  assert.equal(attempt().bounds.consecutiveNoProgress, 2);
  assert.equal(attempt().bounds.consecutiveNoProgress, 3);
  assert.throws(() => f.select()); assert.throws(() => attempt()); assert.throws(() => f.plan());
  const state = new ExecutionCustodyService(f.store, binding(), f.host).status(owner);
  assert.deepEqual(state.originalFailure, failure()); assert.equal(state.bounds.consecutiveNoProgress, 3);
  assert.equal(state.bounds.startedAt, time);
  const resetBinding = { ...binding(), bounds: { ...binding().bounds, runtimeMinutes: 60, deadlineAt: "2026-10-17T01:00:00.000Z" } };
  const reset = new ExecutionCustodyService(f.store, resetBinding, f.host);
  assert.equal(reset.executionId, f.service.executionId); assert.throws(() => reset.initialize(owner));
}));

test("AC10 progress needs new evidence plus rationale; repeated hashes/relabeled failures do not reset", () => fixture((f) => {
  failed(f);
  const recovery = { originalFailure: failure().output, diagnostic: source("new-diagnosis"), remedy: null, rationale: "New exact diagnostic evidence changes the remedy.", recheck: failure() };
  assert.equal(f.apply({ action: "attempt", recovery }).bounds.consecutiveNoProgress, 0);
  assert.equal(f.apply({ action: "attempt", recovery }).bounds.consecutiveNoProgress, 1);
  assert.equal(f.apply({ action: "attempt", recovery: { ...recovery, diagnostic: source("unexplained"), rationale: null } }).bounds.consecutiveNoProgress, 2);
  assert.throws(() => f.apply({ action: "attempt", recovery: { ...recovery, originalFailure: source("relabeled") } }));
  assert.deepEqual(f.service.status(owner).originalFailure, failure());
}));

test("AC10 at most three replacements; direct switches and restart do not reset usage", () => fixture((f) => {
  f.plan(); f.select("implement-child"); f.settle();
  for (let i = 1; i <= 3; i++) {
    f.select(); f.settle();
    assert.equal(f.select("implement-child").bounds.replacementsUsed, i);
    f.begin(`last-child-${i}`, "write", child); f.finish(`last-child-${i}`, null, child); f.settle();
  }
  assert.throws(() => f.select("implement-child"));
  assert.equal(new ExecutionCustodyService(f.store, binding(), f.host).status(owner).bounds.replacementsUsed, 3);
}));

test("AC10 deadline stops new actions but does not prevent recording genuine terminal results", () => fixture((f) => {
  f.plan(); f.select(); f.begin("long-check", "check");
  f.setNow("2026-10-17T02:00:00.000Z"); f.finish("long-check"); f.settle(); assert.throws(() => f.select());
  assert.equal(f.service.status(owner).bounds.deadlineAt, binding().bounds.deadlineAt);
}));

test("AC13 exact candidate evidence invalidates on rebase and dirty writes; no UAT/integration from checks alone", () => fixture((f) => {
  f.plan(); f.select(); f.begin("check-1", "check"); f.finish("check-1"); f.settle();
  assert.throws(() => f.apply({ action: "accept", kind: "integration", evidence: source("merge") }));
  assert.throws(() => f.apply({ action: "accept", kind: "uat", evidence: source("uat") }));
  for (const kind of ["review", "ci", "uat", "integration"] as const) f.apply({ action: "accept", kind, evidence: source(kind) });
  assert.equal(projectExecution(f.service.status(owner)).integrationVerified, true);
  f.apply({ action: "candidate", candidateSha: "c".repeat(40), mapping: source("old-new-sha-map") });
  assert.deepEqual(f.service.status(owner).acceptance, {}); assert.deepEqual(f.service.status(owner).passedChecks, {});
  f.select(); f.begin("check-2", "check"); f.finish("check-2");
  f.begin("dirty-write"); f.finish("dirty-write"); f.settle();
  assert.throws(() => f.apply({ action: "accept", kind: "review", evidence: source("old-review") }));
}));

test("AC10 review cap remains independent; review custody is not source-write authority", () => fixture((f) => {
  f.plan(); f.select(); f.begin("check", "check"); f.finish("check"); f.settle();
  for (let count = 1; count <= 3; count++) {
    assert.equal(f.select("review-reserved", reviewer).bounds.reviewsUsed, count);
    assert.throws(() => f.begin(`review-write-${count}`, "write", reviewer)); f.settle();
  }
  f.select(); f.settle(); assert.throws(() => f.select("review-reserved", reviewer));
  assert.equal(f.service.status(owner).bounds.reviewsUsed, 3);
}));

test("AC10 resolving needs fresh passing exact named check; original failed event remains immutable", () => fixture((f) => {
  failed(f);
  assert.throws(() => f.apply({ action: "resolve", evidence: source("invented-pass") }));
  assert.throws(() => f.select());
  f.apply({ action: "attempt", recovery: { originalFailure: failure().output, diagnostic: source("qualified-diagnosis"), remedy: source("qualified-remedy"), rationale: "Evidence-bound remedy before any next writer.", recheck: failure() } });
  f.select(); f.begin("recheck", "check"); f.finish("recheck"); f.settle();
  f.apply({ action: "resolve", evidence: source("result-recheck") });
  assert.equal(f.service.status(owner).originalFailure, null);
  assert.ok(readdirSync(f.root).some((name) => readFileSync(join(f.root, name), "utf8").includes("original-failed-output")));
}));

test("NFR2 journal rejects gaps, drift, insecure records and aliases without cleanup; status is non-secret", () => {
  for (const corrupt of ["gap", "drift", "mode", "alias"] as const) fixture((f) => {
    f.plan(); f.select(); const path = join(f.root, `${f.service.executionId}.transaction-1.json`);
    const before = readFileSync(path);
    if (corrupt === "gap") unlinkSync(path);
    if (corrupt === "drift") writeFileSync(path, before.toString().replace('"sequence":1', '"sequence":9'));
    if (corrupt === "mode") chmodSync(path, 0o644);
    if (corrupt === "alias") linkSync(path, join(f.root, "retained-alias"));
    assert.throws(() => f.service.status(owner));
    if (corrupt !== "gap") assert.ok(readFileSync(path).length > 0);
  });
  fixture((f) => {
    const text = JSON.stringify(projectExecution(f.service.status(owner)));
    assert.doesNotMatch(text, /process|boot|startTime|\/fixture|token|command|output/);
    assert.ok(Object.isFrozen(f.service.status(owner).binding.owner.process));
  });
});

function git(root: string, args: readonly string[]): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", [...args], { cwd: root, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] });
}
function remoteFixture(run: (root: string, remote: string, b: ExecutionBinding, base: string, candidate: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap256-update-"));
  try {
    const remote = join(root, "remote.git"); git(root, ["init", "--bare", remote]); git(root, ["init", "--initial-branch", "feature/PAP-256-fixture"]);
    git(root, ["config", "user.name", "Fixture"]); git(root, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(root, "file.txt"), "base\n"); git(root, ["add", "file.txt"]); git(root, ["commit", "-m", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]).toString().trim(); git(root, ["remote", "add", "origin", remote]); git(root, ["push", "origin", "HEAD"]);
    writeFileSync(join(root, "file.txt"), "candidate\n"); git(root, ["commit", "-am", "candidate"]);
    const candidate = git(root, ["rev-parse", "HEAD"]).toString().trim();
    run(root, remote, { ...binding(), repoRoot: "/fixture/canonical", worktreeRoot: root, initialHeadSha: base }, base, candidate);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("AC11 fixed expected-HEAD feature update works against local bare remote, never follows tags", () => remoteFixture((root, _remote, b, base, candidate) => {
  git(root, ["tag", "-a", "private-tag", "-m", "not pushed"]);
  const commands: readonly string[][] = [] as string[][];
  updateFeatureWithExpectedHead({ binding: b, candidateSha: candidate, expectedRemoteSha: base }, (args, cwd) => { (commands as string[][]).push([...args]); return git(cwd, args); });
  assert.equal(git(root, ["ls-remote", "origin", "refs/tags/private-tag"]).length, 0);
  assert.ok(commands.some((args) => args.includes(`--force-with-lease=refs/heads/${b.branch}:${base}`)));
  assert.throws(() => updateFeatureWithExpectedHead({ binding: b, candidateSha: candidate, expectedRemoteSha: base }, (args, cwd) => git(cwd, args)));
}));

test("AC11 remote race after observation rejects without overwriting newer remote HEAD", () => remoteFixture((root, remote, b, base, candidate) => {
  const racer = git(root, ["commit-tree", `${base}^{tree}`, "-p", base, "-m", "concurrent writer"]).toString().trim();
  git(root, ["push", "origin", `${racer}:refs/heads/racer-object`]);
  let raced = false;
  assert.throws(() => updateFeatureWithExpectedHead({ binding: b, candidateSha: candidate, expectedRemoteSha: base }, (args, cwd) => {
    if (args.includes("push") && !raced) { raced = true; git(remote, ["update-ref", `refs/heads/${b.branch}`, racer, base]); }
    return git(cwd, args);
  }));
  assert.equal(raced, true);
  assert.equal(git(remote, ["rev-parse", `refs/heads/${b.branch}`]).toString().trim(), racer);
}));

test("AC11 candidate/ref drift rejects before network update; synchronous port rejects Promises", () => remoteFixture((root, _remote, b, base, candidate) => {
  const calls: string[][] = [];
  assert.throws(() => updateFeatureWithExpectedHead({ binding: b, candidateSha: base, expectedRemoteSha: base }, (args, cwd) => { calls.push([...args]); return git(cwd, args); }));
  assert.ok(!calls.some((args) => args.includes("ls-remote") || args.includes("push")));
  assert.throws(() => updateFeatureWithExpectedHead({ binding: { ...b, branch: "develop" }, candidateSha: candidate, expectedRemoteSha: base }, (args, cwd) => git(cwd, args)));
  assert.throws(() => updateFeatureWithExpectedHead({ binding: b, candidateSha: candidate, expectedRemoteSha: base }, (async () => Buffer.from("")) as unknown as (args: readonly string[], cwd: string) => Buffer));
}));
