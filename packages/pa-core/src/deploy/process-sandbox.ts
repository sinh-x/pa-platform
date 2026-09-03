import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAiUsageDir } from "../paths.js";
import type { ExecutionPlan } from "./plan.js";

export interface RuntimeProcessLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Wrap a real reader process in a mount namespace where project Git state is read-only. */
export function constrainRuntimeProcess(
  plan: ExecutionPlan | undefined,
  command: string,
  args: readonly string[],
  cwd: string,
): RuntimeProcessLaunch {
  if (!plan || plan.repositoryAccess === "mutating") return { command, args, cwd };
  if (cwd !== plan.repositoryCwd || cwd !== plan.repoRoot) {
    throw new Error(`Read-only runtime sandbox requires the exact registered repository CWD ${plan.repoRoot}; received ${cwd}.`);
  }

  const protectedPaths = repositoryStatePaths(plan.repoRoot);
  const sandboxArgs: string[] = ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "--tmpfs", "/proc"];
  for (const path of writableRuntimePaths(plan)) sandboxArgs.push("--bind", path, path);
  for (const path of protectedPaths) sandboxArgs.push("--ro-bind", path, path);
  sandboxArgs.push("--chdir", plan.repositoryCwd, "--", command, ...args);
  return { command: "bwrap", args: Object.freeze(sandboxArgs), cwd: plan.repositoryCwd };
}

/** Reject parent-process setup writes that would bypass a reader's sandbox. */
export function assertReadOnlySetupPathsOutsideRepository(plan: ExecutionPlan, paths: readonly string[]): void {
  if (plan.repositoryAccess !== "read-only") return;
  const root = realpathSync(plan.repoRoot);
  for (const path of paths) {
    const target = physicalPath(path);
    if (inside(root, target)) {
      throw new Error(`Read-only deployment rejected because adapter setup path ${target} overlaps registered repository ${root}. Move the repository or adapter configuration before retrying.`);
    }
  }
}

function writableRuntimePaths(plan: ExecutionPlan): string[] {
  const home = homedir();
  const candidates = [
    tmpdir(),
    getAiUsageDir(),
    plan.lifecycle.deploymentDir,
    dirname(plan.lifecycle.activityLogPath),
    dirname(plan.lifecycle.registryDbPath),
    process.env["XDG_RUNTIME_DIR"],
    process.env["XDG_CACHE_HOME"],
    process.env["XDG_STATE_HOME"],
    process.env["XDG_DATA_HOME"],
    join(home, ".cache"),
    join(home, ".local", "share"),
    join(home, ".config", "opencode"),
    join(home, ".claude"),
    join(home, ".factory"),
    join(home, ".pi"),
  ].filter((path): path is string => Boolean(path && isAbsolute(path) && existsSync(path)));
  const paths = [...new Set(candidates.map((path) => realpathSync(path)))];
  return paths.filter((path) => !paths.some((parent) => parent !== path && inside(parent, path)));
}

function repositoryStatePaths(repoRoot: string): string[] {
  if (!isAbsolute(repoRoot) || !existsSync(repoRoot)) {
    throw new Error(`Read-only runtime sandbox requires an existing absolute registered repository path: ${repoRoot}.`);
  }
  const root = realpathSync(repoRoot);
  const paths = [root];
  for (const flag of ["--git-dir", "--git-common-dir"] as const) {
    let raw: string;
    try {
      raw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", flag], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw new Error(`Read-only runtime sandbox could not resolve repository metadata for ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const path = realpathSync(isAbsolute(raw) ? raw : resolve(repoRoot, raw));
    if (!inside(root, path) && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function inside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function physicalPath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}
