import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { loadConfig, normalizeRepoConfig } from "./config.js";
import { expandHome, getPlatformHomeDir, getUserConfigPath } from "./paths.js";

// Ported from PA repos.ts at frozen PA source on 2026-04-26; search paths adjusted for pa-platform coexistence.

export interface RepoEntry {
  path: string;
  description?: string;
  prefix?: string;
  mainBranch?: string;
  developBranch?: string;
  featureBranchPattern?: string;
  remote_url?: string;
}

export type RegisteredRepo = { name: string } & RepoEntry;

export interface ResolvedRepoExecutionPath {
  repo: RegisteredRepo;
  repoKey: string;
  repoRoot: string;
  repositoryCwd: string;
  inferredFrom: "explicit" | "cwd";
}

export const DEFAULT_BRANCH_PATTERN = "feature/<ticket>-<topic>";
export const MAX_REPOSITORY_DIAGNOSTIC_CHARS = 2000;
const REGISTERED_PATH_RULE = "PA deployments use registered project paths only.";

export function getBranchPattern(repo: RepoEntry): string {
  return repo.featureBranchPattern ?? DEFAULT_BRANCH_PATTERN;
}

function candidateReposFiles(): string[] {
  return [
    getUserConfigPath(),
    resolve(getPlatformHomeDir(), "config.yaml"),
    resolve(dirname(getUserConfigPath()), "repos.yaml"),
    resolve(homedir(), ".config/sinh-x/personal-assistant/repos.yaml"),
    resolve(getPlatformHomeDir(), "repos.yaml"),
  ];
}

export function loadReposYaml(): Record<string, RepoEntry> {
  const configuredRepos = loadConfig().repos;
  if (Object.keys(configuredRepos).length > 0) {
    return Object.fromEntries(Object.entries(configuredRepos).map(([key, entry]) => [key, { ...entry, path: expandHome(entry.path) }]));
  }

  for (const filePath of candidateReposFiles()) {
    if (!existsSync(filePath)) continue;
    const raw = yaml.load(readFileSync(filePath, "utf-8")) as { repos?: Record<string, RepoEntry> } | undefined;
    if (!raw?.repos) continue;
    const repos: Record<string, RepoEntry> = {};
    for (const [key, entry] of Object.entries(raw.repos)) {
      repos[key] = normalizeRepoConfig(entry);
    }
    return repos;
  }
  return {};
}

export function listRepos(): Array<{ name: string } & RepoEntry> {
  return Object.entries(loadReposYaml()).map(([name, entry]) => ({ name, ...entry }));
}

export function loadRepoEntry(key: string): ({ name: string } & RepoEntry) | null {
  return listRepos().find((repo) => repo.name === key) ?? null;
}

export function resolveRepo(nameOrPath: string): RegisteredRepo {
  return resolveRepoExecutionPath(nameOrPath).repo;
}

export function resolveRepoExecutionPath(nameOrPath?: string, cwd = process.cwd()): ResolvedRepoExecutionPath {
  const repos = listRepos();
  if (repos.length === 0) {
    throw repositoryResolutionError("No repositories are configured in the PA registry.", []);
  }

  if (nameOrPath !== undefined) {
    const expandedInput = expandHome(nameOrPath);
    const keyMatch = repos.find((candidate) => candidate.name === nameOrPath);
    const pathMatches = repos.filter((candidate) => candidate.path === expandedInput);
    if (keyMatch && pathMatches.some((candidate) => candidate.name !== keyMatch.name)) {
      throw repositoryResolutionError(`Explicit repository input "${nameOrPath}" is ambiguous because it identifies "${keyMatch.name}" by key and a different repository by exact configured path.`, [keyMatch, ...pathMatches]);
    }
    if (keyMatch) return resolvedRegisteredRepo(keyMatch, "explicit");
    if (pathMatches.length === 1) return resolvedRegisteredRepo(pathMatches[0]!, "explicit");
    if (pathMatches.length > 1) {
      throw repositoryResolutionError(`The exact configured path "${expandedInput}" is ambiguous.`, pathMatches);
    }
    const requestedPath = resolve(cwd, expandedInput);
    if (isLinkedGitWorkingTree(requestedPath)) {
      throw repositoryResolutionError(`Explicit repository input "${nameOrPath}" is a linked Git working tree. Linked working trees are not deployment roots.`, repos);
    }
    throw repositoryResolutionError(`Explicit repository input "${nameOrPath}" is not a registered repository key or exact configured path.`, repos);
  }

  const requestedPath = resolve(cwd);
  if (!existsSync(requestedPath)) {
    throw repositoryResolutionError(`Current working directory does not exist: ${requestedPath}.`, repos);
  }
  if (!statSync(requestedPath).isDirectory()) {
    throw repositoryResolutionError(`Current working directory is not a directory: ${requestedPath}.`, repos);
  }
  let repoRoot: string;
  try {
    repoRoot = realpathSync(gitOutput(["rev-parse", "--show-toplevel"], requestedPath));
  } catch {
    throw repositoryResolutionError(`Current working directory "${cwd}" is not a Git working tree.`, repos);
  }
  if (isLinkedGitWorkingTree(repoRoot)) {
    throw repositoryResolutionError(`Current working directory "${cwd}" belongs to a linked Git working tree. Run from the exact configured repository root or pass its registered key.`, repos);
  }
  const matches = repos.filter((candidate) => candidate.path === repoRoot);
  if (matches.length === 1) return resolvedRegisteredRepo(matches[0]!, "cwd");
  if (matches.length > 1) {
    throw repositoryResolutionError("Current working directory matches multiple exact configured repository roots.", matches);
  }
  throw repositoryResolutionError(`Current working directory "${cwd}" does not resolve to an exact configured repository root. Independent clones and remote-only matches are not eligible.`, repos);
}

