#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// PAP-167 isolated retry/session-restart teardown harness.
// Runs the pi-node-24 registry teardown case in an isolated Pi Node 24 child so
// a native abort cannot kill the coordinator, and records child status/signal,
// bounded stderr, host ABI, addon path, registry operation, and teardown order.
// Usage: node scripts/pap-167-pi-retry-smoke.mjs [<ppa-store-output>] [--process-evidence|--regression] [--runs N] [--evidence <path>]

const MAX_STDERR = 2_000;
const DEFAULT_RUNS = 1;
const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;

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

function parseArgs(argv) {
  const positional = [];
  let processEvidence = false;
  let regression = false;
  let runs = DEFAULT_RUNS;
  let evidencePath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--process-evidence") processEvidence = true;
    else if (arg === "--regression") regression = true;
    else if (arg === "--runs") { runs = Number(argv[++index]); }
    else if (arg === "--evidence") { evidencePath = argv[++index]; }
    else positional.push(arg);
  }
  return { storeArg: positional[0], processEvidence, regression, runs, evidencePath };
}

function resolveStoreOutput(storeArg) {
  if (storeArg && existsSync(join(storeArg, "bin", "ppa"))) return resolve(storeArg);
  const addon = process.env.PA_PI_SQLITE_NATIVE_BINDING;
  if (addon) {
    const share = dirname(dirname(dirname(resolve(addon))));
    const store = dirname(share);
    if (existsSync(join(store, "bin", "ppa"))) return store;
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

function childSource(processEvidence) {
  return [
    `import { writeFileSync } from "node:fs";`,
    `const addon = process.env.PAP167_ADDON;`,
    `const closeOnTeardown = process.env.PAP167_CLOSE_ON_TEARDOWN === "1";`,
    `const processEvidence = ${JSON.stringify(processEvidence)};`,
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
    `registry.appendRegistryEvent({ deployment_id: "d-pap167", team: "builder", event: "started", timestamp: new Date().toISOString(), mode: "implement", runtime: "pi", binary: "ppa" });`,
    `const statuses = registry.queryDeploymentStatuses();`,
    `evidence.registryOp = { kind: "queryDeploymentStatuses", deployments: statuses.length };`,
    `evidence.teardown = closeOnTeardown ? "session_shutdown -> closeDb()" : "session_shutdown WITHOUT closeDb (baseline)";`,
    `if (processEvidence) {`,
    `  writeFileSync(process.env.PAP167_TERMINAL_PATH, JSON.stringify({ type: "agent_end", stopReason: "stop", timestamp: new Date().toISOString() }) + "\\n", { mode: 0o600 });`,
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

function runCase({ piNode, storeOutput, addon, root, closeOnTeardown, processEvidence, run, secrets }) {
  const deployDir = join(root, `run-${run}`);
  mkdirSync(deployDir, { recursive: true });
  const registryDb = join(deployDir, "registry.db");
  const aiUsage = join(deployDir, "ai-usage");
  const childPath = join(deployDir, "pap-167-child.mjs");
  const terminalPath = join(deployDir, "pi-terminal-status.json");
  writeFileSync(childPath, childSource(processEvidence));
  const env = {
    ...process.env,
    PAP167_ADDON: addon,
    PAP167_CLOSE_ON_TEARDOWN: closeOnTeardown ? "1" : "0",
    PAP167_REGISTRY_DB: registryDb,
    PAP167_AI_USAGE: aiUsage,
    PAP167_CORE_MODULE: join(storeOutput, "share", "pa-platform", "packages", "pa-core", "dist"),
    PAP167_TERMINAL_PATH: terminalPath,
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
    status: result.status,
    signal: result.signal ?? null,
    processExit,
    error,
    messageTerminal,
    persistedEvidence,
    evidenceClassification,
    stdoutEvidence: stdout,
    boundedStderr,
    diagnostics: { maxErrorCharacters: MAX_STDERR, configuredSecretLeaks },
    signatures,
  };
}

function main() {
  const { storeArg, processEvidence, regression, runs, evidencePath } = parseArgs(process.argv.slice(2));
  assert.ok(Number.isInteger(runs) && runs >= 1, "--runs must be a positive integer");
  assert.equal(processEvidence && regression, false, "--process-evidence and --regression are mutually exclusive");
  assert.ok(evidencePath === undefined || evidencePath.length > 0, "--evidence requires a path");
  const storeOutput = resolveStoreOutput(storeArg);
  const ppa = join(storeOutput, "bin", "ppa");
  const addon = join(storeOutput, "share", "pa-platform", "native-addons", "pi-node-24", "better_sqlite3.node");
  assert.ok(existsSync(ppa), `missing installed ppa: ${ppa}`);
  assert.ok(existsSync(addon), `missing pi-node-24 addon: ${addon}`);
  const piPath = process.env.PAP167_REAL_PI ?? "/home/sinh/.nix-profile/bin/pi";
  const piNode = resolvePiNodeHost(piPath);

  const root = mkdtempSync(join(tmpdir(), "pap-167-pi-retry-"));
  const cases = [];
  const secrets = configuredSecrets(process.env);
  try {
    for (let run = 1; run <= runs; run += 1) {
      cases.push(runCase({ piNode, storeOutput, addon, root, closeOnTeardown: regression, processEvidence, run, secrets }));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const evidence = {
    mode: regression ? "regression" : processEvidence ? "process-evidence" : "baseline",
    ...(processEvidence ? {
      fixture: {
        kind: "approved-signature-replay",
        purpose: "verify message-level stop does not mask a later process-level abort",
        productionSources: ["d-779f18", "d-5cbc2b"],
      },
    } : {}),
    storeOutput,
    addon,
    piNode,
    runs,
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
    }
  }
}

main();
