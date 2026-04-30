import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { loadRepoEntry } from "../../repos.js";

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9._\-/]+$/;
const REPO_KEY_REGEX = /^[a-zA-Z0-9-]+$/;

export function repoCommitsRoutes(): Hono {
  const app = new Hono();
  app.get("/api/repos/:key/branches", (c) => {
    const repo = validatedRepo(c.req.param("key"));
    if (!repo.ok) return c.json({ error: repo.error, code: repo.code }, repo.status);
    const current = gitRun(["branch", "--show-current"], repo.path);
    const branches = gitRun(["branch", "--format", "%(refname:short)"], repo.path).split("\n").filter(Boolean).map((name) => ({ name, is_current: name === current, latest_commit: latestCommit(name, repo.path) ?? { hash_short: "", message: "", date: "", author: "" } }));
    return c.json({ repo: { key: repo.name, path: repo.path }, branches });
  });
  app.get("/api/repos/:key/commits", (c) => {
    const repo = validatedRepo(c.req.param("key"));
    if (!repo.ok) return c.json({ error: repo.error, code: repo.code }, repo.status);
    const branch = c.req.query("branch") || "HEAD";
    if (!BRANCH_NAME_REGEX.test(branch)) return c.json({ error: `Invalid branch name: ${branch}`, code: "BAD_REQUEST" }, 400);
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const meta = { branch, total: Number.parseInt(gitRun(["rev-list", "--count", branch], repo.path), 10) || 0, limit, offset };
    return c.json({ repo: { key: repo.name, path: repo.path }, branch, commits: commitHistory(branch, limit, offset, repo.path), meta });
  });
  return app;
}

function validatedRepo(key: string): { ok: true; name: string; path: string } | { ok: false; error: string; code: string; status: 400 | 404 } {
  if (!key || !REPO_KEY_REGEX.test(key)) return { ok: false, error: "Invalid repo key", code: "BAD_REQUEST", status: 400 };
  const repo = loadRepoEntry(key);
  if (!repo) return { ok: false, error: `Repo key not found: ${key}`, code: "NOT_FOUND", status: 404 };
  if (!existsSync(repo.path)) return { ok: false, error: `Repo path does not exist: ${repo.path}`, code: "PATH_NOT_FOUND", status: 400 };
  if (!existsSync(join(repo.path, ".git"))) return { ok: false, error: `Not a git repository: ${repo.path}`, code: "NOT_GIT_REPO", status: 400 };
  return { ok: true, name: repo.name, path: repo.path };
}

function gitRun(args: string[], cwd: string): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

function latestCommit(branch: string, cwd: string): { hash_short: string; message: string; date: string; author: string } | null {
  const [hashShort, message, date, author] = gitRun(["log", "-1", "--format=%h%n%s%n%ci%n%an", branch], cwd).split("\n");
  return hashShort ? { hash_short: hashShort, message: message ?? "", date: date ?? "", author: author ?? "" } : null;
}

function commitHistory(branch: string, limit: number, offset: number, cwd: string): Array<Record<string, unknown>> {
  const hashes = gitRun(["log", branch, "--first-parent", "--format=%H", `-${limit}`, `--skip=${offset}`], cwd).split("\n").filter(Boolean);
  return hashes.map((hash) => {
    const [fullHash, hashShort, authorName, authorEmail, date, ...messageParts] = gitRun(["log", "-1", "-m", "--first-parent", "--format=%H%n%h%n%an%n%ae%n%ci%n%s", hash], cwd).split("\n");
    const numstat = gitRun(["show", "--numstat", "--format=", hash], cwd).split("\n").filter(Boolean);
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat) {
      const [added, removed] = line.split("\t");
      const addedCount = Number.parseInt(added ?? "0", 10) || 0;
      const removedCount = Number.parseInt(removed ?? "0", 10) || 0;
      if (addedCount > 0 || removedCount > 0) filesChanged++;
      insertions += addedCount;
      deletions += removedCount;
    }
    return { hash: fullHash || hash, hash_short: hashShort || hash.slice(0, 7), author_name: authorName ?? "", author_email: authorEmail ?? "", date: date ?? "", message: messageParts.join("\n"), diff_summary: { files_changed: filesChanged, insertions, deletions } };
  });
}
