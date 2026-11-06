#!/usr/bin/env node
/** PAP-283 installed-only disposable qualification. No source/receipt/skip
 * override, installation, configuration activation or human acceptance. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { block, cleanEnvironment, committedRead, digest, discoverInstalled, exactCheckout, git, parseArguments, physicalFile, provenance, verifyBuildPins, verifyModules } from "./workflow_installed_support.mjs";
import { createHarness, runHarness } from "./workflow_installed_harness.mjs";

const c = file => `packages/pa-core/src/__tests__/${file}.test.ts`;
const p = file => `packages/pi-pa/src/__tests__/${file}.test.ts`;
// Canonical case names AND owning files. Historical advisory/workflow results
// never substitute for this separate document-package inventory.
export const DOCUMENT_CASES = Object.freeze([
  ["extensible-contract", c("document-package"), "document package has independent extensible semantics without branch, workflow or matrix"],
  ["contract-negatives", c("document-package"), "document contract rejects forged authority, unsafe identities, incomplete and aliased member sets"],
  ["raw-input-negatives", c("document-package"), "document raw request rejects duplicate keys and caller evidence"],
  ["complete-package-and-queue", c("document-service"), "full five-member native-owned publication precedes primary and queue; replay is an observation"],
  ...["cancelled", "rejected", "changes-requested"].map(outcome => [`nonapproval-${outcome}`, c("document-service"), `native ${outcome} produces no affirmative effect`]),
  ["stale-consent", c("document-service"), "changed mockup during consent rejects persistence; stale revisions and foreign grants fail locally"],
  ["immutable-successor", c("document-service"), "immutable successor snapshots compare meaningful text and never inherit old approval"],
  ["failed-check-isolation", c("document-service"), "failed structural findings remain facts and do not disable independent drafting"],
  ...["symlink", "hardlink", "active-media", "unsafe-markup"].map(kind => [`source-${kind}`, c("document-service"), `snapshot rejects ${kind} without bytes or authority`]),
  ["partial-publication", c("document-service"), "partial ticket ref interruption resumes the same intent, preserves failure and never promotes early"],
  ["retained-effect-isolation", c("document-service"), "retained effect conflicts block protected calls but not a separate unsigned snapshot"],
  ["ticket-first", c("document-service"), "ticket-first intake is idempotent under the existing owner without workflow approval"],
  ...["bytes", "membership", "effects"].map(kind => [`changed-${kind}`, c("document-integrity"), `changed approved ${kind} cannot consume the old decision`]),
  ["no-approval-resurrection", c("document-integrity"), "late rejection or revocation cannot revive an older approval of the same immutable subject"],
  ["unknown-lineage-exclusion", c("document-integrity"), "conflicting publication is retained and excludes a second lineage while independent snapshots remain possible"],
  ["predecessor-integrity", c("document-integrity"), "successor promotion retains exact historical refs and requires every supporting member"],
  ...["implementing", "review-uat", "done"].map(status => [`no-downgrade-${status}`, c("document-integrity"), `queue never downgrades ${status} and preserves the intent`]),
  ["revoked-observational-settlement", c("document-integrity"), "completed effect with lost reply settles after revocation without performing a new write"],
  ["full-immutable-text", c("document-integrity"), "full immutable Markdown is paged without losing reviewed tail bytes"],
  ["real-publication-contention", c("document-process"), "real competing publication processes have one CAS winner and one complete member/ref set"],
  ...[1, 3, 6].map(boundary => [`process-death-${boundary}`, c("document-process"), `process death after publication ticket boundary ${boundary} reconciles without duplicate files or refs`]),
  ["lost-queue-reply", c("document-process"), "lost queue reply is settled by fresh process without a duplicate status/assignment audit"],
  ["native-presentation", p("document-native"), "native document capture presents brief/full membership/finite effects and persists verifiable transcript bytes"],
  ...["Request changes", "Reject exact package", "Cancel", "undefined"].map((choice, i) => [`native-nonapproval-${i}`, p("document-native"), `native document choice ${choice} never grants approval`]),
  ["native-caller-and-abort", p("document-native"), "nonforeground, caller drift and aborted UI never issue a decision"],
  ["native-launch-incarnation", p("document-native"), "native route authentication requires an immutable launch, incarnation anchor, foreground and canonical root"],
  ["role-and-tool-boundaries", p("document-native"), "paired profile parser is version scoped and no source/shell/resource aliases inherit rights"],
  ["bounded-lost-reply-correlation", p("document-native"), "native tool validates outer input and preserves durable-effect correlation in a bounded reply"],
  ["public-discovery-no-import", p("document-native"), "CLI discovery is static and never an approval/import workaround"],
  ["retained-selector", p("document-session"), "fresh foreground requirements route is native-only and retained routes do not upgrade"],
]);
export const DOCUMENT_ENTRY_CASES = Object.freeze(["installed-cli-description", "no-cli-approval-import", "no-opa-native-parity", "default-native-registration", "native-ticket-first", "native-draft-and-check", "native-snapshot-and-paged-read", "native-stale-consent", "native-exact-decision", "native-full-publication", "native-queue-and-reuse", "native-role-denials", "native-retained-no-upgrade"]);
const prerequisiteIds = ["installed-identity", "paired-document-profile", "selected-composition", "installed-import-integrity"];
export const initialDocumentCases = () => [...prerequisiteIds, ...DOCUMENT_CASES.map(([id]) => id), ...DOCUMENT_ENTRY_CASES].map(id => ({ id, status: "not-run" }));
export function accountDocumentCases(events, harnessRoot) {
  if (!Array.isArray(events) || !events.length || !isAbsolute(harnessRoot ?? "")) block("DOCUMENT_NATIVE_EVENTS_REQUIRED");
  if (events.some(e => e.type === "test:fail" || (e.type === "test:pass" && (e.data.skip || e.data.todo)))) block("DOCUMENT_CASE_FAILED_OR_SKIPPED");
  const passed = events.filter(e => e.type === "test:pass");
  const cases = DOCUMENT_CASES.map(([id, owner, name]) => {
    const matches = passed.filter(e => e.data.name === name);
    if (matches.length !== 1 || matches[0].data.file !== join(harnessRoot, owner.replace(/\.ts$/, ".js"))) block("DOCUMENT_CASE_OWNER_OR_INVENTORY", id);
    return { id, status: "passed", observations: 1, owner, name };
  });
  const summary = events.filter(e => e.type === "test:summary" && e.data.file === undefined).at(-1)?.data;
  if (!summary?.success || summary.counts?.failed || summary.counts?.cancelled || summary.counts?.skipped || summary.counts?.todo
    || summary.counts?.passed !== passed.filter(e => e.data.details?.type !== "suite").length) block("DOCUMENT_NATIVE_SUMMARY_REQUIRED");
  return { cases, tests: summary.counts, testEventsSha256: digest(Buffer.from(JSON.stringify(events))) };
}
export function accountDocumentEntries(value) {
  if (!value || value.schemaVersion !== "pa-document-public-observations/v1" || value.evidenceClass !== "disposable-default-native-synthetic-ui-not-human-approval"
    || value.sourceFallback !== false || value.humanUat !== false || !Array.isArray(value.cases)
    || value.cases.length !== DOCUMENT_ENTRY_CASES.length || value.cases.some((row, i) => row.id !== DOCUMENT_ENTRY_CASES[i] || row.status !== "passed" || !Number.isSafeInteger(row.observations) || row.observations < 1)) block("DOCUMENT_PUBLIC_ENTRY_INVENTORY");
  return value;
}
export function validateDocumentProfile(core, yaml, skill) {
  const team = core.parseTeamYamlContent(yaml), mode = team.deploy_modes?.find(row => row.id === "analyze");
  const canonical = mode?.skills?.filter(row => row.name === "pa-requirements-workflow") ?? [];
  if (team.name !== "requirements" || mode?.document_profile !== "pa-document-package/v1" || !skill.trim() || canonical.length !== 1 || !["global-skill", "shared-skill"].includes(canonical[0]["inject-as"])
    || team.deploy_modes.some(row => row.id !== "analyze" && row.document_profile !== undefined)) block("DOCUMENT_PAIRED_PROFILE_REQUIRED", "paired-document-profile");
  return team;
}
const requiredImports = ["pa-core/dist/documents/package-contract.js", "pa-core/dist/documents/package-service.js", "pa-core/dist/documents/package-tools.js", "pa-core/dist/registry/documents.js", "pa-core/dist/tickets/package-publication.js", "pi-pa/dist/document-session.js", "pi-pa/dist/document-native.js", "pi-pa/dist/document-cli.js", "pi-pa/dist/pi-extension/document-tool.js"];
export function accountDocumentImports(rows, share) {
  if (!Array.isArray(rows) || !rows.length) block("DOCUMENT_INSTALLED_IMPORTS_REQUIRED");
  const seen = new Set(rows.filter(row => row.kind === "implementation").map(row => row.path));
  for (const file of requiredImports) if (!seen.has(join(share, "packages", file))) block("DOCUMENT_INSTALLED_IMPORT_MISSING", file);
}
const driverFiles = ["verify_document_runtime.mjs", "document_installed_entries.mjs", "workflow_installed_support.mjs", "workflow_installed_harness.mjs", "workflow_test_reporter.mjs", "workflow_import_register.mjs", "workflow_import_audit.mjs"];
let progress;
export async function qualifyDocumentRuntime(args) {
  progress = { cases: initialDocumentCases() };
  const mark = (id, status) => { const row = progress.cases.find(row => row.id === id); if (!row) block("DOCUMENT_CASE_INVENTORY"); row.status = status; };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), sourceSha = parseArguments(args);
  progress.sourceSha = sourceSha; exactCheckout(root, sourceSha, "RUNTIME");
  for (const file of driverFiles) committedRead(root, sourceSha, `scripts/dev/${file}`);
  const installed = discoverInstalled(), opencode = discoverInstalled(undefined, "opa"), metadata = provenance(installed, sourceSha);
  if (installed.packageRoot !== opencode.packageRoot) block("DOCUMENT_ADAPTER_PACKAGE_MISMATCH");
  const modules = verifyModules(root, installed), pins = verifyBuildPins(root, installed, metadata);
  if (physicalFile(join(root, "pnpm-lock.yaml"), 2_097_152).compare(physicalFile(join(installed.share, "pnpm-lock.yaml"), 2_097_152, true))
    || JSON.parse(physicalFile(join(root, "package.json"))).version !== metadata.packageVersion) block("DOCUMENT_PACKAGE_IDENTITY_MISMATCH");
  for (const name of ["pi-pa", "opencode-pa", "runtime-host"]) if (realpathSync(join(installed.share, `packages/${name}/node_modules/@pa-platform/pa-core`)) !== join(installed.share, "packages/pa-core")) block("DOCUMENT_DEPENDENCY_SUBSTITUTION");
  mark("installed-identity", "passed");
  const core = await import(pathToFileURL(join(installed.share, "packages/pa-core/dist/index.js")).href);
  const selection = core.selectedTemplates(); exactCheckout(selection.root, pins.configSha, "CONFIG");
  if (selection.registrySha256 !== pins.registrySha256 || selection.configRevision !== metadata.configSha || core.getTeamsDir() !== join(selection.root, "teams")) block("DOCUMENT_SELECTED_PAIR_MISMATCH");
  const resources = {};
  const selectedRead = path => { const raw = committedRead(selection.root, selection.configRevision, path); resources[path] = digest(raw); return raw.toString("utf8"); };
  const team = validateDocumentProfile(core, selectedRead("teams/requirements.yaml"), selectedRead("skills/global/pa-requirements-workflow/SKILL.md"));
  mark("paired-document-profile", "passed");
  const primer = core.generatePrimer({ runtime: "pi", teamConfig: team, mode: "analyze", requirementsDocument: true, skillsDir: join(selection.root, "skills/global"), repository: { repoKey: "qualification-fixture", repoRoot: "/qualification-fixture", worktreeRoot: "/qualification-fixture" }, resolveFile: path => { selectedRead(path); return join(selection.root, path); } });
  const canonicalTag = `name="pa-requirements-workflow" path="${join(selection.root, "skills/global/pa-requirements-workflow/SKILL.md")}"`;
  if (!primer.includes("Native profile: pa-document-package/v1") || primer.split(canonicalTag).length !== 2) block("DOCUMENT_SELECTED_COMPOSITION_REQUIRED");
  // Pin every relevant committed instruction source, including index helpers
  // read by the composer outside its resolveFile callback. No private crawl.
  const instructionFiles = git(selection.root, "ls-tree", "-r", "--name-only", selection.configRevision, "teams", "skills", "primers", "contracts").split("\n").filter(path => /\.(?:md|ya?ml|json)$/.test(path));
  if (instructionFiles.length > 1024) block("DOCUMENT_CONFIG_RESOURCE_LIMIT");
  for (const path of instructionFiles) selectedRead(path);
  mark("selected-composition", "passed");
  const temporary = realpathSync(tmpdir());
  if ([root, selection.root].some(path => { const r = relative(path, temporary); return !r || (!r.startsWith("..") && !isAbsolute(r)); })) block("DOCUMENT_EXTERNAL_DISPOSABLE_ROOT_REQUIRED");
  const evidenceRoot = mkdtempSync(join(temporary, "pa-document-installed-")), directory = join(evidenceRoot, "harness"); progress.evidenceRoot = evidenceRoot;
  writeFileSync(join(evidenceRoot, "selected-primer.md"), primer, { mode: 0o600 });
  const binding = join(installed.share, process.versions.node.split(".")[0] === "24" ? "native-addons/pi-node-24/better_sqlite3.node" : `native-addons/node-${process.versions.node.split(".")[0]}/better_sqlite3.node`);
  const piBinding = join(installed.share, "native-addons/pi-node-24/better_sqlite3.node");
  const bindingSha256 = digest(physicalFile(binding, 32 * 1024 * 1024, true)); physicalFile(piBinding, 32 * 1024 * 1024, true);
  const environment = { ...cleanEnvironment(), HOME: join(evidenceRoot, "home"), PA_AI_USAGE_HOME: join(evidenceRoot, "usage"), PA_PLATFORM_CONFIG: join(evidenceRoot, "config"), PA_REGISTRY_DB: join(evidenceRoot, "registry.db"),
    PA_SQLITE_NATIVE_BINDING: binding, PA_PI_SQLITE_NATIVE_BINDING: piBinding, PA_REQUIRE_PI_SQLITE_NATIVE_BINDING: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8", TZ: "UTC" };
  for (const path of [environment.HOME, environment.PA_AI_USAGE_HOME, environment.PA_PLATFORM_CONFIG]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(environment.PA_PLATFORM_CONFIG, "config.yaml"), "repos: {}\n", { mode: 0o600 });
  const harness = await createHarness({ sourceRoot: root, sourceSha, moduleRoot: installed.share, directory, requiredTestFiles: [...new Set(DOCUMENT_CASES.map(([, owner]) => owner))] });
  const audit = join(evidenceRoot, "imports.jsonl"), frame = join(evidenceRoot, "import-frame.json");
  writeFileSync(frame, JSON.stringify({ sourceRoot: root, moduleRoot: installed.share, harness: directory, modules, bridges: harness.bridges, audit }), { mode: 0o600 });
  const loader = new URL("./workflow_import_register.mjs", import.meta.url); loader.searchParams.set("frame", frame); environment.NODE_OPTIONS = `--import=${loader.href}`;
  for (const [id] of DOCUMENT_CASES) mark(id, "unknown");
  const run = runHarness({ directory, harness, env: environment, reporter: fileURLToPath(new URL("./workflow_test_reporter.mjs", import.meta.url)), evidenceRoot, account: accountDocumentCases });
  for (const row of run.cases) mark(row.id, row.status);
  const entryFrame = join(evidenceRoot, "entry-frame.json");
  writeFileSync(entryFrame, JSON.stringify({ share: installed.share, ppa: installed.binary, opa: opencode.binary, evidenceRoot }), { mode: 0o600 });
  for (const id of DOCUMENT_ENTRY_CASES) mark(id, "unknown");
  const entry = spawnSync(process.execPath, [fileURLToPath(new URL("./document_installed_entries.mjs", import.meta.url)), entryFrame], { cwd: directory, env: environment, encoding: "utf8", timeout: 120000, maxBuffer: 1_048_576 });
  writeFileSync(join(evidenceRoot, "public-entry.json"), entry.stdout ?? "", { mode: 0o600 }); writeFileSync(join(evidenceRoot, "public-entry.stderr"), entry.stderr ?? "", { mode: 0o600 });
  if (entry.error || entry.signal || entry.status !== 0 || entry.stderr) block("DOCUMENT_PUBLIC_ENTRY_FAILED");
  const publicEntries = accountDocumentEntries(JSON.parse(entry.stdout)); for (const row of publicEntries.cases) mark(row.id, row.status);
  const imports = physicalFile(audit, 32 * 1024 * 1024).toString("utf8").trim().split("\n").map(line => JSON.parse(line)); accountDocumentImports(imports, installed.share);
  exactCheckout(root, sourceSha, "RUNTIME"); exactCheckout(selection.root, selection.configRevision, "CONFIG");
  for (const [path, sha] of Object.entries(resources)) if (digest(committedRead(selection.root, selection.configRevision, path)) !== sha) block("DOCUMENT_CONFIG_RESOURCE_DRIFT");
  const freshSelection = core.selectedTemplates();
  if (freshSelection.root !== selection.root || freshSelection.configRevision !== selection.configRevision || freshSelection.registrySha256 !== selection.registrySha256
    || JSON.stringify(verifyBuildPins(root, installed, provenance(discoverInstalled(), sourceSha))) !== JSON.stringify(pins)
    || JSON.stringify(verifyModules(root, installed)) !== JSON.stringify(modules) || discoverInstalled().physical !== installed.physical || discoverInstalled(undefined, "opa").physical !== opencode.physical
    || provenance(installed, sourceSha).sha256 !== metadata.sha256) block("DOCUMENT_INSTALLED_IDENTITY_DRIFT");
  mark("installed-import-integrity", "passed");
  const resourceInventory = JSON.stringify(resources);
  writeFileSync(join(evidenceRoot, "selected-resources.json"), resourceInventory, { mode: 0o600 });
  return { schemaVersion: "pa-document-installed-qualification/v1", status: "passed", unsigned: true, sourceSha,
    evidenceClass: "selected-installed-disposable-not-foreground-independent-review-CI-human-UAT-or-rollout",
    installed: { ...installed, opa: opencode.physical, provenanceSha256: metadata.sha256, bindingSha256, moduleInventorySha256: digest(Buffer.from(JSON.stringify(modules))) },
    config: { root: selection.root, sha: selection.configRevision, registrySha256: selection.registrySha256, resourceInventory: { count: Object.keys(resources).length, sha256: digest(Buffer.from(resourceInventory)), ref: join(evidenceRoot, "selected-resources.json") }, primerSha256: digest(Buffer.from(primer)) }, cases: progress.cases, nativeCases: run.cases, tests: run.tests, publicEntries,
    drivers: { pinnedSource: sourceSha, implementationRoot: installed.share, implementationsCopiedFromSource: false, sourceSha256: run.harnessSourceSha256, bridgesSha256: run.implementationBridgesSha256 },
    evidenceRoot, importAuditSha256: digest(physicalFile(audit, 32 * 1024 * 1024)), installationPerformed: false, enablementPerformed: false, humanApproval: false, humanUat: false,
    limitations: ["Public native caller/registry/process evidence is disposable test setup; foreground UI choices are synthetic, not human approval.", "Selected composition hashes are exact content observations, not semantic instruction acceptance.", "Genuine normal foreground TS-1–TS-18, independent review, full regressions, hosted CI and Sinh UAT remain separate mandatory obligations."] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await qualifyDocumentRuntime(process.argv.slice(2)); const raw = JSON.stringify(result); if (Buffer.byteLength(raw) > 50 * 1024) block("DOCUMENT_REPORT_SIZE"); console.log(raw); }
  catch (error) {
    console.log(JSON.stringify({ schemaVersion: "pa-document-installed-qualification/v1", status: "blocked", unsigned: true, code: error.code ?? "DOCUMENT_REQUIRED_EVIDENCE_UNAVAILABLE", gate: error.gate ?? "qualification", cases: progress?.cases ?? initialDocumentCases(), sourceSha: progress?.sourceSha, evidenceRoot: progress?.evidenceRoot,
      installationPerformed: false, enablementPerformed: false, humanApproval: false, humanUat: false,
      diagnostic: "Exact clean PAP-283 candidate, matched immutable installed provenance/modules and exact selected PAPC document profile are required. Preserve failed evidence; no install, source fallback, advisory-only substitution, skip or imported outcomes." }));
    process.exitCode = 1;
  }
}
