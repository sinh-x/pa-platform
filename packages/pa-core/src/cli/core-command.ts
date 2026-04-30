import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readActivityEvents } from "../activity/index.js";
import { BulletinStore } from "../bulletins/index.js";
import type { BulletinBlock } from "../bulletins/index.js";
import { analyzeRepo, formatClassResult, formatExportsResult, formatFileResult, formatFunctionResult, generateSummary, graphExists, loadGraph, queryClass, queryExports, queryFile, queryFunction, saveGraph } from "../codectx/index.js";
import { DEFAULT_DEPLOY_TIMEOUT_SECONDS, MAX_DEPLOY_TIMEOUT_SECONDS, MIN_DEPLOY_TIMEOUT_SECONDS, validateDeployRequestFields, withResolvedDeployTimeout } from "../deploy/index.js";
import type { CoreExecutionHooks, DeployRequest } from "../deploy/index.js";
import { formatPrimerHealthSummary, generateHealthReport, listHealthSnapshots, saveHealthSnapshot } from "../health/index.js";
import type { HealthCategory } from "../health/index.js";
import { getAiUsageDir, getDeploymentDir, getSignalDir } from "../paths.js";
import { appendRegistryEvent, getDb, getDeploymentEvents, queryDeploymentStatus, queryDeploymentStatuses } from "../registry/index.js";
import { listRepos, resolveProject, resolveProjectFromCwd } from "../repos.js";
import { extractNotesSinceLastRun, fetchNotesSince, findNoteToSelfConversation, getOwnIdentity, getSignalPaths, markSignalNoteAsProcessed, readCollectorState } from "../signal/reader.js";
import { routeMessage } from "../signal/router.js";
import { cleanSignalEntries, writeRoutedMessage } from "../signal/writers.js";
import { assertNoSensitiveMatch, readGuardedLocalTextFile } from "../sensitive-patterns.js";
import { BOARD_COLUMNS, buildBoardView, getTeamBoard, getTeamStatusSummaries } from "../tickets/index.js";
import { listSystemdTimers } from "../timers.js";
import { getTeamRuntimeStatus, listTeamConfigs, loadTeamConfig } from "../teams/index.js";
import { TrashStore } from "../trash/index.js";
import { formatLocal, formatLocalShort, nowUtc, parseTimestamp } from "../time.js";
import type { TrashFileType, TrashStatus } from "../trash/index.js";
import type { DeploymentStatus } from "../types.js";
import { runTicketCommand } from "./commands/ticket.js";
import { formatBulletinList, formatRegistryList, formatRegistryShow, formatReposList, formatTeamDetail, formatTeamList, formatTeamsJson, formatTimers, formatTrashList, formatTrashShow } from "./formatters.js";

export interface CliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface RunCoreCommandOptions {
  hooks?: CoreExecutionHooks;
  io?: CliIo;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  binaryName?: string;
}

const STATUS_WAIT_POLL_INTERVAL_SECONDS = 10;
const STATUS_WAIT_OVERRIDE_ENV = "PA_STATUS_WAIT_TIMEOUT";

