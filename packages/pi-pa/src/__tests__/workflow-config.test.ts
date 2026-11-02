import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { appendRegistryEvent, PA_PI_EXECUTION_MODE_ENV, closeDb, captureWorkflowResources, generatePrimer, loadSelectedWorkflows, workflowReadService } from "@pa-platform/pa-core";
import { bytes, fixtureEvidence } from "../../../pa-core/src/__tests__/workflow-fixtures.js";
import { committedConfigFixture } from "../../../pa-core/src/__tests__/committed-config-fixture.js";
import { workflowRuntimeFixture } from "../../../pa-core/src/__tests__/workflow-runtime-fixture.js";
import { authenticatePiWorkflowCaller, createPiWorkflowCapture, type PiWorkflowContext } from "../workflow-native.js";
import { mutatePiWorkflow, piRetainedTemplateHost, piWorkflowReadHost } from "../workflow-host.js";
import { pinnedPiWorkflowConfig } from "../workflow-config.js";
import { createPaTemplateTool } from "../pi-extension/template-tool.js";

function fixture(legacy = false, native = false) {
  const env = process.env, cwd = process.cwd();
  process.env = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(PA_|PI_|GIT_)/.test(key) || key === "PA_SQLITE_NATIVE_BINDING"));
  const f = workflowRuntimeFixture(), config = committedConfigFixture(), repo = join(f.root, "repo"); mkdirSync(repo);
  mkdirSync(join(config.root, "operator-config"));
  writeFileSync(join(config.root, "operator-config/config.yaml"), JSON.stringify({ repos: { example: { path: repo, prefix: "EX" } } }));
  Object.assign(process.env, { PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "registry.db"), PA_TEAM: "requirements", PA_MODE: "analyze", PA_TICKET_ID: "EX-1" });
  f.bundle.repository.root = repo; f.selection = loadSelectedWorkflows(); f.bundle.workflow.sha256 = f.selection.definitions[0]!.sha256;
  for (const [ref, raw] of fixtureEvidence(f.bundle)) {
    f.evidence.set(ref, raw); const path = join(f.root, ref.slice(ref.indexOf(":") + 1)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, raw);
  }
  let cancel = true;
  const context: PiWorkflowContext = { mode: "tui", cwd: repo, sessionManager: { getSessionId: () => "synthetic-native-recovery" }, ui: { select: async (_title, choices) => cancel ? "Cancel" : choices[0] } };
  if (native) {
    execFileSync("git", ["init", "-q", "-b", "develop", repo]); process.chdir(repo);
    const id = "d-abcdef", dir = join(f.root, "deployments", id); mkdirSync(dir, { recursive: true });
    Object.assign(process.env, { [PA_PI_EXECUTION_MODE_ENV]: "foreground", PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: dir, PA_REPO: repo, PA_WORKTREE_ROOT: repo });
    appendRegistryEvent({ deployment_id: id, team: "requirements", mode: "analyze", event: "started", runtime: "pi", binary: "ppa", invocation_channel: "cli", timestamp: new Date().toISOString(), pid: process.pid, repo, repo_root: repo, worktree_root: repo, ticket_id: "EX-1" });
    f.host.authenticate = () => authenticatePiWorkflowCaller(context);
    f.host.capture = createPiWorkflowCapture(context);
  }
  if (legacy) delete f.host.resources; else f.host.resources = captureWorkflowResources;
  const request = bytes({ action: "render", id: "review-bundle", version: "1", bindings: { bundle: f.bundle } });
  const state = legacy ? f.service.admit(f.selection, bytes(f.bundle)) : f.service.admitProduced(f.selection, request, {});
  mkdirSync(join(f.root, "tickets")); writeFileSync(join(f.root, "tickets/EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", doc_refs: [{ type: "workflow", path: `registry-workflow:${state.runId}` }] }));
  return { ...f, config, state, context, approve: () => { cancel = false; }, close: () => { process.chdir(cwd); closeDb(); config.close(); f.close(); process.env = env; } };
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

test("default native mutation host recovers a cancelled package through supported continuation and compatible config advance without publication", async () => {
  const f = fixture(false, true); try {
    const cancelled = await f.service.decide(f.state.runId, 1, "approve"); assert.equal(cancelled.outcome, "cancelled");
    f.config.write("skills/requirements/analyst.md", "# New instructions\nCURRENT ONLY\n"); f.config.commit();
    // Registry/process/session authentication is real; terminal predecessor and
    // same-process successor lifecycle are disposable fixtures, not live resume.
    appendRegistryEvent({ deployment_id: "d-abcdef", team: "requirements", event: "completed", timestamp: new Date().toISOString(), status: "partial" });
    const unrelated = "d-aabbcc", unrelatedDir = join(f.root, "deployments", unrelated); mkdirSync(unrelatedDir);
    Object.assign(process.env, { PA_DEPLOYMENT_ID: unrelated, PA_DEPLOYMENT_DIR: unrelatedDir });
    appendRegistryEvent({ deployment_id: unrelated, team: "requirements", mode: "analyze", event: "started", runtime: "pi", binary: "ppa", invocation_channel: "cli", timestamp: new Date().toISOString(), pid: process.pid,
      repo: f.state.subject.repository.root, repo_root: f.state.subject.repository.root, worktree_root: f.state.subject.repository.root, ticket_id: "EX-1" });
    await assert.rejects(mutatePiWorkflow({ action: "recover", revision: 2, decisionId: cancelled.decisionId, subjectSha256: f.state.subjectSha256 }, f.context), /WORKFLOW_AUTHORITY/);
    assert.equal(f.service.status(f.state.runId).revision, 2);
    const id = "d-fedcba", dir = join(f.root, "deployments", id); mkdirSync(dir);
    Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: dir });
    appendRegistryEvent({ deployment_id: id, team: "requirements", mode: "analyze", event: "started", runtime: "pi", binary: "ppa", invocation_channel: "cli", timestamp: new Date().toISOString(), pid: process.pid,
      repo: f.state.subject.repository.root, repo_root: f.state.subject.repository.root, worktree_root: f.state.subject.repository.root, ticket_id: "EX-1", resumed_from_deployment_id: "d-abcdef" });
    f.approve();
    const result = await mutatePiWorkflow({ action: "recover", revision: 2, decisionId: cancelled.decisionId, subjectSha256: f.state.subjectSha256 }, f.context);
    assert.equal(result.ok, true); const state = f.service.status(f.state.runId);
    assert.equal(state.revision, 3); assert.deepEqual(state.resources, f.state.resources); assert.equal(state.configRevision, f.state.configRevision);
    assert.equal(state.subjectSha256, f.state.subjectSha256); assert.deepEqual(state.decisions[0], cancelled); assert.equal(state.decisions[1]!.outcome, "approved");
    assert.equal(state.decisions[1]!.captureEvidenceRef.version, "v2"); assert.equal(state.pending.length, 0); assert.equal(state.outcomes.publish, undefined);
    assert.equal(f.journal.runs(state.subject.repository.key, state.subject.ticket).length, 1);
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
