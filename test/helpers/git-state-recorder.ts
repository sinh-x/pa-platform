import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitStateRecorder {
  binDir: string;
  readCommands(): string[][];
  readOperations(): string[][];
}

interface PlanWithRepositoryAdmission {
  environment: Readonly<Record<string, string | undefined>>;
  repositoryAdmission: {
    readonly access: "read-only" | "exclusive-builder" | "non-locking";
    readonly launchMode: "foreground" | "background" | "dry-run";
    readonly ownershipIntent: "none" | "preview" | "acquire-before-spawn";
    readonly force: boolean;
    readonly gitSnapshot?: unknown;
  };
}

function assertNoInternalLeaseFields(plan: PlanWithRepositoryAdmission, primer?: string): void {
  const internalLeasePrefix = ["PA", "REPOSITORY", "LEASE"].join("_");
  if (Object.keys(plan.environment).some((key) => key.startsWith(internalLeasePrefix))) {
    throw new Error("Unexpected internal repository lease environment");
  }
  if (primer?.includes(internalLeasePrefix)) throw new Error("Unexpected internal repository lease primer field");
}

export function assertNonLockingRepositoryAdmission(plan: PlanWithRepositoryAdmission, primer?: string): void {
  if (plan.repositoryAdmission.access !== "non-locking" || plan.repositoryAdmission.ownershipIntent !== "none" || plan.repositoryAdmission.gitSnapshot !== undefined) {
    throw new Error("Expected explicit non-locking repository admission without ownership or Git status evidence");
  }
  assertNoInternalLeaseFields(plan, primer);
}

export function assertBuilderExclusiveRepositoryAdmission(plan: PlanWithRepositoryAdmission, primer?: string): void {
  if (plan.repositoryAdmission.access !== "exclusive-builder" || plan.repositoryAdmission.ownershipIntent !== "acquire-before-spawn" || plan.repositoryAdmission.gitSnapshot === undefined) {
    throw new Error("Expected builder-exclusive repository admission with pre-spawn Git evidence");
  }
  assertNoInternalLeaseFields(plan, primer);
}

/** Records Git commands that can mutate checkout, branch, or worktree state. */
export function installGitStateRecorder(root: string): GitStateRecorder {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const binDir = join(root, "git-state-recorder-bin");
  const commandLogPath = join(root, "git-state-commands.jsonl");
  const logPath = join(root, "git-state-operations.jsonl");
  const wrapperPath = join(binDir, "git");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(wrapperPath, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const command = args[0];
appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify(args) + "\\n");
const branchDelete = command === "branch" && args.slice(1).some((arg) => arg === "-d" || arg === "-D" || arg === "--delete");
if (["checkout", "reset", "clean", "restore", "worktree"].includes(command) || branchDelete) {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: "inherit" });
if (result.error) {
  process.stderr.write(result.error.message + "\\n");
  process.exit(127);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
`, "utf8");
  chmodSync(wrapperPath, 0o755);
  const readLog = (path: string): string[][] => existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];
  return {
    binDir,
    readCommands: () => readLog(commandLogPath),
    readOperations: () => existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
      : [],
  };
}
