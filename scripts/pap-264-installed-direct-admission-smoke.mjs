#!/usr/bin/env node
// Candidate-built isolated software evidence, not installation/readiness or UAT.
// No CLI root, runtime, command, receipt or environment authority overrides.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Serialized into a separate process after package authentication. The exported
// function is also exercised by source tests; the CLI never accepts its inputs.
// Production authority is neither read nor manufactured. Only existing dependency
// ports (Treehouse JSON and the provider-free runtime adapter) are substituted.
export async function isolatedDriver(root, share) {
  const assert = (await import("node:assert/strict")).default;
  const fs = (await import("node:fs")).default;
  const cp = (await import("node:child_process")).default;
  const { join, resolve, relative, isAbsolute, dirname, basename } = await import("node:path");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const { createHash } = await import("node:crypto");
  const { syncBuiltinESMExports } = await import("node:module");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const counts = { fixtureWrites: 0, gitProcesses: 0, mutexProcesses: 0, nativeBashProcesses: 0,
    outsideWrites: 0, forbiddenProcesses: 0, network: 0, treehouseLifecycle: 0, runtimePreflights: 0, runtimeSpawns: 0, implementSpawns: 0 };
  const inside = (base, path) => { const rel = relative(base, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")); };
  const originalRealpath = fs.realpathSync;
  const physical = (input) => {
    if (typeof input === "number") return originalRealpath(`/proc/self/fd/${input}`);
    let path = resolve(input instanceof URL ? fileURLToPath(input) : String(input));
    const suffix = [];
    while (true) {
      try { return join(originalRealpath(path), ...suffix); }
      catch (error) { if (error.code !== "ENOENT") throw error; suffix.unshift(basename(path)); path = dirname(path); }
    }
  };
  const writing = (path) => {
    if (!inside(root, physical(path))) { counts.outsideWrites++; throw new Error("outside fixture write"); }
    counts.fixtureWrites++;
  };
  // Tripwires cover Node writes, including /proc/self/fd anchored journal IO.
  // They are not an OS sandbox. Native SQLite is fixed to the disposable DB;
  // allowed subprocesses below operate only on the disposable Git repository.
  process.env.TMPDIR = root; process.env.TMP = root; process.env.TEMP = root;
  const open = fs.openSync;
  fs.openSync = (path, flags, ...rest) => {
    if (typeof flags === "string" ? /[wa+]/.test(flags) : flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) writing(path);
    return open(path, flags, ...rest);
  };
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "unlinkSync", "rmSync", "rmdirSync", "chmodSync", "truncateSync", "writeSync", "ftruncateSync", "fsyncSync"]) {
    const original = fs[name]; fs[name] = (path, ...args) => { writing(path); return original(path, ...args); };
  }
  for (const name of ["renameSync", "linkSync", "symlinkSync", "copyFileSync"]) {
    const original = fs[name]; fs[name] = (from, to, ...args) => { writing(from); writing(to); return original(from, to, ...args); };
  }
  for (const owner of [fs, fs.promises]) for (const name of ["open", "writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "chmod", "truncate", "link", "symlink", "copyFile"]) {
    owner[name] = () => { counts.outsideWrites++; throw new Error("unobserved async write"); };
  }
  fs.createWriteStream = () => { counts.outsideWrites++; throw new Error("unobserved stream write"); };
  const nativeCommands = new Set(["git diff --check", "git add -- fixture.txt", "git commit -m 'packaged SDK fixture'"]);
  for (const name of ["execFileSync", "spawnSync", "spawn"]) {
    const original = cp[name]; cp[name] = (command, args, options = {}) => {
      const cwd = options.cwd ?? process.cwd();
      const executable = basename(command);
      const allowedGit = executable === "git" && ["execFileSync", "spawnSync"].includes(name) && inside(root, physical(cwd))
        && !args.some((arg) => /^(?:--git-dir|--work-tree|--exec-path|--config-env)=/.test(arg))
        && !args.some((arg) => ["fetch", "push", "clone", "submodule", "remote"].includes(arg));
      const allowedMutex = executable === "flock" && name === "spawn" && args[0] === "--exclusive" && inside(root, physical(args[3]))
        && args[4] === "/bin/sh" && args[5] === "-c" && inside(root, physical(args[8])) && inside(root, physical(args[9]));
      // Native runner has shell executable and command following the fixed frame.
      const framedBash = executable === "bash" && name === "spawn" && inside(root, physical(cwd)) && args.length === 7
        && args[0] === "--noprofile" && args[1] === "--norc" && args[2] === "-c"
        && args[3] === 'IFS= read -r pa_native_start <&3 || exit 125; exec 3<&-; exec "$1" --noprofile --norc -c "$2"'
        && args[4] === "pa-native-execution" && args[5] === command && nativeCommands.has(args[6]);
      if (!allowedGit && !allowedMutex && !framedBash) { counts.forbiddenProcesses++; throw new Error("unapproved fixture process"); }
      counts[allowedGit ? "gitProcesses" : allowedMutex ? "mutexProcesses" : "nativeBashProcesses"]++;
      try { return original(command, args, options); }
      catch (error) { fs.writeFileSync(join(root, "process-error.txt"), String(error.stack), { mode: 0o600 }); throw error; }
    };
  }
  for (const name of ["exec", "execSync", "execFile", "fork"]) cp[name] = () => { counts.forbiddenProcesses++; throw new Error("unapproved process"); };
  for (const [module, names] of [["node:http", ["request", "get"]], ["node:https", ["request", "get"]], ["node:net", ["connect", "createConnection"]], ["node:tls", ["connect"]], ["node:dgram", ["createSocket"]]]) {
    const owner = (await import(module)).default;
    for (const name of names) owner[name] = () => { counts.network++; throw new Error("network forbidden"); };
  }
  globalThis.fetch = () => { counts.network++; throw new Error("network forbidden"); };
  syncBuiltinESMExports();
  const stdout = process.stdout.write;
  const launchOutput = [];
  process.stdout.write = (chunk, encoding, callback) => {
    launchOutput.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8"));
    if (typeof encoding === "function") encoding(); else callback?.();
    return true;
  };
  const load = (path) => import(pathToFileURL(join(share, path)).href);
  const core = await load("packages/pa-core/dist/index.js");
  const { deployWithPi, createPiHooks } = await load("packages/pi-pa/dist/deploy.js");
  const { deployWithOpencode } = await load("packages/opencode-pa/dist/deploy.js");
  const { TreehouseClient } = await load("packages/pi-pa/dist/treehouse.js");
  const { PiPreparedNativeAuthority } = await load("packages/pi-pa/dist/prepared-native.js");
  const { PiNativeExecutionAdapter, ORDINARY_NATIVE_EXECUTION_START } = await load("packages/pi-pa/dist/execution-native.js");
  const { createPiExecutionModule } = await load("packages/pi-pa/dist/pi-extension/prepared-workflow.js");
  const { recordPiProcessIdentity } = await load("packages/pi-pa/dist/process-identity.js");
  const repo = join(root, "repo"); const checkout = join(root, "checkout"); const ai = join(root, "state");
  const config = join(root, "config"); const teams = join(root, "teams"); const authorityRoot = join(root, "authority");
  const branch = "feature/PAP-264-isolated"; const ticket = "PAP-264";
  const save = (path, bytes) => { fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); fs.writeFileSync(path, bytes, { mode: 0o600 }); };
  const git = (args, cwd = repo) => cp.execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  fs.mkdirSync(repo); git(["init", "-b", "develop"]);
  for (const [key, value] of [["user.email", "fixture@example.invalid"], ["user.name", "Fixture"], ["commit.gpgsign", "false"], ["core.hooksPath", join(root, "empty-hooks")]]) git(["config", key, value]);
  fs.mkdirSync(join(root, "empty-hooks")); save(join(repo, "fixture.txt"), "value = 0;\n");
  git(["add", "fixture.txt"]); git(["commit", "-m", "isolated base"]); const base = git(["rev-parse", "HEAD"]);
  git(["worktree", "add", "-b", branch, checkout, base]);
  save(join(config, "config.yaml"), `config_dir: ${root}\nrepos:\n  fixture-repo:\n    path: ${repo}\n    prefix: PAP\n`);
  const teamPath = join(teams, "builder.yaml");
  const team = (defaultMode = "orchestrator") => save(teamPath, `name: builder\ndescription: Isolated\nobjective: Fixture\nagents: []\ndefault_mode: ${defaultMode}\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n`);
  team();
  save(join(ai, "tickets", `${ticket}.json`), JSON.stringify({ id: ticket, project: "fixture-repo", title: "Isolated smoke", status: "implementing",
    linkedBranches: [{ repo: "fixture-repo", branch, state: "materialized", baseSha: base, headSha: base, sha: base }] }));
  Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_PLATFORM_HOME: root, PA_PLATFORM_TEAMS: teams, PA_AI_USAGE_HOME: ai, PA_REGISTRY_DB: join(ai, "registry.db"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  process.chdir(repo);
  const authority = new PiPreparedNativeAuthority({ root: authorityRoot, aiUsageRoot: ai }); // optional policy stays absent
  const leasedAt = new Date().toISOString();
  const treehouse = new TreehouseClient({ run(args, cwd) {
    assert.equal(cwd, repo);
    if (args[0] === "--version") return { status: 0, stdout: Buffer.from("v3.1.3\n"), stderr: Buffer.alloc(0) };
    if (JSON.stringify(args) === JSON.stringify(["status", "--json"])) return { status: 0, stdout: Buffer.from(JSON.stringify([{ name: "1", path: checkout, status: "leased", branch,
      detached: false, flavor: "git", lease_id: "isolated-existing-lease", lease_holder: "pa:fixture-repo:PAP-264", leased_at: leasedAt, processes: [] }])), stderr: Buffer.alloc(0) };
    counts.treehouseLifecycle++; throw new Error("fixture must reuse existing lease");
  } });
  const scenarios = [];
  const diagnostic = (reason) => {
    assert.equal(typeof reason, "string"); assert.ok(reason.length <= 2000);
    for (const field of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.ok(reason.includes(field));
    assert.doesNotMatch(reason, /PRIVATE_SENTINEL|bootId|startTimeTicks/);
  };
  const snapshot = (directory) => {
    const rows = [];
    const walk = (path) => { for (const entry of fs.readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name); if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && child !== `${process.env.PA_REGISTRY_DB}-shm`) rows.push([relative(directory, child), hash(fs.readFileSync(child))]);
    } }; walk(directory); return rows;
  };
  const inert = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "isolated-session",
    async preflight() { counts.runtimePreflights++; }, installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "fixture tools" }), extractActivity: () => [],
    async spawn() { counts.runtimeSpawns++; throw new Error("unexpected runtime"); }, async resume() { counts.forbiddenProcesses++; throw new Error("unexpected resume"); } };
  const request = { team: "builder", ticket, repo: "fixture-repo", provider: "openai-codex", model: "gpt-6.1-sol", timeout: 1800 };
  core.appendRegistryEvent({ deployment_id: "d-264aaa", team: "builder", mode: "implement", runtime: "pi", event: "started", timestamp: new Date().toISOString() });
  const volatileReadMarks = [];
  const readMark = () => { const path = `${process.env.PA_REGISTRY_DB}-shm`; return fs.existsSync(path) ? hash(fs.readFileSync(path)) : null; };
  const hooks = { deployPreflight() { counts.runtimePreflights++; throw new Error("forbidden mode preflight"); }, deploy() { counts.runtimeSpawns++; throw new Error("forbidden mode hook"); } };
  const api = core.createAgentApiApp({ hooks: { runtimeHooks: { pi: hooks, opencode: hooks } } });
  // Invalid selection must precede even preflight and all Git/Treehouse effects.
  try { for (const [name, selection] of [["retired", { mode: "implement" }], ["forced-retired", { mode: "implement", force: true }], ["retired-resume", { mode: "implement", resume: "d-264aaa" }],
    ["historical-resume", { mode: "orchestrator", resume: "d-264aaa" }], ["inherited-retired-child", { mode: "implement", background: true }],
    ["unknown", { mode: "PRIVATE_SENTINEL" }], ["unknown-default", {}]]) {
    team(name === "unknown-default" ? "PRIVATE_SENTINEL" : "orchestrator");
    const previousEnv = process.env;
    if (name === "inherited-retired-child") process.env = { ...previousEnv, PA_TEAM: "builder", PA_MODE: "orchestrator", PA_DEPLOYMENT_ID: "d-264bbb", PA_DEPLOYMENT_DIR: join(ai, "deployments/d-264bbb"), PA_REPO: checkout, PA_TICKET_ID: ticket };
    const before = snapshot(root); const effects = { ...counts }; const beforeReadMark = readMark();
    try { for (const deploy of [deployWithPi, deployWithOpencode]) {
      const result = await deploy({ ...request, ...selection }, { ...inert, name: deploy === deployWithPi ? "pi" : "opencode" }, undefined, { treehouse, preparedAuthority: authority });
      assert.equal(result.status, "failed"); assert.equal(result.deploymentId, undefined); diagnostic(result.reason);
    }
    if (name !== "historical-resume") {
      const preflight = await createPiHooks(inert, { treehouse }).deployPreflight({ ...request, ...selection }); diagnostic(preflight.reason);
    }
    for (const binaryName of ["ppa", "opa"]) {
      const stderr = []; const flags = [...(selection.mode ? ["--mode", selection.mode] : []), ...(selection.force ? ["--force"] : []), ...(selection.resume ? ["--resume", selection.resume] : []), ...(selection.background ? ["--background"] : [])];
      const io = { stdout() {}, stderr: (text) => stderr.push(text) };
      assert.equal(await core.runCoreCommand(["deploy", "builder", ...flags, "--repo", "fixture-repo"], { binaryName, io, hooks }), 1);
      diagnostic(stderr.join("\n"));
      const response = await api.app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder", runtime: binaryName === "ppa" ? "pi" : "opencode", ...selection, repo: "fixture-repo" }) });
      assert.equal(response.status, 202); const body = await response.json(); assert.equal(body.status, "failed"); diagnostic(body.reason);
    }
    assert.deepEqual(snapshot(root), before); assert.deepEqual(counts, effects);
    volatileReadMarks.push({ scenario: name, changed: readMark() !== beforeReadMark }); scenarios.push(name);
    } finally { process.env = previousEnv; }
  } } finally { api.cleanup(); }
  team();
  // Disposable historical holder produced by the existing owner, not a new
  // production receipt. Live ownership and malformed legacy evidence both block.
  const legacyDirectory = join(ai, "deployments/d-264aaa"); fs.mkdirSync(legacyDirectory, { recursive: true });
  const legacyOptions = { canonicalRepoKey: "fixture-repo", canonicalRepoRoot: repo, worktreeRoot: checkout, deploymentId: "d-264aaa",
    deploymentDirectory: legacyDirectory, runtime: "pi", team: "builder", mode: "implement", launchMode: "foreground", ticket };
  let legacy = core.acquireRepositoryMutationLease(legacyOptions);
  assert.equal(legacy.status, "acquired");
  const legacyPath = core.repositoryMutationLeasePath(checkout, "implement");
  const history = core.getDeploymentEvents("d-264aaa");
  for (const malformed of [false, true]) {
    if (malformed) { legacy = core.acquireRepositoryMutationLease(legacyOptions); assert.equal(legacy.status, "acquired"); }
    const restoreBytes = fs.readFileSync(legacyPath);
    if (malformed) fs.writeFileSync(legacyPath, "{PRIVATE_SENTINEL", { mode: 0o600 });
    const before = fs.readFileSync(legacyPath); const preflight = counts.runtimePreflights;
    const result = await deployWithPi({ ...request, mode: "orchestrator" }, inert, undefined, { treehouse, preparedAuthority: authority });
    assert.equal(result.status, "failed"); diagnostic(result.reason); assert.equal(counts.runtimeSpawns, 0); assert.equal(counts.runtimePreflights, preflight);
    assert.deepEqual(fs.readFileSync(legacyPath), before); assert.deepEqual(core.getDeploymentEvents("d-264aaa"), history);
    scenarios.push(malformed ? "malformed-legacy" : "live-legacy");
    // Fixture teardown through matching owners. This is not a historical
    // terminal-settlement claim: the synthetic custodian is this live process.
    if (malformed) fs.writeFileSync(legacyPath, restoreBytes);
    assert.equal(core.releaseRepositoryMutationLease({ canonicalRepoRoot: repo, worktreeRoot: checkout, slot: "implement", ownershipToken: legacy.lease.ownershipToken }).status, "released");
    const slot = core.observeReadonlyRepositoryTicketSlot(repo, ticket).slot;
    assert.equal(core.releaseRepositoryTicketSlot(slot).status, "released");
  }
  let bodyError; let nativeResult;
  const adapter = { ...inert, async spawn(opts) {
    counts.runtimeSpawns++; if (opts.env.PA_MODE === "implement") counts.implementSpawns++;
    const priorEnv = process.env; process.env = { ...priorEnv, ...opts.env }; process.chdir(checkout);
    try {
      const directory = core.getDeployPaths(opts.deployId).deployDir; const context = { cwd: checkout };
      const fresh = () => new PiNativeExecutionAdapter({ authority, helperDependencies: { treehouse } });
      assert.throws(() => fresh().resolve(context)); assert.equal(authority.execution(), null); scenarios.push("missing-process-proof");
      assert.equal(recordPiProcessIdentity(opts.deployId, directory, process.pid), true); opts.onPid?.(process.pid);
      // Missing native support under selected direct-only policy cannot fall back.
      const db = core.getDb();
      db.prepare("UPDATE registry_events SET note = NULL WHERE deployment_id = ? AND event = 'started'").run(opts.deployId);
      assert.throws(() => fresh().resolve(context), /EXECUTION_CAPABILITY_UNSUPPORTED/); assert.equal(authority.execution(), null);
      db.prepare("UPDATE registry_events SET note = ? WHERE deployment_id = ? AND event = 'started'").run(ORDINARY_NATIVE_EXECUTION_START, opts.deployId);
      scenarios.push("missing-direct");
      let native; let runtime; let session;
      const reload = async () => {
        const before = session?.service.status(session.actor);
        native = fresh(); const tools = new Map(); const handlers = new Map();
        runtime = { tools, async dispatch(name, event) { for (const fn of handlers.get(name) ?? []) { const result = await fn(event, context); if (result !== undefined) return result; } } };
        createPiExecutionModule({ nativeAdapter: native })({ registerTool: (tool) => tools.set(tool.name, tool), on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } });
        await runtime.dispatch("session_start", {}); session = native.resolve(context);
        if (before) assert.deepEqual(session.service.status(session.actor), before);
      };
      await reload();
      const control = (input) => runtime.tools.get("pa_execution").execute("control", input, undefined, undefined, context);
      const observe = async (kind) => (await control({ action: "observe", kind })).details.evidence;
      const select = async () => { const holder = await observe("holder"); await control({ action: "select", executor: "orchestrator-direct", holder, handover: holder }); };
      const settle = async () => control({ action: "settle", evidence: await observe("inventory") });
      let sequence = 0;
      const execute = async (name, input, expectedFailure = false) => {
        const id = `isolated-${++sequence}`; assert.equal(await runtime.dispatch("tool_call", { toolName: name, toolCallId: id, input }), undefined);
        let result; let failed = false;
        try { result = await runtime.tools.get(name).execute(id, input, undefined, undefined, context); } catch { failed = true; }
        // A forged pass cannot override actual process exit/streams.
        await runtime.dispatch("tool_execution_end", { toolName: name, toolCallId: id, result: expectedFailure ? { exitCode: 0, text: "PASS" } : result, isError: false });
        assert.equal(failed, expectedFailure); return result;
      };
      const deny = async (name, input, direct = false) => {
        const records = session.evidence.store.records(); const bytes = fs.readFileSync(join(checkout, "fixture.txt"));
        const response = await runtime.dispatch("tool_call", { toolName: name, toolCallId: "denied", input });
        assert.equal(response.block, true); diagnostic(response.reason);
        if (direct) await assert.rejects(runtime.tools.get(name).execute("denied", input, undefined, undefined, context));
        assert.deepEqual(session.evidence.store.records(), records); assert.deepEqual(fs.readFileSync(join(checkout, "fixture.txt")), bytes);
      };
      const plan = { phaseId: "phase-4", scope: "isolated packaged SDK", paths: ["fixture.txt"], requirements: ["FR8", "FR9", "AC1", "AC3", "AC5", "AC7"], prerequisites: [],
        checks: ["git diff --check"], size: "L", complexity: "high", rationale: "Real packaged SDK/process evidence; no provider, production qualification or loaded-runtime acceptance." };
      await control({ action: "plan", plan }); await select();
      await deny("bash", { command: "git commit -m 'premature'" });
      await deny("write", { path: join(repo, "fixture.txt"), content: "forbidden" });
      for (const [key, value] of [["PA_TICKET_ID", "PAP-999"], ["PA_REPO", repo], ["PA_WORKTREE_ROOT", repo]]) {
        const previous = process.env[key]; process.env[key] = value;
        try { await deny("write", { path: "fixture.txt", content: "forbidden" }, true); assert.throws(() => fresh().resolve(context)); }
        finally { process.env[key] = previous; }
      }
      scenarios.push("custody-drift");
      await execute("write", { path: "fixture.txt", content: "value = 1; \n" });
      await execute("edit", { path: "fixture.txt", edits: [{ oldText: "value = 1", newText: "value = 2" }] });
      assert.equal(fs.readFileSync(join(checkout, "fixture.txt"), "utf8"), "value = 2; \n");
      await execute("bash", { command: "git diff --check", timeout: 30 }, true);
      const original = session.service.status(session.actor).originalFailure;
      assert.equal(original.exitCode, 2); assert.equal(original.command, "git diff --check");
      const failed = session.evidence.read(original.output, "tool-result"); assert.equal(failed.process.groupSettled, true);
      assert.ok(session.evidence.blob(failed.process.stdout).length > 0);
      await reload(); assert.deepEqual(session.service.status(session.actor).originalFailure, original);
      await deny("bash", { command: "git commit -m 'premature'" });
      await settle(); await control({ action: "attempt", evidence: await observe("recovery") }); await control({ action: "plan", plan });
      await reload(); assert.equal(session.service.status(session.actor).bounds.consecutiveNoProgress, 1);
      await select(); await execute("edit", { path: "fixture.txt", edits: [{ oldText: "value = 2; ", newText: "value = 2;" }] });
      await execute("bash", { command: "git diff --check", timeout: 30 }); await settle();
      const passed = session.reportFacts().checks.findLast((row) => row.command === "git diff --check" && row.exitCode === 0);
      await control({ action: "resolve", evidence: passed.output }); await select();
      await execute("bash", { command: "git add -- fixture.txt" }); await execute("bash", { command: "git commit -m 'packaged SDK fixture'" });
      const committed = session.service.status(session.actor); assert.notEqual(committed.candidateSha, base);
      await reload(); assert.deepEqual(session.service.status(session.actor).acceptance, {});
      await deny("bash", { command: "git commit -m 'packaged SDK fixture'" }); await settle();
      scenarios.push("ordinary-sdk-write-edit-check-commit", "first-failure-recheck", "reload-preserves-limits", "matching-direct-settlement");
      // Lose correlation after adoption, then roll back config: reload still
      // denies instead of restoring built-ins. Faults stay inside this fixture.
      db.prepare("UPDATE registry_events SET note = NULL WHERE deployment_id = ? AND event = 'started'").run(opts.deployId);
      fs.appendFileSync(teamPath, "  - id: implement\n    label: Legacy\n");
      assert.throws(() => fresh().resolve(context), /EXECUTION_BINDING_UNCERTAIN/);
      db.prepare("UPDATE registry_events SET note = ? WHERE deployment_id = ? AND event = 'started'").run(ORDINARY_NATIVE_EXECUTION_START, opts.deployId); team();
      scenarios.push("correlation-loss-no-fallback");
      const checkLedger = session.reportFacts().checks.map((row) => {
        const result = session.evidence.read(row.output, "tool-result");
        return { command: row.command, exitCode: row.exitCode, stdout: result.process.stdout, stderr: result.process.stderr, groupSettled: result.process.groupSettled };
      });
      assert.deepEqual(checkLedger.map((row) => row.exitCode), [2, 0]);
      assert.equal(fs.existsSync(join(directory, "prepared-consumption.json")), false);
      assert.equal(fs.existsSync(join(authorityRoot, "native")), false);
      nativeResult = { checkLedger, base, candidate: committed.candidateSha, custody: session.service.status(session.actor).custody.state,
        bounds: { consecutiveNoProgress: committed.bounds.consecutiveNoProgress, replacementsUsed: committed.bounds.replacementsUsed, reviewsUsed: committed.bounds.reviewsUsed } };
    } catch (error) { bodyError = error; throw error; }
    finally { process.chdir(repo); process.env = priorEnv; }
    return { sessionId: opts.sessionId, exitCode: 0, metadata: { sessionId: opts.sessionId } };
  } };
  try {
    const launched = await deployWithPi({ ...request, mode: "orchestrator" }, adapter, undefined, { treehouse, preparedAuthority: authority });
    if (bodyError) throw bodyError;
    assert.equal(launched.status, "success", launched.reason); assert.equal(counts.runtimeSpawns, 1); assert.equal(counts.implementSpawns, 0);
    assert.equal(git(["rev-parse", "HEAD"]), base); assert.equal(git(["branch", "--show-current"]), "develop");
    assert.equal(git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], checkout), "");
    assert.equal(core.inspectRepositoryMutationLease(repo, { worktreeRoot: checkout }).state, "absent");
    assert.deepEqual(core.getDeploymentEvents("d-264aaa"), history);
    for (const key of ["outsideWrites", "forbiddenProcesses", "network", "treehouseLifecycle", "implementSpawns"]) assert.equal(counts[key], 0);
    fs.writeFileSync(join(root, "launcher.stdout"), Buffer.concat(launchOutput), { mode: 0o600 });
    return { schemaVersion: "pap-264-isolated-driver/v1", status: "passed", scenarios, counts, nativeResult, volatileReadMarks,
      runtime: { nodeVersion: process.version, executable: originalRealpath(process.execPath) },
      sqliteObservation: "readonly observation may update volatile SHM reader marks; DB/WAL and custody records must stay byte-identical for mode denials",
      launchStdout: { bytes: Buffer.concat(launchOutput).length, sha256: hash(Buffer.concat(launchOutput)) },
      seams: ["disposable Git/registry/authority", "existing-only Treehouse JSON port", "in-process provider-free adapter; real launch admission and SDK factories"],
      limitations: ["tripwires are not OS confinement", "SQLite and fixed Git/shell descendants use fixture-only paths", "no live provider, installed selection, protected review readiness or human UAT"] };
  } finally { process.stdout.write = stdout; core.closeDb(); process.chdir(root); }
}

