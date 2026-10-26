import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeTicketBranch, resolveOrdinaryTaskBaseline } from "../tickets/materialization.js";
import { TicketStore } from "../tickets/store.js";

function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap268-baseline-"));
  const env = process.env; process.env = { ...env };
  try { run(setup(root)); } finally { process.env = env; rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  const repo = join(root, "repo"), worktree = join(root, "checkout"), ai = join(root, "ai"), config = join(root, "config");
  mkdirSync(repo); mkdirSync(config); mkdirSync(join(ai, "tickets"), { recursive: true });
  mkdirSync(join(ai, "agent-teams/requirements/artifacts"), { recursive: true });
  for (const key of Object.keys(process.env)) if (/^(PA_|GIT_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { PA_AI_USAGE_HOME: ai, PA_PLATFORM_CONFIG: config });
  const git = (args: string[], cwd = repo): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git(["init", "-q", "-b", "develop"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]); git(["config", "core.hooksPath", "/dev/null"]);
  writeFileSync(join(repo, "README.md"), "A\n"); git(["add", "README.md"]); git(["commit", "-qm", "base A"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["worktree", "add", "--detach", worktree, base]);
  writeFileSync(join(config, "config.yaml"), `repos:\n  fixture:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n`);
  const source = "requirements:agent-teams/requirements/artifacts/task.md";
  const sourcePath = join(ai, source.slice("requirements:".length));
  const commentId = "c-20261026000000000", branch = "feature/PAP-1-local";
  const markdown = `# Task\n\n> Status: Approved — plan only\n> Author: requirements/analyst\n> Ticket: PAP-1\n> Repository Key: fixture\n> Repository Root: ${repo}\n> Handoff Type: fresh\n> Approved Base SHA: ${base}\n> Feature Branch: ${branch}\n> Review Approval Evidence: PAP-1#${commentId}\n\n## Work\nLocal work only.\n`;
  writeFileSync(sourcePath, markdown);
  const ticket = { id: "PAP-1", project: "fixture", title: "Fixture", linkedBranches: [{ repo: "fixture", branch, state: "planned", linkedAt: "2026-10-26T00:00:00.000Z", linkedBy: "fixture" }],
    doc_refs: [{ type: "requirements", path: source.slice("requirements:".length), primary: true }],
    comments: [{ id: commentId, author: "sinh", content: `Approve PAP-1 fixture ${repo} ${branch} from exact base ${base}; source ${source}.` }] };
  const ticketPath = join(ai, "tickets/PAP-1.json"); writeFileSync(ticketPath, JSON.stringify(ticket));
  const store = new TicketStore(join(ai, "tickets"));
  const options = { canonicalRepoKey: "fixture", canonicalRepoRoot: repo, ticketId: "PAP-1", ticketStore: store };
  const resolve = () => resolveOrdinaryTaskBaseline(options);
  const materialize = () => materializeTicketBranch({ ...options, worktreeRoot: worktree, intendedTaskBaseline: resolve() });
  const inventory = () => ({ refs: git(["show-ref"]), canonical: git(["status", "--porcelain=v2", "--untracked-files=all"]), head: git(["rev-parse", "HEAD"]),
    worktreeHead: git(["rev-parse", "HEAD"], worktree), status: git(["status", "--porcelain=v2", "--untracked-files=all"], worktree), ticket: readFileSync(ticketPath, "utf8") });
  return { root, repo, worktree, ai, base, branch, git, ticket, ticketPath, sourcePath, markdown, store, options, resolve, materialize, inventory };
}

test("PAP-268 ordinary baseline authenticates a durable task tuple, creates once and preserves canonical work", () => fixture((f) => {
  writeFileSync(join(f.repo, "unrelated.txt"), "preserve canonical work\n");
  const before = f.inventory(); const baseline = f.resolve();
  assert.equal(baseline.schemaVersion, "ordinary-task-baseline/v1"); assert.equal(baseline.baseSha, f.base);
  assert.equal(f.materialize().created, true); assert.equal(f.materialize().created, false);
  assert.equal(f.git(["rev-parse", "HEAD"], f.worktree), f.base);
  const after = f.inventory(); assert.equal(after.canonical, before.canonical); assert.equal(after.head, before.head);
  assert.equal(f.store.get("PAP-1")!.linkedBranches[0]!.baseSha, f.base);
}));

test("PAP-268 stale configured integration base is rejected before any branch creation", () => fixture((f) => {
  writeFileSync(join(f.repo, "README.md"), "B\n"); f.git(["commit", "-am", "base B"]);
  assert.notEqual(f.git(["rev-parse", "HEAD"]), f.base); const before = f.inventory();
  assert.throws(f.resolve, /ORDINARY_BASELINE_CONFIG_MISMATCH/); assert.deepEqual(f.inventory(), before);
}));

for (const variant of ["missing", "ambiguous", "draft", "duplicate-header", "wrong-ticket", "wrong-root", "wrong-branch", "forged-author", "unbound-approval", "source-alias", "retained-conflict"] as const) {
  test(`PAP-268 ${variant} intent stops without source effects`, () => fixture((f) => {
    const ticket = structuredClone(f.ticket);
    if (variant === "missing") ticket.doc_refs = [];
    if (variant === "ambiguous") ticket.doc_refs.push({ ...ticket.doc_refs[0]! });
    if (variant === "forged-author") ticket.comments[0]!.author = "requirements/analyst";
    if (variant === "unbound-approval") ticket.comments[0]!.content = "Approved, continue";
    if (variant === "draft") writeFileSync(f.sourcePath, f.markdown.replace("Approved — plan only", "Draft"));
    if (variant === "duplicate-header") writeFileSync(f.sourcePath, f.markdown.replace("> Approved Base SHA:", `> Approved Base SHA: ${f.base}\n> Approved Base SHA:`));
    if (variant === "wrong-ticket") writeFileSync(f.sourcePath, f.markdown.replace("Ticket: PAP-1", "Ticket: PAP-2"));
    if (variant === "wrong-root") writeFileSync(f.sourcePath, f.markdown.replace(`Root: ${f.repo}`, `Root: ${f.worktree}`));
    if (variant === "wrong-branch") writeFileSync(f.sourcePath, f.markdown.replace(f.branch, "feature/PAP-1-other"));
    if (variant === "retained-conflict") Object.assign(ticket.linkedBranches[0]!, { state: "materialized", baseSha: "f".repeat(40), headSha: f.base });
    if (variant === "source-alias") { const other = join(f.root, "alias.md"); writeFileSync(other, f.markdown); rmSync(f.sourcePath); symlinkSync(other, f.sourcePath); }
    writeFileSync(f.ticketPath, JSON.stringify(ticket)); const before = f.inventory();
    assert.throws(f.resolve, /ORDINARY_BASELINE_/); assert.deepEqual(f.inventory(), before);
  }));
}

test("PAP-268 intent is reauthenticated at materialization and never becomes a caller SHA override", () => fixture((f) => {
  const intendedTaskBaseline = f.resolve(); writeFileSync(f.sourcePath, f.markdown + "Changed after selection\n");
  const before = f.inventory();
  assert.throws(() => materializeTicketBranch({ ...f.options, worktreeRoot: f.worktree, intendedTaskBaseline }), /ORDINARY_BASELINE_CHANGED/);
  assert.deepEqual(f.inventory(), before);
  assert.throws(() => materializeTicketBranch({ ...f.options, worktreeRoot: f.worktree, intendedTaskBaseline: { ...f.resolve(), baseSha: "a".repeat(40) } }), /ORDINARY_BASELINE_CHANGED/);
  assert.deepEqual(f.inventory(), before);
}));

for (const variant of ["dirty", "independent-branch", "configured-drift"] as const) {
  test(`PAP-268 ${variant} checkout is preserved without branch adoption/reset`, () => fixture((f) => {
    const intendedTaskBaseline = f.resolve();
    if (variant === "dirty") writeFileSync(join(f.worktree, "unknown.txt"), "preserve\n");
    if (variant === "independent-branch") f.git(["branch", f.branch, f.base]);
    if (variant === "configured-drift") { writeFileSync(join(f.repo, "README.md"), "B\n"); f.git(["commit", "-am", "base B"]); }
    const before = f.inventory();
    assert.throws(() => materializeTicketBranch({ ...f.options, worktreeRoot: f.worktree, intendedTaskBaseline }));
    assert.deepEqual(f.inventory(), before);
  }));
}
