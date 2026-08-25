import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";
import { appendActivityEvent, createActivityEvent, getDeployPaths, parseTimestamp, type ActivityEvent, type HookConfig, type ResumeOpts, type RuntimeAdapter, type SpawnOpts, type SpawnResult, type ToolReference } from "@pa-platform/pa-core";
import { environmentSecrets, redactDiagnostic, SECRET_KEY, StreamingRedactor } from "./diagnostics.js";
import { clearPiTerminalStatus, readPiTerminalStatus } from "./terminal-status.js";
import { normalizePiRuntimeConfig } from "./runtime-normalization.js";

const MAX_BODY = 500;
const MAX_STDERR = 2000;
const MAX_CAPTURE = 8000;
export const PI_VERSION_TIMEOUT_MS = 15_000;
const TERM_GRACE = 250;
const MAX_CARRY = 8192;
const PROCESS_TREE_TIMEOUT = 4900;
const PROCESS_TREE_POLL = 25;
export interface PiCommandResult { status: number | null; stdout: string; stderr: string; spawnError?: Error; metadata?: Record<string, unknown> }
export interface PiSupervisionHandle { completion: Promise<PiCommandResult>; pid?: number }
export interface PiAdapterOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => PiCommandResult | Promise<PiCommandResult>;
  versionProbe?: () => string | Promise<string>;
  versionTimeoutMs?: number;
  sessionIdFactory?: () => string;
  secretValues?: string[];
  supervision?: PiSupervisionOptions;
}

export interface PiSupervisionOptions {
  spawnProcess?: typeof spawn;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  processGroupGone?: (pid: number) => boolean;
  persistLine?: typeof persistLine;
  writeLog?: typeof writeFileSync;
  appendLog?: typeof appendFileSync;
  setTimeout?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeout?: (timeout: NodeJS.Timeout) => void;
  spawnPty?: (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string | undefined> }) => IPty;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  columns?: number;
  rows?: number;
}

export class PiAdapter implements RuntimeAdapter {
  readonly name = "pi" as const;
  readonly defaultModel = "";
  readonly sessionFileName = "session-id-pi.txt";
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand?: PiAdapterOptions["runCommand"];
  private readonly versionProbe: () => string | Promise<string>;
  private readonly versionTimeoutMs: number;
  private preflightPromise?: Promise<void>;
  private readonly sessionIdFactory: () => string;
  private readonly secretValues: string[];
  private readonly supervision: PiSupervisionOptions;

  constructor(options: PiAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd(); this.env = options.env ?? process.env;
    this.runCommand = options.runCommand;
    this.versionTimeoutMs = options.versionTimeoutMs ?? PI_VERSION_TIMEOUT_MS;
    this.versionProbe = options.versionProbe ?? (() => probePiVersion(this.cwd, this.env, this.versionTimeoutMs));
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    this.secretValues = [...(options.secretValues ?? [])];
    this.supervision = options.supervision ?? {};
  }

