import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { SAFETY_PATTERNS } from "../safety-rules.js";

export const PA_DROID_SAFETY_SCRIPT = "pa-safety.js";
const PA_DROID_SAFETY_PATTERNS = "pa-safety-patterns.json";

interface HooksConfig {
  hooks?: {
    PreToolUse?: HookMatcherEntry[];
    PostToolUse?: HookMatcherEntry[];
  };
}

interface HookMatcherEntry {
  matcher: string;
  hooks: HookCommandEntry[];
}

interface HookCommandEntry {
  type: "command";
  command: string;
}

export function resolveDroidHooksPath(env: NodeJS.ProcessEnv = process.env): string {
  const factoryDir = env["FACTORY_DIR"] ?? join(env["HOME"] ?? homedir(), ".factory");
  return join(factoryDir, "hooks.json");
}

export function resolveSafetyScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  const factoryDir = env["FACTORY_DIR"] ?? join(env["HOME"] ?? homedir(), ".factory");
  return join(factoryDir, "hooks", PA_DROID_SAFETY_SCRIPT);
}

export function installDroidSafetyScript(env: NodeJS.ProcessEnv = process.env): string {
  const scriptPath = resolveSafetyScriptPath(env);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, DROID_SAFETY_SCRIPT_SOURCE, "utf-8");
  return scriptPath;
}

export function installDroidSafetyPatterns(env: NodeJS.ProcessEnv = process.env): string {
  const factoryDir = env["FACTORY_DIR"] ?? join(env["HOME"] ?? homedir(), ".factory");
  const patternsPath = join(factoryDir, "hooks", PA_DROID_SAFETY_PATTERNS);
  mkdirSync(dirname(patternsPath), { recursive: true });
  writeFileSync(patternsPath, JSON.stringify(SAFETY_PATTERNS, null, 2) + "\n", "utf-8");
  return patternsPath;
}

export function installPaDroidHooks(env: NodeJS.ProcessEnv = process.env): void {
  const scriptPath = installDroidSafetyScript(env);
  installDroidSafetyPatterns(env);
  const hooksPath = resolveDroidHooksPath(env);
  const scriptCmd = `node ${scriptPath}`;

  let config: HooksConfig = {};
  if (existsSync(hooksPath)) {
    try {
      config = JSON.parse(readFileSync(hooksPath, "utf-8")) as HooksConfig;
    } catch {
      config = {};
    }
  }

  config.hooks = config.hooks ?? {};

  // Merge PreToolUse: add our hook at user scope, dedupe by command
  config.hooks.PreToolUse = mergeMatcherEntry(
    config.hooks.PreToolUse ?? [],
    "*",
    scriptCmd,
  );

  // Merge PostToolUse: append activity + mask sensitive output
  config.hooks.PostToolUse = mergeMatcherEntry(
    config.hooks.PostToolUse ?? [],
    "*",
    scriptCmd,
  );

  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function mergeMatcherEntry(
  entries: HookMatcherEntry[],
  matcher: string,
  command: string,
): HookMatcherEntry[] {
  const existing = entries.find((e) => e.matcher === matcher);
  if (existing) {
    const hasCommand = existing.hooks.some(
      (h) => h.type === "command" && h.command === command,
    );
    if (!hasCommand) {
      existing.hooks.push({ type: "command", command });
    }
    return entries;
  }
  return [...entries, { matcher, hooks: [{ type: "command", command }] }];
}

const DROID_SAFETY_SCRIPT_SOURCE = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const STREAM_BODY_MAX_CHARS = 500;

function loadSensitivePatterns() {
  const patternsPath = join(homedir(), ".factory", "hooks", "sensitive-patterns.conf");
  if (!existsSync(patternsPath)) return [];
  return readFileSync(patternsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const sep = line.indexOf("|");
      return sep === -1 ? null : { label: line.slice(0, sep), pattern: line.slice(sep + 1) };
    })
    .filter(Boolean);
}

const PATTERNS = loadSensitivePatterns();

const BUILTIN_SECRET_PATTERNS = [
  { label: "API_KEY", pattern: /(?:\b|_)(?:api[_-]?key|access[_-]?key|secret[_-]?key)(?:\b|_)/gi },
  { label: "TOKEN", pattern: /(?:\b|_)token(?:\b|_)/gi },
  { label: "PASSWORD", pattern: /(?:\b|_)password(?:\b|_)/gi },
  { label: "SECRET", pattern: /(?:\b|_)secret(?:\b|_)/gi },
  { label: "BEARER", pattern: /bearer\s+\S+/gi },
  { label: "SK_ANT", pattern: /sk-ant-\S+/gi },
  { label: "FK_KEY", pattern: /fk-[a-zA-Z0-9_-]{20,}/gi },
];

function loadSafetyPatterns() {
  const patternsPath = join(homedir(), ".factory", "hooks", "pa-safety-patterns.json");
  if (!existsSync(patternsPath)) return { destructiveCommands: [], blockedFilePatterns: [] };
  try {
    return JSON.parse(readFileSync(patternsPath, "utf-8"));
  } catch {
    return { destructiveCommands: [], blockedFilePatterns: [] };
  }
}

const SAFETY = loadSafetyPatterns();
const DESTS = (SAFETY.destructiveCommands || []).map((p) => { try { return new RegExp(p, "i"); } catch { return null; } }).filter(Boolean);
const BLOCKED_FILE_PATTERNS = (SAFETY.blockedFilePatterns || []).map((p) => { try { return new RegExp(p, "i"); } catch { return null; } }).filter(Boolean);
const BLOCKED_FILE_HARDCODED = [
  /(^|[\\/])\.env(\.|$)/,
  /(^|[\\/])\.ssh[\\/]id_/,
  /credentials/i,
  /secrets?.*\.(json|ya?ml)$/i,
  /[-_]token\.json$/i,
  /[-_]api[-_]?key\.json$/i,
  /(^|[\\/])\.netrc$/,
  /(^|[\\/])\.npmrc$/,
  /(^|[\\/])\.pypirc$/,
];

