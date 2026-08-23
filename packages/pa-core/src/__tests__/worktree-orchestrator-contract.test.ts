import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { getPlatformHomeDir } from "../index.js";

const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"] ?? getPlatformHomeDir();
const modePath = join(configRoot, "teams", "builder", "modes", "orchestrator.md");
const objectivePath = join(configRoot, "skills", "templates", "builder-objective.md");
const reportPath = join(configRoot, "skills", "templates", "orchestration-report.md");

test("builder orchestrator contract creates isolated deterministic worktrees", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const mode = readFileSync(modePath, "utf-8").replace(/\s+/g, " ");

  assert.match(mode, /worktree_path = \/tmp\/pa-worktrees\/<repo-key>\/<ticket-id>\/<orchestrator-deployment-id>/);
  assert.match(mode, /git -C <canonical_repo> worktree add -b <feature_branch>/);
  assert.match(mode, /without changing the canonical\s+checkout/);
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
  for (const launch of launches) assert.match(launch, /--repo "<worktree_path>"/);
  assert.match(mode, /Review the changes[\s\S]*?Repo: <worktree_path>[\s\S]*?Canonical Repository: <canonical_repo_path>[\s\S]*?Worktree: <worktree_path>[\s\S]*?Branch: <feature_branch>/);
  assert.match(mode, /- `Context`: include `Repo: <worktree_path>[\s\S]*?Canonical Repository:[\s\S]*?Worktree: <worktree_path>[\s\S]*?Branch: <feature_branch>/);
  assert.match(mode, /If the fix child fails transiently and is retried[\s\S]*?same objective file contents[\s\S]*?canonical path/);
});
