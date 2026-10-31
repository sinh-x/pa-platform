import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { block, digest } from "./workflow_installed_support.mjs";

/** Invoked ONLY in an isolated child with the parent's verified fixed frame.
 * Actual default CLI/native hosts, never caller-authored outcomes/callbacks. */
export async function qualifyInstalledEntries(frame) {
  const module = path => import(pathToFileURL(join(frame.share, path)).href);
  const core = await module("packages/pa-core/dist/index.js");
  const { createJsonWorkflowModule } = await module("packages/pi-pa/dist/pi-extension/workflow.js");
  const { createTemplateModule } = await module("packages/pi-pa/dist/pi-extension/template-tool.js");
  const { piWorkflowReadHost } = await module("packages/pi-pa/dist/workflow-host.js");
  const { workflowRuntimeFixture } = await import(pathToFileURL(join(frame.harness, "packages/pa-core/src/__tests__/workflow-runtime-fixture.js")).href);
  const f = workflowRuntimeFixture(), originalEnvironment = { ...process.env };
  const rows = [], resources = {};
  try {
    mkdirSync(join(f.root, "tickets")); mkdirSync(join(f.root, "config"));
    Object.assign(process.env, { PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "registry.db"), PA_PLATFORM_CONFIG: join(f.root, "config"),
      PA_PLATFORM_HOME: frame.selection.root, PA_PLATFORM_TEAMS: join(frame.selection.root, "teams"), PA_TEAM: "requirements", PA_MODE: "analyze" });
    writeFileSync(join(f.root, "config/config.yaml"), `repos:\n  ${f.bundle.repository.key}:\n    path: ${f.bundle.repository.root}\n`);
    writeFileSync(join(f.root, `tickets/${f.bundle.ticket}.json`), JSON.stringify({ id: f.bundle.ticket, project: f.bundle.repository.key, title: "Synthetic installed read fixture", doc_refs: [] }));
    for (const [ref, bytes] of f.evidence) { const path = join(f.root, ref.slice(ref.indexOf(":") + 1)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
    const state = f.service.admit(f.selection, f.subject), decision = await f.service.decide(state.runId, 1, "approve");
    const tools = new Map(); createJsonWorkflowModule()({ registerTool: tool => tools.set(tool.name, tool) }); createTemplateModule()({ registerTool: tool => tools.set(tool.name, tool) });
    const cli = (args, input) => {
      const result = spawnSync(frame.binary, args, { env: process.env, input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 15000, maxBuffer: 65536, stdio: ["pipe", "pipe", "pipe"] });
      if (result.error || result.signal || result.stderr) block("WORKFLOW_PUBLIC_CLI_FAILED", "installed-entry-points");
      return { status: result.status, value: JSON.parse(result.stdout) };
    };
    const native = async (name, request) => {
      const result = await tools.get(name).execute("installed-disposable-qualification", { request: typeof request === "string" ? request : JSON.stringify(request) }, undefined, undefined, {});
      return { status: result.isError ? 1 : 0, value: JSON.parse(result.content[0].text) };
    };
    const compare = async (name, args, request) => {
      const expected = cli(args), actual = await native(name, request); assert.deepEqual(actual, expected);
      rows.push({ tool: name, action: request.action, status: actual.status, responseSha256: digest(Buffer.from(JSON.stringify(actual.value))) }); return actual.value;
    };
    const list = await compare("pa_workflow", ["workflow", "list", "--json"], { action: "list" }); assert.equal(list.ok, true);
    const manifest = JSON.parse(readFileSync(join(frame.selection.root, "workflows/manifest.json"), "utf8"));
    for (const d of manifest.definitions) {
      assert.equal((await compare("pa_workflow", ["workflow", "show", "--id", d.workflowId, "--json"], { action: "show", id: d.workflowId })).ok, true);
      assert.equal((await compare("pa_workflow", ["workflow", "validate", "--definition-file", join(frame.selection.root, d.file), "--json"], { action: "validate", definitionFile: join(frame.selection.root, d.file) })).ok, true);
    }
    for (const action of ["preflight", "status", "next"]) assert.equal((await compare("pa_workflow", ["workflow", action, "--ticket", f.bundle.ticket, "--json"], { action, ticket: f.bundle.ticket })).ok, true);
    for (const action of ["show", "verify"]) assert.equal((await compare("pa_decision", ["decision", action, "--ticket", f.bundle.ticket, "--id", decision.decisionId, "--json"], { action, ticket: f.bundle.ticket, id: decision.decisionId })).ok, true);
    for (const request of [{ action: "status", ticket: f.bundle.ticket, actor: "PRIVATE-SENTINEL" }, { action: "capture", revision: 2, stepId: "approve", outcome: "approved" }, { action: "force-complete", passed: true }]) {
      const result = await native(request.action === "capture" ? "pa_decision" : "pa_workflow", request); assert.equal(result.status, 1); assert.ok(!JSON.stringify(result.value).includes("PRIVATE-SENTINEL"));
      rows.push({ tool: "native-negative", action: request.action, status: 1 });
    }
    const selected = core.loadSelectedWorkflows(), templates = core.selectedTemplates(), registered = piWorkflowReadHost().operations;
    for (const definition of selected.definitions) for (const step of definition.definition.steps) if (!(step.kind === "decision" && step.operation.id === "decision.package") && !registered.has(step.operation.id)) block("WORKFLOW_SELECTED_OPERATION_UNSUPPORTED");
    if (selected.bindings.some(binding => binding.enabled && (binding.team !== "requirements" || binding.mode !== "analyze"))) block("WORKFLOW_SELECTED_ROUTE_UNSUPPORTED");
    const configRead = path => { const bytes = readFileSync(join(frame.selection.root, path)); resources[path] = digest(bytes); return bytes; };
    const fixtures = configRead("workflows/fixtures-v1.json"), paired = core.validateWorkflowPair(selected, templates, fixtures, configRead);
    const cases = JSON.parse(fixtures).fixtures;
    for (const fixture of cases) {
      const producer = JSON.parse(fixture.producer), input = { bindings: producer.bindings };
      const rendered = cli(["template", "render", producer.id, "--version", producer.version, "--format", "json"], input), tool = await native("pa_template", producer);
      assert.deepEqual(tool, rendered); assert.equal(tool.status, 0); assert.equal(digest(Buffer.from(tool.value.candidate)), fixture.candidateSha256);
      const validated = cli(["template", "validate", producer.id, "--version", producer.version, "--format", "json"], { ...input, candidate: tool.value.candidate });
      assert.deepEqual(await native("pa_template", { ...producer, action: "validate", candidate: tool.value.candidate }), validated); assert.equal(validated.status, 0);
      rows.push({ tool: "pa_template", action: "fixture-render-validate", fixture: fixture.id, status: 0 });
    }
    // Real selected instructions/definition + installed pinned-primer generator.
    // Disabled drafts stay disabled; no enabled copy or live admission is made.
    const team = core.loadTeamConfig("requirements"), view = { runId: state.runId, workflowId: selected.definitions[0].definition.workflowId,
      version: selected.definitions[0].definition.version, sha256: selected.definitions[0].sha256, configRevision: selected.configRevision, nextOwner: "operator", nextAction: "inspect exact retained package" };
    const primer = core.generatePrimer({ runtime: "pi", teamConfig: team, mode: "analyze", objective: "Installed disposable pinned projection, never approval", workflow: view,
      skillsDir: join(frame.selection.root, "skills/global"), templateVars: { DEPLOY_ID: "d-000001", TEAM_NAME: "requirements", TICKET_ID: f.bundle.ticket, TODAY: "2000-01-01" },
      resolveFile: path => { if (path.startsWith("/") || path.split("/").includes("..")) block("WORKFLOW_PRIMER_PATH"); const file = join(frame.selection.root, path); if (existsSync(file) || path.endsWith(".md")) configRead(path); return file; } });
    for (const value of [view.runId, view.workflowId, view.sha256, view.configRevision, view.nextAction]) assert.ok(primer.includes(value));
    return { cases: [{ id: "installed-entry-points", status: "passed", observations: rows.length, rows }, { id: "paired-handoffs", status: "passed", observations: paired.fixtures.length, fixtures: paired.fixtures },
      { id: "selected-procedure", status: "passed", observations: 1, primerSha256: digest(Buffer.from(primer)), bindings: selected.bindings.map(b => ({ team: b.team, mode: b.mode, enabled: b.enabled })), limitation: "Pinned generated projection and typed selected fixtures; instruction-policy adoption/legacy coexistence still requires the independent paired matrix and human acceptance." }], resources,
      humanApproval: false, syntheticCapture: true };
  } finally { process.env = originalEnvironment; f.close(); core.closeDb(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const frame = JSON.parse(readFileSync(process.argv[2], "utf8")); console.log(JSON.stringify(await qualifyInstalledEntries(frame))); }
  catch { console.log(JSON.stringify({ status: "blocked", code: "WORKFLOW_INSTALLED_ENTRY_CASE_FAILED" })); process.exitCode = 1; }
}
