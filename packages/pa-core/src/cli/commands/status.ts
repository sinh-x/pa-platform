import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { maskSecrets, readActivityEvents } from "../../activity/index.js";
import type { ActivityEvent } from "../../activity/index.js";
import { DEFAULT_DEPLOY_TIMEOUT_SECONDS, MAX_DEPLOY_TIMEOUT_SECONDS, MIN_DEPLOY_TIMEOUT_SECONDS } from "../../deploy/index.js";
import { getAiUsageDir, getDeploymentDir } from "../../paths.js";
import { appendRegistryEvent, getDeploymentEvents, queryDeploymentStatus, queryDeploymentStatuses } from "../../registry/index.js";
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

function parseStatusArgs(argv: string[]): { deployId?: string; running?: boolean; team?: string; recent?: number; today?: boolean; wait?: boolean; report?: boolean; artifacts?: boolean; activity?: boolean; verbose?: boolean } | { error: string } {
  const opts: { deployId?: string; running?: boolean; team?: string; recent?: number; today?: boolean; wait?: boolean; report?: boolean; artifacts?: boolean; activity?: boolean; verbose?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--running") opts.running = true;
    else if (arg === "--today") opts.today = true;
    else if (arg === "--wait") opts.wait = true;
    else if (arg === "--report") opts.report = true;
    else if (arg === "--artifacts") opts.artifacts = true;
    else if (arg === "--activity") opts.activity = true;
    else if (arg === "--verbose") opts.verbose = true;
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
  if (opts.wait) opts.activity = true;
  if (opts.verbose && !opts.activity) return { error: "--verbose requires --activity" };
  const standaloneFlags: Array<keyof typeof opts> = ["report", "artifacts"];
  for (const flag of standaloneFlags) {
    if (opts[flag]) {
      const conflict = (["wait", "activity", "report", "artifacts"] as const).find((other) => other !== flag && opts[other]);
      if (conflict) return { error: `--${flag} is standalone and not combinable with --${conflict}` };
    }
  }
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

interface WaitForDeploymentOptions {
  activity?: boolean;
  verbose?: boolean;
}

async function waitForDeployment(deployId: string, io: Required<CliIo>, runtime: StatusWaitRuntime, options?: WaitForDeploymentOptions): Promise<number> {
  const initial = queryDeploymentStatus(deployId);
  if (!initial) return printError(`Deployment not found: ${deployId}`, io);
  const timeout = resolveStatusWaitTimeout(initial);
  if ("error" in timeout) return printError(timeout.error, io);

  io.stdout(`Waiting for deployment: ${deployId}`);
  io.stdout(`Wait timeout: ${timeout.seconds}s`);
  io.stdout(`Poll interval: ${STATUS_WAIT_POLL_INTERVAL_SECONDS}s`);
  io.stdout(`Override env: ${STATUS_WAIT_OVERRIDE_ENV}`);

  const startedAt = runtime.clock();
  let activityCursor: number | undefined;
  while (true) {
    const deployment = queryDeploymentStatus(deployId);
    if (!deployment) return printError(`Deployment not found: ${deployId}`, io);
    if (deployment.status === "running" && deployment.pid !== undefined && !isProcessAlive(deployment.pid)) {
      const hasTerminalEvent = getDeploymentEvents(deployId).some((event) => event.event === "completed" || event.event === "crashed");
      if (!hasTerminalEvent) {
        appendRegistryEvent({
          deployment_id: deployId,
          team: deployment.team,
          event: "crashed",
          timestamp: nowUtc(),
          error: `status wait detected stale pid ${deployment.pid}`,
          exit_code: -1,
          summary: `status wait detected stale pid ${deployment.pid}`,
        });
      }
      const refreshed = queryDeploymentStatus(deployId);
      if (!refreshed) return printError(`Deployment not found: ${deployId}`, io);
      io.stdout(`${refreshed.status} - ${refreshed.summary ?? refreshed.status}`);
      return 1;
    }
    if (deployment.status !== "running") {
      if (options?.activity) {
        const flushCursor = process.stdout.isTTY ? undefined : activityCursor;
        showActivityTail(deployId, io, options.verbose ?? false, flushCursor);
        if (process.stdout.isTTY) ttyTailLineCount = 0;
      }
      io.stdout(`${deployment.status} - ${deployment.summary ?? deployment.status}`);
      return deployment.status === "success" || deployment.status === "partial" ? 0 : 1;
    }
    if (options?.activity) activityCursor = showActivityTail(deployId, io, options.verbose ?? false, activityCursor);
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

function showDeploymentActivity(deployId: string, io: Required<CliIo>, verbose = false): number {
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
  const visible = verbose ? events : events.filter((event) => !isNoiseActivityEvent(event));
  io.stdout(`Activity timeline - ${deployId} (${visible.length}${verbose ? "" : `/${events.length}`} events${verbose ? " [verbose]" : ""})`);
  for (const [source, group] of groupBy(visible, (event) => event.source)) {
    io.stdout(`--- ${source} (${group.length}) ---`);
    for (const event of group) io.stdout(formatActivityEvent(event));
  }
  return 0;
}

const ACTIVITY_TAIL_LIMIT = 10;

let ttyTailLineCount = 0;

function showActivityTail(deployId: string, io: Required<CliIo>, verbose: boolean, cursor?: number): number | undefined {
  const activityFile = resolve(getDeploymentDir(deployId), "activity.jsonl");
  if (!existsSync(activityFile)) return cursor;
  const events = readActivityEvents(activityFile);
  if (events.length === 0) return cursor;
  const visible = verbose ? events : events.filter((event) => !isNoiseActivityEvent(event));
  const startIndex = cursor === undefined ? Math.max(0, visible.length - ACTIVITY_TAIL_LIMIT) : cursor;
  const tail = visible.slice(startIndex);
  if (tail.length === 0) return startIndex;
  const scope = verbose ? `${visible.length}` : `${visible.length}/${events.length}`;
  const headerLine = `--- activity tail (${tail.length} new of ${scope} events${verbose ? " [verbose]" : ""}) ---`;
  const eventLines = tail.flatMap((event) => formatActivityEvent(event).split("\n"));
  const lines = [headerLine, ...eventLines];

  if (process.stdout.isTTY) {
    if (ttyTailLineCount > 0) {
      process.stdout.write(`\x1b[${ttyTailLineCount}A\r\x1b[K\x1b[J`);
    }
    for (const line of lines) io.stdout(line);
    ttyTailLineCount = lines.length;
  } else {
    for (const line of lines) io.stdout(line);
  }

  return startIndex + tail.length;
}

// Noise prefixes match the `<event>: <summary>` body format produced by summarizePluginEvent()
// in activity/index.ts. Keep in sync with that function's `${event}${summary ? `: ${summary}` : ""}` template.
const NOISE_EVENT_PREFIXES = ["session.status", "session.diff", "file.watcher.updated", "session.updated"];

function isNoiseActivityEvent(event: ActivityEvent): boolean {
  for (const prefix of NOISE_EVENT_PREFIXES) {
    if (event.body.startsWith(`${prefix}:`) || event.body.startsWith(`${prefix} `)) {
      if (prefix === "session.diff") {
        return /\bdiff=\[\]/.test(event.body);
      }
      return true;
    }
  }
  return false;
}

function formatActivityEvent(event: ActivityEvent): string {
  const ts = formatLocalShort(event.timestamp);
  if (isReasoningEvent(event)) return formatReasoningEvent(event, ts);
  if (isToolActionEvent(event)) return formatToolActionEvent(event, ts);
  const kind = event.partType ? `${event.kind}/${event.partType}` : event.kind;
  return `${ts.padEnd(26)} ${kind.padEnd(18)} ${event.body}`.trimEnd();
}

function isReasoningEvent(event: ActivityEvent): boolean {
  return event.kind === "thinking" || event.partType === "reasoning";
}

function formatReasoningEvent(event: ActivityEvent, ts: string): string {
  const content = extractReasoningContent(event.body);
  if (!content) return `${ts.padEnd(26)} reasoning`.trimEnd();
  const indented = content.split("\n").map((line) => `    ${line}`).join("\n");
  return `${ts.padEnd(26)} reasoning\n${indented}`;
}

function extractReasoningContent(body: string): string {
  const match = /^part=(\S+)(?:\s+role=(\S+))?\s+/.exec(body);
  if (!match) return body;
  return body.slice(match[0].length);
}

function isToolActionEvent(event: ActivityEvent): boolean {
  return event.kind === "tool_use" || event.kind === "tool_result";
}

function formatToolActionEvent(event: ActivityEvent, ts: string): string {
  const meta = event.metadata;
  const tool = typeof meta?.["tool"] === "string" ? meta["tool"] : extractToolNameFromBody(event.body);
  const target = extractToolTarget(event);
  const label = event.kind === "tool_use" ? "tool" : "result";
  const summary = target ? `${tool}: ${target}` : tool;
  return `${ts.padEnd(26)} ${label.padEnd(18)} ${summary}`.trimEnd();
}

function extractToolNameFromBody(body: string): string {
  const match = /tool=(\S+)/.exec(body);
  return match?.[1] ?? "unknown";
}

function extractToolTarget(event: ActivityEvent): string {
  const meta = event.metadata;
  if (!meta) return "";
  const args = recordValue(meta["args"]);
  if (args) {
    const target = firstMetaString(args, ["command", "filePath", "file_path", "pattern", "url", "path", "description", "query"]);
    if (target) return maskSecrets(target);
  }
  const summary = typeof meta["summary"] === "string" ? meta["summary"] : "";
  if (summary) return maskSecrets(summary.slice(0, 80));
  return maskSecrets(firstMetaString(meta, ["summary", "description", "command", "error", "message"]) ?? "");
}

function firstMetaString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return maskSecrets(value.slice(0, 80));
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function reportSearchDirs(): string[] {
  const base = getAiUsageDir();
  const dirs = [resolve(base, "sinh-inputs/inbox"), resolve(base, "sinh-inputs/done"), resolve(base, "sinh-inputs/archives")];
  const agentTeams = resolve(base, "agent-teams");
  if (!existsSync(agentTeams)) return dirs;
  for (const team of readdirSync(agentTeams, { withFileTypes: true })) {
    if (!team.isDirectory()) continue;
    dirs.push(resolve(agentTeams, team.name, "done"), resolve(agentTeams, team.name, "ongoing"), resolve(agentTeams, team.name, "artifacts"));
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
    if (opts.wait) return waitForDeployment(opts.deployId, io, runtime, { activity: opts.activity, verbose: opts.verbose });
    if (opts.report) return showDeploymentReport(opts.deployId, io);
    if (opts.artifacts) return showDeploymentArtifacts(opts.deployId, io);
    if (opts.activity) return showDeploymentActivity(opts.deployId, io, opts.verbose);
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
