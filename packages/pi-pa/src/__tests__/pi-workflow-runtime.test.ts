import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createTicketWorkflowOwners, TicketStore, appendRegistryEvent, closeDb, materializeTicketBranch, parseReviewMatrixPlan, workflowDecisionReference, structuredReviewArtifact, type ReviewMatrix, type RuntimeAdapter } from "@pa-platform/pa-core";
import { workflowRuntimeFixture } from "../../../pa-core/src/__tests__/workflow-runtime-fixture.js";
import { bytes } from "../../../pa-core/src/__tests__/workflow-fixtures.js";
import { digest } from "../../../pa-core/src/workflows/contracts.js";
import { authorizePiStructuredWork, parseStructuredLaunchNote, resolvePiStructuredBaseline, structuredLaunchNote } from "../workflow-consumers.js";
import { ProjectCommandContract } from "../project-command-contract.js";
import { createPiWorkflowContinuation } from "../workflow-native.js";
import { deployWithPi } from "../deploy.js";
import { PiNativeExecutionAdapter } from "../execution-native.js";
import { PiPreparedNativeAuthority } from "../prepared-native.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { TreehouseClient } from "./treehouse-fixture.js";
import { createJsonWorkflowModule } from "../pi-extension/workflow.js";
import type { PiToolDefinition, PiRuntime } from "../pi-extension/index.js";
import { workflowReadService, workflowPrimerView, generatePrimer } from "@pa-platform/pa-core";

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, amendment = false) {
  const env = process.env; process.env = { ...env };
  for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key) && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
  const f = workflowRuntimeFixture();
  try { await run(await setup(f, amendment)); } finally { closeDb(); f.close(); process.env = env; }
}
async function setup(f: ReturnType<typeof workflowRuntimeFixture>, amendment = false) {
  Object.assign(process.env, { PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "registry.db"), PA_PLATFORM_CONFIG: join(f.root, "config") });
  const repo = join(f.root, "repo"), checkout = join(f.root, "checkout"); mkdirSync(repo); mkdirSync(join(f.root, "config")); mkdirSync(join(f.root, "tickets"));
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "develop"]); git(["config", "user.name", "Synthetic fixture"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "commit.gpgsign", "false"]); git(["config", "core.hooksPath", "/dev/null"]);
  const script = "process.exit(0)\n"; writeFileSync(join(repo, "check.cjs"), script);
  const profile = JSON.stringify({ schemaVersion: "project-command-contract/v1", effects: ["project-read", "isolated-temp-write"], checks: [{ id: "check", executable: realpathSync(process.execPath), argv: ["check.cjs"], environment: {}, readPaths: [], prerequisites: [{ path: "check.cjs", sha256: digest(script) }], timeoutSeconds: 10, maximumOutputBytes: 1024 }] });
  writeFileSync(join(repo, "checks.json"), profile); git(["add", "."]); git(["commit", "-qm", "fixture base"]);
  const base = git(["rev-parse", "HEAD"]);
  git(amendment ? ["worktree", "add", "-b", f.bundle.handoff.branch, checkout, base] : ["worktree", "add", "--detach", checkout, base]);
  if (amendment) f.bundle.handoff = { type: "amendment", baseSha: base, featureSha: base, branch: f.bundle.handoff.branch, branchAction: "reuse" };
  writeFileSync(join(f.root, "config/config.yaml"), `repos:\n  example:\n    path: ${repo}\n    prefix: EX\n    projectCommands:\n      manifest: checks.json\n      sha256: ${digest(profile)}\n`);
  f.bundle.repository.root = repo; f.bundle.handoff.baseSha = base;
  const original = readFileSync(new URL("../../../pa-core/src/__tests__/fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url));
  const m: ReviewMatrix = parseReviewMatrixPlan(original, "requirements:agent-teams/requirements/artifacts/fixture-producer-node-pnpm.md").matrix;
  m.source = f.bundle.requirements.ref; m.repository = { ...f.bundle.repository, baseSha: base, branch: f.bundle.handoff.branch };
  m.environment.PA_TICKET_ID = { literal: "EX-1" }; m.prerequisites = m.prerequisites.map(p => p.kind === "operatorGate" ? { ...p, ticket: "EX-1" } : p); m.commands[0]!.command = "node 'check.cjs'";
  const requirements = Buffer.from(`# Synthetic subject: deliberately no approval headers or paragraphs\n\n### Full Validation Matrix\n\nMatrix Source: ${m.source}\n\n\`\`\`json\n${JSON.stringify(m)}\n\`\`\`\n\n## After\n`), uat = Buffer.from("Synthetic UAT plan only\n");
  f.bundle.requirements.sha256 = digest(requirements); f.bundle.uat.sha256 = digest(uat); f.bundle.matrix.sha256 = parseReviewMatrixPlan(requirements, m.source).digest;
  f.bundle.scope.checks = [{ matrixSource: m.source, matrixSha256: f.bundle.matrix.sha256, commandId: m.commands[0]!.id }];
  f.evidence.set(f.bundle.requirements.ref, requirements); f.evidence.set(f.bundle.uat.ref, uat);
  for (const [ref, raw] of f.evidence) { const path = join(f.root, ref.slice(ref.indexOf(":") + 1)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, raw); }
  const ticketPath = join(f.root, "tickets/EX-1.json");
  const ticket = { id: "EX-1", project: "example", title: "Synthetic workflow runtime fixture", status: "pending-implementation", assignee: "builder/team-manager", linkedBranches: [{ repo: "example", branch: f.bundle.handoff.branch, state: amendment ? "materialized" : "planned", ...(amendment ? { baseSha: base, headSha: base, sha: base } : {}) }], doc_refs: [{ type: "requirements", primary: true, path: m.source.slice("requirements:".length) }, { type: "uat", primary: false, path: f.bundle.uat.ref.slice("uat:".length) }], comments: [] };
  writeFileSync(ticketPath, JSON.stringify(ticket));
  const d = f.selection.definitions[0]!.definition;
  d.requiredCapabilities.push("ticket.queue"); d.steps[1]!.transitions.completed = "queue";
  d.steps.push({ id: "queue", order: 3, title: "Queue exact pair", kind: "action", owner: "tickets", dependsOn: [{ stepId: "publish", outcome: "completed" }], when: true,
    inputs: [{ name: "pair", schemaVersion: "pa-publication-pair/v1", source: "output", stepId: "publish", output: "pair" }, { name: "decision", schemaVersion: "pa-decision/v1", source: "output", stepId: "approve", output: "decision" }],
    operation: { id: "ticket.queue", version: "v1" }, authorization: ["ticket.queue.advance"], effects: ["ticket.queue"], outputs: [{ name: "queue", schemaVersion: "pa-ticket-queue-result/v1" }], verification: [{ id: "ticket.queue-observed", version: "v1", inputs: ["pair", "decision"] }],
    transitions: { completed: "completed", failed: "blocked", unknown: "blocked" }, failurePolicy: { strategy: "reconcile", correctionOwner: "tickets" } });
  const definition = bytes(d); f.bundle.workflow.sha256 = digest(definition);
  f.selection = { ...f.selection, definitions: f.selection.definitions.map(row => ({ ...row, raw: definition, sha256: digest(definition) })) };
  const owners = createTicketWorkflowOwners(f.journal, new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true }), f.root, f.host.authenticate);
  for (const [id, owner] of owners) (f.host.owners as Map<string, typeof owner>).set(id, owner);
  const admitted = f.service.admit(f.selection, bytes(f.bundle)), decision = await f.service.decide(admitted.runId, 1, "approve");
  assert.throws(() => resolvePiStructuredBaseline("example", repo, "EX-1"), /WORKFLOW_AUTHORITY/); // forged early queue status is not progression
  const published = await f.service.requestStep(admitted.runId, 2, "publish", decision.decisionId);
  const state = await f.service.requestStep(admitted.runId, published.revision, "queue", decision.decisionId);
  const authority = { runId: state.runId, decisionId: decision.decisionId, subjectSha256: state.subjectSha256 };
  return { ...f, repo, checkout, base, git, ticketPath, ticket, state, authority };
}

