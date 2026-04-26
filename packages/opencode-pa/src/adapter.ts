import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendActivityEvent, createActivityEvent, getDeployPaths, type ActivityEvent, type RuntimeAdapter, type SpawnOpts, type SpawnResult, type ResumeOpts, type HookConfig } from "@pa-platform/pa-core";

export type OpencodeProvider = "minimax" | "openai";

export interface OpencodeCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

const STDERR_TAIL_BYTES = 2000;

export interface OpencodeAdapterOptions {
  runCommand?: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => OpencodeCommandResult;
  runBackgroundCommand?: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; logFile?: string }) => { pid?: number; sessionId?: string };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const PROVIDER_DEFAULT_MODELS: Record<OpencodeProvider, string> = {
  minimax: process.env["OPA_MINIMAX_MODEL"] ?? "minimax-coding-plan/MiniMax-M2.7",
  openai: process.env["OPA_OPENAI_MODEL"] ?? "openai/gpt-5.5",
};

export class OpencodeAdapter implements RuntimeAdapter {
  readonly name = "opencode" as const;
  readonly defaultModel = PROVIDER_DEFAULT_MODELS.openai;
  readonly sessionFileName = "session-id-opencode.txt";

  private readonly runCommand?: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => OpencodeCommandResult;
  private readonly runBackgroundCommand: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; logFile?: string }) => { pid?: number; sessionId?: string };
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: OpencodeAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.runCommand = options.runCommand;
    this.runBackgroundCommand = options.runBackgroundCommand ?? ((args, opts) => {
      const logFile = opts.logFile ?? resolve(this.cwd, "opencode.log");
      mkdirSync(dirname(logFile), { recursive: true });
      const configPath = resolve(dirname(logFile), "opencode-background.json");
      writeFileSync(configPath, JSON.stringify({ args, cwd: opts.cwd, env: pickBackgroundEnv(opts.env), logFile, deploymentId: opts.env["PA_DEPLOYMENT_ID"], team: opts.env["PA_TEAM"], sessionFileName: this.sessionFileName }, null, 2));
      const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "background-runner.js");
      const child = spawn(process.execPath, [runnerPath, configPath], { cwd: opts.cwd, env: opts.env, detached: true, stdio: "ignore" });
      child.unref();
      return { pid: child.pid };
    });
  }

  spawn(opts: SpawnOpts): Promise<SpawnResult> {
    return this.runOpencode(opts);
  }

  resume(opts: ResumeOpts): Promise<SpawnResult> {
    return this.runOpencode(opts, opts.sessionId);
  }

  extractActivity(deployDir: string): ActivityEvent[] {
    const logPath = resolve(deployDir, "opencode-output.jsonl");
    if (!existsSync(logPath)) return [];
    const events: ActivityEvent[] = [];
    for (const line of readFileSync(logPath, "utf-8").split("\n").filter(Boolean)) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        events.push(createActivityEvent({
          deployId: String(raw["deployId"] ?? basenameDeployId(deployDir)),
          timestamp: normalizeTimestamp(raw["timestamp"]),
          kind: normalizeKind(raw),
          source: extractSource(raw),
          body: extractBody(raw),
          metadata: raw,
        }));
      } catch {
        events.push(createActivityEvent({ deployId: basenameDeployId(deployDir), kind: "text", source: "opencode", body: line }));
      }
    }
    return events;
  }

  installHooks(_targetDir: string, _config: HookConfig): void {
    // opencode uses global/local JS plugins; PAP-002 only needs the adapter env contract.
  }

  describeTools() {
    return {
      runtime: this.name,
      markdown: [
        "Runtime: opencode via `opa`.",
        "Use opencode tools exposed in the current session; do not assume Claude-only TeamCreate, SendMessage, Agent, AskUserQuestion, or ScheduleWakeup tools exist.",
        "Supported providers for `opa deploy`: `minimax` and `openai` (default).",
      ].join("\n"),
    };
  }

  private async runOpencode(opts: SpawnOpts, sessionId?: string): Promise<SpawnResult> {
    const primer = readFileSync(opts.primerPath, "utf-8");
    const activityLogPath = getDeployPaths(opts.deployId).activityLogPath;
    if (opts.mode === "foreground" || opts.mode === "direct" || opts.mode === "interactive") {
      const args = ["-m", opts.model ?? this.defaultModel];
      if (sessionId) args.push("--session", sessionId);
      args.push("--prompt", primer);
      const result = runInheritedCommand(args, { cwd: this.cwd, env: { ...this.env, ...opts.env } });
      const exitCode = result.status ?? 1;
      const errorMessage = adapterErrorMessage(result, exitCode);
      if (errorMessage) {
        appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "opencode", body: errorMessage }), activityLogPath);
      }
      return { sessionId: sessionId ?? opts.deployId, exitCode, logFile: opts.logFile, ...(errorMessage ? { errorMessage } : {}) };
    }

    const args = ["run", "-m", opts.model ?? this.defaultModel, "--dangerously-skip-permissions"];
    if (sessionId) args.push("--session", sessionId);
    args.push("--format", "json");
    args.push(primer);

    if (opts.mode === "background") {
      const result = this.runBackgroundCommand(args, { cwd: this.cwd, env: { ...this.env, ...opts.env }, logFile: opts.logFile });
      return { sessionId: result.sessionId ?? sessionId ?? opts.deployId, exitCode: 0, logFile: opts.logFile, metadata: { pid: result.pid } };
    }

    const env = { ...this.env, ...opts.env };
    const result = this.runCommand
      ? this.runCommand(args, { cwd: this.cwd, env })
      : await runStreamingCommand(args, { cwd: this.cwd, env, deployId: opts.deployId, logFile: opts.logFile, outputPath: resolve(dirname(opts.primerPath), "opencode-output.jsonl") });
    if (this.runCommand) {
      if (opts.logFile) writeLog(opts.logFile, result.stdout, result.stderr);
      const outputPath = resolve(dirname(opts.primerPath), "opencode-output.jsonl");
      writeLog(outputPath, result.stdout, result.stderr);
    }
    const exitCode = result.status ?? 1;
    const errorMessage = adapterErrorMessage(result, exitCode);
    if (errorMessage) {
      appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "opencode", body: errorMessage }), activityLogPath);
    }
    return { sessionId: parseSessionId(result.stdout) ?? parseSessionId(result.stderr) ?? sessionId ?? opts.deployId, exitCode, logFile: opts.logFile, ...(errorMessage ? { errorMessage } : {}) };
  }
}

