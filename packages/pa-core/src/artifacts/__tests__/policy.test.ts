import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import test from "node:test";
import {
  ARTIFACT_DIAGNOSTICS, ARTIFACT_POLICY_VERSION, ARTIFACT_SOURCE_MAX_BYTES,
  ArtifactPolicyError, artifactDiagnostic, assertArtifactAbsolutePath,
  assertArtifactCapability, assertArtifactEnvironment, assertArtifactSourceSize,
  assertManagedReviewAvailable, parseArtifactFeedbackTimeout,
} from "../policy.js";

import { isReviewClosurePath } from "../runtime.js";

test("immutable asset admission matches native static derivation names, not writable lookalikes", () => {
  const hash = "sc7aibhzzck5w47xd33znfwxdgycb1g3";
  for (const arch of ["x86_64", "aarch64"]) assert.equal(isReviewClosurePath(`/nix/store/${hash}-lavish-axi-static-${arch}-unknown-linux-musl-0.1.67`), true);
  for (const path of [`/tmp/${hash}-lavish-axi-static-x86_64-unknown-linux-musl-0.1.67`,
    `/nix/store/${hash}-lavish-axi-0.1.67`, `/nix/store/${hash}-lavish-axi-static-unknown-0.1.67`,
    `/nix/store/${hash}-lavish-axi-static-x86_64-unknown-linux-musl-0.1.68`,
    `/nix/store/${hash}-lavish-axi-static-x86_64-unknown-linux-musl-0.1.67/extra`]) assert.equal(isReviewClosurePath(path), false);
});

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

test("phase-3 helpers are digest-bound; genuine pinned annotation/queue extraction is narrowly asserted", () => {
  const root = new URL("../../../../../nix/axi/lavish-axi/", import.meta.url);
  const inventory: { adaptations: { path: string; sha256: string }[]; phase3: { sourceFiles: Record<string, string> } } = JSON.parse(readFileSync(new URL("adaptations.json", root), "utf8"));
  const packaging = readFileSync(new URL("../../../../../nix/axi-tools.nix", import.meta.url), "utf8");
  assert.match(packaging, /\$\{records\}\/generate-inventory\.py/); // actual installed bytes checked separately
  for (const entry of inventory.adaptations) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(entry.path, root))).digest("hex"), entry.sha256, entry.path);
  }
  const generator = readFileSync(new URL("adaptations/adapt-upstream.py", root), "utf8");
  for (const digest of Object.values(inventory.phase3.sourceFiles)) assert.ok(generator.includes(digest));
  for (const retained of ["function selector(el)", "function closestElement(node)", "function persistQueuedPrompts()", "function promptTargetLabel(prompt)", "async function submitQueuedOnce()", '"mouseup"']) assert.ok(generator.includes(retained), retained);
  assert.match(generator, /text\.count\(old\) == 1/);
  assert.match(generator, /text\.count\(start\) == 1/);
  assert.match(generator, /document !== frame\.contentDocument/);
  assert.match(generator, /ack\.eventIds/);
  assert.doesNotMatch(generator, /subprocess|exec\(|eval\(/);
  // These are source assertions, not generated/installed/browser qualification.
});