function truncate(value, max = STREAM_BODY_MAX_CHARS) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function isBlockedFilePath(filePath) {
  if (!filePath) return false;
  for (const pattern of BLOCKED_FILE_HARDCODED) {
    if (pattern.test(filePath)) return true;
  }
  for (const pattern of BLOCKED_FILE_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  for (const { label, pattern } of PATTERNS) {
    if (label !== "FILE") continue;
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(basename(filePath)) || regex.test(filePath)) return true;
    } catch {}
  }
  return false;
}

function containsDestructiveCommand(command) {
  if (!command) return false;
  for (const pattern of DESTS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

function maskSensitiveText(text) {
  if (!text) return text;
  let result = text;
  for (const { label, pattern } of PATTERNS) {
    if (label === "FILE" || label.startsWith("JSON_")) continue;
    try {
      result = result.replace(new RegExp(pattern, "g"), "[REDACTED_" + label + "]");
    } catch (e) {}
  }
  for (const { label, pattern } of BUILTIN_SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED_" + label + "]");
  }
  return result;
}

function deploymentId(env) {
  return env.PA_DEPLOYMENT_ID || "unknown";
}

function isPaDeployment(env) {
  return Boolean(env.PA_ACTIVITY_LOG || env.PA_DEPLOYMENT_DIR);
}

function activityLogPath(env) {
  if (env.PA_ACTIVITY_LOG) return env.PA_ACTIVITY_LOG;
  if (env.PA_DEPLOYMENT_DIR) return join(env.PA_DEPLOYMENT_DIR, "activity.jsonl");
  return "";
}

function appendActivity(env, event) {
  if (!isPaDeployment(env)) return;
  const path = activityLogPath(env);
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({
    ts: new Date().toISOString(),
    deploy_id: deploymentId(env),
    source: "droid-hook",
    ...event,
  }) + "\n");
}

function summarizeTool(toolName, toolInput) {
  if (!toolInput) return "";
  switch (toolName) {
    case "Execute": return truncate(toolInput.command);
    case "Read":
    case "Edit":
    case "Create": return truncate(toolInput.file_path || toolInput.filePath);
    case "Grep": return truncate((toolInput.pattern || "") + " -> " + (toolInput.path || "."));
    case "Glob": return truncate(String(toolInput.patterns || toolInput.pattern || ""));
    case "FetchUrl":
    case "WebSearch": return truncate(toolInput.url || toolInput.query || "", 150);
    case "Task": return truncate((toolInput.subagent_type || "") + ": " + (toolInput.description || ""));
    case "Skill": return truncate(toolInput.skill || "");
    case "AskUser": {
      const q = toolInput.questionnaire || "";
      const firstLine = q.split("\n")[0] || "";
      return truncate(firstLine);
    }
    case "ExitSpecMode": {
      const raw = toolInput.plan || toolInput.title || "";
      const firstLine = raw.split("\n")[0] || "";
      return truncate(firstLine);
    }
    case "ToolSearch": return truncate(toolInput.query || "");
    case "GenerateDroid": return truncate(toolInput.description || "");
    default: return truncate(toolInput);
  }
}

function resolveFilePath(args) {
  return args?.file_path || args?.filePath || args?.path || "";
}

try {
  const raw = readFileSync(0, "utf-8");
  if (!raw || raw.trim().length === 0) {
    console.error("pa-safety hook: empty stdin");
    process.exit(0);
  }
  const input = JSON.parse(raw);
  const hookEvent = input.hook_event_name || "";
  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const env = process.env;

  if (hookEvent === "PreToolUse") {
    // Block destructive commands
    if (toolName === "Execute" && containsDestructiveCommand(toolInput.command)) {
      console.error("BLOCKED: destructive command detected. Use dpa trash move instead of rm, or review the command for unsafe operations.");
      process.exit(2);
    }
    // Block sensitive file access
    const filePath = resolveFilePath(toolInput);
    if (filePath && isBlockedFilePath(filePath)) {
      console.error("BLOCKED: sensitive file access is not allowed: " + filePath);
      process.exit(2);
    }
    // Log tool.before
    appendActivity(env, {
      event: "tool.execute.before",
      data: {
        tool: toolName,
        summary: maskSensitiveText(summarizeTool(toolName, toolInput)),
      },
    });
    process.exit(0);
  }

  if (hookEvent === "PostToolUse") {
    const response = input.tool_response || {};
    let exitCode = response.exitCode;
    if (exitCode === undefined || exitCode === null) {
      exitCode = response.result?.exitCode;
    }
    if (exitCode === undefined || exitCode === null) {
      exitCode = response.result?.metadata?.exitCode;
    }
    if (typeof exitCode === "string") exitCode = Number(exitCode);
    const isError = exitCode !== undefined && exitCode !== null && exitCode !== 0;
    const body = truncate(String(
      response.error
        || (exitCode !== undefined && exitCode !== null ? "exit=" + exitCode : "")
        || response.result
        || JSON.stringify(response)
    ));
    appendActivity(env, {
      event: "tool.execute.after",
      data: {
        tool: toolName,
        kind: isError ? "error" : "info",
        exitCode: exitCode !== undefined && exitCode !== null ? exitCode : undefined,
        summary: maskSensitiveText(body),
      },
    });
    process.exit(0);
  }

  process.exit(0);
} catch (err) {
  console.error("pa-safety hook error:", err.message);
  process.exit(0);
}
`;
