import assert from "node:assert/strict";
import test from "node:test";
import { detectPermissionWaitEvidence, resolvePermissionWaitThresholdMs } from "../background-runner.js";

test("resolvePermissionWaitThresholdMs defaults to 120s and supports override", () => {
  assert.equal(resolvePermissionWaitThresholdMs({}), 120_000);
  assert.equal(resolvePermissionWaitThresholdMs({ PA_PERMISSION_WAIT_TIMEOUT_SECONDS: "5" }), 5_000);
  assert.equal(resolvePermissionWaitThresholdMs({ PA_PERMISSION_WAIT_TIMEOUT_SECONDS: "0" }), 120_000);
  assert.equal(resolvePermissionWaitThresholdMs({ PA_PERMISSION_WAIT_TIMEOUT_SECONDS: "nope" }), 120_000);
});

test("detectPermissionWaitEvidence returns evidence for unresolved idle permission wait past threshold", () => {
  const askedTs = 1_714_000_000_000;
  const log = [
    JSON.stringify({ ts: askedTs, deploy_id: "d-test", agent: "opencode", event: "permission.asked", data: { permission: "external_directory" } }),
    JSON.stringify({ ts: askedTs + 1_000, deploy_id: "d-test", agent: "opencode", event: "session.idle", data: { status: "idle" } }),
  ].join("\n");
  const evidence = detectPermissionWaitEvidence(log, askedTs + 8_000, 5_000);
  assert.ok(evidence);
  assert.equal(evidence.permission, "external_directory");
  assert.equal(evidence.askedAtMs, askedTs);
});

test("detectPermissionWaitEvidence does not fire when replied or still below threshold", () => {
  const askedTs = 1_714_000_000_000;
  const repliedLog = [
    JSON.stringify({ ts: askedTs, deploy_id: "d-test", agent: "opencode", event: "permission.asked", data: { permission: "external_directory" } }),
    JSON.stringify({ ts: askedTs + 200, deploy_id: "d-test", agent: "opencode", event: "permission.replied", data: { decision: "approved" } }),
    JSON.stringify({ ts: askedTs + 1_000, deploy_id: "d-test", agent: "opencode", event: "session.idle", data: { status: "idle" } }),
  ].join("\n");
  assert.equal(detectPermissionWaitEvidence(repliedLog, askedTs + 8_000, 5_000), null);

  const unresolvedLog = [
    JSON.stringify({ ts: askedTs, deploy_id: "d-test", agent: "opencode", event: "permission.asked", data: { permission: "external_directory" } }),
    JSON.stringify({ ts: askedTs + 1_000, deploy_id: "d-test", agent: "opencode", event: "session.idle", data: { status: "idle" } }),
  ].join("\n");
  assert.equal(detectPermissionWaitEvidence(unresolvedLog, askedTs + 2_000, 5_000), null);
});