  spawn(opts: SpawnOpts): Promise<SpawnResult> { return this.run(opts); }
  resume(opts: ResumeOpts): Promise<SpawnResult> { return this.run(opts, opts.sessionId); }
  extractActivity(deployDir: string): ActivityEvent[] {
    const path = resolve(deployDir, "pi-output.jsonl"); if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => parsePiLine(line, basename(deployDir), this.secretValues));
  }
  installHooks(_targetDir: string, _config: HookConfig): void {}
  describeTools(): ToolReference { return { runtime: "pi", markdown: "Runtime: Pi via `ppa`. Use `ppa` for PA deployments; Pi 0.80.8 or later must be installed as `pi`." }; }

  async preflight(): Promise<void> {
    if (!this.preflightPromise) {
      const probe = (async () => {
        const version = await bounded(this.versionProbe(), this.versionTimeoutMs, `Pi version probe timed out after ${this.versionTimeoutMs}ms.`);
        if (!meetsMinimum(version)) throw new Error(`Pi version must be 0.80.8 or later; detected '${version || "unknown"}'.`);
      })();
      this.preflightPromise = probe;
      void probe.catch(() => { if (this.preflightPromise === probe) this.preflightPromise = undefined; });
    }
    return this.preflightPromise;
  }

  allocateSessionId(): string { return this.sessionIdFactory(); }
  private async run(opts: SpawnOpts, resumeId?: string): Promise<SpawnResult> {
    try { await this.preflight(); } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
    finally { this.preflightPromise = undefined; }
    const id = resumeId ?? opts.sessionId ?? this.allocateSessionId();
    const interactive = opts.mode === "foreground";
    const normalized = normalizePiRuntimeConfig(opts.env?.["PA_PROVIDER"], opts.model);
    const args = interactive ? ["--session-id", id] : ["--print", "--mode", "json", "--session-id", id];
    if (normalized.model) args.push("--model", normalized.model);
    if (normalized.provider) args.push("--provider", normalized.provider);
    const plan = opts.executionPlan;
    const cwd = plan?.repositoryCwd ?? this.cwd;
    if (plan) {
      args.push("--no-skills", "--no-extensions");
      for (const skill of plan.skills) args.push("--skill", skill.path);
      if (plan.trustedExtension) args.push("--extension", plan.trustedExtension);
    }
    args.push(readFileSync(opts.primerPath, "utf8"));
    const env = { ...this.env, ...opts.env };
    const secrets = environmentSecrets(env, this.secretValues);
    const result = this.runCommand
      ? await this.runCommand(args, { cwd, env })
      : await runPi(args, cwd, env, opts, id, secrets, this.supervision, interactive);
    if (this.runCommand && !interactive) {
      result.metadata = { ...(result.metadata ?? {}), ...persistOutput(opts, result.stdout, result.stderr, secrets) };
    }
    const terminalError = typeof result.metadata?.["terminalError"] === "string" ? result.metadata["terminalError"] : undefined;
    if (terminalError) return { sessionId: id, exitCode: 1, logFile: opts.logFile, errorMessage: terminalError, metadata: { ...(result.metadata ?? {}), sessionId: id } };
    if (result.status !== 0) {
      const message = redact(tail(result.stderr || result.spawnError?.message || `pi exited with code ${result.status ?? 1}`, MAX_STDERR), secrets);
      return { sessionId: id, exitCode: result.status ?? 1, logFile: opts.logFile, errorMessage: message, metadata: { ...(result.metadata ?? {}), sessionId: id } };
    }
    return { sessionId: id, exitCode: 0, logFile: opts.logFile, metadata: { ...(result.metadata ?? {}), sessionId: id } };
  }
}

