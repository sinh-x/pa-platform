import { validateDeployRequestFields } from "../deploy/index.js";
import type { CoreExecutionHooks, DeployRequest } from "../deploy/index.js";
import { appendRegistryEvent, getDeploymentEvents, queryDeploymentStatus, queryDeploymentStatuses } from "../registry/index.js";
import { listRepos } from "../repos.js";
import { BOARD_COLUMNS, buildBoardView, getTeamBoard, getTeamStatusSummaries } from "../tickets/index.js";
import { getTeamRuntimeStatus, listTeamConfigs } from "../teams/index.js";
import type { DeploymentStatus } from "../types.js";

export interface CliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface RunCoreCommandOptions {
  hooks?: CoreExecutionHooks;
  io?: CliIo;
  now?: Date;
}

export async function runCoreCommand(argv: string[], opts: RunCoreCommandOptions = {}): Promise<number> {
  const io = normalizeIo(opts.io);
  const [command, ...rest] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      printHelp(io);
      return 0;
    }
    if (command === "repos") return runReposCommand(rest, io);
    if (command === "status") return runStatusCommand(rest, io, opts.now ?? new Date());
    if (command === "deploy") return runDeployCommand(rest, io, opts.hooks ?? {});
    if (command === "board") return runBoardCommand(rest, io);
    if (command === "teams") return runTeamsCommand(rest, io);
    if (command === "registry") return runRegistryCommand(rest, io);
    io.stderr(`Unknown command: ${command}`);
    printHelp(io);
    return 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runRegistryCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") {
    const opts = parseRegistryListArgs(rest);
    if ("error" in opts) {
      io.stderr(opts.error);
      return 1;
    }
    let deployments = queryDeploymentStatuses();
    if (opts.team) deployments = deployments.filter((deployment) => deployment.team === opts.team);
    if (opts.status) deployments = deployments.filter((deployment) => deployment.status === opts.status);
    printDeploymentList(deployments.slice(0, opts.limit ?? 20), io);
    return 0;
  }
  if (subcommand === "show") {
    const deployId = rest[0];
    if (!deployId) {
      io.stderr("registry show requires deploy-id");
      return 1;
    }
    const deployment = queryDeploymentStatus(deployId);
    if (!deployment) {
      io.stderr(`Deployment not found: ${deployId}`);
      return 1;
    }
    printDeploymentDetail(deployment, io);
    return 0;
  }
  if (subcommand === "complete") return runRegistryComplete(rest, io);
  io.stderr(`Unknown registry subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: list, show, complete");
  return 1;
}

function runBoardCommand(argv: string[], io: Required<CliIo>): number {
  const opts = parseBoardArgs(argv);
  if ("error" in opts) {
    io.stderr(opts.error);
    return 1;
  }
  const board = buildBoardView(opts.project, { assignee: opts.assignee, excludeTags: ["backlog", "archived"], excludeTypes: ["fyi", "work-report"] });
  io.stdout(`Board: ${board.project} (${board.total} tickets)`);
  for (const column of board.columns) {
    io.stdout(`\n${column.status} (${column.count})`);
    if (column.tickets.length === 0) {
      io.stdout("  (empty)");
      continue;
    }
    for (const ticket of column.tickets) io.stdout(`  ${ticket.id.padEnd(8)} [${ticket.priority}] ${ticket.title}${ticket.hasRunningDeployment ? " [deploying]" : ""}`);
  }
  return 0;
}

function runTeamsCommand(argv: string[], io: Required<CliIo>): number {
  const opts = parseTeamsArgs(argv);
  if ("error" in opts) {
    io.stderr(opts.error);
    return 1;
  }
  if (opts.name) {
    const board = getTeamBoard(opts.name, { excludeTags: opts.all ? undefined : ["backlog", "archived"] });
    io.stdout(`${opts.name} (${board.total} tickets)`);
    for (const column of board.columns) {
      if (column.count === 0) continue;
      io.stdout(`\n${column.status} (${column.count})`);
      for (const ticket of column.tickets) io.stdout(`  ${ticket.id.padEnd(8)} [${ticket.priority}] ${ticket.title}`);
    }
    const running = getTeamRuntimeStatus(opts.name).runningDeployments;
    io.stdout(running.length > 0 ? `\ndeployments: ${running.join(", ")}` : "\ndeployments: none running");
    return 0;
  }

  const summaries = new Map(getTeamStatusSummaries(undefined, opts.all ? {} : { excludeTags: ["backlog", "archived"] }).map((summary) => [summary.assignee, summary]));
  io.stdout(`${"TEAM".padEnd(18)} ${"MODEL".padEnd(8)} ${BOARD_COLUMNS.map((status) => status.slice(0, 4).toUpperCase().padEnd(5)).join("")} DEPLOY`);
  for (const team of listTeamConfigs()) {
    const status = getTeamRuntimeStatus(team.name);
    const summary = summaries.get(team.name);
    const counts = BOARD_COLUMNS.map((column) => String(summary?.counts[column] ?? 0).padEnd(5)).join("");
    io.stdout(`${team.name.padEnd(18)} ${status.model.padEnd(8)} ${counts} ${(status.runningDeployments[0] ?? "-")}`);
  }
  return 0;
}

function runReposCommand(argv: string[], io: Required<CliIo>): number {
  const subcommand = argv[0];
  if (subcommand !== "list") {
    io.stderr(`Unknown repos subcommand: ${subcommand ?? ""}`.trim());
    io.stderr("Available subcommands: list");
    return 1;
  }
  const repos = listRepos();
  if (repos.length === 0) {
    io.stdout("No repos configured.");
    return 0;
  }
  const nameW = Math.max(4, ...repos.map((repo) => repo.name.length));
  const pathW = Math.max(4, ...repos.map((repo) => repo.path.length));
  const pad = (value: string, width: number) => value.padEnd(width);
  io.stdout(`  ${pad("NAME", nameW)}  ${pad("PATH", pathW)}  DESCRIPTION`);
  io.stdout(`  ${"-".repeat(nameW)}  ${"-".repeat(pathW)}  -----------`);
  for (const repo of repos) io.stdout(`  ${pad(repo.name, nameW)}  ${pad(repo.path, pathW)}  ${repo.description ?? ""}`);
  return 0;
}

async function runDeployCommand(argv: string[], io: Required<CliIo>, hooks: CoreExecutionHooks): Promise<number> {
  const parsed = parseDeployArgs(argv);
  if ("error" in parsed) {
    io.stderr(parsed.error);
    return 1;
  }
  const validated = validateDeployRequestFields(parsed.fields);
  if ("error" in validated) {
    io.stderr(validated.error);
    return 1;
  }
  if (!hooks.deploy) {
    io.stderr("Deployment execution requires an adapter hook");
    return 1;
  }

  const result = await hooks.deploy(validated.request);
  if (result.status === "failed") {
    io.stderr(result.reason ?? "Deployment failed");
    return 1;
  }
  io.stdout(`Deployment pending: ${result.deploymentId ?? "(adapter-managed)"}`);
  return 0;
}

function runStatusCommand(argv: string[], io: Required<CliIo>, now: Date): number {
  const opts = parseStatusArgs(argv);
  if ("error" in opts) {
    io.stderr(opts.error);
    return 1;
  }
  if (opts.deployId) {
    const deployment = queryDeploymentStatus(opts.deployId);
    if (!deployment) {
      io.stderr(`Deployment not found: ${opts.deployId}`);
      return 1;
    }
    printDeploymentDetail(deployment, io);
    return 0;
  }

  let deployments = queryDeploymentStatuses();
  if (opts.running) deployments = deployments.filter((deployment) => deployment.status === "running");
  if (opts.team) deployments = deployments.filter((deployment) => deployment.team === opts.team);
  if (opts.today) deployments = deployments.filter((deployment) => localDate(deployment.started_at) === localDate(now.toISOString()));
  if (opts.recent !== undefined) deployments = deployments.slice(0, opts.recent);
  printDeploymentList(deployments, io);
  return 0;
}

function parseDeployArgs(argv: string[]): { fields: Record<string, unknown> } | { error: string } {
  const [team, ...rest] = argv;
  if (!team || team.startsWith("-")) return { error: "team is required" };
  const fields: Record<string, unknown> = { team };
  const flagMap: Record<string, keyof DeployRequest> = { "--mode": "mode", "--objective": "objective", "--repo": "repo", "--ticket": "ticket", "--timeout": "timeout" };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    const key = flagMap[arg];
    if (!key) return { error: `Unsupported deploy option: ${arg}` };
    const value = rest[i + 1];
    if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
    fields[key] = key === "timeout" ? Number(value) : value;
    i += 1;
  }
  return { fields };
}

function parseStatusArgs(argv: string[]): { deployId?: string; running?: boolean; team?: string; recent?: number; today?: boolean } | { error: string } {
  const opts: { deployId?: string; running?: boolean; team?: string; recent?: number; today?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--running") opts.running = true;
    else if (arg === "--today") opts.today = true;
    else if (arg === "--team") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--team requires a value" };
      opts.team = value;
      i += 1;
    } else if (arg === "--recent") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--recent requires a value" };
      const recent = Number(value);
      if (!Number.isInteger(recent) || recent < 1) return { error: "--recent must be a positive integer" };
      opts.recent = recent;
      i += 1;
    } else if (arg.startsWith("-")) return { error: `Unsupported status option: ${arg}` };
    else if (!opts.deployId) opts.deployId = arg;
    else return { error: `Unexpected status argument: ${arg}` };
  }
  return opts;
}

function parseBoardArgs(argv: string[]): { project?: string; assignee?: string } | { error: string } {
  const opts: { project?: string; assignee?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--project") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--project requires a value" };
      opts.project = value;
      i += 1;
    } else if (arg === "--assignee") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--assignee requires a value" };
      opts.assignee = value;
      i += 1;
    } else if (arg === "--all") {
      // Accepted for compatibility; no filter is applied by default.
    } else return { error: `Unsupported board option: ${arg}` };
  }
  return opts;
}

function parseTeamsArgs(argv: string[]): { name?: string; all?: boolean } | { error: string } {
  const opts: { name?: string; all?: boolean } = {};
  for (const arg of argv) {
    if (arg === "--all") opts.all = true;
    else if (arg.startsWith("-")) return { error: `Unsupported teams option: ${arg}` };
    else if (!opts.name) opts.name = arg;
    else return { error: `Unexpected teams argument: ${arg}` };
  }
  return opts;
}

function parseRegistryListArgs(argv: string[]): { team?: string; status?: DeploymentStatus["status"]; limit?: number } | { error: string } {
  const opts: { team?: string; status?: DeploymentStatus["status"]; limit?: number } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--team") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--team requires a value" };
      opts.team = value;
      i += 1;
    } else if (arg === "--status") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--status requires a value" };
      opts.status = value as DeploymentStatus["status"];
      i += 1;
    } else if (arg === "--limit") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--limit requires a value" };
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1) return { error: "--limit must be a positive integer" };
      opts.limit = limit;
      i += 1;
    } else return { error: `Unsupported registry list option: ${arg}` };
  }
  return opts;
}

function runRegistryComplete(argv: string[], io: Required<CliIo>): number {
  const [deployId, ...rest] = argv;
  if (!deployId) {
    io.stderr("registry complete requires deploy-id");
    return 1;
  }
  const deployment = queryDeploymentStatus(deployId);
  if (!deployment) {
    io.stderr(`Deployment not found: ${deployId}`);
    return 1;
  }
  const parsed = parseRegistryCompleteArgs(rest);
  if ("error" in parsed) {
    io.stderr(parsed.error);
    return 1;
  }
  appendRegistryEvent({ deployment_id: deployId, team: deployment.team, event: "completed", timestamp: new Date().toISOString(), status: parsed.status, summary: parsed.summary, log_file: parsed.logFile });
  io.stdout(`Completed ${deployId} with status ${parsed.status}`);
  return 0;
}

function parseRegistryCompleteArgs(argv: string[]): { status: "success" | "partial" | "failed"; summary?: string; logFile?: string } | { error: string } {
  const opts: { status?: "success" | "partial" | "failed"; summary?: string; logFile?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--status") {
      const value = argv[i + 1];
      if (value !== "success" && value !== "partial" && value !== "failed") return { error: "--status must be success, partial, or failed" };
      opts.status = value;
      i += 1;
    } else if (arg === "--summary") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--summary requires a value" };
      opts.summary = value;
      i += 1;
    } else if (arg === "--log-file") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--log-file requires a value" };
      opts.logFile = value;
      i += 1;
    } else return { error: `Unsupported registry complete option: ${arg}` };
  }
  return opts.status ? { status: opts.status, summary: opts.summary, logFile: opts.logFile } : { error: "--status is required" };
}

function printDeploymentList(deployments: DeploymentStatus[], io: Required<CliIo>): void {
  io.stdout(`${"DEPLOY-ID".padEnd(12)} ${"TEAM".padEnd(22)} ${"STATUS".padEnd(10)} ${"STARTED".padEnd(20)} ${"ENDED".padEnd(20)} SUMMARY`);
  io.stdout(`${"-----------".padEnd(12)} ${"---------------------".padEnd(22)} ${"---------".padEnd(10)} ${"-------------------".padEnd(20)} ${"-------------------".padEnd(20)} -------`);
  for (const deployment of deployments) {
    const started = shortTs(deployment.started_at);
    const ended = deployment.completed_at ? shortTs(deployment.completed_at) : "-";
    const summary = truncate(deployment.summary ?? "", 50);
    io.stdout(`${deployment.deploy_id.padEnd(12)} ${deployment.team.padEnd(22)} ${deployment.status.padEnd(10)} ${started.padEnd(20)} ${ended.padEnd(20)} ${summary}`);
  }
}

function printDeploymentDetail(deployment: DeploymentStatus, io: Required<CliIo>): void {
  io.stdout(`Deployment: ${deployment.deploy_id}`);
  io.stdout(`  Team:     ${deployment.team}`);
  io.stdout(`  Status:   ${deployment.status}`);
  io.stdout(`  Started:  ${shortTs(deployment.started_at)}`);
  if (deployment.completed_at) io.stdout(`  Ended:    ${shortTs(deployment.completed_at)}`);
  if (deployment.runtime) io.stdout(`  Runtime:  ${deployment.runtime}`);
  if (deployment.agents.length > 0) io.stdout(`  Agents:   ${deployment.agents.join(",")}`);
  if (deployment.pid !== undefined) io.stdout(`  PID:      ${deployment.pid}`);
  if (deployment.summary) io.stdout(`  Summary:  ${deployment.summary}`);
  const eventCount = getDeploymentEvents(deployment.deploy_id).length;
  io.stdout(`  Events:   ${eventCount}`);
}

function printHelp(io: Required<CliIo>): void {
  io.stdout("Usage: pa-core <command> [options]");
  io.stdout("Commands: repos list, status, deploy, board, teams, registry");
}

function normalizeIo(io: CliIo = {}): Required<CliIo> {
  return { stdout: io.stdout ?? ((text) => process.stdout.write(`${text}\n`)), stderr: io.stderr ?? ((text) => process.stderr.write(`${text}\n`)) };
}

function shortTs(timestamp: string): string {
  return timestamp.replace("T", " ").slice(0, 19);
}

function localDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString("en-CA");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
