import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertBaselineReproduced,
  parseArgs,
  resolveStoreAddonVersion,
  resolveStoreOutput,
  workloadPlan,
  REGISTRY_OPERATION_MIX,
} from "../../../../scripts/pap-167-pi-retry-smoke.mjs";

test("PAP-167 retry harness resolves the installed output from only the Pi addon environment", () => {
  const root = mkdtempSync(join(tmpdir(), "pap-167-output-resolution-"));
  const output = join(root, "pa-platform-0.1.100");
  const addon = join(output, "share", "pa-platform", "native-addons", "pi-node-24", "better_sqlite3.node");
  try {
    mkdirSync(join(output, "bin"), { recursive: true });
    mkdirSync(join(addon, ".."), { recursive: true });
    writeFileSync(join(output, "bin", "ppa"), "fixture");
    writeFileSync(addon, "fixture");

    assert.equal(resolveStoreOutput(undefined, { PA_PI_SQLITE_NATIVE_BINDING: addon }), resolve(output));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PAP-167 retry harness fails clearly when no addon ancestor contains bin/ppa", () => {
  const root = mkdtempSync(join(tmpdir(), "pap-167-invalid-output-"));
  const addon = join(root, "share", "pa-platform", "native-addons", "pi-node-24", "better_sqlite3.node");
  try {
    mkdirSync(join(addon, ".."), { recursive: true });
    writeFileSync(addon, "fixture");

    assert.throws(
      () => resolveStoreOutput(undefined, { PA_PI_SQLITE_NATIVE_BINDING: addon }),
      /no ancestor .* contains bin\/ppa/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseArgs reads the calibrated operation count and baseline-calibrate mode", () => {
  const args = parseArgs(["--regression", "--runs", "20", "--operations", "250", "store-output"]);
  assert.equal(args.regression, true);
  assert.equal(args.baselineCalibrate, false);
  assert.equal(args.runs, 20);
  assert.equal(args.operations, 250);
  assert.equal(args.storeArg, "store-output");

  const baseline = parseArgs(["--baseline-calibrate", "store-output"]);
  assert.equal(baseline.baselineCalibrate, true);
  assert.equal(baseline.regression, false);
  assert.equal(baseline.operations, 250);
});

test("workloadPlan distributes the operation count across the fixed mix", () => {
  const plan = workloadPlan(250);
  assert.equal(plan.operations, 250);
  assert.deepEqual(plan.mix, REGISTRY_OPERATION_MIX);
  const total = Object.values(plan.perKind).reduce((sum, count) => sum + count, 0);
  assert.equal(total, 250);
  assert.equal(plan.perKind.appendRegistryEvent, 50);
  assert.equal(plan.perKind.queryDeploymentStatuses, 50);
  assert.equal(plan.perKind.queryDeploymentStatus, 50);
  assert.equal(plan.perKind.getDeploymentEvents, 50);
  assert.equal(plan.perKind.readRegistry, 50);

  const partial = workloadPlan(3);
  assert.equal(partial.operations, 3);
  assert.deepEqual(partial.perKind, {
    appendRegistryEvent: 1,
    queryDeploymentStatuses: 1,
    queryDeploymentStatus: 1,
    getDeploymentEvents: 0,
    readRegistry: 0,
  });
});

test("resolveStoreAddonVersion reads the resolved manifest dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "pap-167-addon-version-"));
  try {
    const share = join(root, "share", "pa-platform");
    mkdirSync(share, { recursive: true });
    writeFileSync(join(share, "package.json"), JSON.stringify({ dependencies: { "better-sqlite3": "11.6.0" } }));
    assert.equal(resolveStoreAddonVersion(root), "11.6.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertBaselineReproduced accepts a matching cleanup failure and fails closed otherwise", () => {
  const reproduced = {
    run: 1,
    processExit: { code: 134 },
    signatures: { removeEnvironmentCleanupHook: true, statementDestructor: true, assertion: true },
    boundedStderr: "Assertion failed: (env) != nullptr",
  };
  assert.doesNotThrow(() => assertBaselineReproduced([reproduced]));

  const clean = {
    run: 1,
    processExit: { code: 0 },
    signatures: { removeEnvironmentCleanupHook: false, statementDestructor: false, assertion: false },
    boundedStderr: "",
  };
  assert.throws(() => assertBaselineReproduced([clean]), /did not abort/);
});
