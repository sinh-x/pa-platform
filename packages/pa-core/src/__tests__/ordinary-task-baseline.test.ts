import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeTicketBranch, resolveOrdinaryTaskBaseline } from "../tickets/materialization.js";
import { TicketStore } from "../tickets/store.js";
import { acquireRepositoryTicketSlot, releaseRepositoryTicketSlot, repositoryTicketSlotPath } from "../deploy/ticket-concurrency.js";

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

for (const hook of ["reference-transaction", "post-checkout"]) test(`PAP-268 unsupported ${hook} stops before materialization effects`, () => fixture((f) => {
  const hooks = join(f.root, "hooks"); mkdirSync(hooks);
  writeFileSync(join(hooks, hook), `#!/bin/sh\nprintf 'forbidden' > ${join(f.root, "hook-effect.txt")}\n`, { mode: 0o700 });
  f.git(["config", "core.hooksPath", hooks]); const before = f.inventory();
  assert.throws(f.materialize, /EXECUTION_GIT_EFFECTS_UNSUPPORTED/); assert.deepEqual(f.inventory(), before);
  assert.throws(() => readFileSync(join(f.root, "hook-effect.txt")), /ENOENT/);
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

test("PAP-268 uncertain checkout custody stops before branch mutation and preserves its evidence", () => fixture((f) => {
  const gitDir = f.git(["rev-parse", "--absolute-git-dir"], f.worktree);
  const ownerPath = join(gitDir, "pa-repository-mutation.lease.json");
  const unknown = "{UNKNOWN-OWNER-SENTINEL"; writeFileSync(ownerPath, unknown, { mode: 0o600 });
  const before = f.inventory(); assert.throws(f.materialize, /ORDINARY_BASELINE_HOLDER_UNCERTAIN/);
  assert.deepEqual(f.inventory(), before); assert.equal(readFileSync(ownerPath, "utf8"), unknown);
}));

for (const interruption of ["after-ref-create", "before-ticket-publication"] as const) {
  test(`PAP-268 same native owner reconciles ${interruption} exactly once without adopting independent work`, () => fixture((f) => {
    const acquired = acquireRepositoryTicketSlot({ canonicalRepoKey: "fixture", canonicalRepoRoot: f.repo, ticket: "PAP-1", deploymentId: "d-268abc", deploymentDirectory: join(f.root, "deployment") });
    assert.equal(acquired.status, "acquired"); if (acquired.status !== "acquired") return;
    const ordinaryOwner = { ...acquired.slot };
    let interrupted = false, creations = 0;
    const originalUpdate = f.store.update.bind(f.store);
    f.store.update = (...args: Parameters<TicketStore["update"]>) => {
      if (interruption === "before-ticket-publication" && !interrupted) { interrupted = true; throw new Error("injected publication interruption"); }
      return originalUpdate(...args);
    };
    const runGit = (args: readonly string[], cwd: string) => {
      const output = execFileSync("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      if (args[0] === "update-ref") { creations++; if (interruption === "after-ref-create" && !interrupted) { interrupted = true; throw new Error("injected return interruption"); } }
      return output;
    };
    const options = { ...f.options, worktreeRoot: f.worktree, intendedTaskBaseline: f.resolve(), ordinaryOwner, runGit };
    const canonical = f.git(["rev-parse", "HEAD"]);
    assert.throws(() => materializeTicketBranch(options), /injected|ORDINARY_BASELINE_BRANCH_RESULT_UNCERTAIN/);
    assert.equal(f.store.get("PAP-1")!.linkedBranches[0]!.state, "planned");
    assert.equal(f.git(["rev-parse", `refs/heads/${f.branch}`]), f.base);
    const slotBefore = readFileSync(repositoryTicketSlotPath(f.repo, "PAP-1"));
    assert.ok(JSON.parse(slotBefore.toString()).materializationIntent);
    assert.equal(releaseRepositoryTicketSlot(ordinaryOwner).status, "invalid-evidence", "unstarted cleanup cannot erase materialization intent/result proof");
    assert.deepEqual(readFileSync(repositoryTicketSlotPath(f.repo, "PAP-1")), slotBefore);
    assert.throws(() => materializeTicketBranch({ ...options, ordinaryOwner: { ...ordinaryOwner, slotToken: "not-the-holder" } }), /ORDINARY_BASELINE_OWNER_INTENT_REJECTED/);
    assert.deepEqual(readFileSync(repositoryTicketSlotPath(f.repo, "PAP-1")), slotBefore);
    const resumed = materializeTicketBranch(options); assert.equal(resumed.created, false); assert.equal(resumed.baseSha, f.base);
    assert.equal(creations, 1); assert.equal(f.git(["rev-parse", "HEAD"]), canonical);
    assert.equal(f.store.get("PAP-1")!.linkedBranches[0]!.state, "materialized");
    assert.deepEqual(readFileSync(repositoryTicketSlotPath(f.repo, "PAP-1")), slotBefore, "intent/custody is retained, not reset or recreated");
  }));
}

for (const style of ["standard-pair", "owner-directed-pair", "bad-hash", "changed-tuple", "rejected-pair", "preview-alias"] as const) {
  test(`PAP-268 existing reviewed-pair producer ${style} requires no replacement approval`, () => fixture((f) => {
    const current = f.markdown.replace("> Status:", "> Review Revision: r001\n> Status:");
    writeFileSync(f.sourcePath, current);
    const previewPath = "agent-teams/requirements/artifacts/reviews/PAP-1/r001/requirements.md";
    const previewAbsolute = join(f.ai, previewPath); mkdirSync(join(f.ai, "agent-teams/requirements/artifacts/reviews/PAP-1/r001"), { recursive: true });
    const preview = current.replace("Approved — plan only", "Draft — UNAPPROVED"); writeFileSync(previewAbsolute, preview);
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const source = "requirements:agent-teams/requirements/artifacts/task.md";
    const decision = style === "owner-directed-pair" ? 'Explicit foreground PA sign-off in d-123abc: I selected "Approve this exact pair" for owner-directed PAP-1 r001.'
      : "Explicit standalone foreground PA sign-off in d-123abc: I selected Approve exact pair and matrix for PAP-1 r001.";
    const ticket = structuredClone(f.ticket);
    ticket.comments[0]!.content = `${decision} Reviewed requirements source: ${previewPath}, raw SHA-256 ${style === "bad-hash" ? "f".repeat(64) : digest(preview)}; reviewed companion: separate. Matrix Source: ${source}. Approved intent: local scope; not UAT or rollout.`;
    if (style === "changed-tuple") writeFileSync(f.sourcePath, current.replace(f.base, "a".repeat(40)));
    if (style === "rejected-pair") ticket.comments[0]!.content = "Rejected this pair. " + ticket.comments[0]!.content;
    if (style === "preview-alias") { const other = join(f.root, "preview.md"); writeFileSync(other, preview); rmSync(previewAbsolute); symlinkSync(other, previewAbsolute); }
    writeFileSync(f.ticketPath, JSON.stringify(ticket)); const before = f.inventory();
    if (style === "standard-pair" || style === "owner-directed-pair") assert.equal(f.resolve().baseSha, f.base);
    else assert.throws(f.resolve, /ORDINARY_BASELINE_/);
    assert.deepEqual(f.inventory(), before);
  }));
}

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