export async function runCoreCommand(argv: string[], opts: RunCoreCommandOptions = {}): Promise<number> {
  const io = normalizeIo(opts.io);
  const [command, ...rest] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      printHelp(io, opts.binaryName ?? defaultBinaryName());
      return 0;
    }
    if (command === "repos") return runReposCommand(rest, io);
    if (command === "status") return runStatusCommand(rest, io, opts.now ?? new Date(), { sleep: opts.sleep ?? sleep, clock: opts.clock ?? Date.now });
    if (command === "deploy") return runDeployCommand(rest, io, opts.hooks ?? {});
    if (command === "serve" || command === "stop" || command === "restart" || command === "serve-status") return runServeCommand(command, rest, io, opts.hooks ?? {});
    if (command === "schedule") return runScheduleCommand(rest, io);
    if (command === "remove-timer") return runRemoveTimerCommand(rest, io);
    if (command === "board") return runBoardCommand(rest, io);
    if (command === "teams") return runTeamsCommand(rest, io);
    if (command === "registry") return runRegistryCommand(rest, io);
    if (command === "ticket") return runTicketCommand(rest, io);
    if (command === "bulletin") return runBulletinCommand(rest, io);
    if (command === "health") return runHealthCommand(rest, io);
    if (command === "trash") return runTrashCommand(rest, io);
    if (command === "codectx") return runCodeCtxCommand(rest, io);
    if (command === "timers") return runTimersCommand(rest, io);
    if (command === "signal") return runSignalCommand(rest, io);
    io.stderr(`Unknown command: ${command}`);
    printHelp(io, opts.binaryName ?? defaultBinaryName());
    return 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runTimersCommand(argv: string[], io: Required<CliIo>): number {
  const json = consumeJsonFlag(argv);
  if ("error" in json) return printError(json.error, io);
  try {
    io.stderr("Reading systemd timers...");
    const { timers } = listSystemdTimers();
    io.stdout(json.json ? JSON.stringify(timers, null, 2) : formatTimers(timers));
    return 0;
  } catch (error) {
    io.stderr(`Failed to list timers: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function runServeCommand(command: string, argv: string[], io: Required<CliIo>, hooks: CoreExecutionHooks): Promise<number> {
  if (!hooks.serve) return printError("Serve process management requires an adapter hook", io);
  const nested = command === "serve" && ["stop", "restart", "status"].includes(argv[0] ?? "") ? argv[0] : undefined;
  const action = nested ?? (command === "serve" ? "start" : command === "serve-status" ? "status" : command);
  const result = await hooks.serve(action as "start" | "stop" | "restart" | "status");
  io.stdout(result.message ?? `Serve ${action}: ${result.status}`);
  return result.status === "error" || result.status === "failed" ? 1 : 0;
}

function runScheduleCommand(argv: string[], io: Required<CliIo>): number {
  const parsed = parseScheduleArgs(argv);
  if ("error" in parsed) return printError(parsed.error, io);
  const resolved = resolveSchedule(parsed.spec, parsed.repeat, parsed.times, parsed.command);
  if ("error" in resolved) return printError(resolved.error, io);
  const systemdDir = resolve(process.env["XDG_CONFIG_HOME"] ?? resolve(homedir(), ".config"), "systemd/user");
  const servicePath = resolve(systemdDir, `${resolved.unitName}.service`);
  const timerPath = resolve(systemdDir, `${resolved.unitName}.timer`);
  if (!parsed.dryRun) {
    mkdirSync(systemdDir, { recursive: true });
    writeFileSync(servicePath, buildServiceUnit(resolved.description, resolved.execCommand));
    writeFileSync(timerPath, buildTimerUnit(resolved.description, parsed.repeat, resolved.timeDisplay, resolved.onCalendarLines));
    execSystemctl(["--user", "daemon-reload"]);
    execSystemctl(["--user", "enable", "--now", `${resolved.unitName}.timer`]);
  }
  io.stdout(`${parsed.dryRun ? "Would schedule" : "Scheduled"}: ${resolved.unitName} (${parsed.repeat}${resolved.timeDisplay ? ` at${resolved.timeDisplay}` : ""})`);
  io.stdout(`Timer: ${resolved.unitName}.timer`);
  io.stdout(`Service: ${servicePath}`);
  return 0;
}

function runRemoveTimerCommand(argv: string[], io: Required<CliIo>): number {
  const parsed = parseRemoveTimerArgs(argv);
  if ("error" in parsed) return printError(parsed.error, io);
  if (!parsed.dryRun && !parsed.yes) return printError("remove-timer is destructive; rerun with --yes to confirm", io);
  const unitName = parsed.name.startsWith("pa-") ? parsed.name : `pa-${parsed.name}`;
  const systemdDir = resolve(process.env["XDG_CONFIG_HOME"] ?? resolve(homedir(), ".config"), "systemd/user");
  const timerPath = resolve(systemdDir, `${unitName}.timer`);
  const servicePath = resolve(systemdDir, `${unitName}.service`);
  if (!parsed.dryRun) {
    io.stderr(`Removing timer ${unitName}...`);
    tryExecSystemctl(["--user", "stop", `${unitName}.timer`]);
    tryExecSystemctl(["--user", "disable", `${unitName}.timer`]);
    if (existsSync(timerPath)) unlinkSync(timerPath);
    if (existsSync(servicePath)) unlinkSync(servicePath);
    execSystemctl(["--user", "daemon-reload"]);
  }
  io.stdout(`${parsed.dryRun ? "Would remove" : "Removed"} timer: ${unitName}`);
  return 0;
}

function runSignalCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "collect") {
    io.stderr(`Unknown signal subcommand: ${subcommand ?? ""}`.trim());
    io.stderr("Available subcommands: collect");
    return 1;
  }
  const opts = parseSignalCollectArgs(rest);
  if ("error" in opts) return printError(opts.error, io);
  if (opts.reprocess) return runSignalReprocess(opts.dryRun, io);
  return runSignalCollect(opts, io);
}

function runBulletinCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new BulletinStore();
  if (subcommand === "list") {
    const json = consumeJsonFlag(rest);
    if ("error" in json) return printError(json.error, io);
    const bulletins = store.readActive();
    io.stdout(json.json ? JSON.stringify(bulletins, null, 2) : formatBulletinList(bulletins));
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
  if (parsed.history) {
    const snapshots = listHealthSnapshots(10);
    for (const snapshot of snapshots) io.stdout(`${snapshot.timestamp} ${String(snapshot.overallScore).padStart(3)}/100 ${snapshot.categories.map((category) => `${category.name}:${category.score}`).join(" ")}`);
    io.stdout(`Count: ${snapshots.length}`);
    return 0;
  }
  const report = generateHealthReport(parsed);
  if (parsed.save) saveHealthSnapshot(report);
  if (parsed.json) io.stdout(JSON.stringify(report));
  else if (parsed.primerSummary) io.stdout(formatPrimerHealthSummary(report));
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
    const { json, ...filters } = opts;
    const entries = store.list(filters);
    io.stdout(json ? JSON.stringify(entries, null, 2) : formatTrashList(entries));
    return 0;
  }
  if (subcommand === "move") {
    const path = rest[0];
    if (!path) return printError("trash move requires path", io);
    const parsed = parseTrashMoveArgs(rest.slice(1));
    if ("error" in parsed) return printError(parsed.error, io);
    if (!parsed.yes) return printError("trash move is destructive; rerun with --yes to confirm", io);
    io.stderr(`Moving to trash: ${path}`);
    const entry = store.move({ path, reason: parsed.reason, actor: parsed.actor, fileType: parsed.fileType });
    io.stdout(`Trashed ${entry.id}: ${entry.originalPath}`);
    return 0;
  }
  if (subcommand === "show") {
    const id = rest[0];
    if (!id) return printError("trash show requires id", io);
    const entry = store.get(id);
    if (!entry) return printError(`Trash entry not found: ${id}`, io);
    const json = consumeJsonFlag(rest.slice(1));
    if ("error" in json) return printError(json.error, io);
    io.stdout(json.json ? JSON.stringify(entry, null, 2) : formatTrashShow(entry));
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
  if (subcommand === "analyze" || subcommand === "refresh") {
    const repoPath = rest[0] ? resolve(rest[0]) : process.cwd();
    const result = analyzeRepo(repoPath);
    saveGraph(result.graph);
    io.stdout(`${subcommand === "refresh" ? "Refreshed" : "Analyzed"} ${repoPath}: ${result.processed} files, ${result.errors} errors`);
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
  if (subcommand === "status") {
    const repo = rest[0] ?? process.cwd();
    const graph = loadGraph(repo);
    if (!graph) {
      io.stdout(`No graph found for: ${repo}`);
      return 1;
    }
    io.stdout(`Graph exists for: ${repo}`);
    io.stdout(`Generated: ${graph.generatedAt}`);
    io.stdout(`Nodes: ${graph.nodeCount}`);
    io.stdout(`Edges: ${graph.edgeCount}`);
    return 0;
  }
  if (subcommand === "query") {
    const queryTypes = new Set(["exports", "file", "function", "fn", "class"]);
    const [first, second, third] = rest;
    const oldStyle = first ? queryTypes.has(first) : false;
    const repo = oldStyle ? third ?? process.cwd() : first;
    const type = oldStyle ? first : second;
    const target = oldStyle ? second : third;
    if (!repo || !type) return printError("codectx query requires repo and type", io);
    const graph = loadGraph(repo);
    if (!graph) return printError(`No graph found for ${repo}`, io);
    if (type === "exports") io.stdout(formatExportsResult(queryExports(graph)));
    else if (type === "file" && target) {
      const result = queryFile(graph, target);
      if (!result) return printError(`File not found: ${target}`, io);
      io.stdout(formatFileResult(result));
    } else if ((type === "function" || type === "fn") && target) {
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
  io.stderr("Available subcommands: analyze, refresh, summary, status, query, exists");
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
    if (opts.since) deployments = deployments.filter((deployment) => deployment.started_at >= opts.since!);
    const rows = deployments.slice(0, opts.limit ?? 20);
    io.stdout(opts.json ? JSON.stringify(rows, null, 2) : formatRegistryList(rows));
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
    const json = consumeJsonFlag(rest.slice(1));
    if ("error" in json) return printError(json.error, io);
    io.stdout(json.json ? JSON.stringify(deployment, null, 2) : formatRegistryShow(deployment, getDeploymentEvents(deployment.deploy_id).length));
    return 0;
  }
  if (subcommand === "complete") return runRegistryComplete(rest, io);
  if (subcommand === "update" || subcommand === "amend") return runRegistryUpdate(rest, io, subcommand === "amend");
  if (subcommand === "search") return runRegistrySearch(rest, io);
  if (subcommand === "analytics") return runRegistryAnalytics(rest, io);
  if (subcommand === "clean") return runRegistryClean(rest, io);
  if (subcommand === "sweep") return runRegistrySweep(rest, io);
  io.stderr(`Unknown registry subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: list, show, complete, update, amend, search, analytics, clean, sweep");
  return 1;
}

function runBoardCommand(argv: string[], io: Required<CliIo>): number {
  const opts = parseBoardArgs(argv);
  if ("error" in opts) {
    io.stderr(opts.error);
    return 1;
  }
  const resolved = resolveBoardProject(opts);
  if ("error" in resolved) return printError(resolved.error, io);
  const board = buildBoardView(resolved.project, { assignee: opts.assignee, excludeTags: ["backlog", "archived"], excludeTypes: ["fyi", "work-report"] });
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
    const running = getTeamRuntimeStatus(opts.name).runningDeployments;
    io.stdout(opts.json ? JSON.stringify({ name: opts.name, board, runningDeployments: running }, null, 2) : formatTeamDetail(opts.name, board, running));
    return 0;
  }

  const summaries = new Map(getTeamStatusSummaries(undefined, opts.all ? {} : { excludeTags: ["backlog", "archived"] }).map((summary) => [summary.assignee, summary]));
  const teams = listTeamConfigs();
  const statuses = [];
  const rows = [];
  for (const team of teams) {
    const status = getTeamRuntimeStatus(team.name);
    statuses.push({ name: team.name, model: status.model, runningDeployments: status.runningDeployments });
    const summary = summaries.get(team.name);
    rows.push({ name: team.name, model: status.model, counts: BOARD_COLUMNS.map((column) => String(summary?.counts[column] ?? 0).padEnd(5)), deployment: status.runningDeployments[0] ?? "-" });
  }
  io.stdout(opts.json ? JSON.stringify(formatTeamsJson(teams, statuses, rows), null, 2) : formatTeamList(rows));
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
  const json = consumeJsonFlag(argv.slice(1));
  if ("error" in json) return printError(json.error, io);
  io.stdout(json.json ? JSON.stringify(repos, null, 2) : formatReposList(repos));
  return 0;
}

async function runDeployCommand(argv: string[], io: Required<CliIo>, hooks: CoreExecutionHooks): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printDeployHelp(io);
    return 0;
  }
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
  if (validated.request.objective) {
    try {
      assertNoSensitiveMatch("content", validated.request.objective);
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (validated.request.listModes) return printDeployModes(validated.request.team, io);
  if (validated.request.validate) return validateDeployConfig(validated.request.team, io);
  const resolved = withResolvedDeployTimeout(validated.request);
  if ("error" in resolved) {
    io.stderr(resolved.error);
    return 1;
  }
  if (!hooks.deploy) {
    io.stderr("Deployment execution requires an adapter hook");
    return 1;
  }

  const result = await hooks.deploy(resolved.request);
  if (result.status === "failed") {
    io.stderr(result.reason ?? "Deployment failed");
    return 1;
  }
  const label = result.status === "success" ? "completed" : "pending";
  io.stdout(`Deployment ${label}: ${result.deploymentId ?? "(adapter-managed)"}`);
  return 0;
}

function parseScheduleArgs(argv: string[]): { spec: string; repeat: "hourly" | "daily" | "weekly" | "monthly"; times: string[]; command: string; dryRun: boolean } | { error: string } {
  const opts = { repeat: "daily" as "hourly" | "daily" | "weekly" | "monthly", times: [] as string[], command: defaultPaCommand(), dryRun: false };
  let spec = "";
  let positionalRepeatSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--repeat") {
      const value = argv[i + 1];
      if (value !== "hourly" && value !== "daily" && value !== "weekly" && value !== "monthly") return { error: "--repeat must be hourly, daily, weekly, or monthly" };
      opts.repeat = value;
      i += 1;
    } else if (arg === "--time") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--time requires a value" };
      opts.times.push(value);
      i += 1;
    } else if (arg === "--command") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--command requires a value" };
      opts.command = value;
      i += 1;
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("-")) return { error: `Unsupported schedule option: ${arg}` };
    else if (!spec) spec = arg;
    else if (!positionalRepeatSeen && isRepeatValue(arg)) {
      opts.repeat = arg;
      positionalRepeatSeen = true;
    }
    else opts.times.push(arg);
  }
  if (!spec) return { error: "schedule requires spec" };
  return { spec, repeat: opts.repeat, times: opts.times.length > 0 ? opts.times : ["09:00"], command: opts.command, dryRun: opts.dryRun };
}

