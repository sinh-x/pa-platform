import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  executeCoreLocalReview, LOCAL_REVIEW_IO_MS, LOCAL_REVIEW_MAX_BODY, LOCAL_REVIEW_OVERALL_MS,
  LOCAL_REVIEW_TRUST, LOCAL_REVIEW_VERSION, LocalReviewTransportError,
  localReviewFailure, readLocalReviewInput, serializeLocalReview, type LocalReviewHandler,
} from "./local-review-cli.js";

export const LOCAL_REVIEW_MAX_HEADERS = 8 * 1024;
export const LOCAL_REVIEW_MAX_SOCKETS = 16;
export const LOCAL_REVIEW_HEALTH = Object.freeze({ schemaVersion: LOCAL_REVIEW_VERSION, trust: LOCAL_REVIEW_TRUST });
type Failure = ConstructorParameters<typeof LocalReviewTransportError>[0];
interface Connection {
  expiresAt: number;
  headerTimer: ReturnType<typeof setTimeout>;
  totalTimer: ReturnType<typeof setTimeout>;
  writeTimer?: ReturnType<typeof setTimeout>;
  responding: boolean;
  receivedRequest: boolean;
  fail(code: Failure, status: number): void;
}

export interface LocalReviewServerOptions {
  /** Zero is available for ephemeral source tests; the CLI requires 1–65535. */
  port: number;
  handler?: LocalReviewHandler;
  /** Tests may shorten, never extend, production deadlines. */
  deadlines?: { ioMs?: number; overallMs?: number };
}

function deadline(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new LocalReviewTransportError("arguments");
  return value;
}
function headerValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]!.toLowerCase() === name) values.push(request.rawHeaders[i + 1]!);
  }
  return values;
}

