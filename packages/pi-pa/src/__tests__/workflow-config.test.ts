import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
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
import { recordPiProcessIdentity } from "../process-identity.js";
import { assertPiWorkflowCoordinatorInactive } from "../workflow-native.js";

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
    const abort = new AbortController(), select = f.context.ui!.select;
    f.context.ui!.select = async (title, choices, options) => {
      const answer = await select(title, choices, options); if (choices[0]?.startsWith("Approve")) abort.abort(); return answer;
    };
    await assert.rejects(mutatePiWorkflow({ action: "recover", revision: 2, decisionId: cancelled.decisionId, subjectSha256: f.state.subjectSha256 }, f.context, abort.signal), /cancelled-native-request/);
    assert.equal(f.service.status(f.state.runId).revision, 2); f.context.ui!.select = select;
    const result = await mutatePiWorkflow({ action: "recover", revision: 2, decisionId: cancelled.decisionId, subjectSha256: f.state.subjectSha256 }, f.context);
    assert.equal(result.ok, true); const state = f.service.status(f.state.runId);
    assert.equal(state.revision, 3); assert.deepEqual(state.resources, f.state.resources); assert.equal(state.configRevision, f.state.configRevision);
    assert.equal(state.subjectSha256, f.state.subjectSha256); assert.deepEqual(state.decisions[0], cancelled); assert.equal(state.decisions[1]!.outcome, "approved");
    assert.equal(state.decisions[1]!.captureEvidenceRef.version, "v2"); assert.equal(state.pending.length, 0); assert.equal(state.outcomes.publish, undefined);
    assert.equal(f.journal.runs(state.subject.repository.key, state.subject.ticket).length, 1);
  } finally { f.close(); }
});

test("fresh default foreground host adopts a dead coordinator without resume, then recovers the same package", async () => {
  const f = fixture(); const child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdout.write('ready');"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    const repo = f.state.subject.repository.root, oldDir = join(f.root, "deployments/d-abcdef"); mkdirSync(oldDir, { recursive: true });
    appendRegistryEvent({ deployment_id: "d-abcdef", team: "requirements", mode: "analyze", event: "started", runtime: "pi", binary: "ppa", timestamp: new Date().toISOString(), pid: child.pid!, repo, repo_root: repo, worktree_root: repo, ticket_id: "EX-1" });
    assert.equal(recordPiProcessIdentity("d-abcdef", oldDir, child.pid!), true);
    const capture = f.host.capture; f.host.capture = async r => ({ ...await capture(r), outcome: "cancelled" });
    const cancelled = await f.service.decide(f.state.runId, 1, "approve");
    appendRegistryEvent({ deployment_id: "d-abcdef", team: "requirements", event: "completed", timestamp: new Date().toISOString(), status: "partial" });
    assert.throws(() => assertPiWorkflowCoordinatorInactive(f.state.caller), /coordinator-live/);
    execFileSync("git", ["init", "-q", "-b", "develop", repo]); process.chdir(repo);
    const id = "d-fedcba", dir = join(f.root, "deployments", id); mkdirSync(dir);
    Object.assign(process.env, { [PA_PI_EXECUTION_MODE_ENV]: "foreground", PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: dir, PA_REPO: repo, PA_WORKTREE_ROOT: repo });
    appendRegistryEvent({ deployment_id: id, team: "requirements", mode: "analyze", event: "started", runtime: "pi", binary: "ppa", invocation_channel: "cli", timestamp: new Date().toISOString(), pid: process.pid, repo, repo_root: repo, worktree_root: repo, ticket_id: "EX-1" });
    const adoption = { action: "adopt" as const, revision: 2, subjectSha256: f.state.subjectSha256 };
    await assert.rejects(mutatePiWorkflow(adoption, f.context), /coordinator-live/);
    const liveView = workflowReadService('{"action":"status","ticket":"EX-1"}', piWorkflowReadHost(f.context)) as any;
    assert.equal(liveView.result.coordinatorContinuation.caller.status, "blocked"); assert.equal(liveView.result.coordinatorContinuation.caller.gateId, "coordinator-live");
    const exited = once(child, "exit"); child.stdin!.end(); await exited;
    const eligibleView = workflowReadService('{"action":"status","ticket":"EX-1"}', piWorkflowReadHost(f.context)) as any;
    assert.equal(eligibleView.result.coordinatorContinuation.caller.status, "eligible-for-native-adoption-consent");
    // Cancellation creates neither a succession nor a package decision.
    assert.equal((await mutatePiWorkflow(adoption, f.context)).ok, true); assert.equal(f.service.status(f.state.runId).revision, 2);
    f.approve(); const before = f.journal.read(f.state.runId);
    const adopted = await mutatePiWorkflow(adoption, f.context); assert.equal(adopted.ok, true);
    const state = f.service.status(f.state.runId); assert.equal(state.coordinator!.deploymentId, id); assert.deepEqual(state.caller, f.state.caller);
    assert.deepEqual(f.journal.read(state.runId).slice(0, 2), before); assert.deepEqual(state.resources, f.state.resources);
    const adoptedView = workflowReadService('{"action":"status","ticket":"EX-1"}', piWorkflowReadHost(f.context)) as any;
    assert.equal(adoptedView.result.coordinatorContinuation.caller.status, "authenticated-coordinator");
    const recovered = await mutatePiWorkflow({ action: "recover", revision: 3, decisionId: cancelled.decisionId, subjectSha256: state.subjectSha256 }, f.context);
    assert.equal(recovered.ok, true); assert.equal(f.service.status(state.runId).decisions.at(-1)!.outcome, "approved");
    assert.equal(f.journal.runs("example", "EX-1").length, 1); assert.equal(f.service.status(state.runId).pending.length, 0);
  } finally { child.stdin?.end(); f.close(); }
});

