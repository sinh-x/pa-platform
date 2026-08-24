import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendActivityEvent, createActivityEvent, getDeployPaths, nowUtc, parseTimestamp, type ActivityEvent, type HookConfig, type ResumeOpts, type RuntimeAdapter, type SpawnOpts, type SpawnResult, type ToolReference } from "@pa-platform/pa-core";

const MAX_BODY = 500;
const MAX_STDERR = 2000;
const SECRET = [/(?:token|secret|password|api[_-]?key)\s*[:=]?\s*\S+/gi, /bearer\s+\S+/gi, /sk-[\w-]+/gi];
export interface PiCommandResult { status: number | null; stdout: string; stderr: string; spawnError?: Error }
export interface PiAdapterOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => PiCommandResult;
  versionProbe?: () => string;
  sessionIdFactory?: () => string;
}

export class PiAdapter implements RuntimeAdapter {
  readonly name = "pi" as const;
  readonly defaultModel = "";
  readonly sessionFileName = "session-id-pi.txt";
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand?: PiAdapterOptions["runCommand"];
  private readonly versionProbe: () => string;
  private readonly sessionIdFactory: () => string;
  private checked = false;

  constructor(options: PiAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd(); this.env = options.env ?? process.env;
    this.runCommand = options.runCommand; this.versionProbe = options.versionProbe ?? (() => {
      const result = spawnSync("pi", ["--version"], { cwd: this.cwd, env: this.env, encoding: "utf8" });
      if (result.error) throw new Error(`Pi is unavailable: ${result.error.message}. Install Pi 0.80.8 or later and ensure \'pi\' is on PATH.`);
      return `${result.stdout ?? ""}`.trim();
    });
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  }

  spawn(opts: SpawnOpts): Promise<SpawnResult> { return this.run(opts); }
  resume(opts: ResumeOpts): Promise<SpawnResult> { return this.run(opts, opts.sessionId); }
  extractActivity(deployDir: string): ActivityEvent[] {
    const path = resolve(deployDir, "pi-output.jsonl"); if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => parsePiLine(line, basename(deployDir)));
  }
  installHooks(_targetDir: string, _config: HookConfig): void {}
  describeTools(): ToolReference { return { runtime: "pi", markdown: "Runtime: Pi via `ppa`. Use `ppa` for PA deployments; Pi 0.80.8 or later must be installed as `pi`." }; }

  allocateSessionId(): string { return this.sessionIdFactory(); }
  private async run(opts: SpawnOpts, resumeId?: string): Promise<SpawnResult> {
    if (!this.checked) { this.checked = true; const version = this.versionProbe(); if (!meetsMinimum(version)) return failure(`Pi version must be 0.80.8 or later; detected '${version || "unknown"}'.`); }
    const id = resumeId ?? this.allocateSessionId();
    const args = ["--print", "--json", "--session-id", id];
    if (opts.model) args.push("--model", opts.model);
    if (opts.env?.["PA_PROVIDER"]) args.push("--provider", opts.env["PA_PROVIDER"]);
    args.push(readFileSync(opts.primerPath, "utf8"));
    const env = { ...this.env, ...opts.env };
    if (opts.mode === "background") {
      const log = opts.logFile ?? resolve(this.cwd, "pi.log"); mkdirSync(dirname(log), { recursive: true });
      const child = spawn("pi", args, { cwd: this.cwd, env, detached: true, stdio: ["ignore", "ignore", "ignore"] }); child.unref();
      return { sessionId: id, exitCode: 0, logFile: log, metadata: { pid: child.pid } };
    }
    const result = this.runCommand ? this.runCommand(args, { cwd: this.cwd, env }) : runPi(args, this.cwd, env, opts.logFile, resolve(dirname(opts.primerPath), "pi-output.jsonl"));
    const output = result.stdout || result.stderr; if (opts.logFile) writeFileSync(opts.logFile, redact(output), "utf8");
    appendFileSync(resolve(dirname(opts.primerPath), "pi-output.jsonl"), output.split("\n").filter(Boolean).map((line) => redact(line)).join("\n") + (output ? "\n" : ""));
    if (result.status !== 0) { const message = redact(tail(result.stderr || `pi exited with code ${result.status ?? 1}`, MAX_STDERR)); appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "pi", body: message }), getDeployPaths(opts.deployId).activityLogPath); return { sessionId: id, exitCode: result.status ?? 1, logFile: opts.logFile, errorMessage: message }; }
    return { sessionId: id, exitCode: 0, logFile: opts.logFile };
  }
}

export function meetsMinimum(version: string): boolean { const match = version.match(/(\d+)\.(\d+)\.(\d+)/); if (!match) return false; const actual = [Number(match[1]), Number(match[2]), Number(match[3])]; const minimum = [0, 80, 8]; return actual[0] > minimum[0] || actual[0] === minimum[0] && (actual[1] > minimum[1] || actual[1] === minimum[1] && actual[2] >= minimum[2]); }
export function normalizePiEvent(raw: Record<string, unknown>, deployId: string): ActivityEvent { const type = String(raw.type ?? raw.event ?? raw.kind ?? "text").toLowerCase(); const kind: ActivityEvent["kind"] = type.includes("error") ? "error" : type.includes("tool") && type.includes("result") ? "tool_result" : type.includes("tool") ? "tool_use" : type.includes("think") ? "thinking" : "text"; const body = redact(String(raw.text ?? raw.message ?? raw.content ?? raw.body ?? raw.result ?? type)); return createActivityEvent({ deployId, kind, source: "pi", body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 3)}...` : body, partType: type, metadata: raw, timestamp: typeof raw.timestamp === "string" ? parseTimestamp(raw.timestamp).toISOString() : undefined }); }
function parsePiLine(line: string, deployId: string): ActivityEvent { try { return normalizePiEvent(JSON.parse(line) as Record<string, unknown>, deployId); } catch { return createActivityEvent({ deployId, kind: "text", source: "pi", body: redact(line).slice(0, MAX_BODY) }); } }
function runPi(args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string | undefined, outputPath: string): PiCommandResult { const result = spawnSync("pi", args, { cwd, env, encoding: "utf8" }); const stdout = `${result.stdout ?? ""}`; const stderr = `${result.stderr ?? ""}`; if (logFile) writeFileSync(logFile, redact(stdout + stderr), "utf8"); mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, redact(stdout + stderr), "utf8"); return { status: result.status, stdout, stderr, ...(result.error ? { spawnError: result.error } : {}) }; }
function failure(message: string): SpawnResult { return { exitCode: 1, errorMessage: message }; }
function redact(value: string): string { return SECRET.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value); }
function tail(value: string, max: number): string { return value.length > max ? value.slice(-max) : value; }
function basename(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown"; }
