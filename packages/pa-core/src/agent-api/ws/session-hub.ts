import { spawn, type ChildProcess } from "node:child_process";
import { type ActivityEvent, normalizeActivityEvent } from "../../activity/index.js";
import { nowUtc } from "../../time.js";

export type SessionStatus = "running" | "stopping";

export interface SessionRecord {
  id: string;
  model: string;
  status: SessionStatus;
  startedAt: string;
  deploymentId: string;
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
}

export type SessionEventNormalizer = (raw: Record<string, unknown>, deployId: string) => ActivityEvent;

export interface SessionManagerOptions {
  maxSessions?: number;
  defaultModel?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  normalizer?: SessionEventNormalizer;
  now?: () => Date;
}

const DEFAULT_MAX_SESSIONS = 3;
const DEFAULT_MODEL = "ollama-cloud/deepseek-v4-pro";
const TERMINATION_TIMEOUT_MS = 5_000;

interface ActiveSession {
  record: SessionRecord;
  child: ChildProcess;
  sinks: Set<SessionStreamSink>;
  sessionIdParser: { write(text: string): void; flush(): string | undefined };
  stdoutBuffer: string;
  stderrBuffer: string;
  terminated: boolean;
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
  private nextId = 1;

  constructor(opts: SessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? readMaxSessionsFromEnv();
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env ?? process.env;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.normalizer = opts.normalizer ?? defaultNormalizer;
    this.now = opts.now ?? (() => new Date());
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

  atCapacity(): boolean {
    return this.sessions.size >= this.maxSessions;
  }

  start(opts: SessionSpawnOptions, sink: SessionStreamSink): { ok: true; session: SessionRecord } | { ok: false; error: string; limit: number } {
    if (this.atCapacity()) {
      return { ok: false, error: "Max sessions reached", limit: this.maxSessions };
    }
    const id = this.allocateId();
    const model = opts.model ?? this.defaultModel;
    const deploymentId = opts.deploymentId ?? `session-${id}`;
    const record: SessionRecord = {
      id,
      model,
      status: "running",
      startedAt: nowUtc(this.now()),
      deploymentId,
    };
    const session: ActiveSession = {
      record,
      child: null as unknown as ChildProcess,
      sinks: new Set<SessionStreamSink>([sink]),
      sessionIdParser: createSessionIdParser(),
      stdoutBuffer: "",
      stderrBuffer: "",
      terminated: false,
    };
    this.sessions.set(id, session);
    try {
      this.spawnOpencode(session, opts);
    } catch (error) {
      this.sessions.delete(id);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Failed to spawn opencode: ${message}`, limit: this.maxSessions };
    }
    return { ok: true, session: { ...record } };
  }

  resume(opts: Omit<SessionSpawnOptions, "sessionId"> & { sessionId: string }, sink: SessionStreamSink): { ok: true; session: SessionRecord } | { ok: false; error: string; limit: number } {
    if (this.atCapacity()) {
      return { ok: false, error: "Max sessions reached", limit: this.maxSessions };
    }
    const newId = this.allocateId();
    const model = opts.model ?? this.defaultModel;
    const deploymentId = opts.deploymentId ?? `session-${newId}`;
    const record: SessionRecord = {
      id: newId,
      model,
      status: "running",
      startedAt: nowUtc(this.now()),
      deploymentId,
    };
    const session: ActiveSession = {
      record,
      child: null as unknown as ChildProcess,
      sinks: new Set<SessionStreamSink>([sink]),
      sessionIdParser: createSessionIdParser(),
      stdoutBuffer: "",
      stderrBuffer: "",
      terminated: false,
    };
    this.sessions.set(newId, session);
    try {
      this.spawnOpencode(session, opts);
    } catch (error) {
      this.sessions.delete(newId);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Failed to spawn opencode: ${message}`, limit: this.maxSessions };
    }
    return { ok: true, session: { ...record } };
  }

  /**
   * Attach an additional read-only sink to an existing session so a client
   * can observe the live JSONL stream (e.g. via the SSE endpoint). Returns
   * an unsubscribe function, or `undefined` if the session does not exist.
   */
  subscribe(id: string, sink: SessionStreamSink): (() => void) | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.sinks.add(sink);
    return () => {
      session.sinks.delete(sink);
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
    const args = ["run", "-m", opts.model ?? session.record.model, "--dangerously-skip-permissions"];
    if (opts.sessionId) args.push("--session", opts.sessionId);
    args.push("--format", "json");
    args.push(opts.prompt);
    const child = this.spawnFn("opencode", args, {
      cwd: opts.cwd ?? this.cwd,
      env: { ...this.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.handleStdout(session, chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.handleStderr(session, chunk));
    child.on("error", (error: Error) => this.handleError(session, error));
    child.on("close", (code: number | null) => this.handleClose(session, code));
  }

  private handleStdout(session: ActiveSession, chunk: Buffer): void {
    if (session.terminated) return;
    const text = chunk.toString("utf-8");
    session.stdoutBuffer += text;
    const lines = session.stdoutBuffer.split("\n");
    session.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) this.processLine(session, line);
  }

  private handleStderr(session: ActiveSession, chunk: Buffer): void {
    if (session.terminated) return;
    const text = chunk.toString("utf-8");
    session.stderrBuffer += text;
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
      this.emitEvent(session, { type: "event", data: { kind: "text", body: line } });
      return;
    }
    session.sessionIdParser.write(line);
    try {
      const event = this.normalizer(raw, session.record.deploymentId);
      this.emitEvent(session, { type: "event", data: activityEventToData(event) });
    } catch {
      this.emitEvent(session, { type: "event", data: raw });
    }
  }

  private handleError(session: ActiveSession, error: Error): void {
    if (session.terminated) return;
    this.emitEvent(session, { type: "error", message: error.message });
  }

  private handleClose(session: ActiveSession, code: number | null): void {
    session.sessionIdParser.flush();
    if (session.terminated) return;
    this.emitEvent(session, { type: "end", data: { exitCode: code ?? 0 } });
  }

  private emitEvent(session: ActiveSession, event: Omit<SessionStreamEvent, "timestamp">): void {
    const full: SessionStreamEvent = { ...event, timestamp: nowUtc(this.now()) };
    for (const sink of session.sinks) {
      try {
        sink.send(full);
      } catch {
        // Sink may be closed; ignore. Keep broadcasting to remaining sinks.
      }
    }
  }

  private terminate(session: ActiveSession, _reason: string): void {
    if (session.terminated) return;
    session.terminated = true;
    session.record.status = "stopping";
    const child = session.child;
    if (!child || child.exitCode !== null || child.killed) {
      session.record.status = "stopping";
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
    }, TERMINATION_TIMEOUT_MS);
    timer.unref?.();
  }
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