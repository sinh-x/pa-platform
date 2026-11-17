import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync, readdirSync, writeFileSync, linkSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = process.env.PA_TEST_SELECTED_PPA_ROOT;
const prefix = root && join(root, "share", "pa-platform");
const selectedModule = root && await import(pathToFileURL(join(prefix, "packages", "pi-pa", "dist", "selected-pi-launch.js")).href);
const selected = selectedModule?.resolveSelectedPiLaunch();

async function execute(file, args, env, onSpawn) {
  const child = spawn(file, args, { env, cwd: env.HOME, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", closed = false;
  child.stdout.on("data", chunk => {
    if (stdout.length + chunk.length > 8 * 1024 * 1024) {
      if (!closed && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    } else stdout += chunk;
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-65536); });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { closed = true; resolve({ code, signal, stdout, stderr }); });
  });
  const timer = setTimeout(() => { if (!closed && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 15000);
  try { await onSpawn?.(child); return await completion; }
  finally {
    clearTimeout(timer);
    if (!closed && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await completion; }
  }
}

async function executeTerminal(prefix, file, args, env, cwd, completionText) {
  const require = createRequire(pathToFileURL(join(prefix, "packages", "pi-pa", "package.json")));
  const pty = require("node-pty").spawn(file, args, { name: "xterm-256color", cols: 120, rows: 40, cwd, env });
  let stdout = "", query = "", closed = false, timedOut = false, sentExit = false, exitTimer, killTimer;
  pty.onData(chunk => {
    stdout += chunk;
    query += chunk;
    let index;
    while ((index = query.indexOf("\x1b[6n")) !== -1) { pty.write("\x1b[1;1R"); query = query.slice(index + 4); }
    query = query.slice(-3);
    if (!sentExit && stdout.includes(completionText)) {
      sentExit = true; exitTimer = setTimeout(() => { if (!closed) pty.write("\x04"); }, 300);
    }
  });
  const completion = new Promise(resolve => pty.onExit(event => { closed = true; resolve({ code: event.exitCode, stdout, timedOut }); }));
  const timer = setTimeout(() => {
    timedOut = true;
    if (!closed) { try { pty.kill("SIGTERM"); } catch {} }
    killTimer = setTimeout(() => { if (!closed) { try { pty.kill("SIGKILL"); } catch {} } }, 5000);
  }, 45000);
  try { return await completion; }
  finally { clearTimeout(timer); clearTimeout(exitTimer); clearTimeout(killTimer); }
}

// Exact built-output tests, not an install/default selection or a read grant.
test("selected PPA native host binds its stopped child before Node and preserves its PID across exec", { skip: !root }, async () => {
  assert.ok(selected);
  const directory = mkdtempSync(join(tmpdir(), "selected-pi-gate-")), agent = join(directory, "agent"); mkdirSync(agent);
  const env = selectedModule.selectedPiEnvironment(selected, { HOME: directory, TMPDIR: directory, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", NO_COLOR: "1" });
  try {
    const result = await execute(selected.entryFile, ["--pa-managed-child", "--version"], env, async child => {
      const gate = await selectedModule.awaitSelectedPiChild(selected, child.pid);
      assert.notEqual(gate.pid, child.pid, "registry/runtime PID is the child, not its native supervisor");
      assert.equal(realpathSync(`/proc/${gate.pid}/exe`), selected.entryFile);
      gate.release();
      assert.throws(() => gate.release(), "native start-gate release is one-use");
      const start = performance.now();
      let nodeObserved = false;
      while (performance.now() - start < 2000) {
        try { if (realpathSync(`/proc/${gate.pid}/exe`) === selected.nodeFile) { nodeObserved = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(nodeObserved, true, "same admitted PID executes the exact pinned Node");
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "1.4.0");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native owner termination cannot strand or execute an unreleased selected runtime child", { skip: !root }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "selected-pi-owner-exit-"));
  const env = selectedModule.selectedPiEnvironment(selected, { HOME: directory, TMPDIR: directory, PATH: process.env.PATH, PI_OFFLINE: "1", NO_COLOR: "1" });
  try {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      let runtimePid;
      const result = await execute(selected.entryFile, ["--pa-managed-child", "--version"], env, async child => {
        const gate = await selectedModule.awaitSelectedPiChild(selected, child.pid); runtimePid = gate.pid;
        child.kill(signal);
      });
      assert.equal(result.stdout, "", "unreleased child never executes Node or delivers output");
      assert.ok(result.code !== 0);
      const start = performance.now(); let stopped = false;
      while (performance.now() - start < 3000) {
        try {
          const stat = readFileSync(`/proc/${runtimePid}/stat`, "utf8");
          if (stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z ")) { stopped = true; break; }
        } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") { stopped = true; break; } throw error; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(stopped, true, "original native child is absent or dead, never left stopped awaiting admission");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("selected native entry rejects startup loaders, copied entry and direct Node without a read grant", { skip: !root }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "selected-pi-negative-")), agent = join(directory, "agent"); mkdirSync(agent);
  const env = selectedModule.selectedPiEnvironment(selected, { HOME: directory, TMPDIR: directory, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", NO_COLOR: "1" });
  try {
    for (const name of ["NODE_OPTIONS", "OPENSSL_CONF", "LD_PRELOAD", "PI_PACKAGE_DIR"]) {
      const result = await execute(selected.entryFile, ["--version"], { ...env, [name]: "INERT_STARTUP_CONFLICT" });
      assert.equal(result.code, 1); assert.equal(result.stdout, "");
      assert.match(result.stderr, /SELECTED_HOST_ENTRY/);
      assert.doesNotMatch(result.stderr, /INERT_STARTUP_CONFLICT/);
      assert.ok(result.stderr.length <= 2000);
      for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(result.stderr.split(`${label}:`).length, 2);
    }
    const copied = join(directory, "copied-native-entry"); copyFileSync(selected.entryFile, copied);
    const copy = await execute(copied, ["--version"], env);
    assert.equal(copy.code, 1); assert.equal(copy.stdout, "");
    const direct = await execute(selected.nodeFile, [join(prefix, "selected-pi", "host.mjs"), "--version"], env);
    assert.equal(direct.code, 1); assert.equal(direct.stdout, "");
    assert.match(direct.stderr, /SELECTED_HOST_BINDING/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("selected build preserves the native addon and all managed PPA tool probes without a document grant", { skip: !root }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "selected-pi-tools-")), agent = join(directory, "agent"), config = join(directory, "config");
  mkdirSync(agent); mkdirSync(config); writeFileSync(join(config, "sensitive-patterns.yaml"), "contents: []\n");
  try {
    const env = selectedModule.selectedPiEnvironment(selected, { HOME: directory, TMPDIR: directory, PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", NO_COLOR: "1", PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: directory,
      PA_REGISTRY_DB: join(directory, "registry.db") });
    const result = await execute(join(root, "bin", "ppa"), ["pi", "smoke-tools"], env);
    assert.equal(result.code, 0, result.stderr);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.nodePath, selected.nodeFile); assert.equal(evidence.node, "v24.21.0");
    assert.deepEqual(evidence.tools.map(tool => [tool.name, tool.status]), ["read", "bash", "question", "todo", "pa_ticket", "pa_bulletin", "pa_registry", "pa_status"].map(name => [name, "passed"]));
    assert.deepEqual(evidence.extension.guards, { destructiveCommand: "passed", sensitivePath: "passed" });
    assert.equal(evidence.extension.todo.activeBranchRestore, "passed");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const fixture = process.env.PA_TEST_SELECTED_PPA_FIXTURE;
const fixturePi = process.env.PA_TEST_SELECTED_PI_FIXTURE;
test("production bootstrap and full PPA reader deliver qualified hard links through real parallel Pi dispatch", { skip: !root || !fixture || !fixturePi }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "selected-pi-dispatch-"));
  const agent = join(directory, "agent"), config = join(directory, "config"); mkdirSync(agent); mkdirSync(config);
  writeFileSync(join(config, "sensitive-patterns.yaml"), "contents:\n - 'INERT_PRIVATE_[A-Z_]+'\n");
  const mutable = join(directory, "mutable.txt"); writeFileSync(mutable, "INERT_MUTABLE_DOCUMENT_BODY"); linkSync(mutable, join(directory, "mutable-alias.txt"));
  const documents = join(fixturePi, "lib", "node_modules", "pi-monorepo");
  const fixturePrefix = join(fixture, "share", "pa-platform");
  const fixtureModule = await import(pathToFileURL(join(fixturePrefix, "packages", "pi-pa", "dist", "selected-pi-launch.js")).href);
  const { readProcessFingerprint } = await import(pathToFileURL(join(fixturePrefix, "packages", "pa-core", "dist", "index.js")).href);
  const launch = fixtureModule.resolveSelectedPiLaunch();
  const alive = (pid, fingerprint) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), state = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0];
      if (["Z", "X", "x"].includes(state)) return false;
      const current = readProcessFingerprint(pid);
      assert.ok(current, "live actor fingerprint is unproven, not established dead");
      return JSON.stringify(current) === JSON.stringify(fingerprint);
    } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
  };
  assert.ok(launch); assert.equal(launch.packageRoot, documents);
  assert.ok(statSync(join(documents, "README.md")).nlink > 1, "real immutable fixture has multiple links");
  const calls = [
    { id: "readme", name: "read", arguments: { path: join(documents, "README.md") } },
    { id: "redaction", name: "read", arguments: { path: join(documents, "docs", "pap298-note.txt"), offset: 3, limit: 1 } },
    { id: "example", name: "read", arguments: { path: join(documents, "examples", "pap298-example.ts") } },
    { id: "outside", name: "read", arguments: { path: join(documents, "pap298-outside.txt") } },
    { id: "mutable", name: "read", arguments: { path: mutable } },
    { id: "image", name: "read", arguments: { path: join(documents, "docs", "pap298-image.gif") } },
  ];
  const requests = [], failures = [], credentialChecks = [];
  const providerCredential = randomUUID();
  let completionText = "INERT_FIXTURE_DONE", providerBarrier, releaseProvider, preserve = false, completed = false;
  let discoverUserResources = false;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", async () => {
      try {
        requests.push(JSON.parse(body));
        if (providerBarrier) await providerBarrier;
        credentialChecks.push(request.headers.authorization === `Bearer ${providerCredential}`);
        const first = requests.length === 1;
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
        const chunk = delta => ({ id: "inert-completion", object: "chat.completion.chunk", created: 0, model: "pap298-fixture", choices: [{ index: 0, delta, finish_reason: null }] });
        const turnCalls = discoverUserResources ? [...calls, { id: "user-resource", name: "inert_user_discovery", arguments: {} }] : calls;
        const delta = first ? { role: "assistant", tool_calls: turnCalls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
          : { role: "assistant", content: completionText };
        response.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
        const final = chunk({}); final.choices[0].finish_reason = first ? "tool_calls" : "stop";
        response.end(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`);
      } catch (error) { failures.push(String(error)); response.writeHead(500); response.end("inert fixture failure"); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    const provider = { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "$OPENAI_API_KEY",
      models: [{ id: "pap298-fixture", name: "Inert local fixture", api: "openai-completions", reasoning: false, contextWindow: 131072, maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
    writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openai: provider, "openai-codex": provider } }));
    const defaultAgent = join(directory, ".pi", "agent");
    for (const agentDir of [agent, defaultAgent]) {
      mkdirSync(join(agentDir, "extensions"), { recursive: true });
      mkdirSync(join(agentDir, "skills", "inert-user-skill"), { recursive: true });
      if (agentDir !== agent) copyFileSync(join(agent, "models.json"), join(agentDir, "models.json"));
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false },
        packages: [join(fixturePrefix, "packages", "pi-pa")] }));
      symlinkSync(join(fixturePrefix, "packages", "pi-pa", "dist", "pi-extension", "index.js"), join(agentDir, "extensions", "pa-alias.js"));
      writeFileSync(join(agentDir, "extensions", "user-discovery.ts"), `export default function(pi) {
        pi.registerTool({ name: "inert_user_discovery", label: "Inert user resource", description: "Disposable resource discovery fixture.",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "INERT_USER_EXTENSION_LOADED" }], details: {} }; }
        });
      }`);
      writeFileSync(join(agentDir, "skills", "inert-user-skill", "SKILL.md"), "---\nname: inert-user-skill\ndescription: Disposable user resource discovery fixture.\n---\nInert user skill.\n");
    }
    const env = fixtureModule.selectedPiEnvironment(launch, { HOME: directory, TMPDIR: directory, PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", NO_COLOR: "1", OPENAI_API_KEY: providerCredential, PA_TEAM: "fixture", PA_MODE: "fixture",
      PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: directory, PA_REGISTRY_DB: join(directory, "registry.db") });
    const selectedSkill = join(directory, "selected-skill", "SKILL.md");
    mkdirSync(join(directory, "selected-skill"));
    writeFileSync(selectedSkill, "---\nname: inert-selected-skill\ndescription: Explicit managed skill fixture.\n---\nInert selected skill.\n");
    const args = ["--pa-managed-child", "--print", "--mode", "json", "--session-id", "pap298-inert-runtime",
      "--no-extensions", "--extension", join(fixturePrefix, "packages", "pi-pa", "dist", "pi-extension", "index.js"),
      "--no-skills", "--skill", selectedSkill, "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline",
      "--provider", "openai", "--model", "pap298-fixture", "--thinking", "off", "Run the inert fixture reads."];
    const result = await execute(launch.entryFile, args, env, async child => {
      const gate = await fixtureModule.awaitSelectedPiChild(launch, child.pid); gate.release();
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 2, "only the owned loopback simulator receives model requests");
    assert.deepEqual(credentialChecks, [true, true], "finite production environment preserves the required provider credential without publishing it");
    assert.doesNotMatch(JSON.stringify(requests[0]), /inert_user_discovery|inert-user-skill/);
    assert.match(JSON.stringify(requests[0]), /inert-selected-skill/);
    const events = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const finished = events.filter(event => event.type === "tool_execution_end");
    assert.equal(finished.length, 6);
    const get = id => { const event = finished.find(event => event.toolCallId === id); assert.ok(event, id); return event; };
    assert.equal(get("readme").isError, false); assert.match(JSON.stringify(get("readme")), /INERT_PPA_SELECTED_README/);
    assert.equal(get("redaction").isError, false); assert.match(JSON.stringify(get("redaction")), /REDACTED/);
    assert.equal(get("example").isError, false); assert.match(JSON.stringify(get("example")), /INERT_PPA_SELECTED_EXAMPLE/);
    for (const id of ["outside", "mutable", "image"]) {
      assert.equal(get(id).isError, true, id);
      assert.equal(get(id).result.details.code, "LOCAL_SOURCE_UNSUPPORTED_FILE", id);
    }
    const all = JSON.stringify([events, requests]);
    assert.doesNotMatch(all, /INERT_PRIVATE_DOCUMENT_CANARY|INERT_MUTABLE_DOCUMENT_BODY/);
    assert.equal(all.includes(providerCredential), false);
    assert.match(all, /INERT_FIXTURE_DONE/);

    // The public foreground CLI must use this same production producer, not a
    // special SDK reader. Its existing adapter owns the nested PTY and PID gate.
    const repo = join(directory, "repo"); mkdirSync(repo);
    writeFileSync(join(repo, "README.txt"), "Inert PAP-298 repository fixture.\n");
    for (const args of [["init", "--quiet", "--initial-branch=fixture"], ["add", "README.txt"],
      ["-c", "user.name=PAP-298 fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "inert fixture"]]) {
      const git = spawnSync("git", args, { cwd: repo, env: { HOME: directory, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr);
    }
    writeFileSync(join(config, "config.yaml"), `config_dir: ${JSON.stringify(config)}\nrepos:\n  fixture:\n    path: ${JSON.stringify(repo)}\n    mainBranch: fixture\n    developBranch: fixture\n`);
    mkdirSync(join(config, "teams"));
    writeFileSync(join(config, "teams", "rogue-one.yaml"), "name: rogue-one\ndescription: Inert production-reader fixture\nagents:\n  - name: fixture\n    role: inert\n    instruction: unused.txt\n");
    writeFileSync(join(config, "unused.txt"), "Inert configured instruction; rogue-one must ignore this.\n");
    const deployRoot = join(directory, "deployments");
    let original;
    discoverUserResources = true;
    for (const [phaseIndex, phase] of ["foreground", "resume", "background"].entries()) {
      const prior = phase === "resume" ? readdirSync(deployRoot).filter(name => /^d-[a-f0-9]{6}$/.test(name))[0] : undefined;
      requests.length = 0; credentialChecks.length = 0; completionText = `INERT_FIXTURE_DONE_${phase.toUpperCase()}`;
      const args = ["deploy", "rogue-one", "--repo", "fixture", "--provider", "openai", "--model", "openai/pap298-fixture",
        "--objective", "Run the inert fixture reads.", ...(prior ? ["--resume", prior] : [])];
      let cli;
      const phaseEnv = { ...env };
      if (phase !== "background") delete phaseEnv.PI_CODING_AGENT_DIR;
      if (phase !== "background") cli = await executeTerminal(fixturePrefix, join(fixture, "bin", "ppa"), args, phaseEnv, repo, completionText);
      else {
        const old = new Set(readdirSync(deployRoot));
        providerBarrier = new Promise(resolve => { releaseProvider = resolve; });
        preserve = true;
        cli = await execute(join(fixture, "bin", "ppa"), [...args, "--background"], env);
        assert.equal(cli.code, 0, cli.stderr);
        const added = readdirSync(deployRoot).filter(id => !old.has(id)); assert.equal(added.length, 1);
        const backgroundDir = join(deployRoot, added[0]), ownershipPath = join(backgroundDir, "pi-supervisor.json");
        let ownership, fingerprint;
        try {
          ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
          fingerprint = readProcessFingerprint(ownership.supervisorPid); assert.ok(fingerprint);
          assert.ok(readFileSync(`/proc/${ownership.supervisorPid}/cmdline`, "utf8").split("\0").includes(join(backgroundDir, "pi-background.json")));
          // Hold the owned loopback provider until the exact real topology is
          // observed. No sleeps guess that a short model turn is still alive.
          const firstRequest = performance.now();
          while (!requests.length && performance.now() - firstRequest < 10000) await new Promise(resolve => setTimeout(resolve, 5));
          assert.equal(requests.length, 1);
          const runtimeFingerprint = readProcessFingerprint(ownership.childPid); assert.ok(runtimeFingerprint);
          assert.equal(realpathSync(`/proc/${ownership.childPid}/exe`), launch.nodeFile);
          const childStat = readFileSync(`/proc/${ownership.childPid}/stat`, "utf8"), parent = Number(childStat.slice(childStat.lastIndexOf(") ") + 2).split(" ")[1]);
          assert.notEqual(ownership.childPid, ownership.supervisorPid); assert.notEqual(parent, ownership.supervisorPid);
          const parentFingerprint = readProcessFingerprint(parent); assert.ok(parentFingerprint);
          assert.equal(realpathSync(`/proc/${parent}/exe`), launch.entryFile);
          const parentStat = readFileSync(`/proc/${parent}/stat`, "utf8");
          assert.equal(Number(parentStat.slice(parentStat.lastIndexOf(") ") + 2).split(" ")[1]), ownership.supervisorPid);
          providerBarrier = undefined; releaseProvider(); releaseProvider = undefined;
          const start = performance.now();
          while (performance.now() - start < 45000) {
            ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
            if (ownership.state === "finalized" && !alive(ownership.supervisorPid, fingerprint)) break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(ownership.state, "finalized"); assert.equal(ownership.terminalStatus, "success");
          assert.equal(alive(ownership.supervisorPid, fingerprint), false, "original background runner is absent or dead");
          assert.equal(alive(ownership.childPid, runtimeFingerprint), false, "original runtime child is absent or dead");
          assert.equal(alive(parent, parentFingerprint), false, "original native parent is absent or dead");
          preserve = false;
        } finally {
          providerBarrier = undefined; releaseProvider?.(); releaseProvider = undefined;
          if (preserve && fingerprint) {
            if (alive(ownership.supervisorPid, fingerprint)) process.kill(ownership.supervisorPid, "SIGTERM");
            const start = performance.now();
            while (performance.now() - start < 5000 && alive(ownership.supervisorPid, fingerprint)) await new Promise(resolve => setTimeout(resolve, 10));
            preserve = alive(ownership.supervisorPid, fingerprint);
          }
        }
      }
      assert.notEqual(cli.timedOut, true, `public ${phase} did not settle`);
      assert.equal(cli.code, 0, cli.stdout.slice(-2000)); assert.equal(requests.length, 2, phase);
      assert.deepEqual(credentialChecks, [true, true], phase);
      assert.match(JSON.stringify(requests[0]), /inert_user_discovery/);
      assert.doesNotMatch(JSON.stringify(requests[0]), /inert-user-skill/);
      assert.match(JSON.stringify(requests[1]), /INERT_USER_EXTENSION_LOADED/);
      const paTicketTools = requests[0].tools.filter(tool => tool.function?.name === "pa_ticket");
      assert.equal(paTicketTools.length, 1, "settings package and symlink discovery do not duplicate native PA registration");
      if (phase !== "background") assert.ok(cli.stdout.includes(completionText));
      assert.match(JSON.stringify(requests[1]), /INERT_PPA_SELECTED_README/); assert.match(JSON.stringify(requests[1]), /INERT_PPA_SELECTED_EXAMPLE/);
      assert.doesNotMatch(JSON.stringify([cli, requests]), /INERT_PRIVATE_DOCUMENT_CANARY|INERT_MUTABLE_DOCUMENT_BODY/);
      assert.equal(JSON.stringify([cli, requests]).includes(providerCredential), false);
      const deployments = readdirSync(deployRoot).filter(name => /^d-[a-f0-9]{6}$/.test(name));
      assert.equal(deployments.length, phaseIndex + 1);
      original ??= deployments[0];
      for (const id of deployments) {
        const evidence = join(deployRoot, id, "pi-selected-host.json"), value = JSON.parse(readFileSync(evidence, "utf8"));
        assert.equal(statSync(evidence).mode & 0o777, 0o600); assert.equal(statSync(evidence).nlink, 1);
        assert.equal(value.deploymentId, id); assert.equal(value.entryFile, launch.entryFile);
        if (prior) assert.equal(value.sessionId, JSON.parse(readFileSync(join(deployRoot, prior, "pi-selected-host.json"), "utf8")).sessionId);
      }
    }
    const ordinary = process.env.PA_TEST_ORDINARY_PPA_ROOT;
    assert.ok(ordinary, "required route qualification supplies the actual ordinary build too");
    const resumeArgs = ["deploy", "rogue-one", "--repo", "fixture", "--provider", "openai", "--model", "openai/pap298-fixture", "--resume", original];
    const before = readdirSync(deployRoot).sort();
    const originalEvidence = readFileSync(join(deployRoot, original, "pi-selected-host.json"), "utf8");
    for (const packageRoot of [root, ordinary]) {
      requests.length = 0; credentialChecks.length = 0;
      const rejected = await execute(join(packageRoot, "bin", "ppa"), resumeArgs, env);
      assert.equal(rejected.code, 1); assert.equal(requests.length, 0, "mismatch/downgrade never reaches a model");
      const diagnostic = rejected.stdout + rejected.stderr;
      assert.match(diagnostic, /verified host contract/); assert.ok(diagnostic.length <= 2000);
      for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(diagnostic.split(`${label}:`).length, 2);
      assert.deepEqual(readdirSync(deployRoot).sort(), before, "reject before allocating another deployment");
      assert.equal(readFileSync(join(deployRoot, original, "pi-selected-host.json"), "utf8"), originalEvidence);
    }
    // Explicitly unqualified historical fixture: no native marker, no minted
    // producer or claimed prior execution. It must never be silently upgraded.
    let serial = 0, legacy;
    do { legacy = `d-${(serial++).toString(16).padStart(6, "0")}`; } while (before.includes(legacy));
    const legacyDir = join(deployRoot, legacy); mkdirSync(legacyDir, { mode: 0o700 });
    writeFileSync(join(legacyDir, "session-id-pi.txt"), "inert-unqualified-session\n", { mode: 0o600 });
    const withLegacy = readdirSync(deployRoot).sort();
    requests.length = 0;
    const upgrade = await execute(join(fixture, "bin", "ppa"), [...resumeArgs.slice(0, -1), legacy], env);
    assert.equal(upgrade.code, 1); assert.equal(requests.length, 0);
    assert.match(upgrade.stdout + upgrade.stderr, /verified host contract/);
    assert.deepEqual(readdirSync(deployRoot).sort(), withLegacy);
    assert.deepEqual(readdirSync(legacyDir), ["session-id-pi.txt"]);
    completed = true;
  } finally {
    providerBarrier = undefined; releaseProvider?.();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (completed && !preserve) rmSync(directory, { recursive: true, force: true });
    else console.error(`Failed production fixture preserved at ${directory}; inspect the original evidence before repeating. Background settlement ${preserve ? "is unproven" : "was observed"}.`);
  }
});
