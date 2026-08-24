import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { appendActivityEvent, createActivityEvent, type ActivityEvent, normalizeActivityEvent } from "../../activity/index.js";
import { getDeploymentDir } from "../../paths.js";
import { nowUtc } from "../../time.js";
import type { ApiRuntimeName } from "../../types.js";
import type { CoreExecutionHooks } from "../../deploy/control.js";

export type SessionStatus = "running" | "stopping";

export interface SessionRecord {
  id: string;
  model: string;
  status: SessionStatus;
  startedAt: string;
  deploymentId: string;
  runtime: ApiRuntimeName;
}

export type SessionEventKind = "event" | "error" | "session-id" | "end";

export interface SessionStreamEvent {
  type: SessionEventKind;
  data?: Record<string, unknown>;
  message?: string;
  sessionId?: string;
  timestamp: string;
}

export interface SessionStreamSink {
  send(event: SessionStreamEvent): void;
}

export interface SessionSpawnOptions {
  model?: string;
  prompt: string;
  sessionId?: string;
  deploymentId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: ApiRuntimeName;
}

export type SessionEventNormalizer = (raw: Record<string, unknown>, deployId: string, secrets?: string[]) => ActivityEvent;
export type SessionCommandBuilder = (opts: SessionSpawnOptions & { session: SessionRecord }) => { binary: string; args: string[] };

export interface SessionManagerOptions {
  maxSessions?: number;
  defaultModel?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  normalizer?: SessionEventNormalizer;
  now?: () => Date;
  /**
   * Milliseconds to wait after SIGTERM before escalating to SIGKILL when
   * terminating a session. Defaults to 5000 (5 seconds).
   */
  terminationTimeoutMs?: number;
  /**
   * Maximum prompt length in bytes. Prompts exceeding this limit are rejected
   * before spawn to avoid argv overflow and oversized payloads. Defaults to
   * 128KB (131072 bytes).
   */
  maxPromptLength?: number;
  /**
   * When true, binary resolution consults the {@link PA_OPENCODE_BINARY_ENV}
   * environment variable before falling back to "opencode" on PATH. When false
   * (the default), the binary is always resolved as "opencode" on PATH —
   * preserving the production behavior. See FR3/FR4.
   */
  devMode?: boolean;
  /**
   * Explicit opencode binary path to spawn. Takes precedence over
   * {@link devMode} env-var resolution. When omitted, resolution falls back
   * to {@link resolveBinary}.
   */
  binaryPath?: string;
  runtimes?: Partial<Record<ApiRuntimeName, CoreExecutionHooks>>;
  runtimeNormalizers?: Partial<Record<ApiRuntimeName, SessionEventNormalizer>>;
  runtimeCommands?: Partial<Record<ApiRuntimeName, SessionCommandBuilder>>;
  onTerminal?: (sessionId: string) => void;
  secretValues?: string[];
}

const DEFAULT_MAX_SESSIONS = 3;
const DEFAULT_MODEL = "ollama-cloud/deepseek-v4-pro";
const DEFAULT_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PROMPT_LENGTH = 128 * 1024;
const DEFAULT_BINARY = "opencode";
const DEFAULT_RUNTIME: ApiRuntimeName = "opencode";
const MAX_STREAM_CARRY = 8192;
const MAX_EVENT_BODY = 500;
const MAX_SERIALIZED_EVENT = 8192;
const MAX_STDERR = 2000;
const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;
const SECRET_TEXT = [/(?:token|secret|password|api[_-]?key|authorization)\s*(?::|=|\s)\s*\S+/gi, /bearer\s+\S+/gi, /sk-[\w-]+/gi];

/**
 * Environment variable consulted by {@link resolveBinary} when an explicit
 * binary path is not provided. In dev mode, setting this to an absolute path
 * (e.g. `PA_OPENCODE_BINARY=/usr/local/bin/opencode`) overrides the PATH
 * fallback. See FR3.
 */
export const PA_OPENCODE_BINARY_ENV = "PA_OPENCODE_BINARY";

