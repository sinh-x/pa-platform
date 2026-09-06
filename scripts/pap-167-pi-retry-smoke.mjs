#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// PAP-167 isolated retry/session-restart teardown harness.
// Runs the pi-node-24 registry teardown case in an isolated Pi Node 24 child so
// a native abort cannot kill the coordinator, and records child status/signal,
// bounded stderr, host ABI, addon path, registry operation, and teardown order.
// Usage: node scripts/pap-167-pi-retry-smoke.mjs [<ppa-store-output>] [--process-evidence|--regression|--baseline-calibrate] [--runs N] [--operations N] [--evidence <path>]

const MAX_STDERR = 2_000;
const DEFAULT_RUNS = 1;
const DEFAULT_OPERATIONS = 250;
const BASELINE_ADDON_VERSION = "11.6.0";
const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;

export const REGISTRY_OPERATION_MIX = [
  "appendRegistryEvent",
  "queryDeploymentStatuses",
  "queryDeploymentStatus",
  "getDeploymentEvents",
  "readRegistry",
];

export function workloadPlan(operations) {
  const perKind = Object.fromEntries(REGISTRY_OPERATION_MIX.map((kind) => [kind, 0]));
  for (let index = 0; index < operations; index += 1) {
    const kind = REGISTRY_OPERATION_MIX[index % REGISTRY_OPERATION_MIX.length];
    perKind[kind] += 1;
  }
  return { operations, mix: [...REGISTRY_OPERATION_MIX], perKind };
}

function configuredSecrets(env) {
  return [...new Set(Object.entries(env)
    .filter(([key, value]) => SECRET_KEY.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value))];
}

function redactDiagnostic(value, secrets) {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/(?:token|secret|password|api[_-]?key|authorization)\s*(?::|=|\s)\s*\S+/gi, "[REDACTED]")
    .replace(/bearer\s+\S+/gi, "[REDACTED]")
    .replace(/sk-[\w-]+/gi, "[REDACTED]");
}

export function parseArgs(argv) {
  const positional = [];
  let processEvidence = false;
  let regression = false;
  let baselineCalibrate = false;
  let runs = DEFAULT_RUNS;
  let operations = DEFAULT_OPERATIONS;
  let evidencePath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--process-evidence") processEvidence = true;
    else if (arg === "--regression") regression = true;
    else if (arg === "--baseline-calibrate") baselineCalibrate = true;
    else if (arg === "--runs") { runs = Number(argv[++index]); }
    else if (arg === "--operations") { operations = Number(argv[++index]); }
    else if (arg === "--evidence") { evidencePath = argv[++index]; }
    else positional.push(arg);
  }
  return { storeArg: positional[0], processEvidence, regression, baselineCalibrate, runs, operations, evidencePath };
}

