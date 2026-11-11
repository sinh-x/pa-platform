import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { isPublicAddress, validatePublicUrl } from "../public-web/policy.js";
import { PublicWebError, WEB_LIMITS, publicWebDiagnostic } from "../public-web/types.js";
import { readPublicWeb, PublicWebSession, type PublicWebDependencies } from "../public-web/reader.js";
import { decodePublicBody } from "../public-web/transport.js";
import { extractPublicText } from "../public-web/extract.js";

const patterns = { configPath: "synthetic", patterns: [] };
const safe = "https://www.public-site.com/page";
function fixture(body = "Public fixture", contentType = "text/plain; charset=utf-8") {
  const requests: string[] = [];
  const dependencies: PublicWebDependencies = {
    resolve: async () => ["93.184.216.34"],
    fetch: async (url, address) => {
      assert.equal(address, "93.184.216.34"); requests.push(url.href);
      return { status: 200, headers: { "content-type": contentType }, body: Buffer.from(body), compressedBytes: Buffer.byteLength(body) };
    },
    patterns: () => patterns,
  };
  return { dependencies, requests };
}
const read = (dependencies: PublicWebDependencies, url = safe, signal?: AbortSignal) => readPublicWeb(url, "pi-tool-result:fixture/call-1", signal, dependencies);

test("public destinations: conservative IPv4/IPv6 boundary and obfuscated URL rejection", () => {
  for (const ip of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.9", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.175.48.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:93.184.216.34", "64:ff9b::1", "fc00::1", "fe80::1", "ff00::1", "2001:db8::1", "2001::1", "2002:5db8:d822::1", "2620:4f:8000::1", "3fff::1", "not-an-ip"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ["http://www.public-site.com/", "https://localhost/", "https://foo.local/", "https://intranet/", "https://127.1/", "https://2130706433/", "https://0x5db8d822/", "https://093.184.216.34/", "https://user:pass@www.public-site.com/", "https://www.public-site.com:444/", "https://www.public-site.com/#fragment", "https://www.public-site.com\\@internal/", " https://www.public-site.com/", "https://www.public-site.com/%0a", "https://www.public-site.com/?token=synthetic", "https://www.public-site.com/?%61pi_key=synthetic"]) assert.throws(() => validatePublicUrl(url, patterns), PublicWebError, url);
  assert.equal(validatePublicUrl(safe, patterns).href, safe);
  const prefix = "https://www.public-site.com/";
  assert.doesNotThrow(() => validatePublicUrl(prefix + "a".repeat(4096 - prefix.length), patterns));
  assert.throws(() => validatePublicUrl(prefix + "a".repeat(4097 - prefix.length), patterns));
  assert.throws(() => validatePublicUrl(prefix + "é".repeat(2048), patterns));
  assert.throws(() => validatePublicUrl(prefix + "é".repeat(1000), patterns), "encoded request target must also fit 4096 bytes");
});

test("every DNS answer and redirect is checked before connector; no retries/crawls", async () => {
  for (const addresses of [["93.184.216.34", "127.0.0.1"], ["::1"], [], Array(65).fill("93.184.216.34")]) {
    const f = fixture(); f.dependencies.resolve = async () => addresses;
    const result = await read(f.dependencies); assert.equal(result.ok, false); assert.deepEqual(f.requests, []);
  }
  const f = fixture(); let count = 0;
  f.dependencies.fetch = async url => { f.requests.push(url.href); return { status: 302, headers: { location: "https://127.0.0.1/" }, body: Buffer.alloc(0), compressedBytes: 0 }; };
  assert.equal((await read(f.dependencies)).ok, false); assert.equal(f.requests.length, 1);
  f.dependencies.fetch = async url => { count++; return { status: 302, headers: { location: `/page${count}` }, body: Buffer.alloc(0), compressedBytes: 0 }; };
  const tooMany = await read(f.dependencies); assert.equal(tooMany.ok, false); assert.equal(count, 6);
  count = 0;
  f.dependencies.fetch = async url => { count++; return count <= 5 ? { status: 302, headers: { location: `/page${count}` }, body: Buffer.alloc(0), compressedBytes: 0 } : { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("after redirects"), compressedBytes: 15 }; };
  const result = await read(f.dependencies); assert.equal(result.ok, true); assert.equal(count, 6);
  for (const location of ["http://www.public-site.com/", "https://2130706433/", "//0x7f000001/", "https://www.public-site.com:444/", "https://user:pass@www.public-site.com/", "https://www.public-site.com/?secret=synthetic", "//private.internal/", "https://www.public-site.com/\\nextra"]) {
    let requests = 0;
    f.dependencies.fetch = async () => { requests++; return { status: 302, headers: { location }, body: Buffer.alloc(0), compressedBytes: 0 }; };
    assert.equal((await read(f.dependencies)).ok, false, location); assert.equal(requests, 1);
  }
  let lookups = 0, requests = 0;
  f.dependencies.resolve = async () => ++lookups === 1 ? ["93.184.216.34"] : ["10.0.0.1"];
  f.dependencies.fetch = async () => { requests++; return { status: 302, headers: { location: "/next" }, body: Buffer.alloc(0), compressedBytes: 0 }; };
  assert.equal((await read(f.dependencies)).ok, false); assert.equal(lookups, 2); assert.equal(requests, 1);
});

