import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
const modePath = configRoot ? join(configRoot, "teams", "builder", "modes", "orchestrator.md") : "";
const implementPath = configRoot ? join(configRoot, "teams", "builder", "modes", "implement.md") : "";
const routinePath = configRoot ? join(configRoot, "teams", "builder", "modes", "routine.md") : "";
const objectivePath = configRoot ? join(configRoot, "skills", "templates", "builder-objective.md") : "";
const reportPath = configRoot ? join(configRoot, "skills", "templates", "orchestration-report.md") : "";

test("builder orchestrator contract creates isolated deterministic worktrees", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const mode = readFileSync(modePath, "utf-8").replace(/\s+/g, " ");

  assert.match(mode, /worktree_path = \/tmp\/pa-worktrees\/<repo-key>\/<ticket-id>\/<orchestrator-deployment-id>/);
  assert.match(mode, /execution_path = worktree_path when strategy=worktree, otherwise canonical_repo/);
  assert.match(mode, /Persist execution_path in the orchestration report and reuse this exact value/);
  assert.match(mode, /git -C <canonical_repo> worktree add -b <feature_branch>/);
  assert.match(mode, /without changing the canonical\s+checkout/);
  assert.match(mode, /Canonical strategy gate:.*exclusive lock/);
  assert.match(mode, /Collision rejection must not create/);
  assert.match(mode, /canonical-checkout mutation/);
  assert.match(mode, /Reject a live orchestrator for the same ticket/);
});

test("builder orchestrator contract validates resume evidence before recreation", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const mode = readFileSync(modePath, "utf-8").replace(/\s+/g, " ");

  assert.match(mode, /If the worktree exists, verify its git common-dir and branch/);
  assert.match(mode, /recreate the exact recorded path only when the ownership evidence matches/);
  assert.match(mode, /Missing, stale, ambiguous, or branch-mismatched evidence stops for operator review/);
  assert.match(mode, /same normalized repository plus branch or worktree path/);
});

test("builder objective and report retain complete worktree ownership evidence", (t) => {
  if (!existsSync(objectivePath) || !existsSync(reportPath)) return t.skip("external pa-platform-config fixture not available");
  const objective = readFileSync(objectivePath, "utf-8");
  const report = readFileSync(reportPath, "utf-8");
  const fields = ["Canonical Repository", "Normalized Remote", "Worktree", "Branch", "Owner Deployment", "Lifecycle Status", "Cleanup Result"];

  for (const field of fields) {
    assert.match(objective, new RegExp(field));
    assert.match(report, new RegExp(field));
  }
  assert.match(report, /Ticket: <ticket_id>/);
  assert.match(report, /Canonical checkout before\/after/);
  assert.match(report, /Collision checks/);
});

