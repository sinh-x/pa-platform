import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRegistryEvent, closeDb, ensureDeployDir, queryDeploymentStatus, readProcessFingerprint } from "@pa-platform/pa-core";
import { cleanupPiPromptArgs, consumePiPromptArgs, PiPromptCleanupError, piPromptDiagnostic, PI_PROMPT_MAX_BYTES, preparePiPrompt } from "../prompt-transport.js";
import { createRuntimeStartGate } from "../runtime-start-gate.js";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PiAdapter, readPiBackgroundConfig, readPiSupervisorOwnership, type PiBackgroundConfig } from "../adapter.js";
import { runPiBackgroundRunner } from "../background-runner.js";

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

type PreparationFault = "exclusive-open" | "write" | "fsync" | "close" | "replacement" | "cleanup" | "startup-cleanup";
async function preparationFault(variant: PreparationFault, run: () => void | Promise<void>): Promise<void> {
  const original = { open: fs.openSync, write: fs.writeFileSync, sync: fs.fsyncSync, close: fs.closeSync, unlink: fs.unlinkSync, rename: fs.renameSync };
  const inputs = new Map<number, string>(); let fired = false;
  const fault = () => Object.assign(new Error("synthetic preparation failure"), { code: "EIO" });
  try {
    fs.openSync = (path, flags, mode) => {
      if (String(path).endsWith(".input") && typeof flags === "number" && (flags & fs.constants.O_CREAT)) {
        if (variant === "exclusive-open") { original.write(path, "foreign replacement", { mode: 0o400 }); throw Object.assign(fault(), { code: "EEXIST" }); }
        const fd = original.open(path, flags, mode); inputs.set(fd, String(path)); return fd;
      }
      return original.open(path, flags, mode);
    };
    fs.writeFileSync = (file, data, options) => {
      if (variant === "write" && typeof file === "number" && inputs.has(file) && !fired) { fired = true; original.write(file, "partial"); throw fault(); }
      return original.write(file, data, options);
    };
    fs.fsyncSync = fd => {
      if (["fsync", "replacement", "cleanup"].includes(variant) && inputs.has(fd) && !fired) {
        fired = true; const path = inputs.get(fd)!;
        if (variant === "replacement") { original.rename(path, `${path}.original`); original.write(path, "foreign replacement", { mode: 0o400 }); }
        throw fault();
      }
      return original.sync(fd);
    };
    fs.closeSync = fd => {
      const input = inputs.delete(fd); original.close(fd);
      if (variant === "close" && input && !fired) { fired = true; throw fault(); }
    };
    fs.unlinkSync = path => {
      if ((variant === "cleanup" || variant === "startup-cleanup") && String(path).includes(".cleanup-") && String(path).endsWith("/input")) throw Object.assign(fault(), { code: "EACCES" });
      return original.unlink(path);
    };
    syncBuiltinESMExports(); await run();
  } finally {
    fs.openSync = original.open; fs.writeFileSync = original.write; fs.fsyncSync = original.sync; fs.closeSync = original.close; fs.unlinkSync = original.unlink; fs.renameSync = original.rename; syncBuiltinESMExports();
    for (const fd of inputs.keys()) { try { original.close(fd); } catch { /* an injected close may already have completed */ } }
  }
}

