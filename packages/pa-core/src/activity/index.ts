import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDeploymentDir } from "../paths.js";
import type { RuntimeName } from "../types.js";

export type ActivityKind = "thinking" | "text" | "tool_use" | "tool_result" | "error";

export interface ActivityEvent {
  deployId: string;
  timestamp: string;
  kind: ActivityKind;
  source: RuntimeName | string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface ActivitySummary {
  deployId: string;
  total: number;
  byKind: Record<ActivityKind, number>;
  bySource: Record<string, number>;
  firstTimestamp?: string;
  lastTimestamp?: string;
}

const ACTIVITY_KINDS: ActivityKind[] = ["thinking", "text", "tool_use", "tool_result", "error"];

export function getActivityLogPath(deployId: string, deploymentDir = getDeploymentDir(deployId)): string {
  return resolve(deploymentDir, "activity.jsonl");
}

export function createActivityEvent(input: Omit<ActivityEvent, "timestamp"> & { timestamp?: string }): ActivityEvent {
  if (!ACTIVITY_KINDS.includes(input.kind)) throw new Error(`Invalid activity kind: ${input.kind}`);
  return { ...input, timestamp: input.timestamp ?? new Date().toISOString() };
}

export function appendActivityEvent(event: ActivityEvent, activityLogPath = getActivityLogPath(event.deployId)): void {
  mkdirSync(dirname(activityLogPath), { recursive: true });
  writeFileSync(activityLogPath, `${JSON.stringify(event)}\n`, { flag: "a" });
}

export function writeActivityEvents(events: ActivityEvent[], activityLogPath: string): void {
  mkdirSync(dirname(activityLogPath), { recursive: true });
  writeFileSync(activityLogPath, events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""));
}

export function readActivityEvents(activityLogPath: string): ActivityEvent[] {
  if (!existsSync(activityLogPath)) return [];
  return readFileSync(activityLogPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line): ActivityEvent[] => {
      try {
        return [normalizeActivityEvent(JSON.parse(line) as Record<string, unknown>)];
      } catch {
        return [];
      }
    });
}

export function readDeploymentActivity(deployId: string, deploymentDir = getDeploymentDir(deployId)): ActivityEvent[] {
  return readActivityEvents(getActivityLogPath(deployId, deploymentDir));
}

export function summarizeActivity(events: ActivityEvent[], deployId = events[0]?.deployId ?? ""): ActivitySummary {
  const byKind = Object.fromEntries(ACTIVITY_KINDS.map((kind) => [kind, 0])) as Record<ActivityKind, number>;
  const bySource: Record<string, number> = {};
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const event of events) {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    bySource[event.source] = (bySource[event.source] ?? 0) + 1;
  }
  return { deployId, total: events.length, byKind, bySource, firstTimestamp: sorted[0]?.timestamp, lastTimestamp: sorted.at(-1)?.timestamp };
}

const PLUGIN_KIND_MAP: Record<string, ActivityKind> = {
  tool_call: "tool_use",
  tool_use: "tool_use",
  tool_success: "tool_result",
  tool_result: "tool_result",
  tool_error: "error",
  session_error: "error",
  error: "error",
  thinking: "thinking",
};

function mapPluginKind(raw: Record<string, unknown>): ActivityKind {
  const kind = typeof raw["kind"] === "string" ? raw["kind"] : undefined;
  if (kind && (ACTIVITY_KINDS as string[]).includes(kind)) return kind as ActivityKind;
  const event = typeof raw["event"] === "string" ? raw["event"].toLowerCase() : undefined;
  if (event && PLUGIN_KIND_MAP[event]) return PLUGIN_KIND_MAP[event];
  return "text";
}

function summarizePluginEvent(raw: Record<string, unknown>): string {
  const event = typeof raw["event"] === "string" ? raw["event"] : "";
  const data = raw["data"];
  if (data && typeof data === "object") {
    const summary = JSON.stringify(data);
    return event ? `${event}: ${summary}` : summary;
  }
  return event;
}

export function normalizeActivityEvent(raw: Record<string, unknown>): ActivityEvent {
  const deployId = (raw["deployId"] ?? raw["deploy_id"]) as string | undefined;
  if (!deployId) throw new Error("Activity event missing deployId");
  const kind = mapPluginKind(raw);
  const timestampRaw = raw["timestamp"] ?? raw["ts"];
  const timestamp = typeof timestampRaw === "string"
    ? timestampRaw
    : typeof timestampRaw === "number" && Number.isFinite(timestampRaw)
      ? new Date(timestampRaw).toISOString()
      : new Date().toISOString();
  const source = (raw["source"] ?? raw["agent"] ?? "unknown") as string;
  const bodyRaw = raw["body"] ?? (raw["event"] !== undefined ? summarizePluginEvent(raw) : "");
  const body = typeof bodyRaw === "string" ? bodyRaw : JSON.stringify(bodyRaw);
  const metadata = (raw["metadata"] ?? raw["data"]) as Record<string, unknown> | undefined;
  return {
    deployId,
    timestamp,
    kind,
    source,
    body,
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { metadata } : {}),
  };
}
