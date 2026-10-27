#!/usr/bin/env node
/** No live PA reads/writes, materialization, launcher, provider or network calls.
 * Imports exactly one operator-selected consumer and calls its exported resolver
 * with disposable config/artifacts/Git and a read-only ticket-store port. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.length !== 4 || process.argv[2] !== "--module") {
  console.error("Usage: node scripts/dev/verify_ordinary_approval_compatibility.mjs --module EXACT_MODULE_PATH");
  process.exit(2);
}
const modulePath = realpathSync(resolve(process.argv[3]));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const moduleSha256 = digest(readFileSync(modulePath));
const originalEnvironment = process.env;
const root = mkdtempSync(join(tmpdir(), "pap269-built-consumer-"));
const results = [];
try {
  process.env = { ...originalEnvironment };
  for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
  const repo = join(root, "repo"), ai = join(root, "ai"), config = join(root, "config");
  mkdirSync(repo); mkdirSync(config); mkdirSync(join(ai, "tickets"), { recursive: true });
  Object.assign(process.env, { PA_AI_USAGE_HOME: ai, PA_PLATFORM_CONFIG: config, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "develop"]); git(["config", "user.name", "Disposable"]); git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]); git(["config", "core.hooksPath", "/dev/null"]);
  writeFileSync(join(repo, "README.md"), "Disposable PAP-269 fixture\n"); git(["add", "README.md"]); git(["commit", "-qm", "fixture base"]);
  const base = git(["rev-parse", "HEAD"]), branch = "feature/PAP-1-local", ticketId = "PAP-1", revision = "r001", id = "c-20261026000000000";
  writeFileSync(join(config, "config.yaml"), `repos:\n  fixture:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n`);
  const { resolveOrdinaryTaskBaseline } = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof resolveOrdinaryTaskBaseline, "function");
  const path = "agent-teams/requirements/artifacts/task.md", ref = `requirements:${path}`;
  const previewPath = `agent-teams/requirements/artifacts/reviews/${ticketId}/${revision}/requirements.md`;
  mkdirSync(dirname(join(ai, previewPath)), { recursive: true });
  const markdown = `# Disposable\n\n> Status: Approved — plan only\n> Ticket: ${ticketId}\n> Repository Key: fixture\n> Repository Root: ${repo}\n> Handoff Type: fresh\n> Approved Base SHA: ${base}\n> Feature Branch: ${branch}\n> Review Revision: ${revision}\n> Review Approval Evidence: ${ticketId}#${id}\n\n## Work\nDisposable only.\n`;
  const preview = markdown.replace("Approved — plan only", "Draft — UNAPPROVED"), hash = digest(preview);
  const tuple = `Repository Key: fixture. Repository Root: ${repo}. Handoff Type: fresh. Feature Branch: ${branch}. Approved Base SHA: ${base}.`;
  const previewClause = `Reviewed requirements source: ${previewPath}, raw SHA-256 ${hash}. Matrix Source: ${ref}.`;
  const producers = {
    simple: `Approve ${ticketId} fixture ${repo} ${branch} exact base ${base}; source ${ref}.`,
    "simple-from": `Approve ${ticketId} fixture ${repo} ${branch} from exact base ${base}; source ${ref}.`,
    standard: `Explicit standalone foreground PA sign-off in d-123abc: I selected Approve exact pair and matrix for ${ticketId} ${revision}. ${previewClause} ${tuple} Approved intent: local scope; not UAT or rollout.`,
    owner: `Explicit foreground PA sign-off in d-123abc: I selected "Approve this exact pair" for owner-directed ${ticketId} ${revision}. ${previewClause} ${tuple} Approved intent: local scope; not UAT or rollout.`,
    "legacy-standard": `Explicit standalone foreground PA sign-off in d-9b82df: I selected Approve exact pair and matrix for ${ticketId} ${revision}. ${previewClause} Approved intent: scoped local workflow. Handoff: builder/orchestrator; canonical fixture at ${repo}; fresh planned/create; ${branch} from exact base ${base}; exact verified planned link retained. Approve the exact eleven-command matrix and all eight paired UAT scenarios as plans, not results. Permit only administrative approval/status/hash/link metadata insertion and unchanged paired publication after final 13 checks; no material requirement/matrix/UAT change. This does not launch implementation/review, authenticate custody, approve UAT success, install or activate policy. Recorded by the analyst from my explicit standalone foreground decision.`,
    waw: `Explicit PA sign-off from interactive deployment d-123abc: Approve ${revision} pair and exact matrix. I approve the complete ${ticketId} requirements revision ${revision} and companion UAT, local scope. Reviewed requirements: ${previewPath}, raw SHA-256 ${hash}. ${tuple} Matrix Source: ${ref}. I approve that exact 10-command matrix and requirements/UAT pair for promotion after final Shape-Conformance 13/13. This is not implementation authorization, AWS access/apply/rollout/backfill/Billing authorization, paired-runtime readiness, or successful UAT.`,
    ttl012: `APPROVED in standalone PA sign-off, deployment d-123abc: complete requirements/UAT pair ${revision}. Requirements source ${ref} reviewed as reviews/${ticketId}/${revision}/requirements.md raw SHA-256 ${hash}. Intent: local scope. Handoff fresh, canonical fixture root ${repo}, approved base ${base}, exact branch ${branch}, planned/create. Matrix Source: ${ref}. Approve this exact four-command matrix and pair, permitting only administrative approval/status/link metadata changes for final promotion. Device tests, candidate CI, human UAT and authenticated runtime/preparation readiness remain separate gates no implementation spawn authorized.`,
    ttl014: `Final standalone PA sign-off in d-123abc. Sinh selected Approve exact ${revision} pair and matrix after complete whole-document Markdown requirements and sixteen-scenario UAT review was offered. Approved intent: local scope. Requirements Source and Matrix Source ${ref}. Reviewed revision ${revision} requirements raw SHA-256 ${hash}. Repository Key fixture Repository Root ${repo} Ticket ${ticketId} Route builder/orchestrator Handoff Type fresh Feature Branch ${branch} Approved Base SHA ${base} Linked Branch State planned Branch Action create. No source implementation, live service/network/certificate/phone effect, matrix execution, review/builder spawn, merge or checkout return is authorized. Plan approval is not executed UAT or application acceptance.`,
  };
  const variants = {
    valid: () => {},
    author: (t) => { t.comments[0].author = "requirements/analyst"; },
    ticket: (t) => { t.comments[0].content = t.comments[0].content.replaceAll(ticketId, "PAP-2"); },
    source: (t) => { t.comments[0].content = t.comments[0].content.replaceAll(ref, ref.replace("task.md", "other.md")); },
    base: (t) => { t.comments[0].content = t.comments[0].content.replaceAll(base, "f".repeat(40)); },
    root: (t) => { t.comments[0].content = t.comments[0].content.replaceAll(repo, repo + "-other"); },
    branch: (t) => { t.comments[0].content = t.comments[0].content.replaceAll(branch, branch + "-other"); },
    "duplicate-comment": (t) => { t.comments.push({ ...t.comments[0] }); },
    "duplicate-source": (t) => { t.doc_refs.push({ ...t.doc_refs[0] }); },
    unknown: (t) => { t.comments[0].content = "Discussed only. " + t.comments[0].content; },
    negated: (t) => { t.comments[0].content += " I do not approve this pair."; },
    conditional: (t) => { t.comments[0].content += " Only if further review passes."; },
    rejected: (t) => { t.comments[0].content += " Rejected."; },
    revoked: (t) => { t.comments[0].content += " Revoked."; },
    withdrawal: (t) => { t.comments.push({ id: "c-20261027000000001", author: "sinh", content: `I revoke approval ${id}.` }); },
  };
  for (const [producer, content] of Object.entries(producers)) {
    const cases = { ...variants };
    if (!producer.startsWith("simple")) Object.assign(cases, {
      revision: (t) => { t.comments[0].content = t.comments[0].content.replaceAll(revision, "r002"); },
      hash: (t) => { t.comments[0].content = t.comments[0].content.replace(hash, "a".repeat(64)); },
      "duplicate-matrix": (t) => { t.comments[0].content += ` Matrix Source: ${ref}.`; },
      "unsafe-locator": (t) => { t.comments[0].content = t.comments[0].content.replace(`reviews/${ticketId}`, `reviews/../${ticketId}`); if (producer === "ttl014") t.comments[0].content += ` Reviewed requirements: ../requirements.md, raw SHA-256 ${hash}.`; },
    });
    for (const [variant, mutate] of Object.entries(cases)) {
      const ticket = { id: ticketId, project: "fixture", linkedBranches: [{ repo: "fixture", branch, state: "planned" }], doc_refs: [{ type: "requirements", path, primary: true }], comments: [{ id, author: "sinh", content }] };
      writeFileSync(join(ai, path), markdown); writeFileSync(join(ai, previewPath), preview); mutate(ticket);
      const ticketPath = join(ai, "tickets", `${ticketId}.json`); writeFileSync(ticketPath, JSON.stringify(ticket));
      const before = [readFileSync(join(ai, path)), readFileSync(join(ai, previewPath)), readFileSync(ticketPath), git(["show-ref"]), git(["status", "--porcelain=v2", "--untracked-files=all"])];
      let gitCalls = 0, error;
      try {
        const result = resolveOrdinaryTaskBaseline({ canonicalRepoKey: "fixture", canonicalRepoRoot: repo, ticketId,
          ticketStore: { get: () => JSON.parse(readFileSync(ticketPath, "utf8")) },
          runGit: (args) => { gitCalls++; return git([...args]); } });
        assert.equal(variant, "valid", "invalid evidence accepted");
        assert.equal(result.baseSha, base); assert.equal(result.requirements.ref, ref); assert.equal(result.requirements.sha256, digest(markdown));
        assert.equal(result.approval.commentId, id); assert.equal(result.approval.sha256, digest(JSON.stringify(ticket.comments[0])));
      } catch (caught) { error = caught; }
      let passed = variant === "valid" ? !error : !!error && /ORDINARY_BASELINE_/.test(error.message) && gitCalls === 0;
      try {
        assert.deepEqual([readFileSync(join(ai, path)), readFileSync(join(ai, previewPath)), readFileSync(ticketPath), git(["show-ref"]), git(["status", "--porcelain=v2", "--untracked-files=all"])], before);
      } catch { passed = false; }
      results.push({ producer, variant, passed, gitCalls, ...(passed ? {} : { condition: error?.message.match(/ORDINARY_BASELINE_[A-Z_]+/)?.[0] ?? "unexpected-result" }) });
    }
  }
  assert.equal(digest(readFileSync(modulePath)), moduleSha256, "module changed during qualification");
} finally {
  process.env = originalEnvironment; rmSync(root, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.passed);
console.log(JSON.stringify({ modulePath, moduleSha256, fidelity: "disposable resolver only; no materialization/launch/installed-selection or human UAT claim", cases: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length) process.exitCode = 1;