test("all implementation child launches pass the recorded worktree", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const mode = readFileSync(modePath, "utf-8");
  const normalized = mode.replace(/\s+/g, " ");
  const launches = normalized.match(/opa deploy (?:builder --mode implement|requirements --mode review-auto) .*?(?= opa status| Locate the review report)/g) ?? [];
  assert.ok(launches.length >= 3, "expected implementation, review, and fix launch contracts");
  for (const launch of launches) assert.match(launch, /--repo "<execution_path>"/);
  assert.match(mode, /Review the changes[\s\S]*?Repo: <execution_path>[\s\S]*?Canonical Repository: <canonical_repo_path>[\s\S]*?Worktree: <execution_path>[\s\S]*?Branch: <feature_branch>/);
  assert.match(mode, /- `Context`: include `Repo: <execution_path>[\s\S]*?Canonical Repository:[\s\S]*?Worktree: <execution_path>[\s\S]*?Branch: <feature_branch>/);
  assert.match(mode, /If the fix child fails transiently and is retried[\s\S]*?same objective file contents[\s\S]*?canonical path/);
});

test("canonical and worktree execution rules are strategy-aware", (t) => {
  if (!existsSync(modePath) || !existsSync(implementPath)) return t.skip("external pa-platform-config fixture not available");
  const orchestrator = readFileSync(modePath, "utf-8");
  const implement = readFileSync(implementPath, "utf-8");

  assert.match(implement, /In `worktree` mode, never read or write project files through the canonical checkout/);
  assert.match(implement, /In `canonical` mode, the lock-protected canonical feature checkout is the recorded execution path and is permitted/);
  assert.doesNotMatch(implement, /Never work directly on the canonical repository/);
  assert.match(orchestrator, /Push from the recorded execution path selected by the strategy/);
  assert.match(orchestrator, /lock-protected canonical feature checkout in\s+# canonical mode/);
  assert.match(orchestrator, /cd <execution_path>\s+git push -u origin <feature-branch>/);
});

test("routine merge contract validates reports and merged PR ancestry before closure", (t) => {
  if (!existsSync(routinePath)) return t.skip("external pa-platform-config fixture not available");
  const routine = readFileSync(routinePath, "utf-8");

  assert.match(routine, /--json number,state,headRefName,baseRefName,/);
  assert.match(routine, /gh pr view <number>[\s\S]*?--json mergeCommit --jq '\.mergeCommit\.oid \/\/ empty'/);
  assert.match(routine, /\[\[ ! "\$merge_commit" =~ \^\[0-9a-fA-F\]\{40\}\$ \]\]/);
  assert.match(routine, /git -C "\$canonical_repo" merge-base --is-ancestor "\$merge_commit" "origin\/\$target_branch"/);
  assert.match(routine, /persist_merge_evidence <TICKET-ID> "\$merge_evidence" \|\| continue/);
  assert.ok((routine.match(/persist_merge_evidence <TICKET-ID> "\$merge_evidence" \|\| continue/g) ?? []).length >= 4);
});

test("routine atomic local evidence fixture persists safely and failure leaves ticket open", (t) => {
  if (!existsSync(routinePath)) return t.skip("external pa-platform-config fixture not available");
  const routine = readFileSync(routinePath, "utf-8");
  const helpers = routine.match(/```bash\n(validated_primary_orchestration_report\(\)[\s\S]*?)\n\ncleanup_worktree_if_eligible\(\)/)?.[1];
  assert.ok(helpers, "routine validator and evidence helpers must be executable shell");

  const root = mkdtempSync(join(tmpdir(), "pa-routine-evidence-"));
  const home = join(root, "home");
  const artifacts = join(home, "Documents", "ai-usage", "agent-teams", "builder", "artifacts");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(bin);
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", "develop"], { cwd: repo, stdio: "ignore" });
  const mergeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();

  const report = join(artifacts, "report.md");
  const missingEvidence = join(artifacts, "missing-evidence.md");
  const invalidRepo = join(artifacts, "invalid-repo.md");
  const linkedReport = join(artifacts, "linked-report.md");
  writeFileSync(report, `Canonical Repository: ${repo}\nMerge Evidence: pending\n`);
  writeFileSync(missingEvidence, `Canonical Repository: ${repo}\n`);
  writeFileSync(invalidRepo, "Canonical Repository: /does/not/exist\nMerge Evidence: pending\n");
  symlinkSync(report, linkedReport);
  const opa = join(bin, "opa");
  writeFileSync(opa, "#!/usr/bin/env bash\nprintf '{\"doc_refs\":[{\"type\":\"orchestration\",\"primary\":true,\"path\":\"%s\"}]}\\n' \"$OPA_REPORT\"\n");
  chmodSync(opa, 0o755);
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/usr/bin/env bash\nprintf '%s\\n' \"$OPA_MERGE_SHA\"\n");
  chmodSync(gh, 0o755);

  const sha = "0123456789abcdef0123456789abcdef01234567";
  const evidence = `local:develop/${sha};ancestor=true;remote=${sha};verified=true`;
  const fixture = `set -euo pipefail
${helpers}
report_path=$(validated_primary_orchestration_report PAP-135)
[ "$report_path" = "$OPA_EXPECTED_REPORT" ]
[ "$(validated_report_field "$report_path" "Canonical Repository")" = "$OPA_EXPECTED_REPO" ]
merge_commit=$(gh pr view 13 --repo fixture/repo --json mergeCommit --jq '.mergeCommit.oid // empty')
[[ "$merge_commit" =~ ^[0-9a-fA-F]{40}$ ]]
git -C "$OPA_EXPECTED_REPO" fetch origin develop
git -C "$OPA_EXPECTED_REPO" merge-base --is-ancestor "$merge_commit" origin/develop
OPA_MERGE_SHA=0000000000000000000000000000000000000000; export OPA_MERGE_SHA
invalid_merge=$(gh pr view 13 --repo fixture/repo --json mergeCommit --jq '.mergeCommit.oid // empty')
! git -C "$OPA_EXPECTED_REPO" merge-base --is-ancestor "$invalid_merge" origin/develop
persist_merge_evidence PAP-135 "$OPA_EVIDENCE"
[ "$(awk -F': ' '/^Merge Evidence: / {print $2}' "$report_path")" = "$OPA_EVIDENCE" ]
OPA_REPORT="$OPA_LINKED_REPORT"; export OPA_REPORT
! validated_primary_orchestration_report PAP-135
OPA_REPORT="$OPA_INVALID_REPO"; export OPA_REPORT
invalid_path=$(validated_primary_orchestration_report PAP-135)
! validated_report_field "$invalid_path" "Canonical Repository"
OPA_REPORT="$OPA_MISSING_EVIDENCE"; export OPA_REPORT
ticket_status=open
for ticket in PAP-135; do
  persist_merge_evidence "$ticket" "$OPA_EVIDENCE" || continue
  ticket_status=done
done
[ "$ticket_status" = open ]
`;

  try {
    execFileSync("bash", ["-c", fixture], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        OPA_REPORT: report,
        OPA_EXPECTED_REPORT: report,
        OPA_EXPECTED_REPO: repo,
        OPA_EVIDENCE: evidence,
        OPA_LINKED_REPORT: linkedReport,
        OPA_INVALID_REPO: invalidRepo,
        OPA_MISSING_EVIDENCE: missingEvidence,
        OPA_MERGE_SHA: mergeSha,
      },
      stdio: "pipe",
    });
    assert.match(readFileSync(report, "utf-8"), new RegExp(`Merge Evidence: ${evidence.replaceAll("/", "\\/")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
