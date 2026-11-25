import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { closeDb, emitStartedEvent, ensureDeployDir, readProcessFingerprint, requiresRepositoryIsolation } from "@pa-platform/pa-core";
import { PiAdapter, runPiManagedProcess } from "../adapter.js";
import { PI_PROCESS_IDENTITY_FILE, readPiProcessIdentity, recordPiProcessIdentity } from "../process-identity.js";

const modes = [["builder", "orchestrator"], ["builder", "implement"], ["builder", "worker"], ["requirements", "analyze"],
  ["requirements", "review-auto"], ["analyst", "analyze"], ["coordinator", "coordinate"], ["instruction-lab", "develop"],
  ["review", "verify"], ["rollout", "rollout"], ["repo-setup", "setup"], ["rogue-one", "rogue-one"], ["custom", "configured"]];
const id = "d-249abc";
async function fixture(team: string, mode: string, run: (root: string, directory: string) => Promise<void>, started = true) {
  const previous = process.env, root = mkdtempSync(join(tmpdir(), "pap334-process-launch-")); closeDb();
  try {
    process.env = { ...previous, PA_AI_USAGE_HOME: join(root, "usage"), PA_REGISTRY_DB: join(root, "registry.db"), PA_TEAM: team, PA_MODE: mode };
    const directory = ensureDeployDir(id);
    if (started) emitStartedEvent({ deploymentId: id, team, mode, runtime: "pi", binary: "ppa" });
    await run(root, directory);
  } finally { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); }
}
for (const [team, mode] of modes) {
  test(`${team}/${mode}: real managed child anchor precedes supervisor readiness without a document selection`, () => fixture(team!, mode!, async (root, directory) => {
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "pi"), `#!${process.execPath}\nsetTimeout(() => process.exit(0), 150);\n`, { mode: 0o700 });
    let spawnedPid: number | undefined;
    const result = await runPiManagedProcess([], root, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, {
      primerPath: join(directory, "primer.md"), deployId: id, mode: "dry-run",
    }, "synthetic-session", [], { onSpawn: (pid) => {
      spawnedPid = pid;
      assert.deepEqual(readPiProcessIdentity(id, directory), readProcessFingerprint(pid));
      assert.equal(JSON.parse(readFileSync(join(directory, PI_PROCESS_IDENTITY_FILE), "utf8")).deploymentId, id);
    } });
    assert.equal(result.status, 0, result.spawnError?.message);
    assert.ok(spawnedPid); assert.equal(result.metadata?.["pid"], spawnedPid);
    assert.equal(readPiProcessIdentity(id, directory).pid, spawnedPid);
    assert.equal(readProcessFingerprint(spawnedPid), undefined);
  }));
}

test("foreground eligible nonAnalyst startup records its anchor before publishing the actual child PID", async () => {
  for (const [team, mode] of modes.filter(([team, mode]) => !requiresRepositoryIsolation({ team, mode }))) await fixture(team!, mode!, async (root, directory) => {
    const primer = join(directory, "primer.md"); writeFileSync(primer, "synthetic fixture");
    const input = new Readable({ read() {} });
    let running = true, published = false;
    let exit: ((event: { exitCode: number; signal: number }) => void) | undefined;
    const pty = { pid: process.pid, write() {}, resize() {}, kill() {}, onData() {}, onExit(handler: typeof exit) { exit = handler; } };
    const adapter = new PiAdapter({ cwd: root, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, env: process.env,
      supervision: { spawnPty: () => pty as never, input: input as never, output: { write: () => true } as never, processExists: () => running } });
    try {
      const pending = adapter.spawn({ primerPath: primer, deployId: id, mode: "foreground", onPid: (pid) => {
        published = true; assert.equal(pid, process.pid);
        assert.deepEqual(readPiProcessIdentity(id, directory), readProcessFingerprint(pid));
      } });
      await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(published, true);
      running = false; assert.ok(exit); exit({ exitCode: 0, signal: 0 });
      assert.equal((await pending).exitCode, 0);
    } finally { input.destroy(); }
  });
});

test("foreground protected routes reject before probes, PTY, anchor and PID callbacks", async () => {
  for (const [team, mode] of modes.filter(([team, mode]) => requiresRepositoryIsolation({ team, mode }))) await fixture(team!, mode!, async (root, directory) => {
    let effects = 0;
    const adapter = new PiAdapter({ cwd: root, env: process.env, versionProbe: () => { effects++; return "0.84.4"; },
      nativeRegistryProbe: () => { effects++; return undefined; }, supervision: { spawnPty: () => { effects++; throw Error("not admitted"); } } });
    const result = await adapter.spawn({ primerPath: join(directory, "primer.md"), deployId: id, mode: "foreground", onPid: () => { effects++; } });
    assert.equal(result.exitCode, 1); assert.match(result.errorMessage!, /REPOSITORY_ISOLATION_UNAVAILABLE/);
    assert.equal(effects, 0); assert.throws(() => readPiProcessIdentity(id, directory));
  });
});

test("absent child or environment-only role strings never manufacture an authenticated launch anchor", () => fixture("builder", "orchestrator", async (root, directory) => {
  assert.equal(recordPiProcessIdentity(id, directory, 0), false);
  assert.throws(() => readPiProcessIdentity(id, directory));
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!${process.execPath}\nsetTimeout(() => process.exit(0), 100);\n`, { mode: 0o700 });
  const result = await runPiManagedProcess([], root, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, {
    primerPath: join(directory, "primer.md"), deployId: id, mode: "dry-run",
  }, "synthetic-session", []);
  assert.equal(result.status, 0); assert.throws(() => readPiProcessIdentity(id, directory));
}, false));
