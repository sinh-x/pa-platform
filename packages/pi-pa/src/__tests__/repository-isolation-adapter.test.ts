import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRegistryEvent, closeDb, getDeployPaths, type ExecutionPlan } from "@pa-platform/pa-core";
import { PiAdapter } from "../adapter.js";

for (const evidence of ["missing", "mismatch", "symlink", "hardlink", "directory", "valid"] as const) test(`Pi direct resume authenticates original native token before probes: ${evidence}`, async () => {
  const previous = process.env, root = mkdtempSync(join(tmpdir(), "pi-isolation-token-")); closeDb();
  process.env = { PATH: previous.PATH, PA_SQLITE_NATIVE_BINDING: previous.PA_SQLITE_NATIVE_BINDING, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
  try {
    const id = "d-334abc";
    appendRegistryEvent({ deployment_id: id, team: "builder", mode: "implement", runtime: "pi", event: "started", timestamp: new Date().toISOString() }); closeDb();
    const dir = getDeployPaths(id).deployDir; mkdirSync(dir, { recursive: true });
    const path = join(dir, "session-id-pi.txt"), primer = join(root, "primer.md"); writeFileSync(primer, "fixture");
    if (evidence !== "missing") writeFileSync(path, evidence === "mismatch" ? "other-native-session" : "original-native-session", { mode: 0o600 });
    if (evidence === "hardlink" || evidence === "symlink") { linkSync(path, join(dir, "alias")); if (evidence === "symlink") { unlinkSync(path); symlinkSync(join(dir, "alias"), path); } }
    if (evidence === "directory") { unlinkSync(path); mkdirSync(path); }
    let probes = 0, commands = 0;
    const adapter = new PiAdapter({ cwd: root, env: {}, versionProbe: () => { probes++; return "0.84.4"; }, nativeRegistryProbe: () => { probes++; return undefined; }, runCommand: () => { commands++; return { status: 0, stdout: "", stderr: "" }; } });
    const result = await adapter.resume({ primerPath: primer, deployId: "d-334def", mode: "dry-run", sessionId: "original-native-session", resumedFromDeploymentId: id });
    assert.equal(result.exitCode, evidence === "valid" ? 0 : 1); assert.equal(commands, evidence === "valid" ? 1 : 0); assert.equal(probes, evidence === "valid" ? 2 : 0);
  } finally { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["foreground", "background", "dry-run"] as const) test(`Pi spawn rejects a protected native token before probes or files: ${mode}`, async () => {
  const previous = process.env, root = mkdtempSync(join(tmpdir(), "pi-spawn-token-")); closeDb();
  process.env = { PATH: previous.PATH, PA_SQLITE_NATIVE_BINDING: previous.PA_SQLITE_NATIVE_BINDING, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
  try {
    const originalId = "d-334abc", protectedToken = "protected-native-session";
    appendRegistryEvent({ deployment_id: originalId, team: "analyst", mode: "analyze", runtime: "pi", event: "started", timestamp: new Date().toISOString() }); closeDb();
    const dir = getDeployPaths(originalId).deployDir; mkdirSync(dir, { recursive: true });
    const tokenPath = join(dir, "session-id-pi.txt"); writeFileSync(tokenPath, protectedToken, { mode: 0o600 });
    const before = readdirSync(root, { recursive: true });
    let effects = 0;
    const adapter = new PiAdapter({ cwd: root, env: {}, versionProbe: () => { effects++; return "0.84.4"; }, nativeRegistryProbe: () => { effects++; return undefined; }, runCommand: () => { effects++; return { status: 0, stdout: "", stderr: "" }; } });
    const result = await adapter.spawn({ primerPath: join(root, "absent/primer.md"), logFile: join(root, "absent/pi.log"), deployId: "d-334def", mode, sessionId: protectedToken, env: { PA_TEAM: "rogue-one", PA_MODE: "rogue-one" } });
    assert.equal(result.exitCode, 1); assert.match(result.errorMessage!, /REPOSITORY_ISOLATION_UNAVAILABLE/);
    assert.equal(effects, 0); assert.deepEqual(readdirSync(root, { recursive: true }), before);
    assert.equal(readFileSync(tokenPath, "utf8"), protectedToken);
  } finally { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); }
});

for (const automatic of [false, true]) test(`Pi fresh session reservation is adapter-owned and single-use (${automatic ? "automatic" : "explicit"})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-spawn-reservation-"));
  try {
    const primerPath = join(root, "primer.md"); writeFileSync(primerPath, "fixture");
    let effects = 0;
    const options = { cwd: root, env: {}, versionProbe: () => { effects++; return "0.84.4"; }, nativeRegistryProbe: () => { effects++; return undefined; }, runCommand: () => { effects++; return { status: 0, stdout: "", stderr: "" }; } };
    const adapter = new PiAdapter(options), otherAdapter = new PiAdapter(options);
    const opts = { primerPath, deployId: "d-334def", mode: "dry-run" as const };
    const sessionId = automatic ? undefined : adapter.allocateSessionId();
    if (sessionId) {
      const foreign = await otherAdapter.spawn({ ...opts, sessionId });
      assert.equal(foreign.exitCode, 1); assert.equal(effects, 0);
    }
    const first = await adapter.spawn({ ...opts, sessionId });
    assert.equal(first.exitCode, 0); assert.ok(first.sessionId); assert.equal(effects, 3);
    const before = readdirSync(root, { recursive: true });
    const replay = await adapter.spawn({ ...opts, primerPath: join(root, "absent/primer.md"), sessionId: first.sessionId });
    assert.equal(replay.exitCode, 1); assert.match(replay.errorMessage!, /REPOSITORY_ISOLATION_UNAVAILABLE/);
    assert.equal(effects, 3); assert.deepEqual(readdirSync(root, { recursive: true }), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi reservation cannot replay after a failed launch or be reissued by the trusted test factory", async () => {
  let probes = 0;
  const adapter = new PiAdapter({ env: {}, sessionIdFactory: () => "trusted-fixture-session", versionProbe: () => { probes++; throw new Error("fixture preflight failed"); }, nativeRegistryProbe: () => undefined });
  const sessionId = adapter.allocateSessionId();
  const opts = { primerPath: "/absent/private/primer", deployId: "d-334def", mode: "foreground" as const, sessionId };
  const first = await adapter.spawn(opts);
  assert.equal(first.exitCode, 1); assert.match(first.errorMessage!, /fixture preflight failed/); assert.equal(probes, 1);
  const replay = await adapter.spawn(opts);
  assert.equal(replay.exitCode, 1); assert.match(replay.errorMessage!, /REPOSITORY_ISOLATION_UNAVAILABLE/); assert.equal(probes, 1);
  assert.throws(() => adapter.allocateSessionId(), /REPOSITORY_ISOLATION_UNAVAILABLE/);
  const automatic = await adapter.spawn({ ...opts, sessionId: undefined });
  assert.equal(automatic.exitCode, 1); assert.match(automatic.errorMessage!, /REPOSITORY_ISOLATION_UNAVAILABLE/); assert.equal(probes, 1);
});

test("Pi reservation is spent before an in-flight launch yields to probes", async () => {
  let probes = 0, release!: () => void;
  const probing = new Promise<string>(resolve => { release = () => resolve("unsupported"); });
  const adapter = new PiAdapter({ env: {}, versionProbe: () => { probes++; return probing; }, nativeRegistryProbe: () => undefined });
  const sessionId = adapter.allocateSessionId();
  const opts = { primerPath: "/absent/private/primer", deployId: "d-334def", mode: "foreground" as const, sessionId };
  const first = adapter.spawn(opts);
  const replay = await adapter.spawn(opts);
  assert.equal(replay.exitCode, 1); assert.match(replay.errorMessage!, /REPOSITORY_ISOLATION_UNAVAILABLE/); assert.equal(probes, 1);
  release(); assert.equal((await first).exitCode, 1);
});

test("Pi plan environment remains restrictive under a writer plan before prompts or probes", async () => {
  let effects = 0;
  const adapter = new PiAdapter({ env: {}, versionProbe: () => { effects++; return "0.84.4"; }, nativeRegistryProbe: () => { effects++; return undefined; }, runCommand: () => { effects++; return { status: 0, stdout: "", stderr: "" }; } });
  // Inconsistent boundary fixture: later execution-plan fields must not be read.
  const plan = { team: "builder", mode: "implement", environment: { PA_TEAM: "requirements", PA_MODE: "analyze" } } as ExecutionPlan;
  const result = await adapter.spawn({ primerPath: "/absent/private/primer", deployId: "d-334abc", mode: "dry-run", executionPlan: plan });
  assert.equal(result.exitCode, 1); assert.match(result.errorMessage!, /REPOSITORY_ISOLATION_UNAVAILABLE/); assert.equal(effects, 0); assert.equal(existsSync("/absent/private/primer"), false);
});
