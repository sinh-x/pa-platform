import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PA_CLAUDE_HOOKS_HANDLER_FILENAME = "pa-activity.mjs";
export const PA_CLAUDE_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
export type PaClaudeHookEvent = (typeof PA_CLAUDE_HOOK_EVENTS)[number];

export interface InstallPaClaudeHooksResult {
  handlerPath: string;
  settingsPath: string;
  events: PaClaudeHookEvent[];
}

export interface InstallPaClaudeHooksOptions {
  handlerPath?: string;
  settingsPath?: string;
}

// Vendored handler source. Written verbatim to <HOME>/.claude/hooks/pa-activity.mjs.
// Mirrors the JSONL shape opa's pa-safety-activity plugin emits so consumers (pa-core
// normalizeActivityEvent) stay compatible. Sensitive patterns come from
// ~/.claude/hooks/sensitive-patterns.conf with a built-in fallback when absent.
export const PA_CLAUDE_HOOKS_HANDLER_SOURCE = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const FALLBACK_PATTERNS = [
  { label: "BEARER", pattern: "Authorization:[[:space:]]*Bearer[[:space:]]+[^[:space:]]+" },
  { label: "ANTHROPIC_API_KEY", pattern: "sk-ant-[A-Za-z0-9_-]+" },
  { label: "AWS_ACCESS_KEY", pattern: "AKIA[0-9A-Z]{16}" },
  { label: "GITHUB_TOKEN", pattern: "gh[pousr]_[A-Za-z0-9_]{36,}" },
  { label: "PRIVATE_KEY", pattern: "-----BEGIN [A-Z ]+ PRIVATE KEY-----" },
]

function patternsFile() {
  return join(process.env.HOME || "", ".claude", "hooks", "sensitive-patterns.conf")
}

function readPatterns() {
  const path = patternsFile()
  if (!path || !existsSync(path)) return FALLBACK_PATTERNS
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
  const parsed = []
  for (const line of lines) {
    const sep = line.indexOf("|")
    if (sep === -1) continue
    parsed.push({ label: line.slice(0, sep), pattern: line.slice(sep + 1) })
  }
  return parsed.length > 0 ? parsed : FALLBACK_PATTERNS
}

const PATTERNS = readPatterns()

function toJavaScriptRegex(pattern) {
  // Translate POSIX bracket classes (used in opa's sensitive-patterns.conf format)
  // to JS regex equivalents. Negated form must be replaced before the bare form,
  // otherwise the inner [[:space:]] would be substituted first and leave a stray "[^\\s]".
  return pattern
    .replaceAll("[^[:space:]]", "\\S")
    .replaceAll("[[:space:]]", "\\s")
}

const COMPILED_PATTERNS = (() => {
  const compiled = []
  for (const { label, pattern } of PATTERNS) {
    if (label === "FILE" || label.startsWith("JSON_")) continue
    try {
      compiled.push({ label, regex: new RegExp(toJavaScriptRegex(pattern), "g") })
    } catch {}
  }
  return compiled
})()

function maskSensitiveText(text) {
  if (text === undefined || text === null) return text
  let result = String(text)
  for (const { label, regex } of COMPILED_PATTERNS) {
    regex.lastIndex = 0
    result = result.replace(regex, "***" + label + "_MASKED***")
  }
  return result
}

function truncate(value, max = 400) {
  if (value === undefined || value === null) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? text.slice(0, max) : text
}

function activityLogPath() {
  if (process.env.PA_ACTIVITY_LOG) return process.env.PA_ACTIVITY_LOG
  if (process.env.PA_DEPLOYMENT_DIR) return join(process.env.PA_DEPLOYMENT_DIR, "activity.jsonl")
  return ""
}

function deploymentId() {
  return process.env.PA_DEPLOYMENT_ID || "unknown"
}

function appendActivity(event) {
  const path = activityLogPath()
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  // appendFileSync is atomic for sub-PIPE_BUF (4096B) lines; matches the opa activity contract.
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), deploy_id: deploymentId(), ...event }) + "\n")
}

function shortAgent(sessionId) {
  return sessionId ? String(sessionId).slice(0, 8) : "claude"
}

function summarizeTool(tool, args) {
  if (!args || typeof args !== "object") return ""
  const lower = (tool || "").toLowerCase()
  if (lower === "bash") return truncate(args.command)
  if (lower === "read" || lower === "write" || lower === "edit") return truncate(args.file_path || args.filePath)
  if (lower === "grep") return truncate((args.pattern || "") + " -> " + (args.path || "."))
  if (lower === "glob") return truncate(args.pattern)
  if (lower === "webfetch") return truncate(args.url, 150)
  return truncate(args)
}

function maskArgs(tool, args) {
  if (!args || typeof args !== "object") return args
  const masked = {}
  for (const [key, value] of Object.entries(args)) {
    masked[key] = typeof value === "string" ? maskSensitiveText(value) : value
  }
  return masked
}

