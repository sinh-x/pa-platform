import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { closeDb, captureWorkflowResources, generatePrimer, loadSelectedWorkflows, workflowReadService } from "@pa-platform/pa-core";
import { bytes, fixtureEvidence } from "../../../pa-core/src/__tests__/workflow-fixtures.js";
import { committedConfigFixture } from "../../../pa-core/src/__tests__/committed-config-fixture.js";
import { workflowRuntimeFixture } from "../../../pa-core/src/__tests__/workflow-runtime-fixture.js";
import { piRetainedTemplateHost, piWorkflowReadHost } from "../workflow-host.js";
import { pinnedPiWorkflowConfig } from "../workflow-config.js";
import { createPaTemplateTool } from "../pi-extension/template-tool.js";

function fixture(legacy = false) {
  const env = process.env;
  process.env = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(PA_|PI_|GIT_)/.test(key) || key === "PA_SQLITE_NATIVE_BINDING"));
  const f = workflowRuntimeFixture(), config = committedConfigFixture(), repo = join(f.root, "repo"); mkdirSync(repo);
  mkdirSync(join(config.root, "operator-config"));
  writeFileSync(join(config.root, "operator-config/config.yaml"), JSON.stringify({ repos: { example: { path: repo, prefix: "EX" } } }));
  Object.assign(process.env, { PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "registry.db"), PA_TEAM: "requirements", PA_MODE: "analyze", PA_TICKET_ID: "EX-1" });
  f.bundle.repository.root = repo; f.selection = loadSelectedWorkflows(); f.bundle.workflow.sha256 = f.selection.definitions[0]!.sha256;
  for (const [ref, raw] of fixtureEvidence(f.bundle)) {
    f.evidence.set(ref, raw); const path = join(f.root, ref.slice(ref.indexOf(":") + 1)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, raw);
  }
  if (legacy) delete f.host.resources; else f.host.resources = captureWorkflowResources;
  const request = bytes({ action: "render", id: "review-bundle", version: "1", bindings: { bundle: f.bundle } });
  const state = legacy ? f.service.admit(f.selection, bytes(f.bundle)) : f.service.admitProduced(f.selection, request, {});
  mkdirSync(join(f.root, "tickets")); writeFileSync(join(f.root, "tickets/EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", doc_refs: [{ type: "workflow", path: `registry-workflow:${state.runId}` }] }));
  return { ...f, config, state, close: () => { closeDb(); config.close(); f.close(); process.env = env; } };
}

test("default native template host and planner retain the exact run config after compatible selected changes", async () => {
  const f = fixture(); try {
    f.config.write("skills/requirements/analyst.md", "# New current analyst\nCURRENT ONLY\n");
    const current = f.config.commit(); assert.notEqual(current, f.state.configRevision);
    const host = piRetainedTemplateHost(); assert.equal(host.selection!.configRevision, f.state.configRevision);
    assert.match(Buffer.from(host.resources!.get("skills/requirements/analyst.md")!).toString(), /Read \[the shared guide\]/);
    const tool = createPaTemplateTool();
    const view = await tool.execute("native-retained", { request: '{"action":"list"}' }, undefined, undefined, {});
    const result = JSON.parse(view.content[0]!.text);
    assert.equal(result.ok, true); assert.equal(result.registry.configRevision, f.state.configRevision);
    const pinned = pinnedPiWorkflowConfig({ team: "requirements", mode: "analyze", ticket: "EX-1" })!;
    const directory = join(f.root, "new-deployment"); mkdirSync(directory); const root = pinned.materialize(directory);
    const primer = generatePrimer({ runtime: "pi", teamConfig: pinned.team, mode: "analyze", configResourceRoot: root, skillsDir: join(root, "skills/global"), resolveFile: relative => join(root, relative) });
    assert.ok(primer.includes("Read [the shared guide]")); assert.ok(!primer.includes("CURRENT ONLY"));
    assert.match(readFileSync(join(root, "skills/global/pa-startup/SKILL.md"), "utf8"), /Inspect current bulletins/);
    const preflight = workflowReadService('{"action":"preflight","ticket":"EX-1"}', piWorkflowReadHost());
    assert.equal(preflight.ok, true); assert.equal((preflight.result as any).status, "static-compatible");
    assert.equal((preflight.result as any).selected.configRevision, f.state.configRevision);
    // Current unsupported contracts cannot silently become the retained run's producer.
    Object.assign(f.config.registry, { runtimeContract: "pa-template-runtime/future" }); f.config.commit();
    assert.equal((workflowReadService('{"action":"preflight","ticket":"EX-1"}', piWorkflowReadHost()).result as any).status, "static-compatible");
    assert.equal(JSON.parse((await tool.execute("still-retained", { request: '{"action":"list"}' }, undefined, undefined, {})).content[0]!.text).ok, true);
  } finally { f.close(); }
});

test("retained native selection denies changed physical root/unretained route instead of falling back", async () => {
  const f = fixture(); try {
    process.env.PA_MODE = "unsupported";
    assert.throws(() => piRetainedTemplateHost(), /retained-resource-closure/);
    assert.throws(() => pinnedPiWorkflowConfig({ team: "requirements", mode: "unsupported", ticket: "EX-1" }), /retained-resource-closure/);
    process.env.PA_MODE = "analyze"; process.env.PA_PLATFORM_HOME = f.root;
    assert.throws(() => piRetainedTemplateHost(), /retained-resource-closure/);
    const response = await createPaTemplateTool().execute("denied", { request: '{"action":"list"}' }, undefined, undefined, {});
    assert.equal(response.isError, true); assert.equal(JSON.parse(response.content[0]!.text).code, "TEMPLATE_PAIR");
  } finally { f.close(); }
});

test("legacy native continuation is readable but cannot acquire current templates or planner instructions", async () => {
  const f = fixture(true); try {
    const status = workflowReadService('{"action":"status","ticket":"EX-1"}', piWorkflowReadHost());
    assert.equal(status.ok, true); assert.equal((status.result as any).resourceState, "legacy-missing");
    assert.throws(() => piRetainedTemplateHost(), /retained-resource-closure/);
    assert.throws(() => pinnedPiWorkflowConfig({ team: "requirements", mode: "analyze", ticket: "EX-1" }), /retained-resource-closure/);
    const result = await createPaTemplateTool().execute("legacy", { request: '{"action":"list"}' }, undefined, undefined, {});
    assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0]!.text).code, "TEMPLATE_PAIR");
    assert.equal(f.service.status(f.state.runId).resources, undefined);
  } finally { f.close(); }
});
