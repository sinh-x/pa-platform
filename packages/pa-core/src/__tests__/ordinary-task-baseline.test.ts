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

type PairStyle = "waw" | "ttl012" | "ttl014" | "nx066";
/** Sanitized retained producer grammar; no live artifact is read or written. */
function retainedPair(f: ReturnType<typeof setup>, style: PairStyle) {
  const revision = "r001", source = "requirements:agent-teams/requirements/artifacts/task.md";
  const current = f.markdown.replace("> Status:", `> Review Revision: ${revision}\n> Matrix Authority SHA-256: ${"c".repeat(64)}\n> Status:`);
  const previewPath = `agent-teams/requirements/artifacts/reviews/PAP-1/${revision}/requirements.md`;
  const preview = current.replace("Approved — plan only", "Draft — UNAPPROVED");
  const previewAbsolute = join(f.ai, previewPath);
  mkdirSync(join(f.ai, "agent-teams/requirements/artifacts/reviews/PAP-1", revision), { recursive: true });
  writeFileSync(previewAbsolute, preview); writeFileSync(f.sourcePath, current);
  const hash = createHash("sha256").update(preview).digest("hex");
  const uat = `# Synthetic UAT preview\n\n> Ticket: PAP-1\n> Revision: ${revision}\n\n## Scenarios\nDisposable fixture only.\n`;
  const uatPath = `agent-teams/requirements/artifacts/reviews/PAP-1/${revision}/uat-preview.md`;
  writeFileSync(join(f.ai, uatPath), uat);
  const tuple = `Handoff Type: fresh. Repository Key: fixture. Repository Root: ${f.repo}. Feature Branch: ${f.branch}. Approved Base SHA: ${f.base}.`;
  const content = style === "waw"
    ? `Explicit PA sign-off from interactive deployment d-123abc: Approve ${revision} pair and exact matrix. I approve the complete PAP-1 requirements revision ${revision} and companion UAT, local scope. Reviewed requirements: ${previewPath}, raw SHA-256 ${hash}. Reviewed UAT: separate. ${tuple} Matrix Source: ${source}. I approve that exact 10-command matrix and requirements/UAT pair for promotion after final Shape-Conformance 13/13. This is not implementation authorization, AWS access/apply/rollout/backfill/Billing authorization, paired-runtime readiness, or successful UAT.`
    : style === "nx066"
      ? `APPROVED in standalone PA decision during d-123abc. Approve paired plan and matrix. Requirements review ${revision} source ${previewPath} raw SHA-256 ${hash}. Companion UAT ${revision} source ${uatPath} raw SHA-256 ${createHash("sha256").update(uat).digest("hex")}. Approved intent native configuration only and unsupported behavior stops before product edits. Route builder/orchestrator. Repository Key fixture Repository Root ${f.repo} Ticket PAP-1 Handoff Type fresh Branch Action create Linked Branch State planned exact link fixture|${f.branch} [planned] Approved Base SHA ${f.base} Feature Branch ${f.branch}. Matrix Source ${source} Matrix Authority SHA-256 ${"c".repeat(64)}. Approve all six exact commands, prerequisites, environment and pass criteria. Authorize administrative approval metadata and final links only, final approval-bound 13 checks and paired promotion to requirements and UAT dated artifacts, followed by supported preparation assessment. No product-source implementation or builder spawn authorized. Actual matrix execution, native runtime UAT and paired-runtime readiness are not claimed.`
    : style === "ttl012"
      ? `APPROVED in standalone PA sign-off, deployment d-123abc: complete requirements/UAT pair ${revision}. Requirements source ${source} reviewed as reviews/PAP-1/${revision}/requirements.md raw SHA-256 ${hash}. Companion UAT source separate. Intent: local scope. Route builder/orchestrator. Handoff fresh, canonical fixture root ${f.repo}, approved base ${f.base}, exact branch ${f.branch}, planned/create. Matrix Source: ${source}. Approve this exact four-command matrix and pair, permitting only administrative approval/status/link metadata changes for final promotion. Device tests, candidate CI, human UAT and authenticated runtime/preparation readiness remain separate gates no implementation spawn authorized.`
      : `Final standalone PA sign-off in d-123abc. Sinh selected Approve exact ${revision} pair and matrix after complete whole-document Markdown requirements and sixteen-scenario UAT review was offered. Approved intent: local scope. Requirements Source and Matrix Source ${source}. Reviewed revision ${revision} requirements raw SHA-256 ${hash}. Companion UAT Source separate. Repository Key fixture Repository Root ${f.repo} Ticket PAP-1 Route builder/orchestrator Handoff Type fresh Feature Branch ${f.branch} Approved Base SHA ${f.base} Linked Branch State planned Branch Action create exact ticket value fixture|${f.branch} [planned]. No source implementation, live service/network/certificate/phone effect, matrix execution, review/builder spawn, merge or checkout return is authorized. Plan approval is not executed UAT or application acceptance.`;
  const ticket = structuredClone(f.ticket); ticket.comments[0]!.content = content;
  writeFileSync(f.ticketPath, JSON.stringify(ticket));
  return { ticket, current, preview, previewAbsolute, previewPath, hash, source };
}