test("native public read tools match core JSON and reject outcome/actor/result/unknown overrides before mutation", () => fixture(async f => {
  const tools = new Map<string, PiToolDefinition>(); let mutations = 0;
  const readHost = { selection: () => f.selection, state: () => f.service.status(f.state.runId), observations: f.host.observations };
  createJsonWorkflowModule({ readHost, mutate: async request => { mutations++; return { schemaVersion: "synthetic-request-only", ok: true, request }; } })({ registerTool: t => tools.set(t.name, t as PiToolDefinition) } as PiRuntime);
  for (const request of [{ action: "list" }, { action: "show", id: "software" }, { action: "status", ticket: "EX-1" }, { action: "next", ticket: "EX-1" }, { action: "preflight", ticket: "EX-1" }]) {
    const result = await tools.get("pa_workflow")!.execute("synthetic", { request: JSON.stringify(request) }, undefined, undefined, {});
    assert.deepEqual(JSON.parse(result.content[0]!.text), workflowReadService(JSON.stringify(request), readHost));
  }
  const show = { action: "show", ticket: "EX-1", id: f.authority.decisionId };
  const shown = await tools.get("pa_decision")!.execute("synthetic", { request: JSON.stringify(show) }, undefined, undefined, {});
  assert.deepEqual(JSON.parse(shown.content[0]!.text), workflowReadService(JSON.stringify({ ...show, action: "decision-show" }), readHost));
  for (const request of [{ action: "capture", revision: 2, stepId: "approve", outcome: "approved" }, { action: "capture", revision: 2, stepId: "approve", actor: "operator" }, { action: "revoke", revision: 2, decisionId: f.authority.decisionId, force: true }, { action: "complete", passed: true }]) {
    const result = await tools.get("pa_decision")!.execute("synthetic", { request: JSON.stringify(request) }, undefined, undefined, {});
    assert.equal(result.isError, true);
  }
  const duplicate = await tools.get("pa_decision")!.execute("synthetic", { request: '{"action":"capture","action":"show"}' }, undefined, undefined, {}); assert.equal(duplicate.isError, true);
  assert.equal(mutations, 0);
  const view = workflowPrimerView(f.state);
  const primer = generatePrimer({ runtime: "pi", teamConfig: { name: "requirements", description: "Synthetic", objective: "Synthetic", agents: [] }, workflow: view });
  assert.ok(primer.includes(f.state.runId)); assert.ok(primer.includes(f.bundle.workflow.sha256)); assert.ok(primer.includes("projection, never approval"));
}));
test("structured baseline drives actual materialization without approval text; static profile inspection executes no tools", () => fixture(async f => {
  const before = f.git(["status", "--porcelain=v2"]), head = f.git(["rev-parse", "HEAD"]);
  const path = process.env.PATH; process.env.PATH = "/nonexistent";
  try { assert.equal(ProjectCommandContract.inspect("example", f.repo)!.checks.length, 1); } finally { process.env.PATH = path; }
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!; assert.equal(baseline.authority.runId, f.state.runId);
  const result = materializeTicketBranch({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! });
  assert.equal(result.created, true); assert.equal(result.baseSha, f.base); assert.equal(f.git(["rev-parse", "HEAD"], f.checkout), f.base);
  assert.equal(f.git(["status", "--porcelain=v2"]), before); assert.equal(f.git(["rev-parse", "HEAD"]), head);
}));
test("amendment materialization reuses ONLY the exact retained feature and rejects changed HEAD without mutation", () => fixture(async f => {
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!; assert.equal(baseline.handoff.type, "amendment");
  const options = { canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! };
  assert.equal(materializeTicketBranch(options).created, false);
  writeFileSync(join(f.checkout, "check.cjs"), "process.exit(1)\n"); f.git(["commit", "-am", "injected feature drift"], f.checkout);
  const ticket = readFileSync(f.ticketPath), head = f.git(["rev-parse", "HEAD"], f.checkout);
  assert.throws(() => materializeTicketBranch(options), /ORDINARY_BASELINE_CHANGED/);
  assert.deepEqual(readFileSync(f.ticketPath), ticket); assert.equal(f.git(["rev-parse", "HEAD"], f.checkout), head);
}, true));
test("default Pi launcher and native execution owner consume the structured grant and reread revocation", () => fixture(async f => {
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!;
  materializeTicketBranch({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! });
  const teams = join(f.root, "teams"); mkdirSync(teams); process.env.PA_PLATFORM_TEAMS = teams;
  writeFileSync(join(teams, "builder.yaml"), "name: builder\ndescription: Synthetic fixture\nobjective: Synthetic fixture\nagents: []\ndefault_mode: orchestrator\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n");
  const treehouse = new TreehouseClient({ run: args => {
    if (args[0] !== "status") throw new Error("unexpected checkout lifecycle effect");
    return { status: 0, stdout: Buffer.from(JSON.stringify([{ name: "1", path: f.checkout, status: "leased", branch: f.bundle.handoff.branch, detached: false, flavor: "git", lease_id: "synthetic-json-workflow", lease_holder: "pa:example:EX-1", leased_at: "2026-10-29T00:00:00Z", processes: [] }])), stderr: Buffer.alloc(0) };
  } });
  const native = new PiPreparedNativeAuthority({ root: join(f.root, "native-authority"), aiUsageRoot: f.root, runtime: () => ({ sourceSha: "a".repeat(40), packageVersion: "synthetic", configSha: "b".repeat(40), storeRoot: "/fixture/runtime" }) });
  let spawns = 0, bodyFailure: unknown;
  const adapter: RuntimeAdapter & { preflight(): Promise<void> } = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "synthetic-json-workflow", async preflight() {}, installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "synthetic fixture" }), extractActivity: () => [], resume: async () => { throw new Error("not a restart test"); },
    async spawn(opts) {
      spawns++; const env = process.env, cwd = process.cwd(); process.env = { ...env, ...opts.env }; process.chdir(f.checkout);
      try {
        assert.equal(recordPiProcessIdentity(opts.deployId, process.env.PA_DEPLOYMENT_DIR!, process.pid), true); opts.onPid?.(process.pid);
        const session = new PiNativeExecutionAdapter({ authority: native, helperDependencies: { treehouse } }).resolve({ cwd: f.checkout })!;
        assert.ok(session);
        const plan = { phaseId: "scoped-phase", scope: "synthetic source owner proof", paths: ["src/a.ts"], requirements: ["FR-01"], prerequisites: [], checks: ["check"], size: "S", complexity: "bounded", rationale: "Synthetic host, real native owners" };
        session.service.apply(session.actor, { action: "plan", plan });
        assert.throws(() => session.service.apply(session.actor, { action: "plan", plan: { ...plan, paths: ["outside.ts"] } }), /WORKFLOW_AUTHORITY/);
        await f.service.revoke(f.state.runId, f.state.revision, f.authority.decisionId);
        assert.throws(() => session.service.apply(session.actor, { action: "plan", plan }), /WORKFLOW_AUTHORITY/);
        assert.equal(session.service.status(session.actor).plan!.phaseId, "scoped-phase"); // reporting stays available
      } catch (error) { bodyFailure = error; throw error; }
      finally { process.chdir(cwd); process.env = env; }
      return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId! } };
    } };
  const result = await deployWithPi({ team: "builder", mode: "orchestrator", repo: "example", ticket: "EX-1", timeout: 1800, provider: "openai-codex", model: "gpt-6.1-sol" }, adapter, undefined, { treehouse, preparedAuthority: native });
  if (bodyFailure) throw bodyFailure;
  assert.equal(result.status, "success", result.reason); assert.equal(spawns, 1);
}));
test("pinned native start binds scope/commands; new work rejects foreign, revoked and legacy-start authority", () => fixture(async f => {
  const note = structuredLaunchNote("ordinary-native-execution/v1", f.authority); assert.deepEqual(parseStructuredLaunchNote(note), f.authority);
  const authorize = (paths = ["src/a.ts"], checks = ["check"]) => authorizePiStructuredWork("example", f.repo, "EX-1", f.bundle.handoff.branch, "source.edit-scoped", { paths, checks }, f.authority);
  assert.equal(authorize()!.runId, f.state.runId);
  assert.throws(() => authorize(["outside.ts"]), /WORKFLOW_AUTHORITY/); assert.throws(() => authorize(undefined, ["unapproved"]), /WORKFLOW_AUTHORITY/);
  assert.throws(() => authorizePiStructuredWork("example", f.repo, "EX-1", f.bundle.handoff.branch, "source.edit-scoped"), /WORKFLOW_AUTHORITY/);
  await f.service.revoke(f.state.runId, f.state.revision, f.authority.decisionId); assert.throws(authorize, /WORKFLOW_AUTHORITY/);
  assert.equal(f.service.status(f.state.runId).decisions.length, 1);
}));
test("protected review consumes issued native locator with no paragraph authority and cannot downgrade after revoke", () => fixture(async f => {
  const locator = workflowDecisionReference(f.state, f.authority.decisionId);
  const artifact = structuredReviewArtifact("example", "EX-1", f.bundle.matrix.ref, locator)!;
  assert.equal(artifact.digest, f.bundle.matrix.sha256); assert.equal(artifact.header.matrixApprovalEvidence, locator);
  assert.throws(() => structuredReviewArtifact("example", "EX-1", f.bundle.matrix.ref, "c-20261029000000000"), /WORKFLOW_AUTHORITY/);
  await f.service.revoke(f.state.runId, f.state.revision, f.authority.decisionId);
  assert.throws(() => structuredReviewArtifact("example", "EX-1", f.bundle.matrix.ref, locator), /WORKFLOW_AUTHORITY/);
}));
test("authenticated registry resume edges continue the same coordinator without reapproval; foreign/unlinked callers fail", () => fixture(async f => {
  const original = f.host.authenticate(), current = { ...original, deploymentId: "d-bbbbbb", identitySha256: "b".repeat(64) };
  const stamp = "2026-10-29T00:00:00.000Z";
  appendRegistryEvent({ deployment_id: original.deploymentId, team: "requirements", mode: "analyze", event: "started", timestamp: stamp, runtime: "pi", binary: "ppa", repo_root: f.repo, repo: f.repo, worktree_root: f.repo, ticket_id: "EX-1" });
  appendRegistryEvent({ deployment_id: original.deploymentId, team: "requirements", event: "completed", timestamp: stamp, status: "partial" });
  appendRegistryEvent({ deployment_id: current.deploymentId, team: "requirements", mode: "analyze", event: "started", timestamp: stamp, runtime: "pi", binary: "ppa", repo_root: f.repo, repo: f.repo, worktree_root: f.repo, ticket_id: "EX-1", resumed_from_deployment_id: original.deploymentId });
  f.host.authenticate = () => current; f.host.continues = createPiWorkflowContinuation(() => current);
  assert.equal(f.host.continues(original, current), true);
  assert.equal(f.host.continues(original, { ...current, ticket: "EX-2" }), false);
  const revoked = await f.service.revoke(f.state.runId, f.state.revision, f.authority.decisionId);
  assert.deepEqual(revoked.revoked, [f.authority.decisionId]); assert.equal(revoked.decisions.length, 1);
}));
test("missing adopted registry cannot fall back to a ticket approval paragraph", () => fixture(async f => {
  f.ticket.doc_refs.push({ type: "workflow", primary: false, path: `registry-workflow:${f.state.runId}` }); writeFileSync(f.ticketPath, JSON.stringify(f.ticket));
  const registry = process.env.PA_REGISTRY_DB; process.env.PA_REGISTRY_DB = join(f.root, "absent.db");
  try { assert.throws(() => resolvePiStructuredBaseline("example", f.repo, "EX-1"), /WORKFLOW_UNCERTAIN/); assert.equal(existsSync(process.env.PA_REGISTRY_DB!), false); }
  finally { process.env.PA_REGISTRY_DB = registry; }
}));
