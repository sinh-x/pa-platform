#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const MATERIAL_MARGIN_MS = 4_000;
const PUBLIC_LIMIT_MS = 5_000;
const VERSION_DELAY_MS = Number(process.env.PAP156_VERSION_DELAY_MS ?? 1_900);
const CHILD_LIFETIME_MS = Number(process.env.PAP156_CHILD_LIFETIME_MS ?? 3_000);
const storeOutput = resolve(process.argv[2] ?? process.env.PPA_STORE_OUTPUT ?? "");
const ppa = join(storeOutput, "bin", "ppa");
const platformNode = join(storeOutput, "bin", "pa-platform-node");
const coreModule = join(storeOutput, "share", "pa-platform", "packages", "pa-core", "dist", "index.js");
assert.ok(storeOutput && existsSync(ppa), "usage: pap-156-caller-boundary-smoke.mjs <ppa-store-output>");
assert.ok(existsSync(platformNode) && existsSync(coreModule), "candidate is missing installed PA output");
assert.ok(Number.isFinite(VERSION_DELAY_MS) && VERSION_DELAY_MS >= 0);
assert.ok(Number.isFinite(CHILD_LIFETIME_MS) && CHILD_LIFETIME_MS >= 1_000);

const root = mkdtempSync(join(tmpdir(), "pap-156-caller-boundary-"));
let supervisorPid;
try {
  const bin = join(root, "bin");
  const config = join(root, "config");
  const teams = join(root, "teams");
  const skills = join(root, "skills");
  const repo = join(root, "repo");
  mkdirSync(bin, { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  mkdirSync(skills, { recursive: true });
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "pap156@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "PAP-156 Fixture"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "PAP-156 caller-boundary fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\n`);
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pap156-fixture:\n    path: ${repo}\n    description: Synthetic PAP-156 repository\n    prefix: PAP\n`);
  const realPi = process.env.PAP156_REAL_PI ?? "/home/sinh/.nix-profile/bin/pi";
  const piNode = resolvePiNodeHost(realPi);
  const probeLog = join(root, "pi-probes.jsonl");
  const fakePi = join(bin, "pi");
  writeFileSync(fakePi, [
    `#!${process.execPath}`,
    `import { appendFileSync } from "node:fs";`,
    `const piNodeHost = ${JSON.stringify(piNode)};`,
    `const log = (event) => appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify({ event, at: Date.now(), pid: process.pid }) + "\\n");`,
    `if (process.argv[2] === "--version") {`,
    `  log("version_start");`,
    `  await new Promise((resolve) => setTimeout(resolve, ${VERSION_DELAY_MS}));`,
    `  log("version_end");`,
    `  process.stdout.write("0.80.8\\n");`,
    `} else {`,
    `  log("child_start");`,
    `  await new Promise((resolve) => setTimeout(resolve, ${CHILD_LIFETIME_MS}));`,
    `  process.stdout.write(JSON.stringify({ type: "agent_end", stopReason: "stop", timestamp: new Date().toISOString() }) + "\\n");`,
    `}`,
    `void piNodeHost;`,
  ].join("\n"));
  chmodSync(fakePi, 0o755);
  writeFileSync(join(teams, "pap156.yaml"), [
    "name: pap156",
    "description: Synthetic PAP-156 caller-boundary fixture",
    "default_mode: smoke",
    "agents: []",
    "deploy_modes:",
    "  - id: smoke",
    "    label: Smoke",
    "    provider: openai",
    "    model: openai/gpt-5.6-sol",
    "    agents: []",
    "    skills: []",
    "",
  ].join("\n"));
  const objective = join(root, "objective.md");
  writeFileSync(objective, "Synthetic non-model PAP-156 caller-boundary fixture.\n");

  const aiUsage = join(root, "ai-usage");
  const registry = join(root, "registry.db");
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    PA_AI_USAGE_HOME: aiUsage,
    PA_REGISTRY_DB: registry,
    PA_PLATFORM_CONFIG: config,
    PA_PLATFORM_HOME: root,
    PA_PLATFORM_TEAMS: teams,
    PA_PLATFORM_SKILLS: skills,
  };
  const invocationWallMs = Date.now();
  const invocationMonotonicMs = performance.now();
  const launcher = spawn(ppa, ["deploy", "pap156", "--mode", "smoke", "--background", "--repo", "pap156-fixture", "--objective-file", objective, "--timeout", "60"], {
    cwd: repo, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  launcher.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  launcher.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const launcherCode = await new Promise((resolveCode) => {
    const timer = setTimeout(() => { launcher.kill("SIGKILL"); resolveCode(124); }, 15_000);
    launcher.once("close", (code) => { clearTimeout(timer); resolveCode(code); });
  });
  const callerReturnWallMs = Date.now();
  const callerElapsedMs = performance.now() - invocationMonotonicMs;
  assert.equal(launcherCode, 0, stderr || stdout);
  const deploymentId = /^Deployment:\s+(d-[a-z0-9]+)$/m.exec(stdout)?.[1];
  assert.ok(deploymentId, `candidate did not print a deployment id: ${stdout}`);

  const ownershipPath = join(aiUsage, "deployments", deploymentId, "pi-supervisor.json");
  let ownership = readOwnership(ownershipPath);
  const readyOwnershipAt = Date.parse(ownership.updatedAt);
  assert.equal(ownership.ready, true, "caller returned before durable ownership was ready");
  assert.ok(["active", "finalizing", "finalized"].includes(ownership.state), `invalid ownership state ${ownership.state}`);
  assert.ok(Number.isInteger(ownership.supervisorPid) && ownership.supervisorPid > 0);
  assert.ok(Number.isInteger(ownership.childPid) && ownership.childPid > 0);
  supervisorPid = ownership.supervisorPid;
  assert.equal(processExists(ownership.supervisorPid), true, "supervisor did not survive caller exit");
  assert.equal(processExists(ownership.childPid), true, "active child did not survive caller exit");

  const terminalDeadline = performance.now() + 8_000;
  while (ownership.state !== "finalized" && performance.now() < terminalDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    ownership = readOwnership(ownershipPath);
  }
  assert.equal(ownership.state, "finalized", "durable supervisor did not finalize");
  assert.equal(ownership.terminalEvent, "completed");
  assert.equal(ownership.terminalStatus, "success");

  const registryProbe = spawnSync(platformNode, ["--input-type=module", "--eval", [
    `const core = await import(${JSON.stringify(coreModule)});`,
    `process.stdout.write(JSON.stringify(core.getDeploymentEvents(${JSON.stringify(deploymentId)})));`,
  ].join("\n")], { cwd: repo, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(registryProbe.status, 0, registryProbe.stderr);
  const events = JSON.parse(registryProbe.stdout);
  const started = events.find((event) => event.event === "started");
  const pidEvent = events.find((event) => event.event === "pid");
  const terminalEvents = events.filter((event) => event.event === "completed" || event.event === "crashed");
  assert.ok(started && pidEvent, "registry is missing start/PID readiness evidence");
  assert.deepEqual(terminalEvents.map((event) => [event.event, event.status]), [["completed", "success"]]);

  const probes = readFileSync(probeLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const versionStart = probes.find((probe) => probe.event === "version_start")?.at;
  const versionEnd = probes.find((probe) => probe.event === "version_end")?.at;
  const childStart = probes.find((probe) => probe.event === "child_start")?.at;
  assert.ok(Number.isFinite(versionStart) && Number.isFinite(versionEnd) && Number.isFinite(childStart));
  const startedAt = Date.parse(started.timestamp);
  const pidAt = Date.parse(pidEvent.timestamp);
  const evidence = {
    deploymentId,
    candidate: storeOutput,
    callerElapsedMs: round(callerElapsedMs),
    limitsMs: { materialMargin: MATERIAL_MARGIN_MS, public: PUBLIC_LIMIT_MS },
    configuredVersionDelayMs: VERSION_DELAY_MS,
    timelineMs: {
      invocationToRegistryStart: round(startedAt - invocationWallMs),
      registryStartToVersionProbe: round(versionStart - startedAt),
      versionProbe: round(versionEnd - versionStart),
      versionEndToOwnershipPublication: round(readyOwnershipAt - versionEnd),
      registryStartToPidReadiness: round(pidAt - startedAt),
      pidReadinessToCallerReturn: round(callerReturnWallMs - pidAt),
      ownershipPublicationToCallerReturn: round(callerReturnWallMs - readyOwnershipAt),
      childCodeStartAfterCallerReturn: round(childStart - callerReturnWallMs),
    },
    ownership: { ready: true, supervisorPid: ownership.supervisorPid, childPid: ownership.childPid },
    terminal: { event: "completed", status: "success", count: terminalEvents.length },
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  assert.ok(callerElapsedMs < PUBLIC_LIMIT_MS, `public caller boundary took ${round(callerElapsedMs)}ms (limit <${PUBLIC_LIMIT_MS}ms)`);
  assert.ok(callerElapsedMs <= MATERIAL_MARGIN_MS, `cold caller boundary took ${round(callerElapsedMs)}ms (material-margin target <=${MATERIAL_MARGIN_MS}ms)`);
} finally {
  if (supervisorPid && processExists(supervisorPid)) {
    try { process.kill(-supervisorPid, "SIGTERM"); } catch { try { process.kill(supervisorPid, "SIGTERM"); } catch {} }
  }
  rmSync(root, { recursive: true, force: true });
}

function resolvePiNodeHost(piPath) {
  let current = realpathSync(piPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const body = readFileSync(current, "utf8");
    const targets = [...body.matchAll(/"([^"\n]+\/bin\/(?:node|\.pi-wrapped))"/g)].map((match) => match[1]);
    const target = targets.at(-1);
    if (!target) break;
    if (target.endsWith("/bin/node")) return realpathSync(target);
    current = realpathSync(target);
  }
  throw new Error(`could not resolve Pi Node host from ${piPath}`);
}

function readOwnership(path) {
  assert.ok(existsSync(path), `ownership evidence is missing: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function round(value) { return Math.round(value * 1_000) / 1_000; }
