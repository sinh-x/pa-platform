import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRegistryEvent, closeDb, getDeployPaths, getDeploymentEvents, parseModeCapabilityBinding, type ExecutionPlan } from "@pa-platform/pa-core";
import { OpencodeAdapter } from "../adapter.js";
import { runBackgroundEntry } from "../background-runner.js";

function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const previous = process.env, root = mkdtempSync(join(tmpdir(), "opa-isolation-ingress-")); closeDb();
  process.env = { PATH: previous.PATH, PA_SQLITE_NATIVE_BINDING: previous.PA_SQLITE_NATIVE_BINDING, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
  return run(root).finally(() => { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); });
}
const id = "d-334abc";
const binding = parseModeCapabilityBinding({ schemaVersion: "pa-mode-capability-binding/v2", configRoot: "/config", configRevision: "a".repeat(40), resourcePath: "teams/analyst.yaml", resourceSha256: "b".repeat(64), profile: "pa-document-policy/v1", policy: { version: "pa-mode-capabilities/v1", allow: [] }, repoKey: "fixture", identity: { publicTeam: "analyst", publicMode: "analyze", effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" }, resources: [{ path: "teams/analyst.yaml", sha256: "b".repeat(64) }] });

test("OPA adapter classifies merged identity, plan environment and immutable binding before effects; writer twin launches", () => fixture(async root => {
  let effects = 0;
  const opts = { primerPath: join(root, "absent-primer"), deployId: id, mode: "dry-run" as const };
  const adapter = new OpencodeAdapter({ env: { PA_TEAM: "requirements" }, runCommand: () => { effects++; return { status: 0, stdout: "", stderr: "" }; } });
  assert.equal((await adapter.spawn({ ...opts, env: { PA_MODE: "analyze" } })).exitCode, 1);
  const writer = new OpencodeAdapter({ env: {}, runCommand: () => { effects++; return { status: 0, stdout: "", stderr: "" }; } });
  // Deliberately minimal inconsistent plans: isolation must reject before any
  // later plan consumer dereferences unrelated execution fields.
  for (const plan of [{ team: "builder", mode: "implement", environment: { PA_TEAM: "analyst" } }, { team: "builder", mode: "implement", modeCapabilityBinding: binding }]) {
    const result = await writer.spawn({ ...opts, executionPlan: plan as ExecutionPlan });
    assert.equal(result.exitCode, 1); assert.match(result.errorMessage!, /REPOSITORY_ISOLATION_UNAVAILABLE/);
  }
  assert.equal(effects, 0); assert.equal(existsSync(join(root, "opencode-output.jsonl")), false);
  assert.equal((await writer.spawn(opts)).exitCode, 0); assert.equal(effects, 1);
}));

for (const evidence of ["missing", "mismatch", "symlink", "hardlink", "directory", "valid"] as const) test(`OPA direct resume binds token to original runtime session: ${evidence}`, () => fixture(async root => {
  appendRegistryEvent({ deployment_id: id, team: "builder", mode: "implement", runtime: "opencode", event: "started", timestamp: new Date().toISOString() }); closeDb();
  const dir = getDeployPaths(id).deployDir; mkdirSync(dir, { recursive: true });
  const path = join(dir, "session-id-opencode.txt");
  if (evidence !== "missing") writeFileSync(path, evidence === "mismatch" ? "other-native-session" : "original-native-session", { mode: 0o600 });
  if (evidence === "hardlink" || evidence === "symlink") { linkSync(path, join(dir, "alias")); if (evidence === "symlink") { unlinkSync(path); symlinkSync(join(dir, "alias"), path); } }
  if (evidence === "directory") { unlinkSync(path); mkdirSync(path); }
  let effects = 0;
  const adapter = new OpencodeAdapter({ env: {}, runCommand: () => { effects++; return { status: 0, stdout: "", stderr: "" }; } });
  const result = await adapter.resume({ primerPath: join(root, "absent"), deployId: "d-334def", mode: "dry-run", sessionId: "original-native-session", resumedFromDeploymentId: id });
  assert.equal(result.exitCode, evidence === "valid" ? 0 : 1); assert.equal(effects, evidence === "valid" ? 1 : 0);
}));

for (const scenario of ["config-role", "config-binding", "original-env", "merged-env", "native", "ancestor", "writer"] as const) test(`OPA background isolation admission retains original evidence: ${scenario}`, () => fixture(async root => {
  const dir = getDeployPaths(id).deployDir, bin = join(root, "bin"), marker = join(root, "child-started"); mkdirSync(dir, { recursive: true }); mkdirSync(bin);
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\nprintf started > '${marker}'\nexit 0\n`); chmodSync(join(bin, "opencode"), 0o700);
  appendRegistryEvent({ deployment_id: id, team: scenario === "native" ? "analyst" : "builder", runtime: "opencode", event: "started", timestamp: new Date().toISOString(), ...(scenario === "ancestor" ? { resumed_from_deployment_id: "d-334def" } : {}) });
  if (scenario === "ancestor") appendRegistryEvent({ deployment_id: "d-334def", team: "analyst", runtime: "opencode", event: "started", timestamp: new Date().toISOString() });
  if (scenario === "native") appendRegistryEvent({ deployment_id: id, team: "analyst", runtime: "opencode", event: "completed", status: "partial", timestamp: new Date().toISOString() });
  const configPath = join(dir, "background.json"), ownershipPath = join(dir, "ownership.json"), logFile = join(dir, "opencode.log");
  if (scenario === "original-env") process.env.PA_TEAM = "analyst";
  if (scenario === "merged-env") process.env.PA_TEAM = "requirements";
  const body = JSON.stringify({ args: [], cwd: root, env: { PATH: `${bin}:${process.env.PATH}`, PA_TEAM: scenario === "merged-env" ? undefined : "builder", PA_MODE: scenario === "merged-env" ? "analyze" : "implement" }, logFile, deploymentId: id, team: scenario === "config-role" ? "analyst" : "builder", ...(scenario === "config-binding" ? { modeCapabilityBinding: binding } : {}), sessionFileName: "session-id-opencode.txt", ownershipToken: "fixture-owner", ownershipPath });
  writeFileSync(configPath, body, { mode: 0o600 });
  const history = getDeploymentEvents(id);
  if (scenario === "writer") {
    await runBackgroundEntry(configPath); assert.equal(existsSync(marker), true); assert.equal(existsSync(configPath), false);
  } else {
    await assert.rejects(runBackgroundEntry(configPath), /REPOSITORY_ISOLATION_UNAVAILABLE/);
    assert.equal(readFileSync(configPath, "utf8"), body); assert.deepEqual(getDeploymentEvents(id), history);
    assert.equal(existsSync(marker), false); assert.equal(existsSync(logFile), false);
    const ownership = JSON.parse(readFileSync(ownershipPath, "utf8")); assert.equal(ownership.ready, false); assert.equal(ownership.state, "failed");
  }
}));
