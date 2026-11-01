// Portable workflow entry. The full local/installed entry imports these cases
// and unconditionally registers all native cases separately. No environment skips.
import "./runtime-start-gate.test.js";
import "./pi-workflow-operation-cases.js";
import "./pi-workflow-bootstrap-cases.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createTicketWorkflowOwners, TicketStore, appendRegistryEvent, closeDb, parseReviewMatrixPlan, workflowDecisionReference, structuredReviewArtifact, workflowReadService, workflowPrimerView, generatePrimer, type ReviewMatrix } from "@pa-platform/pa-core";
import { workflowRuntimeFixture } from "../../../pa-core/src/__tests__/workflow-runtime-fixture.js";
import { bytes } from "../../../pa-core/src/__tests__/workflow-fixtures.js";
import { digest } from "../../../pa-core/src/workflows/contracts.js";
import { resolvePiStructuredBaseline, structuredLaunchNote } from "../workflow-consumers.js";
import { createPiWorkflowContinuation } from "../workflow-native.js";
import { PiPreparedNativeAuthority } from "../prepared-native.js";
import { createJsonWorkflowModule } from "../pi-extension/workflow.js";
import { createPiSourceWorkflowOwner } from "../workflow-source.js";
import { createPiMatrixWorkflowOwner } from "../workflow-matrix.js";
import type { PiToolDefinition, PiRuntime } from "../pi-extension/index.js";

