import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { readProcessFingerprint } from "@pa-platform/pa-core";
import { PiAdapter, runPiManagedProcess } from "../adapter.js";
import { PI_PROCESS_IDENTITY_FILE, readPiProcessIdentity, recordPiProcessIdentity } from "../process-identity.js";

for (const role of ["orchestrator", "implement", "worker", "review-auto", "rogue-one"] as const) {
  test(`${role}: managed child identity is recorded before supervisor readiness, using the real spawned incarnation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pap249-process-launch-"));
    const id = "d-249abc";
    try {
      const bin = join(root, "bin"); mkdirSync(bin);
      writeFileSync(join(bin, "pi"), `#!${process.execPath}\nsetTimeout(() => process.exit(0), 150);\n`, { mode: 0o700 });
      let spawnedPid: number | undefined;
      const result = await runPiManagedProcess([], root, { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        PA_TEAM: role === "review-auto" ? "requirements" : role === "rogue-one" ? "rogue-one" : "builder", PA_MODE: role }, {
        primerPath: join(root, "primer.md"), deployId: id, mode: "dry-run",
      }, "synthetic-session", [], { onSpawn: (pid) => {
        spawnedPid = pid;
        assert.deepEqual(readPiProcessIdentity(id, root), readProcessFingerprint(pid));
        assert.equal(readPiProcessIdentity(id, root).pid, pid);
        assert.equal(JSON.parse(readFileSync(join(root, PI_PROCESS_IDENTITY_FILE), "utf8")).deploymentId, id);
      } });
      assert.equal(result.status, 0, result.spawnError?.message);
      assert.ok(spawnedPid); assert.equal(result.metadata?.["pid"], spawnedPid);
      assert.equal(readPiProcessIdentity(id, root).pid, spawnedPid, "retain historical anchor after process exit");
      assert.equal(readProcessFingerprint(spawnedPid), undefined, "fixture child exited rather than leaving a live role deployment");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("foreground builder/reviewer/reporter records the launch incarnation before publishing its PID", async () => {
  for (const mode of ["orchestrator", "implement", "worker", "review-auto", "rogue-one"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pap249-foreground-anchor-"));
    const primer = join(dir, "primer.md"); writeFileSync(primer, "synthetic fixture");
    const input = new Readable({ read() {} });
    let running = true, published = false;
    let exit: ((event: { exitCode: number; signal: number }) => void) | undefined;
    const pty = { pid: process.pid, write() {}, resize() {}, kill() {}, onData() {},
      onExit(handler: typeof exit) { exit = handler; } };
    const adapter = new PiAdapter({ cwd: dir, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined,
      env: { ...process.env, PA_TEAM: mode === "review-auto" ? "requirements" : mode === "rogue-one" ? "rogue-one" : "builder", PA_MODE: mode },
      supervision: { spawnPty: () => pty as never, input: input as never, output: { write: () => true } as never, processExists: () => running } });
    try {
      const pending = adapter.spawn({ primerPath: primer, deployId: "d-249abc", mode: "foreground", onPid: (pid) => {
        published = true; assert.equal(pid, process.pid);
        assert.deepEqual(readPiProcessIdentity("d-249abc", dir), readProcessFingerprint(pid));
      } });
      await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(published, true);
      running = false; assert.ok(exit); exit({ exitCode: 0, signal: 0 });
      assert.equal((await pending).exitCode, 0);
    } finally { input.destroy(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("launch writer never invents an anchor for an absent process; unrelated roles create none", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap249-process-absent-"));
  try {
    assert.equal(recordPiProcessIdentity("d-249abc", root, 0), false);
    assert.throws(() => readPiProcessIdentity("d-249abc", root));
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "pi"), `#!${process.execPath}\nsetTimeout(() => process.exit(0), 100);\n`, { mode: 0o700 });
    const result = await runPiManagedProcess([], root, { ...process.env, PATH: `${bin}:${process.env.PATH}`, PA_TEAM: "writer", PA_MODE: "write" }, {
      primerPath: join(root, "primer.md"), deployId: "d-249abc", mode: "dry-run",
    }, "synthetic-session", []);
    assert.equal(result.status, 0); assert.throws(() => readPiProcessIdentity("d-249abc", root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
