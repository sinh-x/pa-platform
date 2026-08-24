import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

export const DEFAULT_BRANCH_PATTERN = "feature/<ticket>-<topic>";
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

function resolveRepoByRemote(remoteUrl: string, repos: Array<{ name: string } & RepoEntry>): ({ name: string } & RepoEntry) | null {
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

export function resolveRepo(nameOrPath: string, remoteUrl?: string): { name: string } & RepoEntry {
  const repos = listRepos();
  const remoteMatch = remoteUrl ? resolveRepoByRemote(remoteUrl, repos) : null;
  const repo = remoteMatch ?? repos.find((candidate) => candidate.name === nameOrPath || candidate.path === expandHome(nameOrPath));
  if (!repo) throw new Error(`Unknown repo: ${nameOrPath}`);
  if (!existsSync(repo.path)) throw new Error(`Repo path does not exist: ${repo.path} (repo: ${repo.name})`);
  return repo;
}

export function resolveRepoByRemoteIdentity(remoteUrl: string): ({ name: string } & RepoEntry) | null {
  return resolveRepoByRemote(remoteUrl, listRepos());
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

function gitCommonDir(cwd: string): string | undefined {
  try {
    return realpathSync(gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd));
  } catch {
    return undefined;
  }
}
