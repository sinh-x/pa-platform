import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendRegistryEvent, closeDb, parseModeCapabilityBinding, queryReadonlyDeploymentStatus, RepositoryIsolationUnavailableError, runCoreCommand, type ExecutionPlan, type RuntimeAdapter, type SpawnOpts } from "@pa-platform/pa-core";
import { PiAdapter } from "../adapter.js";
import { createPiHooks, deployWithPi } from "../deploy.js";
import { OpencodeAdapter } from "../../../opencode-pa/src/adapter.js";
import { createOpencodeHooks, deployWithOpencode } from "../../../opencode-pa/src/deploy.js";

// Source-only admission tests. No installed executor, provider or live store is used.
const privateInput = `PRIVATE_INPUT\u001b[31m\nCondition: forged\n${"x".repeat(5000)}`;
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const previous = process.env, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap334-launch-"));
  closeDb();
  process.env = Object.fromEntries(Object.entries(previous).filter(([key]) => !/^(PA_|PI_|AXI_)/.test(key)));
  Object.assign(process.env, { PA_PLATFORM_HOME: join(root, "config"), PA_PLATFORM_CONFIG: join(root, "config"),
    PA_PLATFORM_TEAMS: join(root, "teams"), PA_PLATFORM_SKILLS: join(root, "skills"), PA_AI_USAGE_HOME: join(root, "usage"),
    PA_REGISTRY_DB: join(root, "registry.db"), NO_COLOR: "1" });
  try {
    for (const path of ["config", "teams", "repo"]) mkdirSync(join(root, path));
    writeFileSync(join(root, "config/config.yaml"), `repos:\n example:\n  path: ${join(root, "repo")}\n  prefix: EX\n`);
    for (const [name, mode, profile] of [["analyst", "analyze"], ["analyst-other", "investigate"], ["requirements", "analyze"], ["evidence-lab", "inspect", "pa-readonly-document/v1"], ["coordinator", "coordinate"], ["rogue-one", "rogue-one"]]) {
      writeFileSync(join(root, `teams/${name}.yaml`), JSON.stringify({ name: name === "analyst-other" ? "analyst" : name, description: "Disposable", objective: "Source plan", agents: [], default_mode: mode,
        deploy_modes: [{ id: mode, label: "Selected", mode_type: "interactive", ...(profile ? { document_profile: profile, objective: "docs/objective.md", capability_policy: { version: "pa-mode-capabilities/v1", allow: [] } } : {}) }] }));
    }
    process.chdir(join(root, "repo"));
    await run(root);
  } finally { closeDb(); process.chdir(cwd); process.env = previous; rmSync(root, { recursive: true, force: true }); }
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path); else result[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root); return result;
}
function assertBlocker(message: string | undefined): void {
  assert.equal(message, new RepositoryIsolationUnavailableError().message, "only static owner guidance may cross the public boundary");
  assert.ok(message!.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(message!.split(`${label}:`).length - 1, 1);
  assert.doesNotMatch(message!, /PRIVATE_INPUT|override|force-unlock|\u001b/);
}
function forbiddenAdapter(runtime: "pi" | "opencode", effects: string[]): RuntimeAdapter & { preflight(): Promise<void> } {
  return { name: runtime, defaultModel: "fixture", sessionFileName: `session-id-${runtime}.txt`,
    allocateSessionId: () => { effects.push("allocate"); return "fixture"; },
    async preflight() { effects.push("preflight"); }, installHooks() { effects.push("hooks"); },
    describeTools() { effects.push("tools"); return { runtime, markdown: "fixture" }; },
    extractActivity() { effects.push("activity"); return []; },
    spawn() { effects.push("spawn"); return { exitCode: 0 }; }, resume() { effects.push("resume"); return { exitCode: 0 }; } };
}
const protectedSelections = [["analyst", "analyze"], ["analyst-other", "investigate"], ["requirements", "analyze"], ["evidence-lab", "inspect"]] as const;

for (const binaryName of ["pa-core", "ppa", "opa"]) test(`PAP-334 ${binaryName} CLI rejects before preflight, repository, ticket and registry initialization`, () => fixture(async root => {
  const effects: string[] = [];
  const before = snapshot(root);
  for (const [team, mode] of protectedSelections) for (const flags of [[], ["--background"], ["--resume", "d-private"], ["--force"]]) {
    const stdout: string[] = [], stderr: string[] = [];
    assert.equal(await runCoreCommand(["deploy", team, "--mode", mode, "--repo", "/PRIVATE_INPUT/missing", "--ticket", "EX-404", "--objective", privateInput, ...flags], {
      binaryName, io: { stdout: line => stdout.push(line), stderr: line => stderr.push(line) }, hooks: {
        deployPreflight: () => { effects.push("preflight"); return undefined; }, deploy: () => { effects.push("deploy"); return { status: "pending" }; },
      },
    }), 1);
    assert.deepEqual(stdout, []);
    // Preserve the existing input-sanitization warning, separate from the one
    // static blocker envelope; no raw objective is allowed through either.
    assert.equal(stderr.length, 2);
    assert.match(stderr[0]!, /^sanitized objective: removed \d+ invalid character\(s\)$/);
    assertBlocker(stderr[1]);
    assert.ok(stderr.join("\n").length <= 2000);
    assert.doesNotMatch(stderr.join("\n"), /PRIVATE_INPUT|forged|x{50}|\u001b/);
    assert.deepEqual(snapshot(root), before);
  }
  assert.deepEqual(effects, []);
}));

for (const runtime of ["pi", "opencode"] as const) test(`PAP-334 direct ${runtime} launcher rejects protected selections before prompt, preflight and runtime effects`, () => fixture(async root => {
  const effects: string[] = [], adapter = forbiddenAdapter(runtime, effects), before = snapshot(root);
  for (const [team, mode] of protectedSelections) for (const controls of [{}, { background: true }, { resume: "d-private" }, { force: true }]) {
    const request = { team, mode, repo: "/PRIVATE_INPUT/missing", ticket: "EX-404", objective: privateInput, ...controls };
    const result = runtime === "pi" ? await deployWithPi(request, adapter) : await deployWithOpencode(request, adapter);
    assert.equal(result.status, "failed"); assert.equal(result.deploymentId, undefined); assertBlocker(result.reason);
    assert.deepEqual(snapshot(root), before);
  }
  if (runtime === "pi") {
    const stopped = await createPiHooks(adapter).deployPreflight!({ team: "analyst", mode: "analyze" });
    assertBlocker(stopped?.reason);
  }
  assert.deepEqual(effects, []);
}));

function readonlyBinding(root: string) {
  return parseModeCapabilityBinding({ schemaVersion: "pa-mode-capability-binding/v3", configRoot: root, configRevision: "a".repeat(40), resourcePath: "teams/evidence-lab.yaml", resourceSha256: "b".repeat(64),
    profile: "pa-readonly-document/v1", policy: { version: "pa-mode-capabilities/v1", allow: [] }, repoKey: "example",
    identity: { publicTeam: "evidence-lab", publicMode: "inspect", effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" }, resources: [{ path: "teams/evidence-lab.yaml", sha256: "b".repeat(64) }] });
}

for (const runtime of ["pi", "opencode"] as const) test(`PAP-334 actual ${runtime} adapter guards every identity source before probes or writes, including adapter dry-run`, () => fixture(async root => {
  let effects = 0;
  const restrictive = [
    { base: { PA_TEAM: "analyst", PA_MODE: "analyze" }, overlay: { PA_TEAM: "coordinator", PA_MODE: "coordinate" } },
    { base: {}, overlay: { PA_TEAM: "analyst", PA_MODE: "other" } },
    { base: { PA_TEAM: "requirements", PA_MODE: "analyze" }, overlay: { PA_TEAM: "rogue-one", PA_MODE: "rogue-one" } },
    { base: {}, overlay: { PA_TEAM: "coordinator" }, plan: { team: "analyst", mode: "other" } },
    { base: {}, overlay: { PA_TEAM: "rogue-one" }, plan: { team: "evidence-lab", mode: "inspect", modeCapabilityBinding: readonlyBinding(root) } },
  ];
  for (const selection of restrictive) {
    const options = { cwd: join(root, "repo"), env: selection.base, runCommand: () => { effects++; throw Error("PRIVATE_INPUT runtime"); } };
    const adapter = runtime === "pi" ? new PiAdapter({ ...options, versionProbe: () => { effects++; throw Error("PRIVATE_INPUT probe"); } })
      : new OpencodeAdapter({ ...options, runBackgroundCommand: () => { effects++; throw Error("PRIVATE_INPUT background"); } });
    for (const mode of ["foreground", "background", "dry-run"] as const) {
      const opts: SpawnOpts = { primerPath: join(root, "absent/primer.md"), logFile: join(root, "absent/runtime.log"), deployId: "d-334abc", mode,
        env: { ...selection.overlay, PA_ISOLATION_OVERRIDE: privateInput, PRIVATE_API_KEY: privateInput, PA_REPOSITORY_ISOLATION: "allow" },
        ...(selection.plan ? { executionPlan: Object.freeze(selection.plan) as ExecutionPlan } : {}) };
      const before = snapshot(root);
      for (const result of [await adapter.spawn(opts), await adapter.resume({ ...opts, sessionId: "PRIVATE_INPUT" })]) {
        assert.equal(result.exitCode, 1); assertBlocker(result.errorMessage);
      }
      assert.deepEqual(snapshot(root), before);
    }
  }
  assert.equal(effects, 0);
}));

for (const runtime of ["pi", "opencode"] as const) test(`PAP-334 ${runtime} protected native resume cannot become rogue-one; absent and malformed evidence fail closed`, () => fixture(async root => {
  let effects = 0;
  const adapter = runtime === "pi" ? new PiAdapter({ env: {}, versionProbe: () => { effects++; throw Error("not admitted"); } })
    : new OpencodeAdapter({ env: {}, runCommand: () => { effects++; throw Error("not admitted"); }, runBackgroundCommand: () => { effects++; throw Error("not admitted"); } });
  const opts: SpawnOpts = { primerPath: join(root, "absent/primer.md"), logFile: join(root, "absent/runtime.log"), deployId: "d-334abc", mode: "foreground", env: { PA_TEAM: "rogue-one", PA_MODE: "rogue-one" } };
  const native = (id: string, team: string, mode: string, binding?: string) => appendRegistryEvent({ deployment_id: id, team, mode, runtime, event: "started", timestamp: "2026-11-24T00:00:00Z", ...(binding ? { mode_capability_binding: binding } : {}) });
  native("d-334001", "analyst", "other"); native("d-334002", "requirements", "analyze");
  native("d-334003", "evidence-lab", "inspect", JSON.stringify(readonlyBinding(root)));
  native("d-334004", "coordinator", "coordinate", "PRIVATE_INPUT malformed JSON");
  native("d-334005", "coordinator", "coordinate", JSON.stringify({ profile: "PRIVATE_INPUT" }));
  closeDb();
  // Exercise all rejection cases against an already-readable WAL image too.
  // Missing-sidecar allocation is asserted separately below, without masking it.
  queryReadonlyDeploymentStatus("d-334001");
  for (const resumedFromDeploymentId of [undefined, "d-missing", "d-334001", "d-334002", "d-334003", "d-334004", "d-334005"]) for (const background of [false, true]) {
    const before = snapshot(root);
    const result = await adapter.resume({ ...opts, mode: background ? "background" : "foreground", sessionId: "PRIVATE_INPUT", resumedFromDeploymentId });
    assert.equal(result.exitCode, 1); assertBlocker(result.errorMessage);
    const request = { team: "rogue-one", resume: resumedFromDeploymentId ?? "d-missing", background };
    const launch = runtime === "pi" ? await deployWithPi(request, forbiddenAdapter(runtime, [])) : await deployWithOpencode(request, forbiddenAdapter(runtime, []));
    assert.equal(launch.status, "failed"); assert.equal(launch.deploymentId, undefined); assertBlocker(launch.reason);
    const stderr: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "rogue-one", "--resume", request.resume, "--repo", "/PRIVATE_INPUT/missing"], {
      binaryName: runtime === "pi" ? "ppa" : "opa", io: { stdout: () => assert.fail("rejected resume stdout"), stderr: line => stderr.push(line) },
      hooks: { deployPreflight: () => { effects++; return undefined; }, deploy: () => { effects++; return { status: "pending" }; } },
    }), 1);
    assert.equal(stderr.length, 1); assertBlocker(stderr[0]);
    assert.deepEqual(snapshot(root), before, "prior records and all fixture files remain byte-identical");
  }
  rmSync(join(root, "registry.db")); writeFileSync(join(root, "registry.db"), "PRIVATE_INPUT corrupt sqlite");
  const before = snapshot(root);
  const corrupt = await adapter.resume({ ...opts, sessionId: "fixture", resumedFromDeploymentId: "d-334001" });
  assert.equal(corrupt.exitCode, 1); assertBlocker(corrupt.errorMessage); assert.deepEqual(snapshot(root), before);
  assert.equal(effects, 0);
}));

for (const runtime of ["pi", "opencode"] as const) test(`PAP-334 ${runtime} rejected native resume must not allocate missing WAL sidecars`, () => fixture(async root => {
  appendRegistryEvent({ deployment_id: "d-334abc", team: "analyst", mode: "analyze", runtime, event: "started", timestamp: "2026-11-24T00:00:00Z" });
  closeDb();
  assert.equal(existsSync(join(root, "registry.db-wal")), false);
  const before = snapshot(root);
  const adapter = runtime === "pi" ? new PiAdapter({ env: {}, versionProbe: () => { throw Error("not admitted"); } })
    : new OpencodeAdapter({ env: {}, runCommand: () => { throw Error("not admitted"); } });
  const result = await adapter.resume({ primerPath: join(root, "absent/primer.md"), deployId: "d-334def", mode: "foreground", sessionId: "fixture", resumedFromDeploymentId: "d-334abc" });
  assert.equal(result.exitCode, 1); assertBlocker(result.errorMessage);
  assert.deepEqual(snapshot(root), before, "guard must not allocate WAL/SHM files during native prior inspection");
}));

for (const runtime of ["pi", "opencode"] as const) test(`PAP-334 ${runtime} source dry-run stays nonexecuting and fresh nonAnalyst launch callbacks remain usable`, () => fixture(async root => {
  execFileSync("git", ["init", "-b", "develop"], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], { stdio: "ignore" });
  let spawns = 0, resumes = 0;
  const adapter: RuntimeAdapter = { ...forbiddenAdapter(runtime, []), allocateSessionId: () => "fixture-session",
    spawn(opts) { spawns++; assert.equal(opts.executionPlan?.team, "coordinator"); assert.equal(opts.executionPlan?.repositoryAdmission.access, "non-locking"); return { exitCode: 0, sessionId: opts.sessionId ?? "fixture-session", metadata: { sessionId: opts.sessionId ?? "fixture-session" } }; },
    resume(opts) { resumes++; assert.ok(opts.resumedFromDeploymentId, "launcher must supply native prior ID"); return { exitCode: 0, sessionId: opts.sessionId, metadata: { sessionId: opts.sessionId } }; } };
  const launch = (request: Parameters<typeof deployWithPi>[0]) => runtime === "pi" ? deployWithPi(request, adapter) : deployWithOpencode(request, adapter);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    const stderr: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "analyst", "--mode", "analyze", "--repo", "example", "--dry-run"], {
      binaryName: runtime === "pi" ? "ppa" : "opa", hooks: runtime === "pi" ? createPiHooks(adapter) : createOpencodeHooks(adapter),
      io: { stdout: () => {}, stderr: line => stderr.push(line) },
    }), 0, stderr.join("\n"));
    assert.equal(spawns, 0); assert.equal(resumes, 0); assert.equal(existsSync(join(root, "registry.db")), false);
    const dry = await launch({ team: "analyst", mode: "analyze", repo: "example", dryRun: true });
    assert.equal(dry.status, "pending", dry.reason); assert.ok(dry.deploymentId);
    assert.match(readFileSync(join(root, "usage/deployments", dry.deploymentId, "primer.md"), "utf8"), /analyst/);
    assert.equal(spawns, 0); assert.equal(resumes, 0); assert.equal(existsSync(join(root, "registry.db")), false);
    const fresh = await launch({ team: "coordinator", mode: "coordinate", repo: "example" });
    assert.equal(fresh.status, "success", fresh.reason); assert.equal(spawns, 1);
    const continued = await launch({ team: "coordinator", mode: "coordinate", repo: "example", resume: fresh.deploymentId });
    assert.equal(continued.status, "success", continued.reason); assert.equal(resumes, 1);
  } finally { globalThis.fetch = fetch; }
}));
