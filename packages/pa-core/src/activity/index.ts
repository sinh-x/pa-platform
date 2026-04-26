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
        return [normalizeActivityEvent(JSON.parse(line) as Partial<ActivityEvent>)];
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

export function normalizeActivityEvent(raw: Partial<ActivityEvent>): ActivityEvent {
  const kind = raw.kind ?? "text";
  if (!ACTIVITY_KINDS.includes(kind)) throw new Error(`Invalid activity kind: ${kind}`);
  if (!raw.deployId) throw new Error("Activity event missing deployId");
  return {
    deployId: raw.deployId,
    timestamp: raw.timestamp ?? new Date().toISOString(),
    kind,
    source: raw.source ?? "unknown",
    body: raw.body ?? "",
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
  };
}
