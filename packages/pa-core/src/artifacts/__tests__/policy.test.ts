import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARTIFACT_DIAGNOSTICS, ARTIFACT_POLICY_VERSION, ARTIFACT_SOURCE_MAX_BYTES,
  ArtifactPolicyError, artifactDiagnostic, assertArtifactAbsolutePath,
  assertArtifactCapability, assertArtifactEnvironment, assertArtifactSourceSize,
  assertManagedReviewAvailable, parseArtifactFeedbackTimeout,
} from "../policy.js";

function rejects(fn: () => unknown, diagnostic: keyof typeof ARTIFACT_DIAGNOSTICS): void {
  assert.throws(fn, (error: unknown) => error instanceof ArtifactPolicyError
    && error.diagnostic === diagnostic && error.exitCode === ARTIFACT_DIAGNOSTICS[diagnostic].exitCode);
}

test("exact approved diagnostic exit mapping; no supplied values appear in errors", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(ARTIFACT_DIAGNOSTICS).map(([key, value]) => [key, value.exitCode])), {
    ARTIFACT_USAGE_INVALID: 2, ARTIFACT_SOURCE_INVALID: 2, ARTIFACT_RUNTIME_REQUIRED: 3,
    ARTIFACT_BROWSER_REQUIRED: 3, ARTIFACT_STALE: 4, ARTIFACT_POLICY_REJECTED: 5,
    ARTIFACT_OWNER_CONFLICT: 6, ARTIFACT_RUNTIME_FAILED: 7, ARTIFACT_OUTPUT_CONFLICT: 8,
  });
  for (const code of Object.keys(ARTIFACT_DIAGNOSTICS) as (keyof typeof ARTIFACT_DIAGNOSTICS)[]) {
    const error = artifactDiagnostic(code);
    assert.equal(error.message, `${code}: ${ARTIFACT_DIAGNOSTICS[code].message}`);
    assert.ok(!error.message.includes("secret-sentinel"));
  }
  assert.equal(ARTIFACT_POLICY_VERSION, "pa-artifact-policy/v1");
});

test("all known and unknown routes/capabilities fail closed across transports", () => {
  for (const transport of ["cli", "http", "websocket", "ui", "unknown"]) {
    for (const capability of ["share", "upload", "update", "setup", "serve-file", "review-start", "feedback", "", "unknown"]) {
      rejects(() => assertArtifactCapability(transport, capability), "ARTIFACT_POLICY_REJECTED");
    }
  }
});

test("selection is neither confinement nor permission to execute upstream", () => {
  rejects(() => assertManagedReviewAvailable(false, {}), "ARTIFACT_RUNTIME_REQUIRED");
  rejects(() => assertManagedReviewAvailable(true, {}), "ARTIFACT_POLICY_REJECTED");
  rejects(() => assertManagedReviewAvailable(true, { LAVISH_AXI_NO_OPEN: "1" }), "ARTIFACT_POLICY_REJECTED");
});

test("unsafe inherited configuration rejects even empty values or ostensibly safe assertions", () => {
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "LD_LIBRARY_PATH",
    "LAVISH_AXI_HOST", "LAVISH_AXI_STATE_DIR", "LAVISH_AXI_TELEMETRY", "LAVISH_AXI_NO_OPEN", "LAVISH_AXI_FUTURE"]) {
    for (const value of ["", "1", "secret-sentinel"]) {
      rejects(() => assertArtifactEnvironment({ [key]: value }), "ARTIFACT_POLICY_REJECTED");
    }
  }
  assertArtifactEnvironment({ NODE_OPTIONS: undefined, TZ: "UTC" });
});

test("lexical paths reject traversal, alias forms and hidden NUL; do not grant filesystem authority", () => {
  for (const path of ["", ".", "relative.md", "/", "/a/../b", "/a/./b", "//a", "/a//b", "/a/", "/a\0b", "/a\\b"]) {
    rejects(() => assertArtifactAbsolutePath(path), "ARTIFACT_USAGE_INVALID");
  }
  assertArtifactAbsolutePath("/approved-root/source.md");
  assertArtifactAbsolutePath("/approved-root/Unicode-文档.md");
});