for (const style of ["waw", "ttl012", "ttl014", "nx066"] as const) {
  test(`PAP-269 retained ${style} producer resolves exact source and decision without replacement`, () => fixture((f) => {
    const p = retainedPair(f, style), before = f.inventory();
    const baseline = f.resolve();
    assert.equal(baseline.baseSha, f.base); assert.equal(baseline.requirements.ref, p.source);
    assert.equal(baseline.approval.commentId, p.ticket.comments[0]!.id);
    assert.equal(baseline.requirements.sha256, createHash("sha256").update(p.current).digest("hex"));
    assert.equal(baseline.approval.sha256, createHash("sha256").update(JSON.stringify(p.ticket.comments[0])).digest("hex"));
    assert.deepEqual(f.inventory(), before); assert.equal(readFileSync(p.previewAbsolute, "utf8"), p.preview);
  }));
}

function legacyStandardPair(f: ReturnType<typeof setup>) {
  const p = retainedPair(f, "waw");
  p.ticket.comments[0]!.content = `Explicit standalone foreground PA sign-off in d-9b82df: I selected Approve exact pair and matrix for PAP-1 r001. Reviewed requirements: ${p.previewPath}; raw SHA-256 ${p.hash}. Reviewed UAT: agent-teams/requirements/artifacts/reviews/PAP-1/r001/uat-preview.md; raw SHA-256 ${"b".repeat(64)}. Approved intent: scoped ordinary local PPA instruction/tests, Markdown sufficient for local reporting, automatic safety and separate downstream/risky-effect gates retained, actual runtime capability limits disclosed and paired proof required before acceptance/adoption. Handoff: builder/orchestrator; canonical fixture at ${f.repo}; fresh planned/create; ${f.branch} from exact base ${f.base}; exact verified planned link retained. Matrix Source: ${p.source}. Matrix Authority SHA-256: ${"c".repeat(64)}. Approve the exact eleven-command matrix and all eight paired UAT scenarios as plans, not results. Permit only administrative approval/status/hash/link metadata insertion and unchanged paired publication after final 13 checks; no material requirement/matrix/UAT change. This does not launch implementation/review, authenticate custody, approve UAT success, install or activate policy. Recorded by the analyst from my explicit standalone foreground decision.`;
  writeFileSync(f.ticketPath, JSON.stringify(p.ticket)); return p;
}

test("PAP-269 preserves actual legacy PAPC-068 complete sign-off grammar and safety boundaries", () => fixture((f) => {
  legacyStandardPair(f); const before = f.inventory(); assert.equal(f.resolve().baseSha, f.base); assert.deepEqual(f.inventory(), before);
}));
for (const variant of ["repo", "root", "handoff", "branch", "base", "duplicate-handoff", "negated", "extra-grant", "repeated-grant", "conditional"] as const) {
  test(`PAP-269 legacy PAPC-068 producer rejects ${variant} before Git`, () => fixture((f) => {
    const p = legacyStandardPair(f), comment = p.ticket.comments[0]!;
    if (variant === "repo") comment.content = comment.content.replace("canonical fixture at", "canonical other at");
    if (variant === "root") comment.content = comment.content.replace(f.repo, f.worktree);
    if (variant === "handoff") comment.content = comment.content.replace("fresh planned/create", "amendment materialized/reuse");
    if (variant === "branch") comment.content = comment.content.replace(f.branch, f.branch + "-other");
    if (variant === "base") comment.content = comment.content.replace(f.base, "f".repeat(40));
    if (variant === "duplicate-handoff") comment.content += ` Handoff: builder/orchestrator; canonical fixture at ${f.repo}; fresh planned/create; ${f.branch} from exact base ${f.base};`;
    if (variant === "negated") comment.content += " I do not approve this pair.";
    if (variant === "extra-grant") comment.content += " I approve UAT success.";
    if (variant === "repeated-grant") comment.content += " Approve the exact eleven-command matrix and all eight paired UAT scenarios as plans, not results.";
    if (variant === "conditional") comment.content += " Only if another review passes.";
    writeFileSync(f.ticketPath, JSON.stringify(p.ticket)); const before = f.inventory(); let gitCalls = 0;
    assert.throws(() => resolveOrdinaryTaskBaseline({ ...f.options, runGit: () => { gitCalls++; throw new Error("must not reach Git"); } }), /ORDINARY_BASELINE_/);
    assert.equal(gitCalls, 0); assert.deepEqual(f.inventory(), before);
  }));
}