function isRepeatValue(value: string): value is "hourly" | "daily" | "weekly" | "monthly" {
  return value === "hourly" || value === "daily" || value === "weekly" || value === "monthly";
}

function parseRemoveTimerArgs(argv: string[]): { name: string; dryRun: boolean; yes: boolean } | { error: string } {
  let name = "";
  let dryRun = false;
  let yes = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes") yes = true;
    else if (arg.startsWith("-")) return { error: `Unsupported remove-timer option: ${arg}` };
    else if (!name) name = arg;
    else return { error: `Unexpected remove-timer argument: ${arg}` };
  }
  return name ? { name, dryRun, yes } : { error: "remove-timer requires timer name" };
}

function resolveSchedule(spec: string, repeat: "hourly" | "daily" | "weekly" | "monthly", times: string[], command: string): { unitName: string; description: string; execCommand: string; onCalendarLines: string[]; timeDisplay: string } | { error: string } {
  let unitName: string;
  let description: string;
  let execCommand: string;
  if (spec === "signal:collect") {
    unitName = "pa-signal-collect";
    description = "personal-assistant signal collect";
    execCommand = `${command} signal collect`;
    return { unitName, description, execCommand, onCalendarLines: ["*:0/2:00"], timeDisplay: " every 2 hours" };
  }
  if (spec.startsWith("daily:")) {
    const mode = spec.slice("daily:".length);
    if (!mode || !["plan", "progress", "end"].includes(mode)) return { error: `Invalid daily mode '${mode}'. Use: plan | progress | end` };
    unitName = `pa-daily-${mode}`;
    description = `personal-assistant planner ${mode}`;
    execCommand = `${command} deploy planner --mode ${mode} --background`;
  } else if (spec.includes(":")) {
    const [team, mode] = spec.split(":");
    if (!team || !mode) return { error: `Invalid team:mode syntax '${spec}'. Expected <team>:<mode>.` };
    try {
      loadTeamConfig(team);
    } catch {
      return { error: `Team not found: ${team}` };
    }
    unitName = `pa-${team}-${mode}`;
    description = `personal-assistant ${team}:${mode}`;
    execCommand = `${command} deploy ${team} --mode ${mode} --background`;
  } else {
    try {
      loadTeamConfig(spec);
    } catch {
      return { error: `Team not found: ${spec}` };
    }
    unitName = `pa-${spec}`;
    description = `personal-assistant deploy: ${spec}`;
    execCommand = `${command} deploy ${spec} --background`;
  }
  const onCalendarLines = times.map((time) => calendarLine(repeat, time));
  const invalid = onCalendarLines.find((line) => line.startsWith("Error:"));
  if (invalid) return { error: invalid };
  return { unitName, description, execCommand, onCalendarLines, timeDisplay: times.map((time) => ` ${time}`).join("") };
}

