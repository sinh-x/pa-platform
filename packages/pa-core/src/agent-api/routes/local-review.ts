import { createServer, IncomingMessage, type RequestListener, type Server, type ServerOptions, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { parseLocalReviewRequest } from "../../documents/handoff-contract.js";
import { DocumentPackageError } from "../../documents/package-contract.js";

export const LOCAL_REVIEW_PATH = "/api/documents/local-review";
const BODY_BYTES = 64 * 1024, HEADER_BYTES = 8 * 1024, RESPONSE_BYTES = 32 * 1024 * 1024;
const IO_MS = 5_000, OVERALL_MS = 30_000, MAX_SOCKETS = 16;
const reasons = {
  BIND: "Opt-in review requires the numeric bind 127.0.0.1 or ::1. Other general-server bind defaults are unchanged.",
  OPTIONS: "The local-review option is supported only for server start or restart.",
  PEER: "The actual server bind and direct socket peer must both be numeric loopback. Caller headers cannot establish this trust.",
  HOST: "Exactly one Host matching the numeric listening address and port is required.",
  ORIGIN: "Any Origin header is forbidden, including an empty value or null. Browser requests and CORS are unsupported.",
  HEADERS: "Headers exceed 8 KiB or contain unsupported credentials, forwarding, trailers or duplicate fields.",
  CONTENT: "Use application/json with optional UTF-8 charset, without compression or trailers.",
  METHOD: "Only POST without Expect, upgrade or tunnelling is supported.",
  ROUTE: "Only the exact local-review endpoint is supported, without query strings or suffixes.",
  INPUT: "The request stream or strict request grammar is invalid. Unknown fields and duplicate decoded keys are forbidden.",
  UTF8: "The request body is not strict UTF-8.",
  BODY_LIMIT: "The streamed request exceeds 64 KiB; it was rejected rather than truncated.",
  BUSY: "Another review operation is in flight. No work is queued, including after a lost reply while its owner is still running.",
  DEADLINE: "A transport deadline expired. An operation that already started may have completed; interruption does not undo it.",
  RESPONSE_LIMIT: "The result exceeds 32 MiB. It was not truncated; the review operation may already have completed.",
  INTERNAL: "A complete result is unavailable. Private exception details are withheld; any started operation has an unproven outcome.",
  DOCUMENT_INPUT: "The existing document owner rejected the request schema or values.",
  DOCUMENT_SOURCE: "The existing document owner could not verify the frozen source or delivery evidence.",
  DOCUMENT_STALE: "The existing document owner reported stale coordinates or evidence.",
  DOCUMENT_AUTHORITY: "The existing document owner's admission checks rejected this request. Local confirmation is not authenticated human consent.",
  DOCUMENT_CONFLICT: "The existing document owner reported conflicting original coordinates or retained evidence.",
  DOCUMENT_UNCERTAIN: "The existing document owner reported uncertain retained state; completion or rollback is not established.",
  DOCUMENT_UNAVAILABLE: "The existing document owner reported an unavailable operation or prerequisite.",
} as const;
type Cause = keyof typeof reasons;
class BridgeError extends Error {
  constructor(readonly causeCode: Cause, readonly status: number) { super(causeCode); }
}

/** Static bounded guidance only: no exception text, caller context or recovery effects. */
export function localReviewBridgeFailure(cause: Cause): { ok: false; code: string; message: string } {
  return {
    ok: false, code: cause.startsWith("DOCUMENT_") ? cause : `LOCAL_REVIEW_${cause}`,
    message: [
      cause === "BIND" || cause === "OPTIONS" ? "Local review server not started." : "Local review did not return a complete result.",
      "Condition: The requested review transport is blocked or its result is unproven; a lost reply does not cancel a shared review.",
      "Source: General PA-server local review bridge and existing document owner.",
      `Reason: ${reasons[cause]}`,
      "Correction: Ask the server owner to inspect the supported input, bind and original request. Impact: none. Actor: operator. New approval: not required to ask. Prerequisite: retain the original subject, request key and pre-request revision; inspection or repair needs its own authority.",
      "Resume Action: Correct the failed prerequisite before retrying. If an operation started or its reply was lost, establish its result through the same owner's show action using the ORIGINAL coordinates before another write. Do not request a replacement approval. Any resumed effect request rechecks admission.",
    ].join("\n"),
  };
}

export function isLocalReviewBind(host: string): boolean { return host === "127.0.0.1" || host === "::1"; }
export function serializeLocalReviewBridgeResult(result: Record<string, unknown>): string {
  const body = JSON.stringify(result);
  if (Buffer.byteLength(body) > RESPONSE_BYTES) throw new BridgeError("RESPONSE_LIMIT", 503);
  return body;
}
function values(request: IncomingMessage, name: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === name) result.push(request.rawHeaders[i + 1]!);
  return result;
}
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const cleanup = () => { clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", failed); request.off("close", failed); };
    const fail = (cause: Cause, status: number) => { cleanup(); request.pause(); reject(new BridgeError(cause, status)); };
    const data = (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) { fail("INPUT", 400); return; }
      bytes += chunk.byteLength;
      if (bytes > BODY_BYTES) { fail("BODY_LIMIT", 413); return; }
      chunks.push(Buffer.from(chunk));
    };
    const end = () => {
      cleanup();
      try { resolve(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes))); }
      catch { reject(new BridgeError("UTF8", 400)); }
    };
    const failed = () => fail("INPUT", 400);
    const timer = setTimeout(() => fail("DEADLINE", 408), IO_MS);
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", failed); request.once("close", failed);
  });
}

