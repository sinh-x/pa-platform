import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { spawn as spawnPty, type IPty } from "node-pty";
import { appendActivityEvent, createActivityEvent, getDeployPaths, parseTimestamp, type ActivityEvent, type HookConfig, type ResumeOpts, type RuntimeAdapter, type SpawnOpts, type SpawnResult, type ToolReference } from "@pa-platform/pa-core";
import { environmentSecrets, redactDiagnostic, SECRET_KEY, StreamingRedactor } from "./diagnostics.js";
import { clearPiTerminalStatus, readPiTerminalStatus } from "./terminal-status.js";
import { normalizePiRuntimeConfig } from "./runtime-normalization.js";
import { piRegistryEnvironment, probePiNativeRegistryAddon, type PiNativeHostEvidence } from "./native-host.js";

const MAX_BODY = 500;
const MAX_STDERR = 2000;
const MAX_CAPTURE = 8000;
export const PI_VERSION_TIMEOUT_MS = 15_000;
const TERM_GRACE = 250;
const MAX_CARRY = 256 * 1024;
const PROCESS_TREE_TIMEOUT = 4900;
const PROCESS_TREE_POLL = 25;
const FOREGROUND_EXIT_STATUS_GRACE_MS = 250;
const FOREGROUND_DOUBLE_INTERRUPT_MS = 5_000;
const BACKGROUND_READINESS_TIMEOUT_MS = 4_000;
const BACKGROUND_READINESS_POLL_MS = 25;
const MAX_BACKGROUND_CONFIG_BYTES = 64 * 1024;
export const PI_SUPERVISOR_FILE = "pi-supervisor.json";
export const PI_BACKGROUND_CONFIG_FILE = "pi-background.json";
export interface PiCommandResult { status: number | null; stdout: string; stderr: string; spawnError?: Error; metadata?: Record<string, unknown> }
/** @deprecated Background completion is owned by the persistent runner. */
export interface PiSupervisionHandle { completion: Promise<PiCommandResult>; pid?: number }
export interface PiBackgroundConfig {
  schemaVersion: 1;
  ownershipToken: string;
  deploymentId: string;
  team: string;
  cwd: string;
  primerPath: string;
  logFile: string;
  sessionId: string;
  model?: string;
  provider?: string;
  managed: boolean;
  skills: string[];
  trustedExtension?: string;
  timeoutMs?: number;
}
export interface PiSupervisorOwnership {
  schemaVersion: 1;
  deploymentId: string;
  ownershipToken: string;
  state: "starting" | "active" | "finalizing" | "finalized" | "failed";
  ready: boolean;
  supervisorPid: number;
  childPid?: number;
  updatedAt: string;
  finalizationDeadlineMs: number;
  terminalEvent?: "completed" | "crashed";
  terminalStatus?: "success" | "failed";
  error?: string;
}
export interface PiToolProtocolOutcome {
  callId: string;
  toolName: string;
  arguments?: unknown;
  status: "executed" | "malformed" | "incomplete" | "execution-mismatch";
  executionStarts: number;
  executionEnds: number;
}
export interface PiAdapterOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => PiCommandResult | Promise<PiCommandResult>;
  versionProbe?: () => string | Promise<string>;
  nativeRegistryProbe?: () => PiNativeHostEvidence | undefined | Promise<PiNativeHostEvidence | undefined>;
  versionTimeoutMs?: number;
  sessionIdFactory?: () => string;
  secretValues?: string[];
  supervision?: PiSupervisionOptions;
}

export interface PiSupervisionOptions {
  spawnProcess?: typeof spawn;
  now?: () => number;
  /** Monotonic interval clock used for foreground interrupt sequencing. */
  interruptNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  processGroupGone?: (pid: number) => boolean;
  /** Return false only when the PTY child is known to have exited. */
  processExists?: (pid: number) => boolean;
  persistLine?: (line: string, path: string, deployId: string, secrets: string[]) => void;
  writeLog?: typeof writeFileSync;
  appendLog?: typeof appendFileSync;
  setTimeout?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeout?: (timeout: NodeJS.Timeout) => void;
  spawnPty?: (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string | undefined> }) => IPty;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  columns?: number;
  rows?: number;
  launchBackgroundRunner?: (runnerPath: string, configPath: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;
  readBackgroundOwnership?: (path: string) => PiSupervisorOwnership | undefined;
  readinessNow?: () => number;
  readinessSleep?: (milliseconds: number) => Promise<void>;
  readinessTimeoutMs?: number;
  onSpawn?: (pid: number) => void;
  shutdownSignal?: AbortSignal;
}

