import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackgroundOwnershipConfig, publishBackgroundOwnership, waitForBackgroundOwnership } from "../index.js";

test("background ownership requires matching deployment, token, pid, readiness, and active state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-background-ownership-"));
  try {
    const config = createBackgroundOwnershipConfig(root);
    publishBackgroundOwnership(config.ownershipPath, { schemaVersion: 1, deploymentId: "d-other", ownershipToken: config.ownershipToken, supervisorPid: 42, state: "active", ready: true, updatedAt: new Date().toISOString() });
    let now = 0;
    await assert.rejects(() => waitForBackgroundOwnership({ ...config, deploymentId: "d-owner", supervisorPid: 42 }, { timeoutMs: 2, now: () => now, sleep: async () => { now += 1; } }), /did not acknowledge authenticated ownership/);
    publishBackgroundOwnership(config.ownershipPath, { schemaVersion: 1, deploymentId: "d-owner", ownershipToken: config.ownershipToken, supervisorPid: 42, childPid: 43, state: "active", ready: true, updatedAt: new Date().toISOString() });
    const ready = await waitForBackgroundOwnership({ ...config, deploymentId: "d-owner", supervisorPid: 42 });
    assert.equal(ready.childPid, 43);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background ownership reports authenticated bootstrap failure before pending publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-background-failure-"));
  try {
    const config = createBackgroundOwnershipConfig(root);
    publishBackgroundOwnership(config.ownershipPath, { schemaVersion: 1, deploymentId: "d-owner", ownershipToken: config.ownershipToken, supervisorPid: 42, state: "failed", ready: false, updatedAt: new Date().toISOString(), error: "configuration malformed" });
    await assert.rejects(() => waitForBackgroundOwnership({ ...config, deploymentId: "d-owner", supervisorPid: 42 }), /runner-readiness: configuration malformed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