test("trusted outer frame remains scriptless, UI glue has no messaging/forbidden effect paths", () => {
  const root = new URL("../../../../../nix/axi/lavish-axi/adaptations/", import.meta.url);
  const html = readFileSync(new URL("outer.html", root), "utf8");
  const glue = readFileSync(new URL("outer.js", root), "utf8");
  assert.match(html, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(html, /allow-scripts|allow-forms|allow-popups|allow-downloads|<form|https?:/);
  assert.doesNotThrow(() => new Script(glue)); // syntax only; no DOM execution
  assert.doesNotMatch(glue, /postMessage\(|WebSocket\(|sendBeacon\(|eval\(|innerHTML|\.src\s*=/);
  const routes = [...glue.matchAll(/fetch\("([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(routes, ["api/activity", "api/end", "api/status"]);
  assert.match(glue, /unsent text is retained/);
  assert.match(glue, /sending = true/);
});

test("a refused generated submission cannot display a durable acknowledgement or consume queued text", async () => {
  const glue = readFileSync(new URL("../../../../../nix/axi/lavish-axi/adaptations/outer.js", import.meta.url), "utf8");
  const listeners = new Map<string, () => Promise<void>>();
  const elements = new Map<string, { textContent: string; disabled: boolean; addEventListener: (event: string, fn: () => Promise<void>) => void }>();
  for (const id of ["artifact", "annotationPills", "chatInput", "send", "queue", "end", "notice", "target"]) {
    elements.set(id, { textContent: "", disabled: false, addEventListener: (event, fn) => { listeners.set(`${id}:${event}`, fn); } });
  }
  const context = createContext({ document: { body: { dataset: { config: JSON.stringify({ sessionId: "synthetic", identity: {}, anchors: [] }) } }, getElementById: (id: string) => elements.get(id) },
    sessionStorage: { getItem: () => null }, setInterval: () => 1, render: () => {}, submitQueuedOnce: async () => false });
  new Script(glue).runInContext(context);
  new Script('queued = [{ eventId: "synthetic-rejected-001", prompt: "Unsent synthetic feedback" }];').runInContext(context);
  await listeners.get("send:click")!();
  assert.doesNotMatch(elements.get("notice")!.textContent, /Durably acknowledged/);
  assert.match(elements.get("notice")!.textContent, /not acknowledged/);
  assert.equal(new Script("queued.length").runInContext(context), 1);
  assert.equal(new Script("queued[0].eventId").runInContext(context), "synthetic-rejected-001");
  assert.equal(new Script("queued[0].prompt").runInContext(context), "Unsent synthetic feedback");
});

test("outer End reports non-OK/malformed confirmations and remains retryable while stale", async () => {
  const glue = readFileSync(new URL("../../../../../nix/axi/lavish-axi/adaptations/outer.js", import.meta.url), "utf8");
  for (const response of [{ ok: false, status: 409, body: { diagnostic: "ARTIFACT_OWNER_CONFLICT" } },
    { ok: false, status: 400, body: {} }, { ok: true, status: 200, body: { status: "running" } },
    { ok: true, status: 200, body: { status: "ended" } }]) {
    const listeners = new Map<string, () => Promise<void>>();
    const elements = new Map<string, { textContent: string; value: string; disabled: boolean; addEventListener: (event: string, fn: () => Promise<void>) => void }>();
    for (const id of ["artifact", "annotationPills", "chatInput", "send", "queue", "end", "notice", "target"]) {
      elements.set(id, { textContent: "", value: "", disabled: false, addEventListener: (event, fn) => { listeners.set(`${id}:${event}`, fn); } });
    }
    const context = createContext({ document: { body: { dataset: { config: JSON.stringify({ sessionId: "synthetic", identity: {}, anchors: [] }) } }, getElementById: (id: string) => elements.get(id) },
      sessionStorage: { getItem: () => null }, setInterval: () => 1, render: () => {},
      fetch: async () => ({ ...response, json: async () => response.body }) });
    new Script(glue).runInContext(context);
    new Script("frozen = true;").runInContext(context);
    await listeners.get("end:click")!();
    if (response.ok && response.body.status === "ended") assert.equal(new Script("ended").runInContext(context), true);
    else {
      assert.match(elements.get("notice")!.textContent, /Could not confirm/);
      assert.equal(new Script("ended").runInContext(context), false);
      assert.equal(elements.get("end")!.disabled, false);
    }
  }
});

test("all three adapters provide only shared artifact lifecycle metadata including background persistence", () => {
  const root = new URL("../../../../", import.meta.url);
  for (const adapter of ["pi-pa", "opencode-pa", "claudecode-pa"]) {
    const source = readFileSync(new URL(`${adapter}/src/adapter.ts`, root), "utf8");
    assert.match(source, /PA_ARTIFACT_ADAPTER/);
    assert.match(source, /PA_ARTIFACT_OWNER_PID/);
    assert.match(source, /opts\.mode === "background" \? "background" : String\(process\.pid\)/);
    if (adapter !== "pi-pa") assert.doesNotMatch(source, /axiRuntimeEnvironment/);
  }
});