export async function main() {
  let stage = "prerequisites"; let temporary;
  try {
    assert.equal(process.argv.length, 2, "zero arguments required");
    const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
    assert.equal(realpathSync(process.cwd()), root);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC" };
    temporary = realpathSync(mkdtempSync(join(tmpdir(), "pap264-installed-")));
    let sequence = 0;
    const run = (command, args, cwd = root, timeout = 30000, environment = env) => {
      const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
      const prefix = join(temporary, `command-${++sequence}`);
      for (const channel of ["stdout", "stderr"]) writeFileSync(`${prefix}.${channel}`, result[channel] ?? "", { mode: 0o600 });
      writeFileSync(`${prefix}.json`, JSON.stringify({ command, args, cwd, exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null }), { mode: 0o600 });
      assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
      return result.stdout;
    };
    const git = (args) => run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args]);
    const clean = () => assert.equal(git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"]), "");
    clean(); const featureSha = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim(); assert.match(featureSha, /^[0-9a-f]{40}$/);
    if (process.env.PA_FEATURE_SHA !== undefined) assert.equal(process.env.PA_FEATURE_SHA, featureSha);
    const configSha = readFileSync(join(root, ".pa-platform-config.sha"), "utf8").trim(); assert.match(configSha, /^[0-9a-f]{40}$/);
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version; assert.match(version, /^\d+\.\d+\.\d+$/);
    stage = "nix-build";
    const build = JSON.parse(run("nix", ["build", "--no-link", "--json", "--no-update-lock-file", ".#pa-platform"], root, 1200000));
    assert.equal(build.length, 1); const store = build[0].outputs.out;
    assert.match(store, /^\/nix\/store\/[a-z0-9]{32}-pa-platform-[^/]+$/); assert.equal(realpathSync(store), store);
    stage = "provenance";
    const share = join(store, "share/pa-platform");
    const provenance = JSON.parse(readFileSync(join(share, "review-runtime-provenance.json"), "utf8"));
    assert.equal(provenance.schemaVersion, "pa-review-runtime/v1"); assert.equal(provenance.sourceSha, featureSha); assert.equal(provenance.configSha, configSha);
    assert.equal(provenance.packageName, "pa-platform"); assert.equal(provenance.packageVersion, version);
    const paths = ["packages/pa-core/dist/index.js", "packages/pa-core/dist/deploy/plan.js", "packages/pa-core/dist/deploy/repository-admission.js", "packages/pa-core/dist/deploy/execution-custody.js", "packages/pa-core/dist/deploy/ticket-concurrency.js",
      "packages/pi-pa/dist/deploy.js", "packages/pi-pa/dist/prepared-native.js", "packages/pi-pa/dist/process-identity.js", "packages/pi-pa/dist/execution-native.js", "packages/pi-pa/dist/native-execution-tools.js", "packages/pi-pa/dist/native-execution-evidence.js",
      "packages/pi-pa/dist/pi-extension/prepared-workflow.js", "packages/opencode-pa/dist/deploy.js"];
    const modules = paths.map((path) => { const absolute = join(share, path); assert.equal(realpathSync(absolute), absolute); return { path, sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex") }; });
    for (const path of ["package.json", "packages/pa-core/package.json", "packages/pi-pa/package.json", "packages/opencode-pa/package.json"]) assert.equal(JSON.parse(readFileSync(join(share, path), "utf8")).version, version);
    const require = createRequire(join(share, "packages/pi-pa/package.json"));
    const sdkModule = realpathSync(require.resolve("@earendil-works/pi-coding-agent"));
    assert.ok(sdkModule.startsWith("/nix/store/"));
    const sdk = { module: sdkModule, sha256: createHash("sha256").update(readFileSync(sdkModule)).digest("hex"),
      version: JSON.parse(readFileSync(join(share, "packages/pi-pa/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version };
    assert.equal(git(["rev-parse", "HEAD"]).trim(), featureSha); clean();
    stage = "isolated-driver";
    const driver = join(temporary, "driver.mjs");
    // Private original error evidence stays in the temp fixture on failure. It
    // never becomes a public diagnostic, approval, receipt or runtime grant.
    writeFileSync(driver, `try { const result = await (${isolatedDriver.toString()})(${JSON.stringify(temporary)}, ${JSON.stringify(share)}); process.stdout.write(JSON.stringify(result)); } catch (error) { (await import('node:fs')).writeFileSync(${JSON.stringify(join(temporary, "failure.txt"))}, String(error?.stack ?? error), { mode: 0o600 }); process.exitCode = 1; }`, { mode: 0o600 });
    const result = JSON.parse(run(join(store, "bin/pa-platform-node"), [driver], temporary, 300000, {
      PATH: join(store, "bin"), HOME: temporary, LANG: "C.UTF-8", TZ: "UTC", PA_PLATFORM_HOME: temporary, PA_PLATFORM_CONFIG: join(temporary, "config"),
      PA_AI_USAGE_HOME: join(temporary, "state"), PA_REGISTRY_DB: join(temporary, "state/registry.db"), XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"), XDG_STATE_HOME: join(temporary, "state"),
    }));
    assert.equal(result.schemaVersion, "pap-264-isolated-driver/v1"); assert.equal(result.status, "passed"); assert.equal(result.scenarios.length, 17);
    stage = "candidate-reread"; assert.equal(git(["rev-parse", "HEAD"]).trim(), featureSha); clean();
    const ledger = { schemaVersion: "pap-264-installed-smoke/v1", status: "passed", capturedAt: new Date().toISOString(), featureSha, configSha, packageVersion: version, store, modules, sdk, result,
      privateEvidenceRetained: true,
      evidenceKind: "candidate-built-packaged-isolated", actualRuntimeSelection: "authenticated candidate modules in packaged Node; provider-free adapter seam",
      mergedConfigPairing: "not established; configSha identifies packaged pin only", loadedOperatorRuntime: "unproven", readinessApproval: false, productionActivation: false, humanUat: "unexecuted" };
    const text = JSON.stringify(ledger); assert.ok(text.length <= 16384); process.stdout.write(`${text}\n`);
    // Retain original channels, native journal and fixture inventory privately;
    // public hashes never stand in for original bytes. No production resource is
    // held by this temp evidence, and no receipt/readiness authority is created.
  } catch {
    const diagnostic = `Condition: packaged direct admission smoke stopped. Source: PAP-264 installed-smoke/${stage}. Reason: required isolated package evidence was not established. Correction: preserve original private evidence and reconcile the supported prerequisite or fixture failure. Resume Action: rerun only on the authorized clean committed candidate; no fallback, installation, activation or protected-state repair.`;
    process.stdout.write(`${JSON.stringify({ schemaVersion: "pap-264-installed-smoke/v1", status: "failed", diagnostic, readinessApproval: false })}\n`);
    process.exitCode = 1;
    // A failure retains its private temp fixture for diagnosis, never an approval.
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await main();