test("HTML extraction is inert, bounded, attributed and never claims rendered-page completeness", async () => {
  const f = fixture('<!doctype html><html><head><title>Fixture &amp; source</title><style>bad style</style></head><body><h1>Answer</h1><p>The value is 42.</p><script>evil()</script><iframe>bad iframe</iframe><form>bad form</form><svg>bad svg</svg><!-- hidden --><p>&#27;[31mtext &#x202e; end</p></body></html>', "text/html");
  const result = await read(f.dependencies); assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /The value is 42/); assert.doesNotMatch(result.text, /evil|bad |hidden|\x1b|\u202e|<script>/);
  assert.equal(result.title, "Fixture & source"); assert.equal(result.requestedUrl, safe); assert.equal(result.finalUrl, safe);
  assert.equal(result.evidence, "pi-tool-result:fixture/call-1"); assert.equal(result.textSha256, createHash("sha256").update(result.text).digest("hex"));
  assert.equal(result.coverage.kind, "static-text-not-rendered"); assert.equal(result.coverage.clipped, false); assert.equal(f.requests.length, 1);
  assert.match(result.retrievedAt, /^\d{4}-.*Z$/);
  for (const html of ['<script>only JS</script>', '<form><input type="password"></form>', '<html>Just a moment... cf-chl-challenge</html>']) await assert.rejects(() => extractPublicText(html, "text/html"), PublicWebError);
});

test("provider composite call IDs retain exact bounded inert evidence locators; malformed evidence stays pre-network", async () => {
  const f = fixture(); let lookups = 0;
  f.dependencies.resolve = async () => { lookups++; return ["93.184.216.34"]; };
  for (const evidence of ["pi-tool-result:d-1842c8/call_fixture|fc_fixture", "pi-tool-result:d-1842c8/call_fixture|fc_fixture/1", `pi-tool-result:${"a".repeat(255)}|`]) {
    const result = await readPublicWeb(safe, evidence, undefined, f.dependencies);
    assert.equal(result.ok, true, evidence);
    if (result.ok) assert.equal(result.evidence, evidence, "locator preserves the transcript ID without splitting or lossy replacement");
  }
  assert.equal(lookups, 3); assert.equal(f.requests.length, 3);
  for (const evidence of ["pi-tool-result:call\nforged", "pi-tool-result:call\u001b[31m", "pi-tool-result:call\u202e", "pi-tool-result:call<markup>", `pi-tool-result:${"a".repeat(256)}|`, "https://untrusted.example/locator"]) {
    const result = await readPublicWeb(safe, evidence, undefined, f.dependencies);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.code, "WEB_INPUT"); assert.equal(result.stage, "not-started"); assert.equal(result.cleanup, "settled"); }
    assert.equal(lookups, 3); assert.equal(f.requests.length, 3);
    assert.ok(!JSON.stringify(result).includes("forged"));
  }
});

