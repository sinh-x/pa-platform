import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiAdapter } from "../adapter.js";

const incident = "x".repeat(635831);
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

test("PAP-318 preserves the intended Linux single-argument E2BIG baseline at a real exec", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)", incident], { env: {}, encoding: "utf8" });
  assert.equal((result.error as NodeJS.ErrnoException)?.code, "E2BIG");
  assert.equal(result.pid, 0);
});

test("PAP-318 actual shared adapter delivers incident-sized input intact without an oversized OS argument", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap318-primer-"));
  try {
    const bin = join(root, "bin"), primerPath = join(root, "primer.md"); mkdirSync(bin);
    writeFileSync(primerPath, incident);
    writeFileSync(join(bin, "pi"), `#!${process.execPath}\nconst crypto=require('node:crypto'); const body=process.argv.at(-1); console.log(JSON.stringify({type:'message',content:JSON.stringify({bytes:Buffer.byteLength(body),sha256:crypto.createHash('sha256').update(body).digest('hex'),maxArg:Math.max(...require('node:fs').readFileSync('/proc/self/cmdline').toString().split('\\0').map(x=>Buffer.byteLength(x)))})}));\n`, { mode: 0o700 });
    const adapter = new PiAdapter({ cwd: root, env: { PATH: bin }, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined });
    const result = await adapter.spawn({ primerPath, deployId: "d-primer318", mode: "dry-run" });
    assert.equal(result.exitCode, 0, result.errorMessage);
    // The production output projector stores the inert child's digest, not its body.
    const activity = adapter.extractActivity(root);
    const observed = JSON.parse(activity.find(event => event.kind === "text")!.body);
    assert.equal(observed.bytes, Buffer.byteLength(incident)); assert.equal(observed.sha256, digest(incident));
    assert.ok(observed.maxArg < 128 * 1024);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
