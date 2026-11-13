import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getDb, RegistryAutoJournal, buildAutoWaitlist, type AutoWaitlistView } from "@pa-platform/pa-core";
import { publishAutoNotice, renderAutoUserUnits, sendAutoDesktopNotice } from "../auto-background.js";
test("units render only bounded fixed scanner commands, opt-in timer and no missed-run backlog", () => {
  const units = renderAutoUserUnits("/synthetic/node", "/synthetic/ppa cli.js");
  assert.match(units.service, /ExecStart="\/synthetic\/node" "\/synthetic\/ppa cli.js" auto tick --json/);
  assert.match(units.timer, /OnUnitInactiveSec=30min/); assert.match(units.timer, /Persistent=false/);
  assert.doesNotMatch(JSON.stringify(units), /auto approve|auto select|systemctl|deploy builder/);
  assert.throws(() => renderAutoUserUnits("/path\nExecStart=unsafe", "/cli"));
  assert.ok(renderAutoUserUnits("/path%with$dollar", "/cli").service.includes("%%with$$dollar"));
});
test("native notifier is informational and missing desktop is a durable warning, not lost state or approval", () => {
  const oldBus = process.env.DBUS_SESSION_BUS_ADDRESS, oldRuntime = process.env.XDG_RUNTIME_DIR;
  delete process.env.DBUS_SESSION_BUS_ADDRESS; delete process.env.XDG_RUNTIME_DIR;
  try {
    assert.deepEqual(sendAutoDesktopNotice({} as never), { delivery: "unavailable", reason: "desktop-unavailable" });
  } finally {
    if (oldBus !== undefined) process.env.DBUS_SESSION_BUS_ADDRESS = oldBus;
    if (oldRuntime !== undefined) process.env.XDG_RUNTIME_DIR = oldRuntime;
  }
});
test("default controls never send notifications; enabled duplicate events coalesce and failure remains inspectable", () => {
  const db = getDb(":memory:"); try {
    const j = new RegistryAutoJournal(db), at = new Date().toISOString();
    const s = buildAutoWaitlist({ observedAt: at, completedAt: at, projects: [], tickets: [{ id: "PAP-1", project: "pa-platform", title: "Synthetic", priority: "medium", status: "idea", createdAt: at, ticketSha256: "a".repeat(64), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "missing" } }] });
    const view: AutoWaitlistView = { state: { schemaVersion: "pa-auto-state/v1", snapshot: s, lastAttempt: { at, outcome: "completed", code: null } }, freshness: "fresh", scan: "idle" };
    let calls = 0; const send = () => { calls++; return { delivery: "unavailable" as const, reason: "desktop-unavailable" as const }; };
    assert.equal(publishAutoNotice(j, view, send), null); assert.equal(calls, 0);
    j.setControl(0, { scansEnabled: true, dispatchEnabled: true, paused: false }, () => {});
    assert.equal(publishAutoNotice(j, view, send)!.delivery, "unavailable"); assert.equal(publishAutoNotice(j, view, send), null); assert.equal(calls, 1);
  } finally { db.close(); }
});
test("compiled disabled timer and unit description initialize no registry or user service", () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-timer-cli-"));
  try {
    const env = { ...process.env, PA_AI_USAGE_HOME: join(root, "missing"), PA_PLATFORM_CONFIG: join(root, "config"), PA_PLATFORM_HOME: join(root, "home"), PA_REGISTRY_DB: join(root, "registry.db") };
    const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
    for (const action of ["tick", "units"]) {
      const r = spawnSync(process.execPath, [cli, "auto", action, "--json"], { env, encoding: "utf8", timeout: 15_000 });
      assert.equal(r.status, 0, r.stderr || r.stdout); assert.equal(r.stderr, ""); const result = JSON.parse(r.stdout);
      if (action === "tick") { assert.equal(result.outcome, "disabled"); assert.equal(result.executionRequested, false); }
      else { assert.equal(result.installed, false); assert.equal(result.enabled, false); }
    }
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