function summarizeResult(response) {
  if (response === undefined || response === null) return ""
  if (typeof response === "string") return truncate(maskSensitiveText(response))
  if (response && typeof response === "object") {
    if (response.error) return truncate(maskSensitiveText(String(response.error)))
    if (response.exitCode !== undefined) return "exit_code=" + response.exitCode
    if (response.exit_code !== undefined) return "exit_code=" + response.exit_code
    return truncate(maskSensitiveText(JSON.stringify(response)))
  }
  return ""
}

async function readStdin() {
  let data = ""
  process.stdin.setEncoding("utf-8")
  for await (const chunk of process.stdin) data += chunk
  return data
}

function handle(payload) {
  const event = payload?.hook_event_name || payload?.event || ""
  const sessionId = payload?.session_id || payload?.sessionID || payload?.sessionId || ""
  const tool = payload?.tool_name || payload?.tool || ""
  const input = payload?.tool_input || payload?.tool_args || {}
  const response = payload?.tool_response

  if (event === "PreToolUse") {
    appendActivity({
      agent: shortAgent(sessionId),
      event: "tool.execute.before",
      data: { tool, args: maskArgs(tool, input), summary: maskSensitiveText(summarizeTool(tool, input)) },
    })
    return
  }
  if (event === "PostToolUse") {
    appendActivity({
      agent: shortAgent(sessionId),
      event: "tool.execute.after",
      data: { tool, tool_use_id: payload?.tool_use_id || "", summary: summarizeResult(response) },
    })
    return
  }
  if (event === "Stop" || event === "SubagentStop") {
    appendActivity({
      agent: shortAgent(sessionId),
      event: "session.stop",
      data: { stop_hook_active: !!payload?.stop_hook_active, transcript_path: payload?.transcript_path || "" },
    })
    return
  }
  // Unknown event — log without crashing so claude execution is unaffected.
  appendActivity({
    agent: shortAgent(sessionId),
    event: event ? "claude." + event : "claude.event",
    data: { summary: truncate(maskSensitiveText(JSON.stringify(payload))) },
  })
}

readStdin()
  .then((raw) => {
    let payload = {}
    try { payload = raw ? JSON.parse(raw) : {} } catch {}
    try { handle(payload) } catch {}
    // Exit 0 unconditionally — PreToolUse non-zero would block the tool. We are a
    // logger only; we never mutate the executed command or its inputs.
    process.exit(0)
  })
  .catch(() => process.exit(0))
`;

export function resolvePaClaudeHooksHandlerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["HOME"] ?? homedir(), ".claude", "hooks", PA_CLAUDE_HOOKS_HANDLER_FILENAME);
}

export function resolvePaClaudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["HOME"] ?? homedir(), ".claude", "settings.json");
}

export function installPaClaudeHooks(env: NodeJS.ProcessEnv = process.env, options: InstallPaClaudeHooksOptions = {}): InstallPaClaudeHooksResult {
  const handlerPath = options.handlerPath ?? resolvePaClaudeHooksHandlerPath(env);
  const settingsPath = options.settingsPath ?? resolvePaClaudeSettingsPath(env);

  mkdirSync(dirname(handlerPath), { recursive: true });
  writeFileSync(handlerPath, PA_CLAUDE_HOOKS_HANDLER_SOURCE, "utf-8");
  try { chmodSync(handlerPath, 0o755); } catch { /* fs may reject chmod on some filesystems; shebang+`node` invocation still works. */ }

  const settings = readSettings(settingsPath);
  const hooks = ensureHooksObject(settings);
  for (const eventName of PA_CLAUDE_HOOK_EVENTS) {
    const entries = ensureEventArray(hooks, eventName);
    if (!entriesContainCommand(entries, handlerPath)) {
      entries.push({ hooks: [{ type: "command", command: handlerPath }] });
    }
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  return { handlerPath, settingsPath, events: [...PA_CLAUDE_HOOK_EVENTS] };
}

function readSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, "utf-8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`pa-claude-hooks: cannot parse ${settingsPath} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function ensureHooksObject(settings: Record<string, unknown>): Record<string, unknown> {
  const existing = settings["hooks"];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  settings["hooks"] = fresh;
  return fresh;
}

interface HookEntry {
  matcher?: unknown;
  hooks?: Array<{ type?: unknown; command?: unknown } | unknown>;
  [key: string]: unknown;
}

function ensureEventArray(hooks: Record<string, unknown>, eventName: PaClaudeHookEvent): HookEntry[] {
  const existing = hooks[eventName];
  if (Array.isArray(existing)) return existing as HookEntry[];
  const fresh: HookEntry[] = [];
  hooks[eventName] = fresh;
  return fresh;
}

function entriesContainCommand(entries: HookEntry[], command: string): boolean {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const inner = Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const hook of inner) {
      if (hook && typeof hook === "object" && (hook as { command?: unknown }).command === command) return true;
    }
  }
  return false;
}
