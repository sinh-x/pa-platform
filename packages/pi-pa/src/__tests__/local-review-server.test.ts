import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { LOCAL_REVIEW_MAX_RESPONSE, type LocalReviewHandler } from "../local-review-cli.js";
import { LOCAL_REVIEW_HEALTH, startLocalReviewServer, type LocalReviewServerOptions } from "../local-review-server.js";

const raw = '{"schemaVersion":"pa-local-review/v1","action":"show","subjectSha256":"' + "a".repeat(64) + '"}';
async function fixture(t: TestContext, handler?: LocalReviewHandler | "default", deadlines?: LocalReviewServerOptions["deadlines"]) {
  const seen: string[] = [];
  const server = await startLocalReviewServer({ port: 0, deadlines, handler: handler === "default" ? undefined : async value => { seen.push(value); return handler ? handler(value) : { ok: true }; } });
  t.after(async () => { const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await closed; });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1"); assert.equal(address.family, "IPv4");
  const host = `127.0.0.1:${address.port}`;
  const request = (body: Buffer | string = raw, extra = "") => Buffer.concat([Buffer.from(`POST /v1/review HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n`), Buffer.from(body)]);
  return { server, seen, host, port: address.port, request };
}
async function exchange(port: number, request: string | Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(request));
    socket.setTimeout(3_000, () => { socket.destroy(); reject(new Error("Source test response timeout")); });
    socket.on("data", chunk => chunks.push(chunk)); socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks)));
  });
}
function response(bytes: Buffer) {
  const split = bytes.indexOf("\r\n\r\n"); assert.ok(split >= 0, "HTTP response headers expected");
  const headers = bytes.subarray(0, split).toString("utf8");
  const body = bytes.subarray(split + 4).toString("utf8");
  const parsed: unknown = JSON.parse(body);
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  assert.match(headers, /\r\nCache-Control: no-store\r\n/i);
  assert.doesNotMatch(headers, /Access-Control-|Set-Cookie:/i);
  assert.match(headers, new RegExp(`\\r\\nContent-Length: ${Buffer.byteLength(body)}(?:\\r\\n|$)`, "i"));
  return { status: Number(headers.split(" ")[1]), body: Object.fromEntries(Object.entries(parsed)), headers };
}
async function open(port: number): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port }); await once(socket, "connect"); return socket;
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(10); }
  assert.fail("Source test condition did not settle");
}

test("loopback health is constant version/trust and never invokes the review owner", async t => {
  const f = await fixture(t);
  const result = response(await exchange(f.port, `GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\n\r\n`));
  assert.equal(result.status, 200); assert.deepEqual(result.body, LOCAL_REVIEW_HEALTH); assert.deepEqual(f.seen, []);
});

test("default dispatcher rejects malformed, duplicate and unknown input before any store IO", async t => {
  const root = mkdtempSync(join(tmpdir(), "pap314-default-http-"));
  const overrides = { PA_AI_USAGE_HOME: join(root, "usage"), PA_PLATFORM_CONFIG: join(root, "config"), PA_PLATFORM_HOME: join(root, "home"), PA_REGISTRY_DB: join(root, "absent.db") };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const f = await fixture(t, "default");
    for (const body of [raw.slice(0, -1), raw.replace('"action":"show"', '"action":"show","action":"show"'), raw.replace('"action":"show"', '"action":"show","actor":"human"')]) {
      const result = response(await exchange(f.port, f.request(body)));
      assert.equal(result.status, 400); assert.equal(result.body.code, "DOCUMENT_INPUT");
      assert.ok(typeof result.body.message === "string" && result.body.message.length <= 2000);
      assert.doesNotMatch(JSON.stringify(result.body), /"actor"|"human"/);
      assert.deepEqual(readdirSync(root), [], "invalid input must not initialize stores");
    }
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST passes identical raw schema bytes unchanged and returns the owner's complete record", async t => {
  const f = await fixture(t, async value => ({ ok: false, code: "OWNER_CONFLICT", exact: value }));
  const duplicate = raw.replace('"action":"show"', '"action":"show","action":"decide"');
  const result = response(await exchange(f.port, f.request(duplicate)));
  assert.equal(result.status, 200); assert.deepEqual(f.seen, [duplicate]);
  assert.deepEqual(result.body, { ok: false, code: "OWNER_CONFLICT", exact: duplicate });
});

