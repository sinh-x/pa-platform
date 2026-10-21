#!/usr/bin/env node
// Fixed, isolated software evidence. Run only at the independent matrix boundary.
// No argument/root/receipt/command overrides, live activation or historical proof.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Serialized into a private temp driver; it imports ONLY the authenticated Nix
// output. It never imports checkout TS, uses tsx, calls a launcher or qualifies a
// runtime. FS/process guards are tripwires, not a claim of general OS confinement.
async function installedDriver(root, share) {
  const assert = (await import("node:assert/strict")).default;
  const fs = (await import("node:fs")).default;
  const cp = (await import("node:child_process")).default;
  const http = (await import("node:http")).default;
  const https = (await import("node:https")).default;
  const net = (await import("node:net")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { join, resolve, relative, isAbsolute } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const counts = { fixtureWrites: 0, outsideReads: 0, outsideWrites: 0, subprocesses: 0, network: 0 };
  const inside = (base, path) => { const rel = relative(base, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")); };
  const fds = new Map();
  const pathCheck = (path, writing = false) => {
    const physical = typeof path === "number" ? fds.get(path) : resolve(path instanceof URL ? fileURL(path) : String(path));
    if (!physical || (!inside(root, physical) && (writing || !inside("/nix/store", physical)))) {
      counts[writing ? "outsideWrites" : "outsideReads"]++;
      throw new Error("isolated IO boundary");
    }
    if (writing) counts.fixtureWrites++;
    return physical;
  };
  const fileURL = (url) => { assert.equal(url.protocol, "file:"); return decodeURIComponent(url.pathname); };
  const fail = (kind) => () => { counts[kind]++; throw new Error("isolated effect boundary"); };
  const originalOpen = fs.openSync;
  fs.openSync = (path, flags, ...args) => {
    const writing = typeof flags === "string" ? /[wa+]/.test(flags) : Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
    const physical = pathCheck(path, writing); const fd = originalOpen(path, flags, ...args); fds.set(fd, physical); return fd;
  };
  for (const name of ["readFileSync", "lstatSync", "statSync", "readdirSync", "realpathSync", "accessSync", "existsSync", "readlinkSync"]) {
    const original = fs[name]; const guarded = (path, ...args) => { pathCheck(path); return original(path, ...args); };
    if (original.native) guarded.native = (path, ...args) => { pathCheck(path); return original.native(path, ...args); };
    fs[name] = guarded;
  }
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync", "rmSync", "rmdirSync", "chmodSync", "truncateSync", "writeSync", "ftruncateSync", "fsyncSync"]) {
    const original = fs[name]; fs[name] = (path, ...args) => { pathCheck(path, true); return original(path, ...args); };
  }
  for (const name of ["renameSync", "linkSync", "symlinkSync", "copyFileSync"]) {
    const original = fs[name]; fs[name] = (from, to, ...args) => { pathCheck(from, true); pathCheck(to, true); return original(from, to, ...args); };
  }
  // The fixed driver needs no async/stream IO; reject instead of leaving an
  // unobserved escape seam. Native SQLite IO is fixed to the fixture DB below.
  for (const name of ["open", "readFile", "writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "chmod", "truncate", "link", "symlink", "copyFile"]) {
    fs[name] = fail("outsideWrites"); fs.promises[name] = fail("outsideWrites");
  }
  fs.createWriteStream = fail("outsideWrites"); fs.createReadStream = fail("outsideReads");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[name] = fail("subprocesses");
  for (const module of [http, https]) for (const name of ["request", "get"]) module[name] = fail("network");
  net.connect = net.createConnection = fail("network"); globalThis.fetch = fail("network");
  syncBuiltinESMExports();

  const core = await import(pathToFileURL(join(share, "packages/pa-core/dist/index.js")).href);
  const { createPiExecutionModule } = await import(pathToFileURL(join(share, "packages/pi-pa/dist/pi-extension/prepared-workflow.js")).href);
  const { PiNativeExecutionAdapter } = await import(pathToFileURL(join(share, "packages/pi-pa/dist/execution-native.js")).href);
  const { PiPreparedNativeAuthority } = await import(pathToFileURL(join(share, "packages/pi-pa/dist/prepared-native.js")).href);
  const codes = ["EXECUTION_NOT_ADOPTED", "EXECUTION_BINDING_UNCERTAIN", "EXECUTION_CAPABILITY_UNSUPPORTED", "EXECUTION_CONTRACT_INVALID", "EXECUTION_STORAGE_REJECTED", "EXECUTION_CALLER_STALE", "EXECUTION_BINDING_CONFLICT", "EXECUTION_HOLDER_CONFLICT", "EXECUTION_UNKNOWN"];
  const stages = ["binding-resolution", "binding-resolution", "capability", "contract", "persistence", "caller", "binding-validation", "custody", "fallback"];
  const check = (error, code) => {
    assert.ok(error instanceof Error); assert.equal(error.message, core.executionFailure(code).message);
    assert.match(error.message, new RegExp(`${code}/${stages[codes.indexOf(code)]}`));
    assert.ok(error.message.length <= 2000);
    for (const field of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(error.message.split(field).length, 2);
    assert.doesNotMatch(error.message, /PRIVATE|\/private\/|bootId|startTimeTicks|stack:/); return true;
  };
  const runtime = (options) => {
    const tools = new Map(); const handlers = new Map();
    createPiExecutionModule({ env: { PA_TEAM: "builder", PA_MODE: "orchestrator" }, ...options })({
      registerTool(tool) { tools.set(tool.name, tool); },
      on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    });
    return { tools, handlers, call: (input) => tools.get("pa_execution").execute("smoke", input, undefined, undefined, { cwd: root }) };
  };
  const actions = [{ action: "status" }, { action: "observe", kind: "holder" }];
  for (const code of codes) {
    const authentic = core.executionFailure(code); check(authentic, code);
    check(core.executionWorkflowError(authentic), code);
    for (const spoof of [{ code, message: "PRIVATE /private/token" }, new Error("PRIVATE stack:"), new Proxy(authentic, {}), { ...authentic }]) check(core.executionWorkflowError(spoof), "EXECUTION_UNKNOWN");
    const r = runtime({ resolveBinding() { throw authentic; } });
    for (const input of actions) for (let repeat = 0; repeat < 2; repeat++) await assert.rejects(r.call(input), (error) => check(error, code));
  }
  let getters = 0;
  const hostile = () => { getters++; throw core.executionFailure("EXECUTION_HOLDER_CONFLICT"); };
  const forged = Object.defineProperties({}, { code: { get: hostile }, message: { get: hostile }, stack: { get: hostile } });
  check(core.executionWorkflowError(forged), "EXECUTION_UNKNOWN"); assert.equal(getters, 0);
  const legacy = runtime({ resolveBinding: () => null });
  for (const input of actions) await assert.rejects(legacy.call(input), (error) => check(error, "EXECUTION_NOT_ADOPTED"));
  for (const handler of legacy.handlers.get("tool_call") ?? []) assert.equal(handler({ toolName: "write", input: { path: "fixture.ts" } }, {}), undefined);
  assert.deepEqual([...legacy.tools.keys()], ["pa_execution", "pa_feature_update"]);

  const actor = { deploymentId: "d-263aaa", process: { pid: 123, startTimeTicks: "1", bootId: "fixture" } };
  const time = "2026-10-17T00:00:00.000Z";
  const binding = core.parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: "b".repeat(64), lineageId: actor.deploymentId, repoKey: "fixture", repoRoot: "/fixture/canonical", worktreeRoot: "/fixture/ticket", ticket: "PAP-263", branch: "feature/PAP-263-fixture", initialHeadSha: "a".repeat(40), owner: actor,
    bounds: { startedAt: time, deadlineAt: "2026-10-17T02:00:00.000Z", runtimeMinutes: 120, consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null } });
  const serviceRoot = join(root, "service"); const store = new core.ProtectedWorkflowStore(serviceRoot);
  const service = new core.ExecutionCustodyService(store, binding, { locks: { repository: (run) => run(), worktree: (run) => run() }, authorize() {}, assertLive() {}, verifyEvidence() {}, assertHandover() {}, now: () => time });
  service.initialize(actor);
  let active = true; let publications = 0;
  const native = { bindingIdentity: core.workflowDigest("fixture-binding"), service, actor };
  const r = runtime({ resolveBinding: () => active ? native : null });
  const snapshot = () => fs.readdirSync(serviceRoot).sort().map((name) => [name, fs.readFileSync(join(serviceRoot, name)).toString("base64")]);
  const before = snapshot();
  assert.deepEqual((await r.call(actions[0])).details, core.projectExecution(service.status(actor)));
  await assert.rejects(r.call(actions[1]), (error) => check(error, "EXECUTION_CAPABILITY_UNSUPPORTED"));
  for (const input of [Object.defineProperty({}, "action", { get: hostile }), new Proxy({}, { ownKeys: hostile })]) await assert.rejects(r.call(input), (error) => check(error, "EXECUTION_UNKNOWN"));
  assert.equal(getters, 1); // Proxy reflection attempted; no accessor ran.
  const holderSource = { ref: "fixture:holder", version: "v1", sha256: "a".repeat(64) };
  native.observe = () => { publications++; return holderSource; };
  assert.deepEqual((await r.call(actions[1])).details, { evidence: holderSource });
  assert.equal(publications, 1); // only the existing authenticated observation port
  active = false;
  for (const input of actions) await assert.rejects(r.call(input), (error) => check(error, "EXECUTION_BINDING_UNCERTAIN"));
  assert.deepEqual(snapshot(), before);

  // Native marker/locator reader cases: no grants, launch, qualification or
  // production store. Each registry/marker belongs only to this temp fixture.
  const consumed = Object.fromEntries(["schemaVersion", "deploymentId", "repoKey", "repoRoot", "ticket", "operationId", "receiptId", "grantId", "consumer", "worktreeRoot", "branch", "baseSha", "headSha", "ticketSlotId", "repositoryPermit"].map((key) => [key, "fixture"]));
  const serialized = JSON.stringify(consumed);
  const nativeCases = [
    ["never-adopted", {}, "EXECUTION_NOT_ADOPTED"],
    ["lost-marker", { declared: "a".repeat(64) }, "EXECUTION_BINDING_UNCERTAIN"],
    ["lost-locator", { marker: serialized }, "EXECUTION_BINDING_UNCERTAIN"],
    ["malformed-locator", { declared: "PRIVATE" }, "EXECUTION_BINDING_UNCERTAIN"],
    ["insecure-storage", { marker: serialized, insecure: true }, "EXECUTION_STORAGE_REJECTED"],
    ["malformed-storage", { marker: "PRIVATE malformed record" }, "EXECUTION_STORAGE_REJECTED"],
    ["contract-fields", { marker: "{}" }, "EXECUTION_CONTRACT_INVALID"],
    ["unsupported-executor", { marker: serialized, declared: core.workflowDigest(serialized), mode: "implement" }, "EXECUTION_CAPABILITY_UNSUPPORTED"],
  ];
  for (const [name, options, code] of nativeCases) {
    const state = join(root, name); const directory = join(state, "deployments/d-263aaa"); fs.mkdirSync(directory, { recursive: true });
    Object.assign(process.env, { PA_AI_USAGE_HOME: state, PA_REGISTRY_DB: join(state, "registry.db"), PA_DEPLOYMENT_ID: "d-263aaa", PA_DEPLOYMENT_DIR: directory, PA_TEAM: "builder", PA_MODE: options.mode ?? "orchestrator" });
    core.appendRegistryEvent({ deployment_id: "d-263aaa", team: "builder", mode: process.env.PA_MODE, runtime: "pi", binary: "ppa", event: "started", timestamp: time, ...(options.declared === undefined ? {} : { note: `prepared-native-consumption/v1:${options.declared}` }) });
    core.closeDb();
    if (options.marker !== undefined) { const path = join(directory, "prepared-consumption.json"); fs.writeFileSync(path, options.marker, { mode: 0o600 }); if (options.insecure) fs.chmodSync(path, 0o644); }
    const authorityRoot = join(state, "authority");
    const adapter = new PiNativeExecutionAdapter({ authority: new PiPreparedNativeAuthority({ root: authorityRoot, aiUsageRoot: state }) });
    const control = runtime({ nativeAdapter: adapter });
    for (const input of actions) await assert.rejects(control.call(input), (error) => check(error, code));
    if (name === "never-adopted") {
      for (const handler of control.handlers.get("session_start") ?? []) await handler({}, { cwd: root });
      assert.deepEqual([...control.tools.keys()], ["pa_execution", "pa_feature_update"]);
    }
    assert.equal(fs.existsSync(authorityRoot), false);
  }
  core.closeDb();
  for (const key of ["outsideReads", "outsideWrites", "subprocesses", "network"]) assert.equal(counts[key], 0);
  const ledger = { schemaVersion: "pap-263-installed-driver/v1", formatterCategories: codes.length, trustedBoundaryCategories: codes.length, nativeBindingCases: nativeCases.length,
    privacy: "passed", validProjection: "passed", retainedNoFallback: "passed", guards: counts, historicalCause: "unproven", liveQualification: false };
  process.stdout.write(JSON.stringify(ledger));
}

let stage = "prerequisites";
let temporary;
try {
  assert.equal(process.argv.length, 2, "zero arguments required");
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  assert.equal(realpathSync(process.cwd()), root);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC" };
  const run = (command, args, cwd = root, timeout = 30_000, environment = env) => {
    const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
    return result.stdout;
  };
  const git = (args) => run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args]);
  const clean = () => assert.equal(git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"]), "");
  clean(); const featureSha = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim(); assert.match(featureSha, /^[0-9a-f]{40}$/);
  if (process.env.PA_FEATURE_SHA !== undefined) assert.equal(process.env.PA_FEATURE_SHA, featureSha); // equality only, never a source/root override
  const configSha = readFileSync(join(root, ".pa-platform-config.sha"), "utf8").trim(); assert.match(configSha, /^[0-9a-f]{40}$/);
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version; assert.match(version, /^\d+\.\d+\.\d+$/);
  stage = "nix-build";
  const build = JSON.parse(run("nix", ["build", "--no-link", "--json", "--no-update-lock-file", ".#pa-platform"], root, 1_200_000));
  assert.equal(build.length, 1); const store = build[0].outputs.out; assert.match(store, /^\/nix\/store\/[a-z0-9]{32}-pa-platform-[^/]+$/); assert.equal(realpathSync(store), store);
  stage = "provenance";
  const share = join(store, "share/pa-platform");
  const provenance = JSON.parse(readFileSync(join(share, "review-runtime-provenance.json"), "utf8"));
  assert.equal(provenance.schemaVersion, "pa-review-runtime/v1"); assert.equal(provenance.sourceSha, featureSha); assert.equal(provenance.configSha, configSha);
  assert.equal(provenance.packageName, "pa-platform"); assert.equal(provenance.packageVersion, version);
  const modulePaths = ["packages/pa-core/dist/deploy/prepared-workflow.js", "packages/pi-pa/dist/execution-native.js", "packages/pi-pa/dist/pi-extension/prepared-workflow.js"];
  const modules = modulePaths.map((relativePath) => {
    const path = join(share, relativePath); assert.equal(realpathSync(path), path);
    return { path: relativePath, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  });
  assert.equal(JSON.parse(readFileSync(join(share, "package.json"), "utf8")).version, version);
  assert.equal(JSON.parse(readFileSync(join(share, "packages/pa-core/package.json"), "utf8")).version, version);
  assert.equal(JSON.parse(readFileSync(join(share, "packages/pi-pa/package.json"), "utf8")).version, version);
  assert.equal(git(["rev-parse", "HEAD"]).trim(), featureSha); clean();
  stage = "isolated-driver";
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "pap263-installed-")));
  const driver = join(temporary, "driver.mjs");
  writeFileSync(driver, `try { await (${installedDriver.toString()})(${JSON.stringify(temporary)}, ${JSON.stringify(share)}); } catch { process.stderr.write('isolated driver failed'); process.exitCode = 1; }`, { mode: 0o600 });
  const result = JSON.parse(run(join(store, "bin/pa-platform-node"), [driver], temporary, 120_000, {
    PATH: join(store, "bin"), HOME: temporary, LANG: "C.UTF-8", TZ: "UTC", PA_PLATFORM_HOME: temporary,
    PA_PLATFORM_CONFIG: join(temporary, "config"), PA_AI_USAGE_HOME: join(temporary, "state"), PA_REGISTRY_DB: join(temporary, "state/registry.db"),
    XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"), XDG_STATE_HOME: join(temporary, "state"),
  }));
  assert.equal(result.schemaVersion, "pap-263-installed-driver/v1"); assert.equal(result.formatterCategories, 9); assert.equal(result.trustedBoundaryCategories, 9); assert.equal(result.nativeBindingCases, 8);
  for (const key of ["outsideReads", "outsideWrites", "subprocesses", "network"]) assert.equal(result.guards[key], 0);
  stage = "candidate-reread"; assert.equal(git(["rev-parse", "HEAD"]).trim(), featureSha); clean();
  const ledger = { schemaVersion: "pap-263-installed-smoke/v1", status: "passed", capturedAt: new Date().toISOString(), featureSha, configSha, packageVersion: version, store, modules, result,
    evidenceKind: "compiled-installed-isolated-software", historicalLoadedModule: "unproven", historicalFailingBranch: "unproven", productionActivation: false, resourceAcquisition: false, childDeployment: false, readinessApproval: false };
  const text = JSON.stringify(ledger); assert.ok(text.length <= 16_384); process.stdout.write(`${text}\n`);
} catch {
  // Never echo OS/Nix/assertion/driver text, stack, argv, protected path or record.
  const diagnostic = `Condition: installed execution diagnostic smoke stopped. Source: PAP-263 installed-smoke/${stage}. Reason: required isolated software evidence was not established. Correction: independent reviewer/runtime owner must reconcile the supported prerequisite or fixture failure; preserve original evidence privately. Resume Action: rerun the exact matrix command only with the same authorized clean candidate and supported prerequisites; no activation or repair.`;
  process.stdout.write(`${JSON.stringify({ schemaVersion: "pap-263-installed-smoke/v1", status: "failed", diagnostic, historicalCause: "unproven" })}\n`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
