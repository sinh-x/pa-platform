import { Readable, Writable } from "node:stream";

export type LocalReviewHandler = (raw: string) => Promise<Record<string, unknown>>;
export const LOCAL_REVIEW_VERSION = "pa-local-review/v1";
export const LOCAL_REVIEW_TRUST = "local-unverified";
export const LOCAL_REVIEW_MAX_BODY = 64 * 1024;
export const LOCAL_REVIEW_MAX_RESPONSE = 32 * 1024 * 1024;
export const LOCAL_REVIEW_IO_MS = 5_000;
export const LOCAL_REVIEW_OVERALL_MS = 30_000;

export const LOCAL_REVIEW_USAGE = `Usage: ppa document review --request-stdin
       ppa document review serve --port N
       ppa document review --help

Send one ${LOCAL_REVIEW_VERSION} JSON request on stdin, or explicitly start the
127.0.0.1-only HTTP server (port 1–65535). POST /v1/review uses the same request;
GET /v1/health reports version and trust without opening stores.
Actions: show, request, decide, revoke. Decisions are local-unverified, not
authenticated human consent. Any local process able to reach the server can
read eligible v2 reviews and submit decisions. There is no authentication or CORS.
No publication, ref promotion, queue, arbitrary file access or shell execution.
Limits: 64 KiB strict UTF-8 requests; 8 KiB headers; 16 sockets; one in-flight
operation, no queue; 5s header/body/write, 30s overall; 32 MiB responses.
Runtime selection/default activation is separate (PAPC-090).`;

type FailureCode = "arguments" | "input" | "utf8" | "body-limit" | "headers" | "host" | "origin" | "route" | "method" | "content" | "busy" | "deadline" | "response-limit" | "unavailable" | "internal" | "listen" | "output";
const reasons: Record<FailureCode, string> = {
  arguments: "The command arguments are unsupported. Use ppa document review --help to inspect the supported forms.",
  input: "The request stream could not be read completely.",
  utf8: "The request is not valid UTF-8.",
  "body-limit": "The request exceeds the 64 KiB byte limit.",
  headers: "The HTTP headers are invalid, contain unsupported credential/trailer fields or exceed the 8 KiB limit.",
  host: "Exactly one Host header matching the numeric loopback address and listening port is required.",
  origin: "Requests containing any Origin header are not accepted, including Origin: null.",
  route: "Only /v1/review and /v1/health are supported, without query strings.",
  method: "Use POST for /v1/review and GET without a body for /v1/health. Expect and upgrade requests are unsupported.",
  content: "The review body requires application/json with optional UTF-8 charset and no content encoding or trailers.",
  busy: "Another request is in flight. This server does not queue requests.",
  deadline: "A transport deadline expired. If the operation started, its outcome may be unknown; interruption does not undo a decision.",
  "response-limit": "The serialized result exceeds the 32 MiB response limit. It was not truncated; an operation may already have completed.",
  unavailable: "The installed core does not expose the local review operation. Runtime selection and defaults are separate prerequisites.",
  internal: "The operation did not return a usable result. Its outcome is unproven; private exception details are not exposed.",
  listen: "The dedicated loopback listener could not start. No listener availability is claimed.",
  output: "The result could not be written completely. The operation may already have completed.",
};
const failures = new WeakMap<object, FailureCode>();

export class LocalReviewTransportError extends Error {
  constructor(code: FailureCode) {
    super(`Local review transport: ${code}`);
    failures.set(this, code);
  }
}

/** Only locally constructed, typed failures are trusted; never inspect an exception. */
export function localReviewFailure(error: unknown): { ok: false; code: string; message: string } {
  const cause = ((typeof error === "object" && error !== null) || typeof error === "function") ? failures.get(error) : undefined;
  const code = cause ?? "internal";
  const message = [
    "Local review did not return a complete result.",
    "Condition: The requested transport operation is blocked, failed or has an unproven outcome.",
    "Source: Dedicated local review transport.",
    `Reason: ${reasons[code]}`,
    "Correction: Ask the operator to inspect the original request and supported limits before another effect request. Impact: none. Actor: operator. New approval: not required to ask. Prerequisite: retain the original request coordinates; inspection or repair needs its own authority.",
    "Resume Action: Continue only after the input or transport prerequisite is corrected and any uncertain result is established by its owner. Do not blindly repeat a decision. Any resumed effect request is checked again by its admission owner.",
  ].join("\n");
  return { ok: false, code: `LOCAL_REVIEW_${code.replaceAll("-", "_").toUpperCase()}`, message };
}

/** Lazy loading keeps help, health and rejected HTTP requests away from stores. */
export const executeCoreLocalReview: LocalReviewHandler = async raw => {
  const core = await import("@pa-platform/pa-core");
  if (!("executeLocalReview" in core) || typeof core.executeLocalReview !== "function") throw new LocalReviewTransportError("unavailable");
  const result: unknown = await core.executeLocalReview(raw);
  if (typeof result !== "object" || result === null || Array.isArray(result)) throw new LocalReviewTransportError("internal");
  // Object.entries creates a typed record without assuming the core's result schema.
  return Object.fromEntries(Object.entries(result));
};

export function serializeLocalReview(result: Record<string, unknown>): string {
  const text = JSON.stringify(result);
  if (typeof text !== "string") throw new LocalReviewTransportError("internal");
  if (Buffer.byteLength(text, "utf8") > LOCAL_REVIEW_MAX_RESPONSE) throw new LocalReviewTransportError("response-limit");
  return text;
}

