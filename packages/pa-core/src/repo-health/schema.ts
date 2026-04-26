export interface RepoHealthReport {
  schemaVersion: 1;
  repoKey: string;
  repoPath: string;
  generatedAt: string;
  gitHead: string | null;
  lastReportAt: string | null;
  branchStats: BranchStats;
  commitStats: CommitStats;
  ticketStats: TicketStats;
  staleBranches: StaleBranch[];
  mergedBranches: MergedBranch[];
  healthScore: number;
  healthNotes: string[];
}

export interface BranchStats {
  total: number;
  merged: number;
  stale: number;
  active: number;
  deleted: number;
  remoteRefsPruned: number;
}

export interface CommitStats {
  sinceLastReport: number;
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  topAuthors: AuthorCount[];
}

export interface AuthorCount {
  name: string;
  count: number;
}

export interface TicketStats {
  doneSinceLastReport: string[];
  doneCount: number;
  activeCount: number;
  byStatus: Record<string, number>;
}

export interface StaleBranch {
  name: string;
  lastCommitDate: string;
  daysSinceCommit: number;
}

export interface MergedBranch {
  name: string;
  action: "deleted" | "pruned" | "dry-run";
}

export interface RepoHealthReportRow {
  id?: number;
  repo_key: string;
  repo_path: string;
  generated_at: string;
  git_head: string | null;
  last_report_at: string | null;
  total_branches: number;
  merged_branches: number;
  stale_branches: number;
  active_branches: number;
  branches_deleted: number;
  remote_refs_pruned: number;
  commits_since_last: number;
  first_commit_date: string | null;
  last_commit_date: string | null;
  top_authors: string;
  tickets_done_count: number;
  tickets_done_ids: string;
  tickets_active: number;
  tickets_by_status: string;
  health_score: number;
  health_notes: string;
}

export interface RepoHealthBranchRow {
  id?: number;
  report_id: number;
  branch_name: string;
  status: "merged" | "active" | "stale";
  last_commit_date: string | null;
  days_since_commit: number | null;
  action: "deleted" | "pruned" | "kept" | "dry-run" | null;
}

export type ReportInsert = Omit<RepoHealthReportRow, "id">;
export type BranchInsert = Omit<RepoHealthBranchRow, "id">;
