import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendActivityEvent, createActivityEvent, getDeployPaths, nowUtc, parseTimestamp, type ActivityEvent, type RuntimeAdapter, type SpawnOpts, type SpawnResult, type ResumeOpts, type HookConfig, type ToolReference } from "@pa-platform/pa-core";

export type ClaudeProvider = "anthropic";

export interface ClaudeCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

export const CLAUDE_DEFAULT_MODEL = "claude-opus-4-7";
const STDERR_TAIL_BYTES = 2000;
const STREAM_BODY_MAX_CHARS = 500;
const STREAM_SECRET_PATTERNS = [/(?:\b|_)token(?:\b|_)/i, /(?:\b|_)secret(?:\b|_)/i, /(?:\b|_)password(?:\b|_)/i, /(?:\b|_)key(?:\b|_)/i, /bearer\s+\S+/i, /sk-ant-\S+/i];

export interface ClaudeCodeAdapterOptions {
  runCommand?: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => ClaudeCommandResult;
  runBackgroundCommand?: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; logFile?: string }) => { pid?: number; sessionId?: string };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly name = "claude" as const;
  readonly defaultModel = CLAUDE_DEFAULT_MODEL;
  readonly sessionFileName = "session-id-claude.txt";

  private readonly runCommand?: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => ClaudeCommandResult;
  private readonly runBackgroundCommand: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; logFile?: string }) => { pid?: number; sessionId?: string };
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.runCommand = options.runCommand;
    this.runBackgroundCommand = options.runBackgroundCommand ?? ((args, opts) => {
      const logFile = opts.logFile ?? resolve(this.cwd, "claude.log");
      mkdirSync(dirname(logFile), { recursive: true });
      const configPath = resolve(dirname(logFile), "claude-background.json");
      writeFileSync(configPath, JSON.stringify({ args, cwd: opts.cwd, env: pickBackgroundEnv(opts.env), logFile, deploymentId: opts.env["PA_DEPLOYMENT_ID"], team: opts.env["PA_TEAM"], sessionFileName: this.sessionFileName }, null, 2));
      const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "background-runner.js");
      const child = spawn(process.execPath, [runnerPath, configPath], { cwd: opts.cwd, env: opts.env, detached: true, stdio: "ignore" });
      child.unref();
      return { pid: child.pid };
    });
  }

  spawn(opts: SpawnOpts): Promise<SpawnResult> {
    return this.runClaude(opts);
  }

  resume(opts: ResumeOpts): Promise<SpawnResult> {
    return this.runClaude(opts, opts.sessionId);
  }

  extractActivity(deployDir: string): ActivityEvent[] {
    const logPath = resolve(deployDir, "claude-output.jsonl");
    if (!existsSync(logPath)) return [];
    const events: ActivityEvent[] = [];
    for (const line of readFileSync(logPath, "utf-8").split("\n").filter(Boolean)) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        events.push(claudeJsonToActivityEvent(raw, basenameDeployId(deployDir)));
      } catch {
        events.push(createActivityEvent({ deployId: basenameDeployId(deployDir), kind: "text", source: "claude", body: line }));
      }
    }
    return events;
  }

  installHooks(_targetDir: string, _config: HookConfig): void {
    // TODO(PAP-051 Phase 3): install ~/.claude/settings.json PreToolUse/PostToolUse/Stop entries
    // via installPaClaudeHooks(env). Phase 2 leaves this a no-op so activity ingestion relies
    // solely on the stream-json parser for background mode.
  }

  describeTools(): ToolReference {
    return {
      runtime: this.name,
      markdown: [
        "Runtime: Claude Code via `cpa`.",
        "Use `cpa` for PA platform deployment and workflow commands; it invokes the runtime-neutral pa-core command set with Claude Code as the spawn target.",
        "Use `pa-core serve` for Agent API server lifecycle; `cpa` is the Claude Code deployment adapter, not the server owner.",
        "Use Claude-native tools exposed in the current session (Skill, AskUserQuestion, TeamCreate, ScheduleWakeup, Bash, Read, Edit, Write, Grep, Glob).",
        "Supported provider for `cpa deploy`: `anthropic` (default and only). Default model: `claude-opus-4-7` (override via --model or PA_CPA_DEFAULT_MODEL).",
      ].join("\n"),
    };
  }

  getCwd(): string {
    return this.cwd;
  }

  getEnv(): NodeJS.ProcessEnv {
    return this.env;
  }

  private async runClaude(opts: SpawnOpts, sessionId?: string): Promise<SpawnResult> {
    const primer = readFileSync(opts.primerPath, "utf-8");
    const activityLogPath = getDeployPaths(opts.deployId).activityLogPath;
    const model = opts.model ?? this.defaultModel;

    if (opts.mode === "foreground") {
      const args: string[] = [];
      if (sessionId) args.push("--resume", sessionId);
      args.push("--model", model);
      args.push(primer);
      const result = runInheritedCommand(args, { cwd: this.cwd, env: { ...this.env, ...opts.env } });
      const exitCode = result.status ?? 1;
      const errorMessage = adapterErrorMessage(result, exitCode);
      if (errorMessage) {
        appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "claude", body: errorMessage }), activityLogPath);
      }
      // Foreground TUI cannot observe stdout to capture a claude session id, so a
      // resumed run must replay --resume <real-token>, not <deploy-id>. Return only
      // the sessionId when one was passed in (resume case); deploy.ts skips the
      // session file when undefined.
      return { ...(sessionId ? { sessionId } : {}), exitCode, logFile: opts.logFile, ...(errorMessage ? { errorMessage } : {}) };
    }

    const args: string[] = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    if (sessionId) args.push("--resume", sessionId);
    args.push("--model", model);
    args.push(primer);

    if (opts.mode === "background") {
      const result = this.runBackgroundCommand(args, { cwd: this.cwd, env: { ...this.env, ...opts.env }, logFile: opts.logFile });
      const captured = result.sessionId ?? sessionId;
      return { ...(captured ? { sessionId: captured } : {}), exitCode: 0, logFile: opts.logFile, metadata: { pid: result.pid } };
    }

    const env = { ...this.env, ...opts.env };
    const result = this.runCommand
      ? this.runCommand(args, { cwd: this.cwd, env })
      : await runStreamingCommand(args, { cwd: this.cwd, env, deployId: opts.deployId, logFile: opts.logFile, outputPath: resolve(dirname(opts.primerPath), "claude-output.jsonl") });
    if (this.runCommand) {
      if (opts.logFile) writeLog(opts.logFile, result.stdout, result.stderr);
      const outputPath = resolve(dirname(opts.primerPath), "claude-output.jsonl");
      writeLog(outputPath, result.stdout, result.stderr);
    }
    const exitCode = result.status ?? 1;
    const errorMessage = adapterErrorMessage(result, exitCode);
    if (errorMessage) {
      appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "claude", body: errorMessage }), activityLogPath);
    }
    const captured = parseSessionId(result.stdout) ?? parseSessionId(result.stderr) ?? sessionId;
    return { ...(captured ? { sessionId: captured } : {}), exitCode, logFile: opts.logFile, ...(errorMessage ? { errorMessage } : {}) };
  }
}

