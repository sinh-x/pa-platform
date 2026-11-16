import { lstatSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { PiExtensionModule, PiRuntime, PiSessionLifecycle } from "./index.js";

/** Trusted lifecycle bridge for the selected Herdr integration. It speaks the
 * finite local protocol the installed `herdr-agent-state` integration (v9) uses:
 * one newline-delimited JSON request per unix-socket connection, methods
 * `pane.report_agent_session` and `pane.report_agent`. It never submits prompts,
 * never reads socket replies into model context and never retries. Peer
 * messaging stays unavailable: no protected, request-correlated submission path
 * has been proven. */
export const HERDR_SOURCE = "herdr:pi";
export const HERDR_SELECTION_ENV = "PA_HERDR_LIFECYCLE";
export const HERDR_REQUEST_LIMIT_BYTES = 4096;
export const HERDR_LABEL_LIMIT = 200;

const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SESSION_REF = /^[^\u0000-\u001f\u007f]{1,1024}$/;

export type HerdrAgentState = "working" | "blocked" | "idle";

export interface HerdrBinding { readonly socketPath: string; readonly paneId: string }
export interface HerdrSessionRef { readonly sessionId?: string; readonly sessionPath?: string; readonly reason?: string }

/** Selection is explicit (`PA_HERDR_LIFECYCLE=1`) and requires the complete
 * Herdr binding plus a real, same-user (or root) unix socket. Nothing here is
 * accepted from model input; a partial, aliased or non-socket path disables the
 * bridge instead of guessing. */
export function resolveHerdrBinding(env: NodeJS.ProcessEnv, uid: number | undefined = process.getuid?.()): HerdrBinding | undefined {
  if (env[HERDR_SELECTION_ENV] !== "1" || env["HERDR_ENV"] !== "1") return undefined;
  const socketPath = env["HERDR_SOCKET_PATH"]?.trim(), paneId = env["HERDR_PANE_ID"]?.trim();
  if (!socketPath || !paneId || !isAbsolute(socketPath) || socketPath.length > 4096 || socketPath.includes("\u0000")) return undefined;
  if (!PANE_ID.test(paneId)) return undefined;
  try {
    if (realpathSync(socketPath) !== socketPath) return undefined;
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) return undefined;
    if (uid !== undefined && stat.uid !== uid && stat.uid !== 0) return undefined;
  } catch { return undefined; }
  return { socketPath, paneId };
}

const sessionText = (value: unknown): string | undefined => typeof value === "string" && SESSION_REF.test(value) ? value : undefined;
const printable = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, HERDR_LABEL_LIMIT) : undefined;
};

/** Bounded payload builder. Oversized or unprintable input is dropped rather
 * than truncated into a different claim; the fixed size bound is enforced on the
 * encoded bytes, not on character count. */
export function herdrRequest(method: "pane.report_agent_session" | "pane.report_agent", params: Record<string, unknown>): string {
  const payload = `${JSON.stringify({ id: `${HERDR_SOURCE}:${Date.now()}:${randomUUID()}`, method, params })}\n`;
  if (Buffer.byteLength(payload) > HERDR_REQUEST_LIMIT_BYTES) throw new Error("Herdr lifecycle payload exceeds its bounded size.");
  return payload;
}

export function herdrSessionParams(binding: HerdrBinding, session: HerdrSessionRef, seq: number): Record<string, unknown> {
  const sessionId = sessionText(session.sessionId), sessionPath = sessionText(session.sessionPath), startSource = printable(session.reason);
  return {
    pane_id: binding.paneId, source: HERDR_SOURCE, agent: "pi", seq,
    ...(startSource ? { session_start_source: startSource } : {}),
    ...(sessionPath ? { agent_session_path: sessionPath } : sessionId ? { agent_session_id: sessionId } : {}),
  };
}

export function herdrStateParams(binding: HerdrBinding, state: HerdrAgentState, seq: number, message?: string, session: HerdrSessionRef = {}): Record<string, unknown> {
  const label = state === "blocked" ? printable(message) ?? "blocked" : undefined;
  const sessionId = sessionText(session.sessionId), sessionPath = sessionText(session.sessionPath);
  return {
    pane_id: binding.paneId, source: HERDR_SOURCE, agent: "pi", state, seq,
    ...(label ? { message: label } : {}),
    ...(sessionPath ? { agent_session_path: sessionPath } : {}),
    ...(sessionPath || !sessionId ? {} : { agent_session_id: sessionId }),
  };
}

export interface HerdrSocket { on(event: string, listener: (...args: unknown[]) => void): unknown; write(value: string): unknown; destroy(): void }
export interface HerdrReporter { session(session: HerdrSessionRef): void; state(state: HerdrAgentState, message?: string): void; close(): void }
export interface HerdrReporterOptions { readonly open?: (socketPath: string) => HerdrSocket; readonly timeoutMs?: number }