export function resolveStoreOutput(storeArg, env = process.env) {
  if (storeArg && existsSync(join(storeArg, "bin", "ppa"))) return resolve(storeArg);
  const addon = env.PA_PI_SQLITE_NATIVE_BINDING;
  if (addon) {
    const resolvedAddon = resolve(addon);
    if (!existsSync(resolvedAddon)) {
      throw new Error(`PA_PI_SQLITE_NATIVE_BINDING does not exist: ${resolvedAddon}`);
    }
    let candidate = dirname(resolvedAddon);
    while (true) {
      if (existsSync(join(candidate, "bin", "ppa"))) return candidate;
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    throw new Error(`could not resolve an installed pa-platform store output from PA_PI_SQLITE_NATIVE_BINDING: no ancestor of ${resolvedAddon} contains bin/ppa`);
  }
  throw new Error("could not resolve an installed pa-platform store output; pass <ppa-store-output> or set PA_PI_SQLITE_NATIVE_BINDING");
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

export function resolveStoreAddonVersion(storeOutput) {
  const manifestPath = join(storeOutput, "share", "pa-platform", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = manifest.dependencies?.["better-sqlite3"];
  return typeof version === "string" ? version : null;
}

export function assertBaselineReproduced(cases) {
  for (const item of cases) {
    assert.notEqual(item.processExit.code, 0, `baseline child ${item.run} did not abort (exit ${item.processExit.code})`);
    assert.equal(item.signatures.removeEnvironmentCleanupHook, true, `baseline child ${item.run} missing RemoveEnvironmentCleanupHook signature:\n${item.boundedStderr}`);
    assert.equal(item.signatures.statementDestructor, true, `baseline child ${item.run} missing Statement::~Statement signature:\n${item.boundedStderr}`);
    assert.equal(item.signatures.assertion, true, `baseline child ${item.run} missing native assertion:\n${item.boundedStderr}`);
  }
}

function childSource({ processEvidence, workload }) {
  const { operations, mix } = workload;
  return [
    `import { writeFileSync } from "node:fs";`,
    `const addon = process.env.PAP167_ADDON;`,
    `const closeOnTeardown = process.env.PAP167_CLOSE_ON_TEARDOWN === "1";`,
    `const processEvidence = ${JSON.stringify(processEvidence)};`,
    `const operations = ${JSON.stringify(operations)};`,
    `const mix = ${JSON.stringify(mix)};`,
    `process.env.PA_SQLITE_NATIVE_BINDING = addon;`,
    `process.env.PA_REGISTRY_DB = process.env.PAP167_REGISTRY_DB;`,
    `process.env.PA_AI_USAGE_HOME = process.env.PAP167_AI_USAGE;`,
    `const registry = await import(process.env.PAP167_CORE_MODULE + "/registry/index.js");`,
    `const evidence = {`,
    `  node: process.version,`,
    `  modules: process.versions.modules ?? "unknown",`,
    `  v8: process.versions.v8,`,
    `  addonPath: addon,`,
    `};`,
    `const now = () => new Date().toISOString();`,
    `const perKind = Object.fromEntries(mix.map((kind) => [kind, 0]));`,
    `for (let i = 0; i < operations; i += 1) {`,
    `  const kind = mix[i % mix.length];`,
    `  perKind[kind] += 1;`,
    `  if (kind === "appendRegistryEvent") registry.appendRegistryEvent({ deployment_id: "d-pap167-op-" + i, team: "builder", event: "started", timestamp: now(), mode: "implement", runtime: "pi", binary: "ppa" });`,
    `  else if (kind === "queryDeploymentStatuses") registry.queryDeploymentStatuses();`,
    `  else if (kind === "queryDeploymentStatus") registry.queryDeploymentStatus("d-pap167-op-" + (i % 7));`,
    `  else if (kind === "getDeploymentEvents") registry.getDeploymentEvents("d-pap167-op-" + (i % 7));`,
    `  else if (kind === "readRegistry") registry.readRegistry();`,
    `}`,
    `evidence.workload = { operations, mix, perKind };`,
    `evidence.registryOp = { kind: "operationMix", operations, perKind };`,
    `evidence.teardown = closeOnTeardown ? "session_shutdown -> closeDb()" : "session_shutdown WITHOUT closeDb (baseline)";`,
    `writeFileSync(process.env.PAP167_EVIDENCE_PATH, JSON.stringify(evidence), { mode: 0o600 });`,
    `if (processEvidence) {`,
    `  writeFileSync(process.env.PAP167_TERMINAL_PATH, JSON.stringify({ type: "agent_end", stopReason: "stop", timestamp: now() }) + "\\n", { mode: 0o600 });`,
    `}`,
    `if (closeOnTeardown) registry.closeDb();`,
    `if (globalThis.gc) globalThis.gc();`,
    `process.stdout.write(JSON.stringify(evidence) + "\\n");`,
    `if (processEvidence) {`,
    `  process.stderr.write("  #  pi[fixture]: void node::RemoveEnvironmentCleanupHook(v8::Isolate*, CleanupHook, void*) at ../../src/api/hooks.cc:142\\n  #  Assertion failed: (env) != nullptr\\n\\n 3: fixture Statement::~Statement() [" + addon + "]\\n");`,
    `  process.abort();`,
    `}`,
  ].join("\n");
}

function reconcileProcessEvidence({ storeOutput, registryDb, aiUsage, deployDir, processExit, boundedStderr, secrets }) {
  const diagnostic = redactDiagnostic(`runner-process: Pi exited with code ${processExit.code}; ${boundedStderr}`, secrets).slice(0, MAX_STDERR);
  const source = [
    `const core = await import(process.env.PAP167_CORE_MODULE + "/registry/index.js");`,
    `const terminal = await import(process.env.PAP167_TERMINAL_MODULE);`,
    `const deployDir = process.env.PAP167_DEPLOY_DIR;`,
    `const before = terminal.readPiTerminalStatus(deployDir);`,
    `const requested = { deployment_id: "d-pap167", team: "builder", event: "crashed", timestamp: new Date().toISOString(), error: process.env.PAP167_PROCESS_DIAGNOSTIC, exit_code: Number(process.env.PAP167_PROCESS_EXIT) };`,
    `const authoritative = core.reconcileTerminalRegistryEvent(requested).event;`,
    `const error = (authoritative.event === "crashed" ? authoritative.error : authoritative.summary) ?? process.env.PAP167_PROCESS_DIAGNOSTIC;`,
    `terminal.writePiTerminalStatus(deployDir, { type: "agent_end", stopReason: "error", error, timestamp: authoritative.timestamp });`,
    `const registryStatus = core.queryDeploymentStatus("d-pap167");`,
    `const registryTerminal = core.getDeploymentEvents("d-pap167").filter((event) => event.event === "completed" || event.event === "crashed");`,
    `const persistedTerminal = terminal.readPiTerminalStatus(deployDir);`,
    `core.closeDb();`,
    `process.stdout.write(JSON.stringify({ before, persistedTerminal, registryStatus, registryTerminal }));`,
  ].join("\n");
  const result = spawnSync(join(storeOutput, "bin", "pa-platform-node"), ["--input-type=module", "--eval", source], {
    cwd: deployDir,
    env: {
      ...process.env,
      PA_REGISTRY_DB: registryDb,
      PA_AI_USAGE_HOME: aiUsage,
      PAP167_CORE_MODULE: join(storeOutput, "share", "pa-platform", "packages", "pa-core", "dist"),
      PAP167_TERMINAL_MODULE: join(storeOutput, "share", "pa-platform", "packages", "pi-pa", "dist", "terminal-status.js"),
      PAP167_DEPLOY_DIR: deployDir,
      PAP167_PROCESS_DIAGNOSTIC: diagnostic,
      PAP167_PROCESS_EXIT: String(processExit.code),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const error = redactDiagnostic(result.stderr || result.error?.message || "", secrets).slice(0, MAX_STDERR);
  assert.equal(result.status, 0, `process evidence reconciliation failed: ${error}`);
  return JSON.parse(result.stdout || "{}");
}

function runCase({ piNode, storeOutput, addon, root, closeOnTeardown, processEvidence, workload, run, secrets }) {
  const deployDir = join(root, `run-${run}`);
  mkdirSync(deployDir, { recursive: true });
  const registryDb = join(deployDir, "registry.db");
  const aiUsage = join(deployDir, "ai-usage");
  const childPath = join(deployDir, "pap-167-child.mjs");
  const terminalPath = join(deployDir, "pi-terminal-status.json");
  const evidencePath = join(deployDir, "pap-167-evidence.json");
  writeFileSync(childPath, childSource({ processEvidence, workload }));
  const env = {
    ...process.env,
    PAP167_ADDON: addon,
    PAP167_CLOSE_ON_TEARDOWN: closeOnTeardown ? "1" : "0",
    PAP167_REGISTRY_DB: registryDb,
    PAP167_AI_USAGE: aiUsage,
    PAP167_CORE_MODULE: join(storeOutput, "share", "pa-platform", "packages", "pa-core", "dist"),
    PAP167_TERMINAL_PATH: terminalPath,
    PAP167_EVIDENCE_PATH: evidencePath,
  };
  const result = spawnSync(piNode, ["--expose-gc", childPath], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
  });
  const stderr = redactDiagnostic((result.stderr ?? "").trim(), secrets);
  const boundedStderr = stderr.length > MAX_STDERR ? `${stderr.slice(0, MAX_STDERR - 3)}...` : stderr;
  const signatures = {
    removeEnvironmentCleanupHook: /RemoveEnvironmentCleanupHook/.test(stderr),
    statementDestructor: /Statement::~Statement\(\)/.test(stderr),
    assertion: /Assertion failed: \(env\) != nullptr/.test(stderr),
  };
  let stdout = "";
  try { stdout = JSON.parse((result.stdout ?? "").trim().split("\n").at(-1) ?? "{}"); } catch { stdout = {}; }
  let childEvidence = {};
  try { childEvidence = JSON.parse(readFileSync(evidencePath, "utf8")); } catch { childEvidence = stdout; }
  let messageTerminal = null;
  try { messageTerminal = JSON.parse(readFileSync(terminalPath, "utf8")); } catch { /* absent outside process-evidence mode */ }
  const processExit = result.signal
    ? { kind: "signal", signal: result.signal, code: result.signal === "SIGABRT" ? 134 : 128 }
    : { kind: "status", signal: null, code: result.status ?? 1 };
  const error = redactDiagnostic(result.error?.message ?? "", secrets).slice(0, MAX_STDERR) || null;
  const persistedEvidence = processEvidence
    ? reconcileProcessEvidence({ storeOutput, registryDb, aiUsage, deployDir, processExit, boundedStderr, secrets })
    : null;
  const diagnosticText = `${error ?? ""}\n${boundedStderr}\n${JSON.stringify(persistedEvidence ?? {})}`;
  const configuredSecretLeaks = secrets.filter((secret) => diagnosticText.includes(secret)).length;
  const evidenceClassification = messageTerminal?.stopReason === "stop"
    && processExit.code !== 0
    && signatures.removeEnvironmentCleanupHook
    && signatures.statementDestructor
    && signatures.assertion
    && persistedEvidence?.persistedTerminal?.stopReason === "error"
    && ["crashed", "failed"].includes(persistedEvidence?.registryStatus?.status)
    ? "process_abort_supersedes_message_stop"
    : processExit.code === 0 ? "graceful_process_exit" : "nonzero_process_exit";
  return {
    run,
    command: `${piNode} --expose-gc ${childPath}`,
    closeOnTeardown,
    workload,
    status: result.status,
    signal: result.signal ?? null,
    processExit,
    error,
    messageTerminal,
    persistedEvidence,
    evidenceClassification,
    stdoutEvidence: childEvidence,
    boundedStderr,
    diagnostics: { maxErrorCharacters: MAX_STDERR, configuredSecretLeaks },
    signatures,
  };
}

function main() {
  const { storeArg, processEvidence, regression, baselineCalibrate, runs, operations, evidencePath } = parseArgs(process.argv.slice(2));
  assert.ok(Number.isInteger(runs) && runs >= 1, "--runs must be a positive integer");
  assert.ok(Number.isInteger(operations) && operations >= 1, "--operations must be a positive integer");
  assert.equal([processEvidence, regression, baselineCalibrate].filter(Boolean).length <= 1, true, "--process-evidence, --regression, and --baseline-calibrate are mutually exclusive");
  assert.ok(evidencePath === undefined || evidencePath.length > 0, "--evidence requires a path");
  const storeOutput = resolveStoreOutput(storeArg);
  const ppa = join(storeOutput, "bin", "ppa");
  const addon = join(storeOutput, "share", "pa-platform", "native-addons", "pi-node-24", "better_sqlite3.node");
  assert.ok(existsSync(ppa), `missing installed ppa: ${ppa}`);
  assert.ok(existsSync(addon), `missing pi-node-24 addon: ${addon}`);
  const piPath = process.env.PAP167_REAL_PI ?? "/home/sinh/.nix-profile/bin/pi";
  const piNode = resolvePiNodeHost(piPath);

  const workload = workloadPlan(operations);
  const addonVersion = resolveStoreAddonVersion(storeOutput);
  if (baselineCalibrate) {
    assert.equal(addonVersion, BASELINE_ADDON_VERSION, `baseline calibration requires a ${BASELINE_ADDON_VERSION} store output; resolved ${addonVersion}`);
  }

  const root = mkdtempSync(join(tmpdir(), "pap-167-pi-retry-"));
  const cases = [];
  const secrets = configuredSecrets(process.env);
  const closeOnTeardown = regression || baselineCalibrate;
  try {
    for (let run = 1; run <= runs; run += 1) {
      cases.push(runCase({ piNode, storeOutput, addon, root, closeOnTeardown, processEvidence, workload, run, secrets }));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const evidence = {
    mode: regression ? "regression" : baselineCalibrate ? "baseline-calibrate" : processEvidence ? "process-evidence" : "baseline",
    ...(processEvidence ? {
      fixture: {
        kind: "approved-signature-replay",
        purpose: "verify message-level stop does not mask a later process-level abort",
        productionSources: ["d-779f18", "d-5cbc2b"],
      },
    } : {}),
    storeOutput,
    addon,
    addonVersion,
    piNode,
    runs,
    workload,
    cases,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  process.stdout.write(serialized);
  if (evidencePath) writeFileSync(resolve(evidencePath), serialized, { mode: 0o600 });

  if (processEvidence) {
    for (const item of cases) {
      assert.equal(item.messageTerminal?.stopReason, "stop", `child ${item.run} did not persist message-level stop`);
      assert.notEqual(item.processExit.code, 0, `child ${item.run} did not abort after message-level stop`);
      assert.equal(item.evidenceClassification, "process_abort_supersedes_message_stop");
      assert.deepEqual(item.signatures, { removeEnvironmentCleanupHook: true, statementDestructor: true, assertion: true });
      assert.equal(item.persistedEvidence.before?.stopReason, "stop");
      assert.equal(item.persistedEvidence.persistedTerminal?.stopReason, "error");
      assert.equal(item.persistedEvidence.registryStatus?.status, "crashed");
      assert.equal(item.persistedEvidence.registryTerminal?.length, 1);
      assert.equal(item.persistedEvidence.registryTerminal?.[0]?.event, "crashed");
      assert.equal(item.persistedEvidence.registryTerminal?.[0]?.exit_code, item.processExit.code);
      assert.match(item.persistedEvidence.persistedTerminal?.error ?? "", /RemoveEnvironmentCleanupHook/);
      assert.equal(item.diagnostics.configuredSecretLeaks, 0);
      assert.ok(item.boundedStderr.length <= MAX_STDERR);
      assert.ok((item.error?.length ?? 0) <= MAX_STDERR);
      assert.ok((item.persistedEvidence.persistedTerminal?.error?.length ?? Infinity) <= MAX_STDERR);
      assert.ok((item.persistedEvidence.registryTerminal?.[0]?.error?.length ?? Infinity) <= MAX_STDERR);
    }
  }

  if (regression) {
    for (const item of cases) {
      assert.equal(item.error, null, `child ${item.run} failed to spawn: ${item.error}`);
      assert.equal(item.signal, null, `child ${item.run} was killed by signal ${item.signal}`);
      assert.equal(item.status, 0, `child ${item.run} exited ${item.status}:\n${item.boundedStderr}`);
      assert.equal(item.signatures.assertion, false, `child ${item.run} emitted the native assertion:\n${item.boundedStderr}`);
      assert.equal(item.signatures.removeEnvironmentCleanupHook, false, `child ${item.run} emitted RemoveEnvironmentCleanupHook:\n${item.boundedStderr}`);
      assert.equal(item.signatures.statementDestructor, false, `child ${item.run} emitted Statement::~Statement:\n${item.boundedStderr}`);
    }
  }

  if (baselineCalibrate) {
    assertBaselineReproduced(cases);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
