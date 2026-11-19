import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HERDR_REQUEST_LIMIT_BYTES, HERDR_SOURCE, resolveHerdrBinding } from "./pi-extension/herdr-lifecycle.js";

export const HERDR_EXIT_BUDGET_MS = 500;
const FRAME_LIMIT = 1024 * 1024; // Herdr protocol 22's existing initial-frame bound.
const RESPONSE_LIMIT = 64 * 1024;
const QUEUE_LIMIT = 32;
export type HerdrChildDeathEvidence = "pty-exit" | "confirmed-process-gone";
export interface HerdrExitCleanupResult {
  readonly status: "verified-absent" | "acknowledged" | "skipped" | "unconfirmed";
  readonly reason?: "not-reported" | "foreign-registration" | "report-uncertain" | "timeout" | "socket-error" | "invalid-response" | "rejected" | "still-listed" | "sequence-exhausted";
  readonly submitted: boolean;
  readonly requestId?: string;
  /** Native launch incarnation, not a conversation ID or a permission token. */
  readonly source: string;
  readonly elapsedMs: number;
  readonly deathEvidence: HerdrChildDeathEvidence;
}
type CleanupObservation = Omit<HerdrExitCleanupResult, "elapsedMs">;

/** Advisory activity text only; never formats raw replies or changes exit status. */
export function herdrExitCleanupMessage(result: Pick<HerdrExitCleanupResult, "status">): string {
  switch (result.status) {
    case "verified-absent": return "Pi exited and its Herdr entry is absent. No action is required.";
    case "acknowledged": return "Pi exited. Herdr handled the cleanup request, but entry removal is not verified. Inspect the existing session before requesting cleanup again.";
    case "skipped": return "Pi exited without reported managed Herdr state, so no cleanup was submitted. If an entry remains, inspect that existing session before requesting cleanup.";
    case "unconfirmed": return "Pi exited, but Herdr cleanup is unconfirmed. Preserve the original request and inspect its outcome before requesting another cleanup.";
  }
}
export interface HerdrExitCleanup {
  readonly environment: NodeJS.ProcessEnv;
  afterVerifiedExit(evidence: HerdrChildDeathEvidence): Promise<HerdrExitCleanupResult>;
  dispose(): void;
}
type Json = Record<string, unknown>;
type Session = { kind: "path" | "id"; value: string };
type Reply = { kind: "reply"; body: Json } | { kind: "timeout" | "socket-error" | "invalid-response" };
const object = (value: unknown): Json | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const sessionRef = (params: Json): Session | undefined => {
  const path = params.agent_session_path, id = params.agent_session_id;
  const text = (value: unknown): value is string => typeof value === "string" && /^[^\u0000-\u001f\u007f]{1,1024}$/.test(value);
  return text(path) && isAbsolute(path) ? { kind: "path", value: path } : text(id) ? { kind: "id", value: id } : undefined;
};
const resumeArgv = (session: Session | undefined): string[] | undefined => session
  && !session.value.includes("'") && !session.value.startsWith("-") ? ["pi", "--session", session.value] : undefined;

/** Launch-owned in-process relay, not a second reporter or a model socket tool.
 * Bind the child's reports to one managed source incarnation. Official Pi's
 * source is process-detection gated and its release is ignored; custom sources
 * support both PPA's hidden PTY and atomic source-qualified release. Capture
 * exact lifecycle sequences and serialize reports with supervisor teardown.
 * Other existing Herdr API traffic passes unchanged
 * to the ORIGINAL socket, preserving CLI/tools/subscriptions and their authority.
 * No payload/reply is logged or published. No retry is introduced here.
 *
 * Foreground ownership provides the normal same-shell ordering. A submitted
 * release with no acknowledgement remains uncertain, never verified disappearance.
 */