interface Connection {
  reviewOwned: boolean;
  requests: number;
  expiresAt: number;
  headerTimer: ReturnType<typeof setTimeout>;
  fail(cause: Cause, status: number): void;
}

/** Opt-in Node server factory for the REAL general server. Only this one endpoint
 * bypasses Hono's CORS/error wrappers. Other requests use its unchanged listener.
 * No injected handler, journal, actor, runner, shell effect or proxy trust seam. */
export function createLocalReviewHttpServer<Request extends typeof IncomingMessage = typeof IncomingMessage, Response extends typeof ServerResponse<InstanceType<Request>> = typeof ServerResponse>(listener?: RequestListener<Request, Response>): Server<Request, Response>;
export function createLocalReviewHttpServer<Request extends typeof IncomingMessage = typeof IncomingMessage, Response extends typeof ServerResponse<InstanceType<Request>> = typeof ServerResponse>(options: ServerOptions<Request, Response>, listener?: RequestListener<Request, Response>): Server<Request, Response>;
export function createLocalReviewHttpServer<Request extends typeof IncomingMessage = typeof IncomingMessage, Response extends typeof ServerResponse<InstanceType<Request>> = typeof ServerResponse>(optionsOrListener: ServerOptions<Request, Response> | RequestListener<Request, Response> = {}, requestListener?: RequestListener<Request, Response>): Server<Request, Response> {
  const options = typeof optionsOrListener === "function" ? {} : optionsOrListener;
  const listener = typeof optionsOrListener === "function" ? optionsOrListener : requestListener;
  const server = createServer<Request, Response>({ ...options, maxHeaderSize: HEADER_BYTES, headersTimeout: IO_MS, requestTimeout: IO_MS, connectionsCheckingInterval: 250 });
  server.maxHeadersCount = 0; // Never silently discard safety-relevant headers.
  const connections = new Map<Duplex, Connection>();
  let active = false;
  server.on("connection", socket => {
    if (connections.size >= MAX_SOCKETS) { socket.destroy(); return; }
    let writeTimer: ReturnType<typeof setTimeout> | undefined;
    const state: Connection = {
      reviewOwned: false, requests: 0, expiresAt: performance.now() + OVERALL_MS, headerTimer: setTimeout(() => state.fail("DEADLINE", 408), IO_MS),
      fail(cause, status) {
        if (socket.destroyed || !socket.writable) { socket.destroy(); return; }
        clearTimeout(state.headerTimer);
        const body = JSON.stringify(localReviewBridgeFailure(cause));
        writeTimer = setTimeout(() => socket.destroy(), IO_MS);
        socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
      },
    };
    connections.set(socket, state);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(state.headerTimer); clearTimeout(writeTimer); connections.delete(socket); });
  });
  // EventEmitter calls EVERY listener even if an earlier upgrade listener closes
  // the socket. Gate native ingress before dispatch, including later-installed
  // Hono/WebSocket listeners, rather than trying to fence in one such listener.
  const emit = server.emit.bind(server);
  const ingressEvents = new Set(["request", "checkContinue", "checkExpectation", "upgrade", "connect"]);
  server.emit = (event: string, ...args: unknown[]): boolean => {
    const request = args[0];
    if (typeof event === "string" && ingressEvents.has(event) && request instanceof IncomingMessage) {
      const socket = request.socket, state = connections.get(socket);
      if (!state) { socket.destroy(); return true; }
      if (state.reviewOwned) {
        // Discard subsequent work without aborting the first request/owner. Its
        // response always closes this socket, under the existing deadlines.
        socket.pause();
        return true;
      }
      const review = request.url?.startsWith(LOCAL_REVIEW_PATH) === true;
      if (review) state.reviewOwned = true; // BEFORE any listener or asynchronous work.
      if (event === "upgrade" || event === "connect") {
        clearTimeout(state.headerTimer);
        if (review || event === "connect") { state.fail("METHOD", 405); return true; }
      }
    }
    return emit(event, ...args);
  };
  const receive: RequestListener<Request, Response> = (request, response) => {
    const state = connections.get(request.socket);
    if (!state) { request.socket.destroy(); return; }
    clearTimeout(state.headerTimer); state.requests++;
    if (!request.url?.startsWith(LOCAL_REVIEW_PATH)) { listener?.(request, response); return; }
    // Review never shares a keep-alive/pipelined connection with other work.
    if (state.requests !== 1) { request.socket.destroy(); return; }
    receiveReview(request, response, state);
  };
  const receiveReview = (request: IncomingMessage, response: ServerResponse, state: Connection) => {
    let responding = false, holdsSlot = false, pendingOwner = false, responseDone = false;
    let writeTimer: ReturnType<typeof setTimeout> | undefined;
    const expiresAt = state.expiresAt;
    const release = () => { if (holdsSlot && responseDone && !pendingOwner) { active = false; holdsSlot = false; } };
    const done = () => { responseDone = true; clearTimeout(totalTimer); clearTimeout(writeTimer); release(); };
    const send = (status: number, body: string) => {
      if (responding || response.destroyed) return;
      responding = true; request.pause();
      writeTimer = setTimeout(() => request.socket.destroy(), Math.min(IO_MS, Math.max(1, expiresAt - performance.now())));
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Connection": "close", "Content-Length": Buffer.byteLength(body) });
      response.end(body);
    };
    const fail = (cause: Cause, status: number) => send(status, JSON.stringify(localReviewBridgeFailure(cause)));
    const totalTimer = setTimeout(() => responding ? request.socket.destroy() : fail("DEADLINE", 504), Math.max(1, expiresAt - performance.now()));
    state.fail = fail;
    response.once("finish", done); response.once("close", done);
    response.on("error", () => request.socket.destroy());
    request.on("error", () => { /* Bounded body reader owns reporting; no shared review cancellation. */ });
    const address = server.address(), socket = request.socket;
    if (!address || typeof address === "string" || !isLocalReviewBind(address.address)
      || socket.localAddress !== address.address || !isLocalReviewBind(socket.remoteAddress ?? "")) { fail("PEER", 403); return; }
    const host = address.address === "::1" ? `[::1]:${address.port}` : `127.0.0.1:${address.port}`;
    if (values(request, "origin").length) { fail("ORIGIN", 403); return; }
    if (values(request, "host").length !== 1 || values(request, "host")[0] !== host) { fail("HOST", 400); return; }
    const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());
    if (new Set(names).size !== names.length || names.some(name => name === "forwarded" || name.startsWith("x-forwarded") || ["via", "x-original-url", "x-rewrite-url", "x-real-ip", "authorization", "proxy-authorization", "cookie", "trailer", "x-pa-deployment-id", "x-av-pair-token", "x-av-node-id"].includes(name))) { fail("HEADERS", 400); return; }
    if (request.url !== LOCAL_REVIEW_PATH) { fail("ROUTE", 404); return; }
    if (request.method !== "POST" || ["expect", "upgrade"].some(name => values(request, name).length)) { fail("METHOD", 405); return; }
    const contentType = values(request, "content-type");
    if (contentType.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType[0]!) || values(request, "content-encoding").length) { fail("CONTENT", 415); return; }
    if (Number(request.headers["content-length"] ?? 0) > BODY_BYTES) { fail("BODY_LIMIT", 413); return; }
    if (active) { fail("BUSY", 503); return; }
    active = true; holdsSlot = true;
    void (async () => {
      try {
        const raw = await readBody(request);
        if (Object.keys(request.trailers).length) throw new BridgeError("CONTENT", 415);
        parseLocalReviewRequest(raw); // Strict fields/duplicate keys/depth BEFORE owner import or I/O.
        if (responding || response.destroyed) return;
        pendingOwner = true;
        let result: Record<string, unknown>;
        try {
          const { executeLocalReview } = await import("../../documents/local-review.js");
          if (responding || response.destroyed || performance.now() >= expiresAt) return;
          result = await executeLocalReview(raw);
        } finally { pendingOwner = false; release(); }
        if (responding || response.destroyed) return;
        if (performance.now() >= expiresAt) { fail("DEADLINE", 504); return; }
        send(200, serializeLocalReviewBridgeResult(result));
      } catch (error) {
        if (error instanceof BridgeError) fail(error.causeCode, error.status);
        else if (error instanceof DocumentPackageError) fail(error.code, error.code === "DOCUMENT_INPUT" ? 400 : error.code === "DOCUMENT_AUTHORITY" ? 403 : error.code === "DOCUMENT_UNAVAILABLE" ? 503 : 409);
        else fail("INTERNAL", 500);
      }
    })();
  };
  server.on("request", receive);
  server.on("checkContinue", (request, response) => {
    if (!request.url?.startsWith(LOCAL_REVIEW_PATH)) response.writeContinue();
    receive(request, response);
  });
  server.on("checkExpectation", (request, response) => {
    if (request.url?.startsWith(LOCAL_REVIEW_PATH)) receive(request, response);
    else { clearTimeout(connections.get(request.socket)?.headerTimer); response.writeHead(417); response.end(); }
  });
  server.on("clientError", (error, socket) => {
    const code = "code" in error ? error.code : undefined;
    connections.get(socket)?.fail(code === "HPE_HEADER_OVERFLOW" ? "HEADERS" : code === "ERR_HTTP_REQUEST_TIMEOUT" ? "DEADLINE" : "INPUT", code === "HPE_HEADER_OVERFLOW" ? 431 : code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : 400);
  });
  return server;
}