const invalidPairs = ["author", "ticket", "source", "revision", "hash", "repo", "root", "handoff", "branch", "base", "duplicate-comment", "duplicate-source", "duplicate-matrix", "duplicate-tuple", "malformed-tuple", "duplicate-preview", "wrong-preview-revision", "wrong-preview-tuple", "preview-alias", "directory-alias", "oversized", "malformed-utf8", "unknown", "negated", "rejected", "revoked", "conditional", "partial", "ambiguous", "withdrawal-id", "withdrawal-source", "uncertain-withdrawal", "conflicting-header", "opposite-preview-base", "malformed-tab-clause", "negative-permission", "discussion-only", "bad-header-hash", "malformed-header-hash", "malformed-source-utf8", "oversized-source"] as const;
for (const style of ["waw", "ttl012", "ttl014", "nx066"] as const) for (const variant of invalidPairs) {
  test(`PAP-269 ${style} rejects ${variant} before Git and preserves evidence`, () => fixture((f) => {
    const p = retainedPair(f, style), comment = p.ticket.comments[0]!;
    if (variant === "author") comment.author = "requirements/analyst";
    if (variant === "ticket") comment.content = comment.content.replaceAll("PAP-1", "PAP-2");
    if (variant === "source") comment.content = comment.content.replaceAll(p.source, p.source.replace("task.md", "other.md"));
    if (variant === "revision") comment.content = comment.content.replaceAll("r001", "r002");
    if (variant === "hash") comment.content = comment.content.replace(p.hash, "a".repeat(64));
    if (variant === "repo") comment.content = comment.content.replace("Key: fixture", "Key: other").replace("canonical fixture root", "canonical other root").replace("Key fixture", "Key other");
    if (variant === "root") comment.content = comment.content.replace(f.repo, f.worktree);
    if (variant === "handoff") comment.content = comment.content.replaceAll("fresh", "amendment");
    if (variant === "branch") comment.content = comment.content.replaceAll(f.branch, "feature/PAP-1-other");
    if (variant === "base") comment.content = comment.content.replace(f.base, "f".repeat(40));
    if (variant === "duplicate-comment") p.ticket.comments.push({ ...comment });
    if (variant === "duplicate-source") p.ticket.doc_refs.push({ ...p.ticket.doc_refs[0]! });
    if (variant === "duplicate-matrix") comment.content += ` Matrix Source: ${p.source}.`;
    if (variant === "duplicate-tuple") comment.content += " Repository Key: other.";
    if (variant === "malformed-tuple") comment.content += " Repository Key: .";
    if (variant === "duplicate-preview") comment.content += ` Reviewed requirements: ${p.previewPath}, raw SHA-256 ${p.hash}.`;
    if (variant === "wrong-preview-revision" || variant === "wrong-preview-tuple" || variant === "opposite-preview-base") {
      const preview = variant === "wrong-preview-revision" ? p.preview.replace("Review Revision: r001", "Review Revision: r002")
        : variant === "wrong-preview-tuple" ? p.preview.replace("Key: fixture", "Key: other")
        : p.preview.replace("> Approved Base SHA:", `> Retained Base SHA: ${f.base}\n> Approved Base SHA:`);
      writeFileSync(p.previewAbsolute, preview); comment.content = comment.content.replace(p.hash, createHash("sha256").update(preview).digest("hex"));
    }
    if (variant === "preview-alias") { rmSync(p.previewAbsolute); symlinkSync(f.sourcePath, p.previewAbsolute); }
    if (variant === "directory-alias") {
      const dir = join(f.ai, "agent-teams/requirements/artifacts/reviews/PAP-1/r001"), other = join(f.root, "other");
      mkdirSync(other); writeFileSync(join(other, "requirements.md"), p.preview); rmSync(dir, { recursive: true }); symlinkSync(other, dir);
    }
    if (variant === "oversized") writeFileSync(p.previewAbsolute, "x".repeat(1_048_577));
    if (variant === "malformed-utf8") {
      const bytes = Buffer.from([0xc3, 0x28]); writeFileSync(p.previewAbsolute, bytes);
      comment.content = comment.content.replace(p.hash, createHash("sha256").update(bytes).digest("hex"));
    }
    if (variant === "unknown") comment.content = "We discussed approval. " + comment.content;
    if (variant === "negated") comment.content += " I do not approve this pair.";
    if (variant === "rejected") comment.content += " Rejected.";
    if (variant === "revoked") comment.content += " Approval revoked.";
    if (variant === "conditional") comment.content += " Only if another review passes.";
    if (variant === "partial") comment.content += " I approve only part of this pair.";
    if (variant === "ambiguous") comment.content += " Approve exact r002 pair instead.";
    if (variant.startsWith("withdrawal") || variant === "uncertain-withdrawal") p.ticket.comments.push({ id: "c-20261027000000001", author: "sinh", content: variant === "withdrawal-id" ? `I revoke approval ${comment.id}.` : variant === "withdrawal-source" ? `Withdraw ${p.source} revision r001.` : "I withdraw this approval." });
    if (variant === "conflicting-header") writeFileSync(f.sourcePath, p.current.replace("> Review Revision:", "> Review Revision: r002\n> Review Revision:"));
    if (variant === "malformed-tab-clause") comment.content += " Repository Key:\tother.";
    if (variant === "negative-permission") comment.content += " I am not granting permission.";
    if (variant === "discussion-only") comment.content += " This is discussion only.";
    if (variant === "bad-header-hash" || variant === "malformed-header-hash") writeFileSync(f.sourcePath, p.current.replace("> Status:", `> Review Source SHA-256: ${variant === "bad-header-hash" ? "a".repeat(64) : "malformed"}\n> Status:`));
    if (variant === "malformed-source-utf8") writeFileSync(f.sourcePath, Buffer.from([0xc3, 0x28]));
    if (variant === "oversized-source") writeFileSync(f.sourcePath, "x".repeat(1_048_577));
    writeFileSync(f.ticketPath, JSON.stringify(p.ticket));
    const before = f.inventory(), sourceBefore = readFileSync(f.sourcePath); let gitCalls = 0;
    assert.throws(() => resolveOrdinaryTaskBaseline({ ...f.options, runGit: () => { gitCalls++; throw new Error("must not reach Git"); } }), /ORDINARY_BASELINE_/);
    assert.equal(gitCalls, 0); assert.deepEqual(f.inventory(), before); assert.deepEqual(readFileSync(f.sourcePath), sourceBefore);
  }));
}

