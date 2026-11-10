import { Resolver } from "node:dns/promises";
import { Agent, request as httpsRequest } from "node:https";
import { connect as tlsConnect, checkServerIdentity, type TLSSocket } from "node:tls";
import { isIP } from "node:net";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { isPublicAddress, normalizedAddress, publicHostname } from "./policy.js";
import { PublicWebError, WEB_LIMITS, type PublicWebResponse } from "./types.js";

export async function resolvePublicAddresses(host: string, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) throw new PublicWebError("WEB_CANCELLED");
  if (isIP(host)) return [host];
  const resolver = new Resolver({ timeout: WEB_LIMITS.requestMs, tries: 1 });
  const cancel = () => resolver.cancel(); signal.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    if (signal.aborted) throw new PublicWebError("WEB_CANCELLED");
    const addresses: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") addresses.push(...result.value);
      else if (!["ENODATA", "ENOTFOUND"].includes((result.reason as NodeJS.ErrnoException)?.code ?? "")) throw new PublicWebError("WEB_NETWORK");
    }
    return addresses;
  } finally { signal.removeEventListener("abort", cancel); resolver.cancel(); }
}

/** No unbounded decompression; both input and output have independent byte limits. */
export async function decodePublicBody(raw: Buffer, encoding: string, signal?: AbortSignal): Promise<Buffer> {
  if (raw.length > WEB_LIMITS.bodyBytes) throw new PublicWebError("WEB_LIMIT");
  if (signal?.aborted) throw new PublicWebError("WEB_CANCELLED");
  if (encoding === "identity" || encoding === "") return raw;
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : undefined;
  if (!decoder) throw new PublicWebError("WEB_UNSUPPORTED");
  let size = 0; const chunks: Buffer[] = [];
  const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
    size += chunk.length; done(size > WEB_LIMITS.bodyBytes ? new PublicWebError("WEB_LIMIT") : null, size > WEB_LIMITS.bodyBytes ? undefined : chunk);
  } });
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } });
  await pipeline(Readable.from([raw]), decoder, limit, sink, { signal });
  return Buffer.concat(chunks, size);
}

/** Internal transport seams for disconnected socket fixtures; never caller-supplied tool parameters. */
export interface PublicTransportDependencies { connect: typeof tlsConnect; request: typeof httpsRequest }
const transport: PublicTransportDependencies = { connect: tlsConnect, request: httpsRequest };

/** Direct TLS to one previously checked address; no global agent, proxy, cookies or retry. */
export async function fetchPublicHop(url: URL, address: string, signal: AbortSignal, dependencies: PublicTransportDependencies = transport): Promise<PublicWebResponse> {
  if (url.protocol !== "https:" || url.port || url.username || url.password || !isPublicAddress(address)) throw new PublicWebError("WEB_TARGET");
  if (signal.aborted) throw new PublicWebError("WEB_CANCELLED");
  const host = publicHostname(url);
  let socket: TLSSocket | undefined, agent: Agent | undefined;
  let socketClosed = false, closePromise: Promise<void> | undefined;
  let request: ReturnType<typeof httpsRequest> | undefined;
  const abort = () => { request?.destroy(new PublicWebError("WEB_CANCELLED")); socket?.destroy(new PublicWebError("WEB_CANCELLED")); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    socket = dependencies.connect({ host: address, port: 443, servername: isIP(host) ? undefined : host, rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"], minVersion: "TLSv1.2", checkServerIdentity: (_ignored, cert) => checkServerIdentity(host, cert) });
    const owned = socket;
    closePromise = new Promise<void>(resolve => owned.once("close", () => { socketClosed = true; resolve(); }));
    // Retain an error listener through disposal; raw TLS/network messages never escape.
    owned.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const error = () => reject(new PublicWebError("WEB_NETWORK"));
      owned.once("error", error);
      owned.once("close", () => reject(new PublicWebError("WEB_NETWORK")));
      owned.once("secureConnect", () => {
        owned.removeListener("error", error);
        if (!owned.authorized || !owned.remoteAddress || normalizedAddress(owned.remoteAddress) !== normalizedAddress(address)) reject(new PublicWebError("WEB_TARGET"));
        else resolve();
      });
      if (signal.aborted) abort();
    });
    if (signal.aborted) throw new PublicWebError("WEB_CANCELLED");
    // Create the HTTP request only AFTER TLS identity and the actual peer match.
    // Returning the established socket avoids a second lookup/connect/rebinding window.
    agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
    agent.createConnection = () => owned;
    const response = await new Promise<PublicWebResponse>((resolve, reject) => {
      request = dependencies.request(url, { agent, method: "GET", maxHeaderSize: 16 * 1024, insecureHTTPParser: false,
        headers: { Accept: "text/html, text/plain", "Accept-Encoding": "identity", "User-Agent": "PA-PublicReader/1", Connection: "close" } }, incoming => {
        const status = incoming.statusCode ?? 0;
        const headers: Record<string, string | undefined> = {};
        for (const name of ["location", "content-type", "content-encoding", "content-length"]) {
          const value = incoming.headers[name];
          if (Array.isArray(value)) { incoming.destroy(); reject(new PublicWebError("WEB_UNSUPPORTED")); return; }
          headers[name] = value;
        }
        // Error/redirect bodies are neither downloaded nor interpreted as page evidence.
        if (status !== 200) { incoming.destroy(); resolve({ status, headers, body: Buffer.alloc(0), compressedBytes: 0 }); return; }
        if (headers["content-length"] && (!/^\d+$/.test(headers["content-length"]) || Number(headers["content-length"]) > WEB_LIMITS.bodyBytes)) { incoming.destroy(); reject(new PublicWebError("WEB_LIMIT")); return; }
        let size = 0; const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > WEB_LIMITS.bodyBytes) { incoming.destroy(); reject(new PublicWebError("WEB_LIMIT")); }
          else chunks.push(chunk);
        });
        incoming.once("error", () => reject(new PublicWebError("WEB_NETWORK")));
        incoming.once("aborted", () => reject(new PublicWebError("WEB_NETWORK")));
        incoming.once("end", () => {
          if (!incoming.complete) reject(new PublicWebError("WEB_NETWORK"));
          else resolve({ status, headers, body: Buffer.concat(chunks, size), compressedBytes: size });
        });
      });
      request.once("error", () => reject(new PublicWebError("WEB_NETWORK")));
      request.end();
    });
    if (response.status === 200) response.body = await decodePublicBody(response.body, response.headers["content-encoding"]?.toLowerCase().trim() ?? "identity", signal);
    return response;
  } finally {
    signal.removeEventListener("abort", abort);
    request?.destroy(); agent?.destroy(); socket?.destroy();
    if (socket && !socketClosed && closePromise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([closePromise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), WEB_LIMITS.cleanupMs); })]);
        if (!settled) throw new PublicWebError("WEB_CLEANUP");
      } finally { if (timer) clearTimeout(timer); }
    }
  }
}