function calendarLine(repeat: "hourly" | "daily" | "weekly" | "monthly", time: string): string {
  if (!/^\d{1,2}:\d{2}$/.test(time)) return `Error: Invalid time format '${time}'. Expected HH:MM.`;
  const [hour, min] = time.split(":");
  if (repeat === "hourly") return "hourly";
  if (repeat === "daily") return `*-*-* ${hour}:${min}:00`;
  if (repeat === "weekly") return `Mon *-*-* ${hour}:${min}:00`;
  return `*-*-01 ${hour}:${min}:00`;
}

function buildServiceUnit(description: string, execCommand: string): string {
  return `[Unit]\nDescription=${description}\n\n[Service]\nType=oneshot\nExecStart=${execCommand}\nKillMode=process\nEnvironment=HOME=${homedir()}\n`;
}

function buildTimerUnit(description: string, repeat: string, timeDisplay: string, onCalendarLines: string[]): string {
  return `[Unit]\nDescription=${description} (${repeat}${timeDisplay ? ` at${timeDisplay}` : ""})\n\n[Timer]\n${onCalendarLines.map((line) => `OnCalendar=${line}`).join("\n")}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;
}

function defaultPaCommand(): string {
  if (process.env["PA_COMMAND"]) return process.env["PA_COMMAND"]!;
  if (process.env["PA_CORE_BIN"]) return process.env["PA_CORE_BIN"]!;
  if (process.env["PA_BIN"]) return resolve(process.env["PA_BIN"]!, "pa");
  return "pa-core";
}

function execSystemctl(args: string[]): void {
  execFileSync("systemctl", args, { stdio: "ignore" });
}

function tryExecSystemctl(args: string[]): void {
  try {
    execSystemctl(args);
  } catch {
    // The timer may not exist or may already be stopped.
  }
}

function parseSignalCollectArgs(argv: string[]): { dryRun: boolean; skipRoute: boolean; reprocess: boolean; conversationId?: string } | { error: string } {
  const opts: { dryRun: boolean; skipRoute: boolean; reprocess: boolean; conversationId?: string } = { dryRun: false, skipRoute: false, reprocess: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--skip-route") opts.skipRoute = true;
    else if (arg === "--reprocess") opts.reprocess = true;
    else if (arg === "--conversation-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--conversation-id requires a value" };
      opts.conversationId = value;
      i += 1;
    } else return { error: `Unsupported signal collect option: ${arg}` };
  }
  return opts;
}

function runSignalCollect(opts: { dryRun: boolean; skipRoute: boolean; conversationId?: string }, io: Required<CliIo>): number {
  const state = readCollectorState();
  io.stdout("=== Signal Note to Self Collector ===");
  io.stdout(`Last processed: ${state.lastProcessedAt > 0 ? formatLocal(nowUtc(new Date(state.lastProcessedAt))) : "never"}`);
  io.stdout(`Total processed: ${state.totalProcessed}`);
  let conversationId = opts.conversationId;
  if (!conversationId) {
    const identity = getOwnIdentity();
    const conversation = findNoteToSelfConversation(identity);
    if (!conversation) return printError("Could not find Note to Self conversation", io);
    conversationId = conversation.id;
    io.stdout(`Own identity: ${identity.e164} (${identity.uuid})`);
  }
  io.stdout(`Note to Self conversation: ${conversationId}${opts.conversationId ? " (override)" : ""}`);
  if (opts.dryRun) {
    const messages = fetchNotesSince(conversationId, state.lastProcessedAt);
    io.stdout(messages.length === 0 ? "No new messages found." : `Would extract ${messages.length} new message(s).`);
    for (const msg of messages) io.stdout(`  [${formatLocal(nowUtc(new Date(msg.sent_at)))}] ${(msg.body ?? "(no text body)").slice(0, 80).replace(/\n/g, " ")}`);
    return 0;
  }
  const result = extractNotesSinceLastRun(conversationId);
  io.stdout(result.count === 0 ? "No new messages found." : `Extracted ${result.count} new message(s).`);
  for (const file of result.files) io.stdout(`  ${file}`);
  if (!opts.skipRoute && result.files.length > 0) routeSignalFiles(result.files, false, io);
  return 0;
}

function runSignalReprocess(dryRun: boolean, io: Required<CliIo>): number {
  const rawDir = getSignalPaths(getSignalDir()).rawDir;
  if (!existsSync(rawDir)) {
    io.stdout("No raw notes found in signal/raw/.");
    return 0;
  }
  const files = readdirSync(rawDir).filter((file) => file.endsWith(".md")).map((file) => join(rawDir, file));
  if (files.length === 0) {
    io.stdout("No raw notes found in signal/raw/.");
    return 0;
  }
  io.stdout(`Found ${files.length} raw note(s) to reprocess.`);
  if (!dryRun) io.stdout(`Removed ${cleanSignalEntries()} previous entries.`);
  routeSignalFiles(files, dryRun, io);
  return 0;
}

function routeSignalFiles(files: string[], dryRun: boolean, io: Required<CliIo>): void {
  let routed = 0;
  let errors = 0;
  for (const file of files) {
    try {
      const result = routeMessage(file);
      const sentAt = extractSentAtFromFile(file);
      if (dryRun) io.stdout(`  [${localDate(nowUtc(new Date(sentAt)))}] ${result.destination} <- ${basename(file)}`);
      else {
        const writeResult = writeRoutedMessage(result, sentAt);
        markSignalNoteAsProcessed(file);
        io.stdout(`  ${result.destination.padEnd(16)} -> ${writeResult.path}${writeResult.ticketId ? ` (${writeResult.ticketId})` : ""}`);
      }
      routed += 1;
    } catch (error) {
      errors += 1;
      io.stderr(`ERROR: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  io.stdout(`Routed ${routed} note(s). Errors: ${errors}.`);
}

function extractSentAtFromFile(filePath: string): number {
  const match = readFileSync(filePath, "utf-8").match(/^sentAt:\s*(\d+)/m);
  return match ? Number.parseInt(match[1]!, 10) : Date.now();
}

interface StatusWaitRuntime {
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runStatusCommand(argv: string[], io: Required<CliIo>, now: Date, runtime: StatusWaitRuntime): Promise<number> {
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
    if (opts.wait) return waitForDeployment(opts.deployId, io, runtime);
    if (opts.report) return showDeploymentReport(opts.deployId, io);
    if (opts.artifacts) return showDeploymentArtifacts(opts.deployId, io);
    if (opts.activity) return showDeploymentActivity(opts.deployId, io);
    io.stdout(formatRegistryShow(deployment, getDeploymentEvents(deployment.deploy_id).length));
    return 0;
  }

