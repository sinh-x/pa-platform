import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { expandHome, getPlatformHomeDir, getUserConfigPath } from "./paths.js";

// Ported from PA repos.ts at frozen PA source on 2026-04-26; search paths adjusted for pa-platform coexistence.

export interface RepoEntry {
  path: string;
  description?: string;
  prefix?: string;
  mainBranch?: string;
  developBranch?: string;
}

function candidateReposFiles(): string[] {
  return [
    resolve(dirname(getUserConfigPath()), "repos.yaml"),
    resolve(homedir(), ".config/sinh-x/personal-assistant/repos.yaml"),
    resolve(getPlatformHomeDir(), "repos.yaml"),
  ];
}

export function loadReposYaml(): Record<string, RepoEntry> {
  for (const filePath of candidateReposFiles()) {
    if (!existsSync(filePath)) continue;
    const raw = yaml.load(readFileSync(filePath, "utf-8")) as { repos?: Record<string, RepoEntry> } | undefined;
    const repos: Record<string, RepoEntry> = {};
    for (const [key, entry] of Object.entries(raw?.repos ?? {})) {
      repos[key] = { ...entry, path: expandHome(entry.path) };
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

export function resolveRepo(name: string): { name: string } & RepoEntry {
  const repo = loadRepoEntry(name);
  if (!repo) throw new Error(`Unknown repo: ${name}`);
  if (!existsSync(repo.path)) throw new Error(`Repo path does not exist: ${repo.path} (repo: ${name})`);
  return repo;
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

export function resolveProjectFromCwd(cwd = process.cwd()): { key: string; prefix: string } | undefined {
  let repoRoot: string;
  try {
    repoRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }

  return listRepos().find((repo) => repo.path === repoRoot && repo.prefix)
    ? (() => {
        const repo = listRepos().find((candidate) => candidate.path === repoRoot && candidate.prefix)!;
        return { key: repo.name, prefix: repo.prefix! };
      })()
    : undefined;
}
