import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitStateRecorder {
  binDir: string;
  readOperations(): string[];
}

interface PlanWithEnvironment {
  environment: Readonly<Record<string, string | undefined>>;
}

export function assertNoRepositoryAdmissionState(plan: PlanWithEnvironment, primer?: string): void {
  const retiredPlanKeys = [["repository", "Access"].join(""), ["repository", "Lease"].join("")];
  for (const key of retiredPlanKeys) {
    if (key in plan) throw new Error(`Unexpected retired plan key: ${key}`);
  }
  const retiredEnvPrefix = ["PA", "REPOSITORY", "LEASE"].join("_");
  if (Object.keys(plan.environment).some((key) => key.startsWith(retiredEnvPrefix))) {
    throw new Error("Unexpected retired repository admission environment");
  }
  if (primer) {
    const retiredPrimerFields = [["repository", "access"].join("_"), ["repository", "lease"].join("_"), retiredEnvPrefix];
    if (retiredPrimerFields.some((field) => primer.includes(field))) {
      throw new Error("Unexpected retired repository admission primer field");
    }
  }
}

/** Records Git commands that can mutate checkout, branch, or worktree state. */
export function installGitStateRecorder(root: string): GitStateRecorder {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const binDir = join(root, "git-state-recorder-bin");
  const logPath = join(root, "git-state-operations.jsonl");
  const wrapperPath = join(binDir, "git");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(wrapperPath, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const command = args[0];
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
  return {
    binDir,
    readOperations: () => existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
      : [],
  };
}