export async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, amendment = false, source = false, matrix: boolean | "failure" = false) {
  const env = process.env; process.env = { ...env };
  for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key) && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
  const f = workflowRuntimeFixture();
  try { await run(await setup(f, amendment, source, matrix)); } finally { closeDb(); f.close(); process.env = env; }
}
async function setup(f: ReturnType<typeof workflowRuntimeFixture>, amendment = false, source = false, matrix: boolean | "failure" = false) {
  Object.assign(process.env, { PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "registry.db"), PA_PLATFORM_CONFIG: join(f.root, "config"), PA_PLATFORM_HOME: f.root, PA_PLATFORM_TEAMS: join(f.root, "teams"), PA_PLATFORM_SKILLS: join(f.root, "skills/global") });
  const repo = join(f.root, "repo"), checkout = join(f.root, "checkout"); mkdirSync(repo); mkdirSync(join(f.root, "config")); mkdirSync(join(f.root, "tickets"));
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "develop"]); git(["config", "user.name", "Synthetic fixture"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "commit.gpgsign", "false"]); git(["config", "core.hooksPath", "/dev/null"]);
  const script = matrix === "failure" ? "process.exit(7)\n" : source ? "const fs=require('node:fs'); console.log('native source check'); process.exit(fs.readFileSync('source.txt','utf8').includes('repaired')?0:2);\n" : "process.exit(0)\n"; writeFileSync(join(repo, "check.cjs"), script);
  if (source) { writeFileSync(join(repo, "source.txt"), "original\n"); f.bundle.scope.files = ["source.txt"]; }
  const profile = JSON.stringify({ schemaVersion: "project-command-contract/v1", effects: ["project-read", "isolated-temp-write"], checks: [{ id: "check", executable: realpathSync(process.execPath), argv: ["check.cjs"], environment: {}, readPaths: source ? ["source.txt"] : [], prerequisites: [{ path: "check.cjs", sha256: digest(script) }], timeoutSeconds: 10, maximumOutputBytes: 1024 }] });
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
  if (matrix) { m.commands = [{ ...m.commands[0]!, command: "node 'check.cjs'" }, { ...m.commands[0]!, id: "02-node", command: "node --version" }]; m.commandCount = m.commands.length; m.outputs = m.commands.map(c => `${c.id}: native exact output retained`); }
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
  if (source) {
    d.requiredCapabilities.push("execution.scoped-local"); d.steps[2]!.transitions.completed = "source-phase";
    d.steps.push({ id: "source-phase", order: 4, title: "Scoped native source phase", kind: "action", owner: "execution", dependsOn: [{ stepId: "queue", outcome: "completed" }], when: true,
      inputs: [{ name: "package", schemaVersion: "pa-review-bundle/v1", source: "context", field: "bundle" }, { name: "decision", schemaVersion: "pa-decision/v1", source: "output", stepId: "approve", output: "decision" }],
      operation: { id: "source.local", version: "v1" }, authorization: ["source.edit-scoped", "repair.same-scope", "git.commit-local"], effects: ["source.scoped", "git.local"], outputs: [{ name: "execution", schemaVersion: "pa-execution-result/v1" }],
      verification: [{ id: "execution.native", version: "v1", inputs: ["package", "decision"] }], transitions: { completed: "source-next", failed: "blocked", unknown: "blocked" }, failurePolicy: { strategy: "reconcile", correctionOwner: "execution" } });
    d.steps.push({ ...structuredClone(d.steps[3]!), id: "source-next", order: 5, title: "Second scoped native phase", dependsOn: [{ stepId: "source-phase", outcome: "completed" }], transitions: { completed: "completed", failed: "blocked", unknown: "blocked" } });
  }
  if (matrix) {
    d.requiredCapabilities.push("validation.matrix"); d.steps[2]!.transitions.completed = "validate";
    d.steps.push({ id: "validate", order: 4, title: "Independent native full matrix", kind: "check", owner: "validation", dependsOn: [{ stepId: "queue", outcome: "completed" }], when: true,
      inputs: [{ name: "package", schemaVersion: "pa-review-bundle/v1", source: "context", field: "bundle" }, { name: "decision", schemaVersion: "pa-decision/v1", source: "output", stepId: "approve", output: "decision" }],
      operation: { id: "check.matrix", version: "v1" }, authorization: ["check.execute-scoped"], effects: ["check.scoped"], outputs: [{ name: "validation", schemaVersion: "pa-validation-result/v1" }],
      verification: [{ id: "validation.native", version: "v1", inputs: ["package", "decision"] }], transitions: { passed: "completed", failed: "blocked", unknown: "blocked" }, failurePolicy: { strategy: "reconcile", correctionOwner: "validation" } });
  }
  const definition = bytes(d); f.bundle.workflow.sha256 = digest(definition);
  f.selection = { ...f.selection, configRoot: f.root, definitions: f.selection.definitions.map(row => ({ ...row, configRoot: f.root, raw: definition, sha256: digest(definition) })) };
  const owners = createTicketWorkflowOwners(f.journal, new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true }), f.root, f.host.authenticate);
  for (const [id, owner] of owners) (f.host.owners as Map<string, typeof owner>).set(id, owner);
  const nativeAuthority = new PiPreparedNativeAuthority({ root: join(f.root, "native-authority"), aiUsageRoot: f.root });
  const sourceOwner = createPiSourceWorkflowOwner(f.journal, () => f.host.authenticate(), undefined, nativeAuthority);
  if (source) (f.host.owners as Map<string, typeof sourceOwner>).set("source.local", sourceOwner);
  const matrixOwner = createPiMatrixWorkflowOwner(f.journal, () => f.host.authenticate(), undefined, nativeAuthority);
  if (matrix) (f.host.owners as Map<string, typeof matrixOwner>).set("check.matrix", matrixOwner);
  const admitted = f.service.admit(f.selection, bytes(f.bundle)), decision = await f.service.decide(admitted.runId, 1, "approve");
  assert.throws(() => resolvePiStructuredBaseline("example", repo, "EX-1"), /WORKFLOW_AUTHORITY/);
  const published = await f.service.requestStep(admitted.runId, 2, "publish", decision.decisionId);
  const state = await f.service.requestStep(admitted.runId, published.revision, "queue", decision.decisionId);
  const authority = { runId: state.runId, decisionId: decision.decisionId, subjectSha256: state.subjectSha256 };
  return { ...f, repo, checkout, base, git, ticketPath, ticket, state, authority, nativeAuthority, sourceOwner, matrixOwner };
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
  const revise = { action: "revise", revision: f.state.revision, producer: '{"action":"render","id":"review-bundle"}' };
  const requested = await tools.get("pa_workflow")!.execute("synthetic-revision-transport-only", { request: JSON.stringify(revise) }, undefined, undefined, {});
  assert.deepEqual(JSON.parse(requested.content[0]!.text).request, revise); assert.equal(mutations, 1);
  for (const request of [{ ...revise, revision: 0 }, { ...revise, producer: {} }, { ...revise, actor: "operator" }, { ...revise, reason: "material-amendment" }, { ...revise, previousAttemptId: "forged" }, { ...revise, outcome: "approved" }]) {
    const rejected = await tools.get("pa_workflow")!.execute("synthetic", { request: JSON.stringify(request) }, undefined, undefined, {}); assert.equal(rejected.isError, true);
  }
  assert.equal(mutations, 1);
  const view = workflowPrimerView(f.state);
  const primer = generatePrimer({ runtime: "pi", teamConfig: { name: "requirements", description: "Synthetic", objective: "Synthetic", agents: [] }, workflow: view });
  assert.ok(primer.includes(f.state.runId)); assert.ok(primer.includes(f.bundle.workflow.sha256)); assert.ok(primer.includes("projection, never approval"));
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
