import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getRepoHealthDbPath } from "../paths.js";
import type { BranchInsert, RepoHealthBranchRow, RepoHealthReport, RepoHealthReportRow, ReportInsert } from "./schema.js";

let singleton: Database.Database | null = null;

export function getRepoHealthDb(dbPath = getRepoHealthDbPath()): Database.Database {
  if (singleton && dbPath === getRepoHealthDbPath()) return singleton;
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  createRepoHealthTables(db);
  if (dbPath === getRepoHealthDbPath()) singleton = db;
  return db;
}

export function closeRepoHealthDb(): void {
  singleton?.close();
  singleton = null;
}

function createRepoHealthTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_key            TEXT    NOT NULL,
      repo_path           TEXT    NOT NULL,
      generated_at        TEXT    NOT NULL,
      git_head            TEXT,
      last_report_at      TEXT,
      total_branches      INTEGER DEFAULT 0,
      merged_branches     INTEGER DEFAULT 0,
      stale_branches      INTEGER DEFAULT 0,
      active_branches     INTEGER DEFAULT 0,
      branches_deleted    INTEGER DEFAULT 0,
      remote_refs_pruned  INTEGER DEFAULT 0,
      commits_since_last  INTEGER DEFAULT 0,
      first_commit_date   TEXT,
      last_commit_date    TEXT,
      top_authors         TEXT,
      tickets_done_count  INTEGER DEFAULT 0,
      tickets_done_ids    TEXT,
      tickets_active      INTEGER DEFAULT 0,
      tickets_by_status   TEXT,
      health_score        INTEGER DEFAULT 0,
      health_notes        TEXT
    );

    CREATE TABLE IF NOT EXISTS branches (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id           INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      branch_name         TEXT    NOT NULL,
      status              TEXT    NOT NULL,
      last_commit_date    TEXT,
      days_since_commit   INTEGER,
      action              TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reports_repo_key ON reports(repo_key);
    CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports(generated_at);
    CREATE INDEX IF NOT EXISTS idx_branches_report_id ON branches(report_id);
  `);
}

export function insertRepoHealthReport(report: ReportInsert, branches: BranchInsert[], dbPath?: string): number {
  const handle = openRepoHealthDb(dbPath);
  const insertReport = handle.db.prepare(`
    INSERT INTO reports (
      repo_key, repo_path, generated_at, git_head, last_report_at,
      total_branches, merged_branches, stale_branches, active_branches,
      branches_deleted, remote_refs_pruned,
      commits_since_last, first_commit_date, last_commit_date, top_authors,
      tickets_done_count, tickets_done_ids, tickets_active, tickets_by_status,
      health_score, health_notes
    ) VALUES (
      @repo_key, @repo_path, @generated_at, @git_head, @last_report_at,
      @total_branches, @merged_branches, @stale_branches, @active_branches,
      @branches_deleted, @remote_refs_pruned,
      @commits_since_last, @first_commit_date, @last_commit_date, @top_authors,
      @tickets_done_count, @tickets_done_ids, @tickets_active, @tickets_by_status,
      @health_score, @health_notes
    )
  `);
  const insertBranch = handle.db.prepare(`
    INSERT INTO branches (report_id, branch_name, status, last_commit_date, days_since_commit, action)
    VALUES (@report_id, @branch_name, @status, @last_commit_date, @days_since_commit, @action)
  `);

  const transaction = handle.db.transaction(() => {
    const reportId = insertReport.run(report).lastInsertRowid as number;
    for (const branch of branches) insertBranch.run({ ...branch, report_id: reportId });
    return reportId;
  });
  try {
    return transaction();
  } finally {
    handle.close();
  }
}

export function rowToRepoHealthReport(row: RepoHealthReportRow): RepoHealthReport {
  return {
    schemaVersion: 1,
    repoKey: row.repo_key,
    repoPath: row.repo_path,
    generatedAt: row.generated_at,
    gitHead: row.git_head,
    lastReportAt: row.last_report_at,
    branchStats: {
      total: row.total_branches,
      merged: row.merged_branches,
      stale: row.stale_branches,
      active: row.active_branches,
      deleted: row.branches_deleted,
      remoteRefsPruned: row.remote_refs_pruned,
    },
    commitStats: {
      sinceLastReport: row.commits_since_last,
      firstCommitDate: row.first_commit_date,
      lastCommitDate: row.last_commit_date,
      topAuthors: parseJson(row.top_authors, []),
    },
    ticketStats: {
      doneSinceLastReport: parseJson(row.tickets_done_ids, []),
      doneCount: row.tickets_done_count,
      activeCount: row.tickets_active,
      byStatus: parseJson(row.tickets_by_status, {}),
    },
    healthScore: row.health_score,
    healthNotes: parseJson(row.health_notes, []),
    staleBranches: [],
    mergedBranches: [],
  };
}

export function getLatestRepoHealthReport(repoKey: string, dbPath?: string): RepoHealthReportRow | null {
  const handle = openRepoHealthDb(dbPath);
  try {
    const row = handle.db.prepare("SELECT * FROM reports WHERE repo_key = ? ORDER BY generated_at DESC LIMIT 1").get(repoKey) as RepoHealthReportRow | undefined;
    return row ?? null;
  } finally {
    handle.close();
  }
}

export function getLatestRepoHealthReportWithBranches(repoKey: string, dbPath?: string): { report: RepoHealthReportRow | null; branches: RepoHealthBranchRow[] } {
  const handle = openRepoHealthDb(dbPath);
  try {
    const report = handle.db.prepare("SELECT * FROM reports WHERE repo_key = ? ORDER BY generated_at DESC LIMIT 1").get(repoKey) as RepoHealthReportRow | undefined;
    if (!report?.id) return { report: report ?? null, branches: [] };
    const branches = handle.db.prepare("SELECT * FROM branches WHERE report_id = ? ORDER BY id").all(report.id) as RepoHealthBranchRow[];
    return { report, branches };
  } finally {
    handle.close();
  }
}

export function listRepoHealthReports(repoKey: string, limit = 10, dbPath?: string): RepoHealthReportRow[] {
  const handle = openRepoHealthDb(dbPath);
  try {
    return handle.db.prepare("SELECT * FROM reports WHERE repo_key = ? ORDER BY generated_at DESC LIMIT ?").all(repoKey, limit) as RepoHealthReportRow[];
  } finally {
    handle.close();
  }
}

function openRepoHealthDb(dbPath: string | undefined): { db: Database.Database; close: () => void } {
  const db = getRepoHealthDb(dbPath);
  const isDefault = dbPath === undefined || dbPath === getRepoHealthDbPath();
  return { db, close: () => { if (!isDefault) db.close(); } };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
