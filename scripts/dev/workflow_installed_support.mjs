import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export class QualificationBlocked extends Error { constructor(code, gate = "identity") { super("Workflow qualification blocked"); this.code = code; this.gate = gate; } }
export const block = (code, gate) => { throw new QualificationBlocked(code, gate); };
export const cleanEnvironment = () => Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
export const gitEnvironment = () => ({ ...cleanEnvironment(), LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
const flags = ["--no-pager", "--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never"];
export const gitBytes = (root, ...args) => execFileSync("git", [...flags, "-C", root, ...args], { env: gitEnvironment(), timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
export const git = (root, ...args) => gitBytes(root, ...args).toString("utf8").trim();
export function physicalFile(path, maximum = 1_048_576, immutable = false) {
  if (realpathSync(path) !== path) block("WORKFLOW_FILE_ALIAS");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum || (!immutable && before.nlink !== 1)) block("WORKFLOW_FILE_IDENTITY");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
    const bytes = buffer.subarray(0, length), after = fstatSync(fd), named = lstatSync(path);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs
      || before.mtimeMs !== after.mtimeMs || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino) block("WORKFLOW_FILE_CHANGED");
    return bytes;
  } finally { closeSync(fd); }
}
export function exactCheckout(root, expected, label) {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root || !/^[a-f0-9]{40}$/.test(expected)
    || git(root, "rev-parse", "--show-toplevel") !== root || git(root, "rev-parse", "HEAD") !== expected) block(`WORKFLOW_${label}_IDENTITY`);
  if (git(root, "status", "--porcelain=v2", "--untracked-files=all")) block(`WORKFLOW_${label}_DIRTY`);
}
export function parseArguments(args) {
  if (args.length !== 4 || args[0] !== "--selected-installed" || args[1] !== "--require-candidate" || !/^[a-f0-9]{40}$/.test(args[2] ?? "") || args[3] !== "--require-paired-config") block("WORKFLOW_ARGUMENTS", "arguments");
  return args[2];
}
export function discoverInstalled(pathValue = process.env.PATH ?? "") {
  const binary = pathValue.split(":").filter(isAbsolute).map(path => join(path, "ppa")).find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
  if (!binary) block("WORKFLOW_INSTALLED_BINARY_REQUIRED");
  const physical = realpathSync(binary), match = /^(\/nix\/store\/[a-z0-9]{32}-[^/]+)\/bin\/(?:ppa|\.ppa-wrapped)$/.exec(physical);
  if (!match) block("WORKFLOW_INSTALLED_PROVENANCE_REQUIRED");
  return { binary, physical, packageRoot: match[1], share: join(match[1], "share/pa-platform"), binarySha256: digest(physicalFile(physical, 1_048_576, true)) };
}
export function provenance(installed, candidate) {
  const raw = physicalFile(join(installed.share, "review-runtime-provenance.json"), 65536, true).toString("utf8");
  // Fixed flat Nix metadata, not a workflow/decision parser. Escaped or nested
  // keys are unsupported; duplicates reject before JSON interpretation.
  if (raw.includes("\\") || !/^\s*\{\s*(?:"[A-Za-z]+"\s*:\s*"[A-Za-z0-9./_-]+"\s*,?\s*)+\}\s*$/.test(raw)) block("WORKFLOW_PROVENANCE_SCHEMA");
  const keys = [...raw.matchAll(/"([A-Za-z]+)"\s*:/g)].map(match => match[1]);
  const required = ["schemaVersion", "sourceSha", "configSha", "packageName", "packageVersion", "objectiveSchema", "matrixSchema"];
  if (keys.length !== required.length || new Set(keys).size !== keys.length || keys.some(key => !required.includes(key))) block("WORKFLOW_PROVENANCE_SCHEMA");
  const value = JSON.parse(raw);
  if (value.schemaVersion !== "pa-review-runtime/v1" || value.packageName !== "pa-platform" || value.sourceSha !== candidate || !/^[a-f0-9]{40}$/.test(value.configSha)) block("WORKFLOW_INSTALLED_CANDIDATE_MISMATCH");
  return { ...value, sha256: digest(Buffer.from(raw)) };
}
export function verifyBuildPins(root, installed, metadata) {
  const configSha = physicalFile(join(root, '.pa-platform-config.sha'), 64).toString().trim();
  const registrySha256 = physicalFile(join(root, '.pa-template-registry.sha'), 80).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(configSha) || !/^[a-f0-9]{64}$/.test(registrySha256) || metadata.configSha !== configSha
    || physicalFile(join(installed.share, '.pa-platform-config.sha'), 64, true).toString().trim() !== configSha
    || physicalFile(join(installed.share, '.pa-template-registry.sha'), 80, true).toString().trim() !== registrySha256) block('WORKFLOW_BUILD_PROVENANCE_MISMATCH');
  return { configSha, registrySha256 };
}
export function implementationFiles(root) {
  const result = [];
  function walk(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) block("WORKFLOW_MODULE_ALIAS");
      if (entry.isDirectory()) { if (entry.name !== "__tests__") walk(path); }
      else if (entry.isFile() && /\.(?:js|json|node)$/.test(entry.name) && path !== "packages/pi-pa/dist/pi-pa-package.json") result.push(path);
    }
  }
  for (const name of ["pa-core", "pi-pa", "opencode-pa", "runtime-host"]) walk(`packages/${name}/dist`);
  return result;
}
export function verifyModules(root, installed) {
  const source = implementationFiles(root), target = implementationFiles(installed.share);
  if (!source.length || JSON.stringify(source) !== JSON.stringify(target)) block("WORKFLOW_MODULE_INVENTORY");
  const modules = {};
  for (const path of source) {
    const expected = digest(physicalFile(join(root, path), 16_777_216));
    if (digest(physicalFile(join(installed.share, path), 16_777_216, true)) !== expected) block("WORKFLOW_INSTALLED_MODULE_MISMATCH");
    modules[path] = expected;
  }
  for (const path of ["package.json", "packages/pa-core/package.json", "packages/opencode-pa/package.json", "packages/runtime-host/package.json"]) {
    const expected = digest(physicalFile(join(root, path)));
    if (digest(physicalFile(join(installed.share, path), 1_048_576, true)) !== expected) block("WORKFLOW_PACKAGE_METADATA_MISMATCH");
    modules[path] = expected;
  }
  if (digest(physicalFile(join(root, "packages/pi-pa/dist/pi-pa-package.json"))) !== digest(physicalFile(join(installed.share, "packages/pi-pa/package.json"), 1_048_576, true))) block("WORKFLOW_PACKAGE_METADATA_MISMATCH");
  if (realpathSync(join(installed.share, "packages/pi-pa/node_modules/@pa-platform/pa-core")) !== join(installed.share, "packages/pa-core")) block("WORKFLOW_DEPENDENCY_SUBSTITUTION");
  return modules;
}
export function trackedSource(root) {
  return gitBytes(root, "ls-tree", "-r", "--name-only", "HEAD", "packages/pa-core/src", "packages/pi-pa/src").toString("utf8").trim().split("\n").filter(Boolean);
}
export function committedRead(root, sha, path) {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) block("WORKFLOW_SOURCE_PATH");
  const raw = physicalFile(join(root, path), 2_097_152);
  if (digest(raw) !== digest(gitBytes(root, "cat-file", "blob", `${sha}:${path}`))) block("WORKFLOW_SOURCE_SUBSTITUTION");
  return raw;
}
export function safeDiagnostic(error) {
  const code = error instanceof QualificationBlocked ? error.code : "WORKFLOW_REQUIRED_EVIDENCE_UNAVAILABLE";
  return { code, gateId: error instanceof QualificationBlocked ? error.gate : "qualification", diagnostic: `Condition: ${code}\nSource: exact installed workflow qualification\nReason: a required candidate, selected pair, native case or unchanged-state proof is unavailable.\nCorrection: reconcile the missing prerequisite through its owner; do not install, enable, skip cases or import outcomes to bypass it.\nResume Action: rerun the unchanged verifier against the exact supported candidate and selected pair.` };
}
export const REQUIRED_TEST_FILES = Object.freeze([
  "packages/pa-core/src/__tests__/workflow-contract.test.ts", "packages/pa-core/src/__tests__/workflow-state.test.ts", "packages/pa-core/src/__tests__/workflow-cli.test.ts", "packages/pa-core/src/__tests__/workflow-owner-integration.test.ts", "packages/pa-core/src/__tests__/workflow-startup.test.ts",
  "packages/pi-pa/src/__tests__/workflow-startup.test.ts", "packages/pa-core/src/__tests__/selected-config-compatibility.test.ts", "packages/pa-core/src/__tests__/workflow-resources.test.ts", "packages/pi-pa/src/__tests__/workflow-config.test.ts",
  "packages/pa-core/src/__tests__/execution-custody.test.ts", "packages/pi-pa/src/__tests__/pi-workflow-runtime.test.ts", "packages/pi-pa/src/__tests__/pi-workflow-decision.test.ts", "packages/pi-pa/src/__tests__/pi-execution-custody.test.ts", "packages/pi-pa/src/__tests__/native-execution-evidence.test.ts",
]);
// Exact native test events, not caller report flags. Every anchor is mandatory;
// omission/rename requires a reviewed verifier change, never silent skipping.
export const CASE_ANCHORS = Object.freeze({
  "static-zero-effects": ["preflight reports independent missing prerequisites without executing any effect/probe"],
  "startup-stage-separation": ["requirements admission/revision defers missing execution profile without inventing effect authority", "source.local request fails closed at its own boundary with no intent or effect for missing execution contract", "check.matrix request fails closed at its own boundary with no intent or effect for unsupported execution contract", "native observations distinguish uninspected, registered missing, supported and unsupported before a subject exists"],
  "startup-causal-diagnostics": ["fresh status/next expose selected-without-run and authenticated pre-subject repository context", "producer preserves selected-pair and capability causes instead of erasing them as WORKFLOW_SOURCE", "fresh native read and CLI service projections agree on later execution blockers and true pair failure"],
  "compatible-resource-selection": ["one runtime supports multiple committed compatible config and registry revisions without package-pin edits", "committed source reads do not run selected Git monitors, hooks, replacements or ambient Git configuration"],
  "retained-config-continuation": ["native resource owner retains exact committed templates/instructions and uses them across compatible config advances", "default native template host and planner retain the exact run config after compatible selected changes", "legacy native continuation is readable but cannot acquire current templates or planner instructions"],
  "structured-decision": ["synthetic UI fixture displays exact subject/permissions; outcome and principal are not model inputs", "evidence mutation during the native dialog cannot mint a decision"],
  "package-effects": ["actual ticket publication/queue owners publish exact pair once and preserve counters and audit on replay", "default Pi launcher and native execution owner consume the structured grant and reread revocation"],
  "publication-interruption": ["interruption after first member resumes only the absent member using the SAME durable intent", "conflicting bytes, symlinks and foreign primary evidence are preserved, never overwritten or queued"],
  "amendment": ["amendment publication promotes ONLY the proven predecessor, preserves historical bytes/metadata and reuses the queue", "linked amendment publication/queue admits a new exact baseline without upgrading old launch/scope/review authority"],
  "native-two-phases": ["roadmap Step 2: exact source intent settles from real native checked/committed phase evidence, never agent flags"],
  "native-restart": ["foreground default launcher retains failed-check custody across real predecessor exit and resumes two native source phases without allocation", "PAP-271 unknown operation remains exact, cannot be finished by retired/successor caller or cleared by another restart"],
  "restart-interruption": ["PAP-271 real multi-process owner/journal contention settles one handoff and retains one permit", "PAP-271 capacity-publish fault is recovered only under same pending intent; no second permit or snapshot reset"],
  "native-matrix": ["check.matrix: real executor/ledger/streams settle one durable intent; source flags and a missing native seal cannot pass", "check.matrix retains native failed exit and skipped successors as failed, never passed or retried"],
  "revocation": ["revocation after partial publication prevents the absent member; completed native effects can still settle", "protected review consumes issued native locator with no paragraph authority and cannot downgrade after revoke"],
  "actual-cas": ["32 actual SQLite connections racing one revision accept exactly one append", "32 actual SQLite connections accept exactly one linked subject revision, retaining one run and all history"],
  "tamper-no-fallback": ["missing adopted registry cannot fall back to a ticket approval paragraph", "source operation proof rejects unissued payload despite a protected native-evidence envelope"],
});
export function accountCases(events) {
  if (!Array.isArray(events) || !events.length) block("WORKFLOW_CASE_EVENTS_REQUIRED", "case-accounting");
  const passed = events.filter(event => event.type === "test:pass");
  if (events.some(event => event.type === "test:fail" || ((event.type === "test:pass" || event.type === "test:fail") && (event.data.skip || event.data.todo)))) block("WORKFLOW_REQUIRED_CASE_FAILED_OR_SKIPPED", "case-accounting");
  const names = new Set(passed.map(event => event.data.name)), cases = [];
  for (const [id, required] of Object.entries(CASE_ANCHORS)) {
    if (required.some(name => !names.has(name))) block("WORKFLOW_REQUIRED_CASE_OMITTED", id);
    cases.push({ id, status: "passed", observations: required.length, testNames: required });
  }
  const summary = events.filter(event => event.type === "test:summary" && event.data.file === undefined).at(-1)?.data;
  if (!summary || !summary.success || summary.counts?.failed || summary.counts?.cancelled || summary.counts?.skipped || summary.counts?.todo
    || summary.counts?.passed !== passed.filter(event => event.data.details?.type !== "suite").length) block("WORKFLOW_TEST_SUMMARY_REQUIRED", "case-accounting");
  return { cases, tests: summary.counts, testEventsSha256: digest(Buffer.from(JSON.stringify(events))) };
}