/** Count bytes before decoding; preserve a BOM for core's strict JSON parser to reject. */
export function readLocalReviewInput(input: Readable, timeoutMs = LOCAL_REVIEW_IO_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      input.off("data", data); input.off("end", end); input.off("error", failed); input.off("close", closed);
    };
    const fail = (code: FailureCode) => { cleanup(); input.pause(); reject(new LocalReviewTransportError(code)); };
    const data = (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) { fail("input"); return; }
      size += chunk.byteLength;
      if (size > LOCAL_REVIEW_MAX_BODY) { fail("body-limit"); return; }
      chunks.push(Buffer.from(chunk));
    };
    const end = () => {
      cleanup();
      try { resolve(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size))); }
      catch { reject(new LocalReviewTransportError("utf8")); }
    };
    const failed = () => fail("input");
    const closed = () => fail("input");
    const timer = setTimeout(() => fail("deadline"), timeoutMs);
    input.on("data", data); input.once("end", end); input.once("error", failed); input.once("close", closed);
  });
}

export async function localReviewDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LocalReviewTransportError("deadline")), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

/** CLI production writes have an actual backpressure/completion deadline. */
export async function writeLocalReviewOutput(stream: Writable, text: string, timeoutMs = LOCAL_REVIEW_IO_MS): Promise<void> {
  let rejectWrite: (error: LocalReviewTransportError) => void = () => {};
  const failed = () => rejectWrite(new LocalReviewTransportError("output"));
  const cleanup = () => stream.off("error", failed);
  stream.on("error", failed);
  try {
    await localReviewDeadline(new Promise<void>((resolve, reject) => {
      rejectWrite = reject;
      stream.write(`${text}\n`, error => error ? failed() : resolve());
    }), Math.min(LOCAL_REVIEW_IO_MS, Math.max(1, timeoutMs)));
    cleanup();
  } catch {
    // Failed writes can emit error after their callback. Keep the listener until
    // close, including when a deadline destroys a backpressured stream.
    if (stream.closed) cleanup(); else stream.once("close", cleanup);
    stream.destroy();
    throw new LocalReviewTransportError("output");
  }
}

export interface LocalReviewCliIO {
  stdout(text: string, timeoutMs?: number): void | Promise<void>;
  stderr(text: string, timeoutMs?: number): void | Promise<void>;
}

export async function runLocalReviewCommand(
  args: string[], io: LocalReviewCliIO,
  options: { stdin?: Readable; handler?: LocalReviewHandler } = {},
): Promise<number> {
  let outputStarted = false, outputFailed = false;
  let expiresAt = Infinity;
  const output = async (text: string) => {
    outputStarted = true;
    const budget = Math.min(LOCAL_REVIEW_IO_MS, Math.max(1, expiresAt - performance.now()));
    try { await localReviewDeadline(Promise.resolve(io.stdout(text, budget)), budget); }
    catch (error) { outputFailed = true; throw error; }
  };
  try {
    if (!args.length || (args.length === 1 && args[0] === "--help") || (args.length === 2 && args[0] === "serve" && args[1] === "--help")) {
      await output(LOCAL_REVIEW_USAGE); return 0;
    }
    if (args.length === 3 && args[0] === "serve" && args[1] === "--port" && /^[1-9][0-9]{0,4}$/.test(args[2]!) && Number(args[2]) <= 65535) {
      const { startLocalReviewServer } = await import("./local-review-server.js");
      const server = await startLocalReviewServer({ port: Number(args[2]), handler: options.handler });
      const stop = () => { server.close(); server.closeAllConnections(); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        const closed = new Promise<void>((resolve, reject) => { server.once("close", resolve); server.once("error", reject); });
        await output(JSON.stringify({ schemaVersion: LOCAL_REVIEW_VERSION, trust: LOCAL_REVIEW_TRUST, listening: `http://127.0.0.1:${args[2]}` }));
        await closed; return 0;
      } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); stop(); }
    }
    if (args.length !== 1 || args[0] !== "--request-stdin") throw new LocalReviewTransportError("arguments");
    const input = options.stdin ?? process.stdin;
    let expired = false;
    expiresAt = performance.now() + LOCAL_REVIEW_OVERALL_MS;
    const checkDeadline = () => { if (expired || performance.now() >= expiresAt) throw new LocalReviewTransportError("deadline"); };
    const operation = (async () => {
      const raw = await readLocalReviewInput(input);
      checkDeadline();
      const result = await (options.handler ?? executeCoreLocalReview)(raw);
      checkDeadline();
      const serialized = serializeLocalReview(result);
      checkDeadline(); // Never emit a late second reply after a timeout.
      await output(serialized);
      return result.ok === false ? 1 : 0;
    })();
    try { return await localReviewDeadline(operation, LOCAL_REVIEW_OVERALL_MS); }
    catch (error) { expired = true; input.destroy(); throw error; }
  } catch (error) {
    // A partial stdout write cannot safely be followed by a second JSON document.
    try {
      if (outputStarted) await localReviewDeadline(Promise.resolve(io.stderr(JSON.stringify(localReviewFailure(outputFailed ? new LocalReviewTransportError("output") : error)))), LOCAL_REVIEW_IO_MS);
      else await output(JSON.stringify(localReviewFailure(error)));
    } catch { return 1; }
    return 1;
  }
}