function runInheritedCommand(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ClaudeCommandResult {
  // stdin/stdout stay attached to the parent TTY so the claude TUI renders normally.
  // stderr is piped so non-spawn failures (auth, model errors, mid-run crashes) leave
  // a captured tail in result.stderr; we replay it to the parent's stderr after the
  // child exits so users still see the message inline.
  const result = spawnSync("claude", args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf-8",
  });
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (stderr.length > 0) process.stderr.write(stderr);
  return { status: result.status, stdout: "", stderr, ...(result.error ? { spawnError: result.error } : {}) };
}

function adapterErrorMessage(result: ClaudeCommandResult, exitCode: number): string | undefined {
  if (result.spawnError) return result.spawnError.message;
  if (exitCode === 0) return undefined;
  const tail = tailString(result.stderr, STDERR_TAIL_BYTES);
  return tail.length > 0 ? tail : `claude exited with code ${exitCode}`;
}

// Truncates from the end by UTF-16 code units, not Unicode codepoints. Acceptable
// for diagnostic logs — same approximation opa uses for stderr tails.
function tailString(text: string, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(text.length - max);
}

interface StreamingCommandOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  deployId: string;
  logFile?: string;
  outputPath: string;
}

function runStreamingCommand(args: string[], opts: StreamingCommandOpts): Promise<ClaudeCommandResult> {
  mkdirSync(dirname(opts.outputPath), { recursive: true });
  const log = opts.logFile ? createWriteStream(opts.logFile, { flags: "a" }) : undefined;
  const jsonl = createWriteStream(opts.outputPath, { flags: "a" });
  // Both this writer and the (Phase 3) claude settings.json hook will append to
  // activity.jsonl concurrently. appendFileSync({flag:"a"}) line-flushed writes are
  // atomic for sub-PIPE_BUF (4096-byte) lines; STDERR_TAIL_BYTES = 2000 guarantees that.
  const activity = createClaudeActivityWriter(opts.deployId, getDeployPaths(opts.deployId).activityLogPath);
  const child = spawn("claude", args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";

  const collectStdout = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    stdout += text;
    log?.write(text);
    jsonl.write(text);
    activity.write(text);
  };
  const collectStderr = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    stderr = tailString(stderr + text, STDERR_TAIL_BYTES);
    log?.write(text);
    jsonl.write(text);
    activity.write(text);
  };

  child.stdout.on("data", collectStdout);
  child.stderr.on("data", collectStderr);

  return new Promise((resolvePromise) => {
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
      stderr = tailString(stderr + error.message, STDERR_TAIL_BYTES);
      activity.write(JSON.stringify({ type: "error", timestamp: Date.now(), message: error.message }) + "\n");
    });
    child.on("close", (code) => {
      activity.flush();
      log?.end();
      jsonl.end();
      resolvePromise({ status: code ?? 1, stdout, stderr, ...(spawnError ? { spawnError } : {}) });
    });
  });
}