/** Dedicated unauthenticated transport. No agent API, credentials, store or file routes. */
export async function startLocalReviewServer(options: LocalReviewServerOptions): Promise<Server> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new LocalReviewTransportError("arguments");
  const ioMs = deadline(options.deadlines?.ioMs, LOCAL_REVIEW_IO_MS);
  const overallMs = deadline(options.deadlines?.overallMs, LOCAL_REVIEW_OVERALL_MS);
  const handler = options.handler ?? executeCoreLocalReview;
  const connections = new Map<Duplex, Connection>();
  let active = false;
  const server = createServer({
    maxHeaderSize: LOCAL_REVIEW_MAX_HEADERS, headersTimeout: ioMs,
    requestTimeout: ioMs, connectionsCheckingInterval: Math.min(ioMs, 250),
    keepAliveTimeout: 1,
  });
  server.maxHeadersCount = 0; // Do not silently discard headers; enforce the byte limit instead.
  server.on("connection", socket => {
    if (connections.size >= LOCAL_REVIEW_MAX_SOCKETS) { socket.destroy(); return; }
    const state: Connection = {
      expiresAt: performance.now() + overallMs,
      responding: false,
      receivedRequest: false,
      headerTimer: setTimeout(() => state.fail("deadline", 408), ioMs),
      totalTimer: setTimeout(() => state.fail("deadline", 504), overallMs),
      fail: (code, status) => {
        if (state.responding || socket.destroyed || !socket.writable) { socket.destroy(); return; }
        state.responding = true;
        clearTimeout(state.headerTimer); clearTimeout(state.totalTimer);
        const body = JSON.stringify(localReviewFailure(new LocalReviewTransportError(code)));
        state.writeTimer = setTimeout(() => socket.destroy(), Math.min(ioMs, Math.max(1, state.expiresAt - performance.now())));
        socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
      },
    };
    connections.set(socket, state);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(state.headerTimer); clearTimeout(state.totalTimer); clearTimeout(state.writeTimer);
      connections.delete(socket);
    });
  });

  const receive = (request: IncomingMessage, response: import("node:http").ServerResponse) => {
    const socket = request.socket;
    const state = connections.get(socket);
    if (!state || state.responding || state.receivedRequest) { socket.destroy(); return; }
    state.receivedRequest = true; // No keep-alive or pipelined work on this connection.
    clearTimeout(state.headerTimer);
    let holdsSlot = false, pendingHandler = false, responseDone = false;
    const release = () => {
      // A deadline/disconnect does not cancel core. Keep the admission slot until
      // it settles, even when its reply is lost; never overlap an uncertain write.
      if (holdsSlot && responseDone && !pendingHandler) { active = false; holdsSlot = false; }
    };
    const done = () => {
      responseDone = true;
      clearTimeout(state.totalTimer); clearTimeout(state.writeTimer);
      release();
    };
    response.once("finish", done); response.once("close", done);
    response.on("error", () => socket.destroy());
    request.on("error", () => { /* The bounded body reader owns stream failure reporting. */ });
    const send = (status: number, body: string) => {
      if (state.responding || response.destroyed) return;
      if (status === 200 && performance.now() >= state.expiresAt) { state.fail("deadline", 504); return; }
      state.responding = true;
      state.writeTimer = setTimeout(() => socket.destroy(), Math.min(ioMs, Math.max(1, state.expiresAt - performance.now())));
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "Connection": "close", "Content-Length": Buffer.byteLength(body),
      });
      response.end(body);
    };
    state.fail = (code, status) => {
      if (state.responding) { socket.destroy(); return; }
      request.pause();
      send(status, JSON.stringify(localReviewFailure(new LocalReviewTransportError(code))));
    };
    const reject = (code: Failure, status: number) => state.fail(code, status);
    const host = headerValues(request, "host");
    const address = server.address();
    if (host.length !== 1 || !address || typeof address === "string" || host[0] !== `127.0.0.1:${address.port}`) { reject("host", 400); return; }
    if (headerValues(request, "origin").length) { reject("origin", 403); return; }
    if (["authorization", "proxy-authorization", "cookie", "trailer"].some(name => headerValues(request, name).length)) { reject("headers", 400); return; }
    if (headerValues(request, "content-encoding").length) { reject("content", 415); return; }
    if (headerValues(request, "expect").length || headerValues(request, "upgrade").length) { reject("method", 405); return; }
    if (request.url !== "/v1/health" && request.url !== "/v1/review") { reject("route", 404); return; }
    const health = request.url === "/v1/health";
    if (request.method !== (health ? "GET" : "POST")) { reject("method", 405); return; }
    const length = headerValues(request, "content-length");
    if (health) {
      if (headerValues(request, "transfer-encoding").length || (length.length && length[0] !== "0")) { reject("method", 400); return; }
    } else {
      const contentType = headerValues(request, "content-type");
      if (contentType.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType[0]!)) { reject("content", 415); return; }
      if (length.length && Number(length[0]) > LOCAL_REVIEW_MAX_BODY) { reject("body-limit", 413); return; }
    }
    if (active) { reject("busy", 503); return; }
    active = true; holdsSlot = true;
    if (health) { send(200, JSON.stringify(LOCAL_REVIEW_HEALTH)); return; }
    void (async () => {
      try {
        const raw = await readLocalReviewInput(request, ioMs);
        if (Object.keys(request.trailers).length) { reject("content", 415); return; }
        if (state.responding || response.destroyed) return;
        pendingHandler = true;
        let result: Record<string, unknown>;
        try { result = await handler(raw); }
        finally { pendingHandler = false; release(); }
        if (state.responding || response.destroyed) return;
        send(200, serializeLocalReview(result));
      } catch (error) {
        const failure = localReviewFailure(error);
        const status = failure.code === "LOCAL_REVIEW_BODY_LIMIT" ? 413 : failure.code === "LOCAL_REVIEW_DEADLINE" ? 408
          : failure.code === "LOCAL_REVIEW_UTF8" || failure.code === "LOCAL_REVIEW_INPUT" ? 400 : 500;
        if (!state.responding) send(status, JSON.stringify(failure));
      }
    })();
  };
  server.on("request", receive);
  server.on("checkContinue", receive);
  server.on("checkExpectation", receive);
  server.on("upgrade", (_request, socket) => { connections.get(socket)?.fail("method", 405); });
  server.on("connect", (_request, socket) => { connections.get(socket)?.fail("method", 405); });
  server.on("clientError", (error, socket) => {
    const code = "code" in error ? error.code : undefined;
    connections.get(socket)?.fail(code === "HPE_HEADER_OVERFLOW" ? "headers" : code === "ERR_HTTP_REQUEST_TIMEOUT" ? "deadline" : "input", code === "HPE_HEADER_OVERFLOW" ? 431 : code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : 400);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => { server.off("listening", listening); reject(new LocalReviewTransportError("listen")); };
      const listening = () => { server.off("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", listening);
      server.listen({ host: "127.0.0.1", port: options.port, backlog: LOCAL_REVIEW_MAX_SOCKETS });
    });
  } catch { server.close(); throw new LocalReviewTransportError("listen"); }
  return server;
}
