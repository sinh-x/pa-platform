import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDeployPaths, getDeploymentEvents, readActivityEvents, type RuntimeAdapter, type SpawnResult } from "@pa-platform/pa-core";
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
  const previous = Object.fromEntries(["PA_PLATFORM_CONFIG", "PA_PLATFORM_TEAMS", "PA_REGISTRY_DB", "PA_AI_USAGE_HOME"].map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  return fn(root).finally(() => {
    closeDb();
    for (const [key, value] of Object.entries(previous)) restore(key, value);
    rmSync(root, { recursive: true, force: true });
  });
}

function stubAdapter(options: { preflight?: () => Promise<void>; result?: (sessionId: string) => SpawnResult; onSpawn?: () => void }): RuntimeAdapter & { preflight(): Promise<void>; allocateSessionId(): string } {
  return {
    name: "pi",
    defaultModel: "",
    sessionFileName: "session-id-pi.txt",
    preflight: options.preflight ?? (async () => {}),
    allocateSessionId: () => "authoritative-session-id",
    installHooks() {},
    spawn(opts) { options.onSpawn?.(); return options.result?.(opts.sessionId ?? "") ?? { sessionId: opts.sessionId, exitCode: 0, metadata: { sessionId: opts.sessionId } }; },
    resume(opts) { return this.spawn(opts); },
    extractActivity() { return []; },
    describeTools() { return { runtime: "pi", markdown: "stub" }; },
  };
}

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
