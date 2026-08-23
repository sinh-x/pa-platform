import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import yaml from "js-yaml";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

test("phase 5: two ticket worktrees leave the canonical checkout unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-phase5-worktrees-"));
  const canonical = join(root, "canonical");
  const worktreeRoot = join(root, "worktrees");
  execFileSync("git", ["init", "-q", "-b", "develop", canonical]);
  git(canonical, "config", "user.email", "phase5@example.test");
  git(canonical, "config", "user.name", "Phase 5 Test");
  writeFileSync(join(canonical, "README.md"), "fixture\n");
  git(canonical, "add", "README.md");
  git(canonical, "commit", "-qm", "fixture");
  writeFileSync(join(canonical, "canonical-untracked.txt"), "preserve\n");

  const before = {
    branch: git(canonical, "branch", "--show-current"),
    staged: git(canonical, "diff", "--staged"),
    unstaged: git(canonical, "diff"),
    untracked: git(canonical, "status", "--porcelain", "--untracked-files=all"),
  };
  const first = join(worktreeRoot, "pa-platform", "PAP-101", "d-first");
  const second = join(worktreeRoot, "pa-platform", "PAP-102", "d-second");
  try {
    git(canonical, "worktree", "add", "-b", "feature/PAP-101-isolated", first, "develop");
    git(canonical, "worktree", "add", "-b", "feature/PAP-102-isolated", second, "develop");

    assert.equal(git(first, "branch", "--show-current"), "feature/PAP-101-isolated");
    assert.equal(git(second, "branch", "--show-current"), "feature/PAP-102-isolated");
    assert.notEqual(first, second);
    assert.match(git(canonical, "worktree", "list", "--porcelain"), /feature\/PAP-101-isolated/);
    assert.match(git(canonical, "worktree", "list", "--porcelain"), /feature\/PAP-102-isolated/);

    assert.deepEqual(before, {
      branch: git(canonical, "branch", "--show-current"),
      staged: git(canonical, "diff", "--staged"),
      unstaged: git(canonical, "diff"),
      untracked: git(canonical, "status", "--porcelain", "--untracked-files=all"),
    });
  } finally {
    git(canonical, "worktree", "remove", "--force", first);
    git(canonical, "worktree", "remove", "--force", second);
    git(canonical, "worktree", "prune");
    rmSync(root, { recursive: true, force: true });
  }
});

test("phase 5: config and builder contracts form one lifecycle", (t) => {
  const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
  if (!configRoot) return t.skip("PA_PHASE5_CONFIG_ROOT is not set");
  const configPath = join(configRoot, "config.yaml");
  const raw = yaml.load(readFileSync(configPath, "utf-8")) as { repos?: Record<string, { path?: string; prefix?: string; remote_url?: string }> };
  const repos = raw.repos ?? {};
  assert.ok(repos["pa-platform"]?.path);
  assert.ok(repos["pa-platform-config"]?.path);
  assert.equal(repos["pa-platform"]?.prefix, "PAP");
  assert.equal(repos["pa-platform-config"]?.prefix, "PAPC");
  assert.match(repos["pa-platform"]?.remote_url ?? "", /github\.com:sinh-x\/pa-platform\.git/);

  const mode = readFileSync(join(configRoot, "teams/builder/modes/orchestrator.md"), "utf-8");
  const routine = readFileSync(join(configRoot, "teams/builder/modes/routine.md"), "utf-8");
  const objective = readFileSync(join(configRoot, "skills/templates/builder-objective.md"), "utf-8");
  const report = readFileSync(join(configRoot, "skills/templates/orchestration-report.md"), "utf-8");
  for (const value of [mode, routine, objective, report]) {
    assert.match(value, /Canonical Repository/);
    assert.match(value, /Worktree/);
    assert.match(value, /Branch/);
  }
  assert.match(mode, /execution_path = worktree_path when strategy=worktree, otherwise canonical_repo/);
  assert.match(mode, /Persist execution_path in the orchestration report and reuse this exact value/);
  assert.match(mode, /opa deploy builder --mode implement[\s\S]*--repo "<execution_path>"/);
  assert.match(mode, /opa deploy requirements --mode review-auto[\s\S]*--repo "<execution_path>"/);
  assert.match(mode, /Canonical strategy gate:[\s\S]*exclusive lock/);
  assert.match(routine, /merge-confirmed path/);
  assert.match(report, /Cleanup Result/);
  assert.match(report, /Parent Ticket Status/);
  assert.match(report, /Collision checks/);
  assert.ok(existsSync(resolve(configRoot, "config.yaml")));
});

test("phase 5: routine cleanup stays fail-closed and idempotent", () => {
  const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
  if (!configRoot) return;
  const routine = readFileSync(join(configRoot, "teams/builder/modes/routine.md"), "utf-8");

  assert.match(routine, /merge-confirmed path that has just transitioned the\s+parent ticket to `done`/);
  assert.match(routine, /Do not call it for open, partial, failed, conflicted,\s+closed-without-merge, unmerged, blocked, or post-merge-CI-failure tickets/);
  assert.match(routine, /The orchestration doc-ref is the only accepted ownership source/);
  assert.match(routine, /require the deterministic ticket-owned path prefix/);
  assert.match(routine, /\[ "\$ticket_status" != "done" \]/);
  assert.match(routine, /\[ "\$canonical_worktree" != "\$recorded_worktree" \]/);
  assert.match(routine, /cleanup_result="already-absent"/);
  assert.match(routine, /retries converge on cleaned\/already-absent/);

  for (const fixture of [
    "merged/done GitHub",
    "merged/done local",
    "open ticket",
    "conflict/unmerged",
    "post-merge CI failure",
    "wrong owner",
    "path escape",
    "already absent",
    "retry after remove/prune failure",
  ]) {
    assert.match(routine, new RegExp(fixture.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
});
