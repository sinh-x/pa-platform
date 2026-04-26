import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { loadRepoEntry, listRepos } from "../../repos.js";

export function reposRoutes(): Hono {
  const app = new Hono();
  app.get("/api/repos/git-summary", (c) => c.json({ repos: listRepos().map((repo) => repoSummary(repo)) }));
  app.get("/api/repos/:key/git-info", (c) => {
    const repo = loadRepoEntry(c.req.param("key"));
    if (!repo) return c.json({ error: "Repo not found", code: "NOT_FOUND" }, 404);
    if (!existsSync(repo.path)) return c.json({ error: "Repo path does not exist", code: "NOT_FOUND" }, 404);
    const mainBranch = repo.mainBranch || "main";
    const developBranch = repo.developBranch === "none" ? null : repo.developBranch || "develop";
    return c.json({ key: repo.name, path: repo.path, main: branchInfo(mainBranch, repo.path), develop: developBranch ? branchInfo(developBranch, repo.path) : null, current_branch: gitRun(["branch", "--show-current"], repo.path), working_directory: workingDirStatus(repo.path) });
  });
  return app;
}

function repoSummary(repo: ReturnType<typeof listRepos>[number]): Record<string, unknown> {
  if (!existsSync(repo.path)) return { key: repo.name, path: repo.path, prefix: repo.prefix, current_branch: "", is_dirty: false, feature_branch_count: 0, develop_ahead_of_main: 0, error: "Repo path does not exist on disk" };
  return { key: repo.name, path: repo.path, prefix: repo.prefix, current_branch: gitRun(["branch", "--show-current"], repo.path), is_dirty: !workingDirStatus(repo.path).clean, feature_branch_count: 0, develop_ahead_of_main: 0 };
}

function gitRun(args: string[], cwd: string): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

function branchInfo(branch: string, cwd: string): Record<string, unknown> {
  const hash = gitRun(["rev-parse", "--verify", branch], cwd);
  if (!hash) return { name: branch, exists: false };
  const [fullHash, message, date] = gitRun(["log", "-1", "--format=%H%n%s%n%ci", branch], cwd).split("\n");
  return { name: branch, exists: true, latestCommit: fullHash ? { hash: fullHash, message, date } : undefined };
}

function workingDirStatus(cwd: string): { clean: boolean; uncommitted_count: number } {
  const status = gitRun(["status", "--porcelain"], cwd);
  const count = status ? status.split("\n").filter((line) => line.trim()).length : 0;
  return { clean: count === 0, uncommitted_count: count };
}
