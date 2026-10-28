#!/usr/bin/env node
/** Read-only qualification. Never installs, launches a product, writes tickets or
 * executes config-provided code. Missing cases/resources are blocking failures. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let mode;
function blocked(code, source = "paired-template-owner") {
  const error = new Error("qualification blocked"); error.code = code; error.source = source; throw error;
}
const args = process.argv.slice(2);
try {
  if (args.length !== 2 && args.length !== 4) blocked("TEMPLATE_ARGUMENTS");
  if (args[0] !== "--mode" || !["paired-config", "selected-installed"].includes(args[1])) blocked("TEMPLATE_ARGUMENTS");
  mode = args[1];
  if ((mode === "paired-config" && args.length !== 2) || (mode === "selected-installed" && (args[2] !== "--binary" || args[3] !== "ppa"))) blocked("TEMPLATE_ARGUMENTS");
  const registry = await import(pathToFileURL(join(root, "packages/pa-core/dist/templates/registry.js")));
  const schema = await import(pathToFileURL(join(root, "packages/pa-core/dist/templates/schema.js")));
  const { templateService } = await import(pathToFileURL(join(root, "packages/pa-core/dist/templates/service.js")));
  const { readReviewEvidenceFile } = await import(pathToFileURL(join(root, "packages/pa-core/dist/validation/review-contract.js")));
  const { runCoreCommand } = await import(pathToFileURL(join(root, "packages/pa-core/dist/cli/core-command.js")));
  const { createTemplateModule } = await import(pathToFileURL(join(root, "packages/pi-pa/dist/pi-extension/template-tool.js")));
  const { generatePrimer } = await import(pathToFileURL(join(root, "packages/pa-core/dist/primer/index.js")));
  const { getConfigDir } = await import(pathToFileURL(join(root, "packages/pa-core/dist/paths.js")));
  const { parseTeamYamlContent } = await import(pathToFileURL(join(root, "packages/pa-core/dist/yaml-parser.js")));
  const selection = registry.selectedTemplates();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  // No fsmonitor/hooks, index writes, pager, lazy fetch or config-selected code.
  const gitFlags = ["--no-pager", "--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never"];
  const gitBytes = (cwd, ...args) => execFileSync("git", [...gitFlags, "-C", cwd, ...args], { env, timeout: 15000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"] });
  const git = (cwd, ...args) => gitBytes(cwd, ...args).toString("utf8").trim();
  assert.equal(git(selection.root, "rev-parse", "--show-toplevel"), selection.root);
  assert.equal(git(selection.root, "rev-parse", "HEAD"), selection.configRevision);
  assert.equal(git(selection.root, "status", "--porcelain=v2", "--untracked-files=all"), "");
  git(selection.root, "merge-base", "--is-ancestor", selection.configRevision, "refs/remotes/origin/develop");
  const loaded = registry.loadTemplateRegistry(selection);
  const observed = new Map();
  const fixedRead = (relative) => {
    schema.relativePath(relative);
    if (!/^(?:contracts|skills|teams|primers|docs|policies)\//.test(relative) && !["IDENTITY.md", "README.md", "CLAUDE.md"].includes(relative)) blocked("TEMPLATE_SOURCE", "selected-config-resource");
    const bytes = readReviewEvidenceFile(join(selection.root, relative), 1_048_576, "paired.template");
    const committed = gitBytes(selection.root, "cat-file", "blob", `${selection.configRevision}:${relative}`);
    assert.equal(schema.digest(bytes), schema.digest(committed)); observed.set(relative, schema.digest(bytes)); return bytes;
  };
  for (const path of ["contracts/templates-v1.json", ...new Set(loaded.registry.entries.map(e => e.source.path))]) fixedRead(path);
  // Adoption is explicit selected-config data, not arbitrary filesystem search.
  const adoption = schema.object(schema.strictJson(fixedRead("contracts/templates-adoption-v1.json"), 1_048_576), ["schemaVersion", "registrySha256", "consumers"]);
  assert.equal(adoption.schemaVersion, "pa-template-adoption/v1"); assert.equal(adoption.registrySha256, selection.registrySha256);
  assert.ok(Array.isArray(adoption.consumers) && adoption.consumers.length >= 3 && adoption.consumers.length <= 64);
  const consumerRows = new Map(), covered = new Set();
  for (const consumer of adoption.consumers) {
    const row = schema.object(consumer, ["team", "mode", "templates"]), team = schema.string(row.team, /^[a-z0-9-]+$/), consumerMode = schema.string(row.mode, /^[a-z0-9-]+$/), key = `${team}/${consumerMode}`;
    assert.ok(!consumerRows.has(key)); assert.ok(Array.isArray(row.templates) && row.templates.length > 0 && row.templates.length <= 64 && new Set(row.templates).size === row.templates.length);
    const teamConfig = parseTeamYamlContent(schema.utf8(fixedRead(`teams/${team}.yaml`)));
    const selectedMode = teamConfig.deploy_modes?.find(m => m.id === consumerMode); assert.ok(selectedMode); assert.equal(teamConfig.name, team);
    const inputs = [];
    const readInstruction = (relative) => { const text = schema.utf8(fixedRead(relative)); inputs.push(text); return join(selection.root, relative); };
    const activeAgents = selectedMode.agents ? teamConfig.agents.filter(a => selectedMode.agents.includes(a.name)) : teamConfig.agents;
    for (const agent of activeAgents) if (agent.instruction) readInstruction(agent.instruction);
    for (const path of [...(teamConfig.global_docs ?? []), ...(selectedMode.global_docs ?? [])]) readInstruction(path);
    for (const skill of selectedMode.skills ?? []) readInstruction(`skills/global/${schema.relativePath(skill.name)}/SKILL.md`);
    const objective = selectedMode.objective ?? teamConfig.objective;
    if (selectedMode.objective?.endsWith(".md")) readInstruction(selectedMode.objective); else inputs.push(objective);
    const primer = generatePrimer({ runtime: "pi", teamConfig, mode: consumerMode, objective: "Read-only canonical-template adoption fixture; no execution authority.", skillsDir: join(selection.root, "skills/global"),
      templateVars: { DEPLOY_ID: "d-000001", TEAM_NAME: team, TICKET_ID: "FIX-237", TODAY: "2000-01-01" },
      resolveFile: relative => {
        if (relative.startsWith("/") || relative.startsWith("~") || relative.split("/").includes("..")) blocked("TEMPLATE_SOURCE", "primer-input");
        const path = join(selection.root, relative); if (existsSync(path)) return readInstruction(relative);
        if (relative.endsWith(".md")) blocked("TEMPLATE_SOURCE", "missing-primer-input"); return path;
      } });
    const instructions = inputs.join("\n"); assert.match(instructions, /(?:ppa template|pa_template)/);
    if (instructions.includes("pa_template") && !instructions.includes("ppa template")) assert.match(instructions, /request/);
    for (const id of row.templates) {
      const entry = loaded.registry.entries.find(e => e.id === id); assert.ok(entry);
      assert.ok(entry.contexts.some(c => (c.team === "*" || c.team === team) && (c.mode === "*" || c.mode === consumerMode)));
      assert.ok(instructions.includes(id) && primer.includes(id), "declared template reference missing from generated mode instructions"); covered.add(id);
    }
    consumerRows.set(key, row.templates);
  }
  for (const required of ["requirements/analyze", "builder/orchestrator", "requirements/review-auto"]) assert.ok(consumerRows.has(required));
  assert.equal(covered.size, loaded.registry.entries.length);
  const manifest = schema.object(schema.strictJson(fixedRead("contracts/templates-fixtures-v1.json"), 1_048_576), ["schemaVersion", "fixtures"]);
  assert.equal(manifest.schemaVersion, "pa-template-fixtures/v1");
  assert.ok(Array.isArray(manifest.fixtures)); assert.equal(manifest.fixtures.length, loaded.registry.entries.length);
  const host = { selection, team: "requirements", mode: "analyze" };
  if (loaded.registry.entries.some(e => e.id === "review-bundle")) {
    const consumer = await import(pathToFileURL(join(root, "packages/pa-core/dist/workflows/contracts.js")));
    assert.equal(typeof consumer.parseReviewBundle, "function");
    host.reviewBundleConsumer = { schemaVersion: "pa-review-bundle/v1", validate: consumer.parseReviewBundle };
  }
  const modulePaths = ["packages/pa-core/dist/index.js", "packages/pa-core/dist/templates/service.js", "packages/pa-core/dist/templates/schema.js", "packages/pa-core/dist/templates/registry.js", "packages/pa-core/dist/templates/documents.js", "packages/pa-core/dist/templates/document-profiles.js", "packages/pa-core/dist/templates/reference.js", "packages/pa-core/dist/templates/binding-contracts.js", "packages/pa-core/dist/templates/workflow-producers.js", "packages/pa-core/dist/tickets/producer-contract.js", "packages/pa-core/dist/tickets/materialization.js", "packages/pa-core/dist/validation/review-contract.js", "packages/pa-core/dist/primer/index.js", "packages/pi-pa/dist/cli.js", "packages/pi-pa/dist/adapter.js", "packages/pi-pa/dist/pi-extension/template-tool.js", "packages/pi-pa/dist/pi-extension/index.js"];
  if (host.reviewBundleConsumer) modulePaths.push("packages/pa-core/dist/workflows/contracts.js");
  const candidateModules = Object.fromEntries(modulePaths.map(path => [path, schema.digest(readReviewEvidenceFile(join(root, path), 1_048_576, "candidate.module"))]));
  let installed;
  if (mode === "selected-installed") {
    assert.equal(git(root, "status", "--porcelain=v2", "--untracked-files=all"), "", "installed qualification requires a clean exact candidate source");
    const candidates = (process.env.PATH ?? "").split(":").filter(p => p.startsWith("/")).map(p => join(p, "ppa"));
    const binary = candidates.find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
    if (!binary) blocked("TEMPLATE_INSTALLED_BINARY_REQUIRED");
    const physical = realpathSync(binary);
    const match = /^(\/nix\/store\/[a-z0-9]{32}-[^/]+)\/bin\/(?:\.ppa-wrapped|ppa)$/.exec(physical);
    if (!match) blocked("TEMPLATE_INSTALLED_PROVENANCE_REQUIRED");
    const share = join(match[1], "share/pa-platform");
    const provenance = schema.object(schema.strictJson(readReviewEvidenceFile(join(share, "review-runtime-provenance.json"), 65536, "installed.provenance")), ["schemaVersion", "sourceSha", "configSha", "packageName", "packageVersion", "objectiveSchema", "matrixSchema"]);
    assert.equal(provenance.schemaVersion, "pa-review-runtime/v1"); assert.equal(provenance.packageName, "pa-platform"); assert.equal(provenance.sourceSha, git(root, "rev-parse", "HEAD")); assert.equal(provenance.configSha, selection.configRevision);
    for (const [path, sha256] of Object.entries(candidateModules)) assert.equal(schema.digest(readReviewEvidenceFile(join(share, path), 1_048_576, "installed.module")), sha256, "installed module bytes differ from the built candidate");
    assert.equal(schema.utf8(readReviewEvidenceFile(join(share, ".pa-template-registry.sha"), 65, "installed.registryPin")).trimEnd(), selection.registrySha256);
    const native = await import(pathToFileURL(join(share, "packages/pi-pa/dist/pi-extension/template-tool.js")));
    if (host.reviewBundleConsumer) {
      const consumer = await import(pathToFileURL(join(share, "packages/pa-core/dist/workflows/contracts.js")));
      assert.equal(typeof consumer.parseReviewBundle, "function"); host.reviewBundleConsumer.validate = consumer.parseReviewBundle;
    }
    installed = { binary, createTemplateModule: native.createTemplateModule, share, sourceSha: provenance.sourceSha, binarySha256: schema.digest(readReviewEvidenceFile(physical, 1_048_576, "installed.binary")) };
  }
  const invokeCli = async (argv, body, fixtureHost) => {
    if (installed) {
      const result = spawnSync(installed.binary, argv, { env: { ...env, PA_PLATFORM_HOME: selection.root, PA_PLATFORM_TEAMS: join(selection.root, "teams"), PA_PLATFORM_CONFIG: getConfigDir(), PA_TEAM: fixtureHost.team, PA_MODE: fixtureHost.mode }, input: body, encoding: "utf8", timeout: 15000, maxBuffer: 65536, stdio: ["pipe", "pipe", "pipe"] });
      assert.ok(!result.error && !result.signal); assert.equal(result.stderr, ""); return { status: result.status, output: result.stdout };
    }
    const output = [], status = await runCoreCommand(argv, { binaryName: "ppa", templateHost: { ...fixtureHost, input: (async function* () { if (body !== undefined) yield body; })() }, io: { stdout: s => output.push(s), stderr: () => blocked("TEMPLATE_CLI") } });
    return { status, output: output.join("") };
  };
  const seen = new Set(); let comparisons = 0, negativeCases = 0;
  for (const fixture of manifest.fixtures) {
    const f = schema.object(fixture, ["id", "version", "bindings", "candidateSha256", "context"]);
    const context = schema.object(f.context, ["team", "mode"]);
    const entry = loaded.registry.entries.find(e => e.id === f.id); assert.ok(entry); assert.equal(entry.revision, f.version); assert.ok(!seen.has(f.id)); seen.add(f.id);
    const fixtureHost = { ...host, team: schema.string(context.team), mode: schema.string(context.mode) };
    assert.ok(consumerRows.get(`${fixtureHost.team}/${fixtureHost.mode}`)?.includes(f.id), "fixture context is not an adopted producer context");
    const request = { action: "render", id: f.id, version: f.version, bindings: f.bindings };
    const expected = templateService(request, fixtureHost); assert.equal(expected.ok, true, "required producer unavailable"); assert.equal(schema.digest(expected.candidate), f.candidateSha256);
    const tools = new Map(); (installed?.createTemplateModule ?? createTemplateModule)(fixtureHost)({ registerTool: t => tools.set(t.name, t) });
    const native = tools.get("pa_template"); assert.ok(native);
    for (const action of ["list", "show", "render", "validate"]) {
      const body = action === "render" ? { bindings: f.bindings } : action === "validate" ? { bindings: f.bindings, candidate: expected.candidate } : undefined;
      const input = { action, ...(action === "list" ? {} : { id: f.id, version: f.version }), ...body };
      const argv = ["template", action, ...(action === "list" ? [] : [f.id, "--version", f.version]), "--format", "json"];
      const canonical = JSON.parse(JSON.stringify(templateService(input, fixtureHost))); assert.equal(canonical.ok, true);
      for (let n = 0; n < 20; n++) {
        const cli = await invokeCli(argv, body ? JSON.stringify(body) : undefined, fixtureHost); assert.equal(cli.status, 0);
        const result = await native.execute("disposable-qualification", { request: JSON.stringify(input) }, undefined, undefined, undefined); assert.equal(result.isError, false);
        assert.deepEqual(JSON.parse(cli.output), canonical); assert.deepEqual(JSON.parse(result.content[0].text), canonical); comparisons++;
      }
    }
    const requiredBinding = Object.keys(entry.bindings).find(key => entry.bindings[key].required);
    const missing = { ...f.bindings }; if (requiredBinding) delete missing[requiredBinding];
    const missingInput = requiredBinding ? { action: "render", id: f.id, version: f.version, bindings: missing } : { action: "show", id: f.id };
    for (const input of [{ action: "show", id: f.id, version: "unsupported" }, missingInput, { action: "render", id: f.id, version: f.version, bindings: { ...f.bindings, __qualificationForeignField: "SECRET-SENTINEL" } }, { action: "validate", id: f.id, version: f.version, bindings: f.bindings, candidate: expected.candidate + "\nChanged" }]) {
      const expectedError = templateService(input, fixtureHost); assert.equal(expectedError.ok, false);
      const body = input.action === "show" ? undefined : JSON.stringify({ bindings: input.bindings, ...(input.action === "validate" ? { candidate: input.candidate } : {}) });
      const cli = await invokeCli(["template", input.action, f.id, ...(input.version === undefined ? [] : ["--version", input.version]), "--format", "json"], body, fixtureHost); assert.equal(cli.status, 1); assert.deepEqual(JSON.parse(cli.output), expectedError);
      const result = await native.execute("negative-qualification", { request: JSON.stringify(input) }, undefined, undefined, undefined); assert.equal(result.isError, true); assert.deepEqual(JSON.parse(result.content[0].text), expectedError); assert.ok(!result.content[0].text.includes("SECRET-SENTINEL")); negativeCases++;
    }
    const duplicateKey = requiredBinding ?? "undeclaredBinding";
    const escaped = `\\u${duplicateKey.charCodeAt(0).toString(16).padStart(4, "0")}${duplicateKey.slice(1)}`;
    const duplicate = `{${JSON.stringify(duplicateKey)}:${JSON.stringify(f.bindings[duplicateKey] ?? null)},"${escaped}":"SECRET-SENTINEL"}`;
    const raw = `{"action":"render","id":${JSON.stringify(f.id)},"version":${JSON.stringify(f.version)},"bindings":${duplicate}}`;
    const expectedError = templateService(raw, fixtureHost); assert.equal(expectedError.code, "TEMPLATE_DUPLICATE_KEY");
    const cli = await invokeCli(["template", "render", f.id, "--version", f.version, "--format", "json"], `{"bindings":${duplicate}}`, fixtureHost); assert.equal(cli.status, 1); assert.deepEqual(JSON.parse(cli.output), expectedError);
    const result = await native.execute("duplicate-qualification", { request: raw }, undefined, undefined, undefined); assert.equal(result.isError, true); assert.deepEqual(JSON.parse(result.content[0].text), expectedError); negativeCases++;
  }
  assert.equal(seen.size, loaded.registry.entries.length);
  assert.equal(git(selection.root, "rev-parse", "HEAD"), selection.configRevision);
  assert.equal(git(selection.root, "status", "--porcelain=v2", "--untracked-files=all"), "");
  git(selection.root, "merge-base", "--is-ancestor", selection.configRevision, "refs/remotes/origin/develop");
  for (const [relative, sha256] of observed) assert.equal(schema.digest(readReviewEvidenceFile(join(selection.root, relative), 1_048_576, "paired.reread")), sha256);
  console.log(JSON.stringify({ schemaVersion: "pa-template-qualification/v1", mode, status: "passed", selection, comparisons, negativeCases, mergeObservation: "selected revision is an ancestor of cached origin/develop; no live remote query or merge authority claim", evidenceClass: mode === "paired-config" ? "source-built-selected-pair-not-independent-review-or-UAT" : "selected-installed-disposable-not-human-UAT", instructionCoverage: "selected committed generated-primer reference/context parity; policy behavior still requires companion tests", consumers: consumerRows.size, resources: observed.size, runtime: { kind: installed ? "selected-installed" : "source-built", moduleSha256: candidateModules, ...(installed ? { moduleRoot: installed.share, packageRoot: dirname(dirname(installed.share)), sourceSha: installed.sourceSha, binarySha256: installed.binarySha256 } : {}) } }));
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: "pa-template-qualification/v1", mode: mode ?? "invalid", status: "blocked", diagnostic: `Condition: TEMPLATE_QUALIFICATION_BLOCKED\nSource: ${error.source ?? "runtime-config-qualification"}\nReason: ${typeof error.code === "string" && /^TEMPLATE_[A-Z_]+$/.test(error.code) ? error.code : "required exact pair, producer, installed selection or fixture proof is unavailable"}\nCorrection: Runtime/config owner must deliver all required paired resources and supported consumers; do not install or infer authority.\nResume Action: Reconcile the first missing prerequisite and rerun qualification.`, writes: 0, installation: false, humanUat: false }));
  process.exitCode = 1;
}
