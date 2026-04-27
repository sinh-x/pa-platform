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
  if (data && hasToolFailure(data)) return "error";
  return "tool_result";
}

function hasToolFailure(data: Record<string, unknown>): boolean {
  if (hasNonEmptyValue(data["error"]) || hasNonZeroExitCode(data["exitCode"]) || hasNonZeroExitCode(data["exit_code"])) return true;
  const result = recordValue(data["result"]);
  if (result && (hasNonEmptyValue(result["error"]) || hasNonZeroExitCode(result["exitCode"]) || hasNonZeroExitCode(result["exit_code"]))) return true;
  const metadata = recordValue(data["metadata"]) ?? recordValue(result?.["metadata"]);
  return !!metadata && (hasNonZeroExitCode(metadata["exitCode"]) || hasNonZeroExitCode(metadata["exit_code"]));
}

function hasNonEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function hasNonZeroExitCode(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(numberValue) && numberValue !== 0;
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
const SENSITIVE_PATH_PATTERNS = [/(^|\s)\S*\/(?:\.env(?:\.|\s|$)|\.ssh\/id_\S*|credentials\S*|secrets?\S*\.(?:json|ya?ml)|[-_]token\.json|[-_]api[-_]?key\.json|\.netrc|\.npmrc|\.pypirc)/gi, /(^|\s)(?:\.env(?:\.\S*)?|credentials\S*|secrets?\S*\.(?:json|ya?ml)|[-_]?token\.json|[-_]?api[-_]?key\.json)(?=\s|$)/gi];

function maskSecrets(value: string): string {
  let masked = value;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, "[REDACTED]");
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    masked = masked.replace(pattern, "$1[REDACTED_FILE]");
  }
  return masked;
}

export function summarizePluginEvent(raw: Record<string, unknown>): string {
  const event = typeof raw["event"] === "string" ? raw["event"] : "";
  const data = recordValue(raw["data"]);
  const summary = data ? summarizeEventData(event, data) : "";
  const rawText = event ? `${event}${summary ? `: ${summary}` : ""}` : summary;
  return truncateBody(maskSecrets(rawText));
}

function summarizeEventData(event: string, data: Record<string, unknown>): string {
  switch (event) {
    case "message.part.updated":
    case "message.updated":
      return summarizeMessageData(data);
    case "message.part.removed":
    case "message.removed":
      return summarizeFields(data, ["id", "partId", "part_id", "messageId", "message_id", "sessionId", "sessionID"]);
    case "tool.execute.before":
    case "tool_call":
    case "tool_use":
      return summarizeToolData(data, false);
    case "tool.execute.after":
    case "tool_success":
    case "tool_error":
    case "tool_result":
      return summarizeToolData(data, true);
    case "session.created":
    case "session.updated":
    case "session.status":
    case "session.idle":
    case "session.compacted":
    case "session.diff":
    case "session.deleted":
    case "session.error":
      return summarizeFields(data, ["session", "sessionId", "sessionID", "id", "status", "title", "message", "error", "diff"]);
    case "permission.asked":
    case "permission.replied":
      return summarizeFields(data, ["permission", "status", "decision", "tool", "message", "summary"]);
    case "todo.updated":
      return summarizeTodoData(data);
    case "command.executed":
    case "tui.command.execute":
      return summarizeFields(data, ["command", "name", "args", "message", "summary"]);
    case "file.edited":
      return summarizeFields(data, ["file", "path", "filePath", "file_path", "tool", "summary"]);
    case "file.watcher.updated":
      return summarizeFields(data, ["file", "path", "filePath", "file_path", "event", "change", "summary"]);
    case "lsp.client.diagnostics":
      return summarizeDiagnosticsData(data);
    case "lsp.updated":
      return summarizeFields(data, ["server", "language", "status", "message", "summary"]);
    case "installation.updated":
      return summarizeFields(data, ["version", "status", "message", "summary"]);
    case "server.connected":
      return summarizeFields(data, ["server", "url", "host", "port", "message"]);
    case "tui.prompt.append":
      return summarizeFields(data, ["text", "content", "prompt", "message"]);
    case "tui.toast.show":
      return summarizeFields(data, ["title", "message", "variant", "type"]);
    default:
      return summarizeDataObject(data);
  }
}

