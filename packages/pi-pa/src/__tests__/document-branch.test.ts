import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TicketStore, acquireRepositoryMutationLease, resolveRepoExecutionPath, captureRepositoryGitSnapshot, repositoryMutationLeasePath, workflowDigest } from "@pa-platform/pa-core";
import { inspectPiDocumentBranch } from "../document-branch.js";
import { TreehouseClient } from "../treehouse.js";

function fixture() {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "document-branch-")), repo = join(root, "repo"), slot = join(root, "slot"), config = join(root, "config"), usage = join(root, "usage"), tickets = join(usage, "tickets");
  for (const path of [repo, config, usage, tickets]) mkdirSync(path);
  process.env.PA_PLATFORM_CONFIG = config; process.env.PA_AI_USAGE_HOME = usage;
  writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
  const git = (args: string[], cwd = repo) => execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-b", "develop"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base"]);
  const head = git(["rev-parse", "HEAD"]), branch = "feature/EX-1-fixture";
  git(["worktree", "add", "-b", branch, slot]);
  const ticket = { id: "EX-1", project: "example", title: "Disposable bridge fixture", status: "pending-implementation", assignee: "builder/team-manager", doc_refs: [], comments: [], tags: [], linkedBranches: [{ repo: "example", branch, state: "materialized", baseSha: head, headSha: head, sha: head, linkedAt: "2026-11-10T00:00:00.000Z", linkedBy: "fixture" }] };
  const save = () => writeFileSync(join(tickets, "EX-1.json"), JSON.stringify(ticket)); save();
  const store = new TicketStore(tickets), commands: string[][] = [];
  let status = [{ path: slot, leased: true, lease_id: "fixture-lease", lease_holder: "pa:example:EX-1" }];
  const treehouse = new TreehouseClient({ run: args => { commands.push([...args]); return { status: 0, stdout: Buffer.from(args[0] === "--version" ? "v3.1.3\n" : JSON.stringify(status)), stderr: Buffer.alloc(0) }; } });
  const caller = { deploymentId: "d-abcdef", repoKey: "example", repoRoot: repo, ticket: "EX-1", identitySha256: "a".repeat(64) };
  const inspect = () => inspectPiDocumentBranch(caller, "EX-1", store, treehouse);
  const snapshot = () => {
    const walk = (folder: string): string[] => readdirSync(folder).sort().flatMap(name => { const p = join(folder, name), s = lstatSync(p); return s.isDirectory() ? [`${relative(root, p)}:directory:${s.mode}`, ...walk(p)] : [`${relative(root, p)}:${s.mode}:${s.nlink}:${workflowDigest(readFileSync(p))}`]; });
    return walk(root);
  };
  return { root, repo, slot, head, branch, git, ticket, save, store, commands, treehouse, caller, inspect, snapshot, setStatus: (value: typeof status) => { status = value; }, close: () => { process.env = env; rmSync(root, { recursive: true, force: true }); } };
}
test("branch bridge reuses materialized intent and existing owners with zero filesystem/ticket/lease mutations or launch grants", () => {
  const f = fixture();
  try {
    const before = f.snapshot(); const first = f.inspect(); assert.equal(first.code, "BRANCH_VERIFIED", JSON.stringify(first)); assert.equal(first.queue, "queued"); assert.equal(first.launchReady, false); assert.equal(first.authorityGranted, false);
    assert.equal(f.inspect().code, "BRANCH_VERIFIED"); assert.deepEqual(f.snapshot(), before);
    assert.ok(f.commands.every(args => args.join(" ") === "--version" || args.join(" ") === "status --json"));
  } finally { f.close(); }
});
test("branch bridge missing, foreign, ambiguous and planned links retain precise preparation/intent findings", () => {
  const f = fixture();
  try {
    const link = f.ticket.linkedBranches[0]!;
    f.ticket.linkedBranches = []; f.save(); assert.equal(f.inspect().code, "MISSING_LINK");
    f.ticket.linkedBranches = [{ ...link, repo: "other" }]; f.save(); assert.equal(f.inspect().code, "FOREIGN_LINK");
    f.ticket.linkedBranches = [link, link]; f.save(); assert.equal(f.inspect().code, "CONFLICTING_LINKS");
    f.ticket.linkedBranches = [{ repo: "example", branch: f.branch, state: "planned", linkedAt: link.linkedAt, linkedBy: "fixture" } as any]; f.save();
    const before = f.snapshot(); assert.equal(f.inspect().code, "PREPARATION_NEEDED"); assert.deepEqual(f.snapshot(), before); assert.equal(f.commands.length, 0);
  } finally { f.close(); }
});
test("branch bridge does not normalize conflicting or legacy-incomplete ticket evidence into verified selection", () => {
  const f = fixture();
  try {
    const link = f.ticket.linkedBranches[0]!;
    link.sha = "f".repeat(40); f.save(); assert.equal(f.inspect().code, "INVALID_LINK");
    link.sha = f.head; delete (link as any).headSha; f.save(); assert.equal(f.inspect().code, "INVALID_LINK");
    link.headSha = f.head; delete (link as any).state; f.save(); assert.equal(f.inspect().code, "INVALID_LINK");
  } finally { f.close(); }
});
test("branch bridge reports harmless recorded HEAD advancement without relink, reset or replacement approval", () => {
  const f = fixture();
  try {
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "progress"], f.slot);
    const before = f.snapshot(), result = f.inspect(); assert.equal(result.code, "RECORDED_HEAD_ADVANCED"); assert.ok(String(result.guidance).includes("not demand a replacement branch approval"));
    assert.deepEqual(f.snapshot(), before); assert.equal(f.store.get("EX-1")!.linkedBranches[0]!.headSha, f.head);
  } finally { f.close(); }
});
test("branch bridge distinguishes incompatible base, missing lease, foreign worktree and unresolved protected ownership", () => {
  const f = fixture();
  try {
    const link = f.ticket.linkedBranches[0]!;
    link.baseSha = "f".repeat(40); f.save(); assert.equal(f.inspect().code, "BASE_EVIDENCE_INVALID"); link.baseSha = f.head; f.save();
    f.setStatus([]); assert.equal(f.inspect().code, "PREPARATION_NEEDED");
    f.setStatus([{ path: f.repo, leased: true, lease_id: "fixture-lease", lease_holder: "pa:example:EX-1" }]); assert.equal(f.inspect().code, "WORKTREE_MISMATCH");
    f.setStatus([{ path: f.slot, leased: true, lease_id: "fixture-lease", lease_holder: "pa:example:EX-1" }]);
    writeFileSync(repositoryMutationLeasePath(f.slot), "malformed owner", { mode: 0o600 });
    const before = f.snapshot(); assert.equal(f.inspect().code, "OWNER_EVIDENCE_UNPROVEN"); assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});
test("branch bridge recognizes an existing live native builder owner without releasing or overriding it", () => {
  const f = fixture();
  try {
    const selected = resolveRepoExecutionPath(undefined, f.slot, { allowLinkedWorktreeCwd: true });
    const acquired = acquireRepositoryMutationLease({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.slot, expectedGitDir: selected.gitDir, expectedGitCommonDir: selected.gitCommonDir,
      deploymentId: "d-abc123", deploymentDirectory: join(f.root, "disposable-owner"), runtime: "pi", mode: "orchestrator", team: "builder", ticket: "EX-1", pid: process.pid,
      gitSnapshot: captureRepositoryGitSnapshot(f.slot) });
    assert.equal(acquired.status, "acquired", JSON.stringify(acquired));
    const before = f.snapshot(); assert.equal(f.inspect().code, "OWNER_CONFLICT"); assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});
test("branch bridge distinguishes lease ambiguity, branch mismatch and unrelated recorded HEAD", () => {
  const f = fixture();
  try {
    f.setStatus([{ path: f.slot, leased: true, lease_id: "one", lease_holder: "pa:example:EX-1" }, { path: f.repo, leased: true, lease_id: "two", lease_holder: "pa:example:EX-1" }]); assert.equal(f.inspect().code, "LEASE_CONFLICT");
    f.setStatus([{ path: f.slot, leased: true, lease_id: "one", lease_holder: "pa:example:EX-1" }]);
    f.git(["switch", "-c", "other-branch"], f.slot); assert.equal(f.inspect().code, "BRANCH_MISMATCH");
    f.ticket.linkedBranches[0]!.headSha = "f".repeat(40); f.ticket.linkedBranches[0]!.sha = "f".repeat(40); f.save(); assert.equal(f.inspect().code, "HEAD_MISMATCH");
  } finally { f.close(); }
});
test("branch bridge reobserves lease drift and rejects stale observations without repair", () => {
  const f = fixture();
  try {
    let statuses = 0;
    const treehouse = new TreehouseClient({ run: args => ({ status: 0, stdout: Buffer.from(args[0] === "--version" ? "v3.1.3\n" : JSON.stringify([{ path: f.slot, leased: true, lease_id: ++statuses === 1 ? "original" : "changed", lease_holder: "pa:example:EX-1" }])), stderr: Buffer.alloc(0) }) });
    const before = f.snapshot(); const reply = inspectPiDocumentBranch(f.caller, "EX-1", f.store, treehouse); assert.equal(reply.code, "OBSERVATION_CHANGED"); assert.deepEqual(f.snapshot(), before);
    assert.ok(String(reply.guidance).length <= 2000); for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(String(reply.guidance).split(label).length, 2);
  } finally { f.close(); }
});
