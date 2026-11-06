import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowDigest, parseTeamYamlContent, type DeploymentStatus, type RegistryEvent } from "@pa-platform/pa-core";
import { authenticatePiDocumentCaller, DOCUMENT_SESSION_VERSION, type DocumentSessionDependencies } from "../document-session.js";
import { createPiDocumentCapture } from "../document-native.js";
import { createDocumentTool, documentSessionToolAllowed } from "../pi-extension/document-tool.js";
import { runDocumentDescription } from "../document-cli.js";
import type { PiWorkflowContext } from "../workflow-native.js";
import type { DocumentPackage } from "@pa-platform/pa-core";

function fixture() {
  const caller = { deploymentId: "d-abcdef", repoKey: "example", repoRoot: "/tmp/example", ticket: "EX-1", identitySha256: "a".repeat(64) };
  const subject: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: "example", revision: 1, repository: { key: "example", root: "/tmp/example" }, ticket: "EX-1", predecessor: null,
    members: (["brief", "requirements", "uat", "mockup"] as const).map(id => ({ id, role: id === "mockup" ? "specification" : id, source: `agent-teams/requirements/artifacts/reviews/EX-1/r001/${id}.md`, mediaType: "text/markdown", description: `${id} description`, bytes: 1, sha256: "b".repeat(64) })), references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
  return { caller, subject, request: { subject, sha256: workflowDigest(JSON.stringify(subject)), brief: "Short meaningful decision brief.", action: "capture" as const } };
}
test("native document capture presents brief/full membership/finite effects and persists verifiable transcript bytes", async () => {
  const f = fixture(), prompts: string[] = [];
  const context: PiWorkflowContext = { cwd: f.caller.repoRoot, mode: "tui", ui: { select: async (title, choices) => { prompts.push(title); return choices.includes("Continue review") ? "Continue review" : choices[0]; } } };
  const result = await createPiDocumentCapture(context, () => f.caller)(f.request);
  assert.equal(result.outcome, "approved"); assert.equal(result.evidenceSha256, workflowDigest(result.nativeEvidence)); assert.match(result.principal, /^local-uid:\d+$/);
  const rendered = prompts.join("\n"); for (const expected of ["Short meaningful decision brief", "mockup", "pending-implementation", "builder/team-manager", "No source edit"]) assert.ok(rendered.includes(expected));
  assert.ok(!rendered.includes("Branch:")); assert.equal(prompts.filter(p => p.includes("decide on the reviewed package")).length, 1);
});
for (const choice of ["Request changes", "Reject exact package", "Cancel", undefined]) test(`native document choice ${choice} never grants approval`, async () => {
  const f = fixture(); const context: PiWorkflowContext = { mode: "tui", cwd: f.caller.repoRoot, ui: { select: async (_t, choices) => choices.includes("Continue review") ? "Continue review" : choice } };
  const result = await createPiDocumentCapture(context, () => f.caller)(f.request); assert.notEqual(result.outcome, "approved");
});
test("nonforeground, caller drift and aborted UI never issue a decision", async () => {
  const f = fixture();
  await assert.rejects(createPiDocumentCapture({ mode: "rpc", cwd: f.caller.repoRoot }, () => f.caller)(f.request), /DOCUMENT_AUTHORITY/);
  let calls = 0;
  const context: PiWorkflowContext = { mode: "tui", cwd: f.caller.repoRoot, ui: { select: async (_t, choices) => choices[0] } };
  await assert.rejects(createPiDocumentCapture(context, () => ({ ...f.caller, identitySha256: (++calls === 1 ? "a" : "b").repeat(64) }))(f.request), /DOCUMENT_STALE/);
  const abort = new AbortController(); context.ui!.select = async (_title, choices) => { abort.abort(); return choices[0]; };
  await assert.rejects(createPiDocumentCapture(context, () => f.caller, abort.signal)(f.request), /DOCUMENT_AUTHORITY/);
});
test("native route authentication requires an immutable launch, incarnation anchor, foreground and canonical root", () => {
  const root = "/tmp/example", fingerprint = { pid: 123, bootId: "a".repeat(36), startTimeTicks: "1234" };
  const status = { deploy_id: "d-abcdef", status: "running", runtime: "pi", team: "requirements", mode: "analyze", ticket_id: "EX-1", repo_root: root, repo: root, worktree_root: root, pid: 123, started_at: "2026-11-06T00:00:00.000Z" } as DeploymentStatus;
  const start = { event: "started", note: DOCUMENT_SESSION_VERSION, runtime: "pi", binary: "ppa", team: "requirements", mode: "analyze", ticket_id: "EX-1", repo_root: root, repo: root, worktree_root: root } as RegistryEvent;
  const deps: Partial<DocumentSessionDependencies> = { status: () => status, events: () => [start], physical: () => root, repository: () => ({ repoKey: "example", repoRoot: root, worktreeRoot: root, repositoryCwd: root }) as any, fingerprint: () => fingerprint, anchor: () => fingerprint, inLineage: () => true, cwd: () => root, pid: 123 };
  const env = { PA_DEPLOYMENT_ID: "d-abcdef", PA_TEAM: "requirements", PA_MODE: "analyze", PA_TICKET_ID: "EX-1", PA_REPO: root, PA_WORKTREE_ROOT: root, PA_PI_EXECUTION_MODE: "foreground" };
  const ctx: PiWorkflowContext = { mode: "tui", cwd: root, sessionManager: { getSessionId: () => "synthetic-session" } };
  assert.equal(authenticatePiDocumentCaller(ctx, env, deps).ticket, "EX-1");
  assert.throws(() => authenticatePiDocumentCaller(ctx, env, { ...deps, events: () => [{ ...start, note: "model-claim" }] }), /DOCUMENT_AUTHORITY/);
  assert.throws(() => authenticatePiDocumentCaller(ctx, env, { ...deps, anchor: () => ({ ...fingerprint, startTimeTicks: "9999" }) }), /DOCUMENT_AUTHORITY/);
  assert.throws(() => authenticatePiDocumentCaller(ctx, { ...env, PA_PI_EXECUTION_MODE: "background" }, deps), /DOCUMENT_AUTHORITY/);
  assert.throws(() => authenticatePiDocumentCaller(ctx, env, { ...deps, status: () => ({ ...status, builder_authority: "orchestrator" }) }), /DOCUMENT_AUTHORITY/);
  assert.equal(authenticatePiDocumentCaller(ctx, { ...env, PA_TICKET_ID: "" }, { ...deps, status: () => ({ ...status, ticket_id: undefined }), events: () => [{ ...start, ticket_id: undefined }] }).ticket, null);
  const associated = { event: "ticket-associated", previous_ticket_id: "EX-1", ticket_id: "EX-2", actor: "requirements/analyze" } as RegistryEvent;
  assert.equal(authenticatePiDocumentCaller(ctx, env, { ...deps, status: () => ({ ...status, ticket_id: "EX-2" }), events: () => [start, associated] }).ticket, "EX-2");
  assert.throws(() => authenticatePiDocumentCaller(ctx, env, { ...deps, status: () => ({ ...status, ticket_id: "EX-2" }), events: () => [start, { ...associated, previous_ticket_id: "EX-9" }] }), /DOCUMENT_AUTHORITY/);
});
test("paired profile parser is version scoped and no source/shell/resource aliases inherit rights", () => {
  const yaml = 'name: requirements\ndeploy_modes:\n  - id: analyze\n    document_profile: pa-document-package/v1\n';
  assert.equal(parseTeamYamlContent(yaml).deploy_modes![0]!.document_profile, "pa-document-package/v1");
  for (const invalid of [yaml.replace("v1", "v2"), yaml.replace("requirements", "builder"), yaml.replace("analyze", "auto")]) assert.throws(() => parseTeamYamlContent(invalid));
  for (const name of ["bash", "write", "edit", "mcp.read", "pa_preparation", "pa_workflow_policy", "pa_execution", "pa_workflow"]) assert.equal(documentSessionToolAllowed({ toolName: name, input: {} }), false);
  for (const name of ["pa_document", "pa_ticket", "question", "todo", "pa_template"]) assert.equal(documentSessionToolAllowed({ toolName: name, input: {} }), true);
});
test("native tool validates outer input and preserves durable-effect correlation in a bounded reply", async () => {
  let calls = 0;
  const tool = createDocumentTool(async () => { calls++; return { ok: true, action: "publish", result: { sha256: "a".repeat(64), expectedRevision: 4, operationId: "effect-exact", outcome: "completed", large: "x".repeat(60000) } }; });
  const invalid = await tool.execute("t", { request: "{}", approved: true }, undefined, undefined, {}); assert.equal(invalid.isError, true); assert.equal(calls, 0);
  const result = await tool.execute("t", { request: '{"action":"capabilities"}' }, undefined, undefined, {});
  assert.equal(result.isError, undefined); assert.ok(Buffer.byteLength(result.content[0]!.text) < 50 * 1024); assert.equal(JSON.parse(result.content[0]!.text).operationId, "effect-exact");
});
test("CLI discovery is static and never an approval/import workaround", () => {
  const stdout: string[] = [], stderr: string[] = [], io = { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) };
  assert.equal(runDocumentDescription(["describe", "--format", "json"], io), 0); const result = JSON.parse(stdout[0]!); assert.equal(result.nativeTool, "pa_document"); assert.equal(result.installedQualification, "not-asserted");
  assert.equal(runDocumentDescription(["capture", "--approved"], io), 1);
});