test("HTML suppression survives self-closing syntax, pseudo end tags and nested active text", async () => {
  for (const tag of ["script", "style", "template", "iframe", "object", "form", "noscript"]) {
    const html = `<${tag}/>suppressed payload</${tag}><p>Visible article.</p>`;
    const result = await read(fixture(html, "text/html").dependencies);
    assert.equal(result.ok, true, tag);
    if (result.ok) assert.equal(result.text, "Visible article.", tag);
    await assert.rejects(() => extractPublicText(`<${tag}/>suppressed payload`, "text/html"), PublicWebError, tag);
  }
  for (const html of [
    '<div hidden/>suppressed payload</div><p>Visible article.</p>',
    '<div aria-hidden="true"/>suppressed payload</div><p>Visible article.</p>',
    '<div hidden><div/>nested payload</div>suppressed payload</div><p>Visible article.</p>',
    '<script>suppressed < /script>still suppressed</script><p>Visible article.</p>',
    '<style>suppressed </ style>still suppressed</style><p>Visible article.</p>',
    '<div hidden><script>const text = "</div>";</script>suppressed payload</div><p>Visible article.</p>',
    '<form><style>/* </form> */</style>suppressed payload</form><p>Visible article.</p>',
    '<template><iframe>fake </template> end</iframe>suppressed payload</template><p>Visible article.</p>',
    '<div hidden><script>const text = "<style>";</script>suppressed payload</div><p>Visible article.</p>',
  ]) {
    assert.equal((await extractPublicText(html, "text/html")).text, "Visible article.", html);
  }
  for (const tag of ["textarea", "title", "xmp", "noembed", "iframe", "noscript"]) {
    const html = `<div hidden><${tag}>fake </div> end</${tag}>suppressed payload</div><p>Visible article.</p>`;
    assert.equal((await extractPublicText(html, "text/html")).text, "Visible article.", tag);
  }
  await assert.rejects(() => extractPublicText('<div hidden><plaintext>fake </div> payload', "text/html"), PublicWebError);
  // Void elements do not own subsequent text, even with a hidden attribute.
  assert.equal((await extractPublicText('<input hidden><img hidden/><p>Visible article.</p>', "text/html")).text, "Visible article.");
});

