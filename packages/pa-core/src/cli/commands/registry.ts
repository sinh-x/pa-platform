import { appendRegistryEvent, getDb, getDeploymentEvents, queryDeploymentStatus, queryDeploymentStatuses } from "../../registry/index.js";
import { nowUtc, parseTimestamp } from "../../time.js";
import type { DeploymentStatus } from "../../types.js";
import { formatRegistryList, formatRegistryShow } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { consumeJsonFlag, groupBy, isDeploymentStatus, isProcessAlive, parseLimitOnly, parseRatingOptions, printError } from "../utils.js";

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

export function runRegistryCommand(argv: string[], io: Required<CliIo>): number {
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