test("source byte cap is inclusive and timeout grammar is strict", () => {
  for (const bytes of [0, 1, ARTIFACT_SOURCE_MAX_BYTES]) assertArtifactSourceSize(bytes);
  for (const bytes of [-1, 0.5, NaN, Infinity, ARTIFACT_SOURCE_MAX_BYTES + 1]) {
    rejects(() => assertArtifactSourceSize(bytes), "ARTIFACT_SOURCE_INVALID");
  }
  assert.equal(parseArtifactFeedbackTimeout(undefined), 1000);
  assert.equal(parseArtifactFeedbackTimeout("0"), 0);
  assert.equal(parseArtifactFeedbackTimeout("30000"), 30000);
  for (const value of ["", "-1", "1.5", "1e3", "0x10", " 1", "1 ", "+1", "01", "30001", "Infinity"]) {
    rejects(() => parseArtifactFeedbackTimeout(value), "ARTIFACT_USAGE_INVALID");
  }
});

test("isolated closure covers every locked package, exact root integrity and license records", () => {
  const root = new URL("../../../../../nix/axi/lavish-axi/", import.meta.url);
  const lock: { lockfileVersion: number; packages: Record<string, { version: string; resolved?: string; integrity?: string; hasInstallScript?: boolean }> } = JSON.parse(
    readFileSync(new URL("package-lock.json", root), "utf8"));
  const inventory: { packages: { path: string; version: string; url: string; integrity: string; sha256: string; license: string; licenseFiles: { path: string; sha256: string }[] }[] } = JSON.parse(
    readFileSync(new URL("integrity.json", root), "utf8"));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(inventory.packages.length, 91);
  assert.deepEqual(inventory.packages.map((entry) => entry.path).sort(), Object.keys(lock.packages).filter(Boolean).sort());
  for (const entry of inventory.packages) {
    const locked = lock.packages[entry.path]!;
    assert.equal(entry.version, locked.version);
    assert.equal(entry.url, locked.resolved);
    assert.equal(entry.integrity, locked.integrity);
    assert.ok(!locked.hasInstallScript);
    assert.ok(entry.license && entry.licenseFiles.length);
    assert.match(entry.sha256, /^sha256-[A-Za-z0-9+/]{43}=$/);
    for (const license of entry.licenseFiles) assert.match(license.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(inventory.packages.reduce((count, entry) => count + entry.licenseFiles.length, 0), 92);
  const lavish = inventory.packages.find((entry) => entry.path === "node_modules/lavish-axi")!;
  assert.equal(lavish.version, "0.1.67");
  assert.equal(lavish.sha256, "sha256-sEvY7qcezoJMpdxoN8mN4ENyt2ymoo/m4aGrAl5QrP0=");
  assert.equal(lavish.integrity, "sha512-7qU7tF1ShNQEQY3SMceNkIR2T1Iuy3kOvatoOgPwUW1QJuXoi+vzF5NOiDSt7xMfNaKJMNLefY856yylFxOxHg==");
});

test("recorded native gate is fixed, has no upstream/interpreter execution path, and is digest-bound", () => {
  const root = new URL("../../../../../nix/axi/lavish-axi/", import.meta.url);
  const gate = readFileSync(new URL("adaptations/managed-entrypoint.c", root));
  const inventory: { adaptations: { path: string; sha256: string }[] } = JSON.parse(
    readFileSync(new URL("adaptations.json", root), "utf8"));
  const record = inventory.adaptations.find((item) => item.path === "adaptations/managed-entrypoint.c");
  assert.equal(record?.sha256, createHash("sha256").update(gate).digest("hex"));
  assert.doesNotMatch(gate.toString(), /\b(exec[a-z]*|system|popen|socket|fopen|open|kill|fork)\s*\(/);
  assert.match(gate.toString(), /ARTIFACT_POLICY_REJECTED/);
  assert.match(gate.toString(), /ARTIFACT_USAGE_INVALID/);
  // Source assertions are NOT installed-output or confinement acceptance.
});