test("body/output limits count bytes, code points and serialized tool reply, with explicit clipping", async () => {
  for (const body of ["😀".repeat(20000), "\"\\".repeat(20000), "x\n".repeat(20000)]) {
    const result = await read(fixture(body).dependencies); assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.ok(Array.from(result.text).length <= 16000); assert.ok(result.text.split("\n").length <= 2000); assert.equal(result.coverage.clipped, true);
    const reply = { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 50 * 1024);
  }
  const atLimit = Buffer.alloc(WEB_LIMITS.bodyBytes, 97);
  assert.equal((await decodePublicBody(atLimit, "identity")).length, WEB_LIMITS.bodyBytes);
  await assert.rejects(() => decodePublicBody(Buffer.alloc(WEB_LIMITS.bodyBytes + 1), "identity"), PublicWebError);
  await assert.rejects(() => decodePublicBody(gzipSync(Buffer.alloc(WEB_LIMITS.bodyBytes + 1, 97)), "gzip"), PublicWebError);
  assert.equal((await decodePublicBody(gzipSync(Buffer.from("safe")), "gzip")).toString(), "safe");
  await assert.rejects(() => decodePublicBody(Buffer.from("bad gzip"), "gzip"));
  for (const [encoding, encode] of [["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
    assert.equal((await decodePublicBody(encode(Buffer.from("safe")), encoding)).toString(), "safe");
    await assert.rejects(() => decodePublicBody(encode(Buffer.alloc(WEB_LIMITS.bodyBytes + 1, 97)), encoding), PublicWebError);
  }
  await assert.rejects(() => decodePublicBody(Buffer.from("safe"), "unsupported"), PublicWebError);
});

test("sensitive outbound URLs and typed failure details stay blocked; unsupported/error responses are not page text", async () => {
  const canary = "synthetic-secret-canary";
  const f = fixture(canary); f.dependencies.patterns = () => ({ configPath: "synthetic", patterns: [{ inputClass: "content", source: "local-config", regex: /synthetic-secret-canary/ }] });
  const result = await read(f.dependencies); assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.text, canary); assert.equal(result.source, "public-web-response"); }
  const input = await read(f.dependencies, safe + "?q=" + canary); assert.equal(input.ok, false); assert.equal(f.requests.length, 1);
  if (!input.ok) { assert.equal(input.code, "WEB_SENSITIVE"); assert.equal(input.source, "supplied-url"); }
  assert.ok(!JSON.stringify(input).includes(canary));
  for (const status of [401, 403, 404, 429, 500, 204, 206]) {
    const e = fixture(); e.dependencies.fetch = async () => ({ status, headers: { "content-type": "text/plain" }, body: Buffer.from(canary), compressedBytes: 23 });
    const failure = await read(e.dependencies); assert.equal(failure.ok, false); assert.ok(!JSON.stringify(failure).includes(canary));
  }
  for (const type of ["application/pdf", "application/octet-stream", "text/html; charset=shift_jis"]) assert.equal((await read(fixture("fixture", type).dependencies)).ok, false);
  f.dependencies.resolve = async () => { throw new Error(canary); };
  assert.ok(!JSON.stringify(await read(f.dependencies)).includes(canary));
  for (const code of ["WEB_POLICY", "WEB_INPUT", "WEB_TARGET", "WEB_SENSITIVE", "WEB_UNSUPPORTED", "WEB_LIMIT", "WEB_NETWORK", "WEB_HTTP", "WEB_CANCELLED", "WEB_TIMEOUT", "WEB_BUSY", "WEB_CLEANUP"] as const) {
    const message = publicWebDiagnostic(code, "requested"); assert.ok(message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(message.split(label + ":").length - 1, 1);
  }
});

test("cancellation, concurrency and uncertain cleanup preserve owned work across repeated calls", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  const cancelled = await read(f.dependencies, safe, controller.signal); assert.equal(cancelled.ok, false); assert.equal(f.requests.length, 0);
  const session = new PublicWebSession(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.dependencies.fetch = async () => { await pending; return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("done"), compressedBytes: 4 }; };
  const one = session.read(safe, "pi-tool-result:fixture/1", undefined, f.dependencies), two = session.read(safe, "pi-tool-result:fixture/2", undefined, f.dependencies);
  const three = await session.read(safe, "pi-tool-result:fixture/3", undefined, f.dependencies); assert.equal(three.ok, false); if (!three.ok) assert.equal(three.code, "WEB_BUSY");
  release(); assert.equal((await one).ok, true); assert.equal((await two).ok, true);
  f.dependencies.fetch = async () => { throw new PublicWebError("WEB_CLEANUP"); };
  assert.equal((await session.read(safe, "pi-tool-result:fixture/4", undefined, f.dependencies)).ok, false);
  const blocked = await session.read(safe, "pi-tool-result:fixture/5", undefined, f.dependencies); assert.equal(blocked.ok, false); if (!blocked.ok) assert.equal(blocked.code, "WEB_CLEANUP");
  await session.close(); assert.equal(session.reopen(), false, "reload cannot clear unknown cleanup");
  const settled = new PublicWebSession(); await settled.close(); assert.equal(settled.reopen(), true);
  assert.equal((await settled.read(safe, "pi-tool-result:fixture/6", undefined, fixture().dependencies)).ok, true);
});

test("end-to-end deadline includes DNS/extraction checkpoints, and sensitive-policy failure is pre-network", async () => {
  assert.ok(WEB_LIMITS.requestMs + WEB_LIMITS.cleanupMs <= WEB_LIMITS.timeoutMs, "cleanup must fit inside the total deadline");
  const f = fixture(); let clock = 0;
  f.dependencies.now = () => clock;
  f.dependencies.resolve = async () => { clock = WEB_LIMITS.requestMs; return ["93.184.216.34"]; };
  const timeout = await read(f.dependencies); assert.equal(timeout.ok, false); if (!timeout.ok) assert.equal(timeout.code, "WEB_TIMEOUT");
  assert.equal(f.requests.length, 0);
  const broken = fixture(); broken.dependencies.patterns = () => { throw new Error("private config path must not leak"); };
  const unavailable = await read(broken.dependencies); assert.equal(unavailable.ok, false); if (!unavailable.ok) assert.equal(unavailable.code, "WEB_POLICY");
  assert.equal(broken.requests.length, 0); assert.doesNotMatch(JSON.stringify(unavailable), /private config path/);
  for (const html of ["Text<!--unfinished", "Text<script>unfinished", 'Text<tag attr="unfinished', "<title>unfinished"]) await assert.rejects(() => extractPublicText(html, "text/html"), PublicWebError);
});