test("nonexact/duplicate Host, every Origin, credentials, wrong routes and methods are rejected before core", async t => {
  const f = await fixture(t);
  const cases: [string, number][] = [
    [`GET /v1/health HTTP/1.1\r\nHost: localhost:${f.port}\r\n\r\n`, 400],
    [`GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`, 400],
    [`GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:0${f.port}\r\n\r\n`, 400],
    [`GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\nHost: ${f.host}\r\n\r\n`, 400],
    ["GET /v1/health HTTP/1.0\r\n\r\n", 400],
    ...["null", "", "http://localhost", `http://${f.host}`].map((origin): [string, number] => [`GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\nOrigin: ${origin}\r\n\r\n`, 403]),
    ...["/v1/health?", "/v1/review?token=synthetic", "/v1/health/", "/v1/%68ealth", "/files/x", "/v1/tickets", `http://${f.host}/v1/health`].map((path): [string, number] => [`GET ${path} HTTP/1.1\r\nHost: ${f.host}\r\n\r\n`, 404]),
    ...["POST /v1/health", "GET /v1/review", "OPTIONS /v1/review", "HEAD /v1/health", "DELETE /v1/review"].map((line): [string, number] => [`${line} HTTP/1.1\r\nHost: ${f.host}\r\n\r\n`, 405]),
    [`GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\nContent-Length: 1\r\n\r\nx`, 400],
    ...["Cookie: synthetic=1", "Authorization: synthetic", "Proxy-Authorization: synthetic", "Trailer: Host"].map((header): [string, number] => [`GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\n${header}\r\n\r\n`, 400]),
  ];
  for (const [request, expected] of cases) {
    const bytes = await exchange(f.port, request);
    // HTTP HEAD intentionally has no response body, even on a rejected method.
    if (request.startsWith("HEAD ")) { assert.match(bytes.toString(), /^HTTP\/1\.1 405/); continue; }
    const result = response(bytes); assert.equal(result.status, expected, request.split("\r\n")[0]);
  }
  assert.deepEqual(f.seen, []);
});

test("content type/encoding, oversized headers and declared/streamed bodies are bounded", async t => {
  const f = await fixture(t);
  for (const contentType of ["text/plain", "application/json; charset=latin1", "application/json; profile=x", "application/json\r\nContent-Type: application/json", ""]) {
    const request = `POST /v1/review HTTP/1.1\r\nHost: ${f.host}\r\n${contentType ? `Content-Type: ${contentType}\r\n` : ""}Content-Length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`;
    assert.equal(response(await exchange(f.port, request)).status, 415);
  }
  for (const encoding of ["gzip", "br", "identity", ""]) assert.equal(response(await exchange(f.port, f.request(raw, `Content-Encoding: ${encoding}\r\n`))).status, 415);
  assert.equal(response(await exchange(f.port, `GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\nX-Padding: ${"a".repeat(8192)}\r\n\r\n`)).status, 431);
  assert.equal(response(await exchange(f.port, f.request(Buffer.alloc(65537, 0x61)))).status, 413);
  const chunked = `POST /v1/review HTTP/1.1\r\nHost: ${f.host}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n10001\r\n${"a".repeat(65537)}\r\n0\r\n\r\n`;
  assert.equal(response(await exchange(f.port, chunked)).status, 413);
  assert.deepEqual(f.seen, []);
  assert.equal(response(await exchange(f.port, f.request(Buffer.alloc(65536, 0x61)))).status, 200);
  assert.equal(Buffer.byteLength(f.seen[0]!), 65536);
});

test("strict UTF-8, Expect, upgrade, CONNECT and request trailers do not reach core", async t => {
  const f = await fixture(t);
  for (const bytes of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
    const result = response(await exchange(f.port, f.request(Buffer.from(bytes))));
    assert.equal(result.status, 400); assert.equal(result.body.code, "LOCAL_REVIEW_UTF8");
  }
  for (const request of [f.request(raw, "Expect: 100-continue\r\n"), f.request(raw, "Expect: other\r\n"), `GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`, `CONNECT ${f.host} HTTP/1.1\r\nHost: ${f.host}\r\n\r\n`]) assert.equal(response(await exchange(f.port, request)).status, 405);
  const trailers = `POST /v1/review HTTP/1.1\r\nHost: ${f.host}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(raw).toString(16)}\r\n${raw}\r\n0\r\nHost: ${f.host}\r\n\r\n`;
  assert.equal(response(await exchange(f.port, trailers)).status, 415);
  assert.deepEqual(f.seen, []);
});

test("one operation is admitted from body arrival through reply; overlapping requests are never queued", async t => {
  let resolve!: (value: Record<string, unknown>) => void;
  const f = await fixture(t, () => new Promise(done => { resolve = done; }));
  const first = exchange(f.port, f.request());
  await until(() => f.seen.length === 1);
  const busy = response(await exchange(f.port, f.request()));
  assert.equal(busy.status, 503); assert.equal(busy.body.code, "LOCAL_REVIEW_BUSY");
  assert.equal(response(await exchange(f.port, `GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\n\r\n`)).status, 503);
  assert.equal(f.seen.length, 1);
  resolve({ ok: true }); assert.equal(response(await first).status, 200);
  assert.equal(response(await exchange(f.port, `GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\n\r\n`)).status, 200);
});

