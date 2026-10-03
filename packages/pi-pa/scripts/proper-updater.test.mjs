import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { bundleExtensionSources } from "./bundle-extension-sources.mjs";
import { PACKAGE_ROOT } from "./extension-sources.mjs";

test("packaged ordinary updater executes reviewed inventory; eligible managed hosts attempt zero installers or execve restarts", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "pi-pa-updater-package-"));
  try {
    writeFileSync(join(outputRoot, "package.json"), '{"type":"module"}\n');
    symlinkSync(resolve(PACKAGE_ROOT, "node_modules"), join(outputRoot, "node_modules"), "dir");
    await bundleExtensionSources({ outputRoot, environment: { PI_PA_PLUGIN_SELECTION: '{"proper-base":true}' } });
    assert.deepEqual(readFileSync(join(outputRoot, "pi-extension/vendor/inventory.mjs")),
      readFileSync(resolve(PACKAGE_ROOT, "vendor/proper-pi-extensions/proper-base/src/auto-update/inventory.mjs")));
    for (const mode of ["ordinary", "managed", "off-only", "managed-root-only", "missing-helper"]) {
      if (mode === "missing-helper") unlinkSync(join(outputRoot, "pi-extension/vendor/inventory.mjs"));
      const stdout = execFileSync(process.execPath, [
        "--import", import.meta.resolve("tsx/esm"),
        resolve(PACKAGE_ROOT, "src/__tests__/fixtures/proper-updater-host.mjs"),
        join(outputRoot, "pi-extension/vendor/proper-base.js"), mode,
      ], { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 30_000, env: { ...process.env, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" } });
      const evidence = JSON.parse(stdout.trim().split("\n").at(-1));
      assert.equal(evidence.mode, mode);
      assert.equal(evidence.updaterInstallSubprocesses, mode === "ordinary" ? 1 : 0);
      assert.equal(evidence.automaticRestarts, mode === "ordinary" ? 1 : 0);
    }
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
