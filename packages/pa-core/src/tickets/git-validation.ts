import { execFileSync } from "node:child_process";
import { loadRepoEntry, listRepos } from "../repos.js";
import { nowUtc } from "../time.js";
import type { AddLinkedBranchInput, AddLinkedCommitInput, LinkedBranch, LinkedCommit } from "./types.js";

function validateRepoKey(repo: string): { name: string; path: string } {
  const entry = loadRepoEntry(repo);
  if (!entry) {
    const valid = listRepos().map((candidate) => candidate.name).sort();
    throw new Error(`Unknown repo "${repo}". Valid repos: ${valid.join(", ") || "(none)"}`);
  }
  return { name: entry.name, path: entry.path };
}

function isGitRepo(path: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function resolveLinkedBranch(input: AddLinkedBranchInput, actor: string): LinkedBranch {
  const repoEntry = validateRepoKey(input.repo);
  if (!isGitRepo(repoEntry.path)) throw new Error(`Path is not a git repository: ${repoEntry.path}`);
  let sha: string;
  try {
    sha = execFileSync("git", ["rev-parse", "--verify", `refs/heads/${input.branch}`], { cwd: repoEntry.path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`Branch "${input.branch}" not found in repo "${input.repo}". Hint: local branches only. Run "git fetch" first if the branch exists on a remote.`);
  }
  return { repo: input.repo, branch: input.branch, sha, linkedAt: nowUtc(), linkedBy: input.linkedBy ?? actor };
}

export function resolveLinkedCommit(input: AddLinkedCommitInput, actor: string): LinkedCommit {
  const repoEntry = validateRepoKey(input.repo);
  if (!isGitRepo(repoEntry.path)) throw new Error(`Path is not a git repository: ${repoEntry.path}`);
  try {
    const type = execFileSync("git", ["cat-file", "-t", input.sha], { cwd: repoEntry.path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (type !== "commit") throw new Error(`Object "${input.sha}" is not a commit (type: ${type})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not a commit")) throw new Error(`Commit "${input.sha}" not found in repo "${input.repo}". Hint: make sure the commit exists locally.`, { cause: error });
    throw new Error(`Commit "${input.sha}" not found in repo "${input.repo}"`, { cause: error });
  }

  let message = input.message ?? "";
  let author = input.author ?? "";
  let timestamp = input.timestamp ?? "";
  if (!message || !author || !timestamp) {
    const logLine = execFileSync("git", ["log", "-1", "--format=%s|%an|%aI", input.sha], { cwd: repoEntry.path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const [logMessage, logAuthor, logTimestamp] = logLine.split("|");
    if (!message) message = logMessage ?? "";
    if (!author) author = logAuthor ?? "";
    if (!timestamp) timestamp = logTimestamp ?? "";
  }
  return { repo: input.repo, sha: input.sha, message, author, timestamp, linkedAt: nowUtc(), linkedBy: input.linkedBy ?? actor };
}