export function meetsMinimum(version: string): boolean { const match = version.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?=\s|$)/); if (!match) return false; const actual = [Number(match[1]), Number(match[2]), Number(match[3])]; return actual[0] > 0 || actual[0] === 0 && (actual[1] > 80 || actual[1] === 80 && actual[2] >= 8); }
export function normalizePiEvent(raw: Record<string, unknown>, deployId: string, secrets: string[] = []): ActivityEvent { const safe = deepRedact(raw, secrets) as Record<string, unknown>; const type = String(safe.type ?? safe.event ?? safe.kind ?? "text").toLowerCase(); const kind: ActivityEvent["kind"] = type === "tool_execution_end" || type === "tool_result" || type === "tool_execution_result" ? "tool_result" : type === "tool_execution_start" || type === "tool_use" || type === "tool_call" ? "tool_use" : type.includes("error") ? "error" : type.includes("think") ? "thinking" : type.includes("tool") ? "tool_use" : "text"; const body = redact(extractText(safe) || type, secrets); return createActivityEvent({ deployId, kind, source: "pi", body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 3)}...` : body, partType: type, metadata: allowMetadata(safe), timestamp: typeof safe.timestamp === "string" ? parseTimestamp(safe.timestamp).toISOString() : undefined }); }
function parsePiLine(line: string, deployId: string, secrets: string[] = []): ActivityEvent { try { const value = JSON.parse(line) as unknown; return Array.isArray(value) ? normalizePiEvent({ type: "message", content: value }, deployId, secrets) : normalizePiEvent(value as Record<string, unknown>, deployId, secrets); } catch { return createActivityEvent({ deployId, kind: "text", source: "pi", body: redact(line, secrets).slice(0, MAX_BODY) }); } }
function runPi(args: string[], cwd: string, env: NodeJS.ProcessEnv, opts: SpawnOpts, id: string, secrets: string[], supervision: PiSupervisionOptions = {}, interactive = false): Promise<PiCommandResult> {
  if (interactive) return runPiForeground(args, cwd, env, opts, id, secrets, supervision);
  const spawnProcess = supervision.spawnProcess ?? spawn;
  const now = supervision.now ?? Date.now;
  const sleep = supervision.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const sendSignal = supervision.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(-pid, signal));
  const groupGone = supervision.processGroupGone ?? ((pid: number) => processGroupGone(pid));
  const persist = supervision.persistLine ?? persistLine;
  const writeLog = supervision.writeLog ?? writeFileSync;
  const setTimer = supervision.setTimeout ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
  const clearTimer = supervision.clearTimeout ?? ((timeout: NodeJS.Timeout) => clearTimeout(timeout));
  const child = spawnProcess("pi", args, { cwd, env, detached: true, stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"] });
  let completion!: Promise<PiCommandResult>;
  completion = new Promise((resolveResult) => {
    let stdout = ""; let stderr = ""; let carry = ""; let terminalError = ""; let settled = false; let directClosed = false; let cleanupPending = false; let cleanupVerified = false; let timer: NodeJS.Timeout | undefined; let cleanupDeadline = 0; let cleanupStatus = 1; let cleanupError: Error | undefined;
    const outputPath = resolve(dirname(opts.primerPath), "pi-output.jsonl");
    const settle = (status: number | null, error?: Error): void => {
      if (settled) return;
      if (timer) clearTimer(timer);
      settled = true;
      resolveResult({ status, stdout, stderr, ...(error ? { spawnError: error } : {}), metadata: { pid: child.pid, sessionId: id, ...(terminalError ? { terminalError } : {}), ...(cleanupPending ? { cleanupVerified } : {}) } });
    };
    const requestCleanup = (status: number, error: Error): void => {
      if (settled || cleanupPending) return;
      cleanupPending = true; cleanupStatus = status; cleanupError = error; cleanupDeadline = now() + PROCESS_TREE_TIMEOUT;
      if (timer) clearTimer(timer);
      try { if (child.pid) sendSignal(child.pid, "SIGTERM"); } catch { /* already exited */ }
      void (async () => {
        let killSent = false;
        while (now() < cleanupDeadline) {
          const groupGoneNow = !child.pid || groupGone(child.pid);
          if (directClosed && groupGoneNow) { cleanupVerified = true; break; }
          if (!killSent && now() >= cleanupDeadline - PROCESS_TREE_TIMEOUT + TERM_GRACE) {
            killSent = true;
            try { if (child.pid) sendSignal(child.pid, "SIGKILL"); } catch { /* already exited */ }
          }
          await sleep(Math.min(PROCESS_TREE_POLL, Math.max(1, cleanupDeadline - now())));
        }
        if (!cleanupVerified) cleanupVerified = directClosed && (!child.pid || groupGone(child.pid));
        if (!cleanupVerified) cleanupError = new Error(`${cleanupError?.message ?? "Pi cleanup failed"}; process tree cleanup deadline exceeded`);
        settle(cleanupStatus, cleanupError);
      })();
    };
    const finish = (): void => {
      if (settled || cleanupPending) return;
      try {
        if (!interactive) {
          if (carry) persist(carry, outputPath, opts.deployId, secrets);
          if (opts.logFile) writeLog(opts.logFile, redact(stdout + stderr, secrets), "utf8");
        }
        settle(0);
      } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); }
    };
    const consume = (chunk: Buffer, stream: "stdout" | "stderr"): void => { const text = chunk.toString("utf8"); if (stream === "stdout") { stdout = tail(stdout + text, MAX_CAPTURE); carry = tail(carry + text, MAX_CARRY); const lines = carry.split("\n"); carry = tail(lines.pop() ?? "", MAX_CARRY); for (const line of lines) { terminalError ||= terminalErrorFromLine(line, secrets); try { persist(line, outputPath, opts.deployId, secrets); } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); return; } } } else stderr = tail(redact(stderr + text, secrets), MAX_STDERR); };
    child.stdout?.on("data", (chunk: Buffer) => { if (!cleanupPending) consume(chunk, "stdout"); }); child.stderr?.on("data", (chunk: Buffer) => { if (!cleanupPending) consume(chunk, "stderr"); });
    child.once("error", (error) => { if (!cleanupPending) settle(null, error); }); child.once("close", (code) => { directClosed = true; if (!cleanupPending) { if (code === 0) finish(); else settle(code, new Error(`Pi exited with code ${code ?? 1}`)); } });
    if (opts.timeoutMs) timer = setTimer(() => requestCleanup(124, new Error("Pi deployment timed out")), opts.timeoutMs);
  });
  if (opts.mode === "background") return Promise.resolve({ status: 0, stdout: "", stderr: "", metadata: { pid: child.pid, sessionId: id, pending: true, monitor: { completion, pid: child.pid } satisfies PiSupervisionHandle } });
  return completion;
}
function runPiForeground(args: string[], cwd: string, env: NodeJS.ProcessEnv, opts: SpawnOpts, id: string, secrets: string[], supervision: PiSupervisionOptions): Promise<PiCommandResult> {
  const deployDir = dirname(opts.primerPath);
  clearPiTerminalStatus(deployDir);
  const pty = (supervision.spawnPty ?? spawnPty)("pi", args, { name: "xterm-256color", cols: supervision.columns ?? process.stdout.columns ?? 80, rows: supervision.rows ?? process.stdout.rows ?? 24, cwd, env });
  const input = supervision.input ?? process.stdin;
  const output = supervision.output ?? process.stdout;
  const outputPath = resolve(deployDir, "pi-output.jsonl");
  const persist = supervision.persistLine ?? persistLine;
  const appendLog = supervision.appendLog ?? appendFileSync;
  const now = supervision.now ?? Date.now;
  const sleep = supervision.sleep ?? ((milliseconds: number) => new Promise<void>((resolveValue) => setTimeout(resolveValue, milliseconds)));
  const setTimer = supervision.setTimeout ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
  const clearTimer = supervision.clearTimeout ?? ((timeout: NodeJS.Timeout) => clearTimeout(timeout));
  let stdout = ""; let carry = ""; let terminalError = ""; let settled = false; let exited = false; let cleanupPending = false; let cleanupVerified = false; let timer: NodeJS.Timeout | undefined; let cleanupStatus = 1; let cleanupError: Error | undefined;
  const previousRaw = input.isTTY ? input.isRaw : undefined;
  const logRedactor = opts.logFile ? new StreamingRedactor(secrets, (safe) => appendLog(opts.logFile!, safe, "utf8")) : undefined;

  return new Promise((resolveResult) => {
    const restoreTerminal = (): Error | undefined => {
      try {
        input.off("data", onInput); process.stdout.off("resize", onResize); process.off("SIGINT", onSigint);
        if (input.isTTY && previousRaw !== undefined) input.setRawMode(previousRaw);
        return undefined;
      } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
    };
    const settle = (status: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      const restoreError = restoreTerminal();
      const finalError = error ?? restoreError;
      const finalStatus = restoreError && status === 0 ? 1 : status;
      resolveResult({ status: finalStatus, stdout, stderr: "", ...(finalError ? { spawnError: finalError } : {}), metadata: { pid: pty.pid, sessionId: id, ...(terminalError ? { terminalError } : {}), ...(cleanupPending ? { cleanupVerified } : {}) } });
    };
    const finishEvidence = (): void => {
      logRedactor?.flush();
      if (carry) { terminalError ||= terminalErrorFromLine(carry, secrets); persist(carry, outputPath, opts.deployId, secrets); carry = ""; }
      const status = readPiTerminalStatus(deployDir);
      if (status) {
        const record = status as unknown as Record<string, unknown>;
        terminalError ||= terminalErrorFromValue(record, secrets);
        persist(JSON.stringify(status), outputPath, opts.deployId, secrets);
      }
    };
    const finishCleanup = (): void => {
      if (settled || !cleanupPending || !exited) return;
      cleanupVerified = true;
      settle(cleanupStatus, cleanupError);
    };
    const requestCleanup = (status: number, error: Error): void => {
      if (settled || cleanupPending) return;
      cleanupPending = true; cleanupStatus = status; cleanupError = error;
      if (timer) clearTimer(timer);
      const deadline = now() + PROCESS_TREE_TIMEOUT;
      let killSent = false;
      try { pty.kill("SIGTERM"); } catch { /* onExit remains the authoritative exit confirmation */ }
      finishCleanup();
      if (settled) return;
      void (async () => {
        while (!settled && !exited && now() < deadline) {
          if (!killSent && now() >= deadline - PROCESS_TREE_TIMEOUT + TERM_GRACE) {
            killSent = true;
            try { pty.kill("SIGKILL"); } catch { /* continue waiting for onExit */ }
          }
          if (!exited) await sleep(Math.min(PROCESS_TREE_POLL, Math.max(1, deadline - now())));
        }
        if (settled) return;
        if (exited) { finishCleanup(); return; }
        cleanupError = new Error(`${cleanupError?.message ?? "Pi cleanup failed"}; PTY child exit was not confirmed before cleanup deadline`);
        settle(cleanupStatus, cleanupError);
      })();
    };
    const onInput = (chunk: Buffer | string): void => { if (!settled && !cleanupPending) { try { pty.write(chunk.toString()); } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); } } };
    const onSigint = (): void => { if (!settled && !cleanupPending) { try { pty.kill("SIGINT"); } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); } } };
    const onResize = (): void => { if (!settled && !cleanupPending) { try { pty.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24); } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); } } };
    const onData = (chunk: string): void => {
      if (settled || cleanupPending) return;
      try {
        stdout = tail(stdout + chunk, MAX_CAPTURE); carry = tail(carry + chunk, MAX_CARRY); output.write(chunk); logRedactor?.push(chunk);
        const lines = carry.split("\n"); carry = tail(lines.pop() ?? "", MAX_CARRY);
        for (const line of lines) { terminalError ||= terminalErrorFromLine(line, secrets); persist(line, outputPath, opts.deployId, secrets); }
      } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); }
    };

    try {
      if (input.isTTY) input.setRawMode(true);
      input.on("data", onInput); process.stdout.on("resize", onResize); process.once("SIGINT", onSigint); pty.onData(onData);
      pty.onExit(({ exitCode, signal }) => {
        exited = true;
        if (cleanupPending) { finishCleanup(); return; }
        try {
          finishEvidence();
          settle(exitCode, exitCode === 0 ? undefined : new Error(`Pi exited with code ${exitCode || signal || 1}`));
        } catch (error) { settle(1, error instanceof Error ? error : new Error(String(error))); }
      });
      if (opts.timeoutMs) timer = setTimer(() => requestCleanup(124, new Error("Pi deployment timed out")), opts.timeoutMs);
    } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); }
  });
}
function persistLine(line: string, path: string, deployId: string, secrets: string[]): void { if (!line.trim()) return; const safe = redactJsonLine(line, secrets); mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${safe}\n`); appendActivityEvent(parsePiLine(safe, deployId, secrets), getDeployPaths(deployId).activityLogPath); }
function persistOutput(opts: SpawnOpts, stdout: string, stderr: string, secrets: string[]): Record<string, unknown> { const outputPath = resolve(dirname(opts.primerPath), "pi-output.jsonl"); mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, stdout.split("\n").filter(Boolean).map((line) => redactJsonLine(line, secrets)).join("\n") + (stdout ? "\n" : ""), "utf8"); if (opts.logFile) writeFileSync(opts.logFile, redact(stdout + stderr, secrets), "utf8"); const terminalError = stdout.split("\n").map((line) => terminalErrorFromLine(line, secrets)).find(Boolean); return terminalError ? { terminalError } : {}; }
function failure(message: string): SpawnResult { return { exitCode: 1, errorMessage: message }; }
function redactJsonLine(line: string, secrets: string[]): string { try { return JSON.stringify(deepRedact(JSON.parse(line), secrets)); } catch { return redact(line, secrets); } }
const redact = redactDiagnostic;
function terminalErrorFromLine(line: string, secrets: string[]): string { try { return terminalErrorFromValue(JSON.parse(line) as Record<string, unknown>, secrets); } catch { return ""; } }
function terminalErrorFromValue(value: Record<string, unknown>, secrets: string[]): string { const stopReason = value.stopReason ?? value.stop_reason; const type = String(value.type ?? value.event ?? value.kind ?? "").toLowerCase(); const hasError = typeof value.error === "string" || typeof value.errorMessage === "string" || typeof value.error_message === "string"; if (stopReason !== "error" && !(hasError && /agent_end|turn_end|session_end|terminal|complete|stop/.test(type))) return ""; return redact(tail(extractText(value) || String(value.error ?? value.errorMessage ?? stopReason), MAX_STDERR), secrets); }
function deepRedact(value: unknown, secrets: string[] = []): unknown { if (typeof value === "string") return redact(value, secrets); if (Array.isArray(value)) return value.map((item) => deepRedact(item, secrets)); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => SECRET_KEY.test(key) ? [key, "[REDACTED]"] : [key, deepRedact(item, secrets)])); return value; }
function allowMetadata(raw: Record<string, unknown>): Record<string, unknown> { const metadata: Record<string, unknown> = {}; for (const key of ["type", "event", "kind", "timestamp", "role", "tool", "toolName", "args", "partialResult", "assistantMessageEvent", "partType"]) if (raw[key] !== undefined) metadata[key] = raw[key]; return metadata; }
function extractText(raw: Record<string, unknown>): string { const values = [raw.text, raw.body, raw.content, raw.message, raw.result, raw.partialResult, raw.assistantMessageEvent, raw.toolName, raw.args]; for (const value of values) { if (typeof value === "string") return value; if (Array.isArray(value)) { const text = value.map((item) => typeof item === "string" ? item : item && typeof item === "object" ? extractText(item as Record<string, unknown>) : "").filter(Boolean).join(" "); if (text) return text; } if (value && typeof value === "object") { const nested = extractText(value as Record<string, unknown>); if (nested) return nested; } } return ""; }
function tail(value: string, max: number): string { return value.length > max ? value.slice(-max) : value; }
function basename(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown"; }
function probePiVersion(cwd: string, env: NodeJS.ProcessEnv, timeout: number): string {
  const result = spawnSync("pi", ["--version"], { cwd, env, encoding: "utf8", timeout });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new Error(`Pi version probe timed out after ${timeout}ms.`);
    throw new Error(`Pi is unavailable: ${result.error.message}. Install Pi 0.80.8 or later and ensure 'pi' is on PATH.`);
  }
  if (result.status !== 0) throw new Error(`Pi version probe failed with exit code ${result.status ?? 1}.`);
  return `${result.stdout ?? ""}`.trim();
}
async function bounded<T>(value: T | Promise<T>, timeout: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(() => rejectValue(new Error(timeoutMessage)), timeout);
    void Promise.resolve(value).then((result) => { clearTimeout(timer); resolveValue(result); }, (error: unknown) => { clearTimeout(timer); rejectValue(error); });
  });
}
function processGroupGone(pid: number): boolean { try { process.kill(-pid, 0); return false; } catch { return true; } }
