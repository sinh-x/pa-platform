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
const CASE_INSENSITIVE_REMOTE_HOSTS = new Set(["github.com"]);

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

export function normalizeRemoteUrl(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (!value) throw new Error("Remote URL cannot be empty");

  const scpMatch = value.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  const parsed = scpMatch
    && !/^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? { host: scpMatch[1], port: undefined, pathname: scpMatch[2] }
    : (() => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new Error(`Invalid remote URL: ${remoteUrl}`);
        }
        const defaultPort = url.protocol === "ssh:" ? "22" : url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : undefined;
        return { host: url.hostname, port: url.port && url.port !== defaultPort ? url.port : undefined, pathname: url.pathname };
      })();

  const host = parsed.host.toLowerCase();
  const caseInsensitivePath = CASE_INSENSITIVE_REMOTE_HOSTS.has(host);
  const pathWithoutSlashes = parsed.pathname.replace(/^\/+|\/+$/g, "");
  const rawPath = pathWithoutSlashes.replace(caseInsensitivePath ? /\.git$/i : /\.git$/, "");
  const path = caseInsensitivePath ? rawPath.toLowerCase() : rawPath;
  if (!parsed.host || !path) throw new Error(`Invalid remote URL: ${remoteUrl}`);
  return `${host}${parsed.port ? `:${parsed.port}` : ""}/${path}`;
}

function resolveRepoByRemote(remoteUrl: string, repos: RegisteredRepo[]): RegisteredRepo | null {
  const normalized = normalizeRemoteUrl(remoteUrl);
  const matches = repos.filter((repo) => repo.remote_url && normalizeRemoteUrl(repo.remote_url) === normalized);
  if (matches.length > 1) {
    throw new Error(`Ambiguous repository remote "${remoteUrl}" matches: ${matches.map((repo) => `${repo.name} (${repo.path})`).join(", ")}`);
  }
  return matches[0] ?? null;
}

function isLocalGitOrigin(origin: string): boolean {
  if (/^file:\/\//i.test(origin)) return true;
  if (/^(?:\.{1,2}\/|\/)/.test(origin)) return true;
  return !/^[a-z][a-z\d+.-]*:\/\//i.test(origin) && !/^(?:[^@]+@)?[^:/]+:.+$/.test(origin);
}

export function resolveRepo(nameOrPath: string, remoteUrl?: string): RegisteredRepo {
  const repos = listRepos();
  const remoteMatch = remoteUrl ? resolveRepoByRemote(remoteUrl, repos) : null;
  const repo = remoteMatch ?? repos.find((candidate) => candidate.name === nameOrPath || candidate.path === expandHome(nameOrPath));
  if (!repo) throw new Error(`Unknown repo: ${nameOrPath}`);
  if (!existsSync(repo.path)) throw new Error(`Repo path does not exist: ${repo.path} (repo: ${repo.name})`);
  return repo;
}

export function resolveRepoByRemoteIdentity(remoteUrl: string): RegisteredRepo | null {
  return resolveRepoByRemote(remoteUrl, listRepos());
}

export function resolveRepoExecutionPath(nameOrPath?: string, cwd = process.cwd()): ResolvedRepoExecutionPath {
  const repos = listRepos();
  if (repos.length === 0) {
    throw repositoryResolutionError("No repositories are configured in the PA registry.", []);
  }

  if (nameOrPath !== undefined) {
    const expandedInput = expandHome(nameOrPath);
    const keyMatch = repos.find((candidate) => candidate.name === nameOrPath);
    if (keyMatch) return resolvedRegisteredRepo(keyMatch, "explicit");

    const pathMatches = repos.filter((candidate) => candidate.path === expandedInput);
    if (pathMatches.length === 1) return resolvedRegisteredRepo(pathMatches[0]!, "explicit");
    if (pathMatches.length > 1) {
      throw repositoryResolutionError(`The exact configured path "${expandedInput}" is ambiguous.`, pathMatches);
    }

    const identity = inspectRepositoryIdentity(expandedInput, cwd, nameOrPath, repos);
    if (identity.gitDir !== identity.commonDir) assertWorktreeAdminOwnership(expandedInput, identity.repoRoot, identity.gitDir, repos);
    const identityMatches = registeredIdentityMatches(identity, repos);
    if (identityMatches.length > 1) {
      throw repositoryResolutionError(`Explicit repository input "${nameOrPath}" has ambiguous registered identity.`, identityMatches);
    }
    if (identityMatches.length === 1) {
      const match = identityMatches[0]!;
      throw repositoryResolutionError(`Explicit repository input "${nameOrPath}" is not the exact configured path for "${match.name}". Linked worktrees, nested paths, symlink aliases, and independent checkouts are identity evidence only and cannot be execution paths.`, [match]);
    }

    const remoteMatches = registeredRemoteMatches(identity.repoRoot, repos);
    if (remoteMatches.length > 1) {
      throw repositoryResolutionError(`Explicit repository input "${nameOrPath}" has ambiguous remote identity.`, remoteMatches);
    }
    if (remoteMatches.length === 1) {
      const match = remoteMatches[0]!;
      throw repositoryResolutionError(`Explicit repository input "${nameOrPath}" is an independent or otherwise unregistered checkout for "${match.name}".`, [match]);
    }
    throw repositoryResolutionError(`Explicit repository input "${nameOrPath}" is not a registered repository key or exact configured path.`, repos);
  }

  const identity = inspectRepositoryIdentity(cwd, cwd, "current working directory", repos);
  const directMatches = repos.filter((candidate) => configuredRepoRoot(candidate.path) === identity.repoRoot);
  if (directMatches.length === 1) return resolvedRegisteredRepo(directMatches[0]!, "cwd");
  if (directMatches.length > 1) {
    throw repositoryResolutionError(`Current working directory identity is ambiguous across registered project roots.`, directMatches);
  }

  if (identity.gitDir !== identity.commonDir) assertWorktreeAdminOwnership(cwd, identity.repoRoot, identity.gitDir, repos);
  const commonDirMatches = repos.filter((candidate) => gitCommonDir(candidate.path) === identity.commonDir);
  if (commonDirMatches.length === 1) return resolvedRegisteredRepo(commonDirMatches[0]!, "cwd");
  if (commonDirMatches.length > 1) {
    throw repositoryResolutionError(`Current working directory has ambiguous registered Git identity.`, commonDirMatches);
  }

  throw repositoryResolutionError(`Current working directory "${cwd}" does not identify a unique registered project. Independent clones and remote-only matches are not eligible.`, repos);
}

interface RepositoryIdentity {
  repoRoot: string;
  gitDir: string;
  commonDir: string;
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
  return { repo, repoKey: repo.name, repoRoot: repo.path, repositoryCwd: repo.path, inferredFrom };
}

function inspectRepositoryIdentity(input: string, cwd: string, label: string, repos: RegisteredRepo[]): RepositoryIdentity {
  const requestedPath = resolve(cwd, expandHome(input));
  if (!existsSync(requestedPath)) {
    throw repositoryResolutionError(`Repository ${label} does not exist: ${requestedPath}.`, repos);
  }
  if (!statSync(requestedPath).isDirectory()) {
    throw repositoryResolutionError(`Repository ${label} is not a directory: ${requestedPath}.`, repos);
  }
  try {
    const repoRoot = realpathSync(gitOutput(["rev-parse", "--show-toplevel"], requestedPath));
    return {
      repoRoot,
      gitDir: realpathSync(gitOutput(["rev-parse", "--path-format=absolute", "--git-dir"], repoRoot)),
      commonDir: realpathSync(gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot)),
    };
  } catch {
    throw repositoryResolutionError(`Repository ${label} is not a Git working tree: ${requestedPath}.`, repos);
  }
}

