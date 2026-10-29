#!/usr/bin/env -S node --import=tsx
/** PAPC development only: exact committed SOURCE pairing, never installation,
 * selected runtime adoption, human approval or rollout qualification. No writes. */
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const runtimeRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
let gateId = "arguments";
const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
const gitEnvironment = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
const flags = ["--no-pager", "--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never"];
class PairBlocked extends Error { constructor(readonly code: string) { super("Source pairing blocked"); } }
const block = (code: string): never => { throw new PairBlocked(code); };
function output(report: unknown) { const raw = JSON.stringify(report); if (Buffer.byteLength(raw) > 262_144) block("RESPONSE_SIZE"); console.log(raw); }
const gitBytes = (root: string, args: string[]) => execFileSync("git", [...flags, "-C", root, ...args], { env: gitEnvironment, timeout: 15_000, maxBuffer: 2_097_152, stdio: ["ignore", "pipe", "pipe"] });
const git = (root: string, args: string[]) => gitBytes(root, args).toString("utf8").trim();
function exactCheckout(root: string, expected: string, label: string) {
  if (!/^[a-f0-9]{40}$/.test(expected) || !isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) block(`${label}_IDENTITY`);
  if (git(root, ["rev-parse", "--show-toplevel"]) !== root || git(root, ["rev-parse", "HEAD"]) !== expected) block(`${label}_REVISION`);
  if (git(root, ["status", "--porcelain=v2", "--untracked-files=all"])) block(`${label}_DIRTY`);
}
async function run(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: corepack pnpm exec tsx scripts/dev/verify_workflow_source_pair.mts --runtime-sha FULL_SHA --config-root /physical/papc/checkout --config-sha FULL_SHA\nAll bindings must remain disabled. Requires committed, clean physical source checkouts; no origin/develop, install, selected-pin rewrite or executable-config-code requirement. This is not the installed verifier.");
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--runtime-sha", "--config-root", "--config-sha"].includes(key) || options.has(key) || !value || value.startsWith("--")) block("ARGUMENTS");
    options.set(key, value);
  }
  if (options.size !== 3) block("ARGUMENTS");
  const runtimeSha = options.get("--runtime-sha")!, configRoot = options.get("--config-root")!, configSha = options.get("--config-sha")!;
  gateId = "runtime-identity"; exactCheckout(runtimeRoot, runtimeSha, "RUNTIME");
  gateId = "config-identity"; exactCheckout(configRoot, configSha, "CONFIG");
  gateId = "runtime-source";
  // Load only the explicitly pinned runtime's code. Config remains bounded JSON/Markdown data.
  const workflows = await import(pathToFileURL(resolve(runtimeRoot, "packages/pa-core/src/workflows/index.ts")).href) as typeof import("../../packages/pa-core/src/workflows/index.js");
  const templatesService = await import(pathToFileURL(resolve(runtimeRoot, "packages/pa-core/src/templates/service.ts")).href) as typeof import("../../packages/pa-core/src/templates/service.js");
  const templatesRegistry = await import(pathToFileURL(resolve(runtimeRoot, "packages/pa-core/src/templates/registry.ts")).href) as typeof import("../../packages/pa-core/src/templates/registry.js");
  const reader = await import(pathToFileURL(resolve(runtimeRoot, "packages/pa-core/src/validation/review-contract.ts")).href) as typeof import("../../packages/pa-core/src/validation/review-contract.js");
  const core = { ...workflows, ...templatesService, ...templatesRegistry, ...reader };
  const templateCli = await import(pathToFileURL(resolve(runtimeRoot, "packages/pa-core/src/cli/commands/template.ts")).href) as typeof import("../../packages/pa-core/src/cli/commands/template.js");
  const observed = new Map<string, { root: string; relative: string; sha256: string }>();
  const read = (root: string, revision: string, relative: string): Uint8Array => {
    if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").some(p => !p || p === "." || p === "..")) block("RESOURCE_PATH");
    const path = resolve(root, relative);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path) block("RESOURCE_ALIAS");
    const raw = core.readReviewEvidenceFile(path, 1_048_576, "source-pair.resource");
    if (sha(raw) !== sha(gitBytes(root, ["cat-file", "blob", `${revision}:${relative}`]))) block("RESOURCE_UNCOMMITTED");
    observed.set(`${root}:${relative}`, { root, relative, sha256: sha(raw) }); return raw;
  };
  const runtimeFiles = ["scripts/dev/verify_workflow_source_pair.mts", "pnpm-lock.yaml", "packages/pa-core/src/index.ts", "packages/pa-core/src/workflows/index.ts", "packages/pa-core/src/workflows/contracts.ts", "packages/pa-core/src/workflows/definition.ts", "packages/pa-core/src/workflows/operations.ts", "packages/pa-core/src/workflows/selected.ts", "packages/pa-core/src/workflows/producer.ts", "packages/pa-core/src/workflows/paired.ts", "packages/pa-core/src/workflows/evidence.ts", "packages/pa-core/src/workflows/public.ts", "packages/pa-core/src/cli/commands/workflow.ts", "packages/pa-core/src/cli/commands/template.ts", "packages/pa-core/src/templates/service.ts", "packages/pa-core/src/templates/registry.ts", "packages/pa-core/src/validation/review-contract.ts"];
  for (const relative of runtimeFiles) read(runtimeRoot, runtimeSha, relative);
  const configRead = (relative: string) => read(configRoot, configSha, relative);
  gateId = "workflow-manifest";
  const selection = core.loadSelectedWorkflows({ root: () => configRoot, revision: () => git(configRoot, ["rev-parse", "HEAD"]), read: (_root: string, relative: string) => configRead(relative) });
  if (!selection.definitions.length || !selection.bindings.length || !selection.manifestSha256) block("WORKFLOW_CONTENT_REQUIRED");
  if (selection.bindings.some(b => b.enabled)) block("DISABLED_BINDINGS_REQUIRED");
  gateId = "template-registry";
  const registryBytes = configRead("contracts/templates-v1.json"), templates = { root: configRoot, configRevision: configSha, registrySha256: sha(registryBytes) };
  const loaded = core.loadTemplateRegistry(templates);
  for (const entry of loaded.registry.entries) configRead(entry.source.path);
  gateId = "workflow-fixtures";
  const fixtures = configRead("workflows/fixtures-v1.json");
  const paired = core.validateWorkflowPair(selection, templates, fixtures, configRead);
  const checks: { id: string; cases: number }[] = [{ id: "exact-producer-artifact-matrix-pair", cases: paired.fixtures.length }];
  gateId = "source-cli-parity";
  let cliCases = 0;
  const cli = async (argv: string[], body: unknown, team: string, mode: string) => {
    const output: string[] = [];
    const status = await templateCli.runTemplateCommand(argv, { stdout: s => output.push(s), stderr: () => block("CLI_STDERR") }, { selection: templates, team, mode, input: (async function* () { if (body !== undefined) yield JSON.stringify(body); })() });
    if (output.length !== 1) block("CLI_FRAMING");
    return { status, value: JSON.parse(output[0]!) as Record<string, unknown> };
  };
  const document = core.parseReviewEvidenceJson(fixtures, "source-pair.fixtures") as { fixtures: { producer: string; candidateSha256: string; team: string; mode: string }[] };
  for (const fixture of document.fixtures) {
    const request = core.parseWorkflowRequest(fixture.producer) as { action: string; id: string; version: string; bindings: Record<string, unknown> };
    const host = { selection: templates, team: fixture.team, mode: fixture.mode, reviewBundleConsumer: core.reviewBundleTemplateConsumer };
    const rendered = core.templateService(fixture.producer, host);
    if (rendered.ok !== true || typeof rendered.candidate !== "string" || sha(Buffer.from(rendered.candidate)) !== fixture.candidateSha256) block("PRODUCER_CANDIDATE");
    for (const action of ["list", "show", "render", "validate"]) {
      const input = action === "list" ? { action } : action === "show" ? { action, id: request.id, version: request.version } : { action, id: request.id, version: request.version, bindings: request.bindings, ...(action === "validate" ? { candidate: rendered.candidate } : {}) };
      const argv = [action, ...(action === "list" ? [] : [request.id, "--version", request.version]), "--format", "json"];
      const body = action === "render" ? { bindings: request.bindings } : action === "validate" ? { bindings: request.bindings, candidate: rendered.candidate } : undefined;
      const expected = JSON.stringify(core.templateService(input, host));
      for (let repeat = 0; repeat < 3; repeat++) {
        const actual = await cli(argv, body, fixture.team, fixture.mode);
        if (actual.status !== 0 || JSON.stringify(actual.value) !== expected) block("CLI_CONSUMER_PARITY"); cliCases++;
      }
    }
    const bad = await cli(["validate", request.id, "--version", request.version, "--format", "json"], { bindings: request.bindings, candidate: `${rendered.candidate}\nchanged` }, fixture.team, fixture.mode);
    if (bad.status !== 1 || bad.value.ok !== false) block("CHANGED_CANDIDATE_ACCEPTED");
    const forged = core.templateService({ ...request, outcome: "approved", actor: "operator" }, host);
    if (forged.ok !== false) block("FORGED_AUTHORITY_ACCEPTED");
  }
  checks.push({ id: "source-cli-template-consumer-parity", cases: cliCases }, { id: "changed-candidate-and-forged-request-rejection", cases: document.fixtures.length * 2 });
  gateId = "disabled-new-run-selector";
  for (const binding of selection.bindings) {
    let disabled = false;
    try { core.selectNewWorkflow(selection, binding.team, binding.mode); } catch (error) { disabled = error instanceof core.JsonWorkflowError && error.code === "WORKFLOW_DISABLED"; }
    if (!disabled) block("DISABLED_NEW_RUN_ACCEPTED");
  }
  checks.push({ id: "actual-new-run-selector-denies-disabled-binding", cases: selection.bindings.length });
  gateId = "static-definition-cli";
  for (const definition of selection.definitions) {
    const file = JSON.parse(Buffer.from(configRead("workflows/manifest.json")).toString()).definitions.find((d: { workflowId: string; version: string }) => d.workflowId === definition.definition.workflowId && d.version === definition.definition.version).file;
    const output: string[] = [];
    const status = core.runWorkflowCommand("workflow", ["validate", "--definition-file", resolve(configRoot, file), "--json"], { stdout: s => output.push(s), stderr: () => block("CLI_STDERR") });
    const result = JSON.parse(output[0]!);
    if (status !== 0 || result.executionAdmitted !== false || result.result.sha256 !== definition.sha256) block("DEFINITION_CLI_VALIDATION");
  }
  checks.push({ id: "source-cli-definition-static-validation", cases: selection.definitions.length });
  gateId = "identity-resource-reread";
  exactCheckout(runtimeRoot, runtimeSha, "RUNTIME"); exactCheckout(configRoot, configSha, "CONFIG");
  for (const resource of observed.values()) if (sha(core.readReviewEvidenceFile(resolve(resource.root, resource.relative), 1_048_576, "source-pair.reread")) !== resource.sha256) block("RESOURCE_DRIFT");
  output({ schemaVersion: "pa-workflow-source-pair/v1", status: "compatible-disabled-source-drafts", evidenceClass: "read-only-source-structural-not-installed-native-execution-review-or-human-UAT", unsigned: true, structuralOnly: true, runtime: { root: runtimeRoot, sha: runtimeSha, sourceFiles: Object.fromEntries([...observed.values()].filter(r => r.root === runtimeRoot).map(r => [r.relative, r.sha256])) }, config: { root: configRoot, sha: configSha, manifestSha256: selection.manifestSha256, registrySha256: templates.registrySha256, fixturesSha256: sha(fixtures) }, bindingsEnabled: false, executionAdmitted: false, humanApproval: false, checks, fixtures: paired.fixtures, consumedResources: observed.size, limitations: ["No native foreground capture, effect dispatch, execution-holder restart, installed verification or policy/instruction acceptance is established.", "Operation contracts are vocabulary, not executable registrations. Consult the pinned runtime implementation/handoff for missing owner capabilities; no dispatcher is invoked here.", "No installed package, runtime/config pin, config bytes, ticket, registry, checkout or enablement selection is written by this command."] });
}
try { await run(process.argv.slice(2)); }
catch (error) {
  const code = error instanceof PairBlocked ? error.code : "SOURCE_PAIR_EVIDENCE_REQUIRED";
  output({ schemaVersion: "pa-workflow-source-pair/v1", unsigned: true, structuralOnly: true, status: "blocked", code, gateId, correctionOwner: gateId.startsWith("runtime") ? "runtime-source-owner" : "runtime-config-source-owner", diagnostic: "Exact clean source revisions, disabled bindings and complete matching producer/consumer fixtures are required. Correct the missing evidence; do not install, enable, use legacy fallback or infer readiness.", executionAdmitted: false, humanApproval: false });
  process.exitCode = 1;
}