  let deployments = queryDeploymentStatuses();
  if (opts.running) deployments = deployments.filter((deployment) => deployment.status === "running");
  if (opts.team) deployments = deployments.filter((deployment) => deployment.team === opts.team);
  if (opts.today) deployments = deployments.filter((deployment) => localDate(deployment.started_at) === localDate(nowUtc(now)));
  if (opts.recent !== undefined) deployments = deployments.slice(0, opts.recent);
  io.stdout(formatRegistryList(deployments));
  return 0;
}

function parseDeployArgs(argv: string[]): { fields: Record<string, unknown> } | { error: string } {
  const [team, ...rest] = argv;
  if (!team || team.startsWith("-")) return { error: "team is required" };
  const fields: Record<string, unknown> = { team };
  const flagMap: Record<string, keyof DeployRequest | "objectiveFile"> = { "--mode": "mode", "--objective": "objective", "--objective-file": "objectiveFile", "--repo": "repo", "--ticket": "ticket", "--timeout": "timeout", "--provider": "provider", "--model": "model", "--team-model": "teamModel", "--agent-model": "agentModel", "--resume": "resume" };
  const booleanMap: Record<string, keyof DeployRequest> = { "--dry-run": "dryRun", "--background": "background", "--list-modes": "listModes", "--validate": "validate" };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    const booleanKey = booleanMap[arg];
    if (booleanKey) {
      fields[booleanKey] = true;
      continue;
    }
    const key = flagMap[arg];
    if (!key && (arg === "--interactive" || arg === "--direct")) return { error: `${arg} was removed. Foreground TUI is now the default; use --background for detached runs or --dry-run to preview.` };
    if (!key) return { error: `Unsupported deploy option: ${arg}` };
    const value = rest[i + 1];
    if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
    if (key === "objectiveFile") {
      try {
        fields.objective = readGuardedLocalTextFile(value);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    else fields[key] = key === "timeout" ? Number(value) : value;
    i += 1;
  }
  return { fields };
}

function printDeployModes(team: string, io: Required<CliIo>): number {
  const config = loadTeamConfig(team);
  const modes = config.deploy_modes ?? [];
  if (modes.length === 0) {
    io.stdout(`No deploy modes configured for ${team}.`);
    return 0;
  }
  io.stdout(`Deploy modes for ${team}:`);
  for (const mode of modes) io.stdout(`  ${mode.id.padEnd(18)} ${mode.label}`);
  return 0;
}

function validateDeployConfig(team: string, io: Required<CliIo>): number {
  const config = loadTeamConfig(team);
  io.stdout(`Valid team config: ${config.name}`);
  io.stdout(`Agents: ${config.agents.length}`);
  io.stdout(`Modes: ${(config.deploy_modes ?? []).length}`);
  return 0;
}

function parseStatusArgs(argv: string[]): { deployId?: string; running?: boolean; team?: string; recent?: number; today?: boolean; wait?: boolean; report?: boolean; artifacts?: boolean; activity?: boolean } | { error: string } {
  const opts: { deployId?: string; running?: boolean; team?: string; recent?: number; today?: boolean; wait?: boolean; report?: boolean; artifacts?: boolean; activity?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--running") opts.running = true;
    else if (arg === "--today") opts.today = true;
    else if (arg === "--wait") opts.wait = true;
    else if (arg === "--report") opts.report = true;
    else if (arg === "--artifacts") opts.artifacts = true;
    else if (arg === "--activity") opts.activity = true;
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
  if (opts.wait && !opts.deployId) return { error: "status --wait requires deploy-id" };
  return opts;
}

async function waitForDeployment(deployId: string, io: Required<CliIo>, runtime: StatusWaitRuntime): Promise<number> {
  const initial = queryDeploymentStatus(deployId);
  if (!initial) return printError(`Deployment not found: ${deployId}`, io);
  const timeout = resolveStatusWaitTimeout(initial);
  if ("error" in timeout) return printError(timeout.error, io);

  io.stdout(`Waiting for deployment: ${deployId}`);
  io.stdout(`Wait timeout: ${timeout.seconds}s`);
  io.stdout(`Poll interval: ${STATUS_WAIT_POLL_INTERVAL_SECONDS}s`);
  io.stdout(`Override env: ${STATUS_WAIT_OVERRIDE_ENV}`);

  const startedAt = runtime.clock();
  while (true) {
    const deployment = queryDeploymentStatus(deployId);
    if (!deployment) return printError(`Deployment not found: ${deployId}`, io);
    if (deployment.status !== "running") {
      io.stdout(`${deployment.status} - ${deployment.summary ?? deployment.status}`);
      return deployment.status === "success" || deployment.status === "partial" ? 0 : 1;
    }
    if (runtime.clock() - startedAt >= timeout.seconds * 1000) {
      io.stderr(`Timed out waiting for deployment ${deployId} after ${timeout.seconds}s`);
      return 1;
    }
    await runtime.sleep(STATUS_WAIT_POLL_INTERVAL_SECONDS * 1000);
  }
}

function resolveStatusWaitTimeout(deployment: DeploymentStatus): { seconds: number } | { error: string } {
  const rawOverride = process.env[STATUS_WAIT_OVERRIDE_ENV];
  if (rawOverride !== undefined && rawOverride !== "") {
    const override = Number(rawOverride);
    const error = validateTimeoutSeconds(override, STATUS_WAIT_OVERRIDE_ENV);
    if (error) return { error };
    return { seconds: override };
  }
  return { seconds: deployment.effective_timeout_seconds ?? DEFAULT_DEPLOY_TIMEOUT_SECONDS };
}

function validateTimeoutSeconds(timeout: number, label: string): string | undefined {
  if (!Number.isInteger(timeout) || timeout < MIN_DEPLOY_TIMEOUT_SECONDS || timeout > MAX_DEPLOY_TIMEOUT_SECONDS) {
    return `${label} must be between ${MIN_DEPLOY_TIMEOUT_SECONDS} and ${MAX_DEPLOY_TIMEOUT_SECONDS} seconds`;
  }
  return undefined;
}

function showDeploymentReport(deployId: string, io: Required<CliIo>): number {
  for (const dir of reportSearchDirs()) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir).filter((entry) => entry.endsWith(".md"));
    const filenameMatch = entries.find((entry) => entry.includes(deployId));
    if (filenameMatch) {
      io.stdout(readFileSync(resolve(dir, filenameMatch), "utf-8"));
      return 0;
    }
    for (const entry of entries) {
      const filePath = resolve(dir, entry);
      const content = readFileSync(filePath, "utf-8");
      if (content.includes(deployId)) {
        io.stdout(content);
        return 0;
      }
    }
  }
  io.stdout(`No work report found for deployment: ${deployId}`);
  return 0;
}

function showDeploymentArtifacts(deployId: string, io: Required<CliIo>): number {
  const dir = getDeploymentDir(deployId);
  if (!existsSync(dir)) {
    io.stdout(`No workspace found for deployment: ${deployId}`);
    return 0;
  }
  for (const file of listFilesRecursive(dir)) io.stdout(file);
  return 0;
}

