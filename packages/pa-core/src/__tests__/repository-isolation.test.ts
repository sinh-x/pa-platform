import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync, type ChildProcess, type spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendRegistryEvent, closeDb, getDb } from "../registry/index.js";
import { getDeployPaths } from "../deploy/paths.js";
import { parseModeCapabilityBinding } from "../mode-capabilities.js";
import { SessionManager } from "../agent-api/ws/session-hub.js";
import { assertRepositoryIsolationAvailable, assertRepositoryIsolationBindingAvailable, assertRepositoryIsolationIngressAvailable, assertRepositoryIsolationResumeAvailable, readRecordedRuntimeSession, RepositoryIsolationUnavailableError, requiresRepositoryIsolation } from "../deploy/repository-isolation.js";

test("PAP-334 interim isolation classifies public Analyst in every mode, legacy analyze and arbitrary-name readonly profiles", () => {
  for (const selection of [{ team: "analyst" }, { team: "Analyst", mode: "other" }, { team: "ANALYST", mode: "coordinate" },
    { team: "requirements", mode: "analyze" }, { team: "evidence-lab", mode: "inspect", documentProfile: "pa-readonly-document/v1" },
    { team: "rogue-one", documentProfile: "pa-readonly-document/v1" }]) {
    assert.equal(requiresRepositoryIsolation(selection), true);
    assert.throws(() => assertRepositoryIsolationAvailable(selection), error => error instanceof RepositoryIsolationUnavailableError && error.code === "REPOSITORY_ISOLATION_UNAVAILABLE");
  }
  for (const selection of [{}, { team: "coordinator", mode: "coordinate" }, { team: "builder", mode: "implement" },
    { team: "requirements", mode: "review-auto" }, { team: "rogue-one" }, { team: "evidence-lab", mode: "analyze" }]) {
    assert.equal(requiresRepositoryIsolation(selection), false);
    assert.doesNotThrow(() => assertRepositoryIsolationAvailable(selection));
  }
});

test("PAP-334 absent native resume is read-only and cannot create a registry or grant execution", () => {
  const previous = process.env, root = mkdtempSync(join(tmpdir(), "pap334-resume-"));
  process.env = { ...previous, PA_REGISTRY_DB: join(root, "missing/registry.db"), PA_AI_USAGE_HOME: root };
  try {
    assert.doesNotThrow(() => assertRepositoryIsolationResumeAvailable(), "undefined means fresh selection, not an adapter resume qualification");
    assert.throws(() => assertRepositoryIsolationResumeAvailable("d-334abc"), RepositoryIsolationUnavailableError);
    assert.equal(existsSync(process.env.PA_REGISTRY_DB!), false);
    assert.deepEqual(readdirSync(root), []);
  } finally { process.env = previous; rmSync(root, { recursive: true, force: true }); }
});

