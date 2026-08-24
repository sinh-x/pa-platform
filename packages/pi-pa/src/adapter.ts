import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendActivityEvent, createActivityEvent, getDeployPaths, nowUtc, parseTimestamp, type ActivityEvent, type HookConfig, type ResumeOpts, type RuntimeAdapter, type SpawnOpts, type SpawnResult, type ToolReference } from "@pa-platform/pa-core";

const MAX_BODY = 500;
const MAX_STDERR = 2000;
const MAX_CAPTURE = 8000;
const VERSION_TIMEOUT = 2000;
const TERM_GRACE = 250;
const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;
const SECRET_TEXT = [/(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, /bearer\s+\S+/gi, /sk-[\w-]+/gi];
export interface PiCommandResult { status: number | null; stdout: string; stderr: string; spawnError?: Error; metadata?: Record<string, unknown> }
export interface PiAdapterOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => PiCommandResult | Promise<PiCommandResult>;
  versionProbe?: () => string | Promise<string>;
  sessionIdFactory?: () => string;
  secretValues?: string[];
}

export class PiAdapter implements RuntimeAdapter {
  readonly name = "pi" as const;
  readonly defaultModel = "";
  readonly sessionFileName = "session-id-pi.txt";
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand?: PiAdapterOptions["runCommand"];
  private readonly versionProbe: () => string | Promise<string>;
  private readonly sessionIdFactory: () => string;
  private readonly secretValues: string[];

  constructor(options: PiAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd(); this.env = options.env ?? process.env;
    this.runCommand = options.runCommand; this.versionProbe = options.versionProbe ?? (() => {
      const result = spawnSync("pi", ["--version"], { cwd: this.cwd, env: this.env, encoding: "utf8", timeout: VERSION_TIMEOUT });
      if (result.error) throw new Error(`Pi is unavailable: ${result.error.message}. Install Pi 0.80.8 or later and ensure 'pi' is on PATH.`);
      if (result.status !== 0) throw new Error(`Pi version probe failed with exit code ${result.status ?? 1}.`);
      return `${result.stdout ?? ""}`.trim();
    });
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    this.secretValues = [...new Set([...(options.secretValues ?? []), ...Object.entries(this.env).filter(([key, value]) => SECRET_KEY.test(key) && value !== undefined && value.length >= 8).map(([, value]) => value!)])];
  }