/** One bounded attempt per payload with a latest-wins queue: intermediate states
 * are dropped, a failure is silent (lifecycle reporting is advisory) and every
 * owned socket is destroyed. No reply bytes are retained. */
export function createHerdrReporter(binding: HerdrBinding, options: HerdrReporterOptions = {}): HerdrReporter {
  const open = options.open ?? (socketPath => connect(socketPath) as unknown as HerdrSocket);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 750, 100), 2000);
  let seq = Date.now() * 1000, closed = false, sending = false;
  let sessionSlot: string | undefined, stateSlot: string | undefined, active: HerdrSocket | undefined, sessionRef: HerdrSessionRef = {};
  const nextSeq = () => ++seq;
  const drain = () => {
    if (closed || sending) return;
    const payload = sessionSlot ?? stateSlot;
    if (!payload) return;
    if (sessionSlot) sessionSlot = undefined; else stateSlot = undefined;
    sending = true;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (active) { try { active.destroy(); } catch { /* owned socket already gone */ } active = undefined; }
      sending = false;
      drain();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    try {
      const socket = open(binding.socketPath);
      active = socket;
      socket.on("error", finish);
      socket.on("end", finish);
      socket.on("data", finish);
      socket.on("connect", () => { try { socket.write(payload); } catch { finish(); } });
    } catch { finish(); }
  };
  return {
    session(session) {
      if (closed) return;
      sessionRef = session;
      try { sessionSlot = herdrRequest("pane.report_agent_session", herdrSessionParams(binding, session, nextSeq())); } catch { sessionSlot = undefined; }
      drain();
    },
    state(state, message) {
      if (closed) return;
      try { stateSlot = herdrRequest("pane.report_agent", herdrStateParams(binding, state, nextSeq(), message, sessionRef)); } catch { stateSlot = undefined; }
      drain();
    },
    close() {
      closed = true; sessionSlot = undefined; stateSlot = undefined;
      if (active) { try { active.destroy(); } catch { /* owned socket already gone */ } active = undefined; }
    },
  };
}

interface HerdrContext { mode?: unknown; isIdle?: () => unknown; sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown } }
const contextRef = (context: unknown): HerdrSessionRef => {
  if (!context || typeof context !== "object") return {};
  const ctx = context as HerdrContext;
  const read = (value: () => unknown): string | undefined => { try { const result = value(); return typeof result === "string" ? result : undefined; } catch { return undefined; } };
  const manager = ctx.sessionManager;
  return {
    ...(manager?.getSessionId ? { sessionId: read(() => manager.getSessionId?.()) } : {}),
    ...(manager?.getSessionFile ? { sessionPath: read(() => manager.getSessionFile?.()) } : {}),
  };
};

/** Registers only under explicit selection and a validated binding. The TUI-only
 * gate matches the installed integration: headless/RPC runs have no pane to
 * display state for. `herdr:blocked` remains compatible with the selected
 * integration's event contract; nothing here creates peer or prompt authority. */
export const registerHerdrLifecycleModule: PiExtensionModule = (pi: PiRuntime, lifecycle?: PiSessionLifecycle) => {
  const binding = resolveHerdrBinding(process.env);
  if (!binding) return;
  const reporter = createHerdrReporter(binding);
  lifecycle?.addShutdownStep(() => { reporter.close(); });
  let root = false, active = false, blocked = 0, blockedMessage: string | undefined, session: HerdrSessionRef = {};
  const publish = () => reporter.state(blocked > 0 ? "blocked" : active ? "working" : "idle", blocked > 0 ? blockedMessage : undefined);
  pi.on?.("session_start", (event, context) => {
    if ((context as HerdrContext | undefined)?.mode !== "tui") return;
    root = true;
    session = { ...contextRef(context), ...(printable((event as { reason?: unknown } | undefined)?.reason) ? { reason: printable((event as { reason?: unknown } | undefined)?.reason) } : {}) };
    reporter.session(session);
    active = (context as HerdrContext | undefined)?.isIdle?.() === false;
    publish();
  });
  pi.on?.("agent_start", (_event, context) => {
    if (!root) return;
    session = { ...session, ...contextRef(context) };
    reporter.session(session);
    active = true;
    publish();
  });
  pi.on?.("agent_settled", (_event, context) => {
    if (!root || (context as HerdrContext | undefined)?.isIdle?.() !== true) return;
    active = false;
    publish();
  });
  const events = (pi as PiRuntime & { events?: { on?: (name: string, handler: (data: unknown) => void) => unknown } }).events;
  events?.on?.("herdr:blocked", data => {
    if (!root) return;
    const detail = data as { active?: unknown; label?: unknown } | undefined;
    if (detail?.active === false) {
      blocked = Math.max(0, blocked - 1);
      if (blocked === 0) blockedMessage = undefined;
    } else {
      blocked += 1;
      blockedMessage = printable(detail?.label) ?? "blocked";
    }
    publish();
  });
};
