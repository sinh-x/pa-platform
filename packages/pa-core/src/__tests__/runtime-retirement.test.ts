import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireRepositoryMutationLease, appendRegistryEvent, assertMatchingRuntime, closeDb, composeRuntimeHooks,
  emitStartedEvent, generatePrimer, getDeploymentEvents, loadConfig, queryDeploymentStatus, queryReadonlyDeploymentStatus,
  registerRepositoryMutationBorrower, resolveExecutionPlan, resolveRepositoryAdmissionEvidence,
  resolveRuntimeConfig, runCoreCommand, validateDeployRequestFields,
  type RuntimeAdapter, type RuntimeName, type TeamConfig,
} from "../index.js";
import { createMockRuntimeAdapter, runCli } from "../cli/run.js";
import { runDeployCommand } from "../cli/commands/deploy.js";
import { deployStatusRoutes } from "../agent-api/routes/deploy-status.js";
import { reviewContext } from "../artifacts/runtime.js";
import { SessionManager } from "../agent-api/ws/session-hub.js";

const supplied: unknown = JSON.parse(process.env["PA_RETIRED_RUNTIME_CASES"] ?? "[]");
assert.ok(Array.isArray(supplied) && supplied.every((value: unknown) => typeof value === "string" && value !== "pi" && value !== "opencode"));
const unsupported = [...new Set(["unsupported-synthetic", ...supplied as string[]])];
const team: TeamConfig = { name: "synthetic", description: "fixture", objective: "fixture", agents: [] };

function boundedStop(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length <= 2000);
    for (const field of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.ok(error.message.includes(field));
    return true;
  });
}

function bytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // SQLite's transient shared-memory file contains read-lock counters, not
      // history. Main database and WAL bytes remain part of the comparison.
      if (dir === root && entry.name === "registry.db-shm") continue;
      if (entry.isDirectory()) visit(path);
      else result[path.slice(root.length + 1)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  visit(root);
  return result;
}

