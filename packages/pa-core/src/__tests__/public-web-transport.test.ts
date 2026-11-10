import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Duplex } from "node:stream";
import { request as httpsRequest } from "node:https";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import type { RequestOptions } from "node:https";
import { fetchPublicHop, type PublicTransportDependencies } from "../public-web/transport.js";
import { PublicWebError, WEB_LIMITS } from "../public-web/types.js";

function fixture(options: { peer?: string; authorized?: boolean; close?: boolean; stall?: boolean; body?: Buffer; status?: number; headers?: Record<string, string> } = {}) {
  let connects = 0, requests = 0, connectOptions: ConnectionOptions | undefined, requestOptions: RequestOptions | undefined;
  const socket = new EventEmitter() as EventEmitter & { authorized: boolean; remoteAddress: string; destroy: (error?: Error) => void };
  socket.authorized = options.authorized ?? true; socket.remoteAddress = options.peer ?? "93.184.216.34";
  let destroyed = false;
  socket.destroy = error => { if (destroyed) return; destroyed = true; if (error) socket.emit("error", error); if (options.close !== false) queueMicrotask(() => socket.emit("close")); };
  const dependencies: PublicTransportDependencies = {
    connect: ((settings: ConnectionOptions) => { connects++; connectOptions = settings; if (!options.stall) queueMicrotask(() => socket.emit("secureConnect")); return socket as unknown as TLSSocket; }) as PublicTransportDependencies["connect"],
    request: ((_url: URL, settings: RequestOptions, callback: (value: unknown) => void) => {
      requests++; requestOptions = settings;
      assert.equal((settings.agent as any).createConnection(), socket);
      const request = new EventEmitter() as any;
      request.destroy = () => { socket.destroy(); return request; };
      request.end = () => queueMicrotask(() => {
        const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string>; complete: boolean };
        response.statusCode = options.status ?? 200; response.headers = options.headers ?? { "content-type": "text/plain" }; response.complete = true;
        callback(response); response.end(options.body ?? Buffer.from("synthetic body"));
      });
      return request;
    }) as PublicTransportDependencies["request"],
  };
  return { dependencies, counts: () => ({ connects, requests }), settings: () => ({ connectOptions, requestOptions }), socket };
}
const url = new URL("https://www.public-site.com/page");

test("direct pinned TLS verifies peer before HTTP, uses fresh agent, fixed headers and no ambient proxy/auth", async () => {
  const f = fixture(); const before = { ...process.env };
  try {
    process.env.HTTPS_PROXY = "http://127.0.0.1:9999"; process.env.HTTP_PROXY = process.env.HTTPS_PROXY;
    const response = await fetchPublicHop(url, "93.184.216.34", new AbortController().signal, f.dependencies);
    assert.equal(response.body.toString(), "synthetic body"); assert.deepEqual(f.counts(), { connects: 1, requests: 1 });
    const { connectOptions, requestOptions } = f.settings();
    assert.equal(connectOptions!.host, "93.184.216.34"); assert.equal(connectOptions!.servername, "www.public-site.com");
    assert.equal(connectOptions!.rejectUnauthorized, true); assert.equal(connectOptions!.port, 443); assert.deepEqual(connectOptions!.ALPNProtocols, ["http/1.1"]);
    assert.equal(requestOptions!.method, "GET"); assert.equal(requestOptions!.maxHeaderSize, 16384);
    assert.deepEqual(requestOptions!.headers, { Accept: "text/html, text/plain", "Accept-Encoding": "identity", "User-Agent": "PA-PublicReader/1", Connection: "close" });
    assert.ok(connectOptions!.checkServerIdentity!("untrusted-name", { subject: { CN: "wrong.example" }, subjectaltname: "DNS:wrong.example" } as any));
  } finally { process.env = before; }
});

test("real Node HTTPS request consumes only the preverified in-memory socket (no network)", async () => {
  let wire = "", responded = false;
  const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) {
    wire += chunk.toString();
    if (!responded && wire.includes("\r\n\r\n")) {
      responded = true;
      queueMicrotask(() => { socket.push("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture"); socket.push(null); });
    }
    callback();
  } }) as Duplex & Record<string, any>;
  Object.assign(socket, { authorized: true, encrypted: true, remoteAddress: "93.184.216.34", connecting: false,
    setTimeout() { return socket; }, setNoDelay() { return socket; }, setKeepAlive() { return socket; } });
  const dependencies: PublicTransportDependencies = { request: httpsRequest, connect: (() => {
    queueMicrotask(() => socket.emit("secureConnect")); return socket as unknown as TLSSocket;
  }) as PublicTransportDependencies["connect"] };
  const result = await fetchPublicHop(url, "93.184.216.34", new AbortController().signal, dependencies);
  assert.equal(result.body.toString(), "fixture"); assert.equal(result.compressedBytes, 7);
  assert.match(wire, /^GET \/page HTTP\/1.1\r\n/); assert.match(wire, /Host: www.public-site.com\r\n/i);
  assert.doesNotMatch(wire, /Authorization:|Cookie:|Referer:|Proxy-/i); assert.equal(socket.destroyed, true);
});

test("unsafe pins cause zero sockets; mismatched peer and unauthorized TLS cause zero HTTP requests", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "::1", "169.254.169.254"]) {
    const f = fixture(); await assert.rejects(() => fetchPublicHop(url, address, new AbortController().signal, f.dependencies), PublicWebError);
    assert.deepEqual(f.counts(), { connects: 0, requests: 0 });
  }
  for (const options of [{ peer: "127.0.0.1" }, { peer: "93.184.216.35" }, { authorized: false }]) {
    const f = fixture(options); await assert.rejects(() => fetchPublicHop(url, "93.184.216.34", new AbortController().signal, f.dependencies), PublicWebError);
    assert.deepEqual(f.counts(), { connects: 1, requests: 0 });
  }
  const mapped = fixture({ peer: "::ffff:93.184.216.34" });
  assert.equal((await fetchPublicHop(url, "93.184.216.34", new AbortController().signal, mapped.dependencies)).status, 200);
});

test("cancellation destroys owned TLS before HTTP; missing close remains cleanup unknown", async () => {
  const f = fixture({ stall: true }), controller = new AbortController();
  const operation = fetchPublicHop(url, "93.184.216.34", controller.signal, f.dependencies); controller.abort();
  await assert.rejects(() => operation, PublicWebError); assert.equal(f.counts().requests, 0);
  const uncertain = fixture({ close: false });
  await assert.rejects(() => fetchPublicHop(url, "93.184.216.34", new AbortController().signal, uncertain.dependencies), (error: unknown) => error instanceof PublicWebError && error.code === "WEB_CLEANUP");
});

test("transport rejects oversized bodies, excludes redirect/error bodies, and waits for socket close", async () => {
  for (const options of [{ body: Buffer.alloc(WEB_LIMITS.bodyBytes + 1) }, { headers: { "content-length": String(WEB_LIMITS.bodyBytes + 1) } }]) {
    const f = fixture(options);
    await assert.rejects(() => fetchPublicHop(url, "93.184.216.34", new AbortController().signal, f.dependencies), (error: unknown) => error instanceof PublicWebError && error.code === "WEB_LIMIT");
  }
  for (const status of [302, 401, 429]) {
    const f = fixture({ status, body: Buffer.from("not page content"), headers: { location: "/next", "content-encoding": "gzip" } });
    const result = await fetchPublicHop(url, "93.184.216.34", new AbortController().signal, f.dependencies);
    assert.equal(result.status, status); assert.equal(result.body.length, 0); assert.equal(result.compressedBytes, 0);
  }
});