function summarizeMessageData(data: Record<string, unknown>): string {
  const part = recordValue(data["part"]) ?? recordValue(recordValue(data["message"])?.["part"]);
  const message = recordValue(data["message"]);
  const text = firstString(part?.["text"], part?.["content"], part?.["delta"], part?.["thinking"], part?.["message"], data["text"], data["content"], data["delta"], data["thinking"], data["message"]);
  const type = firstString(part?.["type"], data["part_type"], data["partType"], data["type"]);
  const role = firstString(message?.["role"], data["role"]);
  return [type ? `part=${type}` : "", role ? `role=${role}` : "", text ? sanitizeSummaryValue(text, 350) : ""].filter(Boolean).join(" ");
}

function summarizeToolData(data: Record<string, unknown>, includeResult: boolean): string {
  const tool = firstString(data["tool"], data["name"], recordValue(data["part"])?.["tool"]);
  const resultRecord = recordValue(data["result"]);
  const metadataRecord = recordValue(data["metadata"]) ?? recordValue(resultRecord?.["metadata"]);
  const status = firstString(data["status"], data["state"], data["exitCode"], data["exit_code"], resultRecord?.["exitCode"], resultRecord?.["exit_code"], metadataRecord?.["exitCode"], metadataRecord?.["exit_code"]);
  const args = recordValue(data["args"]) ?? recordValue(data["input"]);
  const summary = firstString(data["summary"], data["description"], data["command"], data["error"], data["message"]);
  const argSummary = args ? summarizeFields(args, ["command", "description", "filePath", "file_path", "pattern", "url"]) : "";
  const result = includeResult ? firstString(data["result"], data["output"]) : undefined;
  return [tool ? `tool=${tool}` : "", status ? `status=${status}` : "", summary ? sanitizeSummaryValue(summary, 250) : "", argSummary, result ? sanitizeSummaryValue(result, 250) : ""].filter(Boolean).join(" ");
}

function summarizeTodoData(data: Record<string, unknown>): string {
  const todos = Array.isArray(data["todos"]) ? data["todos"] : Array.isArray(data["todo"]) ? data["todo"] : undefined;
  if (todos) return `items=${todos.length} ${sanitizeSummaryValue(JSON.stringify(todos.slice(0, 5)), 300)}`;
  return summarizeFields(data, ["todo", "summary", "message"]);
}

function summarizeDiagnosticsData(data: Record<string, unknown>): string {
  const diagnostics = Array.isArray(data["diagnostics"]) ? data["diagnostics"] : [];
  const messages = diagnostics.slice(0, 3).flatMap((diagnostic) => {
    const record = recordValue(diagnostic);
    const severity = firstString(record?.["severity"]);
    const message = firstString(record?.["message"]);
    return message ? [`${severity ? `${severity}:` : ""}${message}`] : [];
  });
  return [`diagnostics=${diagnostics.length}`, ...messages.map((message) => sanitizeSummaryValue(message, 160))].join(" ");
}

function summarizeFields(data: Record<string, unknown>, keys: string[]): string {
  const parts: string[] = [];
  for (const key of keys) {
    const value = data[key];
    if (value === null || value === undefined) continue;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (!text) continue;
    parts.push(`${key}=${sanitizeSummaryValue(text, key.toLowerCase().includes("file") || key === "path" ? 120 : 220)}`);
    if (parts.length >= 5) break;
  }
  return parts.join(" ");
}

function summarizeDataObject(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const skipKeys = new Set(["diagnostics", "part", "content", "message", "tool", "description", "session", "file"]);
  for (const [key, value] of Object.entries(data)) {
    if (skipKeys.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.length > 100) {
      parts.push(`${key}=${sanitizeSummaryValue(value, 80)}`);
    } else if (typeof value !== "object") {
      parts.push(`${key}=${sanitizeSummaryValue(String(value))}`);
    }
  }
  const message = stringValue(data["message"]);
  const tool = stringValue(data["tool"]);
  const description = stringValue(data["description"]);
  const file = stringValue(data["file"]);
  const session = stringValue(data["session"]);
  if (message) parts.push(sanitizeSummaryValue(message, 200));
  if (tool) parts.push(`tool=${tool}`);
  if (description) parts.push(sanitizeSummaryValue(description, 100));
  if (file) parts.push(`file=${sanitizeSummaryValue(file, 120)}`);
  if (session) parts.push(`session=${session}`);
  return parts.slice(0, 5).join(" ");
}

function sanitizeSummaryValue(value: string, max = MAX_BODY_LENGTH): string {
  return maskSecrets(truncateBody(value, max));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return String(value);
  }
  return undefined;
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
  const body = truncateBody(maskSecrets(typeof bodyRaw === "string" ? bodyRaw : JSON.stringify(bodyRaw)));
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
