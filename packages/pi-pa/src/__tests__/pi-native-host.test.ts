import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  PA_PI_EXECUTION_MODE_ENV,
  appendRegistryEvent,
  closeDb,
  getDb,
  queryDeploymentStatus,
  readPiForegroundCompletion,
  runCoreCommand,
} from "@pa-platform/pa-core";
import { PiAdapter } from "../adapter.js";
import registerPiPaExtension, {
  createPiSessionLifecycle,
  registerPiSessionModules,
  type PiExtensionModule,
  type PiRuntime,
  type PiToolDefinition,
} from "../pi-extension/index.js";
import {
  PI_REGISTRY_ADDON_ENV,
  REGISTRY_NATIVE_BINDING_ENV,
  REQUIRE_PI_REGISTRY_ADDON_ENV,
  configurePiRegistryBinding,
  piRegistryEnvironment,
  probePiNativeRegistryAddon,
} from "../native-host.js";
import { runHostManagedToolSmoke } from "../pi-host-smoke.js";

const require = createRequire(import.meta.url);

function localAddonPath(): string {
  return join(dirname(require.resolve("better-sqlite3")), "..", "build", "Release", "better_sqlite3.node");
}

type ShutdownReason = "reload" | "new" | "resume" | "fork" | "quit";
type EventHandler = (event: unknown, context: unknown) => unknown;

function captureExtension(): { events: Map<string, EventHandler>; registrations: Map<string, number>; tools: Map<string, PiToolDefinition> } {
  const events = new Map<string, EventHandler>();
  const registrations = new Map<string, number>();
  const tools = new Map<string, PiToolDefinition>();
  const pi: PiRuntime = {
    on: ((event: string, handler: EventHandler): void => {
      events.set(event, handler);
      registrations.set(event, (registrations.get(event) ?? 0) + 1);
    }) as NonNullable<PiRuntime["on"]>,
    registerTool: (tool) => { tools.set(tool.name, tool); },
  };
  registerPiPaExtension(pi);
  return { events, registrations, tools };
}