for (const change of ["retained base", "materialized/reuse"]) test(`PAP-269 compact producer rejects conflicting ${change}`, () => fixture((f) => {
  const p = retainedPair(f, "ttl012"); p.ticket.comments[0]!.content = p.ticket.comments[0]!.content.replace(change === "retained base" ? "approved base" : "planned/create", change);
  writeFileSync(f.ticketPath, JSON.stringify(p.ticket)); assert.throws(f.resolve, /ORDINARY_BASELINE_APPROVAL_REJECTED/);
}));

test("PAP-269 simple producer without from and unrelated discussion remain supported", () => fixture((f) => {
  f.ticket.comments[0]!.content = f.ticket.comments[0]!.content.replace("from exact", "exact");
  f.ticket.comments.push({ id: "c-20261027000000001", author: "sinh", content: "Discuss revocation policy for a different ticket; no decision here." });
  writeFileSync(f.ticketPath, JSON.stringify(f.ticket)); assert.equal(f.resolve().baseSha, f.base);
}));

test("PAP-269 diagnostics distinguish unsupported format, invalid evidence and changed base without leaking bodies", () => fixture((f) => {
  const p = retainedPair(f, "waw");
  for (const [content, expected] of [["SECRET-BODY-TOKEN", "APPROVAL_REJECTED_UNSUPPORTED_PRODUCER"], [p.ticket.comments[0]!.content + " Rejected SECRET-BODY-TOKEN.", "APPROVAL_REJECTED_INVALID_EVIDENCE"]]) {
    p.ticket.comments[0]!.content = content!; writeFileSync(f.ticketPath, JSON.stringify(p.ticket));
    assert.throws(f.resolve, (error: Error) => { assert.match(error.message, new RegExp(expected!));
      assert.ok(error.message.length <= 2000); for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.ok(error.message.includes(label + ":"));
      assert.doesNotMatch(error.message, /SECRET-BODY-TOKEN/); return true; });
  }
  retainedPair(f, "waw"); writeFileSync(join(f.repo, "README.md"), "B\n"); f.git(["commit", "-am", "advance integration"]);
  assert.throws(f.resolve, /ORDINARY_BASELINE_CONFIG_MISMATCH/);
}));

test("PAP-269 exact materialized base survives integration advance; comment drift remains rejected", () => fixture((f) => {
  retainedPair(f, "ttl014"); f.materialize();
  writeFileSync(join(f.repo, "README.md"), "B\n"); f.git(["commit", "-am", "advance integration"]);
  const intendedTaskBaseline = f.resolve(); assert.equal(intendedTaskBaseline.baseSha, f.base);
  const ticket = JSON.parse(readFileSync(f.ticketPath, "utf8")); ticket.comments[0].content += " Descriptive scope note."; writeFileSync(f.ticketPath, JSON.stringify(ticket));
  const before = f.inventory();
  assert.throws(() => materializeTicketBranch({ ...f.options, worktreeRoot: f.worktree, intendedTaskBaseline }), /ORDINARY_BASELINE_CHANGED/);
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
