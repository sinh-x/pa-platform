import { execFileSync } from "node:child_process";
import { buildBranchName, validateBranchName } from "../../tickets/git-validation.js";
import { getBranchPattern, resolveProjectFromCwd, resolveRepo } from "../../repos.js";
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

  const project = resolveProjectFromCwd();
  if (!project) return printError("Not in a registered repository", io);
  const repo = resolveRepo(project.key);

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

  const existing = gitQuiet(["rev-parse", "--verify", `refs/heads/${branch}`], project.repoRoot);
  if (existing) return printError(`Branch "${branch}" already exists`, io);

  const developBranch = repo.developBranch ?? "develop";
  try {
    const developRef = gitQuiet(["rev-parse", "--verify", `refs/heads/${developBranch}`], project.repoRoot);
    if (!developRef) {
      git(["fetch", "origin", developBranch], project.repoRoot, io);
      git(["checkout", "-b", branch, `origin/${developBranch}`], project.repoRoot, io);
    } else {
      git(["checkout", "-b", branch, developBranch], project.repoRoot, io);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return printError(`Failed to create branch: ${message}`, io);
  }

  io.stdout(`Created and checked out ${branch}`);
  return 0;
}

function runBranchValidate(io: Required<CliIo>): number {
  const project = resolveProjectFromCwd();
  if (!project) return printError("Not in a registered repository", io);
  const repo = resolveRepo(project.key);
  const pattern = getBranchPattern(repo);

  const currentBranch = git(["branch", "--show-current"], process.cwd(), io);
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

export function runBranchCommand(argv: string[], io: Required<CliIo>): number {
  const subcommand = argv[0];
  if (subcommand === "create") return runBranchCreate(argv.slice(1), io);
  if (subcommand === "validate") return runBranchValidate(io);
  io.stderr(`Unknown branch subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: create, validate");
  return 1;
}
