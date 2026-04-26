import { resolve } from "node:path";
import { BulletinStore } from "../bulletins/index.js";
import type { BulletinBlock } from "../bulletins/index.js";
import { analyzeRepo, formatClassResult, formatExportsResult, formatFileResult, formatFunctionResult, generateSummary, graphExists, loadGraph, queryClass, queryExports, queryFile, queryFunction, saveGraph } from "../codectx/index.js";
import { validateDeployRequestFields } from "../deploy/index.js";
import type { CoreExecutionHooks, DeployRequest } from "../deploy/index.js";
import { generateHealthReport, saveHealthSnapshot } from "../health/index.js";
import type { HealthCategory } from "../health/index.js";
import { appendRegistryEvent, getDeploymentEvents, queryDeploymentStatus, queryDeploymentStatuses } from "../registry/index.js";
import { listRepos } from "../repos.js";
import { BOARD_COLUMNS, buildBoardView, getTeamBoard, getTeamStatusSummaries, TicketStore } from "../tickets/index.js";
import type { CreateTicketInput, Estimate, TicketPriority, TicketStatus, TicketType } from "../tickets/index.js";
import { listSystemdTimers } from "../timers.js";
import { getTeamRuntimeStatus, listTeamConfigs } from "../teams/index.js";
import { TrashStore } from "../trash/index.js";
import type { TrashFileType, TrashStatus } from "../trash/index.js";
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
    if (command === "ticket") return runTicketCommand(rest, io);
    if (command === "bulletin") return runBulletinCommand(rest, io);
    if (command === "health") return runHealthCommand(rest, io);
    if (command === "trash") return runTrashCommand(rest, io);
    if (command === "codectx") return runCodeCtxCommand(rest, io);
    if (command === "timers") return runTimersCommand(io);
    io.stderr(`Unknown command: ${command}`);
    printHelp(io);
    return 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runTimersCommand(io: Required<CliIo>): number {
  try {
    const { timers } = listSystemdTimers();
    for (const timer of timers) io.stdout(`${timer.unit.padEnd(28)} ${timer.team.padEnd(20)} ${timer.next_in}`);
    io.stdout(`Count: ${timers.length}`);
    return 0;
  } catch (error) {
    io.stderr(`Failed to list timers: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function runTicketCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new TicketStore();
  if (subcommand === "list") {
    const opts = parseTicketListArgs(rest);
    if ("error" in opts) return printError(opts.error, io);
    const tickets = store.list(opts);
    for (const ticket of tickets) io.stdout(`${ticket.id.padEnd(8)} ${ticket.status.padEnd(22)} ${ticket.priority.padEnd(8)} ${ticket.assignee.padEnd(22)} ${ticket.title}`);
    io.stdout(`Count: ${tickets.length}`);
    return 0;
  }
  if (subcommand === "show") {
    const id = rest[0];
    if (!id) return printError("ticket show requires id", io);
    const ticket = store.get(id);
    if (!ticket) return printError(`Ticket not found: ${id}`, io);
    io.stdout(`${ticket.id} | ${ticket.status} | ${ticket.priority} | ${ticket.assignee}`);
    io.stdout(ticket.title);
    if (ticket.summary) io.stdout(`Summary: ${ticket.summary}`);
    if (ticket.doc_refs.length > 0) io.stdout(`Doc refs: ${ticket.doc_refs.map((ref) => ref.path).join(", ")}`);
    if (ticket.comments.length > 0) io.stdout(`Comments: ${ticket.comments.length}`);
    return 0;
  }
  if (subcommand === "create") {
    const parsed = parseTicketCreateArgs(rest);
    if ("error" in parsed) return printError(parsed.error, io);
    const ticket = store.create(parsed.input, parsed.actor);
    io.stdout(`Created ${ticket.id}: ${ticket.title}`);
    return 0;
  }
  if (subcommand === "update") {
    const id = rest[0];
    if (!id) return printError("ticket update requires id", io);
    const parsed = parseTicketUpdateArgs(rest.slice(1));
    if ("error" in parsed) return printError(parsed.error, io);
    const ticket = store.update(id, parsed.input, parsed.actor);
    io.stdout(`Updated ${ticket.id}: ${ticket.status}`);
    return 0;
  }
  if (subcommand === "comment") {
    const id = rest[0];
    if (!id) return printError("ticket comment requires id", io);
    const parsed = parseTicketCommentArgs(rest.slice(1));
    if ("error" in parsed) return printError(parsed.error, io);
    const comment = store.comment(id, parsed.author, parsed.content);
    io.stdout(`Commented ${id}: ${comment.id}`);
    return 0;
  }
  io.stderr(`Unknown ticket subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: list, show, create, update, comment");
  return 1;
}

function runBulletinCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new BulletinStore();
  if (subcommand === "list") {
    const bulletins = store.readActive();
    for (const bulletin of bulletins) io.stdout(`${bulletin.id.padEnd(6)} ${String(bulletin.block).padEnd(16)} ${bulletin.title}`);
    io.stdout(`Count: ${bulletins.length}`);
    return 0;
  }
  if (subcommand === "create") {
    const parsed = parseBulletinCreateArgs(rest);
    if ("error" in parsed) return printError(parsed.error, io);
    const bulletin = store.create(parsed);
    io.stdout(`Created ${bulletin.id}: ${bulletin.title}`);
    return 0;
  }
  if (subcommand === "resolve") {
    const id = rest[0];
    if (!id) return printError("bulletin resolve requires id", io);
    if (!store.resolve(id)) return printError(`Bulletin not found: ${id}`, io);
    io.stdout(`Resolved ${id}`);
    return 0;
  }
  io.stderr(`Unknown bulletin subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: list, create, resolve");
  return 1;
}

function runHealthCommand(argv: string[], io: Required<CliIo>): number {
  const parsed = parseHealthArgs(argv);
  if ("error" in parsed) return printError(parsed.error, io);
  const report = generateHealthReport(parsed);
  if (parsed.save) saveHealthSnapshot(report);
  if (parsed.json) io.stdout(JSON.stringify(report));
  else {
    io.stdout(`Health: ${report.overallScore}/100 ${report.scoreLabel}`);
    for (const category of report.categories) io.stdout(`${category.name}: ${category.score} (${category.findings.length} findings)`);
  }
  return 0;
}

function runTrashCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new TrashStore();
  if (subcommand === "list") {
    const opts = parseTrashListArgs(rest);
    if ("error" in opts) return printError(opts.error, io);
    const entries = store.list(opts);
    for (const entry of entries) io.stdout(`${entry.id.padEnd(6)} ${entry.status.padEnd(9)} ${entry.fileType.padEnd(8)} ${entry.originalPath}`);
    io.stdout(`Count: ${entries.length}`);
    return 0;
  }
  if (subcommand === "move") {
    const path = rest[0];
    if (!path) return printError("trash move requires path", io);
    const parsed = parseTrashMoveArgs(rest.slice(1));
    if ("error" in parsed) return printError(parsed.error, io);
    const entry = store.move({ path, reason: parsed.reason, actor: parsed.actor, fileType: parsed.fileType });
    io.stdout(`Trashed ${entry.id}: ${entry.originalPath}`);
    return 0;
  }
  if (subcommand === "show") {
    const id = rest[0];
    if (!id) return printError("trash show requires id", io);
    const entry = store.get(id);
    if (!entry) return printError(`Trash entry not found: ${id}`, io);
    io.stdout(`${entry.id} | ${entry.status} | ${entry.fileType}`);
    io.stdout(`Original: ${entry.originalPath}`);
    io.stdout(`Reason: ${entry.reason}`);
    return 0;
  }
  if (subcommand === "restore") {
    const id = rest[0];
    if (!id) return printError("trash restore requires id", io);
    const force = rest.includes("--force");
    const entry = store.restore(id, { force });
    io.stdout(`Restored ${entry.id}: ${entry.originalPath}`);
    return 0;
  }
  if (subcommand === "purge") {
    const opts = parseTrashPurgeArgs(rest);
    if ("error" in opts) return printError(opts.error, io);
    const purged = store.purge(opts);
    io.stdout(`${opts.dryRun ? "Would purge" : "Purged"}: ${purged.length}`);
    return 0;
  }
  io.stderr(`Unknown trash subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: list, move, show, restore, purge");
  return 1;
}

function runCodeCtxCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === "analyze") {
    const repoPath = rest[0] ? resolve(rest[0]) : process.cwd();
    const result = analyzeRepo(repoPath);
    saveGraph(result.graph);
    io.stdout(`Analyzed ${repoPath}: ${result.processed} files, ${result.errors} errors`);
    io.stdout(generateSummary(result.graph));
    return 0;
  }
  if (subcommand === "summary") {
    const repo = rest[0] ?? process.cwd();
    const graph = loadGraph(repo);
    if (!graph) return printError(`No graph found for ${repo}`, io);
    io.stdout(generateSummary(graph));
    return 0;
  }
  if (subcommand === "query") {
    const [repo, type, target] = rest;
    if (!repo || !type) return printError("codectx query requires repo and type", io);
    const graph = loadGraph(repo);
    if (!graph) return printError(`No graph found for ${repo}`, io);
    if (type === "exports") io.stdout(formatExportsResult(queryExports(graph)));
    else if (type === "file" && target) {
      const result = queryFile(graph, target);
      if (!result) return printError(`File not found: ${target}`, io);
      io.stdout(formatFileResult(result));
    } else if (type === "function" && target) {
      const result = queryFunction(graph, target);
      if (!result) return printError(`Function not found: ${target}`, io);
      io.stdout(formatFunctionResult(result));
    } else if (type === "class" && target) {
      const result = queryClass(graph, target);
      if (!result) return printError(`Class not found: ${target}`, io);
      io.stdout(formatClassResult(result));
    } else return printError(`Unsupported codectx query: ${type}`, io);
    return 0;
  }
  if (subcommand === "exists") {
    const repo = rest[0] ?? process.cwd();
    io.stdout(graphExists(repo) ? "yes" : "no");
    return graphExists(repo) ? 0 : 1;
  }
  io.stderr(`Unknown codectx subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: analyze, summary, query, exists");
  return 1;
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

function parseTicketListArgs(argv: string[]): { project?: string; status?: TicketStatus; assignee?: string; priority?: TicketPriority; type?: TicketType; search?: string } | { error: string } {
  const opts: { project?: string; status?: TicketStatus; assignee?: string; priority?: TicketPriority; type?: TicketType; search?: string } = {};
  const result = parseFlagPairs(argv, new Set(["--project", "--status", "--assignee", "--priority", "--type", "--search"]));
  if ("error" in result) return result;
  if (result.values["--project"]) opts.project = result.values["--project"];
  if (result.values["--status"]) opts.status = result.values["--status"] as TicketStatus;
  if (result.values["--assignee"]) opts.assignee = result.values["--assignee"];
  if (result.values["--priority"]) opts.priority = result.values["--priority"] as TicketPriority;
  if (result.values["--type"]) opts.type = result.values["--type"] as TicketType;
  if (result.values["--search"]) opts.search = result.values["--search"];
  return opts;
}

function parseTicketCreateArgs(argv: string[]): { input: CreateTicketInput; actor: string } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--project", "--title", "--type", "--priority", "--estimate", "--assignee", "--summary", "--description", "--status", "--from", "--to", "--tags", "--actor"]));
  if ("error" in result) return result;
  const values = result.values;
  for (const flag of ["--project", "--title", "--type", "--priority", "--estimate", "--assignee"] as const) {
    if (!values[flag]) return { error: `${flag} is required` };
  }
  return {
    actor: values["--actor"] ?? "pa-core",
    input: {
      project: values["--project"]!,
      title: values["--title"]!,
      summary: values["--summary"] ?? "",
      description: values["--description"] ?? "",
      status: (values["--status"] ?? "idea") as TicketStatus,
      priority: values["--priority"] as TicketPriority,
      type: values["--type"] as TicketType,
      assignee: values["--assignee"]!,
      estimate: values["--estimate"] as Estimate,
      from: values["--from"] ?? "",
      to: values["--to"] ?? "",
      tags: splitCsv(values["--tags"]),
      blockedBy: [],
      doc_refs: [],
      comments: [],
    },
  };
}

function parseTicketUpdateArgs(argv: string[]): { input: { status?: TicketStatus; assignee?: string; priority?: TicketPriority; tags?: string[]; add_doc_ref?: { path: string; type?: string; primary?: boolean } }; actor: string } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--status", "--assignee", "--priority", "--tags", "--doc-ref", "--actor"]));
  if ("error" in result) return result;
  const values = result.values;
  const input: { status?: TicketStatus; assignee?: string; priority?: TicketPriority; tags?: string[]; add_doc_ref?: { path: string; type?: string; primary?: boolean } } = {};
  if (values["--status"]) input.status = values["--status"] as TicketStatus;
  if (values["--assignee"]) input.assignee = values["--assignee"];
  if (values["--priority"]) input.priority = values["--priority"] as TicketPriority;
  if (values["--tags"]) input.tags = splitCsv(values["--tags"]);
  if (values["--doc-ref"]) input.add_doc_ref = parseDocRefFlag(values["--doc-ref"]!);
  return { input, actor: values["--actor"] ?? "pa-core" };
}

function parseTicketCommentArgs(argv: string[]): { author: string; content: string } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--author", "--content"]));
  if ("error" in result) return result;
  if (!result.values["--author"]) return { error: "--author is required" };
  if (!result.values["--content"]) return { error: "--content is required" };
  return { author: result.values["--author"]!, content: result.values["--content"]! };
}

function parseBulletinCreateArgs(argv: string[]): { title: string; block: BulletinBlock; except?: string[]; body: string } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--title", "--block", "--except", "--message"]));
  if ("error" in result) return result;
  const title = result.values["--title"];
  const block = result.values["--block"];
  if (!title) return { error: "--title is required" };
  if (!block) return { error: "--block is required" };
  return { title, block: block === "all" ? "all" : splitCsv(block), except: splitCsv(result.values["--except"]), body: result.values["--message"] ?? "" };
}

function parseHealthArgs(argv: string[]): { category?: HealthCategory; days?: number; since?: string; json?: boolean; save?: boolean } | { error: string } {
  const opts: { category?: HealthCategory; days?: number; since?: string; json?: boolean; save?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") opts.json = true;
    else if (arg === "--save") opts.save = true;
    else if (arg === "--days") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--days requires a value" };
      const days = Number(value);
      if (!Number.isInteger(days) || days < 1) return { error: "--days must be a positive integer" };
      opts.days = days;
      i += 1;
    } else if (arg === "--since") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--since requires a value" };
      opts.since = value;
      i += 1;
    } else if (arg.startsWith("-")) return { error: `Unsupported health option: ${arg}` };
    else if (!opts.category) opts.category = arg as HealthCategory;
    else return { error: `Unexpected health argument: ${arg}` };
  }
  return opts;
}

function parseTrashListArgs(argv: string[]): { status?: TrashStatus; fileType?: TrashFileType; search?: string } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--status", "--type", "--search"]));
  if ("error" in result) return result;
  return { status: result.values["--status"] as TrashStatus | undefined, fileType: result.values["--type"] as TrashFileType | undefined, search: result.values["--search"] };
}

function parseTrashMoveArgs(argv: string[]): { reason: string; actor: string; fileType?: TrashFileType } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--reason", "--actor", "--type"]));
  if ("error" in result) return result;
  if (!result.values["--reason"]) return { error: "--reason is required" };
  return { reason: result.values["--reason"]!, actor: result.values["--actor"] ?? "pa-core", fileType: result.values["--type"] as TrashFileType | undefined };
}

function parseTrashPurgeArgs(argv: string[]): { days?: number; dryRun?: boolean } | { error: string } {
  const opts: { days?: number; dryRun?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--days") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--days requires a value" };
      const days = Number(value);
      if (!Number.isInteger(days) || days < 0) return { error: "--days must be a non-negative integer" };
      opts.days = days;
      i += 1;
    } else return { error: `Unsupported trash purge option: ${arg}` };
  }
  return opts;
}

function parseFlagPairs(argv: string[], allowed: Set<string>): { values: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!allowed.has(flag)) return { error: `Unsupported option: ${flag}` };
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) return { error: `${flag} requires a value` };
    values[flag] = value;
    i += 1;
  }
  return { values };
}

function parseDocRefFlag(value: string): { path: string; type?: string; primary?: boolean } {
  const index = value.indexOf(":");
  if (index > 0 && !value.slice(0, index).includes("/")) return { type: value.slice(0, index), path: value.slice(index + 1) };
  return { path: value };
}

function splitCsv(value: string | undefined): string[] {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function printError(error: string, io: Required<CliIo>): number {
  io.stderr(error);
  return 1;
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
  io.stdout("Commands: repos list, status, deploy, board, teams, registry, ticket, bulletin, health, trash, codectx, timers");
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