function runInheritedCommand(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): OpencodeCommandResult {
  const result = spawnSync("opencode", args, { cwd: opts.cwd, env: opts.env, stdio: "inherit" });
  return { status: result.status, stdout: "", stderr: result.error?.message ?? "", ...(result.error ? { spawnError: result.error } : {}) };
}

function adapterErrorMessage(result: OpencodeCommandResult, exitCode: number): string | undefined {
  if (result.spawnError) return result.spawnError.message;
  if (exitCode === 0) return undefined;
  const tail = tailString(result.stderr, STDERR_TAIL_BYTES);
  return tail.length > 0 ? tail : `opencode exited with code ${exitCode}`;
}

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

function runStreamingCommand(args: string[], opts: StreamingCommandOpts): Promise<OpencodeCommandResult> {
  mkdirSync(dirname(opts.outputPath), { recursive: true });
  const log = opts.logFile ? createWriteStream(opts.logFile, { flags: "a" }) : undefined;
  const jsonl = createWriteStream(opts.outputPath, { flags: "a" });
  const activity = createOpencodeActivityWriter(opts.deployId, getDeployPaths(opts.deployId).activityLogPath);
  const child = spawn("opencode", args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
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

export function createOpencodeActivityWriter(deployId: string, activityLogPath: string): { write(text: string): void; flush(): void } {
  let pending = "";
  const processLine = (line: string): void => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      appendActivityEvent(opencodeJsonToActivityEvent(raw, deployId), activityLogPath);
    } catch {
      appendActivityEvent(createActivityEvent({ deployId, kind: "text", source: "opencode", body: line }), activityLogPath);
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

export function opencodeJsonToActivityEvent(raw: Record<string, unknown>, deployId: string): ActivityEvent {
  return createActivityEvent({
    deployId: String(raw["deployId"] ?? deployId),
    timestamp: normalizeTimestamp(raw["timestamp"]),
    kind: normalizeKind(raw),
    source: extractSource(raw),
    body: extractBody(raw),
    metadata: raw,
  });
}

export function resolveOpencodeModel(provider: string | undefined, model: string | undefined): string {
  if (model?.includes("/")) return model;
  const normalized = normalizeProvider(provider);
  if (model) return `${normalized === "minimax" ? "minimax-coding-plan" : normalized}/${model}`;
  return PROVIDER_DEFAULT_MODELS[normalized];
}

export function normalizeProvider(provider: string | undefined): OpencodeProvider {
  if (!provider || provider === "minimax") return "minimax";
  if (provider === "openai") return "openai";
  throw new Error(`Unsupported opa provider: ${provider}. Supported providers: minimax, openai`);
}

function writeLog(path: string, stdout: string, stderr: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [stdout, stderr].filter(Boolean).join("\n"), "utf-8");
}

function parseSessionId(output: string): string | undefined {
  for (const line of output.split("\n").filter(Boolean)) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const session = raw["sessionID"] ?? raw["sessionId"] ?? raw["session_id"] ?? raw["id"];
      if (typeof session === "string" && session.length > 0) return session;
    } catch {
      const match = line.match(/session(?:ID|Id|_id)?["':=\s]+([a-zA-Z0-9_-]+)/);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}

function normalizeKind(raw: Record<string, unknown>): ActivityEvent["kind"] {
  const part = recordValue(raw["part"]);
  const state = recordValue(part?.["state"]);
  const status = String(state?.["status"] ?? "").toLowerCase();
  const type = String(raw["type"] ?? raw["kind"] ?? part?.["type"] ?? raw["role"] ?? "text").toLowerCase();
  if (["error", "failed", "failure"].includes(status)) return "error";
  if (type.includes("tool") && ["completed", "success", "done"].includes(status)) return "tool_result";
  if (type.includes("tool") && type.includes("result")) return "tool_result";
  if (type.includes("tool")) return "tool_use";
  if (type.includes("think") || type.includes("reason")) return "thinking";
  if (type.includes("error")) return "error";
  return "text";
}

function extractBody(raw: Record<string, unknown>): string {
  const part = recordValue(raw["part"]);
  const state = recordValue(part?.["state"]);
  const input = recordValue(state?.["input"]);
  const tool = stringValue(part?.["tool"] ?? raw["tool"]);
  if (tool) {
    const status = stringValue(state?.["status"]);
    const description = stringValue(input?.["description"] ?? input?.["command"] ?? input?.["filePath"] ?? input?.["file_path"] ?? input?.["pattern"] ?? input?.["url"]);
    return [tool, status, description].filter(Boolean).join(" ");
  }
  const body = part?.["text"] ?? part?.["thinking"] ?? raw["text"] ?? raw["content"] ?? raw["message"] ?? raw["body"] ?? raw["type"] ?? "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

function extractSource(raw: Record<string, unknown>): string {
  const sessionId = stringValue(raw["sessionID"] ?? raw["sessionId"] ?? raw["session_id"]);
  return sessionId ? sessionId.slice(0, 8) : "opencode";
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basenameDeployId(deployDir: string): string {
  return deployDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown";
}

function pickBackgroundEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PA_AI_USAGE_HOME", "PA_REGISTRY_DB", "PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_ACTIVITY_LOG", "PA_TEAM"] as const) {
    if (env[key]) picked[key] = env[key]!;
  }
  return picked;
}
