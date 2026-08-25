import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDeployPaths, getDeploymentEvents, readActivityEvents, type RuntimeAdapter, type SpawnOpts, type SpawnResult } from "@pa-platform/pa-core";
import { deployWithPi } from "../deploy.js";

function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }

function withPiEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ppa-deploy-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\n`);
  writeFileSync(join(teams, "builder.yaml"), [
    "name: builder",
    "description: Builder",
    "objective: Build",
    "agents:",
    "  - name: builder-agent",
    "    role: Builds",
    "deploy_modes:",
    "  - id: implement",
    "    label: Implement",
  ].join("\n") + "\n");
  const previous = Object.fromEntries(["PA_PLATFORM_CONFIG", "PA_PLATFORM_TEAMS", "PA_REGISTRY_DB", "PA_AI_USAGE_HOME", "PA_MAX_RUNTIME"].map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  delete process.env["PA_MAX_RUNTIME"];
  return fn(root).finally(() => {
    closeDb();
    for (const [key, value] of Object.entries(previous)) restore(key, value);
    rmSync(root, { recursive: true, force: true });
  });
}

function stubAdapter(options: { preflight?: () => Promise<void>; result?: (sessionId: string) => SpawnResult; onSpawn?: (opts: SpawnOpts) => void; onResume?: (opts: SpawnOpts) => void }): RuntimeAdapter & { preflight(): Promise<void>; allocateSessionId(): string } {
  const result = (sessionId: string) => options.result?.(sessionId) ?? { sessionId, exitCode: 0, metadata: { sessionId } };
  return {
    name: "pi",
    defaultModel: "",
    sessionFileName: "session-id-pi.txt",
    preflight: options.preflight ?? (async () => {}),
    allocateSessionId: () => "authoritative-session-id",
    installHooks() {},
    spawn(opts) { options.onSpawn?.(opts); return result(opts.sessionId ?? ""); },
    resume(opts) { options.onResume?.(opts); return result(opts.sessionId); },
    extractActivity() { return []; },
    describeTools() { return { runtime: "pi", markdown: "stub" }; },
  };
}

function assertTimeoutMetadata(opts: SpawnOpts, timeoutSeconds: number): void {
  assert.equal(opts.executionPlan?.timeoutSeconds, timeoutSeconds);
  assert.equal(readFileSync(opts.primerPath, "utf8").match(new RegExp(`timeout_seconds: ${timeoutSeconds}`, "g"))?.length, 1);
  assert.equal(getDeploymentEvents(opts.deployId)[0]?.effective_timeout_seconds, timeoutSeconds);
}

test("new foreground Pi deployments omit the adapter deadline but retain timeout metadata", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.ok(captured);
    assert.equal(captured.mode, "foreground");
    assert.equal(Object.hasOwn(captured, "timeoutMs"), false);
    assert.equal(captured.timeoutMs, undefined);
    assertTimeoutMetadata(captured, 1800);
  });
});

test("new background Pi deployments omit the adapter deadline while retaining supervision metadata", async () => {
  await withPiEnv(async () => {
    let captured: SpawnOpts | undefined;
    const result = await deployWithPi({ team: "builder", mode: "implement", background: true, timeout: 2400 }, stubAdapter({ onSpawn: (opts) => { captured = opts; } }));
    assert.equal(result.status, "success");
    assert.ok(captured);
    assert.equal(captured.mode, "background");
    assert.equal(Object.hasOwn(captured, "timeoutMs"), false);
    assert.equal(captured.timeoutMs, undefined);
    assertTimeoutMetadata(captured, 2400);
  });
});

test("resumed and evaluator Pi deployments retain their resolved adapter deadlines", async () => {
  await withPiEnv(async () => {
    const captured: Array<{ kind: "spawn" | "resume"; opts: SpawnOpts }> = [];
    const adapter = stubAdapter({
      onSpawn: (opts) => { captured.push({ kind: "spawn", opts }); },
      onResume: (opts) => { captured.push({ kind: "resume", opts }); },
    });
    const initial = await deployWithPi({ team: "builder", mode: "implement", timeout: 1200 }, adapter);
    assert.equal(initial.status, "success");
    const resumed = await deployWithPi({ team: "builder", mode: "implement", resume: initial.deploymentId, timeout: 1200 }, adapter);
    assert.equal(resumed.status, "success");
    const evaluator = await deployWithPi({ team: "builder", mode: "implement", evaluateDeployment: "d-abcdef", timeout: 600 }, adapter);
    assert.equal(evaluator.status, "success");
    assert.equal(captured[1]?.kind, "resume");
    assert.equal(captured[1]?.opts.timeoutMs, 1_200_000);
    assertTimeoutMetadata(captured[1]!.opts, 1200);
    assert.equal(captured[2]?.kind, "spawn");
    assert.equal(captured[2]?.opts.timeoutMs, 600_000);
    assertTimeoutMetadata(captured[2]!.opts, 600);
  });
});

test("Pi preflight failure is controlled, actionable, and leaves no session file", async () => {
  await withPiEnv(async () => {
    let spawned = 0;
    const adapter = stubAdapter({
      preflight: async () => { throw new Error("Pi version probe timed out after 5ms."); },
      onSpawn: () => { spawned++; },
    });
    const result = await deployWithPi({ team: "builder", mode: "implement" }, adapter);
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /Pi version probe timed out after 5ms/);
    assert.equal(spawned, 0);
    assert.ok(result.deploymentId);
    const paths = getDeployPaths(result.deploymentId!);
    assert.equal(existsSync(join(paths.deployDir, "session-id-pi.txt")), false);
    assert.deepEqual(getDeploymentEvents(result.deploymentId!).map((event) => event.event), ["started", "completed"]);
    assert.equal(getDeploymentEvents(result.deploymentId!)[1]?.status, "failed");
    const errors = readActivityEvents(paths.activityLogPath).filter((event) => event.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.body ?? "", /Pi version probe timed out after 5ms/);
  });
});

test("Pi adapter failure without session metadata keeps its original reason", async () => {
  await withPiEnv(async () => {
    const adapter = stubAdapter({ result: () => ({ exitCode: 1, errorMessage: "model auth failed" }) });
    const result = await deployWithPi({ team: "builder", mode: "implement" }, adapter);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "model auth failed");
    assert.doesNotMatch(result.reason ?? "", /session id different/);
    assert.ok(result.deploymentId);
    const events = getDeploymentEvents(result.deploymentId!);
    assert.deepEqual(events.map((event) => event.event), ["started", "completed"]);
    assert.equal(events[1]?.summary, "ppa deploy failed: model auth failed");
    assert.match(readActivityEvents(getDeployPaths(result.deploymentId!).activityLogPath)[0]?.body ?? "", /model auth failed/);
  });
});

test("Pi successful results still require both authoritative session IDs", async () => {
  for (const resultFor of [
    () => ({ exitCode: 0, metadata: { sessionId: "authoritative-session-id" } }),
    () => ({ exitCode: 0, sessionId: "authoritative-session-id", metadata: {} }),
    () => ({ exitCode: 0, sessionId: "wrong-session-id", metadata: { sessionId: "authoritative-session-id" } }),
  ]) {
    await withPiEnv(async () => {
      const result = await deployWithPi({ team: "builder", mode: "implement" }, stubAdapter({ result: resultFor }));
      assert.equal(result.status, "failed");
      assert.match(result.reason ?? "", /Pi adapter returned a session id different/);
      assert.ok(result.deploymentId);
      assert.equal(readFileSync(join(getDeployPaths(result.deploymentId!).deployDir, "session-id-pi.txt"), "utf8").trim(), "authoritative-session-id");
      assert.deepEqual(getDeploymentEvents(result.deploymentId!).map((event) => event.event), ["started", "crashed"]);
    });
  }
});
