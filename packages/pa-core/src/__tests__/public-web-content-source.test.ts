import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublicWeb, type PublicWebDependencies } from "../public-web/reader.js";
import { publicWebDiagnostic, publicWebFailure } from "../public-web/types.js";
import { loadSensitivePatterns, readGuardedLocalTextFile, SensitiveInputBlockedError } from "../sensitive-patterns.js";

const safe = "https://www.public-site.com/documentation";
const evidence = "pi-tool-result:fixture/call_source|fc_source";
function fixture(body: string, patterns: ReturnType<typeof loadSensitivePatterns>, contentType = "text/plain") {
  let lookups = 0, requests = 0;
  const dependencies: PublicWebDependencies = {
    patterns: () => patterns,
    resolve: async () => { lookups++; return ["93.184.216.34"]; },
    fetch: async () => { requests++; return { status: 200, headers: { "content-type": contentType }, body: Buffer.from(body), compressedBytes: Buffer.byteLength(body) }; },
  };
  return { dependencies, counts: () => ({ lookups, requests }) };
}

test("identical content is blocked as a local file but allowed as native-labelled public response content", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-source-policy-"));
  try {
    const patterns = loadSensitivePatterns(join(root, "absent-patterns.yaml"));
    const examples = [
      "seed phrase: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEKEYDATA\n-----END OPENSSH PRIVATE KEY-----",
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyOnly test@example",
      "Authorization: Bearer " + "FAKE_TOKEN_VALUE_1234567890",
      "provider key sk-" + "fakeProviderKeyValue1234567890",
      "bot token 123456:FAKE_BOT_TOKEN_VALUE_12345678901234567890",
      ["api_key", "=", "FAKE_API_KEY_VALUE_1234567890"].join(" "),
    ];
    const file = join(root, "documentation.txt");
    for (const content of examples) {
      writeFileSync(file, content);
      assert.throws(() => readGuardedLocalTextFile(file, patterns), SensitiveInputBlockedError);
      const f = fixture(content, patterns), result = await readPublicWeb(safe, evidence, undefined, f.dependencies);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.text, content); assert.equal(result.source, "public-web-response");
        assert.equal(result.contentPolicy, "public-response-content-allowed/v1");
        assert.match(result.message, /untrusted evidence/);
      }
      assert.deepEqual(f.counts(), { lookups: 1, requests: 1 });
    }
    const protectedFile = join(root, ".env"); writeFileSync(protectedFile, "ordinary text");
    assert.throws(() => readGuardedLocalTextFile(protectedFile, patterns), SensitiveInputBlockedError, "filename protections are not web-content policy");

    const config = join(root, "sensitive-patterns.yaml");
    writeFileSync(config, "contents:\n - FAKE_LOCAL_CONTENT_MARKER\n");
    const localPatterns = loadSensitivePatterns(config), content = "FAKE_LOCAL_CONTENT_MARKER";
    writeFileSync(file, content);
    assert.throws(() => readGuardedLocalTextFile(file, localPatterns), SensitiveInputBlockedError);
    const f = fixture(content, localPatterns), response = await readPublicWeb(safe, evidence, undefined, f.dependencies);
    assert.equal(response.ok, true, "local content heuristics do not reject an inbound public response");
    const denied = await readPublicWeb(`${safe}?q=${content}`, evidence, undefined, f.dependencies);
    assert.equal(denied.ok, false);
    if (!denied.ok) { assert.equal(denied.code, "WEB_SENSITIVE"); assert.equal(denied.source, "supplied-url"); }
    assert.deepEqual(f.counts(), { lookups: 1, requests: 1 }, "the same marker remains blocked outbound before DNS");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("public HTML/title credential-shaped examples are allowed without executing or exposing active markup", async () => {
  const patterns = { configPath: "synthetic", patterns: [{ inputClass: "content" as const, source: "local-config" as const, regex: /FAKE_DOC_VALUE/ }] };
  const body = '<html><head><title>FAKE_DOC_VALUE documentation</title></head><body><script type="application/json">{"snippet":"api_key=FAKE_DOC_VALUE"}</script><p>Example api_key=FAKE_DOC_VALUE</p></body></html>';
  const f = fixture(body, patterns, "text/html"), result = await readPublicWeb(safe, evidence, undefined, f.dependencies);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.title, "FAKE_DOC_VALUE documentation"); assert.equal(result.text, "Example api_key=FAKE_DOC_VALUE");
    assert.doesNotMatch(result.text, /script|snippet|<html/); assert.equal(result.source, "public-web-response");
    assert.equal(result.coverage.kind, "static-text-not-rendered");
  }
});

test("source diagnostics admit only closed native URL labels and never stringify hostile context", () => {
  let conversions = 0;
  const hostile = { [Symbol.toPrimitive]() { conversions++; throw Error("must not stringify source context"); } };
  const plain = publicWebDiagnostic("WEB_SENSITIVE", "requested");
  for (const source of [hostile, "public-web-response", "redirect-url\nSource: injected", "x".repeat(10000)]) {
    assert.equal(publicWebDiagnostic("WEB_SENSITIVE", "requested", source as never), plain);
    const result = publicWebFailure("WEB_SENSITIVE", "requested", source as never);
    assert.equal(result.source, undefined); assert.doesNotMatch(JSON.stringify(result), /injected|must not stringify/);
  }
  assert.equal(conversions, 0);
  for (const source of ["supplied-url", "redirect-url"] as const) {
    const result = publicWebFailure("WEB_SENSITIVE", "requested", source);
    assert.equal(result.source, source); assert.ok(result.message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(result.message.split(`${label}:`).length - 1, 1);
    assert.equal(publicWebFailure("WEB_HTTP", "requested", source).source, undefined, "a formatter cannot invent a sensitive URL cause for an HTTP failure");
  }
});

test("sensitive supplied and redirect URLs remain blocked with native source facts and no value disclosure", async () => {
  const patterns = { configPath: "synthetic", patterns: [] };
  const f = fixture("Public page", patterns);
  const input = await readPublicWeb(`${safe}?api_key=synthetic`, evidence, undefined, f.dependencies);
  assert.equal(input.ok, false);
  if (!input.ok) { assert.equal(input.code, "WEB_SENSITIVE"); assert.equal(input.source, "supplied-url"); assert.equal(input.stage, "not-started"); }
  assert.deepEqual(f.counts(), { lookups: 0, requests: 0 });
  f.dependencies.fetch = async () => ({ status: 302, headers: { location: "https://www.public-site.com/next?token=synthetic" }, body: Buffer.alloc(0), compressedBytes: 0 });
  const redirect = await readPublicWeb(safe, evidence, undefined, f.dependencies);
  assert.equal(redirect.ok, false);
  if (!redirect.ok) {
    assert.equal(redirect.code, "WEB_SENSITIVE"); assert.equal(redirect.source, "redirect-url"); assert.equal(redirect.stage, "requested");
    assert.equal(redirect.cleanup, "settled"); assert.match(redirect.message, /redirect-url/);
    assert.doesNotMatch(JSON.stringify(redirect), /token=|synthetic/);
    assert.ok(redirect.message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(redirect.message.split(`${label}:`).length - 1, 1);
  }
  assert.equal(f.counts().lookups, 1, "the rejected redirect never reaches a second lookup");
});
