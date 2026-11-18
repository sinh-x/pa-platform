import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessFingerprint } from "@pa-platform/pa-core";
import { cleanupPiPromptArgs, consumePiPromptArgs, piPromptDiagnostic, PI_PROMPT_MAX_BYTES, preparePiPrompt } from "../prompt-transport.js";
import { createRuntimeStartGate } from "../runtime-start-gate.js";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PiAdapter } from "../adapter.js";

const incident = "x".repeat(635831);
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const snapshotPath = (root: string) => join(root, readdirSync(root).find(path => path.endsWith(".input"))!);

for (const body of ["", "small", "\ufeffUnicode: Việt 日本語 🚀\r\n", "trailing\n\n", "no trailing newline", "z".repeat(PI_PROMPT_MAX_BYTES)]) {
  test(`PAP-318 exact UTF-8 memory expansion (${Buffer.byteLength(body)} bytes)`, () => {
    const root = mkdtempSync(join(tmpdir(), "pap318 space 'quote'-"));
    try {
      const primer = join(root, "primer.md"); writeFileSync(primer, body);
      const arg = preparePiPrompt(primer); assert.ok(Buffer.byteLength(arg) < 8192);
      assert.deepEqual(consumePiPromptArgs(["--session-id", "fixture", arg], root), ["--session-id", "fixture", body]);
      assert.equal(readdirSync(root).some(path => path.endsWith(".input")), false);
      cleanupPiPromptArgs([arg], root);
      const childArg = preparePiPrompt(primer);
      const child = spawnSync(process.execPath, ["-e", "const body=process.argv.at(-1);process.stdout.write(JSON.stringify({bytes:Buffer.byteLength(body),sha256:require('node:crypto').createHash('sha256').update(body).digest('hex')}))", "--", childArg], {
        env: { PA_DEPLOYMENT_DIR: root, NODE_OPTIONS: `--import=${new URL("../../dist/prompt-preload.js", import.meta.url).href}` }, encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), { bytes: Buffer.byteLength(body), sha256: digest(body) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("PAP-318 rejects oversized, malformed, missing, aliased, nonregular and unsafe source inputs without echoing content", () => {
  const root = mkdtempSync(join(tmpdir(), "pap318-source-"));
  try {
    const path = join(root, "primer.md"), other = join(root, "other");
    for (const variant of ["missing", "oversized", "invalid", "symlink", "hardlink", "directory", "writable", "unreadable"]) {
      rmSync(path, { force: true, recursive: true }); rmSync(other, { force: true });
      if (variant === "oversized") writeFileSync(path, "x".repeat(PI_PROMPT_MAX_BYTES + 1));
      else if (variant === "invalid") writeFileSync(path, Buffer.from([0xc0, 0xaf]));
      else if (variant === "symlink") { writeFileSync(other, "safe"); symlinkSync(other, path); }
      else if (variant === "hardlink") { writeFileSync(other, "safe"); linkSync(other, path); }
      else if (variant === "directory") mkdirSync(path);
      else if (variant !== "missing") { writeFileSync(path, "synthetic private canary"); chmodSync(path, variant === "writable" ? 0o666 : 0o200); }
      assert.throws(() => preparePiPrompt(path), error => error instanceof Error && error.message === piPromptDiagnostic(), variant);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const variant of ["missing", "changed", "replaced", "symlink", "hardlink", "mode", "foreign-root"]) {
  test(`PAP-318 child rejects ${variant} snapshot before substituted content is delivered`, () => {
    const root = mkdtempSync(join(tmpdir(), "pap318-race-"));
    try {
      const primer = join(root, "primer.md"); writeFileSync(primer, "original");
      const arg = preparePiPrompt(primer), path = snapshotPath(root);
      if (variant === "missing") rmSync(path);
      else if (variant === "changed") { chmodSync(path, 0o600); writeFileSync(path, "modified"); chmodSync(path, 0o400); }
      else if (variant === "replaced") { renameSync(path, `${path}.old`); writeFileSync(path, "original", { mode: 0o400 }); }
      else if (variant === "symlink") { rmSync(path); symlinkSync(primer, path); }
      else if (variant === "hardlink") linkSync(path, `${path}.alias`);
      else if (variant === "mode") chmodSync(path, 0o600);
      assert.throws(() => consumePiPromptArgs([arg], variant === "foreign-root" ? dirnameForTest(root) : root), /PI_PROMPT_INPUT/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
function dirnameForTest(root: string): string { return join(root, "foreign"); }

test("PAP-318 atomic cleanup claim retains a concurrent public-path replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "pap318-claim-")), originalRename = fs.renameSync;
  try {
    const primer = join(root, "primer.md"); writeFileSync(primer, "original"); const arg = preparePiPrompt(primer), path = snapshotPath(root);
    fs.renameSync = (from, to) => {
      if (from === path) { originalRename(path, `${path}.original`); writeFileSync(path, "foreign replacement", { mode: 0o400 }); }
      originalRename(from, to);
    };
    syncBuiltinESMExports();
    assert.throws(() => cleanupPiPromptArgs([arg], root), /PI_PROMPT_INPUT/);
    assert.equal(existsSync(`${path}.original`), true);
    const claim = readdirSync(root).find(name => name.includes(".cleanup-"))!;
    assert.equal(fs.readFileSync(join(root, claim, "input"), "utf8"), "foreign replacement");
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test("PAP-318 known no-child setup failure cleans input; uncertain PTY failure retains explicit ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap318-start-failure-"));
  try {
    const primerPath = join(root, "primer.md"); writeFileSync(primerPath, incident);
    const options = { cwd: root, env: { PATH: root }, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined };
    const failed = await new PiAdapter(options).spawn({ primerPath, deployId: "d-nostart318", mode: "foreground", beforeRuntimeStart() {} });
    assert.equal(failed.exitCode, 1); assert.match(failed.errorMessage!, /PI_PROCESS_START/);
    assert.equal(readdirSync(root).some(path => path.endsWith(".input")), false);
    const unknown = await new PiAdapter({ ...options, supervision: { spawnPty() { throw new Error("synthetic unproven spawn outcome"); } } }).spawn({ primerPath, deployId: "d-unknown318", mode: "foreground" });
    assert.equal(unknown.exitCode, 1); assert.match(unknown.errorMessage!, /PI_PROMPT_CLEANUP/);
    assert.equal(unknown.metadata?.cleanupVerified, false); assert.equal(readdirSync(root).filter(path => path.endsWith(".input")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PAP-318 prompt failure is a fixed bounded five-field diagnostic", () => {
  const diagnostic = piPromptDiagnostic(); assert.ok(diagnostic.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(diagnostic.split(`${label}:`).length - 1, 1);
});

test("PAP-318 large prompt crosses the actual foreground inert gate only after PID/incarnation admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap318-gate-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const bin = join(root, "bin"), primer = join(root, "primer.md"), marker = join(root, "started"); mkdirSync(bin); writeFileSync(primer, incident);
    writeFileSync(join(bin, "pi"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');console.log(JSON.stringify({pid:process.pid,birth:require('node:fs').readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19],bytes:Buffer.byteLength(process.argv.at(-1)),sha256:require('node:crypto').createHash('sha256').update(process.argv.at(-1)).digest('hex')}));`, { mode: 0o700 });
    const arg = preparePiPrompt(primer);
    const preload = new URL("../../dist/prompt-preload.js", import.meta.url);
    const gate = createRuntimeStartGate(root, [arg], { PATH: bin, PA_DEPLOYMENT_DIR: root, NODE_OPTIONS: `--import=${preload.href}` });
    assert.ok(gate.args.every(value => Buffer.byteLength(value) < 128 * 1024));
    child = spawn(gate.file, gate.args, { env: gate.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = ""; child.stdout!.on("data", bytes => { output += bytes; }); child.stderr!.on("data", bytes => { stderr += bytes; });
    await once(child, "spawn"); await new Promise(resolve => setTimeout(resolve, 60));
    const identity = readProcessFingerprint(child.pid!)!; assert.ok(identity); assert.equal(existsSync(marker), false);
    const ended = once(child, "close"); gate.release(); assert.deepEqual(await ended, [0, null]); assert.equal(stderr, "");
    const result = JSON.parse(output); assert.equal(result.pid, identity.pid); assert.equal(result.birth, identity.startTimeTicks);
    assert.equal(result.bytes, incident.length); assert.equal(result.sha256, digest(incident));
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test("PAP-318 preserves the intended Linux single-argument E2BIG baseline at a real exec", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)", incident], { env: {}, encoding: "utf8" });
  assert.equal((result.error as NodeJS.ErrnoException)?.code, "E2BIG");
  assert.equal(result.pid, 0);
});

for (const resume of [false, true]) test(`PAP-318 actual shared adapter ${resume ? "supported resume" : "spawn"} delivers incident-sized input intact without an oversized OS argument`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pap318-primer-"));
  try {
    const bin = join(root, "bin"), primerPath = join(root, "primer.md"); mkdirSync(bin);
    writeFileSync(primerPath, incident);
    writeFileSync(join(bin, "pi"), `#!${process.execPath}\nconst crypto=require('node:crypto'); const body=process.argv.at(-1); console.log(JSON.stringify({type:'message',content:JSON.stringify({bytes:Buffer.byteLength(body),sha256:crypto.createHash('sha256').update(body).digest('hex'),maxArg:Math.max(...require('node:fs').readFileSync('/proc/self/cmdline').toString().split('\\0').map(x=>Buffer.byteLength(x)))})}));\n`, { mode: 0o700 });
    const adapter = new PiAdapter({ cwd: root, env: { PATH: bin }, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined });
    const opts = { primerPath, deployId: "d-primer318", mode: "dry-run" as const };
    const result = await (resume ? adapter.resume({ ...opts, sessionId: "retained-fixture" }) : adapter.spawn(opts));
    assert.equal(result.exitCode, 0, result.errorMessage);
    // The production output projector stores the inert child's digest, not its body.
    const activity = adapter.extractActivity(root);
    const observed = JSON.parse(activity.find(event => event.kind === "text")!.body);
    assert.equal(observed.bytes, Buffer.byteLength(incident)); assert.equal(observed.sha256, digest(incident));
    assert.ok(observed.maxArg < 128 * 1024);
    assert.deepEqual(readdirSync(root).filter(path => path.endsWith(".input")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
