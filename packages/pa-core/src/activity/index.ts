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
  partType?: string;
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
  // Tool events
  tool_call: "tool_use",
  tool_use: "tool_use",
  tool_execute_before: "tool_use",
  tool_success: "tool_result",
  tool_execute_after: "tool_result",
  tool_result: "tool_result",
  tool_error: "error",
  // Session events
  session_created: "text",
  session_updated: "text",
  session_status: "text",
  session_idle: "text",
  session_compacted: "text",
  session_diff: "text",
  session_deleted: "text",
  session_error: "error",
  // Message events
  message_updated: "text",
  message_part_updated: "text", // resolved per-part in mapPluginKind
  message_part_removed: "text",
  message_removed: "text",
  // File/LSP events
  file_edited: "tool_result",
  file_watcher_updated: "text",
  lsp_client_diagnostics: "text", // resolved per-severity in mapPluginKind
  lsp_updated: "text",
  // Server/TUI events
  server_connected: "text",
  tui_prompt_append: "text",
  tui_command_execute: "tool_use",
  tui_toast_show: "text",
  // Permission/todo/command events
  permission_asked: "text",
  permission_replied: "text",
  todo_updated: "text",
  command_executed: "tool_result",
  // Installation events
  installation_updated: "text",
  // Legacy aliases
  thinking: "thinking",
  error: "error",
  session_started: "text",
};

function mapPluginKind(raw: Record<string, unknown>): ActivityKind {
  const kind = typeof raw["kind"] === "string" ? raw["kind"] : undefined;
  if (kind && (ACTIVITY_KINDS as string[]).includes(kind)) return kind as ActivityKind;
  const event = typeof raw["event"] === "string" ? raw["event"].toLowerCase() : undefined;
  if (event === "message.part.updated") return resolveMessagePartKind(raw);
  if (event === "lsp.client.diagnostics") return resolveLspDiagnosticsKind(raw);
  if (event === "tool.execute.after") return resolveToolExecuteAfterKind(raw);
  const normalizedEvent = event ? event.replace(/\./g, "_") : undefined;
  if (normalizedEvent && PLUGIN_KIND_MAP[normalizedEvent]) return PLUGIN_KIND_MAP[normalizedEvent]!;
  // Fall back to text for unknown documented events (per Phase 1 requirement)
  return "text";
}

function resolveToolExecuteAfterKind(raw: Record<string, unknown>): ActivityKind {
  const data = recordValue(raw["data"]);
  if (data && (data["error"] !== undefined || data["exitCode"] !== undefined || data["exit_code"] !== undefined)) return "error";
  return "tool_result";
}

function resolveMessagePartKind(raw: Record<string, unknown>): ActivityKind {
  const part = recordValue(raw["part"]);
  const data = recordValue(raw["data"]);
  const dataPart = recordValue(data?.["part"]);
  const content = stringValue(part?.["content"]) ?? stringValue(dataPart?.["content"]) ?? "";
  const type = stringValue(part?.["type"]) ?? stringValue(dataPart?.["type"]) ?? stringValue(raw["type"]);
  if (type === "thinking" || content.startsWith("<thinking>") || content.startsWith("<reasoning>")) return "thinking";
  if (type === "tool_use" || type === "tool_call") return "tool_use";
  if (type === "tool_result" || type === "tool_result") return "tool_result";
  if (type === "error" || content.includes("error") || content.includes("Error")) return "error";
  return "text";
}

function resolveLspDiagnosticsKind(raw: Record<string, unknown>): ActivityKind {
  const data = recordValue(raw["data"]);
  const diagnostics = data?.["diagnostics"] ?? raw["diagnostics"];
  if (Array.isArray(diagnostics)) {
    for (const d of diagnostics) {
      const diag = recordValue(d);
      const severity = typeof diag?.["severity"] === "number" ? diag["severity"] : typeof diag?.["severity"] === "string" ? Number.parseInt(String(diag["severity"]), 10) : 0;
      // LSP severity: 1=Error, 2=Warning, 3=Info, 4=Hint
      if (severity === 1) return "error";
    }
  }
  return "text";
}

const MAX_BODY_LENGTH = 500;
const SECRET_PATTERNS = [/(?:\b|_)token(?:\b|_)/i, /(?:\b|_)secret(?:\b|_)/i, /(?:\b|_)password(?:\b|_)/i, /(?:\b|_)key(?:\b|_)/i, /bearer\s+\S+/i, /sk-\S+/i];

function maskSecrets(value: string): string {
  let masked = value;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, "[REDACTED]");
  }
  return masked;
}

function summarizePluginEvent(raw: Record<string, unknown>): string {
  const event = typeof raw["event"] === "string" ? raw["event"] : "";
  const data = raw["data"];
  let summary = "";
  if (data && typeof data === "object" && !Array.isArray(data)) {
    summary = summarizeDataObject(data as Record<string, unknown>);
  }
  const rawText = event ? `${event}${summary ? `: ${summary}` : ""}` : summary;
  return truncateBody(maskSecrets(rawText));
}

function summarizeDataObject(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const skipKeys = new Set(["diagnostics", "part", "content", "message", "tool", "description", "session", "file"]);
  for (const [key, value] of Object.entries(data)) {
    if (skipKeys.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.length > 100) {
      parts.push(`${key}=${maskSecrets(truncateBody(value, 80))}`);
    } else if (typeof value !== "object") {
      parts.push(`${key}=${maskSecrets(String(value))}`);
    }
  }
  const message = stringValue(data["message"]);
  const tool = stringValue(data["tool"]);
  const description = stringValue(data["description"]);
  const file = stringValue(data["file"]);
  const session = stringValue(data["session"]);
  if (message) parts.push(maskSecrets(truncateBody(message, 200)));
  if (tool) parts.push(`tool=${tool}`);
  if (description) parts.push(maskSecrets(truncateBody(description, 100)));
  if (file) parts.push(`file=${file}`);
  if (session) parts.push(`session=${session}`);
  return parts.slice(0, 5).join(" ");
}

function truncateBody(value: string, max = MAX_BODY_LENGTH): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
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
  const partType = extractPartType(raw);
  return {
    deployId,
    timestamp,
    kind,
    source,
    body,
    ...(partType ? { partType } : {}),
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { metadata } : {}),
  };
}

function extractPartType(raw: Record<string, unknown>): string | undefined {
  const part = recordValue(raw["part"]);
  const data = recordValue(raw["data"]);
  const dataPart = recordValue(data?.["part"]);
  return stringValue(raw["partType"])
    ?? stringValue(raw["part_type"])
    ?? stringValue(part?.["type"])
    ?? stringValue(data?.["partType"])
    ?? stringValue(data?.["part_type"])
    ?? stringValue(dataPart?.["type"])
    ?? stringValue(raw["type"]);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