function registeredIdentityMatches(identity: RepositoryIdentity, repos: RegisteredRepo[]): RegisteredRepo[] {
  const directMatches = repos.filter((candidate) => configuredRepoRoot(candidate.path) === identity.repoRoot);
  if (directMatches.length > 0) return directMatches;
  return repos.filter((candidate) => gitCommonDir(candidate.path) === identity.commonDir);
}

function registeredRemoteMatches(repoRoot: string, repos: RegisteredRepo[]): RegisteredRepo[] {
  const origin = gitOrigin(repoRoot);
  if (!origin || isLocalGitOrigin(origin)) return [];
  let normalizedOrigin: string;
  try {
    normalizedOrigin = normalizeRemoteUrl(origin);
  } catch {
    return [];
  }
  return repos.filter((candidate) => {
    if (!candidate.remote_url || isLocalGitOrigin(candidate.remote_url)) return false;
    try {
      return normalizeRemoteUrl(candidate.remote_url) === normalizedOrigin;
    } catch {
      return false;
    }
  });
}

function configuredRepoRoot(path: string): string | undefined {
  try {
    const root = realpathSync(gitOutput(["rev-parse", "--show-toplevel"], path));
    return root === realpathSync(path) ? root : undefined;
  } catch {
    return undefined;
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
    repoRoot = gitOutput(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return undefined;
  }

  const repos = listRepos();
  const exactMatch = repos.find((repo) => repo.path === repoRoot && repo.prefix);
  if (exactMatch) return { key: exactMatch.name, prefix: exactMatch.prefix!, repoRoot };

  const cwdCommonDir = gitCommonDir(repoRoot);
  if (cwdCommonDir) {
    const commonDirMatches = repos.filter((repo) => repo.prefix && gitCommonDir(repo.path) === cwdCommonDir);
    if (commonDirMatches.length === 1) return { key: commonDirMatches[0]!.name, prefix: commonDirMatches[0]!.prefix!, repoRoot };
    if (commonDirMatches.length > 1) return undefined;
  }

  let origin: string;
  try {
    origin = gitOutput(["config", "--get", "remote.origin.url"], repoRoot);
  } catch {
    return undefined;
  }
  if (isLocalGitOrigin(origin)) return undefined;
  const remoteMatch = resolveRepoByRemote(origin, repos);
  return remoteMatch?.prefix ? { key: remoteMatch.name, prefix: remoteMatch.prefix, repoRoot } : undefined;
}

function gitOutput(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function assertWorktreeAdminOwnership(requestedPath: string, repositoryCwd: string, gitDir: string, repos: RegisteredRepo[]): void {
  let adminWorktreeGitFile: string;
  let rootGitFile: string;
  try {
    const backlink = readFileSync(resolve(gitDir, "gitdir"), "utf-8").trim();
    if (!backlink) throw new Error("empty worktree admin gitdir metadata");
    adminWorktreeGitFile = realpathSync(resolve(gitDir, backlink));
    rootGitFile = realpathSync(resolve(repositoryCwd, ".git"));
  } catch {
    throw repositoryResolutionError(`Linked-worktree identity for "${requestedPath}" has missing or invalid Git administration metadata.`, repos);
  }
  if (adminWorktreeGitFile !== rootGitFile) {
    throw repositoryResolutionError(`Linked-worktree identity for "${requestedPath}" belongs to a different working tree.`, repos);
  }
}

function gitCommonDir(cwd: string): string | undefined {
  try {
    return realpathSync(gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd));
  } catch {
    return undefined;
  }
}

function gitOrigin(cwd: string): string | undefined {
  try {
    return gitOutput(["config", "--get", "remote.origin.url"], cwd);
  } catch {
    return undefined;
  }
}