test("header and body deadlines reject slow input before invoking core", async t => {
  const f = await fixture(t, undefined, { ioMs: 100, overallMs: 1000 });
  const header = response(await exchange(f.port, "POST /v1/review HTTP/1.1\r\n")); assert.equal(header.status, 408);
  const body = response(await exchange(f.port, `POST /v1/review HTTP/1.1\r\nHost: ${f.host}\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{`));
  assert.equal(body.status, 408); assert.equal(body.body.code, "LOCAL_REVIEW_DEADLINE"); assert.deepEqual(f.seen, []);
});

test("overall timeout preserves the busy slot until an uncertain core operation settles", async t => {
  let resolve!: (value: Record<string, unknown>) => void;
  const f = await fixture(t, () => new Promise(done => { resolve = done; }), { ioMs: 500, overallMs: 100 });
  const expired = response(await exchange(f.port, f.request()));
  assert.equal(expired.status, 504); assert.equal(expired.body.code, "LOCAL_REVIEW_DEADLINE");
  assert.equal(response(await exchange(f.port, f.request())).status, 503); assert.equal(f.seen.length, 1);
  resolve({ ok: true }); await delay(10);
  assert.equal(response(await exchange(f.port, `GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\n\r\n`)).status, 200);
});

test("client disconnect does not free a still-running owner's admission slot", async t => {
  let resolve!: (value: Record<string, unknown>) => void;
  const f = await fixture(t, () => new Promise(done => { resolve = done; }));
  const socket = await open(f.port); socket.write(f.request());
  await until(() => f.seen.length === 1); socket.destroy(); await delay(10);
  assert.equal(response(await exchange(f.port, f.request())).status, 503);
  resolve({ ok: true });
});

test("incomplete request bodies reserve admission and pipelining never runs a second owner", async t => {
  const f = await fixture(t);
  const socket = await open(f.port); t.after(() => socket.destroy());
  socket.on("error", () => {});
  socket.write(`POST /v1/review HTTP/1.1\r\nHost: ${f.host}\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{`);
  await delay(10);
  assert.equal(response(await exchange(f.port, f.request())).status, 503); assert.deepEqual(f.seen, []);
  socket.destroy(); await delay(10);
  const pipelined = await exchange(f.port, Buffer.concat([f.request(), f.request()]));
  assert.ok(f.seen.length <= 1);
  if (pipelined.length) {
    assert.match(pipelined.toString(), /Cache-Control: no-store/i);
    assert.equal(pipelined.toString().split("HTTP/1.1").length - 1, 1);
  }
});

test("16-socket cap rejects additional idle connections without a request queue", async t => {
  const f = await fixture(t);
  const sockets: Socket[] = []; t.after(() => sockets.forEach(socket => socket.destroy()));
  for (let i = 0; i < 16; i++) sockets.push(await open(f.port));
  const extra = await open(f.port); extra.on("error", () => {}); const closed = once(extra, "close"); extra.resume();
  await closed; assert.deepEqual(f.seen, []);
});

test("write deadline closes a backpressured reply and releases completed owner work", async t => {
  const f = await fixture(t, async () => ({ ok: true, data: "a".repeat(16 * 1024 * 1024) }), { ioMs: 100, overallMs: 2000 });
  const socket = await open(f.port); t.after(() => socket.destroy()); socket.pause(); socket.write(f.request());
  await until(() => f.seen.length === 1);
  await until(() => new Promise<boolean>((resolve, reject) => f.server.getConnections((error, count) => error ? reject(error) : resolve(count === 0))));
  assert.equal(response(await exchange(f.port, `GET /v1/health HTTP/1.1\r\nHost: ${f.host}\r\n\r\n`)).status, 200);
});

test("oversized responses and arbitrary owner exceptions become bounded safe JSON, never partial content", async t => {
  for (const handler of [async () => ({ data: "a".repeat(LOCAL_REVIEW_MAX_RESPONSE) }), async () => { throw new Error("SYNTHETIC_PRIVATE"); }, async () => { throw new Proxy({}, { get() { throw new Error("SYNTHETIC_PRIVATE"); }, getPrototypeOf() { throw new Error("SYNTHETIC_PRIVATE"); } }); }]) {
    const f = await fixture(t, handler);
    const result = response(await exchange(f.port, f.request()));
    assert.equal(result.status, 500); assert.ok(typeof result.body.message === "string" && result.body.message.length <= 2000);
    assert.doesNotMatch(JSON.stringify(result.body), /SYNTHETIC_PRIVATE/);
    assert.equal("data" in result.body, false);
  }
});

test("listener failures and invalid test limits fail safely without broader binding", async t => {
  const f = await fixture(t);
  await assert.rejects(startLocalReviewServer({ port: f.port }), /listen/);
  for (const port of [-1, 65536, 0.5]) await assert.rejects(startLocalReviewServer({ port }));
  await assert.rejects(startLocalReviewServer({ port: 0, deadlines: { ioMs: 5001 } }));
});