function showDeploymentActivity(deployId: string, io: Required<CliIo>): number {
  const activityFile = resolve(getDeploymentDir(deployId), "activity.jsonl");
  if (!existsSync(activityFile)) {
    io.stdout(`No activity log found for deployment: ${deployId}`);
    io.stdout(`Expected: ${activityFile}`);
    return 0;
  }
  const lines = readFileSync(activityFile, "utf-8").split("\n").filter((line) => line.trim());
  if (lines.length === 0) {
    io.stdout(`Activity log is empty: ${activityFile}`);
    return 0;
  }
  const events = readActivityEvents(activityFile);
  io.stdout(`Activity timeline - ${deployId} (${events.length} events)`);
  for (const event of events) {
    const ts = formatLocalShort(event.timestamp);
    const kind = event.partType ? `${event.kind}/${event.partType}` : event.kind;
    const body = event.body.slice(0, 100);
    io.stdout(`${ts.padEnd(26)} ${event.source.padEnd(20)} ${kind.padEnd(18)} ${body}`.trimEnd());
  }
  return 0;
}

function reportSearchDirs(): string[] {
  const base = getAiUsageDir();
  const dirs = [resolve(base, "sinh-inputs/inbox"), resolve(base, "sinh-inputs/done"), resolve(base, "sinh-inputs/archives")];
  const agentTeams = resolve(base, "agent-teams");
  if (!existsSync(agentTeams)) return dirs;
  for (const team of readdirSync(agentTeams, { withFileTypes: true })) {
    if (!team.isDirectory()) continue;
    dirs.push(resolve(agentTeams, team.name, "done"), resolve(agentTeams, team.name, "ongoing"));
  }
  return dirs;
}

function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) results.push(...listFilesRecursive(fullPath));
    else results.push(fullPath);
  }
  return results;
}

function parseBoardArgs(argv: string[]): { project?: string; assignee?: string; all?: boolean } | { error: string } {
  const opts: { project?: string; assignee?: string; all?: boolean } = {};
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
      opts.all = true;
    } else return { error: `Unsupported board option: ${arg}` };
  }
  return opts;
}

function resolveBoardProject(opts: { project?: string; all?: boolean }): { project?: string } | { error: string } {
  if (opts.all) return { project: undefined };
  if (opts.project) return { project: resolveProject(opts.project).key };
  const cwdProject = resolveProjectFromCwd();
  if (cwdProject) return { project: cwdProject.key };
  return { error: `Not in a registered repo. Use --all or --project name.${availableProjectGuidance()}` };
}

function availableProjectGuidance(): string {
  const available = listRepos().filter((repo) => repo.prefix).map((repo) => repo.name).join(", ");
  return available ? ` Available projects: ${available}` : "";
}

function parseTeamsArgs(argv: string[]): { name?: string; all?: boolean; json?: boolean } | { error: string } {
  const opts: { name?: string; all?: boolean; json?: boolean } = {};
  for (const arg of argv) {
    if (arg === "--all") opts.all = true;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("-")) return { error: `Unsupported teams option: ${arg}` };
    else if (!opts.name) opts.name = arg;
    else return { error: `Unexpected teams argument: ${arg}` };
  }
  return opts;
}

function parseRegistryListArgs(argv: string[]): { team?: string; status?: DeploymentStatus["status"]; limit?: number; since?: string; json?: boolean } | { error: string } {
  const opts: { team?: string; status?: DeploymentStatus["status"]; limit?: number; since?: string; json?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") opts.json = true;
    else if (arg === "--team") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--team requires a value" };
      opts.team = value;
      i += 1;
    } else if (arg === "--status") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--status requires a value" };
      if (!isDeploymentStatus(value)) return { error: `Invalid status '${value}'. Must be one of: running, success, partial, failed, crashed, dead, unknown` };
      opts.status = value as DeploymentStatus["status"];
      i += 1;
    } else if (arg === "--since") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--since requires a value" };
      opts.since = value;
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
  const events = getDeploymentEvents(deployId);
  if (parsed.fallback && events.some((event) => event.event === "completed" || event.event === "crashed")) {
    io.stdout("Skipping: deployment already has terminal event");
    return 0;
  }
  appendRegistryEvent({ deployment_id: deployId, team: deployment.team, event: "completed", timestamp: nowUtc(), status: parsed.status, summary: parsed.summary, log_file: parsed.logFile, rating: parsed.rating, fallback: parsed.fallback });
  io.stdout(`Completed ${deployId} with status ${parsed.status}`);
  return 0;
}

function parseRegistryCompleteArgs(argv: string[]): { status: "success" | "partial" | "failed"; summary?: string; logFile?: string; rating?: { source: "agent" | "system" | "user"; overall: number; productivity?: number; quality?: number; efficiency?: number; insight?: number }; fallback?: boolean } | { error: string } {
  const opts: { status?: "success" | "partial" | "failed"; summary?: string; logFile?: string; fallback?: boolean } = {};
  const ratingValues: Record<string, string> = {};
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
    } else if (arg === "--fallback") opts.fallback = true;
    else if (arg.startsWith("--rating-")) {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
      ratingValues[arg] = value;
      i += 1;
    } else return { error: `Unsupported registry complete option: ${arg}` };
  }
  const rating = parseRatingOptions(ratingValues);
  if ("error" in rating) return rating;
  return opts.status ? { status: opts.status, summary: opts.summary, logFile: opts.logFile, fallback: opts.fallback, rating: rating.rating } : { error: "--status is required" };
}

function runRegistryUpdate(argv: string[], io: Required<CliIo>, deprecatedAlias: boolean): number {
  const [deployId, ...rest] = argv;
  if (!deployId) return printError("registry update requires deploy-id", io);
  const events = getDeploymentEvents(deployId);
  const started = events.find((event) => event.event === "started");
  if (!started) return printError(`Deployment not found: ${deployId}`, io);
  const parsed = parseRegistryUpdateArgs(rest);
  if ("error" in parsed) return printError(parsed.error, io);
  if (deprecatedAlias) io.stderr("Warning: `pa registry amend` is deprecated. Use `pa registry update` instead.");
  appendRegistryEvent({ deployment_id: deployId, team: started.team, event: "updated", timestamp: nowUtc(), status: parsed.status, summary: parsed.summary, log_file: parsed.logFile, rating: parsed.rating, note: parsed.note });
  io.stdout(`${deprecatedAlias ? "Amended" : "Updated"}: ${deployId} - ${parsed.summary ?? parsed.note ?? "update recorded"}`);
  return 0;
}