  spawn(opts: SpawnOpts): Promise<SpawnResult> { return this.run(opts); }
  resume(opts: ResumeOpts): Promise<SpawnResult> { return this.run(opts, opts.sessionId); }
  extractActivity(deployDir: string): ActivityEvent[] {
    const path = resolve(deployDir, "pi-output.jsonl"); if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => parsePiLine(line, basename(deployDir), this.secretValues));
  }
  installHooks(_targetDir: string, _config: HookConfig): void {}
  describeTools(): ToolReference { return { runtime: "pi", markdown: "Runtime: Pi via `ppa`. Use `ppa` for PA deployments; Pi 0.80.8 or later must be installed as `pi`." }; }

  allocateSessionId(): string { return this.sessionIdFactory(); }
  private async run(opts: SpawnOpts, resumeId?: string): Promise<SpawnResult> {
    let version: string;
    try { version = await bounded(this.versionProbe(), VERSION_TIMEOUT); } catch (error) { return failure(`Pi version preflight failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!meetsMinimum(version)) return failure(`Pi version must be 0.80.8 or later; detected '${version || "unknown"}'.`);
    const id = resumeId ?? this.allocateSessionId();
    const args = ["--print", "--mode", "json", "--session-id", id];
    if (opts.model) args.push("--model", opts.model);
    if (opts.env?.["PA_PROVIDER"]) args.push("--provider", opts.env["PA_PROVIDER"]);
    args.push(readFileSync(opts.primerPath, "utf8"));
    const env = { ...this.env, ...opts.env };
    const result = this.runCommand
      ? await this.runCommand(args, { cwd: this.cwd, env })
      : await runPi(args, this.cwd, env, opts, id, this.secretValues);
    if (this.runCommand) {
      persistOutput(opts, result.stdout, result.stderr, this.secretValues);
    }
    if (result.status !== 0) {
      const message = redact(tail(result.stderr || result.spawnError?.message || `pi exited with code ${result.status ?? 1}`, MAX_STDERR), this.secretValues);
      appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "pi", body: message }), getDeployPaths(opts.deployId).activityLogPath);
      return { sessionId: id, exitCode: result.status ?? 1, logFile: opts.logFile, errorMessage: message };
    }
    return { sessionId: id, exitCode: 0, logFile: opts.logFile, metadata: { ...(result.metadata ?? {}) } };
  }
}

export function meetsMinimum(version: string): boolean { const match = version.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?=\s|$)/); if (!match) return false; const actual = [Number(match[1]), Number(match[2]), Number(match[3])]; return actual[0] > 0 || actual[0] === 0 && (actual[1] > 80 || actual[1] === 80 && actual[2] >= 8); }
export function normalizePiEvent(raw: Record<string, unknown>, deployId: string, secrets: string[] = []): ActivityEvent { const safe = deepRedact(raw, secrets) as Record<string, unknown>; const type = String(safe.type ?? safe.event ?? safe.kind ?? "text").toLowerCase(); const kind: ActivityEvent["kind"] = type.includes("error") ? "error" : type.includes("tool") && type.includes("result") ? "tool_result" : type.includes("tool") ? "tool_use" : type.includes("think") ? "thinking" : "text"; const body = redact(extractText(safe) || type, secrets); return createActivityEvent({ deployId, kind, source: "pi", body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 3)}...` : body, partType: type, metadata: allowMetadata(safe), timestamp: typeof safe.timestamp === "string" ? parseTimestamp(safe.timestamp).toISOString() : undefined }); }
function parsePiLine(line: string, deployId: string, secrets: string[] = []): ActivityEvent { try { const value = JSON.parse(line) as unknown; return Array.isArray(value) ? normalizePiEvent({ type: "message", content: value }, deployId, secrets) : normalizePiEvent(value as Record<string, unknown>, deployId, secrets); } catch { return createActivityEvent({ deployId, kind: "text", source: "pi", body: redact(line, secrets).slice(0, MAX_BODY) }); } }
function runPi(args: string[], cwd: string, env: NodeJS.ProcessEnv, opts: SpawnOpts, id: string, secrets: string[]): Promise<PiCommandResult & { metadata?: Record<string, unknown>; monitor?: Promise<PiCommandResult> }> {
  const child = spawn("pi", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let completion!: Promise<PiCommandResult>;
  completion = new Promise((resolveResult) => {
    let stdout = ""; let stderr = ""; let carry = ""; let settled = false; let timedOut = false; let timer: NodeJS.Timeout | undefined; let killTimer: NodeJS.Timeout | undefined;
    const outputPath = resolve(dirname(opts.primerPath), "pi-output.jsonl");
    const finish = (status: number | null, error?: Error): void => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (carry) persistLine(carry, outputPath, opts.deployId, secrets); if (opts.logFile) writeFileSync(opts.logFile, redact(stdout + stderr, secrets), "utf8"); resolveResult({ status, stdout, stderr, ...(error ? { spawnError: error } : {}), metadata: { pid: child.pid, sessionId: id } }); };
    const consume = (chunk: Buffer, stream: "stdout" | "stderr"): void => { const text = chunk.toString("utf8"); if (stream === "stdout") { stdout = tail(stdout + text, MAX_CAPTURE); carry += text; const lines = carry.split("\n"); carry = lines.pop() ?? ""; for (const line of lines) persistLine(line, outputPath, opts.deployId, secrets); } else stderr = tail(stderr + redact(text, secrets), MAX_STDERR); };
    child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout")); child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
    child.once("error", (error) => finish(null, error)); child.once("close", (code) => finish(timedOut ? 124 : code, timedOut ? new Error("Pi deployment timed out") : undefined));
    if (opts.timeoutMs) timer = setTimeout(() => { timedOut = true; try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ } killTimer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }, TERM_GRACE); }, opts.timeoutMs);
  });
  if (opts.mode === "background") return Promise.resolve({ status: 0, stdout: "", stderr: "", metadata: { pid: child.pid, sessionId: id, pending: true }, monitor: completion });
  return completion;
}
function persistLine(line: string, path: string, deployId: string, secrets: string[]): void { if (!line.trim()) return; const safe = redactJsonLine(line, secrets); appendFileSync(path, `${safe}\n`); appendActivityEvent(parsePiLine(safe, deployId, secrets), getDeployPaths(deployId).activityLogPath); }
function persistOutput(opts: SpawnOpts, stdout: string, stderr: string, secrets: string[]): void { const outputPath = resolve(dirname(opts.primerPath), "pi-output.jsonl"); mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, stdout.split("\n").filter(Boolean).map((line) => redactJsonLine(line, secrets)).join("\n") + (stdout ? "\n" : ""), "utf8"); if (opts.logFile) writeFileSync(opts.logFile, redact(stdout + stderr, secrets), "utf8"); }
function failure(message: string): SpawnResult { return { exitCode: 1, errorMessage: message }; }
function redactJsonLine(line: string, secrets: string[]): string { try { return JSON.stringify(deepRedact(JSON.parse(line), secrets)); } catch { return redact(line, secrets); } }
function redact(value: string, secrets: string[] = []): string { let result = value; for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]"); for (const pattern of SECRET_TEXT) result = result.replace(pattern, "[REDACTED]"); return result; }
function deepRedact(value: unknown, secrets: string[] = []): unknown { if (typeof value === "string") return redact(value, secrets); if (Array.isArray(value)) return value.map((item) => deepRedact(item, secrets)); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => SECRET_KEY.test(key) ? [key, "[REDACTED]"] : [key, deepRedact(item, secrets)])); return value; }
function allowMetadata(raw: Record<string, unknown>): Record<string, unknown> { const metadata: Record<string, unknown> = {}; for (const key of ["type", "event", "kind", "timestamp", "role", "tool", "partType"]) if (raw[key] !== undefined) metadata[key] = raw[key]; return metadata; }
function extractText(raw: Record<string, unknown>): string { const values = [raw.text, raw.body, raw.content, raw.message, raw.result]; for (const value of values) { if (typeof value === "string") return value; if (Array.isArray(value)) { const text = value.map((item) => typeof item === "string" ? item : item && typeof item === "object" ? extractText(item as Record<string, unknown>) : "").filter(Boolean).join(" "); if (text) return text; } if (value && typeof value === "object") { const nested = extractText(value as Record<string, unknown>); if (nested) return nested; } } return ""; }
function tail(value: string, max: number): string { return value.length > max ? value.slice(-max) : value; }
function basename(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown"; }
async function bounded<T>(value: T | Promise<T>, timeout: number): Promise<T> { return Promise.race([Promise.resolve(value), new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeout}ms`)), timeout))]); }
