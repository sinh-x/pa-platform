#!/usr/bin/env node
/** PAP-282 implemented-slice verifier. Does not install, activate a profile,
 * consume live ticket state, or turn a byte comparison into commit provenance. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { block, cleanEnvironment, committedRead, digest, discoverInstalled, git, physicalFile, provenance, QualificationBlocked, verifyBuildPins, verifyModules } from "./workflow_installed_support.mjs";
import { createHarness, runHarness } from "./workflow_installed_harness.mjs";

const core = "packages/pa-core/src/__tests__/", pi = "packages/pi-pa/src/__tests__/";
// Mandatory exact names and owners, not caller-provided passed flags or counts.
export const INTERACTION_CASES = Object.freeze([
  ["strict-discovery", core + "interactions-contract.test.ts", "raw input rejects duplicate decoded keys, invalid Unicode, BOM and excessive nesting"],
  ["discovery-schema", core + "interactions-contract.test.ts", "published JSON schema and parser agree on discriminator, fields, limits and enums"],
  ["complete-source-view", core + "interactions-discovery.test.ts", "source discovery traverses all records without omission, duplicates or availability promotion"],
  ["cursor-isolation", core + "interactions-discovery.test.ts", "cursors are issuer/view/query-bound, reject tampering, and allow unchanged read replay"],
  ["bounded-output", core + "interactions-discovery.test.ts", "byte-bound pages continue before omission and cannot return an oversized single record"],
  ["finite-intake-schema", core + "interactions-ticket.test.ts", "strict raw intake contract shares published fields and rejects authority, duplicates, Unicode and oversized inputs"],
  ["exact-project-creation", core + "interactions-ticket.test.ts", "bound companion uses exact registered project, defaults, derived actor and original owner recovery without reassociation"],
  ["required-metadata", core + "interactions-ticket.test.ts", "ordinary intake retains required metadata and CLI sanitization with bounded nonsecret warnings"],
  ["read-only-reuse", core + "interactions-ticket.test.ts", "exact aligned reuse is a read-only caller-bound snapshot, not a claim or reassociation"],
  ["planning-negative-controls", core + "interactions-ticket.test.ts", "planning rejects forged fields, caller/version/project and retained owners before intent or ticket effects"],
  ["planning-response-loss", core + "interactions-ticket.test.ts", "native planning response loss reconciles original caller-bound versions at each owner boundary"],
  ["creation-interruption", core + "ticket-create-intent.test.ts", "intent is durable before counter/ticket/audit effects and reservation survives interruption"],
  ["creation-contention", core + "ticket-create-intent.test.ts", "concurrent owner processes share reservation and audit identity"],
  ["unsafe-lock-aliases", core + "ticket-create-intent.test.ts", "ticket transaction mutex rejects symlink and hardlink aliases before chmod or ticket effects"],
  ["planning-interruption", core + "ticket-planning-intent.test.ts", "interrupted intent/ticket/audit stages recover original request with one update and no duplicates"],
  ["planning-contention", core + "ticket-planning-intent.test.ts", "real concurrent owners reconcile same intent and accept at most one competing CAS"],
  ["native-discovery", pi + "interactions-discovery-native.test.ts", "native source discovery preserves bounded continuation and never advertises installed support"],
  ["native-reauthentication", pi + "interactions-discovery-native.test.ts", "new port requires its current native owner check on every call and fails closed"],
  ["retained-profile-selection", pi + "interactions-ticket-native.test.ts", "new opt-in config/version selection does not select retained profiles"],
  ["composed-native-journey", pi + "interactions-ticket-native.test.ts", "default non-editor composition registers finite intake only for fresh authenticated v4; real owner, synthetic host, not live UAT"],
  ["launcher-journey", pi + "interactions-ticket-native.test.ts", "source launcher selects v4 before default native registration and one bound companion; simulated provider, no installed qualification"],
  ["unbound-intake-denial", pi + "interactions-ticket-native.test.ts", "unbound intake framing fails closed without native owner or raw error disclosure"],
].map(Object.freeze));
export const INTERACTION_TEST_FILES = Object.freeze([...new Set(INTERACTION_CASES.map(([, owner]) => owner))]);
export function accountInteractionCases(events, harnessRoot) {
  if (!Array.isArray(events) || !events.length || !isAbsolute(harnessRoot ?? "")) block("INTERACTIONS_NATIVE_EVENTS_REQUIRED", "case-accounting");
  if (events.some(e => e.type === "test:fail" || (e.type === "test:pass" && (e.data.skip || e.data.todo)))) block("INTERACTIONS_CASE_FAILED_OR_SKIPPED", "case-accounting");
  const passed = events.filter(e => e.type === "test:pass");
  const cases = INTERACTION_CASES.map(([id, owner, name]) => {
    const matches = passed.filter(e => e.data.name === name);
    if (matches.length !== 1 || matches[0].data.file !== join(harnessRoot, owner.replace(/\.ts$/, ".js"))) block("INTERACTIONS_CASE_OWNER_OR_INVENTORY", id);
    return { id, status: "passed", observations: 1, owner, name };
  });
  const summary = events.filter(e => e.type === "test:summary" && e.data.file === undefined).at(-1)?.data;
  if (!summary?.success || summary.counts?.failed || summary.counts?.cancelled || summary.counts?.skipped || summary.counts?.todo
    || summary.counts?.passed !== passed.filter(e => e.data.details?.type !== "suite").length) block("INTERACTIONS_NATIVE_SUMMARY_REQUIRED", "case-accounting");
  return { cases, tests: summary.counts, testEventsSha256: digest(Buffer.from(JSON.stringify(events))) };
}
export function parseInteractionArguments(args) {
  if (args.length !== 3 || args[0] !== "--selected-installed" || !["--require-candidate", "--compare-worktree"].includes(args[1]) || !/^[a-f0-9]{40}$/.test(args[2] ?? "")) block("INTERACTIONS_ARGUMENTS", "arguments");
  return { sourceSha: args[2], comparison: args[1] === "--compare-worktree" };
}
export function interactionProvenance(installed, sourceSha, comparison) {
  try { return { metadata: provenance(installed, sourceSha), exactCandidateProvenance: true }; }
  catch (error) {
    if (!comparison || error.code !== "WORKFLOW_INSTALLED_CANDIDATE_MISMATCH") throw error;
    // ONLY the literal native build marker is accepted in comparison mode.
    // Different commits, malformed metadata and duplicate keys still reject.
    return { metadata: provenance(installed, "unversioned-dirty-source"), exactCandidateProvenance: false };
  }
}
const tooling = ["verify_interactions_runtime.mjs", "workflow_installed_support.mjs", "workflow_installed_harness.mjs", "workflow_import_register.mjs", "workflow_import_audit.mjs", "workflow_test_reporter.mjs"];
const runtimePaths = ["packages", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "flake.nix", "flake.lock", ".pa-platform-config.sha", ".pa-template-registry.sha"];
export function unchangedInteractionRuntime(root, sourceSha) {
  const paths = [...runtimePaths, ":(exclude)packages/pa-core/src/interactions/README.md"];
  if (git(root, "rev-parse", "--show-toplevel") !== root || git(root, "merge-base", sourceSha, "HEAD") !== sourceSha
    || git(root, "diff", sourceSha, "--", ...paths)
    || git(root, "status", "--porcelain=v2", "--untracked-files=all", "--", ...paths)) block("INTERACTIONS_RUNTIME_SOURCE_CHANGED", "identity");
  for (const path of runtimePaths.filter(path => path !== "packages")) committedRead(root, sourceSha, path);
}
const initialCases = () => [...["installed-byte-identity", "public-version"].map(id => ({ id, status: "not-run" })), ...INTERACTION_CASES.map(([id]) => ({ id, status: "not-run" }))];
export async function qualifyInteractions(args, progress = { cases: initialCases() }) {
  const { sourceSha, comparison } = parseInteractionArguments(args), root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  progress.sourceSha = sourceSha;
  unchangedInteractionRuntime(root, sourceSha);
  const toolHashes = Object.fromEntries(tooling.map(path => [path, digest(physicalFile(join(root, "scripts/dev", path), 2_097_152))]));
  const installed = discoverInstalled();
  const { metadata, exactCandidateProvenance } = interactionProvenance(installed, sourceSha, comparison);
  const modules = verifyModules(root, installed), pins = verifyBuildPins(root, installed, metadata);
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) if (physicalFile(join(root, path), 2_097_152).compare(physicalFile(join(installed.share, path), 2_097_152, true))) block("INTERACTIONS_BUILD_INPUT_MISMATCH", "identity");
  const observe = (id, status) => { const row = progress.cases.find(row => row.id === id); if (!row) block("INTERACTIONS_CASE_INVENTORY"); row.status = status; };
  observe("installed-byte-identity", "passed");
  const version = spawnSync(installed.binary, ["--version"], { env: cleanEnvironment(), encoding: "utf8", timeout: 15000, maxBuffer: 65536 });
  if (version.error || version.signal || version.status !== 0 || version.stderr || version.stdout !== `ppa ${metadata.packageVersion}\n`) block("INTERACTIONS_PUBLIC_VERSION", "public-cli");
  observe("public-version", "passed");
  const temporary = tmpdir();
  const r = relative(root, temporary); if (!r || (!r.startsWith("..") && !isAbsolute(r))) block("INTERACTIONS_EXTERNAL_DISPOSABLE_ROOT_REQUIRED");
  const evidenceRoot = mkdtempSync(join(temporary, "pa-interactions-installed-")), directory = join(evidenceRoot, "harness"); progress.evidenceRoot = evidenceRoot;
  const binding = join(installed.share, `native-addons/node-${process.versions.node.split(".")[0]}/better_sqlite3.node`);
  const piBinding = join(installed.share, "native-addons/pi-node-24/better_sqlite3.node");
  const bindings = Object.fromEntries([binding, piBinding].map(path => [path, digest(physicalFile(path, 32 * 1024 * 1024, true))]));
  const environment = { ...cleanEnvironment(), HOME: join(evidenceRoot, "home"), TMPDIR: join(evidenceRoot, "tmp"), PA_AI_USAGE_HOME: join(evidenceRoot, "usage"), PA_PLATFORM_CONFIG: join(evidenceRoot, "config"),
    PA_REGISTRY_DB: join(evidenceRoot, "registry.db"), PA_SQLITE_NATIVE_BINDING: binding, PA_PI_SQLITE_NATIVE_BINDING: piBinding, PA_REQUIRE_PI_SQLITE_NATIVE_BINDING: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8", TZ: "UTC", NO_COLOR: "1" };
  for (const path of [environment.HOME, environment.TMPDIR, environment.PA_AI_USAGE_HOME, environment.PA_PLATFORM_CONFIG]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(environment.PA_PLATFORM_CONFIG, "config.yaml"), "repos: {}\n", { mode: 0o600 });
  const harness = await createHarness({ sourceRoot: root, sourceSha, moduleRoot: installed.share, directory, requiredTestFiles: INTERACTION_TEST_FILES });
  const audit = join(evidenceRoot, "imports.jsonl"), frame = join(evidenceRoot, "import-frame.json");
  writeFileSync(frame, JSON.stringify({ sourceRoot: root, moduleRoot: installed.share, harness: directory, modules, bridges: harness.bridges, audit }), { mode: 0o600 });
  const loader = new URL("./workflow_import_register.mjs", import.meta.url); loader.searchParams.set("frame", frame); environment.NODE_OPTIONS = `--import=${loader.href}`;
  for (const [id] of INTERACTION_CASES) observe(id, "unknown");
  const run = runHarness({ directory, harness, env: environment, reporter: fileURLToPath(new URL("./workflow_test_reporter.mjs", import.meta.url)), evidenceRoot, account: accountInteractionCases });
  for (const row of run.cases) observe(row.id, row.status);
  const imports = physicalFile(audit, 32 * 1024 * 1024).toString("utf8").trim().split("\n").map(line => JSON.parse(line)), seen = new Set(imports.map(row => row.path));
  for (const path of ["pa-core/dist/interactions/discovery.js", "pa-core/dist/interactions/tickets.js", "pa-core/dist/tickets/create-intent.js", "pa-core/dist/tickets/planning-intent.js", "pi-pa/dist/pi-extension/capability-tool.js", "pi-pa/dist/pi-extension/ticket-intake-tool.js", "pi-pa/dist/pi-extension/document-tool.js", "pi-pa/dist/deploy.js"]) if (!seen.has(join(installed.share, "packages", path))) block("INTERACTIONS_INSTALLED_IMPORT_MISSING", "imports");
  unchangedInteractionRuntime(root, sourceSha);
  if (JSON.stringify(verifyModules(root, installed)) !== JSON.stringify(modules) || discoverInstalled().physical !== installed.physical
    || provenance(installed, metadata.sourceSha).sha256 !== metadata.sha256 || JSON.stringify(verifyBuildPins(root, installed, metadata)) !== JSON.stringify(pins)
    || tooling.some(path => digest(physicalFile(join(root, "scripts/dev", path), 2_097_152)) !== toolHashes[path])) block("INTERACTIONS_IDENTITY_DRIFT", "identity");
  return { schemaVersion: "pa-interactions-installed-observations/v1", status: "passed", unsigned: true,
    evidenceClass: "implemented-slice-installed-disposable-not-full-PAP-282-qualification", sourceSha, exactCandidateProvenance,
    identityMode: exactCandidateProvenance ? "commit-provenance-and-byte-parity" : "worktree-byte-parity-unversioned-install",
    installed: { ...installed, metadata, moduleCount: Object.keys(modules).length, moduleInventorySha256: digest(Buffer.from(JSON.stringify(modules))), bindings }, buildPins: pins,
    toolingSha256: toolHashes, cases: progress.cases, tests: run.tests, harnessSourceSha256: run.harnessSourceSha256,
    importAuditSha256: digest(physicalFile(audit, 32 * 1024 * 1024)), evidenceRoot,
    installationPerformed: false, enablementPerformed: false, humanUat: false, fullTicketAcceptance: false,
    limitations: [
      ...(exactCandidateProvenance ? [] : ["The installed sourceSha is unversioned-dirty-source. Matching rebuilt module bytes are observed, not native commit provenance or proof of reproducible build inputs."]),
      "Only implemented discovery/intake/reuse/scalar-planning slices are exercised; remaining operation families and the external-read amendment are not qualified.",
      "Native admission, session, UI, launcher/provider and configuration seams use disposable fixtures; no actual foreground agent, live selected-profile adoption or human approval/UAT is claimed.",
      "Independent review, hosted CI, complete CLI/native semantic parity and umbrella acceptance remain separate obligations.",
    ] };
}
export function publicInteractionError(error) {
  const fallback = { code: "INTERACTIONS_REQUIRED_EVIDENCE_UNAVAILABLE", gate: "qualification" };
  try {
    if (!(error instanceof QualificationBlocked)) return fallback;
    const fields = Object.getOwnPropertyDescriptors(error);
    const code = fields.code?.value, gate = fields.gate?.value;
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,95}$/.test(code) || typeof gate !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(gate)) return fallback;
    return { code, gate };
  } catch { return fallback; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const progress = { cases: initialCases() };
  try {
    const raw = JSON.stringify(await qualifyInteractions(process.argv.slice(2), progress));
    if (Buffer.byteLength(raw) > 51200) block("INTERACTIONS_REPORT_LIMIT", "report");
    console.log(raw);
  }
  catch (error) {
    console.log(JSON.stringify({ schemaVersion: "pa-interactions-installed-observations/v1", status: "blocked", unsigned: true, ...publicInteractionError(error),
      ...progress, installationPerformed: false, enablementPerformed: false, humanUat: false, fullTicketAcceptance: false,
      diagnostic: "Installed interaction verification could not complete.\nCondition: A required identity or implemented-slice observation is unavailable.\nSource: Installed interaction verifier.\nReason: The required candidate, byte comparison or mandatory case could not be established; unknown cases are not passes.\nCorrection: Ask the runtime maintainer to inspect the reported gate and retained evidence. Impact: none. Actor: agent. New approval: not required to ask. Prerequisite: preserve the installed selection and evidence; repairs need their own authority.\nResume Action: Repeat observation after the missing prerequisite is reconciled. Do not install, activate a profile, skip cases or import passed flags to bypass the gate." }));
    process.exitCode = 1;
  }
}
