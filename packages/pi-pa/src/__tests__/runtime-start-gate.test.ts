import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readProcessFingerprint } from "@pa-platform/pa-core";
import { createRuntimeStartGate } from "../runtime-start-gate.js";

async function fixture(run: (f: { root: string; marker: string; gate: ReturnType<typeof createRuntimeStartGate>; child: ChildProcess; output: () => string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pap271-runtime-gate-")), bin = join(root, "bin"), marker = join(root, "runtime-started"); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');console.log(JSON.stringify({pid:process.pid,stat:require('node:fs').readFileSync('/proc/self/stat','utf8'),options:process.env.NODE_OPTIONS,leaked:process.env.PA_PI_START_NODE_OPTIONS}));\n`, { mode: 0o700 });
  const gate = createRuntimeStartGate(root, [], { ...process.env, PATH: bin, NODE_OPTIONS: "--no-warnings" });
  const child = spawn(gate.file, gate.args, { env: gate.env, stdio: ["ignore", "pipe", "pipe"] }); let output = "", error = "";
  child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { error += data; });
  try { await once(child, "spawn"); await run({ root, marker, gate, child, output: () => output }); assert.equal(error, ""); }
  finally { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill(); await ended; } rmSync(root, { recursive: true, force: true }); }
}
test("actual runtime gate executes no target code until admission release and preserves child PID/start incarnation across exec", () => fixture(async f => {
  await new Promise(resolve => setTimeout(resolve, 80)); const anchor = readProcessFingerprint(f.child.pid!)!;
  assert.ok(anchor); assert.equal(existsSync(f.marker), false); const ended = once(f.child, "close");
  f.gate.release(); assert.throws(() => f.gate.release()); assert.deepEqual(await ended, [0, null]);
  assert.equal(existsSync(f.marker), true); const result = JSON.parse(f.output());
  assert.equal(result.pid, anchor.pid); assert.equal(result.stat.slice(result.stat.lastIndexOf(')') + 2).split(' ')[19], anchor.startTimeTicks);
  assert.equal(result.options, "--no-warnings"); assert.equal(result.leaked, undefined);
}));
test("unreleased/failed admission can terminate its bootstrap without executing runtime code", () => fixture(async f => {
  await new Promise(resolve => setTimeout(resolve, 80)); const ended = once(f.child, "close"); f.child.kill(); await ended;
  assert.equal(existsSync(f.marker), false); assert.equal(f.output(), "");
}));
