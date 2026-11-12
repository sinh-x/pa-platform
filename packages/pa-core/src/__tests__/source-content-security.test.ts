import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalFileSource, checkSourceContent, LOCAL_CONTENT_REDACTED, MAX_LOCAL_SECURITY_BYTES, SourceContentSecurityError } from "../source-content-security.js";
import { loadSensitivePatterns, assertNoSensitiveMatch, type SensitivePatternSet } from "../sensitive-patterns.js";

const defaults = () => loadSensitivePatterns(join(tmpdir(), "absent-source-security-patterns-fixture.yaml"));
const source = { kind: "local-tool-output", tool: "read" } as const;
const check = (content: string, patterns = defaults()) => checkSourceContent({ source, content }, patterns);

test("source and content are both required: local path admission precedes readable projections", () => {
  const root = mkdtempSync(join(tmpdir(), "source-security-"));
  try {
    const patterns = defaults();
    patterns.patterns.push({ inputClass: "filename", source: "local-config", regex: /^blocked-note\.txt$/i }, { inputClass: "path", source: "local-config", regex: /blocked-dir/ });
    for (const file of [".env", "blocked-note.txt", "blocked-dir/missing.txt"]) assert.throws(() => assertLocalFileSource(join(root, file), patterns), /LOCAL_SOURCE_BLOCKED/);
    writeFileSync(join(root, "blocked-note.txt"), "ordinary-looking text");
    symlinkSync(join(root, "blocked-note.txt"), join(root, "ordinary-alias.txt"));
    assert.throws(() => assertLocalFileSource(join(root, "ordinary-alias.txt"), patterns), /LOCAL_SOURCE_BLOCKED/);
    assert.throws(() => checkSourceContent({ source: { kind: "local-file", path: join(root, ".env") }, content: "harmless" }, patterns), /LOCAL_SOURCE_BLOCKED/);
    assertLocalFileSource(join(root, "normal-absent.txt"), patterns);
    const file = join(root, "normal.txt"); writeFileSync(file, "plain ordinary source\n");
    assert.deepEqual(checkSourceContent({ source: { kind: "local-file", path: file }, content: "plain ordinary source\n" }, patterns), { source: "local-file", disposition: "allow", content: "plain ordinary source\n" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all built-in sensitive content classes redact complete matching lines, not adjacent ordinary context", () => {
  const cases = [
    "seed phrase: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyOnly fixture",
    ["Authorization:", "Bearer", "FAKE_TOKEN_VALUE_1234567890"].join(" "),
    ["provider ", "sk", "FAKE_SOURCE_PROVIDER_1234567890"].join("-"),
    "bot value 123456:FAKE_BOT_TOKEN_VALUE_12345678901234567890",
    ["api_key", "FAKE_LOCAL_VALUE_1234567890"].join(" = "),
    '\"api_key\": \"FAKE_LOCAL_VALUE_1234567890\"',
  ];
  for (const sensitive of cases) {
    const text = `ordinary before\n${sensitive}\nordinary after\n`, result = check(text);
    assert.equal(result.disposition, "redact");
    assert.equal(result.content, `ordinary before\n${LOCAL_CONTENT_REDACTED}\nordinary after\n`);
    assert.equal(result.content.split("\n").length, text.split("\n").length);
    assert.ok(!result.content.includes("FAKE_"));
  }
});

test("private-key bodies and unterminated tails cannot leak through offset-only reads", () => {
  const header = "-----BEGIN OPENSSH PRIVATE KEY-----", footer = "-----END OPENSSH PRIVATE KEY-----";
  const text = `safe before\n${header}\nopaque-body-not-matching-a-token-regex\nsecond-body-line\n${footer}\nsafe after\n`;
  const result = check(text);
  assert.equal(result.content, `safe before\n${Array(4).fill(LOCAL_CONTENT_REDACTED).join("\n")}\nsafe after\n`);
  assert.equal(result.content.split("\n")[2], LOCAL_CONTENT_REDACTED);
  assert.doesNotMatch(check(`safe\n${header}\nopaque-body\nunclosed tail`).content, /opaque-body|unclosed tail/);
});

test("configured rules, multiline matches, overlapping/global expressions and zero-width rules are deterministic", () => {
  const patterns = defaults();
  patterns.patterns.push({ inputClass: "content", source: "local-config", regex: /FIRST_LOCAL_MARKER[\s\S]*?LAST_LOCAL_MARKER/gi });
  const text = "ordinary\nFIRST_LOCAL_MARKER\nopaque middle\nLAST_LOCAL_MARKER\nordinary last";
  for (let n = 0; n < 3; n++) assert.equal(check(text, patterns).content, `ordinary\n${Array(3).fill(LOCAL_CONTENT_REDACTED).join("\n")}\nordinary last`);
  assert.equal(patterns.patterns.at(-1)!.regex.lastIndex, 0);
  const zero: SensitivePatternSet = { configPath: "fixture", patterns: [{ inputClass: "content", source: "local-config", regex: /^/gm }] };
  assert.doesNotMatch(check("one\ntwo", zero).content, /one|two/);
  const many: SensitivePatternSet = { configPath: "fixture", patterns: [{ inputClass: "content", source: "local-config", regex: /x/g }] };
  assert.equal(check("x".repeat(10001), many).disposition, "withhold");
  assert.throws(() => check("x".repeat(MAX_LOCAL_SECURITY_BYTES + 1)), /LOCAL_CONTENT_LIMIT/);
});

test("trusted public response allowance is source-specific; local claims and malformed sources do not import it", () => {
  const sensitive = ["api_key", "FAKE_LOCAL_VALUE_1234567890"].join(" = ");
  assert.equal(check(sensitive).disposition, "redact");
  assert.equal(checkSourceContent({ source: { kind: "public-web-response" }, content: sensitive }).content, sensitive);
  for (const forged of [{ kind: "public-web-response", path: "/tmp/local-file" }, { kind: "public-web" }, { kind: "local-file" }, { kind: "local-tool-output", tool: "functions/read" }]) {
    assert.throws(() => checkSourceContent({ source: forged as any, content: sensitive }, defaults()));
  }
  // This output projection never turns authority/input validation into sanitization.
  assert.throws(() => assertNoSensitiveMatch("content", sensitive, defaults()));
});

test("policy failures and fixed diagnostics disclose no source, pattern or raw content", () => {
  const root = mkdtempSync(join(tmpdir(), "source-security-policy-")), old = process.env.PA_PLATFORM_CONFIG;
  try {
    const config = join(root, "config"); mkdirSync(config);
    process.env.PA_PLATFORM_CONFIG = config;
    writeFileSync(join(config, "sensitive-patterns.yaml"), "contents:\n - '[INERT_INVALID_REGEX'\n");
    assert.throws(() => checkSourceContent({ source, content: "ordinary" }), error => error instanceof SourceContentSecurityError && error.code === "LOCAL_CONTENT_POLICY" && !error.message.includes("INERT_INVALID"));
  } finally { if (old === undefined) delete process.env.PA_PLATFORM_CONFIG; else process.env.PA_PLATFORM_CONFIG = old; rmSync(root, { recursive: true, force: true }); }
  for (const code of ["LOCAL_SOURCE_BLOCKED", "LOCAL_CONTENT_LIMIT", "LOCAL_CONTENT_POLICY", "CONTENT_SOURCE_INVALID"] as const) {
    const text = new SourceContentSecurityError(code).message;
    assert.ok(text.length <= 2000); assert.ok(!text.includes("\u001b"));
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(text.split(`${label}:`).length, 2);
  }
});