/**
 * Resolve the opencode binary path to spawn.
 *
 * Resolution order (FR3/FR4):
 *   1. `explicitPath` — caller-supplied override (e.g. CLI flag).
 *   2. `PA_OPENCODE_BINARY` env var — when `devMode` is true.
 *   3. `"opencode"` on PATH — production default, identical to prior behavior.
 *
 * Returns the resolved command string. No PATH lookup I/O is performed —
 * Node's `spawn` resolves the PATH at spawn time, keeping this function under
 * the 1ms budget (NFR2).
 */
export function resolveBinary(opts: {
  devMode?: boolean;
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (opts.explicitPath) return opts.explicitPath;
  if (opts.devMode) {
    const env = opts.env ?? process.env;
    const override = env[PA_OPENCODE_BINARY_ENV];
    if (override && override.trim().length > 0) return override;
  }
  return DEFAULT_BINARY;
}

interface ActiveSession {
  record: SessionRecord;
  child: ChildProcess | null;
  /**
   * Streaming sinks for live SSE observation. Absent for deploy sessions
   * (registered via {@link SessionManager.register}) which have no child
   * process and therefore no stream to broadcast.
   */
  sinks?: Set<SessionStreamSink>;
  /**
   * Parses the opencode session id from the child's JSONL stdout. Absent
   * for deploy sessions (no child stdout to parse).
   */
  sessionIdParser?: { write(text: string): void; flush(): string | undefined };
  /** Accumulates incomplete stdout lines; absent for deploy sessions. */
  stdoutBuffer?: string;
  /** Accumulates incomplete stderr lines; absent for deploy sessions. */
  stderrBuffer?: string;
  terminated: boolean;
  terminateReason?: string;
  secrets?: string[];
}

function readMaxSessionsFromEnv(): number {
  const raw = process.env["PA_MAX_SESSIONS"];
  if (!raw) return DEFAULT_MAX_SESSIONS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_SESSIONS;
  return parsed;
}

export class SessionManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly maxSessions: number;
  private readonly defaultModel: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: typeof spawn;
  private readonly normalizer: SessionEventNormalizer;
  private readonly now: () => Date;
  private readonly terminationTimeoutMs: number;
  private readonly maxPromptLength: number;
  private readonly devMode: boolean;
  private readonly binaryPath: string;
  private readonly runtimes: Partial<Record<ApiRuntimeName, CoreExecutionHooks>>;
  private readonly runtimeNormalizers: Partial<Record<ApiRuntimeName, SessionEventNormalizer>>;
  private readonly runtimeCommands: Partial<Record<ApiRuntimeName, SessionCommandBuilder>>;
  private readonly nativeSessionRuntimes = new Map<string, ApiRuntimeName>();
  private readonly onTerminal?: (sessionId: string) => void;
  private readonly secretValues: string[];
  private nextId = 1;

  constructor(opts: SessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? readMaxSessionsFromEnv();
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env ?? process.env;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.normalizer = opts.normalizer ?? defaultNormalizer;
    this.now = opts.now ?? (() => new Date());
    this.terminationTimeoutMs = opts.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
    this.maxPromptLength = opts.maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH;
    this.devMode = opts.devMode ?? false;
    this.binaryPath = resolveBinary({
      devMode: this.devMode,
      explicitPath: opts.binaryPath,
      env: this.env,
    });
    this.runtimes = opts.runtimes ?? {};
    this.runtimeNormalizers = opts.runtimeNormalizers ?? {};
    this.runtimeCommands = opts.runtimeCommands ?? {};
    this.onTerminal = opts.onTerminal;
    this.secretValues = [...(opts.secretValues ?? collectSecrets(this.env))];
  }

  get limit(): number {
    return this.maxSessions;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values()).map((session) => ({ ...session.record }));
  }

  get(id: string): SessionRecord | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session.record } : undefined;
  }

  /**
   * Returns `true` if the session exists and has no child process (i.e. was
   * registered via {@link register} as a deploy session rather than spawned
   * via {@link start} / {@link resume}). Used by the stream endpoint to return
   * a distinct 404 message for deploy sessions (FR6).
   */
  isDeploySession(id: string): boolean {
    const session = this.sessions.get(id);
    return session ? session.child === null : false;
  }

  atCapacity(): boolean {
    return this.sessions.size >= this.maxSessions;
  }

  start(opts: SessionSpawnOptions, sink: SessionStreamSink): { ok: true; session: SessionRecord } | { ok: false; error: string; limit: number } {
    if (this.atCapacity()) {
      return { ok: false, error: "Max sessions reached", limit: this.maxSessions };
    }
    const promptError = this.validatePromptLength(opts.prompt);
    if (promptError) return promptError;
    return this.createSession(opts, sink);
  }

  resume(opts: Omit<SessionSpawnOptions, "sessionId"> & { sessionId: string }, sink: SessionStreamSink): { ok: true; session: SessionRecord } | { ok: false; error: string; limit: number } {
    if (this.atCapacity()) {
      return { ok: false, error: "Max sessions reached", limit: this.maxSessions };
    }
    const promptError = this.validatePromptLength(opts.prompt);
    if (promptError) return promptError;
    const knownRuntime = this.nativeSessionRuntimes.get(opts.sessionId);
    if (knownRuntime && knownRuntime !== (opts.runtime ?? DEFAULT_RUNTIME)) return { ok: false, error: `Session belongs to runtime ${knownRuntime}; resume it with '${runtimeBinary(knownRuntime)}'`, limit: this.maxSessions };
    return this.createSession(opts, sink);
  }

  /**
   * Register a deploy session without spawning a child process. Creates a
   * {@link SessionRecord} with `child: null` so deploy sessions appear in
   * `GET /api/sessions` alongside WebSocket sessions. Respects the
   * `maxSessions` limit (NFR4 — combined count). Lifecycle events are logged
   * best-effort; no I/O beyond the activity log append (NFR1).
   *
   * Deploy sessions do not allocate streaming infrastructure (`sinks`,
   * `sessionIdParser`, `stdout/stderrBuffer`) — those are only needed for
   * sessions with a live child process and would otherwise sit unused (CQ-1).
   *
   * Known limitation (CQ-3): deploy sessions have no TTL or heartbeat. They
   * persist in memory until an explicit {@link stop} / {@link disconnect} /
   * {@link cleanup} call or server restart. The {@link maxSessions} cap and
   * server restart provide the only automatic bounds. Auto-expiry would be an
   * effort-M enhancement and is intentionally out of scope for now.
   */
  register(deploymentId: string, model?: string, runtime: ApiRuntimeName = DEFAULT_RUNTIME): { ok: true; session: SessionRecord } | { ok: false; error: string; limit: number } {
    if (this.atCapacity()) {
      return { ok: false, error: "Max sessions reached", limit: this.maxSessions };
    }
    const newId = this.allocateId();
    const resolvedModel = model ?? this.defaultModel;
    const record: SessionRecord = {
      id: newId,
      model: resolvedModel,
      status: "running",
      startedAt: nowUtc(this.now()),
      deploymentId,
      runtime,
    };
    const session: ActiveSession = {
      record,
      child: null,
      terminated: false,
    };
    this.sessions.set(newId, session);
    this.logLifecycle(session, "session_started");
    return { ok: true, session: { ...record } };
  }

  private createSession(opts: SessionSpawnOptions & { sessionId?: string }, sink: SessionStreamSink): { ok: true; session: SessionRecord } | { ok: false; error: string; limit: number } {
    const newId = this.allocateId();
    const model = opts.model ?? this.defaultModel;
    const deploymentId = opts.deploymentId ?? `session-${newId}`;
    const record: SessionRecord = {
      id: newId,
      model,
      status: "running",
      startedAt: nowUtc(this.now()),
      deploymentId,
      runtime: opts.runtime ?? DEFAULT_RUNTIME,
    };
    const session: ActiveSession = {
      record,
      child: null,
      sinks: new Set<SessionStreamSink>([sink]),
      sessionIdParser: createSessionIdParser(),
      stdoutBuffer: "",
      stderrBuffer: "",
      terminated: false,
      secrets: [...new Set([...this.secretValues, ...collectSecrets({ ...this.env, ...opts.env })])],
    };
    this.sessions.set(newId, session);
    this.logLifecycle(session, "session_started");
    try {
      const runtime = opts.runtime ?? DEFAULT_RUNTIME;
      if (runtime !== DEFAULT_RUNTIME && !this.runtimes[runtime]) {
        this.sessions.delete(newId);
        return { ok: false, error: `No adapter registered for runtime ${runtime}`, limit: this.maxSessions };
      }
      const nativeSessionId = opts.sessionId ?? (record.runtime === "pi" ? record.id : undefined);
      if (nativeSessionId && isBoundedNativeSessionId(nativeSessionId)) this.nativeSessionRuntimes.set(nativeSessionId, record.runtime);
      this.spawnOpencode(session, opts);
    } catch (error) {
      const nativeSessionId = opts.sessionId ?? (record.runtime === "pi" ? record.id : undefined);
      if (nativeSessionId) this.nativeSessionRuntimes.delete(nativeSessionId);
      this.sessions.delete(newId);
      const rawMessage = error instanceof Error ? error.message : String(error);
      const isEnoent = error instanceof Error && (error as Error & { code?: string }).code === "ENOENT";
      const message = isEnoent
        ? `opencode binary not found at "${this.binaryPath}" (ENOENT). Set PA_OPENCODE_BINARY or ensure opencode is on PATH.`
        : `Failed to spawn opencode: ${rawMessage}`;
      this.logLifecycle(session, "session_spawn_error", message);
      return { ok: false, error: message, limit: this.maxSessions };
    }
    return { ok: true, session: { ...record } };
  }

  private validatePromptLength(prompt: string): { ok: false; error: string; limit: number } | undefined {
    if (Buffer.byteLength(prompt, "utf-8") > this.maxPromptLength) {
      return { ok: false, error: `Prompt exceeds maximum length (${this.maxPromptLength} bytes)`, limit: this.maxSessions };
    }
    return undefined;
  }

  /**
   * Attach an additional read-only sink to an existing session so a client
   * can observe the live JSONL stream (e.g. via the SSE endpoint). Returns
   * an unsubscribe function, or `undefined` if the session does not exist.
   */
  subscribe(id: string, sink: SessionStreamSink): (() => void) | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    // Deploy sessions (registered, not spawned) have no streaming sinks and
    // cannot be observed live — return undefined so callers can 404 (FR6).
    if (!session.sinks) return undefined;
    session.sinks.add(sink);
    return () => {
      session.sinks?.delete(sink);
    };
  }

  stop(id: string): { ok: true; status: "stopped" } | { ok: false; error: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "Session not found" };
    this.terminate(session, "stopped");
    this.sessions.delete(id);
    return { ok: true, status: "stopped" };
  }

  disconnect(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.terminate(session, "disconnect");
    this.sessions.delete(id);
  }

  cleanup(): void {
    for (const [, session] of this.sessions) {
      this.terminate(session, "cleanup");
    }
    this.sessions.clear();
  }

  private allocateId(): string {
    const id = `s${Date.now().toString(36)}-${this.nextId.toString(36)}`;
    this.nextId += 1;
    return id;
  }

  private spawnOpencode(session: ActiveSession, opts: SessionSpawnOptions): void {
    const runtime = opts.runtime ?? DEFAULT_RUNTIME;
    const command = this.runtimeCommands[runtime]?.({ ...opts, session: session.record }) ?? defaultSessionCommand(runtime, this.binaryPath, opts, session.record);
    const { binary, args } = command;
    const child = this.spawnFn(binary, args, {
      cwd: opts.cwd ?? this.cwd,
      env: { ...this.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.handleStdout(session, chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.handleStderr(session, chunk));
    child.on("error", (error: Error & { code?: string }) => this.handleError(session, error));
    child.on("close", (code: number | null) => this.handleClose(session, code));
  }

  private handleStdout(session: ActiveSession, chunk: Buffer): void {
    if (session.terminated) return;
    const text = chunk.toString("utf-8");
    session.stdoutBuffer = tail((session.stdoutBuffer ?? "") + text, MAX_STREAM_CARRY);
    const lines = session.stdoutBuffer.split("\n");
    session.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) this.processLine(session, line);
  }

  private handleStderr(session: ActiveSession, chunk: Buffer): void {
    if (session.terminated) return;
    const text = chunk.toString("utf-8");
    session.stderrBuffer = tail(redact((session.stderrBuffer ?? "") + text, this.sessionSecrets(session)), MAX_STDERR);
    const lines = session.stderrBuffer.split("\n");
    session.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) this.processLine(session, line);
  }

  private processLine(session: ActiveSession, line: string): void {
    if (!line.trim()) return;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emitEvent(session, { type: "event", data: { kind: "text", body: redact(line, this.sessionSecrets(session)).slice(0, MAX_EVENT_BODY) } });
      return;
    }
    session.sessionIdParser?.write(line);
    try {
      const normalizer = this.runtimeNormalizers[session.record.runtime] ?? this.normalizer;
      const event = normalizer(raw, session.record.deploymentId, this.sessionSecrets(session));
      event.body = redact(event.body, this.sessionSecrets(session)).slice(0, MAX_EVENT_BODY);
      this.emitEvent(session, { type: "event", data: activityEventToData(event) });
    } catch {
      this.emitEvent(session, { type: "event", data: boundedRecord(raw, this.sessionSecrets(session)) });
    }
  }

  private handleError(session: ActiveSession, error: Error & { code?: string }): void {
    if (session.terminated) return;
    const message = isEnoentError(error)
      ? session.record.runtime === "opencode"
        ? `opencode binary not found at "${this.binaryPath}" (ENOENT). Set PA_OPENCODE_BINARY or ensure opencode is on PATH.`
        : `${session.record.runtime} binary not found (ENOENT). Ensure ${session.record.runtime} is on PATH.`
      : error.message;
    this.emitEvent(session, { type: "error", message });
    this.logLifecycle(session, "session_error", message);
    this.finalize(session);
  }

  private handleClose(session: ActiveSession, code: number | null): void {
    if (session.stdoutBuffer?.trim()) this.processLine(session, session.stdoutBuffer);
    if (session.stderrBuffer?.trim()) this.processLine(session, session.stderrBuffer);
    session.stdoutBuffer = "";
    session.stderrBuffer = "";
    const nativeSessionId = session.sessionIdParser?.flush();
    if (nativeSessionId && isBoundedNativeSessionId(nativeSessionId)) this.nativeSessionRuntimes.set(nativeSessionId, session.record.runtime);
    if (session.terminated) return;
    this.emitEvent(session, { type: "end", data: { exitCode: code ?? 0, ...(session.terminateReason ? { reason: session.terminateReason } : {}) } });
    this.logLifecycle(session, "session_ended", `exitCode=${code ?? 0}`);
    this.finalize(session);
  }

  private sessionSecrets(session: ActiveSession): string[] {
    return session.secrets ?? this.secretValues;
  }

  private finalize(session: ActiveSession): void {
    if (this.sessions.get(session.record.id) !== session) return;
    this.sessions.delete(session.record.id);
    session.sinks?.clear();
    this.onTerminal?.(session.record.id);
  }

  private emitEvent(session: ActiveSession, event: Omit<SessionStreamEvent, "timestamp">): void {
    const full: SessionStreamEvent = { ...event, timestamp: nowUtc(this.now()) };
    const sinks = session.sinks;
    if (!sinks) return;
    for (const sink of sinks) {
      try {
        sink.send(full);
      } catch {
        // Sink may be closed; ignore. Keep broadcasting to remaining sinks.
      }
    }
  }

  private terminate(session: ActiveSession, reason: string): void {
    if (session.terminated) return;
    session.terminated = true;
    session.terminateReason = reason;
    session.record.status = "stopping";
    this.logLifecycle(session, "session_stopping", reason);
    const child = session.child;
    if (!child || child.exitCode !== null || child.killed) {
      this.emitEvent(session, { type: "end", data: { reason } });
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, this.terminationTimeoutMs);
    timer.unref?.();
  }

  private logLifecycle(session: ActiveSession, event: string, detail?: string): void {
    try {
      const activityEvent = createActivityEvent({
        deployId: session.record.deploymentId,
        kind: "text",
        source: "session-hub",
        body: detail ? `${event}: ${detail}` : event,
        metadata: { event, sessionId: session.record.id, model: session.record.model, ...(detail ? { detail } : {}) },
      });
      appendActivityEvent(activityEvent, resolve(getDeploymentDir(session.record.deploymentId), "activity.jsonl"));
    } catch {
      // Logging is best-effort; never let it crash session lifecycle.
    }
  }
}

