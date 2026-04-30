import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { loadRepoEntry, listRepos } from "../../repos.js";

interface BranchInfo {
  name: string;
  exists: boolean;
  latestCommit?: { hash: string; hash_short?: string; message: string; date: string };
}

interface FeatureBranch {
  name: string;
  latestCommit: { hash_short: string; message: string; date: string };
}

interface GitInfoErrors {
  main?: string;
  develop?: string;
  featureBranches?: string;
  workingDirectory?: string;
}

export function reposRoutes(): Hono {
  const app = new Hono();

  app.get("/api/repos/git-summary", (c) => {
    const repos = listRepos().map((repo) => {
      let error: string | undefined;
      let currentBranch = "";
      let isDirty = false;
      let featureBranchCount = 0;
      let developAheadOfMain = 0;
      try {
        if (!existsSync(repo.path)) error = "Repo path does not exist on disk";
        else if (!existsSync(join(repo.path, ".git"))) error = "Not a git repository";
        else {
          currentBranch = currentBranchName(repo.path);
          isDirty = !workingDirStatus(repo.path).clean;
          const mainBranch = repo.mainBranch || "main";
          const developBranch = repo.developBranch === "none" ? null : repo.developBranch || "develop";
          const features = developBranch ? unmergedBranches(developBranch, repo.path) : [];
          featureBranchCount = features.length;
          if (developBranch && branchExists(mainBranch, repo.path) && branchExists(developBranch, repo.path)) developAheadOfMain = aheadBehind(mainBranch, developBranch, repo.path).develop_ahead;
        }
      } catch (errorValue) {
        error = errorValue instanceof Error ? errorValue.message : "Unknown error";
      }
      return { key: repo.name, path: repo.path, prefix: repo.prefix, current_branch: currentBranch, is_dirty: isDirty, feature_branch_count: featureBranchCount, develop_ahead_of_main: developAheadOfMain, error };
    });
    return c.json({ repos });
  });

  app.get("/api/repos/:key/git-info", (c) => {
    const key = c.req.param("key");
    if (!key) return c.json({ error: "Repo key is required", code: "BAD_REQUEST" }, 400);
    if (!/^[a-zA-Z0-9-]+$/.test(key)) return c.json({ error: "Invalid repo key", code: "BAD_REQUEST" }, 400);
    const repo = loadRepoEntry(key);
    if (!repo) return c.json({ error: `Repo key not found: ${key}`, code: "NOT_FOUND" }, 404);

    const mainBranch = c.req.query("main") || repo.mainBranch || "main";
    const configuredDevelop = c.req.query("develop") || repo.developBranch || "develop";
    const skipDevelopChecks = configuredDevelop === "none";
    const developBranch = skipDevelopChecks ? "none" : configuredDevelop;
    const branchNameRegex = /^[a-zA-Z0-9._\-/]+$/;
    if (!branchNameRegex.test(mainBranch)) return c.json({ error: `Invalid main branch name: ${mainBranch}`, code: "BAD_REQUEST" }, 400);
    if (!skipDevelopChecks && !branchNameRegex.test(developBranch)) return c.json({ error: `Invalid develop branch name: ${developBranch}`, code: "BAD_REQUEST" }, 400);
    if (!existsSync(repo.path)) return c.json({ error: `Repo path does not exist: ${repo.path}`, code: "PATH_NOT_FOUND" }, 400);
    if (!existsSync(join(repo.path, ".git"))) return c.json({ error: `Not a git repository: ${repo.path}`, code: "NOT_GIT_REPO" }, 400);

    const errors: GitInfoErrors = {};
    const currentBranch = currentBranchName(repo.path);
    const mainBranchInfo = branchExists(mainBranch, repo.path) ? branchInfo(mainBranch, repo.path) : { name: mainBranch, exists: false };
    if (!mainBranchInfo.exists) errors.main = `Branch '${mainBranch}' not found`;
    let developBranchInfo: BranchInfo;
    if (skipDevelopChecks) developBranchInfo = { name: "none", exists: false };
    else {
      developBranchInfo = branchExists(developBranch, repo.path) ? branchInfo(developBranch, repo.path) : { name: developBranch, exists: false };
      if (!developBranchInfo.exists) errors.develop = `Branch '${developBranch}' not found`;
    }
    const mainVsDevelop = skipDevelopChecks || !mainBranchInfo.exists || !developBranchInfo.exists ? { main_ahead: 0, develop_ahead: 0, diverged: false } : aheadBehind(mainBranch, developBranch, repo.path);
    let featureBranches: FeatureBranch[] = [];
    if (!skipDevelopChecks) {
      try { featureBranches = unmergedBranches(developBranch, repo.path); } catch (error) { errors.featureBranches = error instanceof Error ? error.message : "Failed to get feature branches"; }
    }
    let workingDirectory = { clean: false, uncommitted_count: 0 };
    try { workingDirectory = workingDirStatus(repo.path); } catch (error) { errors.workingDirectory = error instanceof Error ? error.message : "Failed to get working directory status"; }

    return c.json({
      repo: { key: repo.name, path: repo.path, description: repo.description, prefix: repo.prefix },
      current_branch: currentBranch,
      main_branch: mainBranchInfo,
      develop_branch: developBranchInfo,
      main_vs_develop: mainVsDevelop,
      feature_branches: featureBranches,
      working_directory: workingDirectory,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    });
  });

  return app;
}