function parseRegistryUpdateArgs(argv: string[]): { status?: "success" | "partial" | "failed"; summary?: string; logFile?: string; note?: string; rating?: { source: "agent" | "system" | "user"; overall: number; productivity?: number; quality?: number; efficiency?: number; insight?: number } } | { error: string } {
  const opts: { status?: "success" | "partial" | "failed"; summary?: string; logFile?: string; note?: string } = {};
  const ratingValues: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--status") {
      const value = argv[i + 1];
      if (value !== "success" && value !== "partial" && value !== "failed") return { error: "--status must be success, partial, or failed" };
      opts.status = value;
      i += 1;
    } else if (arg === "--summary" || arg === "--log-file" || arg === "--note") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
      if (arg === "--summary") opts.summary = value;
      else if (arg === "--log-file") opts.logFile = value;
      else opts.note = value;
      i += 1;
    } else if (arg.startsWith("--rating-")) {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
      ratingValues[arg] = value;
      i += 1;
    } else return { error: `Unsupported registry update option: ${arg}` };
  }
  const rating = parseRatingOptions(ratingValues);
  if ("error" in rating) return rating;
  if (!opts.status && !opts.summary && !opts.logFile && !opts.note && !rating.rating) return { error: "At least one field is required. Use --summary, --status, --log-file, --rating-*, or --note." };
  return { ...opts, rating: rating.rating };
}

function runRegistrySearch(argv: string[], io: Required<CliIo>): number {
  const [query, ...rest] = argv;
  if (!query?.trim()) return printError("Search query cannot be empty", io);
  const parsed = parseLimitOnly(rest, "registry search");
  if ("error" in parsed) return printError(parsed.error, io);
  const needle = query.toLowerCase();
  const eventDeployIds = new Set((getDb().prepare("SELECT deployment_id, team, event, summary, note, objective FROM registry_events ORDER BY timestamp DESC").all() as Array<Record<string, unknown>>)
    .filter((row) => `${row["deployment_id"] ?? ""} ${row["team"] ?? ""} ${row["event"] ?? ""} ${row["summary"] ?? ""} ${row["note"] ?? ""} ${row["objective"] ?? ""}`.toLowerCase().includes(needle))
    .map((row) => String(row["deployment_id"])));
  const matches = queryDeploymentStatuses().filter((deployment) => eventDeployIds.has(deployment.deploy_id) || `${deployment.deploy_id} ${deployment.team} ${deployment.status} ${deployment.summary ?? ""} ${deployment.objective ?? ""}`.toLowerCase().includes(needle)).slice(0, parsed.limit ?? 20);
  if (matches.length === 0) {
    io.stdout("No results found.");
    return 0;
  }
  io.stdout(formatRegistryList(matches));
  return 0;
}

function runRegistryAnalytics(argv: string[], io: Required<CliIo>): number {
  const opts = parseRegistryAnalyticsArgs(argv);
  if ("error" in opts) return printError(opts.error, io);
  let deployments = queryDeploymentStatuses();
  if (opts.team) deployments = deployments.filter((deployment) => deployment.team === opts.team);
  if (opts.since) deployments = deployments.filter((deployment) => deployment.started_at >= opts.since!);
  if (!opts.view || opts.view === "daily") {
    io.stdout("=== Deployments Per Day ===");
    for (const [day, rows] of groupBy(deployments, (deployment) => deployment.started_at.slice(0, 10))) io.stdout(`${day.padEnd(12)} ${String(rows.length).padEnd(8)} ${rows.filter((d) => d.status === "success").length}`);
  }
  if (!opts.view || opts.view === "teams") {
    io.stdout("=== Team Activity ===");
    for (const [team, rows] of groupBy(deployments, (deployment) => deployment.team)) io.stdout(`${team.padEnd(20)} ${String(rows.length).padEnd(8)} ${rows[0]?.started_at ?? ""}`);
  }
  if (!opts.view || opts.view === "ratings") {
    io.stdout("=== Rating Trends ===");
    const rows = (getDb().prepare("SELECT team, timestamp, rating FROM registry_events WHERE rating IS NOT NULL ORDER BY timestamp DESC LIMIT 60").all() as Array<{ team: string; timestamp: string; rating: string }>).filter((row) => !opts.team || row.team === opts.team);
    for (const row of rows) {
      const rating = JSON.parse(row.rating) as { overall?: number; productivity?: number; quality?: number };
      io.stdout(`${row.timestamp.slice(0, 10).padEnd(12)} ${row.team.padEnd(16)} ${String(rating.overall ?? "N/A").padEnd(8)} ${String(rating.productivity ?? "N/A").padEnd(8)} ${String(rating.quality ?? "N/A")}`);
    }
  }
  return 0;
}

function runRegistryClean(argv: string[], io: Required<CliIo>): number {
  const opts = parseRegistryCleanArgs(argv);
  if ("error" in opts) return printError(opts.error, io);
  const thresholdMs = opts.thresholdHours * 60 * 60 * 1000;
  const now = Date.now();
  const orphans = queryDeploymentStatuses().filter((deployment) => deployment.status === "running" && now - parseTimestamp(deployment.started_at).getTime() > thresholdMs);
  if (orphans.length === 0) {
    io.stdout("No orphaned deployments found.");
    return 0;
  }
  io.stdout(`Found ${orphans.length} orphaned deployment(s) (running > ${opts.thresholdHours}h):`);
  for (const deployment of orphans) io.stdout(`${deployment.deploy_id.padEnd(12)} ${deployment.team.padEnd(12)} ${deployment.started_at}`);
  if (!opts.markDead) {
    io.stdout("Dry-run: no changes made. Use --mark-dead to mark them as crashed.");
    return 0;
  }
  for (const deployment of orphans) appendRegistryEvent({ deployment_id: deployment.deploy_id, team: deployment.team, event: "crashed", timestamp: nowUtc(), exit_code: -1, summary: "Marked as dead by registry clean" });
  return 0;
}

