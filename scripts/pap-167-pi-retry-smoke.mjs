#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// PAP-167 isolated retry/session-restart teardown harness.
// Runs the pi-node-24 registry teardown case in an isolated Pi Node 24 child so
// a native abort cannot kill the coordinator, and records child status/signal,
// bounded stderr, host ABI, addon path, registry operation, and teardown order.
// Usage: node scripts/pap-167-pi-retry-smoke.mjs [<ppa-store-output>] [--regression --runs N]

const MAX_STDERR = 2_000;
const DEFAULT_RUNS = 1;

function parseArgs(argv) {
  const positional = [];
  let regression = false;
  let runs = DEFAULT_RUNS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--regression") regression = true;
    else if (arg === "--runs") { runs = Number(argv[++index]); }
    else positional.push(arg);
  }
  return { storeArg: positional[0], regression, runs };
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

function childSource() {
  return [
    `const addon = process.env.PAP167_ADDON;`,
    `const closeOnTeardown = process.env.PAP167_CLOSE_ON_TEARDOWN === "1";`,
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
    `if (closeOnTeardown) registry.closeDb();`,
    `if (globalThis.gc) globalThis.gc();`,
    `process.stdout.write(JSON.stringify(evidence) + "\\n");`,
  ].join("\n");
}

function runCase({ piNode, storeOutput, addon, root, closeOnTeardown, run }) {
  const registryDb = join(root, `registry-${run}.db`);
  const aiUsage = join(root, `ai-usage-${run}`);
  const childPath = join(root, `pap-167-child-${run}.mjs`);
  writeFileSync(childPath, childSource());
  const env = {
    ...process.env,
    PAP167_ADDON: addon,
    PAP167_CLOSE_ON_TEARDOWN: closeOnTeardown ? "1" : "0",
    PAP167_REGISTRY_DB: registryDb,
    PAP167_AI_USAGE: aiUsage,
    PAP167_CORE_MODULE: join(storeOutput, "share", "pa-platform", "packages", "pa-core", "dist"),
  };
  const result = spawnSync(piNode, ["--expose-gc", childPath], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
  });
  const stderr = (result.stderr ?? "").trim();
  const boundedStderr = stderr.length > MAX_STDERR ? `${stderr.slice(0, MAX_STDERR - 3)}...` : stderr;
  const signatures = {
    removeEnvironmentCleanupHook: /RemoveEnvironmentCleanupHook/.test(stderr),
    statementDestructor: /Statement::~Statement\(\)/.test(stderr),
    assertion: /Assertion failed: \(env\) != nullptr/.test(stderr),
  };
  let stdout = "";
  try { stdout = JSON.parse((result.stdout ?? "").trim().split("\n").at(-1) ?? "{}"); } catch { stdout = {}; }
  return {
    run,
    command: `${piNode} --expose-gc ${childPath}`,
    closeOnTeardown,
    status: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    stdoutEvidence: stdout,
    boundedStderr,
    signatures,
  };
}

function main() {
  const { storeArg, regression, runs } = parseArgs(process.argv.slice(2));
  assert.ok(Number.isInteger(runs) && runs >= 1, "--runs must be a positive integer");
  const storeOutput = resolveStoreOutput(storeArg);
  const ppa = join(storeOutput, "bin", "ppa");
  const addon = join(storeOutput, "share", "pa-platform", "native-addons", "pi-node-24", "better_sqlite3.node");
  assert.ok(existsSync(ppa), `missing installed ppa: ${ppa}`);
  assert.ok(existsSync(addon), `missing pi-node-24 addon: ${addon}`);
  const piPath = process.env.PAP167_REAL_PI ?? "/home/sinh/.nix-profile/bin/pi";
  const piNode = resolvePiNodeHost(piPath);

  const root = mkdtempSync(join(tmpdir(), "pap-167-pi-retry-"));
  const cases = [];
  try {
    for (let run = 1; run <= runs; run += 1) {
      cases.push(runCase({ piNode, storeOutput, addon, root, closeOnTeardown: regression, run }));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const evidence = {
    mode: regression ? "regression" : "baseline",
    storeOutput,
    addon,
    piNode,
    runs,
    cases,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

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