function gitRun(args: string[], cwd: string): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 5000 }).toString().trim(); } catch { return ""; }
}

function branchExists(branch: string, cwd: string): boolean {
  return gitRun(["rev-parse", "--verify", "--quiet", branch], cwd) !== "";
}

function currentBranchName(cwd: string): string {
  return gitRun(["branch", "--show-current"], cwd) || gitRun(["rev-parse", "--abbrev-ref", "HEAD"], cwd) || "";
}

function branchInfo(branch: string, cwd: string): BranchInfo {
  const [hash, hashShort, message, date] = gitRun(["log", "-1", "--format=%H%n%h%n%s%n%ci", branch], cwd).split("\n");
  return { name: branch, exists: true, latestCommit: hash ? { hash, hash_short: hashShort, message: message ?? "", date: date ?? "" } : undefined };
}

function aheadBehind(base: string, compare: string, cwd: string): { main_ahead: number; develop_ahead: number; diverged: boolean } {
  const mainAhead = Number(gitRun(["rev-list", "--count", `${compare}..${base}`], cwd) || "0");
  const developAhead = Number(gitRun(["rev-list", "--count", `${base}..${compare}`], cwd) || "0");
  return { main_ahead: mainAhead, develop_ahead: developAhead, diverged: mainAhead > 0 && developAhead > 0 };
}

function unmergedBranches(developBranch: string, cwd: string): FeatureBranch[] {
  if (!branchExists(developBranch, cwd)) return [];
  return gitRun(["branch", "--no-merged", developBranch], cwd).split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch && !branch.startsWith("*") && !["main", "develop", "master"].includes(branch))
    .filter((branch) => {
      const cherryLines = gitRun(["cherry", developBranch, branch], cwd).split("\n").filter((line) => line.trim());
      return !(cherryLines.length > 0 && cherryLines.every((line) => line.startsWith("-")));
    })
    .map((branch) => {
      const [hashShort, message, date] = gitRun(["log", "-1", "--format=%h%n%s%n%ci", branch], cwd).split("\n");
      return { name: branch, latestCommit: hashShort ? { hash_short: hashShort, message: message ?? "", date: date ?? "" } : { hash_short: "?", message: "?", date: "?" } };
    });
}

function workingDirStatus(cwd: string): { clean: boolean; uncommitted_count: number } {
  const status = gitRun(["status", "--porcelain"], cwd);
  const count = status ? status.split("\n").filter((line) => line.trim()).length : 0;
  return { clean: count === 0, uncommitted_count: count };
}
