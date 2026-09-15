import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
  /** Registered primary repository root and trust anchor. */
  repoRoot: string;
  /** Exact physical root where project and runtime operations execute. */
  worktreeRoot: string;
  repositoryCwd: string;
  gitDir: string;
  gitCommonDir: string;
  worktreeKind: "primary" | "linked";
  inferredFrom: "explicit" | "cwd";
}

export interface ResolveRepoExecutionPathOptions {
  /** Internal Pi-only CWD policy. Explicit linked-worktree inputs remain invalid. */
  allowLinkedWorktreeCwd?: boolean;
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

export function resolveRepoExecutionPath(nameOrPath?: string, cwd = process.cwd(), options: ResolveRepoExecutionPathOptions = {}): ResolvedRepoExecutionPath {
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
  const physicalRequestedPath = realpathSync(requestedPath);
  if (physicalRequestedPath !== requestedPath) {
    throw repositoryResolutionError(`Current working directory "${cwd}" uses a symlink alias. Use the physical Git working-tree path.`, repos);
  }

  let evidence: GitWorkingTreeEvidence;
  try {
    evidence = gitWorkingTreeEvidence(requestedPath);
  } catch {
    throw repositoryResolutionError(`Current working directory "${cwd}" is not a valid physical Git working tree.`, repos);
  }
  if (evidence.worktreeRoot !== realpathSync(evidence.worktreeRoot)) {
    throw repositoryResolutionError(`Current working directory "${cwd}" resolves through a symlinked Git working-tree root. Use its physical path.`, repos);
  }

  if (evidence.kind === "linked") {
    if (!options.allowLinkedWorktreeCwd) {
      throw repositoryResolutionError(`Current working directory "${cwd}" belongs to a linked Git working tree. Run from the exact configured repository root or pass its registered key.`, repos);
    }
    if (!isAuthenticatedLinkedWorktree(evidence)) {
      throw repositoryResolutionError(`Current working directory "${cwd}" has malformed or forged linked-worktree metadata.`, repos);
    }
    const matches = repos.filter((candidate) => {
      try {
        const registered = resolvedRegisteredRepo(candidate, "cwd");
        return registered.gitCommonDir === evidence.gitCommonDir
          && registeredPhysicalWorktrees(registered.repoRoot).includes(evidence.worktreeRoot);
      } catch {
        return false;
      }
    });
    if (matches.length === 1) return resolvedRegisteredRepo(matches[0]!, "cwd", evidence);
    if (matches.length > 1) {
      throw repositoryResolutionError("Current linked working tree matches multiple registered primary repositories by physical Git common directory.", matches);
    }
    throw repositoryResolutionError(`Current linked working tree "${evidence.worktreeRoot}" does not have a unique registered primary repository with the same physical Git common directory. Independent clones and remote-only matches are not eligible.`, repos);
  }

  const matches = repos.filter((candidate) => candidate.path === evidence.worktreeRoot);
  if (matches.length === 1) return resolvedRegisteredRepo(matches[0]!, "cwd");
  if (matches.length > 1) {
    throw repositoryResolutionError("Current working directory matches multiple exact configured repository roots.", matches);
  }
  throw repositoryResolutionError(`Current working directory "${cwd}" does not resolve to an exact configured repository root. Independent clones and remote-only matches are not eligible.`, repos);
}

function resolvedRegisteredRepo(repo: RegisteredRepo, inferredFrom: "explicit" | "cwd", executionEvidence?: GitWorkingTreeEvidence): ResolvedRepoExecutionPath {
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
  let primaryEvidence: GitWorkingTreeEvidence;
  try {
    primaryEvidence = gitWorkingTreeEvidence(repo.path);
  } catch {
    throw repositoryResolutionError(`Configured path for "${repo.name}" is not the root of a Git working tree: ${repo.path}.`, []);
  }
  if (primaryEvidence.worktreeRoot !== repo.path) {
    throw repositoryResolutionError(`Configured path for "${repo.name}" is not the root of a Git working tree: ${repo.path}.`, []);
  }
  if (primaryEvidence.kind === "linked") {
    throw repositoryResolutionError(`Configured path for "${repo.name}" is a linked Git working tree. Register the primary working tree root instead.`, []);
  }
  const execution = executionEvidence ?? primaryEvidence;
  if (execution.gitCommonDir !== primaryEvidence.gitCommonDir) {
    throw repositoryResolutionError(`Execution working tree does not match the registered Git common directory for "${repo.name}".`, [repo]);
  }
  return {
    repo,
    repoKey: repo.name,
    repoRoot: repo.path,
    worktreeRoot: execution.worktreeRoot,
    repositoryCwd: execution.worktreeRoot,
    gitDir: execution.gitDir,
    gitCommonDir: execution.gitCommonDir,
    worktreeKind: execution.kind,
    inferredFrom,
  };
}

interface GitWorkingTreeEvidence {
  worktreeRoot: string;
  gitDir: string;
  gitCommonDir: string;
  kind: "primary" | "linked";
}

function gitWorkingTreeEvidence(path: string): GitWorkingTreeEvidence {
  const worktreeRoot = absolutePhysicalGitPath(gitOutput(["rev-parse", "--path-format=absolute", "--show-toplevel"], path));
  const gitDir = absolutePhysicalGitPath(gitOutput(["rev-parse", "--path-format=absolute", "--git-dir"], path));
  const gitCommonDir = absolutePhysicalGitPath(gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"], path));
  return { worktreeRoot, gitDir, gitCommonDir, kind: gitDir === gitCommonDir ? "primary" : "linked" };
}

function absolutePhysicalGitPath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Git returned a non-absolute path");
  const absolute = resolve(path);
  const physical = realpathSync(absolute);
  if (absolute !== physical) throw new Error("Git metadata resolves through a symlink");
  return physical;
}

function registeredPhysicalWorktrees(repoRoot: string): readonly string[] {
  const worktrees: string[] = [];
  for (const field of gitOutput(["worktree", "list", "--porcelain", "-z"], repoRoot).split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    try {
      worktrees.push(absolutePhysicalGitPath(field.slice("worktree ".length)));
    } catch {
      // Stale/prunable worktree records cannot authenticate a deployment CWD.
    }
  }
  return worktrees;
}

function isAuthenticatedLinkedWorktree(evidence: GitWorkingTreeEvidence): boolean {
  try {
    if (evidence.kind !== "linked") return false;
    const dotGit = join(evidence.worktreeRoot, ".git");
    if (!lstatSync(dotGit).isFile() || lstatSync(dotGit).isSymbolicLink()) return false;
    const pointer = readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith("gitdir:")) return false;
    const pointerPath = pointer.slice("gitdir:".length).trim();
    const resolvedPointer = realpathSync(isAbsolute(pointerPath) ? pointerPath : resolve(evidence.worktreeRoot, pointerPath));
    if (resolvedPointer !== evidence.gitDir) return false;

    const reversePointer = readFileSync(join(evidence.gitDir, "gitdir"), "utf8").trim();
    const resolvedReverse = realpathSync(isAbsolute(reversePointer) ? reversePointer : resolve(evidence.gitDir, reversePointer));
    if (resolvedReverse !== dotGit) return false;

    const commonPointer = readFileSync(join(evidence.gitDir, "commondir"), "utf8").trim();
    const resolvedCommon = realpathSync(isAbsolute(commonPointer) ? commonPointer : resolve(evidence.gitDir, commonPointer));
    if (resolvedCommon !== evidence.gitCommonDir) return false;

    return true;
  } catch {
    return false;
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