for (const variant of ["exclusive-open", "write", "fsync", "close", "replacement", "cleanup"] as const) test(`PAP-318 preparation ${variant} failure preserves owned cleanup state and foreign evidence`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pap318-preparation-"));
  try {
    const primer = join(root, "primer.md"); writeFileSync(primer, "ordinary");
    await preparationFault(variant, () => {
      assert.throws(() => preparePiPrompt(primer, "ordinary\n<protected-review-metadata>synthetic-private-context</protected-review-metadata>"), error => {
        assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /synthetic-private-context/);
        assert.equal(error instanceof PiPromptCleanupError, ["close", "replacement", "cleanup"].includes(variant)); return true;
      });
    });
    if (variant === "exclusive-open") assert.equal(fs.readFileSync(snapshotPath(root), "utf8"), "foreign replacement");
    if (variant === "replacement") {
      assert.ok(readdirSync(root).some(path => path.endsWith(".original")));
      const claim = readdirSync(root).find(path => path.includes(".cleanup-"))!;
      assert.equal(fs.readFileSync(join(root, claim, "input"), "utf8"), "foreign replacement");
    }
    if (["write", "fsync", "close"].includes(variant)) assert.deepEqual(readdirSync(root), ["primer.md"]);
    if (variant === "cleanup") assert.ok(readdirSync(root).some(path => path.includes(".cleanup-")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PAP-318 adapter and persistent supervisor truthfully report uncertain preparation cleanup without spawning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap318-preparation-owner-")), prior = { ...process.env }; closeDb();
  try {
    const primerPath = join(root, "primer.md"); writeFileSync(primerPath, incident); let spawns = 0;
    const adapter = new PiAdapter({ cwd: root, env: {}, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: { spawnProcess() { spawns++; throw Error("must not spawn"); } } });
    await preparationFault("cleanup", async () => {
      const result = await adapter.spawn({ primerPath, deployId: "d-318aaa", mode: "dry-run" });
      assert.equal(result.exitCode, 1); assert.equal(result.metadata?.cleanupVerified, false); assert.match(result.errorMessage!, /PI_PROMPT_CLEANUP/);
    });
    for (const key of Object.keys(process.env)) if (key.startsWith("PA_")) delete process.env[key];
    process.env.PA_AI_USAGE_HOME = root; process.env.PA_REGISTRY_DB = join(root, "registry.db");
    appendRegistryEvent({ deployment_id: "d-318bbb", team: "builder", runtime: "pi", event: "started", timestamp: new Date().toISOString() });
    const config: PiBackgroundConfig = { schemaVersion: 1, ownershipToken: "inert-owner", deploymentId: "d-318bbb", team: "builder", cwd: root, primerPath, logFile: join(root, "pi.log"), sessionId: "inert-session", managed: false, skills: [] };
    await preparationFault("cleanup", () => runPiBackgroundRunner(config, { supervision: { spawnProcess() { spawns++; throw Error("must not spawn"); } } }));
    const ownership = readPiSupervisorOwnership(join(root, "pi-supervisor.json"));
    assert.match(ownership?.error ?? "", /PI_PROMPT_CLEANUP/); assert.equal(ownership?.terminalStatus, "failed");
    assert.equal(queryDeploymentStatus(config.deploymentId)?.status, "crashed", "retain the existing registry failure-event contract");
    assert.equal(ownership?.cleanupVerified, false);
    assert.equal(readdirSync(root).filter(path => path.includes(".cleanup-")).length, 2);
    // Exercise the OUTER background adapter too: a known-dead runner must not
    // overwrite the real supervisor's retained-input fact with process cleanup.
    assert.equal(spawns, 0);
    let admittedChildren = 0;
    for (const [variant, deployId] of [["cleanup", "d-318ccc"], ["startup-cleanup", "d-318ddd"]] as const) {
      const outerRoot = join(root, "deployments", deployId); mkdirSync(outerRoot, { recursive: true });
      const outerPrimer = join(outerRoot, "primer.md"); writeFileSync(outerPrimer, incident);
      appendRegistryEvent({ deployment_id: deployId, team: "builder", runtime: "pi", event: "started", timestamp: new Date().toISOString() });
      let runnerDone: Promise<void> | undefined;
      const outer = new PiAdapter({ cwd: root, env: { PA_TEAM: "builder" }, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined,
        supervision: {
          launchBackgroundRunner(_path, configPath) {
            runnerDone = runPiBackgroundRunner(readPiBackgroundConfig(configPath), { supervision: {
              spawnProcess() { spawns++; throw Error("synthetic no-child spawn failure"); }, onSpawn() { admittedChildren++; },
            } });
            return Object.assign(new EventEmitter(), { pid: 830318, unref() {} }) as never;
          }, processGroupGone: () => true, sendSignal() {},
        } });
      await preparationFault(variant, async () => {
        const result = await outer.spawn({ primerPath: outerPrimer, deployId, mode: "background" });
        await runnerDone;
        assert.equal(result.exitCode, 1); assert.equal(result.metadata?.cleanupVerified, false); assert.match(result.errorMessage!, /PI_PROMPT_CLEANUP/);
      });
      assert.equal(readPiSupervisorOwnership(join(outerRoot, "pi-supervisor.json"))?.cleanupVerified, false);
      assert.equal(readdirSync(outerRoot).filter(path => path.includes(".cleanup-")).length, 1);
    }
    assert.equal(spawns, 1, "only the successful-preparation case reaches the throwing OS-spawn seam");
    assert.equal(admittedChildren, 0, "neither path starts an actual Pi child");
  } finally { closeDb(); process.env = prior; rmSync(root, { recursive: true, force: true }); }
});

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
  const root = mkdtempSync(join(tmpdir(), "pap318-primer-")), prior = process.env;
  closeDb();
  try {
    // Native resume provenance must be owned by this fixture, not the parent PA deployment.
    process.env = Object.fromEntries(Object.entries(prior).filter(([key]) => !/^(PA_|PI_)/.test(key)));
    Object.assign(process.env, { PA_AI_USAGE_HOME: join(root, "usage"), PA_REGISTRY_DB: join(root, "registry.db") });
    const bin = join(root, "bin"), primerPath = join(root, "primer.md"); mkdirSync(bin);
    writeFileSync(primerPath, incident);
    writeFileSync(join(bin, "pi"), `#!${process.execPath}\nconst crypto=require('node:crypto'); const body=process.argv.at(-1); console.log(JSON.stringify({type:'message',content:JSON.stringify({bytes:Buffer.byteLength(body),sha256:crypto.createHash('sha256').update(body).digest('hex'),sessionId:process.argv[process.argv.indexOf('--session-id')+1],maxArg:Math.max(...require('node:fs').readFileSync('/proc/self/cmdline').toString().split('\\0').map(x=>Buffer.byteLength(x)))})}));\n`, { mode: 0o700 });
    const adapter = new PiAdapter({ cwd: root, env: { PATH: bin }, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined });
    const opts = { primerPath, deployId: "d-318eee", mode: "dry-run" as const };
    let sessionId: string;
    const resumedFromDeploymentId = "d-318ddd";
    if (resume) {
      sessionId = "recorded-nonanalyst-primer-fixture";
      appendRegistryEvent({ deployment_id: resumedFromDeploymentId, team: "coordinator", mode: "coordinate", runtime: "pi", event: "started", timestamp: new Date().toISOString() });
      const directory = ensureDeployDir(resumedFromDeploymentId);
      writeFileSync(join(directory, adapter.sessionFileName), sessionId, { mode: 0o600 });
    } else sessionId = adapter.allocateSessionId();
    const result = await (resume ? adapter.resume({ ...opts, sessionId, resumedFromDeploymentId }) : adapter.spawn({ ...opts, sessionId }));
    assert.equal(result.exitCode, 0, result.errorMessage);
    // The production output projector stores the inert child's digest, not its body.
    const activity = adapter.extractActivity(root);
    const observed = JSON.parse(activity.find(event => event.kind === "text")!.body);
    assert.equal(observed.bytes, Buffer.byteLength(incident)); assert.equal(observed.sha256, digest(incident));
    assert.equal(observed.sessionId, sessionId, "the real child receives the allocated fresh or owner-recorded original token");
    assert.ok(observed.maxArg < 128 * 1024);
    assert.deepEqual(readdirSync(root).filter(path => path.endsWith(".input")), []);
  } finally { closeDb(); process.env = prior; rmSync(root, { recursive: true, force: true }); }
});
