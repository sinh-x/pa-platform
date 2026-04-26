import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createActivityEvent, type ActivityEvent, type RuntimeAdapter, type SpawnOpts, type SpawnResult, type ResumeOpts, type HookConfig } from "@pa-platform/pa-core";

export type OpencodeProvider = "minimax" | "openai";

export interface OpencodeCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

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
  readonly defaultModel = PROVIDER_DEFAULT_MODELS.minimax;
  readonly sessionFileName = "session-id-opencode.txt";

  private readonly runCommand: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => OpencodeCommandResult;
  private readonly runBackgroundCommand: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; logFile?: string }) => { pid?: number; sessionId?: string };
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: OpencodeAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.runCommand = options.runCommand ?? ((args, opts) => {
      const result = spawnSync("opencode", args, { cwd: opts.cwd, env: opts.env, encoding: "utf-8" });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    });
    this.runBackgroundCommand = options.runBackgroundCommand ?? ((args, opts) => {
      const logFile = opts.logFile ?? resolve(this.cwd, "opencode.log");
      mkdirSync(dirname(logFile), { recursive: true });
      const log = createWriteStream(logFile, { flags: "a" });
      const child = spawn("opencode", args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      child.unref();
      return { pid: child.pid };
    });
  }

  spawn(opts: SpawnOpts): SpawnResult {
    return this.runOpencode(opts);
  }

  resume(opts: ResumeOpts): SpawnResult {
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
          timestamp: typeof raw["timestamp"] === "string" ? raw["timestamp"] : undefined,
          kind: normalizeKind(raw),
          source: "opencode",
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
        "Supported providers for `opa deploy`: `minimax` (default) and `openai`.",
      ].join("\n"),
    };
  }

  private runOpencode(opts: SpawnOpts, sessionId?: string): SpawnResult {
    const primer = readFileSync(opts.primerPath, "utf-8");
    const args = ["run", "-m", opts.model ?? this.defaultModel, "--dangerously-skip-permissions"];
    if (sessionId) args.push("--session", sessionId);
    if (opts.mode === "background") args.push("--format", "json", "--print-logs");
    args.push(primer);

    if (opts.mode === "background") {
      const result = this.runBackgroundCommand(args, { cwd: this.cwd, env: { ...this.env, ...opts.env }, logFile: opts.logFile });
      return { sessionId: result.sessionId ?? sessionId ?? opts.deployId, exitCode: 0, logFile: opts.logFile, metadata: { pid: result.pid } };
    }

    const result = this.runCommand(args, { cwd: this.cwd, env: { ...this.env, ...opts.env } });
    if (opts.logFile) writeLog(opts.logFile, result.stdout, result.stderr);
    const outputPath = resolve(dirname(opts.primerPath), "opencode-output.jsonl");
    writeLog(outputPath, result.stdout, result.stderr);
    return { sessionId: parseSessionId(result.stdout) ?? parseSessionId(result.stderr) ?? sessionId ?? opts.deployId, exitCode: result.status ?? 1, logFile: opts.logFile };
  }
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
  const type = String(raw["type"] ?? raw["kind"] ?? raw["role"] ?? "text").toLowerCase();
  if (type.includes("tool") && type.includes("result")) return "tool_result";
  if (type.includes("tool")) return "tool_use";
  if (type.includes("think") || type.includes("reason")) return "thinking";
  if (type.includes("error")) return "error";
  return "text";
}

function extractBody(raw: Record<string, unknown>): string {
  const body = raw["text"] ?? raw["content"] ?? raw["message"] ?? raw["body"] ?? raw["type"] ?? "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

function basenameDeployId(deployDir: string): string {
  return deployDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown";
}
