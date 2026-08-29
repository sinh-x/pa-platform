import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PiAdapter } from "../adapter.js";
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
