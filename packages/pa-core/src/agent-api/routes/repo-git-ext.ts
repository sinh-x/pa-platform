import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { loadRepoEntry } from "../../repos.js";

const REPO_KEY_REGEX = /^[a-zA-Z0-9-]+$/;
const REF_REGEX = /^[a-zA-Z0-9._\-/]+$/;
const SHA_REGEX = /^[a-fA-F0-9]{7,40}$/;

export function repoGitExtRoutes(): Hono {
  const app = new Hono();
  app.get("/api/repos/:key/diff", (c) => {
    const repo = validatedRepo(c.req.param("key"));
    if (!repo.ok) return c.json({ error: repo.error, code: repo.code }, repo.status);
    const commit = c.req.query("commit");
    if (!commit || !SHA_REGEX.test(commit)) return c.json({ error: "commit query param must be a SHA", code: "BAD_REQUEST" }, 400);
    if (!gitRun(["rev-parse", "--verify", commit], repo.path)) return c.json({ error: "Commit not found", code: "NOT_FOUND" }, 404);
    const diff = parseUnifiedDiff(gitRun(["show", commit, "-m", "--first-parent", "-p", "--format="], repo.path));
    return c.json({ repo: { key: repo.name, path: repo.path }, commit, ...diff });
  });
  app.get("/api/repos/:key/branches/remote", (c) => {
    const repo = validatedRepo(c.req.param("key"));
    if (!repo.ok) return c.json({ error: repo.error, code: repo.code }, repo.status);
    const branches = gitRun(["branch", "-r", "--format", "%(refname:short)"], repo.path).split("\n").filter((name) => name && !name.includes("HEAD")).map((name) => ({ name, tracking_local: null, latest_commit: latestCommit(name, repo.path) ?? { hash_short: "", message: "", date: "", author: "" } }));
    return c.json({ repo: { key: repo.name, path: repo.path }, branches });
  });
  app.get("/api/repos/:key/compare", (c) => {
    const repo = validatedRepo(c.req.param("key"));
    if (!repo.ok) return c.json({ error: repo.error, code: repo.code }, repo.status);
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to || !REF_REGEX.test(from) || !REF_REGEX.test(to)) return c.json({ error: "from and to query params must be valid refs", code: "BAD_REQUEST" }, 400);
    const output = gitRun(["log", `${from}..${to}`, "--format=%H%n%h%n%an%n%ae%n%ci%n%s%x1e"], repo.path);
    const commits = output.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [hash, hashShort, authorName, authorEmail, date, ...message] = entry.split("\n");
      return { hash, hash_short: hashShort, author_name: authorName, author_email: authorEmail, date, message: message.join("\n") };
    });
    return c.json({ repo: { key: repo.name, path: repo.path }, from, to, commits, count: commits.length });
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

function latestCommit(ref: string, cwd: string): { hash_short: string; message: string; date: string; author: string } | null {
  const [hashShort, message, date, author] = gitRun(["log", "-1", "--format=%h%n%s%n%ci%n%an", ref], cwd).split("\n");
  return hashShort ? { hash_short: hashShort, message: message ?? "", date: date ?? "", author: author ?? "" } : null;
}

function parseUnifiedDiff(diffOutput: string): { diffEntries: Array<Record<string, unknown>>; filesChanged: number; insertions: number; deletions: number } {
  const diffEntries: Array<Record<string, unknown>> = [];
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const section of diffOutput.split(/^diff --git /m).filter((part) => part.trim())) {
    const lines = section.split("\n");
    const header = lines[0]?.match(/^a\/(.+?) b\/(.+?)(?:\s*$|$)/);
    if (!header) continue;
    const hunks: Array<Record<string, unknown>> = [];
    let changeType = "modified";
    let binary = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.startsWith("Binary files")) binary = true;
      if (line.includes("new file mode")) changeType = "added";
      if (line.includes("deleted file mode")) changeType = "deleted";
      if (line.includes("rename from")) changeType = "renamed";
      if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunk) hunks.push({ old_start: Number(hunk[1]), old_lines: Number(hunk[2] ?? 1), new_start: Number(hunk[3]), new_lines: Number(hunk[4] ?? 1), lines: [] });
    }
    if (!binary) filesChanged++;
    diffEntries.push({ old_path: header[1], new_path: header[2], change_type: changeType, hunks, binary });
  }
  return { diffEntries, filesChanged, insertions, deletions };
}
