#!/usr/bin/env node
/** Exact installed disposable qualification. No install, launch/provider, source
 * fallback, user approval import, pin rewrite or live resource reconciliation. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { block, cleanEnvironment, committedRead, digest, discoverInstalled, exactCheckout, git, parseArguments, physicalFile, provenance, verifyBuildPins, verifyModules } from "./workflow_installed_support.mjs";
import { createHarness, runHarness } from "./workflow_installed_harness.mjs";

const core = "packages/pa-core/src/__tests__/", pi = "packages/pi-pa/src/__tests__/", opa = "packages/opencode-pa/src/__tests__/";
export const ADVISORY_CASES = Object.freeze([
  ["result-contract", core + "advisory-operation-result.test.ts", "orthogonal completion/outcome/capability/enforcement and approved CLI/native mappings"],
  ["bounded-output", core + "advisory-operation-result.test.ts", "UTF-8, text/line/JSON bounds and owner reference preserve complete valid envelopes"],
  ["unforgeable-pass", core + "advisory-operation-result.test.ts", "incomplete, denied, unavailable, child-failed, stale or unproven observations cannot pass"],
  ["new-run-integrity", core + "advisory-runtime-integrity.test.ts", "native new-run owner: fail, inspect, atomic edit, rerun and local commit without setup/catalogue/plan"],
  ["contention", core + "advisory-runtime-integrity.test.ts", "32 real processes reserve the SAME existing lease operation: one winner,31 conflicts; uncertainty keeps custody,not reads"],
  ["protected-paths", core + "advisory-runtime-integrity.test.ts", "native path boundary refuses traversal,protected metadata,symlinks and hardlink aliases before mutation"],
  ["retained-dispatch", core + "advisory-runtime-integrity.test.ts", "unmarked,pinned,resumed,ambiguous,rogue or spoofed projections never upgrade retained start bytes"],
  ["pi-tools", pi + "advisory-runtime.test.ts", "actual Pi operation tool: failed check then safe diagnosis and recheck, no plan/catalogue/order"],
  ["optional-isolation", pi + "advisory-runtime.test.ts", "missing optional host/config is local unavailable; discovery and subsequent tool calls remain callable"],
  ["opa-cli", opa + "advisory-runtime.test.ts", "actual OPA/PPA CLI dispatch shares neutral executor and result exits without native-parity claims"],
  ["opa-hooks", opa + "advisory-runtime.test.ts", "generated OpenCode hooks delegate shell to the shared public owner and keep protected denials local"],
  ["default-launch-sdk", pi + "ordinary-local-development.test.ts", "PAP-268 actual ordinary launch: advisory intended baseline (simulated provider/Treehouse)"],
  ["retained-launch", pi + "ordinary-local-development.test.ts", "PAP-268 actual ordinary launch: project-commands intended baseline (simulated provider/Treehouse)"],
  ["interrupted-result", pi + "advisory-runtime.test.ts", "interrupted native publication retains the exact begun operation ID and evidence, never a fresh failed-attempt identity"],
  ["capacity", core + "treehouse-ticket-concurrency.test.ts", "ticket slots reject duplicate and fifth live tickets in one repository transaction"],
  ["retained-custody", core + "execution-custody.test.ts", "observational execution replay retains unknown operations/bounds without locks, live probes, reaffirm or initialization"],
  ["timeout-cleanup", pi + "native-execution-evidence.test.ts", "native timeout kills the recorded session/group, not a freshly sampled unrelated PID"],
  ["cancel-cleanup", pi + "native-execution-evidence.test.ts", "native abort is retained separately from timeout and never converted to success"],
  ["unsettled-process", pi + "native-execution-evidence.test.ts", "remaining background group members make the result unproven even after leader exit zero"],
  ["output-limit", pi + "native-execution-evidence.test.ts", "bounded output retains exact captured prefix and a distinct limit flag, never a passing check"],
]);
export function accountAdvisoryCases(events, harnessRoot) {
  if (!Array.isArray(events) || !events.length || !isAbsolute(harnessRoot ?? "")) block("ADVISORY_NATIVE_EVENTS_REQUIRED");
  if (events.some(e => e.type === "test:fail" || (e.type === "test:pass" && (e.data.skip || e.data.todo)))) block("ADVISORY_CASE_FAILED_OR_SKIPPED");
  const passed = events.filter(e => e.type === "test:pass");
  const cases = ADVISORY_CASES.map(([id, owner, name]) => {
    const matches = passed.filter(e => e.data.name === name);
    if (matches.length !== 1 || matches[0].data.file !== join(harnessRoot, owner.replace(/\.ts$/, ".js"))) block("ADVISORY_CASE_OWNER_OR_INVENTORY", id);
    return { id, status: "passed", observations: 1, owner, name };
  });
  const summary = events.filter(e => e.type === "test:summary" && e.data.file === undefined).at(-1)?.data;
  if (!summary?.success || summary.counts?.failed || summary.counts?.cancelled || summary.counts?.skipped || summary.counts?.todo
    || summary.counts?.passed !== passed.filter(e => e.data.details?.type !== "suite").length) block("ADVISORY_NATIVE_SUMMARY_REQUIRED");
  return { cases, tests: summary.counts, testEventsSha256: digest(Buffer.from(JSON.stringify(events))) };
}
export function validatePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "owner,resultContract,runtimeContract,schemaVersion,sources"
    || value.schemaVersion !== "pa-advisory-policy/v1" || value.owner !== "PAPC-074" || value.runtimeContract !== "pa-advisory-runtime/v1" || value.resultContract !== "pa-operation-result/v1"
    || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 64 || new Set(value.sources).size !== value.sources.length
    || value.sources.some(path => typeof path !== "string" || !/^(?:teams|skills)\/[A-Za-z0-9._/-]+\.(?:md|yaml)$/.test(path) || path.split("/").some(p => !p || p === "." || p === ".."))) block("ADVISORY_PAIRED_POLICY_REQUIRED", "paired-policy");
  return value;
}
let progress;
const initialCases = () => [...["installed-identity", "paired-policy", "public-cli-new-and-retained"].map(id => ({ id, status: "not-run" })), ...ADVISORY_CASES.map(([id]) => ({ id, status: "not-run" }))];
function observed(id, status) { const entry = progress.cases.find(row => row.id === id); if (!entry) block("ADVISORY_CASE_INVENTORY"); entry.status = status; }
export async function qualify(args) {
  progress = { cases: initialCases() };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), sourceSha = parseArguments(args);
  progress.sourceSha = sourceSha;
  exactCheckout(root, sourceSha, "RUNTIME");
  for (const file of ["verify_advisory_runtime.mjs", "advisory_installed_entries.mjs", "workflow_installed_support.mjs", "workflow_installed_harness.mjs", "workflow_test_reporter.mjs", "workflow_import_register.mjs", "workflow_import_audit.mjs"]) committedRead(root, sourceSha, `scripts/dev/${file}`);
  const installed = discoverInstalled(), opencode = discoverInstalled(undefined, "opa"), metadata = provenance(installed, sourceSha);
  if (installed.packageRoot !== opencode.packageRoot) block("ADVISORY_ADAPTER_PACKAGE_MISMATCH");
  const modules = verifyModules(root, installed), pins = verifyBuildPins(root, installed, metadata);
  if (physicalFile(join(root, "pnpm-lock.yaml"), 2_097_152).compare(physicalFile(join(installed.share, "pnpm-lock.yaml"), 2_097_152, true))) block("ADVISORY_LOCKFILE_MISMATCH");
  if (JSON.parse(physicalFile(join(root, "package.json")).toString()).version !== metadata.packageVersion) block("ADVISORY_PACKAGE_VERSION_MISMATCH");
  for (const name of ["pi-pa", "opencode-pa"])  if (realpathSync(join(installed.share, `packages/${name}/node_modules/@pa-platform/pa-core`)) !== join(installed.share, "packages/pa-core")) block("ADVISORY_DEPENDENCY_SUBSTITUTION");
  observed("installed-identity", "passed");
  const installedCore = await import(pathToFileURL(join(installed.share, "packages/pa-core/dist/index.js")).href);
  const selection = installedCore.selectedTemplates(); exactCheckout(selection.root, pins.configSha, "CONFIG");
  if (selection.registrySha256 !== pins.registrySha256 || selection.configRevision !== metadata.configSha || installedCore.getTeamsDir() !== join(selection.root, "teams")) block("ADVISORY_SELECTED_PAIR_MISMATCH");
  const policyRaw = committedRead(selection.root, selection.configRevision, "contracts/advisory-runtime-v1.json");
  const policy = validatePolicy(installedCore.parseReviewEvidenceJson(policyRaw, "advisory-policy"));
  const resources = Object.fromEntries(policy.sources.map(path => [path, digest(committedRead(selection.root, selection.configRevision, path))]));
  observed("paired-policy", "passed");
  const temporary = realpathSync(tmpdir());
  if ([root, selection.root].some(path => { const r = relative(path, temporary); return !r || (!r.startsWith("..") && !isAbsolute(r)); })) block("ADVISORY_EXTERNAL_DISPOSABLE_ROOT_REQUIRED");
  const evidenceRoot = mkdtempSync(join(temporary, "pa-advisory-installed-")), directory = join(evidenceRoot, "harness");
  progress.evidenceRoot = evidenceRoot;
  const binding = join(installed.share, `native-addons/node-${process.versions.node.split(".")[0]}/better_sqlite3.node`);
  const piBinding = join(installed.share, "native-addons/pi-node-24/better_sqlite3.node");
  const bindingSha256 = digest(physicalFile(binding, 32 * 1024 * 1024, true)); physicalFile(piBinding, 32 * 1024 * 1024, true);
  const environment = { ...cleanEnvironment(), HOME: join(evidenceRoot, "home"), PA_AI_USAGE_HOME: join(evidenceRoot, "usage"), PA_PLATFORM_CONFIG: join(evidenceRoot, "config"),
    PA_REGISTRY_DB: join(evidenceRoot, "registry.db"), PA_SQLITE_NATIVE_BINDING: binding, PA_PI_SQLITE_NATIVE_BINDING: piBinding, PA_REQUIRE_PI_SQLITE_NATIVE_BINDING: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8", TZ: "UTC" };
  for (const path of [environment.HOME, environment.PA_AI_USAGE_HOME, environment.PA_PLATFORM_CONFIG]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(environment.PA_PLATFORM_CONFIG, "config.yaml"), "repos: {}\n", { mode: 0o600 });
  const requiredTestFiles = [...new Set(ADVISORY_CASES.map(([, path]) => path))];
  const harness = await createHarness({ sourceRoot: root, sourceSha, moduleRoot: installed.share, directory, requiredTestFiles, packageNames: ["pa-core", "pi-pa", "opencode-pa"] });
  const audit = join(evidenceRoot, "imports.jsonl"), frame = join(evidenceRoot, "import-frame.json");
  writeFileSync(frame, JSON.stringify({ sourceRoot: root, moduleRoot: installed.share, harness: directory, modules, bridges: harness.bridges, audit }), { mode: 0o600 });
  const loader = new URL("./workflow_import_register.mjs", import.meta.url); loader.searchParams.set("frame", frame); environment.NODE_OPTIONS = `--import=${loader.href}`;
  for (const [id] of ADVISORY_CASES) observed(id, "unknown");
  const run = runHarness({ directory, harness, env: environment, reporter: fileURLToPath(new URL("./workflow_test_reporter.mjs", import.meta.url)), evidenceRoot, account: accountAdvisoryCases });
  for (const row of run.cases) observed(row.id, row.status);
  const entryFrame = join(evidenceRoot, "entry-frame.json");
  writeFileSync(entryFrame, JSON.stringify({ share: installed.share, ppa: installed.binary, opa: opencode.binary, evidenceRoot }), { mode: 0o600 });
  observed("public-cli-new-and-retained", "unknown");
  const entry = spawnSync(process.execPath, [fileURLToPath(new URL("./advisory_installed_entries.mjs", import.meta.url)), entryFrame], { cwd: directory, env: environment, encoding: "utf8", timeout: 120000, maxBuffer: 1_048_576 });
  writeFileSync(join(evidenceRoot, "public-cli.json"), entry.stdout ?? "", { mode: 0o600 }); writeFileSync(join(evidenceRoot, "public-cli.stderr"), entry.stderr ?? "", { mode: 0o600 });
  if (entry.error || entry.signal || entry.status !== 0 || entry.stderr) block("ADVISORY_PUBLIC_ENTRY_FAILED");
  const publicEntries = JSON.parse(entry.stdout); if (publicEntries.schemaVersion !== "pa-advisory-public-observations/v1" || publicEntries.observations !== 16) block("ADVISORY_PUBLIC_ENTRY_INVENTORY");
  observed("public-cli-new-and-retained", "passed");
  exactCheckout(root, sourceSha, "RUNTIME"); exactCheckout(selection.root, selection.configRevision, "CONFIG");
  for (const [path, sha] of Object.entries(resources)) if (digest(committedRead(selection.root, selection.configRevision, path)) !== sha) block("ADVISORY_POLICY_DRIFT");
  if (digest(committedRead(selection.root, selection.configRevision, "contracts/advisory-runtime-v1.json")) !== digest(policyRaw)
    || JSON.stringify(verifyModules(root, installed)) !== JSON.stringify(modules) || provenance(discoverInstalled(), sourceSha).sha256 !== metadata.sha256
    || discoverInstalled(undefined, "opa").physical !== opencode.physical) block("ADVISORY_IDENTITY_DRIFT");
  const imports = physicalFile(audit, 32 * 1024 * 1024).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  const seen = new Set(imports.map(row => row.path));
  for (const file of ["pa-core/dist/operations/service.js", "pa-core/dist/operations/host.js", "pa-core/dist/deploy/repository-admission.js", "pi-pa/dist/pi-extension/advisory.js", "opencode-pa/dist/plugins/pa-safety-activity.js"]) if (!seen.has(join(installed.share, "packages", file))) block("ADVISORY_INSTALLED_IMPORT_MISSING");
  return { schemaVersion: "pa-advisory-installed-qualification/v1", status: "passed", unsigned: true, evidenceClass: "selected-installed-disposable-not-foreground-independent-review-CI-human-UAT-or-rollout",
    sourceSha, installed: { ...installed, opa: opencode.physical, provenanceSha256: metadata.sha256, moduleInventorySha256: digest(Buffer.from(JSON.stringify(modules))), bindingSha256 },
    config: { root: selection.root, sha: selection.configRevision, policySha256: digest(policyRaw), resources }, cases: progress.cases, nativeCases: run.cases, tests: run.tests, publicEntries,
    evidenceRoot, importAuditSha256: digest(physicalFile(audit, 32 * 1024 * 1024)), installationPerformed: false, enablementPerformed: false, humanUat: false,
    limitations: ["Native admission/provider and Treehouse seams are labelled disposable fixtures, not actual foreground agent behavior or human decisions.", "Retained drivers exercise historical rules without migrating live state.", "Independent full matrix, hosted CI, real foreground transcript and Sinh UAT/adoption remain separate obligations."] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await qualify(process.argv.slice(2)); const raw = JSON.stringify(result); if (Buffer.byteLength(raw) > 50 * 1024) block("ADVISORY_REPORT_SIZE"); console.log(raw); }
  catch (error) {
    console.log(JSON.stringify({ schemaVersion: "pa-advisory-installed-qualification/v1", status: "blocked", unsigned: true, code: error.code ?? "ADVISORY_REQUIRED_EVIDENCE_UNAVAILABLE", gate: error.gate ?? "qualification",
      cases: progress?.cases ?? initialCases(), sourceSha: progress?.sourceSha, evidenceRoot: progress?.evidenceRoot, installationPerformed: false, enablementPerformed: false, humanUat: false,
      diagnostic: "Exact clean candidate, matched selected installed PPA/OPA closure and compatible pinned PAPC-074 policy are required. Correct this qualification prerequisite; do not install, fall back to source, import passed flags or alter retained state." }));
    process.exitCode = 1;
  }
}
