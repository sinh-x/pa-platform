import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getRepoHealthDb, getRepoHealthDbPath, getRepoHealthDir, insertRepoHealthReport, getLatestRepoHealthReport, getLatestRepoHealthReportWithBranches, listRepoHealthReports, rowToRepoHealthReport } from "../index.js";
import type { BranchInsert, ReportInsert } from "../index.js";

test("repo-health db stores reports and branch details", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repo-health-"));
  const dbPath = join(root, "repo-health.db");
  try {
    const report: ReportInsert = {
      repo_key: "pa-platform",
      repo_path: "/repo/pa-platform",
      generated_at: "2026-04-26T00:00:00.000Z",
      git_head: "abc123",
      last_report_at: null,
      total_branches: 3,
      merged_branches: 1,
      stale_branches: 1,
      active_branches: 1,
      branches_deleted: 0,
      remote_refs_pruned: 0,
      commits_since_last: 5,
      first_commit_date: "2026-04-25T00:00:00.000Z",
      last_commit_date: "2026-04-26T00:00:00.000Z",
      top_authors: JSON.stringify([{ name: "Sinh", count: 5 }]),
      tickets_done_count: 2,
      tickets_done_ids: JSON.stringify(["PAP-001", "PAP-002"]),
      tickets_active: 4,
      tickets_by_status: JSON.stringify({ implementing: 1, idea: 3 }),
      health_score: 87,
      health_notes: JSON.stringify(["healthy"]),
    };
    const branches: BranchInsert[] = [
      { report_id: 0, branch_name: "main", status: "active", last_commit_date: "2026-04-26T00:00:00.000Z", days_since_commit: 0, action: "kept" },
      { report_id: 0, branch_name: "old", status: "stale", last_commit_date: "2026-03-01T00:00:00.000Z", days_since_commit: 56, action: "dry-run" },
    ];
    const id = insertRepoHealthReport(report, branches, dbPath);
    assert.equal(id, 1);
    const latest = getLatestRepoHealthReport("pa-platform", dbPath);
    assert.equal(latest?.health_score, 87);
    const hydrated = rowToRepoHealthReport(latest!);
    assert.equal(hydrated.repoKey, "pa-platform");
    assert.deepEqual(hydrated.ticketStats.doneSinceLastReport, ["PAP-001", "PAP-002"]);
    assert.deepEqual(hydrated.commitStats.topAuthors, [{ name: "Sinh", count: 5 }]);
    const withBranches = getLatestRepoHealthReportWithBranches("pa-platform", dbPath);
    assert.equal(withBranches.branches.length, 2);
    assert.equal(withBranches.branches[1]?.branch_name, "old");
    assert.equal(listRepoHealthReports("pa-platform", 5, dbPath).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-health paths use the shared knowledge-base root", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repo-health-paths-"));
  const previous = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_AI_USAGE_HOME"] = root;
  try {
    assert.equal(getRepoHealthDir(), join(root, "knowledge-base", "repo-health"));
    assert.equal(getRepoHealthDbPath(), join(root, "knowledge-base", "repo-health.db"));
    const db = getRepoHealthDb(getRepoHealthDbPath());
    db.close();
    assert.equal(existsSync(join(root, "knowledge-base")), true);
  } finally {
    if (previous === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