function defaultSessionCommand(runtime: ApiRuntimeName, opencodeBinary: string, opts: SessionSpawnOptions, session: SessionRecord): { binary: string; args: string[] } {
  const args = runtime === "opencode"
    ? ["run", "-m", opts.model ?? session.model, "--dangerously-skip-permissions"]
    : ["--print", "--mode", "json"];
  if (opts.sessionId) args.push(runtime === "opencode" ? "--session" : "--session-id", opts.sessionId);
  if (runtime === "opencode") args.push("--format", "json");
  args.push(opts.prompt);
  return { binary: runtime === "opencode" ? opencodeBinary : runtime, args };
}

function isEnoentError(error: Error & { code?: string }): boolean {
  return error.code === "ENOENT";
}

function isBoundedNativeSessionId(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function runtimeBinary(runtime: ApiRuntimeName): string {
  return runtime === "pi" ? "ppa" : runtime === "opencode" ? "opa" : runtime;
}

function activityEventToData(event: ActivityEvent): Record<string, unknown> {
  return {
    deployId: event.deployId,
    kind: event.kind,
    source: event.source,
    body: event.body,
    partType: event.partType,
    metadata: event.metadata,
  };
}

function defaultNormalizer(raw: Record<string, unknown>, deployId: string): ActivityEvent {
  const withDeployId = { ...raw, deployId: raw["deployId"] ?? raw["deploy_id"] ?? deployId };
  return normalizeActivityEvent(withDeployId);
}

function createSessionIdParser(): { write(text: string): void; flush(): string | undefined } {
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

function parseSessionIdLine(line: string): string | undefined {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const session = raw["sessionID"] ?? raw["sessionId"] ?? raw["session_id"] ?? raw["id"];
    if (typeof session === "string" && session.length > 0) return session;
  } catch {
    const match = line.match(/session(?:ID|Id|_id)?["':=\s]+([a-zA-Z0-9_-]+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function collectSecrets(env: NodeJS.ProcessEnv | undefined): string[] {
  if (!env) return [];
  return Object.entries(env).filter(([key, value]) => SECRET_KEY.test(key) && value !== undefined && value.length >= 8).map(([, value]) => value as string);
}

function redact(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  for (const pattern of SECRET_TEXT) result = result.replace(pattern, "[REDACTED]");
  return result;
}

function boundedRecord(value: Record<string, unknown>, secrets: string[]): Record<string, unknown> {
  const boundedValue = (item: unknown): unknown => {
    if (typeof item === "string") {
      const safe = redact(item, secrets);
      return safe.length > MAX_EVENT_BODY ? `${safe.slice(0, MAX_EVENT_BODY - 3)}...` : safe;
    }
    if (Array.isArray(item)) return item.map(boundedValue);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : boundedValue(child)]));
    return item;
  };
  const bounded = boundedValue(value) as Record<string, unknown>;
  if (JSON.stringify(bounded).length <= MAX_SERIALIZED_EVENT) return bounded;
  const serialized = JSON.stringify(bounded);
  return { kind: "text", body: `${serialized.slice(0, MAX_EVENT_BODY - 3)}...` };
}

function tail(value: string, max: number): string { return value.length > max ? value.slice(-max) : value; }
