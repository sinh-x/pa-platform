import { execFileSync } from "node:child_process";
import { buildBranchName, validateBranchName } from "../../tickets/git-validation.js";
import { getBranchPattern, resolveRepoExecutionPath } from "../../repos.js";
import { recordRepositoryBranchCleanupByDeployment } from "../../deploy/repository-lifecycle.js";
import { TicketStore } from "../../tickets/store.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

function git(args: string[], cwd: string, io: Required<CliIo>): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`git ${args.join(" ")} failed: ${message}`);
    throw error;
  }
}

function gitQuiet(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function runBranchCreate(argv: string[], io: Required<CliIo>): number {
  const ticketIds: string[] = [];
  let topic: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--topic") {
      if (i + 1 < argv.length) {
        topic = argv[i + 1];
        i += 1;
      }
    } else {
      ticketIds.push(argv[i]);
    }
  }

  if (ticketIds.length === 0) return printError("branch create requires at least one ticket id", io);
  if (!topic) return printError("branch create requires --topic <slug>", io);

  const repository = resolveRepoExecutionPath();
  const repo = repository.repo;

  const store = new TicketStore();
  for (const id of ticketIds) {
    if (!store.get(id)) {
      io.stderr(`Warning: ticket "${id}" not found`);
    }
  }

  const pattern = getBranchPattern(repo);

  let branch: string;
  try {
    branch = buildBranchName(ticketIds, topic, pattern);
  } catch (error) {
    return printError(error instanceof Error ? error.message : String(error), io);
  }

  const existing = gitQuiet(["rev-parse", "--verify", `refs/heads/${branch}`], repository.repoRoot);
  if (existing) return printError(`Branch "${branch}" already exists`, io);

  const developBranch = repo.developBranch ?? "develop";
  try {
    const developRef = gitQuiet(["rev-parse", "--verify", `refs/heads/${developBranch}`], repository.repoRoot);
    if (!developRef) {
      git(["fetch", "origin", developBranch], repository.repoRoot, io);
      git(["checkout", "-b", branch, `origin/${developBranch}`], repository.repoRoot, io);
    } else {
      git(["checkout", "-b", branch, developBranch], repository.repoRoot, io);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return printError(`Failed to create branch: ${message}`, io);
  }

  io.stdout(`Created and checked out ${branch}`);
  return 0;
}

function runBranchValidate(io: Required<CliIo>): number {
  const repository = resolveRepoExecutionPath();
  const repo = repository.repo;
  const pattern = getBranchPattern(repo);

  const currentBranch = git(["branch", "--show-current"], repository.repoRoot, io);
  if (!currentBranch) return printError("Failed to determine current branch", io);

  if (validateBranchName(currentBranch, pattern)) return 0;

  const baseBranches = [repo.mainBranch ?? "main", repo.developBranch ?? "develop"];
  if (baseBranches.includes(currentBranch)) {
    io.stdout(`Warning: "${currentBranch}" is a base branch, not a feature branch`);
  } else {
    io.stdout(`Warning: "${currentBranch}" does not match the configured branch pattern (${pattern})`);
  }
  return 0;
}

function runBranchRecordCleanup(argv: string[], io: Required<CliIo>): number {
  let featureBranch: string | undefined;
  let mergeEvidence: string | undefined;
  let deleteLocal = false;
  let deleteRemote = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--feature" || arg === "--merge-evidence") {
      const value = argv[i + 1];
      if (!value) return printError(`${arg} requires a value`, io);
      if (arg === "--feature") featureBranch = value;
      else mergeEvidence = value;
      i += 1;
    } else if (arg === "--delete-local") deleteLocal = true;
    else if (arg === "--delete-remote") deleteRemote = true;
    else return printError(`Unknown branch record-cleanup option: ${arg}`, io);
  }
  if (!featureBranch) return printError("branch record-cleanup requires --feature <branch>", io);
  if (!mergeEvidence) return printError("branch record-cleanup requires --merge-evidence <evidence>", io);
  const deploymentDir = process.env["PA_DEPLOYMENT_DIR"];
  const leaseToken = process.env["PA_REPOSITORY_LEASE_TOKEN"];
  if (!deploymentDir || !leaseToken) return printError("branch record-cleanup requires an active mutating deployment lifecycle", io);
  recordRepositoryBranchCleanupByDeployment(deploymentDir, featureBranch, mergeEvidence, { deleteLocal, deleteRemote }, leaseToken);
  io.stdout(`Recorded authenticated cleanup evidence for ${featureBranch}`);
  return 0;
}

function printBranchHelp(io: Required<CliIo>): number {
  io.stdout("Usage: branch <create|validate|record-cleanup> [options]");
  io.stdout("");
  io.stdout("Commands:");
  io.stdout("  create <ticket-id...> --topic <slug>  Create a feature branch in the registered checkout");
  io.stdout("  validate                              Validate the registered checkout's current branch");
  io.stdout("  record-cleanup --feature <branch> --merge-evidence <evidence> [--delete-local] [--delete-remote]");
  io.stdout("");
  io.stdout("Repository: infer CWD Git identity, then operate only at its exact configured registered path.");
  return 0;
}

export function runBranchCommand(argv: string[], io: Required<CliIo>): number {
  const subcommand = argv[0];
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") return printBranchHelp(io);
  if (subcommand === "create") return runBranchCreate(argv.slice(1), io);
  if (subcommand === "validate") return runBranchValidate(io);
  if (subcommand === "record-cleanup") return runBranchRecordCleanup(argv.slice(1), io);
  io.stderr(`Unknown branch subcommand: ${subcommand}`);
  io.stderr("Available subcommands: create, validate, record-cleanup");
  return 1;
}