async function isolated(action: (root: string) => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PA_|PI_|GIT_)/.test(key)));
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "pa-runtime-retirement-"));
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_PLATFORM_CONFIG"] = join(root, "config");
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "config.yaml"), `config_dir: ${root}\n`);
  process.chdir(root);
  try { await action(root); }
  finally {
    closeDb(); process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

for (const value of unsupported) {
  test(`unsupported selection ${value} rejects before events, allocation, repository effects or spawn`, async () => {
    await isolated(async (root) => {
      const runtime = value as RuntimeName; // Deliberately bypass compile-time admission.
      let effects = 0;
      const adapter: RuntimeAdapter = { ...createMockRuntimeAdapter("pi"), name: runtime,
        spawn: () => { effects++; throw new Error("forbidden spawn"); },
        resume: () => { effects++; throw new Error("forbidden resume"); },
        installHooks: () => { effects++; }, describeTools: () => { effects++; throw new Error("forbidden tools"); },
      };
      const before = bytes(root);
      assert.equal(queryReadonlyDeploymentStatus("d-abcdef"), null);
      assert.ok("error" in validateDeployRequestFields({ team: team.name, runtime: value }));
      boundedStop(() => createMockRuntimeAdapter(runtime));
      boundedStop(() => composeRuntimeHooks({}, {}, runtime));
      boundedStop(() => resolveRuntimeConfig({ runtime, request: { provider: "anthropic", model: "claude-sonnet-4-6" }, team }));
      boundedStop(() => generatePrimer({ runtime, teamConfig: team }));
      boundedStop(() => generatePrimer({ runtime, teamConfig: { ...team, name: "rogue-one" }, rogueOne: true }));
      boundedStop(() => emitStartedEvent({ runtime, deploymentId: "d-abcdef", team: team.name }));
      boundedStop(() => resolveExecutionPlan({ runtime, request: { team: team.name }, teamConfig: team,
        deploymentId: "d-abcdef", deploymentDir: join(root, "unallocated"), activityLogPath: "unused", environment: {}, timeoutSeconds: 60 }));
      boundedStop(() => resolveRepositoryAdmissionEvidence({ runtime, team: team.name, mode: "fixture", canonicalRepoKey: "fixture", canonicalRepoRoot: root,
        observeOperation: () => { effects++; } }));
      boundedStop(() => acquireRepositoryMutationLease({ runtime, mode: "implement", canonicalRepoKey: "fixture", canonicalRepoRoot: root,
        deploymentId: "d-abcdef", deploymentDirectory: root, dependencies: { createToken: () => { effects++; return "never"; } } }));
      boundedStop(() => registerRepositoryMutationBorrower({ runtime, mode: "implement", team: "builder", launchMode: "background", canonicalRepoKey: "fixture", canonicalRepoRoot: root,
        deploymentId: "d-abcdef", deploymentDirectory: root, parentDeploymentId: "d-111111", ticket: "ALT-7", branch: "feature/ALT-7-fixture", timeoutSeconds: 60 }));
      assert.throws(() => reviewContext({ PA_ARTIFACT_ADAPTER: value, PA_DEPLOYMENT_ID: "d-abcdef", PA_DEPLOYMENT_DIR: root }), /ARTIFACT_/);
      await assert.rejects(runCli({ adapter, binaryName: "never-spawn" }), /unsupported runtime/);
      const output: string[] = [];
      assert.equal(await runDeployCommand([team.name], { stdout: () => {}, stderr: (line) => output.push(line) }, { deploy: () => { effects++; return { status: "success" }; } }, "unsupported-adapter"), 1);
      assert.equal(await runDeployCommand([team.name, "--runtime", value], { stdout: () => {}, stderr: () => {} }, { deploy: () => { effects++; return { status: "success" }; } }), 1);
      const sessions = new SessionManager({ spawnFn: (() => { effects++; throw new Error("forbidden spawn"); }) as never });
      const sink = { send: () => { effects++; } };
      assert.equal(sessions.start({ runtime, prompt: "fixture" }, sink).ok, false);
      assert.equal(sessions.resume({ runtime, prompt: "fixture", sessionId: "opaque" }, sink).ok, false);
      assert.equal(sessions.register("d-abcdef", undefined, runtime).ok, false);
      assert.equal(sessions.activeCount, 0);
      const app = deployStatusRoutes(() => ({ operator: true }));
      const response = await app.request("/api/deploy/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deploymentId: "d-abcdef", team: team.name, runtime: value }) });
      assert.equal(response.status, 400);
      assert.equal(effects, 0);
      assert.deepEqual(bytes(root), before, "no new registry, deployment, lease or operational bytes");
    });
  });

  test(`opaque history ${value} stays byte-identical through status and rejected resume`, async () => {
    await isolated(async (root) => {
      const id = "d-abcdef";
      const dir = join(root, "deployments", id);
      mkdirSync(dir, { recursive: true });
      const fixture = { deployment_id: id, team: team.name, event: "started" as const, timestamp: "2020-01-01T00:00:00Z", runtime: value };
      writeFileSync(join(dir, "legacy.json"), JSON.stringify(fixture) + "\n");
      writeFileSync(join(dir, `session-id-${value}.txt`), "opaque-historical-session\n");
      // Even a misleading retained session file must not override historical runtime identity.
      for (const runtime of ["pi", "opencode"]) writeFileSync(join(dir, `session-id-${runtime}.txt`), "not-migration-authority\n");
      appendRegistryEvent(fixture);
      appendRegistryEvent({ deployment_id: id, team: team.name, event: "completed", timestamp: "2020-01-01T00:01:00Z", status: "success" });
      const before = bytes(root);
      assert.equal(queryDeploymentStatus(id)?.runtime, value);
      assert.equal(getDeploymentEvents(id)[0]?.runtime, value);
      const output: string[] = [];
      assert.equal(await runCoreCommand(["status", id], { io: { stdout: (line) => output.push(line), stderr: () => {} } }), 0);
      assert.ok(output.join("\n").includes(value));
      const app = deployStatusRoutes();
      assert.equal((await app.request(`/api/deploy/status/${id}`)).status, 200);
      assert.equal((await app.request(`/api/deploy/events/${id}`)).status, 200);
      // Adapter suites exercise rejected resume itself without coupling this
      // source-only core test to another package's built exports.
      for (const runtime of ["pi", "opencode"] as const) boundedStop(() => assertMatchingRuntime(value, runtime));
      assert.deepEqual(bytes(root), before);
      closeDb();
      const registryBefore = readFileSync(join(root, "registry.db"));
      assert.equal(queryReadonlyDeploymentStatus(id)?.runtime, value);
      assert.deepEqual(readFileSync(join(root, "registry.db")), registryBefore, "cold historical inspection never migrates the database");
      assert.equal(existsSync(join(root, "unallocated")), false);
    });
  });
}

test("empty and wrong-type explicit runtime selections never fall back or create effects", async () => {
  await isolated(async (root) => {
    const before = bytes(root);
    let effects = 0;
    const sessions = new SessionManager({ spawnFn: (() => { effects++; throw new Error("forbidden spawn"); }) as never });
    const app = deployStatusRoutes(() => ({ operator: true }));
    for (const value of ["", " ", null, false, 0, {}, []]) {
      const runtime = value as RuntimeName;
      assert.ok("error" in validateDeployRequestFields({ team: team.name, runtime: value }));
      boundedStop(() => createMockRuntimeAdapter(runtime));
      boundedStop(() => composeRuntimeHooks({}, {}, runtime));
      boundedStop(() => resolveRuntimeConfig({ runtime, request: {}, team }));
      boundedStop(() => generatePrimer({ runtime, teamConfig: team }));
      boundedStop(() => generatePrimer({ runtime, teamConfig: team, rogueOne: true }));
      boundedStop(() => emitStartedEvent({ runtime, deploymentId: "d-abcdef", team: team.name }));
      boundedStop(() => resolveExecutionPlan({ runtime, request: { team: team.name }, teamConfig: team, deploymentId: "d-abcdef", deploymentDir: root, activityLogPath: "unused", environment: {}, timeoutSeconds: 60 }));
      const sink = { send: () => { effects++; } };
      assert.equal(sessions.start({ runtime, prompt: "fixture" }, sink).ok, false);
      assert.equal(sessions.resume({ runtime, prompt: "fixture", sessionId: "opaque" }, sink).ok, false);
      assert.equal(sessions.register("d-abcdef", undefined, runtime).ok, false);
      assert.equal((await app.request("/api/deploy/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deploymentId: "d-abcdef", team: team.name, runtime: value }) })).status, 400);
    }
    assert.equal(effects, 0); assert.equal(sessions.activeCount, 0);
    assert.deepEqual(bytes(root), before);
  });
});

test("configured active runtime rejects unsupported values without rewriting configuration", async () => {
  await isolated(async (root) => {
    const path = join(root, "config", "config.yaml");
    for (const runtime of unsupported) {
      const original = JSON.stringify({ defaults: { runtime } });
      writeFileSync(path, original);
      boundedStop(() => loadConfig(path));
      assert.equal(readFileSync(path, "utf8"), original);
    }
  });
});

test("generic tracked audit handles tokens, odd paths, hidden files, gitlinks and deleted documents", async () => {
  const { auditRuntimeReferences } = await import("../../../../scripts/dev/check_runtime_retirement.mjs");
  const root = mkdtempSync(join(tmpdir(), "pa-reference-audit-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const put = (path: string, text: string | Buffer) => writeFileSync(join(root, path), text);
  try {
    git("init", "-q");
    put(".hidden", "RETIRED-SYNTHETIC must fail, not unretired-syntheticword");
    put("odd\nretired-synthetic.md", "# old adapter\n");
    put("guide.md", "[old](odd%0Aretired-synthetic.md)\n");
    put("binary", Buffer.from([0, 1, 2]));
    git("add", "--all");
    git("update-index", "--add", "--cacheinfo", "160000", "a".repeat(40), "vendor");
    const bad = auditRuntimeReferences(root, ["retired-synthetic"]);
    assert.equal(bad.gitlinks, 1); assert.equal(bad.binaries, 1);
    assert.ok(bad.findings.some((finding: { path: string; kind: string }) => finding.path === ".hidden" && finding.kind === "text"));
    assert.ok(bad.findings.some((finding: { path: string; kind: string }) => finding.path.includes("\n") && finding.kind === "path"));
    put(".hidden", "unretired-syntheticword is unrelated");
    rmSync(join(root, "odd\nretired-synthetic.md"));
    const dangling = auditRuntimeReferences(root, ["retired-synthetic"]);
    assert.ok(dangling.findings.some((finding: { kind: string }) => finding.kind === "dead-document-link"));
    put("guide.md", "# retained guide\n");
    const clean = auditRuntimeReferences(root, ["retired-synthetic"]);
    assert.equal(clean.matches, 0); assert.equal(clean.deletedFiles, 1);
    assert.throws(() => auditRuntimeReferences(root, []), /nonempty/);
    assert.throws(() => auditRuntimeReferences(root, [".*"]), /nonempty/);
    put("invalid-utf8", Buffer.from([0xff])); git("add", "invalid-utf8");
    assert.throws(() => auditRuntimeReferences(root, ["retired-synthetic"]), /encoded data/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retained selections keep API defaults and Anthropic model resolution", () => {
  assert.deepEqual(validateDeployRequestFields({ team: team.name }), { request: { team: team.name } });
  for (const runtime of ["pi", "opencode"] as const) {
    assert.ok("request" in validateDeployRequestFields({ team: team.name, runtime }));
    const config = resolveRuntimeConfig({ runtime, request: { provider: "anthropic", model: "claude-sonnet-4-6" }, team });
    assert.equal(config.provider, "anthropic"); assert.equal(config.model, "claude-sonnet-4-6");
  }
});
