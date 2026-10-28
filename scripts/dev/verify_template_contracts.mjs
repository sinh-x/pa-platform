#!/usr/bin/env node
/** Read-only qualification. Never installs, launches a product, writes tickets or
 * executes config-provided code. Missing cases/resources are blocking failures. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
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
  const selection = registry.selectedTemplates();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...args) => execFileSync("git", ["--no-optional-locks", "--no-replace-objects", "-C", cwd, ...args], { env, encoding: "utf8", timeout: 15000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.equal(git(selection.root, "rev-parse", "--show-toplevel"), selection.root);
  assert.equal(git(selection.root, "rev-parse", "HEAD"), selection.configRevision);
  assert.equal(git(selection.root, "status", "--porcelain=v2", "--untracked-files=all"), "");
  const loaded = registry.loadTemplateRegistry(selection);
  const fixedRead = (relative) => readReviewEvidenceFile(join(selection.root, relative), 1_048_576, "paired.template");
  // Prove tracked bytes at the exact selected commit, not a self-declared label.
  for (const path of ["contracts/templates-v1.json", ...new Set(loaded.registry.entries.map(e => e.source.path))]) {
    const committed = execFileSync("git", ["--no-replace-objects", "-C", selection.root, "show", `${selection.configRevision}:${path}`], { env, timeout: 15000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(schema.digest(committed), schema.digest(fixedRead(path)));
  }
  for (const path of ["teams/requirements/modes/analyze.md", "teams/builder/modes/orchestrator.md", "teams/requirements/modes/review-auto.md"]) {
    assert.match(schema.utf8(fixedRead(path)), /(?:ppa template|pa_template)/);
  }
  const manifest = schema.object(schema.strictJson(fixedRead("contracts/templates-fixtures-v1.json"), 1_048_576), ["schemaVersion", "fixtures"]);
  assert.equal(manifest.schemaVersion, "pa-template-fixtures/v1");
  assert.ok(Array.isArray(manifest.fixtures)); assert.equal(manifest.fixtures.length, loaded.registry.entries.length);
  const host = { selection, team: "requirements", mode: "analyze" };
  if (loaded.registry.entries.some(e => e.id === "review-bundle")) {
    const consumer = await import(pathToFileURL(join(root, "packages/pa-core/dist/workflows/contracts.js")));
    assert.equal(typeof consumer.parseReviewBundle, "function");
    host.reviewBundleConsumer = { schemaVersion: "pa-review-bundle/v1", validate: consumer.parseReviewBundle };
  }
  let installed;
  if (mode === "selected-installed") {
    const candidates = (process.env.PATH ?? "").split(":").filter(p => p.startsWith("/")).map(p => join(p, "ppa"));
    const binary = candidates.find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
    if (!binary) blocked("TEMPLATE_INSTALLED_BINARY_REQUIRED");
    const physical = realpathSync(binary);
    const match = /^(\/nix\/store\/[a-z0-9]{32}-[^/]+)\/bin\/(?:\.ppa-wrapped|ppa)$/.exec(physical);
    if (!match) blocked("TEMPLATE_INSTALLED_PROVENANCE_REQUIRED");
    const share = join(match[1], "share/pa-platform");
    const provenance = schema.object(schema.strictJson(readReviewEvidenceFile(join(share, "review-runtime-provenance.json"), 65536, "installed.provenance")), ["schemaVersion", "sourceSha", "configSha", "packageName", "packageVersion", "objectiveSchema", "matrixSchema"]);
    assert.equal(provenance.schemaVersion, "pa-review-runtime/v1"); assert.equal(provenance.sourceSha, git(root, "rev-parse", "HEAD")); assert.equal(provenance.configSha, selection.configRevision);
    assert.equal(schema.utf8(readReviewEvidenceFile(join(share, ".pa-template-registry.sha"), 65, "installed.registryPin")).trimEnd(), selection.registrySha256);
    const native = await import(pathToFileURL(join(share, "packages/pi-pa/dist/pi-extension/template-tool.js")));
    if (host.reviewBundleConsumer) {
      const consumer = await import(pathToFileURL(join(share, "packages/pa-core/dist/workflows/contracts.js")));
      assert.equal(typeof consumer.parseReviewBundle, "function"); host.reviewBundleConsumer.validate = consumer.parseReviewBundle;
    }
    installed = { binary, createTemplateModule: native.createTemplateModule, share };
  }
  const seen = new Set(); let comparisons = 0;
  for (const fixture of manifest.fixtures) {
    const f = schema.object(fixture, ["id", "version", "bindings", "candidateSha256", "context"]);
    const context = schema.object(f.context, ["team", "mode"]);
    const entry = loaded.registry.entries.find(e => e.id === f.id); assert.ok(entry); assert.equal(entry.revision, f.version); assert.ok(!seen.has(f.id)); seen.add(f.id);
    const fixtureHost = { ...host, team: schema.string(context.team), mode: schema.string(context.mode) };
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
        let cli;
        if (installed) cli = execFileSync(installed.binary, argv, { env: { ...env, PA_PLATFORM_HOME: selection.root, PA_PLATFORM_TEAMS: join(selection.root, "teams"), PA_TEAM: fixtureHost.team, PA_MODE: fixtureHost.mode }, input: body ? JSON.stringify(body) : undefined, encoding: "utf8", timeout: 15000, maxBuffer: 65536, stdio: ["pipe", "pipe", "pipe"] });
        else { const output = []; assert.equal(await runCoreCommand(argv, { binaryName: "ppa", templateHost: { ...fixtureHost, input: (async function* () { if (body) yield JSON.stringify(body); })() }, io: { stdout: s => output.push(s), stderr: () => blocked("TEMPLATE_CLI") } }), 0); cli = output.join(""); }
        const result = await native.execute("disposable-qualification", input, undefined, undefined, undefined); assert.equal(result.isError, false);
        assert.deepEqual(JSON.parse(cli), canonical); assert.deepEqual(JSON.parse(result.content[0].text), canonical); comparisons++;
      }
    }
  }
  assert.equal(seen.size, loaded.registry.entries.length);
  console.log(JSON.stringify({ schemaVersion: "pa-template-qualification/v1", mode, status: "passed", selection, comparisons, evidenceClass: mode === "paired-config" ? "source-built-selected-pair-not-independent-review-or-UAT" : "selected-installed-disposable-not-human-UAT", instructionCoverage: "fixed-source-discovery-only; generated-primer behavior needs companion tests" }));
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: "pa-template-qualification/v1", mode: mode ?? "invalid", status: "blocked", diagnostic: `Condition: TEMPLATE_QUALIFICATION_BLOCKED\nSource: ${error.source ?? "runtime-config-qualification"}\nReason: ${typeof error.code === "string" && /^TEMPLATE_[A-Z_]+$/.test(error.code) ? error.code : "required exact pair, producer, installed selection or fixture proof is unavailable"}\nCorrection: Runtime/config owner must deliver all required paired resources and supported consumers; do not install or infer authority.\nResume Action: Reconcile the first missing prerequisite and rerun qualification.`, writes: 0, installation: false, humanUat: false }));
  process.exitCode = 1;
}