export class PiAdapter implements RuntimeAdapter {
  readonly name = "pi" as const;
  readonly defaultModel = "";
  readonly sessionFileName = "session-id-pi.txt";
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand?: PiAdapterOptions["runCommand"];
  private readonly versionProbe: () => string | Promise<string>;
  private readonly nativeRegistryProbe: () => PiNativeHostEvidence | undefined | Promise<PiNativeHostEvidence | undefined>;
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
    this.nativeRegistryProbe = options.nativeRegistryProbe ?? (() => probePiNativeRegistryAddon(this.env, this.secretValues));
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    this.secretValues = [...(options.secretValues ?? [])];
    this.supervision = options.supervision ?? {};
  }

  spawn(opts: SpawnOpts): Promise<SpawnResult> { return this.run(opts); }
  resume(opts: ResumeOpts): Promise<SpawnResult> { return this.run(opts, opts.sessionId); }
  extractActivity(deployDir: string): ActivityEvent[] {
    const path = resolve(deployDir, "pi-output.jsonl"); if (!existsSync(path)) return [];
    const projector = new PiActivityProjector(basename(deployDir), this.secretValues);
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => projector.observeLine(line));
  }
  installHooks(_targetDir: string, _config: HookConfig): void {}
  describeTools(): ToolReference { return { runtime: "pi", markdown: "Runtime: Pi via `ppa`. Use `ppa` for PA deployments; Pi 0.80.8 or later must be installed as `pi`." }; }

  async preflight(): Promise<void> {
    if (!this.preflightPromise) {
      const probe = (async () => {
        // The installed Pi version and native-host addon are independent process
        // validations. Start both before awaiting either so their cold startup
        // costs overlap, while retaining deterministic version-first failures.
        let versionValue: string | Promise<string>;
        try { versionValue = this.versionProbe(); } catch (error) { versionValue = Promise.reject(error); }
        let nativeValue: PiNativeHostEvidence | undefined | Promise<PiNativeHostEvidence | undefined>;
        try { nativeValue = this.nativeRegistryProbe(); } catch (error) { nativeValue = Promise.reject(error); }
        const [versionResult, nativeResult] = await Promise.allSettled([
          bounded(versionValue, this.versionTimeoutMs, `Pi version probe timed out after ${this.versionTimeoutMs}ms.`),
          bounded(nativeValue, this.versionTimeoutMs, `native-load: Pi registry addon probe timed out after ${this.versionTimeoutMs}ms.`),
        ]);
        if (versionResult.status === "rejected") throw versionResult.reason;
        if (!meetsMinimum(versionResult.value)) throw new Error(`Pi version must be 0.80.8 or later; detected '${versionResult.value || "unknown"}'.`);
        if (nativeResult.status === "rejected") throw nativeResult.reason;
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
    const piEnv = piRegistryEnvironment(env);
    const secrets = environmentSecrets(env, this.secretValues);
    if (interactive) clearPiTerminalStatus(dirname(opts.primerPath));
    const result = this.runCommand
      ? await this.runCommand(args, { cwd, env: piEnv })
      : interactive
        ? await runPiForeground(args, cwd, piEnv, opts, id, secrets, this.supervision)
        : opts.mode === "background"
          ? await launchPiBackgroundRunner({ cwd, env, opts, id, model: normalized.model, provider: normalized.provider, secrets, supervision: this.supervision })
          : await runPiManagedProcess(args, cwd, piEnv, opts, id, secrets, this.supervision);
    if (this.runCommand && !interactive) {
      result.metadata = { ...(result.metadata ?? {}), ...persistOutput(opts, result.stdout, result.stderr, secrets) };
    }
    const cleanupUnverified = result.metadata?.["cleanupVerified"] === false;
    if (result.status !== 0 || result.spawnError || cleanupUnverified) {
      const exitCode = result.status === 0 ? 1 : result.status ?? 1;
      const message = redactPiLog(tail(result.stderr || result.spawnError?.message || (cleanupUnverified ? "Pi cleanup failed: PTY child exit was not verified" : `pi exited with code ${exitCode}`), MAX_STDERR), secrets);
      return { sessionId: id, exitCode, logFile: opts.logFile, errorMessage: message, metadata: { ...(result.metadata ?? {}), sessionId: id } };
    }
    const terminalError = typeof result.metadata?.["terminalError"] === "string" ? result.metadata["terminalError"] : undefined;
    if (terminalError) return { sessionId: id, exitCode: 1, logFile: opts.logFile, errorMessage: terminalError, metadata: { ...(result.metadata ?? {}), sessionId: id } };
    return { sessionId: id, exitCode: 0, logFile: opts.logFile, metadata: { ...(result.metadata ?? {}), sessionId: id } };
  }
}

export function meetsMinimum(version: string): boolean { const match = version.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?=\s|$)/); if (!match) return false; const actual = [Number(match[1]), Number(match[2]), Number(match[3])]; return actual[0] > 0 || actual[0] === 0 && (actual[1] > 80 || actual[1] === 80 && actual[2] >= 8); }
export function normalizePiEvent(raw: Record<string, unknown>, deployId: string, secrets: string[] = []): ActivityEvent {
  const safe = deepRedact(raw, secrets) as Record<string, unknown>;
  const outerType = String(safe.type ?? safe.event ?? safe.kind ?? "text").toLowerCase();
  const assistant = record(safe.assistantMessageEvent);
  const nestedType = String(assistant?.type ?? "").toLowerCase();
  const type = outerType === "message_update" && /^toolcall_(?:start|delta|end)$/.test(nestedType) ? nestedType : outerType;
  const kind: ActivityEvent["kind"] = type === "tool_execution_end" || type === "tool_result" || type === "tool_execution_result" ? "tool_result" : type === "tool_execution_start" || type === "tool_use" || type === "tool_call" || type.startsWith("toolcall_") ? "tool_use" : type.includes("error") ? "error" : type.includes("think") ? "thinking" : type.includes("tool") ? "tool_use" : "text";
  const body = redact(extractText(type.startsWith("toolcall_") && assistant ? assistant : safe) || type, secrets);
  const metadata = { ...allowMetadata(safe), ...toolCallMetadata(assistant) };
  const tool = typeof metadata.tool === "string" ? metadata.tool : metadata.toolName;
  if (typeof tool === "string") metadata.tool = tool;
  return createActivityEvent({ deployId, kind, source: "pi", body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 3)}...` : body, partType: type, metadata, timestamp: typeof safe.timestamp === "string" ? parseTimestamp(safe.timestamp).toISOString() : undefined });
}

interface ProjectedPiToolCall {
  callId: string;
  toolName: string;
  arguments?: unknown;
}

class PiActivityProjector {
  private readonly callsById = new Map<string, ProjectedPiToolCall>();
  private readonly callsByContentIndex = new Map<string, ProjectedPiToolCall>();
  private readonly projectedUses = new Set<string>();
  private readonly projectedResults = new Set<string>();
  private readonly diagnostics = new Set<string>();

  constructor(private readonly deployId: string, private readonly secrets: string[]) {}

  observeLine(line: string): ActivityEvent[] {
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return [parsePiLine(line, this.deployId, this.secrets)];
      return this.observe(value as Record<string, unknown>);
    } catch {
      if (/^\s*[\[{]/.test(line)) return this.diagnostic("malformed-protocol: invalid Pi JSON record");
      return [parsePiLine(line, this.deployId, this.secrets)];
    }
  }

  observe(raw: Record<string, unknown>): ActivityEvent[] {
    const safe = deepRedact(raw, this.secrets) as Record<string, unknown>;
    const assistant = record(safe.assistantMessageEvent);
    const nestedType = String(assistant?.type ?? "").toLowerCase();
    const contentIndex = String(assistant?.contentIndex ?? "");
    if (nestedType === "toolcall_start") {
      const partial = record(assistant?.partial);
      const content = Array.isArray(partial?.content) ? partial.content : [];
      const value = content.map((item) => record(item)).find((item) => item?.type === "toolCall");
      const call = this.toolCall(value?.id, value?.name, value?.arguments);
      if (call) { this.callsById.set(call.callId, call); this.callsByContentIndex.set(contentIndex, call); }
      return [];
    }
    if (nestedType === "toolcall_delta") return [];
    if (nestedType === "toolcall_end") {
      const finalCall = record(assistant?.toolCall);
      const prior = this.callsByContentIndex.get(contentIndex);
      const call = this.toolCall(finalCall?.id ?? prior?.callId, finalCall?.name ?? prior?.toolName, finalCall?.arguments ?? prior?.arguments);
      if (call) { this.callsById.set(call.callId, call); this.callsByContentIndex.set(contentIndex, call); }
      return [];
    }

    const type = String(safe.type ?? safe.event ?? safe.kind ?? "").toLowerCase();
    if (type === "tool_execution_update") return [];
    const isUse = type === "tool_execution_start" || type === "tool_running";
    const isResult = type === "tool_execution_end" || type === "tool_completed" || type === "tool_execution_result" || type === "tool_result";
    if (!isUse && !isResult) return [normalizePiEvent(safe, this.deployId, this.secrets)];

    const callIdValue = safe.toolCallId ?? safe.callId;
    const callId = typeof callIdValue === "string" ? callIdValue.trim() : "";
    if (!callId) return this.diagnostic(`malformed-tool: ${isUse ? "use" : "result"} is missing a call id`);
    const prior = this.callsById.get(callId);
    const toolNameValue = safe.toolName ?? safe.tool ?? prior?.toolName;
    const toolName = typeof toolNameValue === "string" ? toolNameValue.trim() : "";
    if (!toolName) return this.diagnostic(`malformed-tool: ${isUse ? "use" : "result"} ${callId} is missing a tool name`);
    const args = safe.args ?? prior?.arguments;
    const call: ProjectedPiToolCall = { callId, toolName, ...(args !== undefined ? { arguments: args } : {}) };
    this.callsById.set(callId, call);

    if (isUse) {
      if (this.projectedUses.has(callId)) return [];
      this.projectedUses.add(callId);
      return [normalizePiEvent({ ...safe, type: "tool_execution_start", toolCallId: callId, toolName, ...(args !== undefined ? { args } : {}) }, this.deployId, this.secrets)];
    }
    if (!this.projectedUses.has(callId)) return this.diagnostic(`malformed-tool: result ${callId} has no matching execution start`);
    if (this.projectedResults.has(callId)) return [];
    this.projectedResults.add(callId);
    return [normalizePiEvent({ ...safe, type: "tool_execution_end", toolCallId: callId, toolName, ...(args !== undefined ? { args } : {}) }, this.deployId, this.secrets)];
  }

  private toolCall(id: unknown, name: unknown, args: unknown): ProjectedPiToolCall | undefined {
    const callId = typeof id === "string" ? id.trim() : "";
    const toolName = typeof name === "string" ? name.trim() : "";
    return callId && toolName ? { callId, toolName, ...(args !== undefined ? { arguments: args } : {}) } : undefined;
  }

  private diagnostic(body: string): ActivityEvent[] {
    const safeBody = redact(body, this.secrets).slice(0, MAX_BODY);
    if (this.diagnostics.has(safeBody)) return [];
    this.diagnostics.add(safeBody);
    return [createActivityEvent({ deployId: this.deployId, kind: "error", source: "pi", body: safeBody, partType: "protocol_diagnostic" })];
  }
}

export function projectPiActivity(events: Array<Record<string, unknown>>, deployId: string, secrets: string[] = []): ActivityEvent[] {
  const projector = new PiActivityProjector(deployId, secrets);
  return events.flatMap((event) => projector.observe(event));
}

interface TrackedPiToolCall extends PiToolProtocolOutcome {
  contentIndex: string;
  deltas: string[];
  ended: boolean;
  malformed: boolean;
  executionToolName?: string;
  executionArguments?: unknown;
  executionIdentityMismatch?: boolean;
}

class PiToolProtocolInspector {
  private readonly calls: TrackedPiToolCall[] = [];

  observe(raw: Record<string, unknown>): void {
    const assistant = record(raw.assistantMessageEvent);
    const nestedType = String(assistant?.type ?? "");
    const contentIndex = String(assistant?.contentIndex ?? "");
    if (nestedType === "toolcall_start") {
      const partial = record(assistant?.partial);
      const content = Array.isArray(partial?.content) ? partial.content : [];
      const call = content.map((item) => record(item)).find((item) => item?.type === "toolCall");
      if (call) this.calls.push({ contentIndex, callId: String(call.id ?? ""), toolName: String(call.name ?? "unknown"), deltas: [], ended: false, malformed: false, status: "incomplete", executionStarts: 0, executionEnds: 0 });
      return;
    }
    const active = [...this.calls].reverse().find((call) => call.contentIndex === contentIndex && !call.ended);
    if (nestedType === "toolcall_delta") {
      if (active) active.deltas.push(String(assistant?.delta ?? ""));
      return;
    }
    if (nestedType === "toolcall_end") {
      const finalCall = record(assistant?.toolCall);
      if (!active || !finalCall) return;
      active.callId = String(finalCall.id ?? active.callId);
      active.toolName = String(finalCall.name ?? active.toolName);
      active.arguments = finalCall.arguments;
      active.ended = true;
      try { active.malformed = active.deltas.length > 0 && !isDeepStrictEqual(JSON.parse(active.deltas.join("")), finalCall.arguments); }
      catch { active.malformed = true; }
      return;
    }
    const type = String(raw.type ?? "");
    if (type !== "tool_execution_start" && type !== "tool_execution_end") return;
    const callId = String(raw.toolCallId ?? "");
    const tracked = [...this.calls].reverse().find((call) => call.callId === callId);
    if (!tracked) return;
    if (typeof raw.toolName === "string") {
      if (tracked.executionToolName !== undefined && tracked.executionToolName !== raw.toolName) tracked.executionIdentityMismatch = true;
      tracked.executionToolName = raw.toolName;
    }
    if (raw.args !== undefined) tracked.executionArguments = raw.args;
    if (type === "tool_execution_start") tracked.executionStarts++;
    else tracked.executionEnds++;
  }

  outcomes(): PiToolProtocolOutcome[] {
    return this.calls.map((call) => {
      const executionMatches = !call.executionIdentityMismatch && (call.executionToolName === undefined || call.executionToolName === call.toolName);
      const argumentsMatch = call.executionArguments === undefined || call.arguments === undefined || isDeepStrictEqual(call.executionArguments, call.arguments);
      const executed = call.ended && call.executionStarts === 1 && call.executionEnds === 1 && executionMatches && argumentsMatch;
      const executionObserved = call.executionStarts > 0 || call.executionEnds > 0;
      const status = executed ? "executed" : executionObserved ? "execution-mismatch" : !call.ended ? "incomplete" : call.malformed ? "malformed" : "execution-mismatch";
      return { callId: call.callId, toolName: call.toolName, ...(call.arguments !== undefined ? { arguments: call.arguments } : {}), status, executionStarts: call.executionStarts, executionEnds: call.executionEnds };
    });
  }

  diagnostic(): string {
    const failed = this.outcomes().find((call) => call.status !== "executed");
    if (!failed) return "";
    const identity = `${failed.toolName} (${failed.callId || "missing call id"})`;
    if (failed.status === "incomplete") return `Incomplete Pi tool call ${identity}; execution was suppressed.`;
    if (failed.status === "malformed") return `Malformed Pi tool call ${identity}; execution was suppressed.`;
    return `Invalid Pi tool execution lifecycle for ${identity}: expected one start/end, observed ${failed.executionStarts}/${failed.executionEnds}.`;
  }
}

export function inspectPiToolProtocol(events: Array<Record<string, unknown>>): { outcomes: PiToolProtocolOutcome[]; diagnostic: string } {
  const inspector = new PiToolProtocolInspector();
  for (const event of events) inspector.observe(event);
  return { outcomes: inspector.outcomes(), diagnostic: inspector.diagnostic() };
}
function parsePiLine(line: string, deployId: string, secrets: string[] = []): ActivityEvent { try { const value = JSON.parse(line) as unknown; return Array.isArray(value) ? normalizePiEvent({ type: "message", content: value }, deployId, secrets) : normalizePiEvent(value as Record<string, unknown>, deployId, secrets); } catch { return createActivityEvent({ deployId, kind: "text", source: "pi", body: redact(line, secrets).slice(0, MAX_BODY) }); } }
export function runPiManagedProcess(args: string[], cwd: string, env: NodeJS.ProcessEnv, opts: SpawnOpts, id: string, secrets: string[], supervision: PiSupervisionOptions = {}): Promise<PiCommandResult> {
  const spawnProcess = supervision.spawnProcess ?? spawn;
  const now = supervision.now ?? Date.now;
  const sleep = supervision.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const sendSignal = supervision.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(-pid, signal));
  const groupGone = supervision.processGroupGone ?? ((pid: number) => processGroupGone(pid));
  const injectedPersist = supervision.persistLine;
  const projector = new PiActivityProjector(opts.deployId, secrets);
  const persist = (line: string, path: string): void => injectedPersist ? injectedPersist(line, path, opts.deployId, secrets) : persistLine(line, path, opts.deployId, secrets, projector);
  const writeLog = supervision.writeLog ?? writeFileSync;
  const setTimer = supervision.setTimeout ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
  const clearTimer = supervision.clearTimeout ?? ((timeout: NodeJS.Timeout) => clearTimeout(timeout));
  const child = spawnProcess("pi", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let completion!: Promise<PiCommandResult>;
  completion = new Promise((resolveResult) => {
    let stdout = ""; let stderr = ""; let carry = ""; let terminalError = ""; let settled = false; let directClosed = false; let cleanupPending = false; let cleanupVerified = false; let timer: NodeJS.Timeout | undefined; let cleanupDeadline = 0; let cleanupStatus = 1; let cleanupError: Error | undefined; let onShutdown: (() => void) | undefined;
    const protocol = new PiToolProtocolInspector();
    const outputPath = resolve(dirname(opts.primerPath), "pi-output.jsonl");
    const settle = (status: number | null, error?: Error): void => {
      if (settled) return;
      if (timer) clearTimer(timer);
      if (onShutdown) supervision.shutdownSignal?.removeEventListener("abort", onShutdown);
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
    const finish = (status: number, error?: Error): void => {
      if (settled || cleanupPending) return;
      try {
        if (carry) { observeProtocolLine(protocol, carry); terminalError ||= terminalErrorFromLine(carry, secrets); persist(carry, outputPath); carry = ""; }
        if (opts.logFile) writeLog(opts.logFile, redactPiLog(stdout + stderr, secrets), "utf8");
        terminalError ||= protocol.diagnostic();
        settle(status, error);
      } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); }
    };
    const consume = (chunk: Buffer, stream: "stdout" | "stderr"): void => { const text = chunk.toString("utf8"); if (stream === "stdout") { stdout = tail(stdout + text, MAX_CAPTURE); carry = tail(carry + text, MAX_CARRY); const lines = carry.split("\n"); carry = tail(lines.pop() ?? "", MAX_CARRY); for (const line of lines) { observeProtocolLine(protocol, line); terminalError ||= terminalErrorFromLine(line, secrets); try { persist(line, outputPath); } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); return; } } } else stderr = tail(redact(stderr + text, secrets), MAX_STDERR); };
    child.stdout?.on("data", (chunk: Buffer) => { if (!cleanupPending) consume(chunk, "stdout"); }); child.stderr?.on("data", (chunk: Buffer) => { if (!cleanupPending) consume(chunk, "stderr"); });
    child.once("error", (error) => { if (!cleanupPending) settle(null, error); }); child.once("close", (code) => { directClosed = true; if (!cleanupPending) finish(code ?? 1, code === 0 ? undefined : new Error(`Pi exited with code ${code ?? 1}`)); });
    if (opts.timeoutMs) timer = setTimer(() => requestCleanup(124, new Error("Pi deployment timed out")), opts.timeoutMs);
    if (supervision.shutdownSignal) {
      onShutdown = () => {
        const reason = typeof supervision.shutdownSignal?.reason === "string" ? supervision.shutdownSignal.reason : "signal";
        requestCleanup(reason === "SIGINT" ? 130 : 143, new Error(`runner-shutdown: Pi supervisor received ${reason}`));
      };
      supervision.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
      if (supervision.shutdownSignal.aborted) onShutdown();
    }
    try {
      if (!child.pid) throw new Error("Pi child did not expose a process id");
      supervision.onSpawn?.(child.pid);
    } catch (error) {
      requestCleanup(1, error instanceof Error ? error : new Error(String(error)));
    }
  });
  return completion;
}

interface BackgroundLaunchInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  opts: SpawnOpts;
  id: string;
  model?: string;
  provider?: string;
  secrets: string[];
  supervision: PiSupervisionOptions;
}

async function launchPiBackgroundRunner(input: BackgroundLaunchInput): Promise<PiCommandResult> {
  const deployDir = dirname(input.opts.primerPath);
  const configPath = resolve(deployDir, PI_BACKGROUND_CONFIG_FILE);
  const ownershipPath = resolve(deployDir, PI_SUPERVISOR_FILE);
  const ownershipToken = randomUUID();
  const plan = input.opts.executionPlan;
  const config: PiBackgroundConfig = {
    schemaVersion: 1,
    ownershipToken,
    deploymentId: input.opts.deployId,
    team: input.env["PA_TEAM"] || plan?.team || "unknown",
    cwd: input.cwd,
    primerPath: input.opts.primerPath,
    logFile: input.opts.logFile ?? resolve(deployDir, "pi.log"),
    sessionId: input.id,
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    managed: plan !== undefined,
    skills: plan?.skills.map((skill) => skill.path) ?? [],
    ...(plan?.trustedExtension ? { trustedExtension: plan.trustedExtension } : {}),
    ...(input.opts.timeoutMs ? { timeoutMs: input.opts.timeoutMs } : {}),
  };
  try {
    writePiBackgroundConfig(configPath, config);
  } catch (error) {
    return { status: null, stdout: "", stderr: "", spawnError: new Error(`runner-launcher: ${boundedRunnerDiagnostic(error, input.secrets)}`), metadata: { sessionId: input.id } };
  }

  const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "background-runner.js");
  const launch = input.supervision.launchBackgroundRunner ?? ((path, backgroundConfig, options) =>
    spawn(process.execPath, [path, backgroundConfig], { ...options, detached: true, stdio: "ignore" })
  );
  let runner: ChildProcess;
  try {
    runner = launch(runnerPath, configPath, { cwd: input.cwd, env: input.env });
  } catch (error) {
    safeUnlink(configPath);
    return { status: null, stdout: "", stderr: "", spawnError: new Error(`runner-launcher: ${boundedRunnerDiagnostic(error, input.secrets)}`), metadata: { sessionId: input.id } };
  }

  let launchError: Error | undefined;
  const onError = (error: Error): void => { launchError = error; };
  runner.once("error", onError);
  const readOwnership = input.supervision.readBackgroundOwnership ?? readPiSupervisorOwnership;
  const now = input.supervision.readinessNow ?? (() => performance.now());
  const wait = input.supervision.readinessSleep ?? ((milliseconds: number) => new Promise<void>((resolveValue) => setTimeout(resolveValue, milliseconds)));
  const timeoutMs = Math.min(BACKGROUND_READINESS_TIMEOUT_MS, Math.max(1, input.supervision.readinessTimeoutMs ?? BACKGROUND_READINESS_TIMEOUT_MS));
  const readinessStartedAt = now();
  const deadline = readinessStartedAt + timeoutMs;
  let ownership: PiSupervisorOwnership | undefined;
  while (now() < deadline) {
    if (launchError) break;
    try { ownership = readOwnership(ownershipPath); } catch (error) {
      launchError = error instanceof Error ? error : new Error(String(error));
      break;
    }
    if (ownership?.deploymentId === input.opts.deployId && ownership.ownershipToken === ownershipToken) {
      if (ownership.ready && (ownership.state === "active" || ownership.state === "finalizing" || ownership.state === "finalized")) break;
      if (ownership.state === "failed") {
        launchError = new Error(ownership.error ?? "Pi background supervisor failed before readiness");
        break;
      }
    }
    await wait(Math.min(BACKGROUND_READINESS_POLL_MS, Math.max(1, deadline - now())));
  }
  runner.removeListener("error", onError);

  const ready = ownership?.deploymentId === input.opts.deployId
    && ownership.ownershipToken === ownershipToken
    && ownership.ready
    && (ownership.state === "active" || ownership.state === "finalizing" || ownership.state === "finalized");
  if (!ready) {
    const cleanupError = await terminateRunner(runner.pid, input.supervision, now, wait, readinessStartedAt + PROCESS_TREE_TIMEOUT);
    let configCleanupError: string | undefined;
    try { safeUnlinkOwnedBackgroundConfig(configPath, ownershipToken); }
    catch (error) { configCleanupError = `config cleanup failed: ${boundedRunnerDiagnostic(error, input.secrets)}`; }
    const baseReason = launchError ? boundedRunnerDiagnostic(launchError, input.secrets) : `ownership was not established within ${timeoutMs}ms`;
    const reason = [baseReason, cleanupError, configCleanupError].filter(Boolean).join("; ");
    return { status: null, stdout: "", stderr: "", spawnError: new Error(`runner-readiness: ${reason}`), metadata: { sessionId: input.id, ...(runner.pid ? { supervisorPid: runner.pid } : {}) } };
  }
  const established = ownership!;
  runner.unref();
  return {
    status: 0,
    stdout: "",
    stderr: "",
    metadata: {
      sessionId: input.id,
      pending: true,
      supervisorPid: established.supervisorPid,
      ...(established.childPid ? { pid: established.childPid } : {}),
      ownershipFile: ownershipPath,
    },
  };
}

export function buildPiBackgroundArgs(config: PiBackgroundConfig): string[] {
  const args = ["--print", "--mode", "json", "--session-id", config.sessionId];
  if (config.model) args.push("--model", config.model);
  if (config.provider) args.push("--provider", config.provider);
  if (config.managed) {
    args.push("--no-skills", "--no-extensions");
    for (const skill of config.skills) args.push("--skill", skill);
    if (config.trustedExtension) args.push("--extension", config.trustedExtension);
  }
  args.push(readFileSync(config.primerPath, "utf8"));
  return args;
}

export function writePiBackgroundConfig(path: string, config: PiBackgroundConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(config)}\n`;
  if (Buffer.byteLength(body) > MAX_BACKGROUND_CONFIG_BYTES) throw new Error(`Pi background configuration exceeds ${MAX_BACKGROUND_CONFIG_BYTES} bytes`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function readPiBackgroundConfig(path: string): PiBackgroundConfig {
  const body = readFileSync(path, "utf8");
  if (Buffer.byteLength(body) > MAX_BACKGROUND_CONFIG_BYTES) throw new Error(`runner-readiness: Pi background configuration exceeds ${MAX_BACKGROUND_CONFIG_BYTES} bytes`);
  const value = JSON.parse(body) as Partial<PiBackgroundConfig>;
  if (value.schemaVersion !== 1 || typeof value.ownershipToken !== "string" || typeof value.deploymentId !== "string" || typeof value.team !== "string" || typeof value.cwd !== "string" || typeof value.primerPath !== "string" || typeof value.logFile !== "string" || typeof value.sessionId !== "string" || typeof value.managed !== "boolean" || !Array.isArray(value.skills) || !value.skills.every((skill) => typeof skill === "string")) {
    throw new Error("runner-readiness: Pi background configuration is malformed");
  }
  return value as PiBackgroundConfig;
}

export function readPiSupervisorOwnership(path: string): PiSupervisorOwnership | undefined {
  if (!existsSync(path)) return undefined;
  const body = readFileSync(path, "utf8");
  if (Buffer.byteLength(body) > 16 * 1024) throw new Error("Pi supervisor ownership evidence exceeds 16384 bytes");
  const value = JSON.parse(body) as Partial<PiSupervisorOwnership>;
  if (value.schemaVersion !== 1 || typeof value.deploymentId !== "string" || typeof value.ownershipToken !== "string" || typeof value.state !== "string" || typeof value.ready !== "boolean" || !Number.isInteger(value.supervisorPid) || Number(value.supervisorPid) <= 0 || typeof value.updatedAt !== "string" || !Number.isInteger(value.finalizationDeadlineMs)) throw new Error("Pi supervisor ownership evidence is malformed");
  return value as PiSupervisorOwnership;
}

export function writePiSupervisorOwnership(path: string, ownership: PiSupervisorOwnership): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ownership)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

async function terminateRunner(pid: number | undefined, supervision: PiSupervisionOptions, now: () => number, wait: (milliseconds: number) => Promise<void>, deadline: number): Promise<string | undefined> {
  if (!pid) return undefined;
  const sendSignal = supervision.sendSignal ?? ((target: number, signal: NodeJS.Signals) => {
    try { process.kill(-target, signal); } catch { process.kill(target, signal); }
  });
  const groupGone = supervision.processGroupGone ?? processGroupGone;
  const startedAt = now();
  let killSent = false;
  try { sendSignal(pid, "SIGTERM"); } catch { /* process may already be gone */ }
  while (now() < deadline) {
    if (groupGone(pid)) return undefined;
    if (!killSent && now() - startedAt >= TERM_GRACE) {
      killSent = true;
      try { sendSignal(pid, "SIGKILL"); } catch { /* process may already be gone */ }
    }
    await wait(Math.min(PROCESS_TREE_POLL, Math.max(1, deadline - now())));
  }
  return groupGone(pid) ? undefined : `runner cleanup failed: process group ${pid} remained before the ${PROCESS_TREE_TIMEOUT}ms launch deadline`;
}
function safeUnlinkOwnedBackgroundConfig(path: string, ownershipToken: string): void {
  if (!existsSync(path)) return;
  const body = readFileSync(path, "utf8");
  if (Buffer.byteLength(body) > MAX_BACKGROUND_CONFIG_BYTES) return;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return; }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>)["ownershipToken"] !== ownershipToken) return;
  safeUnlink(path);
}
function safeUnlink(path: string): void { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
function boundedRunnerDiagnostic(error: unknown, secrets: string[]): string { return redact(tail(error instanceof Error ? error.message : String(error), MAX_STDERR), secrets); }

function readableIsFlowing(input: NodeJS.ReadStream): boolean { return input.readableFlowing === true; }

function runPiForeground(args: string[], cwd: string, env: NodeJS.ProcessEnv, opts: SpawnOpts, id: string, secrets: string[], supervision: PiSupervisionOptions): Promise<PiCommandResult> {
  const deployDir = dirname(opts.primerPath);
  const terminalAtLaunch = readPiTerminalStatus(deployDir);
  const pty = (supervision.spawnPty ?? spawnPty)("pi", args, { name: "xterm-256color", cols: supervision.columns ?? process.stdout.columns ?? 80, rows: supervision.rows ?? process.stdout.rows ?? 24, cwd, env });
  const input = supervision.input ?? process.stdin;
  const output = supervision.output ?? process.stdout;
  const outputPath = resolve(deployDir, "pi-output.jsonl");
  const injectedPersist = supervision.persistLine;
  const projector = new PiActivityProjector(opts.deployId, secrets);
  const persist = (line: string, path: string): void => injectedPersist ? injectedPersist(line, path, opts.deployId, secrets) : persistLine(line, path, opts.deployId, secrets, projector);
  const appendLog = supervision.appendLog ?? appendFileSync;
  const now = supervision.now ?? Date.now;
  const interruptNow = supervision.interruptNow ?? (() => performance.now());
  const sleep = supervision.sleep ?? ((milliseconds: number) => new Promise<void>((resolveValue) => setTimeout(resolveValue, milliseconds)));
  const setTimer = supervision.setTimeout ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
  const clearTimer = supervision.clearTimeout ?? ((timeout: NodeJS.Timeout) => clearTimeout(timeout));
  const processExists = supervision.processExists ?? piProcessExists;
  let stdout = ""; let carry = ""; let terminalError = ""; let settled = false; let exited = false; let evidenceFinished = false; let cleanupPending = false; let cleanupVerified = false; let timer: NodeJS.Timeout | undefined; let gracefulExitTimer: NodeJS.Timeout | undefined; let cleanupStatus = 1; let cleanupError: Error | undefined; let processExitObservedAt: number | undefined; let lastInterruptAt: number | undefined; let inputLine = "";
  const previousRaw = input.isTTY ? input.isRaw : undefined;
  const previousFlowing = input.readableFlowing;
  let inputFlowOwned = false;
  const logRedactor = opts.logFile ? new StreamingRedactor(secrets, (safe) => appendLog(opts.logFile!, safe, "utf8"), (value) => redactPiLog(value, secrets), /thinking[_-]?signature|encrypted[_-]?content/i) : undefined;

  return new Promise((resolveResult) => {
    const restoreTerminal = (): Error | undefined => {
      const failures: string[] = [];
      try { input.off("data", onInput); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      try { input.off("end", onInputClosed); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      try { input.off("close", onInputClosed); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      try { process.stdout.off("resize", onResize); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      try { process.off("SIGINT", onSigint); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      try { if (inputFlowOwned) input.pause(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      try { if (input.isTTY && previousRaw !== undefined) input.setRawMode(previousRaw); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      return failures.length > 0 ? new Error(`terminal-restoration: ${failures.join("; ")}`) : undefined;
    };
    const settle = (status: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      if (gracefulExitTimer) clearTimer(gracefulExitTimer);
      const restoreError = restoreTerminal();
      const finalError = error ?? restoreError;
      const finalStatus = finalError && status === 0 ? 1 : status;
      resolveResult({ status: finalStatus, stdout, stderr: "", ...(finalError ? { spawnError: finalError } : {}), metadata: { pid: pty.pid, sessionId: id, ...(terminalError ? { terminalError } : {}), ...(cleanupPending ? { cleanupVerified } : {}) } });
    };
    const finishEvidence = (): void => {
      if (evidenceFinished) return;
      evidenceFinished = true;
      logRedactor?.flush();
      if (carry) { terminalError ||= terminalErrorFromLine(carry, secrets); persist(carry, outputPath); carry = ""; }
      const status = readPiTerminalStatus(deployDir);
      if (status) {
        const record = status as unknown as Record<string, unknown>;
        terminalError ||= terminalErrorFromValue(record, secrets);
        persist(JSON.stringify(status), outputPath);
      }
    };
    const finishCleanup = (): void => {
      if (settled || !cleanupPending || !exited) return;
      cleanupVerified = true;
      try {
        finishEvidence();
        settle(cleanupStatus, cleanupError);
      } catch (error) {
        settle(1, error instanceof Error ? error : new Error(String(error)));
      }
    };
    const finishExit = (exitCode: number, signal?: number): void => {
      if (settled || exited) return;
      exited = true;
      if (cleanupPending) {
        if (exitCode !== 0 && cleanupStatus === 0) {
          cleanupStatus = exitCode;
          cleanupError = new Error(`Pi exited with code ${exitCode || signal || 1}`);
        }
        finishCleanup();
        return;
      }
      try {
        finishEvidence();
        settle(exitCode, exitCode === 0 ? undefined : new Error(`Pi exited with code ${exitCode || signal || 1}`));
      } catch (error) { settle(1, error instanceof Error ? error : new Error(String(error))); }
    };
    const confirmProcessExit = (): boolean => {
      if (pty.pid === undefined) return false;
      let running = true;
      try { running = processExists(pty.pid); } catch { /* an indeterminate probe is not exit evidence */ }
      if (!running) processExitObservedAt ??= now();
      else processExitObservedAt = undefined;
      return !running;
    };
    const monitorProcessExit = async (): Promise<void> => {
      while (!settled && !exited) {
        const processGone = confirmProcessExit();
        if (processGone && processExitObservedAt !== undefined && now() - processExitObservedAt >= FOREGROUND_EXIT_STATUS_GRACE_MS) {
          const terminal = readPiTerminalStatus(deployDir);
          const predatesLaunch = terminal && terminalAtLaunch?.timestamp === terminal.timestamp && terminalAtLaunch.type === terminal.type;
          if (terminal && !predatesLaunch) {
            finishExit(terminal.stopReason === "error" ? 1 : 0);
            return;
          }
          try { finishEvidence(); }
          catch (error) { settle(1, error instanceof Error ? error : new Error(String(error))); return; }
          settle(1, new Error(`process-exit-status-unavailable: Pi process ${pty.pid} exited without a terminal marker or PTY exit status`));
          return;
        }
        await sleep(PROCESS_TREE_POLL);
        // Keep injected/fake clocks from starving input and PTY callbacks.
        await new Promise<void>((resolveValue) => setImmediate(resolveValue));
      }
    };
    const requestCleanup = (status: number, error?: Error): void => {
      if (settled || exited || cleanupPending) return;
      cleanupPending = true; cleanupStatus = status; cleanupError = error;
      if (timer) clearTimer(timer);
      if (gracefulExitTimer) { clearTimer(gracefulExitTimer); gracefulExitTimer = undefined; }
      const deadline = now() + PROCESS_TREE_TIMEOUT;
      let killSent = false;
      try { pty.kill("SIGTERM"); } catch { /* onExit remains the authoritative exit confirmation */ }
      finishCleanup();
      if (settled) return;
      void (async () => {
        while (!settled && !exited && now() < deadline) {
          if (!killSent && now() >= deadline - PROCESS_TREE_TIMEOUT + TERM_GRACE) {
            killSent = true;
            try { pty.kill("SIGKILL"); } catch { /* continue waiting for process evidence */ }
          }
          if (!exited) {
            await sleep(Math.min(PROCESS_TREE_POLL, Math.max(1, deadline - now())));
            if (!settled && !exited && confirmProcessExit()) {
              exited = true;
              finishCleanup();
            }
          }
        }
        if (settled) return;
        if (exited) { finishCleanup(); return; }
        cleanupError = new Error(`${cleanupError?.message ?? "Pi cleanup failed"}; PTY child exit was not confirmed before cleanup deadline`);
        settle(cleanupStatus, cleanupError);
      })();
    };
    const requestGracefulExit = (): void => {
      if (settled || exited || cleanupPending || gracefulExitTimer) return;
      gracefulExitTimer = setTimer(() => {
        gracefulExitTimer = undefined;
        requestCleanup(0);
      }, TERM_GRACE);
    };
    const observeQuitCommand = (text: string): boolean => {
      let quit = false;
      for (const character of text) {
        if (character === "\u0003" || character === "\u0015") inputLine = "";
        else if (character === "\b" || character === "\u007f") inputLine = inputLine.slice(0, -1);
        else if (character === "\r" || character === "\n") { quit ||= inputLine === "/quit"; inputLine = ""; }
        else if (character >= " ") inputLine = tail(inputLine + character, 1_024);
      }
      return quit;
    };
    const interrupt = (forwardCancellation: () => void): void => {
      if (settled || cleanupPending) return;
      const interruptedAt = interruptNow();
      if (lastInterruptAt !== undefined && interruptedAt - lastInterruptAt < FOREGROUND_DOUBLE_INTERRUPT_MS) {
        lastInterruptAt = undefined;
        requestCleanup(0);
        return;
      }
      lastInterruptAt = interruptedAt;
      try { forwardCancellation(); }
      catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); }
    };
    const onInput = (chunk: Buffer | string): void => {
      if (settled || cleanupPending) return;
      const text = chunk.toString();
      const quit = observeQuitCommand(text);
      const pieces = text.split("\u0003");
      for (let index = 0; index < pieces.length; index += 1) {
        if (settled || cleanupPending) break;
        const piece = pieces[index]!;
        try { if (piece) pty.write(piece); }
        catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); break; }
        if (index < pieces.length - 1) interrupt(() => pty.write("\u0003"));
      }
      if (quit) requestGracefulExit();
    };
    const onInputClosed = (): void => requestCleanup(0);
    const onSigint = (): void => interrupt(() => pty.kill("SIGINT"));
    const onResize = (): void => { if (!settled && !cleanupPending) { try { pty.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24); } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); } } };
    const onData = (chunk: string): void => {
      if (settled || cleanupPending) return;
      try {
        stdout = tail(stdout + chunk, MAX_CAPTURE); carry = tail(carry + chunk, MAX_CARRY); output.write(chunk); logRedactor?.push(chunk);
        const lines = carry.split("\n"); carry = tail(lines.pop() ?? "", MAX_CARRY);
        for (const line of lines) { terminalError ||= terminalErrorFromLine(line, secrets); persist(line, outputPath); }
      } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); }
    };

    try {
      if (input.isTTY) input.setRawMode(true);
      input.on("data", onInput);
      inputFlowOwned = previousFlowing !== true && readableIsFlowing(input);
      input.once("end", onInputClosed); input.once("close", onInputClosed); process.stdout.on("resize", onResize); process.on("SIGINT", onSigint); pty.onData(onData);
      pty.onExit(({ exitCode, signal }) => finishExit(exitCode, signal));
      opts.onPid?.(pty.pid);
      if (opts.timeoutMs) timer = setTimer(() => requestCleanup(124, new Error("Pi deployment timed out")), opts.timeoutMs);
      void monitorProcessExit();
    } catch (error) { requestCleanup(1, error instanceof Error ? error : new Error(String(error))); }
  });
}
function persistLine(line: string, path: string, deployId: string, secrets: string[], projector: PiActivityProjector): void { if (!line.trim()) return; const safe = redactJsonLine(line, secrets); mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${safe}\n`); for (const event of projector.observeLine(safe)) appendActivityEvent(event, getDeployPaths(deployId).activityLogPath); }
function persistOutput(opts: SpawnOpts, stdout: string, stderr: string, secrets: string[]): Record<string, unknown> { const outputPath = resolve(dirname(opts.primerPath), "pi-output.jsonl"); mkdirSync(dirname(outputPath), { recursive: true }); const lines = stdout.split("\n").filter(Boolean); const safeLines = lines.map((line) => redactJsonLine(line, secrets)); writeFileSync(outputPath, safeLines.join("\n") + (stdout ? "\n" : ""), "utf8"); const projector = new PiActivityProjector(opts.deployId, secrets); for (const line of safeLines) for (const event of projector.observeLine(line)) appendActivityEvent(event, getDeployPaths(opts.deployId).activityLogPath); if (opts.logFile) writeFileSync(opts.logFile, redactPiLog(stdout + stderr, secrets), "utf8"); const protocol = new PiToolProtocolInspector(); for (const line of lines) observeProtocolLine(protocol, line); const terminalError = lines.map((line) => terminalErrorFromLine(line, secrets)).find(Boolean) || protocol.diagnostic(); return terminalError ? { terminalError: redact(tail(terminalError, MAX_STDERR), secrets) } : {}; }
function failure(message: string): SpawnResult { return { exitCode: 1, errorMessage: message }; }
function redactJsonLine(line: string, secrets: string[]): string { try { return JSON.stringify(deepRedact(JSON.parse(line), secrets)); } catch { const match = SENSITIVE_REASONING_KEY.exec(line); SENSITIVE_REASONING_KEY.lastIndex = 0; return match ? `${redact(line.slice(0, match.index), secrets)}[REDACTED reasoning metadata]` : redact(line, secrets); } }
function redactPiLog(value: string, secrets: string[]): string { return value.split("\n").map((line) => redactJsonLine(line, secrets)).join("\n"); }
const redact = redactDiagnostic;
function terminalErrorFromLine(line: string, secrets: string[]): string { try { return terminalErrorFromValue(JSON.parse(line) as Record<string, unknown>, secrets); } catch { return ""; } }
function terminalErrorFromValue(value: Record<string, unknown>, secrets: string[]): string { const safe = deepRedact(value, secrets) as Record<string, unknown>; const stopReason = safe.stopReason ?? safe.stop_reason; const type = String(safe.type ?? safe.event ?? safe.kind ?? "").toLowerCase(); const hasError = typeof safe.error === "string" || typeof safe.errorMessage === "string" || typeof safe.error_message === "string"; if (stopReason !== "error" && !(hasError && /agent_end|turn_end|session_end|terminal|complete|stop/.test(type))) return ""; return redact(tail(extractText(safe) || String(safe.error ?? safe.errorMessage ?? stopReason), MAX_STDERR), secrets); }
function observeProtocolLine(inspector: PiToolProtocolInspector, line: string): void { try { const value = JSON.parse(line) as unknown; if (value && typeof value === "object" && !Array.isArray(value)) inspector.observe(value as Record<string, unknown>); } catch { /* Non-JSON terminal output is not Pi protocol evidence. */ } }
const SENSITIVE_REASONING_KEY = /thinking[_-]?signature|encrypted[_-]?content/gi;
const SENSITIVE_REASONING_FIELD = /^(?:thinking[_-]?signature|encrypted[_-]?content)$/i;
function deepRedact(value: unknown, secrets: string[] = []): unknown { return deepRedactValue(value, [...secrets, ...sensitiveReasoningValues(value)]); }
function deepRedactValue(value: unknown, secrets: string[]): unknown { if (typeof value === "string") return redact(value, secrets); if (Array.isArray(value)) return value.map((item) => deepRedactValue(item, secrets)); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE_REASONING_FIELD.test(key)).map(([key, item]) => SECRET_KEY.test(key) ? [key, "[REDACTED]"] : [key, deepRedactValue(item, secrets)])); return value; }
function sensitiveReasoningValues(value: unknown): string[] { if (Array.isArray(value)) return value.flatMap(sensitiveReasoningValues); if (!value || typeof value !== "object") return []; return Object.entries(value).flatMap(([key, item]) => SENSITIVE_REASONING_FIELD.test(key) ? stringValues(item) : sensitiveReasoningValues(item)); }
function stringValues(value: unknown): string[] { if (typeof value === "string") return [value]; if (Array.isArray(value)) return value.flatMap(stringValues); if (value && typeof value === "object") return Object.values(value).flatMap(stringValues); return []; }
function allowMetadata(raw: Record<string, unknown>): Record<string, unknown> { const metadata: Record<string, unknown> = {}; for (const key of ["type", "event", "kind", "timestamp", "role", "tool", "toolName", "toolCallId", "callId", "args", "isError", "partialResult", "assistantMessageEvent", "partType"]) if (raw[key] !== undefined) metadata[key] = raw[key]; return metadata; }
function toolCallMetadata(assistant: Record<string, unknown> | undefined): Record<string, unknown> { if (!assistant) return {}; const type = String(assistant.type ?? ""); const partial = record(assistant.partial); const content = Array.isArray(partial?.content) ? partial.content : []; const call = type === "toolcall_end" ? record(assistant.toolCall) : type === "toolcall_start" ? content.map((item) => record(item)).find((item) => item?.type === "toolCall") : undefined; return { ...(assistant.contentIndex !== undefined ? { contentIndex: assistant.contentIndex } : {}), ...(call?.id !== undefined ? { toolCallId: call.id } : {}), ...(call?.name !== undefined ? { toolName: call.name } : {}), ...(call?.arguments !== undefined ? { args: call.arguments } : {}) }; }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function extractText(raw: Record<string, unknown>): string { const values = [raw.text, raw.body, raw.content, raw.message, raw.result, raw.partialResult, raw.assistantMessageEvent, raw.toolName, raw.args]; for (const value of values) { if (typeof value === "string") return value; if (Array.isArray(value)) { const text = value.map((item) => typeof item === "string" ? item : item && typeof item === "object" ? extractText(item as Record<string, unknown>) : "").filter(Boolean).join(" "); if (text) return text; } if (value && typeof value === "object") { const nested = extractText(value as Record<string, unknown>); if (nested) return nested; } } return ""; }
function tail(value: string, max: number): string { return value.length > max ? value.slice(-max) : value; }
function basename(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown"; }
function probePiVersion(cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise<string>((resolveValue, rejectValue) => {
    const child = spawn("pi", ["--version"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectValue(error); else resolveValue(stdout.trim());
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* process already exited */ }
      finish(new Error(`Pi version probe timed out after ${timeout}ms.`));
    }, timeout);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = tail(stdout + chunk.toString("utf8"), MAX_CAPTURE); });
    child.once("error", (error) => finish(new Error(`Pi is unavailable: ${error.message}. Install Pi 0.80.8 or later and ensure 'pi' is on PATH.`)));
    child.once("close", (code) => finish(code === 0 ? undefined : new Error(`Pi version probe failed with exit code ${code ?? 1}.`)));
  });
}
async function bounded<T>(value: T | Promise<T>, timeout: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(() => rejectValue(new Error(timeoutMessage)), timeout);
    void Promise.resolve(value).then((result) => { clearTimeout(timer); resolveValue(result); }, (error: unknown) => { clearTimeout(timer); rejectValue(error); });
  });
}
function processGroupGone(pid: number): boolean { try { process.kill(-pid, 0); return false; } catch { return true; } }
function piProcessExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
