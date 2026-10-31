#!/usr/bin/env node
/** Exact selected-installed disposable qualification; unsigned observations,
 * never approval/readiness. No install, pin rewrite, live allocation or enablement. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { accountCases, block, CASE_ANCHORS, cleanEnvironment, committedRead, digest, discoverInstalled, exactCheckout, git, gitBytes, parseArguments, physicalFile,
  provenance, safeDiagnostic, verifyModules } from "./workflow_installed_support.mjs";
import { createHarness, runHarness } from "./workflow_installed_harness.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), scriptRoot = dirname(fileURLToPath(import.meta.url));
const ids = ["installed-identity", "installed-entry-points", "paired-handoffs", "selected-procedure", ...Object.keys(CASE_ANCHORS), "isolation-accounting"];
let cases = ids.map(id => ({ id, status: "not-run", observations: 0 })), evidenceRoot, identity, selection, modules, run, entry, sourceSha;
const passed = rows => { for (const row of rows) { const index = cases.findIndex(c => c.id === row.id); if (index < 0 || row.status !== "passed" || !Number.isSafeInteger(row.observations) || row.observations < 1) block("WORKFLOW_CASE_PROTOCOL"); cases[index] = row; } };
const output = value => { const raw = JSON.stringify(value); if (Buffer.byteLength(raw) > 1_048_576) throw new Error("qualification response exceeds bound"); process.stdout.write(raw + "\n"); };
try {
  sourceSha = parseArguments(process.argv.slice(2)); exactCheckout(root, sourceSha, "RUNTIME");
  const installed = discoverInstalled(), metadata = provenance(installed, sourceSha);
  modules = verifyModules(root, installed);
  if (JSON.parse(physicalFile(join(root, "package.json")).toString()).version !== metadata.packageVersion) block("WORKFLOW_PACKAGE_VERSION_MISMATCH");
  if (physicalFile(join(installed.share, "pnpm-lock.yaml"), 2_097_152, true).compare(physicalFile(join(root, "pnpm-lock.yaml"), 2_097_152))) block("WORKFLOW_LOCKFILE_MISMATCH");
  const platformPaths = await import(pathToFileURL(join(installed.share, "packages/pa-core/dist/paths.js")).href);
  const registry = await import(pathToFileURL(join(installed.share, "packages/pa-core/dist/templates/registry.js")).href);
  selection = registry.selectedTemplates(); exactCheckout(selection.root, metadata.configSha, "CONFIG");
  if (platformPaths.getTeamsDir() !== join(selection.root, "teams") || selection.configRevision !== metadata.configSha
    || physicalFile(join(root, ".pa-platform-config.sha"), 64).toString().trim() !== selection.configRevision
    || physicalFile(join(root, ".pa-template-registry.sha"), 80).toString().trim() !== selection.registrySha256) block("WORKFLOW_SELECTED_PAIR_MISMATCH");
  const originalResources = new Map();
  const configRead = path => { const bytes = committedRead(selection.root, selection.configRevision, path); originalResources.set(path, digest(bytes)); return bytes; };
  const manifest = JSON.parse(configRead("workflows/manifest.json")), fixtures = JSON.parse(configRead("workflows/fixtures-v1.json")), template = JSON.parse(configRead("contracts/templates-v1.json"));
  if (!manifest.bindings?.length || !manifest.definitions?.length || !fixtures.fixtures?.length) block("WORKFLOW_SELECTED_CONTENT_REQUIRED");
  for (const definition of manifest.definitions) configRead(definition.file);
  for (const fixture of fixtures.fixtures) { configRead(fixture.requirementsFile); configRead(fixture.uatFile); }
  for (const producer of template.entries) configRead(producer.source.path);
  const coreBinding = join(installed.share, `native-addons/node-${process.versions.node.split('.')[0]}/better_sqlite3.node`);
  const piBinding = join(installed.share, "native-addons/pi-node-24/better_sqlite3.node");
  identity = { ...installed, ...metadata, node: { executable: realpathSync(process.execPath), version: process.versions.node, abi: process.versions.modules },
    bindings: { core: { path: coreBinding, sha256: digest(physicalFile(coreBinding, 32 * 1024 * 1024, true)) }, pi: { path: piBinding, sha256: digest(physicalFile(piBinding, 32 * 1024 * 1024, true)) } } };
  passed([{ id: "installed-identity", status: "passed", observations: Object.keys(modules).length, sourceSha, configSha: selection.configRevision, registrySha256: selection.registrySha256 }]);
  const temporary = realpathSync(tmpdir());
  if ([root, selection.root].some(path => { const r = relative(path, temporary); return !r || (!r.startsWith("..") && !r.startsWith("/")); })) block("WORKFLOW_DISPOSABLE_ROOT_REQUIRED");
  evidenceRoot = mkdtempSync(join(temporary, "pa-workflow-installed-"));
  const directory = join(evidenceRoot, "harness"), environment = { ...cleanEnvironment(), HOME: join(evidenceRoot, "home"), PA_AI_USAGE_HOME: join(evidenceRoot, "ai"),
    PA_REGISTRY_DB: join(evidenceRoot, "ai/registry.db"), PA_PLATFORM_CONFIG: join(evidenceRoot, "config"), PA_SQLITE_NATIVE_BINDING: coreBinding,
    PA_PI_SQLITE_NATIVE_BINDING: piBinding, PA_REQUIRE_PI_SQLITE_NATIVE_BINDING: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8", TZ: "UTC" };
  for (const path of [environment.HOME, environment.PA_AI_USAGE_HOME, environment.PA_PLATFORM_CONFIG]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(environment.PA_PLATFORM_CONFIG, "config.yaml"), "repos: {}\n", { mode: 0o600 });
  for (const file of ["workflow_installed_support.mjs", "workflow_installed_harness.mjs", "workflow_installed_entries.mjs", "workflow_test_reporter.mjs", "workflow_import_register.mjs", "workflow_import_audit.mjs", "verify_json_workflow_runtime.mjs"]) committedRead(root, sourceSha, `scripts/dev/${file}`);
  const harness = await createHarness({ sourceRoot: root, sourceSha, moduleRoot: installed.share, directory });
  writeFileSync(join(evidenceRoot, "driver-identity.json"), JSON.stringify({ source: harness.observed, bridges: harness.bridges, compiler: harness.compiler }), { mode: 0o600 });
  const audit = join(evidenceRoot, "implementation-imports.jsonl"), auditFrame = join(evidenceRoot, "import-frame.json");
  writeFileSync(auditFrame, JSON.stringify({ sourceRoot: root, moduleRoot: installed.share, harness: directory, modules, bridges: harness.bridges, audit }), { mode: 0o600 });
  const register = pathToFileURL(join(scriptRoot, "workflow_import_register.mjs")); register.searchParams.set("frame", auditFrame); environment.NODE_OPTIONS = `--import=${register.href}`;
  const frame = join(evidenceRoot, "entry-frame.json"); writeFileSync(frame, JSON.stringify({ binary: installed.binary, share: installed.share, harness: directory, selection }), { mode: 0o600 });
  const entries = spawnSync(process.execPath, [join(scriptRoot, "workflow_installed_entries.mjs"), frame], { cwd: directory, env: environment, encoding: "utf8", timeout: 120000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(evidenceRoot, "public-entry-results.json"), entries.stdout ?? "", { mode: 0o600 }); writeFileSync(join(evidenceRoot, "public-entry-stderr.log"), entries.stderr ?? "", { mode: 0o600 });
  if (entries.error || entries.signal || entries.status !== 0 || entries.stderr) block("WORKFLOW_INSTALLED_ENTRY_FAILED", "installed-entry-points");
  entry = JSON.parse(entries.stdout); passed(entry.cases);
  run = runHarness({ directory, harness, env: environment, reporter: join(scriptRoot, "workflow_test_reporter.mjs"), evidenceRoot }); passed(run.cases);
  for (const [path, sha256] of Object.entries(entry.resources)) if (digest(committedRead(selection.root, selection.configRevision, path)) !== sha256) block("WORKFLOW_SELECTED_RESOURCE_DRIFT");
  for (const [path, sha256] of originalResources) if (digest(committedRead(selection.root, selection.configRevision, path)) !== sha256) block("WORKFLOW_SELECTED_RESOURCE_DRIFT");
  exactCheckout(root, sourceSha, "RUNTIME"); exactCheckout(selection.root, metadata.configSha, "CONFIG");
  if (JSON.stringify(verifyModules(root, installed)) !== JSON.stringify(modules) || discoverInstalled().physical !== installed.physical || provenance(installed, sourceSha).sha256 !== metadata.sha256) block("WORKFLOW_INSTALLED_IDENTITY_DRIFT");
  const imports = physicalFile(audit, 32 * 1024 * 1024).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  const actualModules = new Set(imports.map(row => row.path));
  for (const required of ["packages/pa-core/dist/workflows/service.js", "packages/pa-core/dist/deploy/execution-custody.js", "packages/pi-pa/dist/deploy.js", "packages/pi-pa/dist/workflow-resume.js", "packages/pi-pa/dist/workflow-source.js", "packages/pi-pa/dist/adapter.js"]) if (!actualModules.has(join(installed.share, required))) block("WORKFLOW_REQUIRED_INSTALLED_IMPORT_MISSING");
  passed([{ id: "isolation-accounting", status: "passed", observations: originalResources.size + Object.keys(entry.resources).length, sourceUnchanged: true, configUnchanged: true,
    livePolicyEnabled: false, liveResourcesAllocated: false, disposableRoot: evidenceRoot }]);
  if (cases.some(row => row.status !== "passed")) block("WORKFLOW_REQUIRED_CASE_OMITTED");
  output({ schemaVersion: "pa-workflow-installed-qualification/v1", status: "passed", unsigned: true, evidenceClass: "selected-installed-disposable-not-independent-review-or-human-UAT", runtime: identity,
    selection: { ...selection, manifestSha256: originalResources.get("workflows/manifest.json"), bindings: manifest.bindings }, moduleSha256: modules, cases, tests: run.tests,
    drivers: { pinnedSource: sourceSha, implementationRoot: installed.share, implementationsCopiedFromSource: false, sourceSha256: run.harnessSourceSha256, bridgesSha256: run.implementationBridgesSha256 },
    evidenceRoot, nativeTestEventsSha256: run.testEventsSha256, implementationImportAuditSha256: digest(physicalFile(audit, 32 * 1024 * 1024)), observedImplementationModules: actualModules.size, installed: true, installationPerformed: false, enablementPerformed: false, humanApproval: false, humanUat: false,
    limitations: [...run.limitations, "Actual independent full matrix/review, CI, real foreground operator capture/UAT and final enabled-pair adoption remain separate gates.", "Initial restart support is foreground structured direct custody; background/force/prepared continuation is not silently widened."] });
} catch (error) {
  output({ schemaVersion: "pa-workflow-installed-qualification/v1", status: "blocked", unsigned: true, ...safeDiagnostic(error), runtime: identity, selection, cases, evidenceRoot,
    sourceSha, installationPerformed: false, enablementPerformed: false, humanApproval: false, humanUat: false });
  process.exitCode = 1;
}