function binding(version: number): Record<string, unknown> {
  if (version === 1) return { schemaVersion: "pa-mode-capability-binding/v1", profile: "pa-document-policy/v1", policy: { version: "pa-mode-capabilities/v1", allow: [] }, configRevision: "a".repeat(40), resourcePath: "teams/requirements.yaml", resourceSha256: "b".repeat(64) };
  return { ...binding(1), configRoot: "/config", repoKey: "fixture", schemaVersion: `pa-mode-capability-binding/v${version}`, resourcePath: "teams/analyst.yaml",
    profile: version === 3 ? "pa-readonly-document/v1" : "pa-document-policy/v1",
    identity: { publicTeam: "analyst", publicMode: "analyze", effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" },
    resources: [{ path: "teams/analyst.yaml", sha256: "b".repeat(64) }] };
}

test("all binding versions, malformed bindings and split environment identities are restrictive", () => {
  for (const version of [1, 2, 3]) assert.equal(parseModeCapabilityBinding(binding(version)).schemaVersion, `pa-mode-capability-binding/v${version}`);
  for (const value of [binding(1), binding(2), binding(3), {}, null]) assert.throws(() => assertRepositoryIsolationBindingAvailable(value), RepositoryIsolationUnavailableError);
  assert.throws(() => assertRepositoryIsolationIngressAvailable([{ PA_TEAM: "requirements" }, { PA_MODE: "analyze" }]), RepositoryIsolationUnavailableError);
  assert.throws(() => assertRepositoryIsolationIngressAvailable([{ PA_TEAM: "analyst" }, { PA_TEAM: "builder" }]), RepositoryIsolationUnavailableError);
  assert.doesNotThrow(() => assertRepositoryIsolationIngressAvailable([{ PA_TEAM: "builder", PA_MODE: "implement" }]));
});

for (const scenario of ["writer", "review", "rogue-protected-ancestor", "ancestor-binding-v2", "ancestor-binding-v3", "duplicate-start", "missing-ancestor", "cycle", "changed-current", "changed-event", "binding-v1", "binding-v2", "binding-v3", "retained-document-note", "retained-readonly-note", "wrong-runtime"]) {
  test(`native isolation lineage snapshot: ${scenario}`, () => {
    const previous = process.env, root = mkdtempSync(join(tmpdir(), "pap334-lineage-")); closeDb();
    process.env = { ...previous, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
    try {
      const id = "d-334abc", ancestor = "d-334def";
      const start = { deployment_id: id, team: scenario === "review" ? "review" : scenario === "rogue-protected-ancestor" ? "rogue-one" : "builder", mode: "implement", runtime: "pi" as const, event: "started" as const, timestamp: "2026-11-24T00:00:00Z" };
      appendRegistryEvent({ ...start, ...(scenario.includes("ancestor") || scenario === "cycle" ? { resumed_from_deployment_id: ancestor } : {}),
        ...(scenario === "retained-document-note" ? { note: "requirements-document-confirmation/v3" } : scenario === "retained-readonly-note" ? { note: "readonly-document-policy/v1" } : {}) });
      const db = getDb();
      if (scenario === "rogue-protected-ancestor" || scenario === "cycle") appendRegistryEvent({ ...start, deployment_id: ancestor, team: scenario === "cycle" ? "builder" : "analyst", ...(scenario === "cycle" ? { resumed_from_deployment_id: id } : {}) });
      if (scenario.startsWith("ancestor-binding-")) appendRegistryEvent({ ...start, deployment_id: ancestor, mode_capability_binding: JSON.stringify(binding(Number(scenario.at(-1)))) });
      if (scenario === "duplicate-start") db.prepare("INSERT INTO registry_events (deployment_id, team, runtime, event, timestamp) VALUES (?, 'builder', 'pi', 'started', ?)").run(id, "2026-11-24T00:00:01Z");
      if (scenario === "changed-current") db.prepare("UPDATE deployments SET team = 'custom' WHERE deployment_id = ?").run(id);
      if (scenario === "changed-event") db.prepare("INSERT INTO registry_events (deployment_id, team, event, timestamp) VALUES (?, 'custom', 'pid', ?)").run(id, start.timestamp);
      if (scenario.startsWith("binding-")) {
        const value = JSON.stringify(binding(Number(scenario.at(-1))));
        db.prepare("UPDATE deployments SET mode_capability_binding = ? WHERE deployment_id = ?").run(value, id);
        db.prepare("UPDATE registry_events SET mode_capability_binding = ? WHERE deployment_id = ?").run(value, id);
      }
      closeDb();
      const dir = getDeployPaths(id).deployDir; mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "session-id-pi.txt"), "original-native-session", { mode: 0o600 });
      const manager = new SessionManager({ env: {} });
      const nativeOpts = { prompt: "fixture", deploymentId: id, runtime: "pi" as const, sessionId: "original-native-session" };
      if (scenario === "writer" || scenario === "review") {
        assert.doesNotThrow(() => manager.assertExecutionAvailable(nativeOpts));
        assert.throws(() => manager.assertExecutionAvailable({ ...nativeOpts, sessionId: "unrelated-protected-token" }), RepositoryIsolationUnavailableError);
      } else if (scenario !== "wrong-runtime") assert.throws(() => manager.assertExecutionAvailable(nativeOpts), RepositoryIsolationUnavailableError);
      const files = readdirSync(root).filter(file => file.startsWith("registry.db"));
      const before = files.map(file => readFileSync(join(root, file)));
      if (scenario === "writer" || scenario === "review") assert.doesNotThrow(() => assertRepositoryIsolationResumeAvailable(id, "pi"));
      else assert.throws(() => assertRepositoryIsolationResumeAvailable(id, scenario === "wrong-runtime" ? "opencode" : "pi"), RepositoryIsolationUnavailableError);
      assert.deepEqual(readdirSync(root).filter(file => file.startsWith("registry.db")), files);
      assert.deepEqual(files.map(file => readFileSync(join(root, file))), before);
    } finally { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); }
  });
}

