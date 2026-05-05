import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readActivityEvents } from "../../activity/index.js";
import { DEFAULT_DEPLOY_TIMEOUT_SECONDS, MAX_DEPLOY_TIMEOUT_SECONDS, MIN_DEPLOY_TIMEOUT_SECONDS } from "../../deploy/index.js";
import { getAiUsageDir, getDeploymentDir } from "../../paths.js";
import { appendRegistryEvent, getDb, getDeploymentEvents, queryDeploymentStatus, queryDeploymentStatuses } from "../../registry/index.js";
import { formatLocal, formatLocalShort, nowUtc, parseTimestamp } from "../../time.js";
import type { DeploymentStatus } from "../../types.js";
import { formatRegistryList, formatRegistryShow } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { consumeJsonFlag, groupBy, isDeploymentStatus, isProcessAlive, parseLimitOnly, parseRatingOptions, printError } from "../utils.js";

const STATUS_WAIT_POLL_INTERVAL_SECONDS = 10;
const STATUS_WAIT_OVERRIDE_ENV = "PA_STATUS_WAIT_TIMEOUT";

interface StatusWaitRuntime {
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

function validateTimeoutSeconds(timeout: number, label: string): string | undefined {
  if (!Number.isInteger(timeout) || timeout < MIN_DEPLOY_TIMEOUT_SECONDS || timeout > MAX_DEPLOY_TIMEOUT_SECONDS) {
    return `${label} must be between ${MIN_DEPLOY_TIMEOUT_SECONDS} and ${MAX_DEPLOY_TIMEOUT_SECONDS} seconds`;
  }
  return undefined;
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

function localDate(timestamp: string): string {
  return parseTimestamp(timestamp).toLocaleDateString("en-CA");
}

export async function runStatusCommand(argv: string[], io: Required<CliIo>, now: Date, runtime: StatusWaitRuntime): Promise<number> {
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
  if (opts.running) deployments = deployments.filter((deployment) => deployment.status === "running" && (!deployment.pid || isProcessAlive(deployment.pid)));
  if (opts.team) deployments = deployments.filter((deployment) => deployment.team === opts.team);
  if (opts.today) deployments = deployments.filter((deployment) => localDate(deployment.started_at) === localDate(nowUtc(now)));
  if (opts.recent !== undefined) deployments = deployments.slice(0, opts.recent);
  io.stdout(formatRegistryList(deployments));
  return 0;
}