function resolvedRegisteredRepo(repo: RegisteredRepo, inferredFrom: "explicit" | "cwd"): ResolvedRepoExecutionPath {
  if (!existsSync(repo.path)) {
    throw repositoryResolutionError(`Configured path for "${repo.name}" does not exist: ${repo.path}.`, [repo]);
  }
  if (!statSync(repo.path).isDirectory()) {
    throw repositoryResolutionError(`Configured path for "${repo.name}" is not a directory: ${repo.path}.`, []);
  }
  const physicalPath = realpathSync(repo.path);
  if (repo.path !== physicalPath) {
    throw repositoryResolutionError(`Configured path for "${repo.name}" must be its physical Git root, not a relative path or symlink: ${repo.path}.`, []);
  }
  if (configuredRepoRoot(repo.path) !== repo.path) {
    throw repositoryResolutionError(`Configured path for "${repo.name}" is not the root of a Git working tree: ${repo.path}.`, []);
  }
  if (isLinkedGitWorkingTree(repo.path)) {
    throw repositoryResolutionError(`Configured path for "${repo.name}" is a linked Git working tree. Register the primary working tree root instead.`, []);
  }
  return { repo, repoKey: repo.name, repoRoot: repo.path, repositoryCwd: repo.path, inferredFrom };
}

function configuredRepoRoot(path: string): string | undefined {
  try {
    const root = realpathSync(gitOutput(["rev-parse", "--show-toplevel"], path));
    return root === realpathSync(path) ? root : undefined;
  } catch {
    return undefined;
  }
}

function isLinkedGitWorkingTree(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const gitDir = realpathSync(gitOutput(["rev-parse", "--path-format=absolute", "--git-dir"], path));
    const commonDir = realpathSync(gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"], path));
    return gitDir !== commonDir;
  } catch {
    return false;
  }
}

function repositoryResolutionError(detail: string, candidates: RegisteredRepo[]): Error {
  const correctiveAction = candidates.length === 1
    ? `Corrective action: pass --repo "${candidates[0]!.name}" or --repo "${candidates[0]!.path}".`
    : candidates.length > 1
      ? `Corrective action: pass one registered key or exact configured path: ${candidates.map((repo) => `${repo.name} (${repo.path})`).join(", ")}.`
      : "Corrective action: configure the project in the PA repository registry, then pass its key or exact configured path.";
  const suffix = ` ${correctiveAction}`;
  const prefix = `${REGISTERED_PATH_RULE} `;
  const available = Math.max(0, MAX_REPOSITORY_DIAGNOSTIC_CHARS - prefix.length - suffix.length - 3);
  const boundedDetail = detail.length > available ? `${detail.slice(0, available)}...` : detail;
  const message = `${prefix}${boundedDetail}${suffix}`;
  return new Error(message.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS ? message : `${prefix}${correctiveAction}`.slice(0, MAX_REPOSITORY_DIAGNOSTIC_CHARS));
}

export function resolveProject(input: string): { key: string; prefix: string } {
  const repos = loadReposYaml();
  if (repos[input]?.prefix) return { key: input, prefix: repos[input].prefix };

  for (const [key, entry] of Object.entries(repos)) {
    if (entry.prefix?.toLowerCase() === input.toLowerCase()) return { key, prefix: entry.prefix };
  }

  for (const [key, entry] of Object.entries(repos)) {
    if (entry.prefix && basename(entry.path) === input) return { key, prefix: entry.prefix };
  }

  const validKeys = Object.keys(repos).filter((key) => repos[key]?.prefix).join(", ") || "(none)";
  throw new Error(`Unknown project "${input}". Valid project keys: ${validKeys}`);
}

export function getRepoPrefix(projectName: string): string | undefined {
  try {
    return resolveProject(projectName).prefix;
  } catch {
    return undefined;
  }
}

export function resolveProjectFromCwd(cwd = process.cwd()): { key: string; prefix: string; repoRoot: string } | undefined {
  let repoRoot: string;
  try {
    repoRoot = realpathSync(gitOutput(["rev-parse", "--show-toplevel"], cwd));
  } catch {
    return undefined;
  }
  if (isLinkedGitWorkingTree(repoRoot)) return undefined;
  const exactMatch = listRepos().find((repo) => repo.path === repoRoot && repo.prefix);
  return exactMatch ? { key: exactMatch.name, prefix: exactMatch.prefix!, repoRoot } : undefined;
}

function gitOutput(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