test("recorded native session reads reject link and special-file evidence", () => {
  const previous = process.env, root = mkdtempSync(join(tmpdir(), "pap334-session-"));
  process.env = { ...previous, PA_AI_USAGE_HOME: root };
  try {
    const id = "d-334abc", dir = getDeployPaths(id).deployDir, file = join(dir, "session-id-pi.txt"); mkdirSync(dir, { recursive: true });
    assert.throws(() => readRecordedRuntimeSession(id, "session-id-pi.txt"));
    writeFileSync(file, "native-session", { mode: 0o600 });
    assert.equal(readRecordedRuntimeSession(id, "session-id-pi.txt"), "native-session");
    linkSync(file, join(dir, "alias")); assert.throws(() => readRecordedRuntimeSession(id, "session-id-pi.txt"));
    unlinkSync(file); symlinkSync(join(dir, "alias"), file); assert.throws(() => readRecordedRuntimeSession(id, "session-id-pi.txt"));
    unlinkSync(file); mkdirSync(file); assert.throws(() => readRecordedRuntimeSession(id, "session-id-pi.txt"));
    rmSync(file, { recursive: true }); execFileSync("mkfifo", [file]);
    assert.throws(() => readRecordedRuntimeSession(id, "session-id-pi.txt")); unlinkSync(file);
    writeFileSync(file, "native-session", { mode: 0o600 });
    renameSync(dir, `${dir}-real`); symlinkSync(`${dir}-real`, dir);
    assert.throws(() => readRecordedRuntimeSession(id, "session-id-pi.txt"));
  } finally { process.env = previous; rmSync(root, { recursive: true, force: true }); }
});

test("same-server continuations retain native origin across repeated resumes", () => {
  const previous = process.env, root = mkdtempSync(join(tmpdir(), "pap334-origin-")); closeDb();
  process.env = { ...previous, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
  try {
    const id = "d-334abc", children: EventEmitter[] = [];
    appendRegistryEvent({ deployment_id: id, team: "builder", runtime: "pi", event: "started", timestamp: new Date().toISOString() });
    const dir = getDeployPaths(id).deployDir; mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "session-id-pi.txt"), "original-session", { mode: 0o600 });
    // A fake native child exposes only the event surface used by the manager.
    const spawnFn = (() => { const child = Object.assign(new EventEmitter(), { pid: 42001, stdout: new EventEmitter(), stderr: new EventEmitter() }); children.push(child); return child as unknown as ChildProcess; }) as typeof spawn;
    const manager = new SessionManager({ env: {}, spawnFn, runtimes: { pi: {} } }), sink = { send() {} };
    assert.equal(manager.resume({ prompt: "original", runtime: "pi", deploymentId: id, sessionId: "original-session" }, sink).ok, true); children[0]!.emit("close", 0);
    assert.equal(manager.resume({ prompt: "continue", runtime: "pi", sessionId: "original-session" }, sink).ok, true); children[1]!.emit("close", 0);
    const db = getDb(); db.prepare("UPDATE deployments SET team = 'analyst' WHERE deployment_id = ?").run(id); db.prepare("UPDATE registry_events SET team = 'analyst' WHERE deployment_id = ?").run(id);
    const rejected = manager.resume({ prompt: "continue", runtime: "pi", sessionId: "original-session", env: { PA_TEAM: "builder" } }, sink);
    assert.equal(rejected.ok, false); assert.equal(children.length, 2); assert.equal(manager.activeCount, 0);
  } finally { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); }
});