export function createClaudeActivityWriter(deployId: string, activityLogPath: string): { write(text: string): void; flush(): void } {
  let pending = "";
  const processLine = (line: string): void => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      appendActivityEvent(claudeJsonToActivityEvent(raw, deployId), activityLogPath);
    } catch {
      appendActivityEvent(createActivityEvent({ deployId, kind: "text", source: "claude", body: line }), activityLogPath);
    }
  };
  return {
    write(text: string): void {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    },
    flush(): void {
      processLine(pending);
      pending = "";
    },
  };
}

export function claudeJsonToActivityEvent(raw: Record<string, unknown>, deployId: string): ActivityEvent {
  return createActivityEvent({
    deployId: String(raw["deploy_id"] ?? raw["deployId"] ?? deployId),
    timestamp: normalizeTimestamp(raw["timestamp"]),
    kind: normalizeKind(raw),
    source: extractSource(raw),
    body: extractBody(raw),
    partType: extractPartType(raw),
    metadata: raw,
  });
}

export function resolveClaudeModel(provider: string | undefined, model: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  normalizeProvider(provider);
  if (model && model.length > 0) return model;
  const envOverride = env["PA_CPA_DEFAULT_MODEL"];
  if (envOverride && envOverride.length > 0) return envOverride;
  return CLAUDE_DEFAULT_MODEL;
}

export function normalizeProvider(provider: string | undefined): ClaudeProvider {
  if (!provider || provider === "anthropic") return "anthropic";
  throw new Error(`Unsupported cpa provider: ${provider}. Supported providers: anthropic`);
}

function writeLog(path: string, stdout: string, stderr: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [stdout, stderr].filter(Boolean).join("\n"), "utf-8");
}

function parseSessionId(output: string): string | undefined {
  for (const line of output.split("\n").filter(Boolean)) {
    const id = parseSessionIdLine(line);
    if (id) return id;
  }
  return undefined;
}

