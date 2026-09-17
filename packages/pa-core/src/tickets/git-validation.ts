import { execFileSync } from "node:child_process";
import { getBranchPattern, loadRepoEntry, listRepos, MAX_REPOSITORY_DIAGNOSTIC_CHARS } from "../repos.js";
import { nowUtc } from "../time.js";
import type { AddLinkedBranchInput, AddLinkedCommitInput, LinkedBranch, LinkedCommit, Ticket } from "./types.js";

const GIT_REF_ILLEGAL_CHARS = /[\s~^:?*\[\\]/;
const GIT_REF_ILLEGAL_SEQUENCES = /(?:\.\.|\/\/|@{|\.\.lock$|\.lock$)/;

function isGitRefSafe(ref: string): boolean {
  if (!ref) return false;
  if (ref.startsWith("-")) return false;
  if (ref.endsWith("/")) return false;
  if (ref.endsWith(".lock")) return false;
  if (GIT_REF_ILLEGAL_CHARS.test(ref)) return false;
  if (GIT_REF_ILLEGAL_SEQUENCES.test(ref)) return false;
  return true;
}

function sanitizeTopicSlug(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildBranchName(tickets: string[], topic: string, pattern: string): string {
  if (tickets.length === 0) throw new Error("buildBranchName requires at least one ticket id");
  const sanitizedTopic = sanitizeTopicSlug(topic);
  if (!sanitizedTopic) throw new Error(`buildBranchName: topic is empty after sanitization (input: "${topic}")`);
  const joinedTickets = tickets.join("-");
  const branch = pattern.replace(/<ticket>/g, joinedTickets).replace(/<topic>/g, sanitizedTopic);
  if (!isGitRefSafe(branch)) throw new Error(`buildBranchName: generated branch is not git-ref-safe: "${branch}"`);
  return branch;
}

export function validateBranchName(branch: string, pattern: string): boolean {
  const ticketSegment = "[A-Z]+-\\d+(?:-[A-Z]+-\\d+)*";
  const topicSegment = "[a-z0-9-]+";
  const regexBody = escapeRegex(pattern)
    .replace(/<ticket>/g, ticketSegment)
    .replace(/<topic>/g, topicSegment);
  const regex = new RegExp(`^${regexBody}$`);
  return regex.test(branch);
}

/** Validates one branch against one exact ticket rather than the multi-ticket grammar. */
export function validateBranchNameForTicket(branch: string, ticket: string, pattern: string): boolean {
  if (!/^[A-Z]+-\d+$/.test(ticket)) return false;
  const topicSegment = "[a-z0-9-]+";
  const regexBody = escapeRegex(pattern)
    .replace(/<ticket>/g, escapeRegex(ticket))
    .replace(/<topic>/g, topicSegment);
  return new RegExp(`^${regexBody}$`).test(branch);
}

function boundedBranchError(message: string): Error {
  return new Error(message.slice(0, MAX_REPOSITORY_DIAGNOSTIC_CHARS));
}

function validateRepoKey(repo: string): NonNullable<ReturnType<typeof loadRepoEntry>> {
  const entry = loadRepoEntry(repo);
  if (!entry) {
    const valid = listRepos().map((candidate) => candidate.name).sort();
    throw boundedBranchError(`Unknown linked-branch repository "${repo}". Correction: use one registered repository key. Valid repositories: ${valid.join(", ") || "(none)"}`);
  }
  return entry;
}

function isGitRepo(path: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function resolveLinkedBranch(input: AddLinkedBranchInput, ticket: Pick<Ticket, "id" | "project">, actor: string): LinkedBranch {
  const repoEntry = validateRepoKey(input.repo);
  if (repoEntry.name !== ticket.project) {
    throw boundedBranchError(`Cross-project linked branch rejected: ticket ${ticket.id} belongs to "${ticket.project}", but repository "${repoEntry.name}" was supplied. Correction: link the ticket's registered project repository.`);
  }
  if (!isGitRepo(repoEntry.path)) {
    throw boundedBranchError(`Linked-branch repository "${repoEntry.name}" is unavailable at its registered Git path "${repoEntry.path}". Correction: restore the registered checkout before retrying.`);
  }
  const pattern = getBranchPattern(repoEntry);
  if (!validateBranchNameForTicket(input.branch, ticket.id, pattern)) {
    throw boundedBranchError(`Invalid ticket branch "${input.branch}" for ${ticket.id}. Correction: use the exact configured pattern "${pattern}" with ticket ${ticket.id} and a lowercase topic.`);
  }

  const headSha = localBranchHead(repoEntry.path, input.branch);
  const common = { repo: repoEntry.name, branch: input.branch, linkedAt: nowUtc(), linkedBy: input.linkedBy ?? actor };
  if (!headSha) return { ...common, state: "planned" };

  return { ...common, state: "materialized", baseSha: headSha, headSha, sha: headSha };
}

export function requireTicketLinkedBranch(ticket: Pick<Ticket, "id" | "project" | "linkedBranches">, repo: string): LinkedBranch {
  const repoEntry = validateRepoKey(repo);
  if (ticket.project !== repoEntry.name) {
    throw boundedBranchError(`Cross-project linked-branch evidence rejected for ${ticket.id}: ticket project is "${ticket.project}", requested repository is "${repoEntry.name}". Correction: launch from the ticket's registered project.`);
  }
  const matches = ticket.linkedBranches.filter((branch) => branch.repo === repoEntry.name);
  if (matches.length === 0) {
    throw boundedBranchError(`Missing linked-branch evidence for ${ticket.id} in "${repoEntry.name}". Correction: run ticket update ${ticket.id} --linked-branch ${repoEntry.name}|<exact-ticket-branch>.`);
  }
  if (matches.length > 1) {
    throw boundedBranchError(`Ambiguous linked-branch evidence for ${ticket.id} in "${repoEntry.name}": found ${matches.length} entries. Correction: retain exactly one repository/branch entry before launch.`);
  }
  const branch = matches[0]!;
  const pattern = getBranchPattern(repoEntry);
  if (!validateBranchNameForTicket(branch.branch, ticket.id, pattern)) {
    throw boundedBranchError(`Invalid linked-branch evidence for ${ticket.id}: "${branch.branch}" does not match exact ticket pattern "${pattern}". Correction: replace it with one branch for ${ticket.id}.`);
  }
  if (branch.state === "planned" && (branch.baseSha || branch.headSha || branch.sha)) {
    throw boundedBranchError(`Invalid planned linked-branch evidence for ${ticket.id}: planned entries cannot contain base/head SHA evidence. Correction: remove the conflicting SHA fields or promote the same entry from authenticated Git evidence.`);
  }
  if (branch.state === "materialized" && !branch.headSha) {
    throw boundedBranchError(`Invalid materialized linked-branch evidence for ${ticket.id}: headSha is missing. Correction: refresh the same entry from the authenticated local branch.`);
  }
  return branch;
}

function localBranchHead(repoPath: string, branch: string): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
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