export async function createHerdrExitCleanup(env: NodeJS.ProcessEnv): Promise<HerdrExitCleanup | undefined> {
  if (env.PA_HERDR_LIFECYCLE === "0") return undefined;
  const binding = resolveHerdrBinding({ ...env, PA_HERDR_LIFECYCLE: "1" });
  if (!binding) return undefined;
  let root: string, originalSocket: ReturnType<typeof lstatSync>;
  try {
    originalSocket = lstatSync(binding.socketPath);
    root = mkdtempSync(join(tmpdir(), "ppa-herdr-")); chmodSync(root, 0o700);
  } catch { return undefined; }
  const sameSocket = (): boolean => {
    try {
      const current = lstatSync(binding.socketPath);
      return current.isSocket() && current.dev === originalSocket.dev && current.ino === originalSocket.ino && current.ctimeMs === originalSocket.ctimeMs;
    } catch { return false; }
  };
  const endpoint = join(root, "h.sock"), managedSource = `ppa:pi:${randomUUID()}`;
  const clients = new Set<Socket>(), upstreams = new Set<Socket>();
  let closing = false, disposed = false, uncertainReport = false, maxSeq = -1;
  let ownedSession: Session | undefined, stateReported = false, active: Promise<void> | undefined;
  let completion: Promise<HerdrExitCleanupResult> | undefined;
  const queue: Array<{ client: Socket; body: Json; id: string; seq: number; session?: Session }> = [];

  const rpc = (frame: string, id: string, deadline: number, onSubmit?: () => void): Promise<Reply> => new Promise(resolve => {
    if (disposed || !sameSocket()) { resolve({ kind: "socket-error" }); return; }
    let done = false, carry = Buffer.alloc(0);
    const socket = connect(binding.socketPath); upstreams.add(socket);
    const finish = (reply: Reply): void => {
      if (done) return;
      done = true; clearTimeout(timer); upstreams.delete(socket); socket.destroy(); resolve(reply);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, deadline - performance.now()));
    socket.on("error", () => finish({ kind: "socket-error" }));
    socket.on("close", () => finish({ kind: "socket-error" }));
    socket.on("end", () => finish({ kind: "invalid-response" }));
    socket.on("connect", () => {
      if (done || disposed || performance.now() >= deadline) { finish({ kind: "timeout" }); return; }
      if (!sameSocket()) { finish({ kind: "socket-error" }); return; }
      try { onSubmit?.(); socket.write(frame); } catch { finish({ kind: "socket-error" }); }
    });
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      if (carry.length + chunk.length > RESPONSE_LIMIT) { finish({ kind: "invalid-response" }); return; }
      carry = Buffer.concat([carry, chunk]);
      const newline = carry.indexOf(10); if (newline < 0) return;
      try {
        const body = object(JSON.parse(carry.subarray(0, newline).toString("utf8")));
        if (!body || body.id !== id || (!object(body.result) && !object(body.error))) throw new Error();
        finish({ kind: "reply", body });
      } catch { finish({ kind: "invalid-response" }); }
    });
  });
  const request = (method: string, params: Json, deadline: number, onSubmit?: (id: string) => void): Promise<Reply> => {
    const id = `ppa-herdr:${randomUUID()}`;
    return rpc(`${JSON.stringify({ id, method, params })}\n`, id, deadline, () => onSubmit?.(id));
  };
  const respond = (client: Socket, id: string, code: string): void => {
    if (!client.destroyed) client.end(`${JSON.stringify({ id, error: { code, message: "Herdr lifecycle delivery is unconfirmed." } })}\n`);
  };
  const drain = (): void => {
    if (closing || active || !queue.length) return;
    const next = queue.shift()!;
    const newer = next.seq > maxSeq;
    if (newer && next.session) ownedSession = next.session;
    const params: Json = { ...object(next.body.params)!, source: managedSource };
    // Herdr does not infer session metadata/resume for custom sources. Preserve
    // its existing native Pi resume command through the supported state field.
    // Never let a stale report overwrite the current reported resume command.
    delete params.resume_argv;
    const stateReport = next.body.method === "pane.report_agent";
    const resume = newer && stateReport ? resumeArgv(ownedSession) : undefined;
    if (resume) params.resume_argv = resume;
    let frame = `${JSON.stringify({ ...next.body, params })}\n`;
    if (Buffer.byteLength(frame) > HERDR_REQUEST_LIMIT_BYTES && resume) {
      delete params.resume_argv; frame = `${JSON.stringify({ ...next.body, params })}\n`;
    }
    if (Buffer.byteLength(frame) > HERDR_REQUEST_LIMIT_BYTES) { respond(next.client, next.id, "invalid_lifecycle_report"); drain(); return; }
    // Mark before submission; a failed response never permits a later release.
    maxSeq = Math.max(maxSeq, next.seq);
    active = (async () => {
      const reply = await rpc(frame, next.id, performance.now() + 750);
      if (reply.kind !== "reply" || object(reply.body.error)) uncertainReport = true;
      else if (stateReport) stateReported = true;
      if (!next.client.destroyed) {
        if (reply.kind === "reply") next.client.end(`${JSON.stringify(reply.body)}\n`);
        else respond(next.client, next.id, "delivery_unconfirmed");
      }
    })().finally(() => { active = undefined; drain(); });
  };
  const server = createServer({ allowHalfOpen: true }, client => {
    if (closing || clients.size >= 64) { client.destroy(); return; }
    clients.add(client); client.on("error", () => client.destroy()); client.on("close", () => clients.delete(client));
    // Half-written local requests must not keep the supervisor alive forever.
    client.setTimeout(2_000, () => client.destroy());
    let prefix = Buffer.alloc(0);
    const firstFrame = (chunk: Buffer): void => {
      if (closing) { client.destroy(); return; }
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length > FRAME_LIMIT) { client.destroy(); return; }
      const newline = prefix.indexOf(10); if (newline < 0) return;
      client.pause(); client.off("data", firstFrame); client.setTimeout(0);
      const frame = prefix.subarray(0, newline + 1).toString("utf8");
      let body: Json | undefined;
      try { body = object(JSON.parse(frame)); } catch { /* original server owns malformed requests */ }
      const params = object(body?.params);
      const owned = ["pane.report_agent", "pane.report_agent_session"].includes(String(body?.method))
        && params?.pane_id === binding.paneId && params.source === HERDR_SOURCE && params.agent === "pi";
      if (owned) {
        // Official/PA integrations emit canonical JSON. Reject noncanonical
        // owned frames instead of turning duplicate-key/invalid JSON into a
        // different valid request while rewriting its source.
        if (typeof body?.id !== "string" || JSON.stringify(body) !== frame.trim() || Buffer.byteLength(frame) > HERDR_REQUEST_LIMIT_BYTES
          || !Number.isSafeInteger(params.seq) || (params.seq as number) < 0 || queue.length >= QUEUE_LIMIT) {
          respond(client, typeof body?.id === "string" ? body.id : "", "invalid_lifecycle_report"); return;
        }
        queue.push({ client, body, id: body.id, seq: params.seq as number, session: sessionRef(params) });
        drain(); return;
      }
      // Transparent existing API traffic: no rewriting, synthesized command,
      // extra routing authority, response parsing or transcript retention.
      const upstream = connect(binding.socketPath); upstreams.add(upstream);
      upstream.on("error", () => { client.destroy(); upstream.destroy(); });
      upstream.on("close", () => {
        upstreams.delete(upstream);
        // pipe() ends the downstream gracefully after EOF. Destroying it here
        // would discard writes still buffered for a slow consumer.
        if (!upstream.readableEnded) client.destroy();
      });
      client.on("close", () => upstream.destroy());
      upstream.on("connect", () => {
        if (closing || disposed || client.destroyed) { upstream.destroy(); return; }
        upstream.write(prefix); client.pipe(upstream); upstream.pipe(client); client.resume();
      });
    };
    client.on("data", firstFrame);
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true; closing = true; queue.length = 0;
    try { server.close(); } catch { /* an unstarted/already closed owned server */ }
    for (const socket of clients) socket.destroy();
    for (const socket of upstreams) socket.destroy();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* advisory owned temporary endpoint cleanup */ }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      server.once("error", failed);
      server.listen(endpoint, () => { server.off("error", failed); resolve(); });
    });
    server.on("error", () => dispose()); server.unref();
  } catch { dispose(); return undefined; }

  const finish = async (deathEvidence: HerdrChildDeathEvidence): Promise<CleanupObservation> => {
    const deadline = performance.now() + HERDR_EXIT_BUDGET_MS;
    let submitted = false, requestId: string | undefined;
    const result = (status: HerdrExitCleanupResult["status"], reason?: HerdrExitCleanupResult["reason"]): CleanupObservation =>
      Object.freeze({ status, ...(reason ? { reason } : {}), submitted, ...(requestId ? { requestId } : {}), source: managedSource, deathEvidence });
    closing = true; server.close(); queue.length = 0;
    for (const client of clients) client.destroy();
    // The one budget also cuts short an already forwarded report's 750 ms wait.
    const timer = setTimeout(dispose, HERDR_EXIT_BUDGET_MS);
    const classify = (reply: Reply): HerdrExitCleanupResult["reason"] => performance.now() >= deadline || reply.kind === "timeout" ? "timeout"
      : reply.kind === "reply" ? "rejected" : reply.kind;
    try {
      await active;
      if (uncertainReport) return result("unconfirmed", "report-uncertain");
      if (!stateReported || maxSeq < 0) return result("skipped", "not-reported");
      if (!Number.isSafeInteger(maxSeq + 1)) return result("unconfirmed", "sequence-exhausted");
      if (performance.now() >= deadline) return result("unconfirmed", "timeout");
      // Record the original request only at possible delivery, never on a
      // failed connect. At most one attempt; disconnect is not cancellation.
      // The server compares the current authority's source+agent atomically.
      // A delayed A release cannot remove B, even with a larger A sequence.
      const cleared = await request("pane.release_agent", { pane_id: binding.paneId, source: managedSource, agent: "pi", seq: maxSeq + 1 }, deadline,
        id => { submitted = true; requestId = id; });
      if (cleared.kind !== "reply") return result("unconfirmed", classify(cleared));
      if (object(cleared.body.error)) return result("unconfirmed", "rejected");
      const after = await request("agent.get", { target: binding.paneId }, deadline);
      if (after.kind === "reply" && object(after.body.error)?.code === "agent_not_found") return result("verified-absent");
      return result("acknowledged", after.kind === "reply" && !object(after.body.error) ? "still-listed" : classify(after));
    } catch { return result("unconfirmed", performance.now() >= deadline ? "timeout" : "socket-error"); }
    finally { clearTimeout(timer); dispose(); }
  };
  return {
    environment: { ...env, HERDR_SOCKET_PATH: endpoint },
    afterVerifiedExit(evidence) {
      if (!completion) {
        const started = performance.now();
        completion = finish(evidence).then(result => Object.freeze({ ...result, elapsedMs: performance.now() - started }));
      }
      return completion;
    },
    dispose,
  };
}