function parseSessionIdLine(line: string): string | undefined {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const session = raw["session_id"] ?? raw["sessionID"] ?? raw["sessionId"];
    if (typeof session === "string" && session.length > 0) return session;
  } catch {
    const match = line.match(/session(?:_id|ID|Id)["':=\s]+([a-zA-Z0-9_-]+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

// Line-buffered session-id parser: claude stream-json may split a session_id line
// across multiple stdout chunks, so per-chunk regex/JSON.parse is unsafe.
// Accumulate until newline; only inspect complete lines.
export function createClaudeSessionIdParser(): { write(text: string): void; flush(): string | undefined } {
  let pending = "";
  let captured: string | undefined;
  const inspect = (line: string): void => {
    if (captured || !line.trim()) return;
    const id = parseSessionIdLine(line);
    if (id) captured = id;
  };
  return {
    write(text: string): void {
      if (captured) return;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) inspect(line);
    },
    flush(): string | undefined {
      if (!captured && pending) inspect(pending);
      pending = "";
      return captured;
    },
  };
}

function normalizeKind(raw: Record<string, unknown>): ActivityEvent["kind"] {
  if (raw["is_error"] === true) return "error";
  const type = String(raw["type"] ?? raw["kind"] ?? "text").toLowerCase();
  const subtype = String(raw["subtype"] ?? "").toLowerCase();
  if (type === "result" && subtype && !["success"].includes(subtype)) return "error";
  if (type === "result") return "text";
  if (type === "system") return "text";
  if (type === "rate_limit_event") return "text";
  const message = recordValue(raw["message"]);
  const content = arrayValue(message?.["content"]);
  const firstPart = content && content.length > 0 ? recordValue(content[0]) : undefined;
  const partType = String(firstPart?.["type"] ?? "").toLowerCase();
  if (partType === "thinking") return "thinking";
  if (partType === "tool_use") return "tool_use";
  if (partType === "tool_result") return "tool_result";
  if (partType === "text") return "text";
  if (type === "assistant" || type === "user") return "text";
  if (type.includes("error")) return "error";
  return "text";
}

function extractBody(raw: Record<string, unknown>): string {
  const type = String(raw["type"] ?? "").toLowerCase();
  if (type === "result") {
    const result = raw["result"];
    if (typeof result === "string") return sanitizeStreamBody(result);
    return sanitizeStreamBody(`result ${String(raw["subtype"] ?? "")}`.trim());
  }
  if (type === "system") {
    const subtype = String(raw["subtype"] ?? "");
    const hookName = stringValue(raw["hook_name"]);
    if (subtype === "init") return sanitizeStreamBody(`system init session ${stringValue(raw["session_id"])?.slice(0, 8) ?? ""}`.trim());
    return sanitizeStreamBody(`system ${subtype}${hookName ? ` ${hookName}` : ""}`.trim());
  }
  const message = recordValue(raw["message"]);
  const content = arrayValue(message?.["content"]);
  if (content && content.length > 0) {
    const firstPart = recordValue(content[0]);
    const partType = String(firstPart?.["type"] ?? "").toLowerCase();
    if (partType === "text") return sanitizeStreamBody(stringValue(firstPart?.["text"]) ?? "");
    if (partType === "thinking") return sanitizeStreamBody(stringValue(firstPart?.["thinking"]) ?? "");
    if (partType === "tool_use") {
      const tool = stringValue(firstPart?.["name"]) ?? "tool";
      const input = recordValue(firstPart?.["input"]);
      const description = stringValue(input?.["description"] ?? input?.["command"] ?? input?.["filePath"] ?? input?.["file_path"] ?? input?.["pattern"] ?? input?.["url"]);
      return sanitizeStreamBody([tool, description].filter(Boolean).join(" "));
    }
    if (partType === "tool_result") {
      const output = firstPart?.["content"];
      const text = typeof output === "string" ? output : Array.isArray(output) && output.length > 0 ? stringValue(recordValue(output[0])?.["text"]) ?? "" : "";
      return sanitizeStreamBody(`tool_result ${text}`.trim());
    }
  }
  const fallback = raw["text"] ?? raw["content"] ?? raw["message"] ?? raw["body"] ?? raw["type"] ?? "";
  return sanitizeStreamBody(typeof fallback === "string" ? fallback : JSON.stringify(fallback));
}

function sanitizeStreamBody(value: string): string {
  let result = value;
  for (const pattern of STREAM_SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result.length > STREAM_BODY_MAX_CHARS ? `${result.slice(0, STREAM_BODY_MAX_CHARS - 3)}...` : result;
}

function extractSource(raw: Record<string, unknown>): string {
  const sessionId = stringValue(raw["session_id"] ?? raw["sessionID"] ?? raw["sessionId"]);
  return sessionId ? sessionId.slice(0, 8) : "claude";
}

function extractPartType(raw: Record<string, unknown>): string | undefined {
  const message = recordValue(raw["message"]);
  const content = arrayValue(message?.["content"]);
  const firstPart = content && content.length > 0 ? recordValue(content[0]) : undefined;
  return stringValue(firstPart?.["type"] ?? raw["subtype"] ?? raw["type"]);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return parseTimestamp(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return nowUtc(new Date(value));
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basenameDeployId(deployDir: string): string {
  return deployDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown";
}

function pickBackgroundEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PA_AI_USAGE_HOME", "PA_REGISTRY_DB", "PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_ACTIVITY_LOG", "PA_TEAM", "PA_CPA_DEFAULT_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const) {
    if (env[key]) picked[key] = env[key]!;
  }
  return picked;
}