async function withRegistryFixture(name: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), name));
  const previous = {
    registry: process.env["PA_REGISTRY_DB"],
    binding: process.env[REGISTRY_NATIVE_BINDING_ENV],
    piBinding: process.env[PI_REGISTRY_ADDON_ENV],
  };
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env[REGISTRY_NATIVE_BINDING_ENV] = localAddonPath();
  process.env[PI_REGISTRY_ADDON_ENV] = localAddonPath();
  try {
    await run(root);
  } finally {
    closeDb();
    restoreEnv("PA_REGISTRY_DB", previous.registry);
    restoreEnv(REGISTRY_NATIVE_BINDING_ENV, previous.binding);
    restoreEnv(PI_REGISTRY_ADDON_ENV, previous.piBinding);
    rmSync(root, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("Pi preflight verifies version then native registry addon before objective execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap-156-preflight-order-"));
  const primer = join(root, "primer.md");
  writeFileSync(primer, "objective must not execute before preflight");
  const order: string[] = [];
  const adapter = new PiAdapter({
    cwd: root,
    versionProbe: () => { order.push("version"); return "0.80.8"; },
    nativeRegistryProbe: () => { order.push("native"); return undefined; },
    runCommand: () => { order.push("objective"); return { status: 0, stdout: "", stderr: "" }; },
  });
  try {
    const result = await adapter.spawn({ primerPath: primer, deployId: "d-order", mode: "foreground" });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(order, ["version", "native", "objective"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi preflight overlaps independent cold version and native validations", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap-156-preflight-overlap-"));
  const primer = join(root, "primer.md");
  writeFileSync(primer, "objective executes only after both probes");
  let nativeStarted = false;
  let executed = false;
  const adapter = new PiAdapter({
    cwd: root,
    versionProbe: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(nativeStarted, true, "native validation must start before version validation settles");
      return "0.80.8";
    },
    nativeRegistryProbe: () => { nativeStarted = true; return undefined; },
    runCommand: () => { executed = true; return { status: 0, stdout: "", stderr: "" }; },
  });
  try {
    const result = await adapter.spawn({ primerPath: primer, deployId: "d-overlap", mode: "foreground" });
    assert.equal(result.exitCode, 0);
    assert.equal(executed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel preflight retains deterministic version-first causal failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap-156-preflight-causal-"));
  const primer = join(root, "primer.md");
  writeFileSync(primer, "objective must not execute");
  let executed = false;
  const adapter = new PiAdapter({
    cwd: root,
    versionProbe: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); return "0.80.7"; },
    nativeRegistryProbe: () => { throw new Error("native-load: concurrent fixture failure"); },
    runCommand: () => { executed = true; return { status: 0, stdout: "", stderr: "" }; },
  });
  try {
    const result = await adapter.spawn({ primerPath: primer, deployId: "d-causal", mode: "foreground" });
    assert.equal(result.exitCode, 1);
    assert.equal(executed, false);
    assert.match(result.errorMessage ?? "", /^Pi version must be 0\.80\.8 or later/);
    assert.doesNotMatch(result.errorMessage ?? "", /native-load/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("async Pi version process failures remain bounded and causal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap-156-version-process-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  try {
    await assert.rejects(
      new PiAdapter({ cwd: root, env: { PATH: bin }, versionTimeoutMs: 50 }).preflight(),
      /Pi is unavailable:.*Install Pi 0\.80\.8 or later/,
    );

    const pi = join(bin, "pi");
    writeFileSync(pi, "#!/bin/sh\nexit 7\n");
    chmodSync(pi, 0o755);
    await assert.rejects(
      new PiAdapter({ cwd: root, env: { PATH: bin }, versionTimeoutMs: 50 }).preflight(),
      /Pi version probe failed with exit code 7/,
    );

    writeFileSync(pi, `#!${process.execPath}\nawait new Promise((resolve) => setTimeout(resolve, 1_000));\nconsole.log("0.80.8");\n`);
    await assert.rejects(
      new PiAdapter({ cwd: root, env: { PATH: bin }, versionTimeoutMs: 20 }).preflight(),
      /Pi version probe timed out after 20ms/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing Pi addon fails causally before objective execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap-156-missing-addon-"));
  const primer = join(root, "primer.md");
  writeFileSync(primer, "objective must not execute");
  let executed = false;
  const adapter = new PiAdapter({
    cwd: root,
    env: { ...process.env, [REQUIRE_PI_REGISTRY_ADDON_ENV]: "1" },
    versionProbe: () => "0.80.8",
    runCommand: () => { executed = true; return { status: 0, stdout: "", stderr: "" }; },
  });
  try {
    const result = await adapter.spawn({ primerPath: primer, deployId: "d-missing", mode: "foreground" });
    assert.equal(result.exitCode, 1);
    assert.equal(executed, false);
    assert.match(result.errorMessage ?? "", /^native-load: Pi registry addon path is not configured$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrong ABI or V8 symbol diagnostics are bounded and redacted", () => {
  const root = mkdtempSync(join(tmpdir(), "pap-156-wrong-abi-"));
  const bin = join(root, "bin");
  const addon = join(root, "better_sqlite3.node");
  const secret = "pap156-native-sensitive-sentinel";
  mkdirSync(bin);
  writeFileSync(addon, "synthetic wrong ABI addon");
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec "${join(bin, ".pi-wrapped")}" "$@"\n`);
  writeFileSync(join(bin, ".pi-wrapped"), `#!/bin/sh\nexec "${join(bin, "node")}" "$@"\n`);
  writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' 'undefined symbol: _ZN2v8Synthetic ${secret} ${"x".repeat(3000)}' >&2\nexit 1\n`);
  for (const path of [join(bin, "pi"), join(bin, ".pi-wrapped"), join(bin, "node")]) chmodSync(path, 0o755);
  try {
    assert.throws(
      () => probePiNativeRegistryAddon({
        PATH: bin,
        [PI_REGISTRY_ADDON_ENV]: addon,
        [REQUIRE_PI_REGISTRY_ADDON_ENV]: "1",
        PAP_156_NATIVE_TOKEN: secret,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^native-load: undefined symbol:/);
        assert.ok(error.message.length <= 2000);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session shutdown uses one awaited boundary for all reasons and duplicate cleanup", async () => {
  await withRegistryFixture("pap-167-session-shutdown-", async () => {
    const reasons: ShutdownReason[] = ["reload", "new", "resume", "fork", "quit"];
    for (const reason of reasons) {
      const { events, registrations } = captureExtension();
      const shutdown = events.get("session_shutdown");
      assert.ok(shutdown, `${reason}: shutdown handler must be registered`);
      assert.equal(registrations.get("session_shutdown"), 1, `${reason}: cleanup must use one shutdown boundary`);
      const outgoingDb = getDb();
      assert.equal(outgoingDb.open, true);
      await shutdown({ type: "session_shutdown", reason }, {});
      assert.equal(outgoingDb.open, false, `${reason}: outgoing registry must close before teardown`);
      await assert.doesNotReject(async () => shutdown({ type: "session_shutdown", reason }, {}));
    }
  });
});

test("direct module shutdown handlers compose into the central awaited boundary", async () => {
  const events = new Map<string, EventHandler>();
  const registrations = new Map<string, number>();
  const order: string[] = [];
  let releaseLegacyCleanup: (() => void) | undefined;
  let receivedEvent: unknown;
  let receivedContext: unknown;
  let legacyCalls = 0;
  const pi: PiRuntime = {
    on: ((event: string, handler: EventHandler): void => {
      events.set(event, handler);
      registrations.set(event, (registrations.get(event) ?? 0) + 1);
    }) as NonNullable<PiRuntime["on"]>,
  };
  const legacyModule: PiExtensionModule = (moduleRuntime) => {
    moduleRuntime.on?.("session_shutdown", async (event, context) => {
      legacyCalls++;
      receivedEvent = event;
      receivedContext = context;
      order.push("legacy-start");
      await new Promise<void>((resolve) => { releaseLegacyCleanup = resolve; });
      order.push("legacy-settled");
    });
  };
  const lifecycle = createPiSessionLifecycle(() => { order.push("close"); });
  registerPiSessionModules(pi, lifecycle, [legacyModule]);

  assert.equal(registrations.get("session_shutdown"), 1, "only the central boundary reaches the real runtime");
  const shutdown = events.get("session_shutdown");
  assert.ok(shutdown);
  const event = { type: "session_shutdown", reason: "reload" };
  const context = { session: "outgoing" };
  const first = Promise.resolve(shutdown(event, context));
  const duplicate = Promise.resolve(shutdown({ type: "session_shutdown", reason: "quit" }, { session: "duplicate" }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(legacyCalls, 1);
  assert.equal(receivedEvent, event);
  assert.equal(receivedContext, context);
  assert.deepEqual(order, ["legacy-start"]);
  releaseLegacyCleanup?.();
  await Promise.all([first, duplicate]);
  assert.deepEqual(order, ["legacy-start", "legacy-settled", "close"]);
  assert.equal(legacyCalls, 1, "duplicate shutdown must not repeat composed cleanup");
});

test("shutdown settles context disposal and in-flight registry access before close", async () => {
  const order: string[] = [];
  let releaseAccess: (() => void) | undefined;
  let releaseContext: (() => void) | undefined;
  const lifecycle = createPiSessionLifecycle(() => { order.push("close"); });
  lifecycle.addShutdownStep(async () => {
    order.push("stop-context-refresh");
    await new Promise<void>((resolve) => { releaseContext = resolve; });
    order.push("context-settled");
  });
  const access = lifecycle.trackRegistryAccess(async () => {
    order.push("registry-start");
    await new Promise<void>((resolve) => { releaseAccess = resolve; });
    order.push("registry-settled");
  });

  const shutdown = lifecycle.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["registry-start", "stop-context-refresh"]);
  await assert.rejects(lifecycle.trackRegistryAccess(() => undefined), /shutting down/);
  releaseAccess?.();
  await access;
  assert.deepEqual(order, ["registry-start", "stop-context-refresh", "registry-settled"]);
  releaseContext?.();
  await shutdown;
  assert.deepEqual(order, ["registry-start", "stop-context-refresh", "registry-settled", "context-settled", "close"]);
  await assert.doesNotReject(async () => lifecycle.shutdown());
});

test("foreground registry completion permits another turn and registry read before shutdown", async () => {
  await withRegistryFixture("pap-167-completion-turn-", async (root) => {
    const deploymentId = "d-pap-167-live";
    const deploymentDir = join(root, "deployments", deploymentId);
    const previous = {
      mode: process.env[PA_PI_EXECUTION_MODE_ENV],
      id: process.env["PA_DEPLOYMENT_ID"],
      dir: process.env["PA_DEPLOYMENT_DIR"],
      aiUsage: process.env["PA_AI_USAGE_HOME"],
    };
    process.env[PA_PI_EXECUTION_MODE_ENV] = "foreground";
    process.env["PA_DEPLOYMENT_ID"] = deploymentId;
    process.env["PA_DEPLOYMENT_DIR"] = deploymentDir;
    process.env["PA_AI_USAGE_HOME"] = root;
    try {
      appendRegistryEvent({ deployment_id: deploymentId, team: "builder", event: "started", timestamp: "2026-09-04T00:00:00.000Z", runtime: "pi", binary: "ppa" });
      const outgoingDb = getDb();
      const { events, tools } = captureExtension();
      const output: string[] = [];
      const errors: string[] = [];
      const completionExit = await runCoreCommand(
        ["registry", "complete", deploymentId, "--status", "success", "--summary", "phase complete"],
        { binaryName: "ppa", io: { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) } },
      );
      assert.equal(completionExit, 0);
      assert.deepEqual(errors, []);
      assert.match(output.join("\n"), /Staged .*publishes when foreground Pi exits/);
      assert.equal(queryDeploymentStatus(deploymentId)?.status, "running");
      assert.equal(readPiForegroundCompletion(deploymentDir)?.status, "success");
      assert.equal(outgoingDb.open, true, "registry complete must not close the interactive registry");

      const context = { hasUI: false, cwd: root, sessionManager: { getBranch: () => [] }, ui: { setStatus() {} } };
      assert.doesNotThrow(() => events.get("turn_end")?.({ turnIndex: 2 }, context));
      const registryTool = tools.get("pa_registry");
      assert.ok(registryTool);
      const registryRead = await registryTool.execute("post-completion-read", { action: "list" }, undefined, undefined, context);
      const statuses = JSON.parse(registryRead.content[0]!.text) as Array<{ deploy_id?: string }>;
      assert.ok(statuses.some((status) => status.deploy_id === deploymentId));
      assert.equal(outgoingDb.open, true, "post-completion turn and read must retain the registry");

      const shutdown = events.get("session_shutdown");
      assert.ok(shutdown);
      await shutdown({ type: "session_shutdown", reason: "quit" }, context);
      assert.equal(outgoingDb.open, false);
    } finally {
      restoreEnv(PA_PI_EXECUTION_MODE_ENV, previous.mode);
      restoreEnv("PA_DEPLOYMENT_ID", previous.id);
      restoreEnv("PA_DEPLOYMENT_DIR", previous.dir);
      restoreEnv("PA_AI_USAGE_HOME", previous.aiUsage);
    }
  });
});

test("a later extension session lazily reopens the registry singleton after shutdown", async () => {
  await withRegistryFixture("pap-167-close-reopen-", async () => {
    const first = captureExtension();
    const outgoingDb = getDb();
    await first.events.get("session_shutdown")?.({ type: "session_shutdown", reason: "new" }, {});
    assert.equal(outgoingDb.open, false);

    const replacementDb = getDb();
    assert.notEqual(replacementDb, outgoingDb);
    assert.equal(replacementDb.open, true);
    assert.deepEqual(replacementDb.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get(), { value: "10" });
    const replacement = captureExtension();
    await replacement.events.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, {});
    assert.equal(replacementDb.open, false);
  });
});

test("Pi child environment replaces the Node 22 wrapper binding with only the packaged Pi-host binding", () => {
  const input = {
    KEEP: "yes",
    [REGISTRY_NATIVE_BINDING_ENV]: "/nix/store/node-22/better_sqlite3.node",
    [PI_REGISTRY_ADDON_ENV]: "/nix/store/pi-host/better_sqlite3.node",
  };
  const output = piRegistryEnvironment(input);
  assert.equal(output.KEEP, "yes");
  assert.equal(output[REGISTRY_NATIVE_BINDING_ENV], input[PI_REGISTRY_ADDON_ENV]);
  assert.equal(input[REGISTRY_NATIVE_BINDING_ENV], "/nix/store/node-22/better_sqlite3.node");
  configurePiRegistryBinding(input);
  assert.equal(input[REGISTRY_NATIVE_BINDING_ENV], input[PI_REGISTRY_ADDON_ENV]);
});

test("deterministic managed tool harness executes the complete eight-tool matrix", async () => {
  const evidence = await runHostManagedToolSmoke(localAddonPath());
  assert.deepEqual(evidence.tools, [
    "read", "bash", "question", "todo", "pa_ticket", "pa_bulletin", "pa_registry", "pa_status",
  ].map((name) => ({ name, status: "passed" })));
  assert.equal(evidence.modules, process.versions.modules);
});