function runRegistrySweep(argv: string[], io: Required<CliIo>): number {
  const fix = argv.includes("--fix");
  const unsupported = argv.find((arg) => arg !== "--fix" && arg !== "--dry-run");
  if (unsupported) return printError(`Unsupported registry sweep option: ${unsupported}`, io);
  const orphans = queryDeploymentStatuses().filter((deployment) => deployment.status === "running" && (!deployment.pid || !isProcessAlive(deployment.pid)));
  if (orphans.length === 0) {
    io.stdout("No orphaned deployments found.");
    return 0;
  }
  io.stdout(`Found ${orphans.length} orphaned deployment(s):`);
  for (const deployment of orphans) io.stdout(`${deployment.deploy_id.padEnd(12)} ${deployment.team.padEnd(15)} ${deployment.pid ?? "none"}`);
  if (!fix) {
    io.stdout("Dry-run: no changes made. Use --fix to write fallback markers.");
    return 0;
  }
  for (const deployment of orphans) appendRegistryEvent({ deployment_id: deployment.deploy_id, team: deployment.team, event: "completed", timestamp: nowUtc(), status: "partial", summary: "Resolved by pa registry sweep (fallback)", fallback: true });
  io.stdout(`Swept ${orphans.length} orphaned deployment(s).`);
  return 0;
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

function parseHealthArgs(argv: string[]): { category?: HealthCategory; days?: number; since?: string; json?: boolean; save?: boolean; primerSummary?: boolean; history?: boolean } | { error: string } {
  const opts: { category?: HealthCategory; days?: number; since?: string; json?: boolean; save?: boolean; primerSummary?: boolean; history?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") opts.json = true;
    else if (arg === "--save") opts.save = true;
    else if (arg === "--primer-summary") opts.primerSummary = true;
    else if (arg === "--history") opts.history = true;
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

function parseTrashListArgs(argv: string[]): { status?: TrashStatus; fileType?: TrashFileType; search?: string; json?: boolean } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--status", "--type", "--search", "--json"]), new Set(["--json"]));
  if ("error" in result) return result;
  return { status: result.values["--status"] as TrashStatus | undefined, fileType: result.values["--type"] as TrashFileType | undefined, search: result.values["--search"], json: result.booleans.has("--json") };
}

function parseTrashMoveArgs(argv: string[]): { reason: string; actor: string; fileType?: TrashFileType; yes: boolean } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--reason", "--actor", "--type", "--yes"]), new Set(["--yes"]));
  if ("error" in result) return result;
  if (!result.values["--reason"]) return { error: "--reason is required" };
  return { reason: result.values["--reason"]!, actor: result.values["--actor"] ?? "pa-core", fileType: result.values["--type"] as TrashFileType | undefined, yes: result.booleans.has("--yes") };
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

function parseFlagPairs(argv: string[], allowed: Set<string>, booleanFlags = new Set<string>()): { values: Record<string, string>; booleans: Set<string> } | { error: string } {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!allowed.has(flag)) return { error: `Unsupported option: ${flag}` };
    if (booleanFlags.has(flag)) {
      booleans.add(flag);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) return { error: `${flag} requires a value` };
    values[flag] = value;
    i += 1;
  }
  return { values, booleans };
}

function splitCsv(value: string | undefined): string[] {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function parseRatingOptions(values: Record<string, string>): { rating?: { source: "agent" | "system" | "user"; overall: number; productivity?: number; quality?: number; efficiency?: number; insight?: number } } | { error: string } {
  if (Object.keys(values).length === 0) return {};
  const source = values["--rating-source"] ?? "agent";
  if (source !== "agent" && source !== "system" && source !== "user") return { error: "--rating-source must be agent, system, or user" };
  const rating: { source: "agent" | "system" | "user"; overall: number; productivity?: number; quality?: number; efficiency?: number; insight?: number } = { source, overall: numberRating(values["--rating-overall"] ?? "0") };
  for (const [flag, key] of [["--rating-productivity", "productivity"], ["--rating-quality", "quality"], ["--rating-efficiency", "efficiency"], ["--rating-insight", "insight"]] as const) {
    if (values[flag] !== undefined) rating[key] = numberRating(values[flag]);
  }
  for (const value of [rating.overall, rating.productivity, rating.quality, rating.efficiency, rating.insight]) if (value !== undefined && (Number.isNaN(value) || value < 0 || value > 5)) return { error: "Rating values must be between 0 and 5" };
  return { rating };
}

function numberRating(value: string): number {
  return Number.parseFloat(value);
}

function parseLimitOnly(argv: string[], context: string): { limit?: number } | { error: string } {
  const opts: { limit?: number } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg !== "--limit") return { error: `Unsupported ${context} option: ${arg}` };
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) return { error: "--limit requires a value" };
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1) return { error: "--limit must be a positive integer" };
    opts.limit = limit;
    i += 1;
  }
  return opts;
}

function parseRegistryAnalyticsArgs(argv: string[]): { view?: "daily" | "teams" | "ratings"; team?: string; since?: string } | { error: string } {
  const opts: { view?: "daily" | "teams" | "ratings"; team?: string; since?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    if (arg === "--view") {
      if (value !== "daily" && value !== "teams" && value !== "ratings") return { error: "--view must be daily, teams, or ratings" };
      opts.view = value;
      i += 1;
    } else if (arg === "--team" || arg === "--since") {
      if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
      if (arg === "--team") opts.team = value;
      else opts.since = value;
      i += 1;
    } else return { error: `Unsupported registry analytics option: ${arg}` };
  }
  return opts;
}

function parseRegistryCleanArgs(argv: string[]): { thresholdHours: number; markDead: boolean } | { error: string } {
  const opts = { thresholdHours: 6, markDead: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--mark-dead") opts.markDead = true;
    else if (arg === "--dry-run") {
      // dry-run is the default; accepted for compatibility.
    } else if (arg === "--threshold") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--threshold requires a value" };
      const thresholdHours = Number.parseFloat(value);
      if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) return { error: "--threshold must be a positive number" };
      opts.thresholdHours = thresholdHours;
      i += 1;
    } else return { error: `Unsupported registry clean option: ${arg}` };
  }
  return opts;
}

function groupBy<T>(values: T[], keyFn: (value: T) => string): Array<[string, T[]]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) grouped.set(keyFn(value), [...(grouped.get(keyFn(value)) ?? []), value]);
  return [...grouped.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isDeploymentStatus(value: string): value is DeploymentStatus["status"] {
  return ["running", "success", "partial", "failed", "crashed", "dead", "unknown"].includes(value);
}

function printError(error: string, io: Required<CliIo>): number {
  io.stderr(error);
  return 1;
}

function printHelp(io: Required<CliIo>, binaryName: string): void {
  io.stdout(`Usage: ${binaryName} <command> [options]`);
  io.stdout("Commands: repos list, status, deploy, serve, stop, restart, serve-status, schedule, remove-timer, board, teams, registry, ticket, bulletin, health, trash, codectx, timers, signal");
  io.stdout(`Status wait: ${binaryName} status <deploy-id> --wait polls until terminal status; override wait seconds with ${STATUS_WAIT_OVERRIDE_ENV}.`);
}

function printDeployHelp(io: Required<CliIo>): void {
  io.stdout("Usage: deploy <team> [options]");
  io.stdout("Mode flags:");
  io.stdout("  --background        Run detached/headless");
  io.stdout("  --dry-run           Generate primer and plan without invoking opencode");
  io.stdout("Other options: --mode, --objective, --objective-file, --repo, --ticket, --timeout, --provider, --model, --team-model, --agent-model, --resume, --list-modes, --validate");
}

function defaultBinaryName(): string {
  return basename(process.argv[1] ?? "") || "pa-core";
}

function consumeJsonFlag(argv: string[]): { json: boolean } | { error: string } {
  const unsupported = argv.find((arg) => arg !== "--json");
  return unsupported ? { error: `Unsupported option: ${unsupported}` } : { json: argv.includes("--json") };
}

function normalizeIo(io: CliIo = {}): Required<CliIo> {
  return { stdout: io.stdout ?? ((text) => process.stdout.write(`${text}\n`)), stderr: io.stderr ?? ((text) => process.stderr.write(`${text}\n`)) };
}

function localDate(timestamp: string): string {
  return parseTimestamp(timestamp).toLocaleDateString("en-CA");
}