test("native adoption denies missing anchors, PID reuse, unsettled owners and live explicit resume descendants", async () => {
  const f = fixture(); const child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdout.write('ready');"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data"); const owner = f.state.caller, repo = owner.repoRoot, dir = join(f.root, "deployments", owner.deploymentId); mkdirSync(dir, { recursive: true });
    appendRegistryEvent({ deployment_id: owner.deploymentId, team: owner.team, mode: owner.mode, event: "started", runtime: "pi", binary: "ppa", timestamp: new Date().toISOString(), pid: child.pid!, repo, repo_root: repo, worktree_root: repo, ticket_id: owner.ticket });
    assert.throws(() => assertPiWorkflowCoordinatorInactive(owner), /coordinator-lifecycle-unsettled/);
    appendRegistryEvent({ deployment_id: owner.deploymentId, team: owner.team, event: "completed", timestamp: new Date().toISOString(), status: "partial" });
    assert.throws(() => assertPiWorkflowCoordinatorInactive(owner), /coordinator-liveness-unknown/);
    recordPiProcessIdentity(owner.deploymentId, dir, child.pid!);
    const path = join(dir, "pi-process-identity.json"), original = readFileSync(path, "utf8"), tampered = JSON.parse(original); tampered.processFingerprint.startTimeTicks = "0";
    writeFileSync(path, JSON.stringify(tampered)); assert.throws(() => assertPiWorkflowCoordinatorInactive(owner), /coordinator-pid-reused/); writeFileSync(path, original);
    const exited = once(child, "exit"); child.stdin!.end(); await exited;
    assert.doesNotThrow(() => assertPiWorkflowCoordinatorInactive(owner));
    // A live audit session without a resume edge is not the owning coordinator.
    appendRegistryEvent({ deployment_id: "d-aabbcc", team: owner.team, mode: owner.mode, event: "started", runtime: "pi", binary: "ppa", timestamp: new Date().toISOString(), pid: process.pid, repo, repo_root: repo, worktree_root: repo, ticket_id: owner.ticket });
    assert.doesNotThrow(() => assertPiWorkflowCoordinatorInactive(owner));
    appendRegistryEvent({ deployment_id: "d-fedcba", team: owner.team, mode: owner.mode, event: "started", runtime: "pi", binary: "ppa", timestamp: new Date().toISOString(), pid: process.pid, repo, repo_root: repo, worktree_root: repo, ticket_id: owner.ticket, resumed_from_deployment_id: owner.deploymentId });
    assert.throws(() => assertPiWorkflowCoordinatorInactive(owner), /coordinator-lifecycle-unsettled/);
  } finally { child.stdin?.end(); f.close(); }
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
