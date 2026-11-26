import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SessionManager } from "../agent-api/ws/session-hub.js";
import { appendRegistryEvent, closeDb } from "../registry/index.js";
import { getDeployPaths } from "../deploy/paths.js";

test("PAP-349 WebSocket session execution cannot bypass Rogue-One capture/retention", () => {
  const previous = process.env, root = mkdtempSync(join(tmpdir(), "rogue-session-")); closeDb();
  process.env = { ...previous, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
  try {
    let spawns = 0;
    const manager = new SessionManager({ env: {}, runtimes: { pi: {} }, spawnFn: (() => { spawns++; throw new Error("must not spawn"); }) as never });
    const sink = { send() {} };
    const direct = manager.start({ prompt: "fixture", runtime: "pi", env: { PA_TEAM: "rogue-one" } }, sink);
    assert.equal(direct.ok, false);
    const id = "d-349abc";
    appendRegistryEvent({ deployment_id: id, team: "rogue-one", mode: "direct", rogue_one: true, event: "started", timestamp: new Date().toISOString(), runtime: "pi", binary: "ppa" });
    const dir = getDeployPaths(id).deployDir; mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "session-id-pi.txt"), "native-rogue-session", { mode: 0o600 });
    const resumed = manager.resume({ prompt: "fixture", runtime: "pi", deploymentId: id, sessionId: "native-rogue-session" }, sink);
    assert.equal(resumed.ok, false);
    if (!resumed.ok) assert.match(resumed.error, /Only foreground PPA CLI is supported/);
    assert.equal(spawns, 0); assert.equal(manager.activeCount, 0);
  } finally { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); }
});
