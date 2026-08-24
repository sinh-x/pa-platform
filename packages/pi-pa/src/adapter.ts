import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendActivityEvent, createActivityEvent, getDeployPaths, nowUtc, parseTimestamp, type ActivityEvent, type HookConfig, type ResumeOpts, type RuntimeAdapter, type SpawnOpts, type SpawnResult, type ToolReference } from "@pa-platform/pa-core";

const MAX_BODY = 500;
const MAX_STDERR = 2000;
const SECRET = [/(?:token|secret|password|api[_-]?key)\s*[:=]?\s*\S+/gi, /bearer\s+\S+/gi, /sk-[\w-]+/gi];
export interface PiCommandResult { status: number | null; stdout: string; stderr: string; spawnError?: Error; metadata?: Record<string, unknown> }
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
    const version = this.versionProbe();
    if (!meetsMinimum(version)) return failure(`Pi version must be 0.80.8 or later; detected '${version || "unknown"}'.`);
    const id = resumeId ?? this.allocateSessionId();
    const args = ["--print", "--mode", "json", "--session-id", opts.sessionId ?? id];
    if (opts.model) args.push("--model", opts.model);
    if (opts.env?.["PA_PROVIDER"]) args.push("--provider", opts.env["PA_PROVIDER"]);
    args.push(readFileSync(opts.primerPath, "utf8"));
    const env = { ...this.env, ...opts.env };
    const result = this.runCommand
      ? this.runCommand(args, { cwd: this.cwd, env })
      : await runPi(args, this.cwd, env, opts, id);
    if (this.runCommand) {
      persistOutput(opts, result.stdout, result.stderr);
    }
    if (result.status !== 0) {
      const message = redact(tail(result.stderr || result.spawnError?.message || `pi exited with code ${result.status ?? 1}`, MAX_STDERR));
      appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "pi", body: message }), getDeployPaths(opts.deployId).activityLogPath);
      return { sessionId: id, exitCode: result.status ?? 1, logFile: opts.logFile, errorMessage: message };
    }
    return { sessionId: id, exitCode: 0, logFile: opts.logFile, metadata: { ...(result.metadata ?? {}) } };
  }
}

export function meetsMinimum(version: string): boolean { const match = version.match(/(\d+)\.(\d+)\.(\d+)/); if (!match) return false; const actual = [Number(match[1]), Number(match[2]), Number(match[3])]; const minimum = [0, 80, 8]; return actual[0] > minimum[0] || actual[0] === minimum[0] && (actual[1] > minimum[1] || actual[1] === minimum[1] && actual[2] >= minimum[2]); }
export function normalizePiEvent(raw: Record<string, unknown>, deployId: string): ActivityEvent { const safe = deepRedact(raw) as Record<string, unknown>; const type = String(safe.type ?? safe.event ?? safe.kind ?? "text").toLowerCase(); const kind: ActivityEvent["kind"] = type.includes("error") ? "error" : type.includes("tool") && type.includes("result") ? "tool_result" : type.includes("tool") ? "tool_use" : type.includes("think") ? "thinking" : "text"; const body = redact(extractText(safe) || type); return createActivityEvent({ deployId, kind, source: "pi", body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 3)}...` : body, partType: type, metadata: allowMetadata(safe), timestamp: typeof safe.timestamp === "string" ? parseTimestamp(safe.timestamp).toISOString() : undefined }); }
function parsePiLine(line: string, deployId: string): ActivityEvent { try { return normalizePiEvent(JSON.parse(line) as Record<string, unknown>, deployId); } catch { return createActivityEvent({ deployId, kind: "text", source: "pi", body: redact(line).slice(0, MAX_BODY) }); } }
function runPi(args: string[], cwd: string, env: NodeJS.ProcessEnv, opts: SpawnOpts, id: string): Promise<PiCommandResult & { metadata?: Record<string, unknown> }> {
  return new Promise((resolveResult) => {
    const child = spawn("pi", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false; let timer: NodeJS.Timeout | undefined;
    const outputPath = resolve(dirname(opts.primerPath), "pi-output.jsonl");
    const finish = (status: number | null, error?: Error): void => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (opts.logFile) writeFileSync(opts.logFile, redact(stdout + stderr), "utf8"); resolveResult({ status, stdout, stderr, ...(error ? { spawnError: error } : {}), metadata: { pid: child.pid, sessionId: id } }); };
    const consume = (chunk: Buffer, stream: "stdout" | "stderr"): void => { const text = chunk.toString("utf8"); if (stream === "stdout") { stdout += text; for (const line of text.split("\n").filter(Boolean)) { const safe = redact(line); appendFileSync(outputPath, `${safe}\n`); try { appendActivityEvent(parsePiLine(safe, opts.deployId), getDeployPaths(opts.deployId).activityLogPath); } catch { /* malformed lines are retained as text */ } } } else stderr += text; };
    child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout")); child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
    child.once("error", (error) => finish(null, error)); child.once("close", (code) => finish(code));
    if (opts.timeoutMs) timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ } setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }, 100); finish(124, new Error("Pi deployment timed out")); }, opts.timeoutMs);
  });
}
function persistOutput(opts: SpawnOpts, stdout: string, stderr: string): void { const outputPath = resolve(dirname(opts.primerPath), "pi-output.jsonl"); mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, stdout.split("\n").filter(Boolean).map(redact).join("\n") + (stdout ? "\n" : ""), "utf8"); if (opts.logFile) writeFileSync(opts.logFile, redact(stdout + stderr), "utf8"); }
function failure(message: string): SpawnResult { return { exitCode: 1, errorMessage: message }; }
function redact(value: string): string { return SECRET.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value); }
function deepRedact(value: unknown): unknown { if (typeof value === "string") return redact(value); if (Array.isArray(value)) return value.map(deepRedact); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => /token|secret|password|api[_-]?key|authorization/i.test(key) ? [key, "[REDACTED]"] : [key, deepRedact(item)])); return value; }
function allowMetadata(raw: Record<string, unknown>): Record<string, unknown> { const metadata: Record<string, unknown> = {}; for (const key of ["type", "event", "kind", "timestamp", "role", "tool", "partType"]) if (raw[key] !== undefined) metadata[key] = raw[key]; return metadata; }
function extractText(raw: Record<string, unknown>): string { const values = [raw.text, raw.body, raw.content, raw.message, raw.result]; for (const value of values) { if (typeof value === "string") return value; if (value && typeof value === "object") { const nested = extractText(value as Record<string, unknown>); if (nested) return nested; } } return ""; }
function tail(value: string, max: number): string { return value.length > max ? value.slice(-max) : value; }
function basename(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown"; }
