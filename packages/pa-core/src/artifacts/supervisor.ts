import { closeSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFeedback, readJournal } from "./feedback.js";
import { artifactSha256 } from "./manifest.js";
import { ArtifactPolicyError, artifactDiagnostic } from "./policy.js";
import {
  jsonBytes, privateDirectory, processBirth, readPrivate, readReviewAsset, REVIEW_IDLE_MS, REVIEW_START_MS, selectedReviewAssets,
  withReviewLock, type ReviewContext,
} from "./runtime.js";
import { readReviewRecord, reviewFresh, writeReviewRecord, type ReviewRecord } from "./session.js";

export const OUTER_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export function idleExpired(lastActivity: number, now: number): boolean { return now - lastActivity >= REVIEW_IDLE_MS; }
interface SupervisorOptions { now?: () => number; tickMs?: number; expectedAssets?: string }

/** Core-owned server uses only adapted packaged Lavish components, never the
 * upstream server. No route imports CLI, shell, SDK, updater or outbound client. */
export async function superviseReview(path: string, options: SupervisorOptions = {}): Promise<{ close: () => Promise<void>; record: ReviewRecord }> {
  const fd = privateDirectory(path);
  let record: ReviewRecord;
  try {
    const raw = JSON.parse(readPrivate(fd, "owner.json", 268_435_456).toString()) as ReviewRecord;
    const context: ReviewContext = raw.context;
    record = readReviewRecord(fd, context, raw.sessionId);
    if (path !== join(context.root, raw.sessionId) || record.state !== "starting"
        || record.supervisorPid !== 0 || processBirth(context.ownerPid) !== context.ownerBirth) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
    if (options.expectedAssets !== undefined && record.assets !== options.expectedAssets) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
    if (!reviewFresh(record)) throw artifactDiagnostic("ARTIFACT_STALE");
    withReviewLock(context, () => {
      const current = readReviewRecord(fd, context, record.sessionId);
      if (current.state !== "starting" || current.supervisorPid !== 0 || current.token !== record.token
          || Date.now() >= current.startDeadline) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
      record.supervisorPid = process.pid; record.supervisorBirth = processBirth(process.pid)!;
      writeReviewRecord(fd, record);
    });
  } catch (error) { closeSync(fd); throw error; }
  const now = options.now ?? (() => performance.now());
  let lastActivity = now();
  const boot = now();
  let closing = false;
  let closed: Promise<void> | undefined;
  let snapshot: Buffer;
  const assets = new Map<string, Buffer>();
  try {
    snapshot = readPrivate(fd, "snapshot.html", 268_435_456);
    if (artifactSha256(snapshot) !== record.identity.htmlSha256) throw artifactDiagnostic("ARTIFACT_STALE");
    for (const name of ["outer.html", "outer.css", "review.js"]) assets.set(name, readReviewAsset(record.assets, name));
    readJournal(fd, record); // A corrupt journal never becomes a fresh empty one.
  } catch (error) {
    try {
      try { unlinkSync(`/proc/self/fd/${fd}/snapshot.html`); } catch { /* own transient only */ }
      record.state = "stopped"; writeReviewRecord(fd, record);
    } finally { closeSync(fd); }
    throw error;
  }
  let frozen = false;
  const fresh = (): boolean => { frozen ||= !reviewFresh(record); return !frozen; };
  const diagnosticResponse = (response: ServerResponse, error: unknown): void => {
    const diagnostic = error instanceof ArtifactPolicyError ? error : artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
    response.writeHead(diagnostic.exitCode === 4 || diagnostic.exitCode === 6 ? 409 : 400, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ diagnostic: diagnostic.diagnostic }));
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) diagnosticResponse(response, error);
      else response.destroy();
    });
  });
  server.requestTimeout = 1500; server.headersTimeout = 1500; server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 32;
  server.on("upgrade", (_request, socket) => {
    socket.once("error", () => socket.destroy());
    // Upgraded sockets are excluded from closeAllConnections(). Flush the
    // denial, then destroy our socket even if a peer keeps its half open.
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
  });
  const send = (response: ServerResponse, bytes: Buffer, type: string, csp = OUTER_CSP): void => {
    response.writeHead(200, { "content-type": type, "content-length": bytes.length,
      "content-security-policy": csp, "cache-control": "no-store", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-write=()" });
    response.end(bytes);
  };
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = `http://127.0.0.1:${record.port}`;
    if (closing || request.headers.host !== `127.0.0.1:${record.port}`
        || request.headers.origin !== undefined && request.headers.origin !== origin
        || request.headers["sec-fetch-site"] !== undefined && request.headers["sec-fetch-site"] !== "same-origin"
          && request.headers["sec-fetch-site"] !== "none") throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
    const prefix = `/${record.token}/`;
    const url = request.url ?? "";
    if (!url.startsWith(prefix) || /[%?#\\\u0000]/.test(url)) throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
    const route = url.slice(prefix.length);
    if (request.method === "GET") {
      if (route === "") {
        const config = JSON.stringify({ sessionId: record.sessionId, identity: record.identity, anchors: record.anchors });
        const escaped = config.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
        send(response, Buffer.from(assets.get("outer.html")!.toString().replace("__CONFIG__", escaped)), "text/html; charset=utf-8");
      } else if (route === "content") {
        send(response, snapshot, "text/html; charset=utf-8", "sandbox allow-same-origin; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
      } else if (route === "review.js" || route === "outer.css") {
        send(response, assets.get(route)!, route === "review.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
      } else if (route === "api/status") {
        send(response, jsonBytes({ status: !fresh() ? "stale" : record.state }), "application/json");
      } else throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
      return;
    }
    if (request.method !== "POST") throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
    if (["control/start", "control/stop", "control/consume"].includes(route)) {
      if (request.headers.authorization !== `Bearer ${record.token}` || request.headers.origin !== undefined
          || request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) !== 0) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
      if (route === "control/stop") {
        response.once("finish", () => { setTimeout(() => { void close("stopped"); }, 10); });
        send(response, jsonBytes({ status: "stopped" }), "application/json"); return;
      }
      if (!fresh()) throw artifactDiagnostic("ARTIFACT_STALE");
      lastActivity = now();
      send(response, jsonBytes({ status: record.state }), "application/json"); return;
    }
    if (!["api/feedback", "api/activity", "api/end"].includes(route)
        || request.headers.origin !== origin || request.headers["content-type"] !== "application/json") throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
    if (!fresh()) throw artifactDiagnostic("ARTIFACT_STALE");
    if (record.state !== "running") throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
    const chunks: Buffer[] = [];
    let length = 0;
    // Bound both body size and slow/incomplete clients. No write before full validation.
    const timer = setTimeout(() => request.destroy(), 1500);
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        length += bytes.length;
        if (length > 16_777_216) throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
        chunks.push(bytes);
      }
    } finally { clearTimeout(timer); }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED"); }
    if (!fresh()) throw artifactDiagnostic("ARTIFACT_STALE");
    // Another request may have ended/closed the review while this body awaited
    // bytes. Never append or acknowledge new feedback after that transition.
    if (closing || record.state !== "running") throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
    if (route === "api/feedback") {
      const events = appendFeedback(fd, record, body);
      lastActivity = now();
      send(response, jsonBytes({ status: "acknowledged", eventIds: events.map((event) => event.eventId) }), "application/json");
    } else {
      if (JSON.stringify(body) !== "{}") throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
      lastActivity = now();
      if (route === "api/end") {
        // Persist the user-ended tombstone before ACK. A crash between ACK and
        // socket cleanup must not make an explicitly ended review restartable.
        const endedRecord: ReviewRecord = { ...record, state: "ended" };
        writeReviewRecord(fd, endedRecord);
        record = endedRecord;
        response.once("finish", () => { setTimeout(() => { void close("ended"); }, 10); });
      }
      send(response, jsonBytes({ status: route === "api/end" ? "ended" : "running" }), "application/json");
    }
  }
  let interval: ReturnType<typeof setInterval> | undefined;
  function close(state: "stopped" | "ended" = "stopped"): Promise<void> {
    if (closed) return closed;
    closing = true;
    if (interval) clearInterval(interval);
    closed = new Promise<void>((done) => {
      server.close(() => {
        try {
          const current = readReviewRecord(fd, record.context, record.sessionId);
          if (current.token === record.token && current.supervisorPid === record.supervisorPid && current.supervisorBirth === record.supervisorBirth) {
            try { unlinkSync(`/proc/self/fd/${fd}/snapshot.html`); } catch { /* own transient file only */ }
            record.state = record.state === "ended" ? "ended" : state; writeReviewRecord(fd, record);
          }
        } finally { closeSync(fd); done(); }
      });
      server.closeAllConnections();
    });
    return closed;
  }
  try {
    const current = readReviewRecord(fd, record.context, record.sessionId);
    if (current.state !== "starting" || current.token !== record.token || current.supervisorPid !== process.pid || Date.now() >= record.startDeadline) throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
    await new Promise<void>((ready, fail) => {
      const deadline = setTimeout(() => { server.close(); fail(artifactDiagnostic("ARTIFACT_RUNTIME_FAILED")); }, REVIEW_START_MS - 1000);
      server.once("error", (error) => { clearTimeout(deadline); fail(error); });
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => { clearTimeout(deadline); ready(); });
    });
    const address = server.address();
    if (!address || typeof address === "string" || now() - boot >= REVIEW_START_MS - 1000) throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
    const claimed = readReviewRecord(fd, record.context, record.sessionId);
    if (claimed.state !== "starting" || claimed.token !== record.token || claimed.supervisorPid !== process.pid || Date.now() >= record.startDeadline) throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
    record.port = address.port; record.state = "running";
    writeReviewRecord(fd, record);
    interval = setInterval(() => {
      if (processBirth(record.context.ownerPid) !== record.context.ownerBirth || idleExpired(lastActivity, now())) void close();
      else fresh();
    }, options.tickMs ?? 1000);
    return { close, record };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (process.argv.length !== 3 || !path) process.exitCode = 7;
  else void Promise.resolve().then(() => superviseReview(path, { expectedAssets: selectedReviewAssets() })).then((supervisor) => {
    process.once("SIGTERM", () => { void supervisor.close(); });
    process.once("SIGINT", () => { void supervisor.close(); });
  }).catch(() => { process.exitCode = 7; });
}
