// Private pinned qualification driver. Native registry/process setup and UI
// answers are explicitly synthetic; all implementations/default tool calls and
// public CLI dispatches come from the selected installed closure, never source.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const frame = JSON.parse(readFileSync(process.argv[2], "utf8"));
const load = path => import(pathToFileURL(join(frame.share, "packages", path)).href);
const core = await load("pa-core/dist/index.js"), native = await load("pi-pa/dist/pi-extension/document-tool.js"), session = await load("pi-pa/dist/document-session.js"), identity = await load("pi-pa/dist/process-identity.js");
const cases = [], observed = (id, observations = 1) => cases.push({ id, status: "passed", observations });
const root = join(frame.evidenceRoot, "public-documents"), repo = join(root, "repo"), config = join(root, "config");
for (const path of [root, repo, config, join(root, "usage")]) mkdirSync(path, { recursive: true, mode: 0o700 });
process.env = { ...process.env, PA_AI_USAGE_HOME: join(root, "usage"), PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") };
for (const name of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_ROGUE_ONE", "PA_WORKTREE_ROOT", "PA_REPO", "PA_PI_EXECUTION_MODE"]) delete process.env[name];
const git = args => execFileSync("git", args, { cwd: repo, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
git(["init", "-b", "develop"]); git(["config", "user.name", "Disposable document fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
writeFileSync(join(repo, "README.md"), "Disposable project evidence.\n"); git(["add", "README.md"]); git(["commit", "-m", "disposable fixture"]);
writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: repo, prefix: "EX" } } }), { mode: 0o600 });
const cli = (binary, args) => spawnSync(binary, args, { cwd: repo, env: process.env, encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
const description = cli(frame.ppa, ["document", "describe", "--format", "json"]);
assert.ifError(description.error); assert.equal(description.status, 0); assert.equal(description.signal, null); assert.equal(description.stderr, "");
assert.deepEqual(JSON.parse(description.stdout), core.documentInterfaceDescription()); observed("installed-cli-description");
for (const args of [["document", "capture", "--approved"], ["document", "publish", "--decision", "invented"]]) { const denied = cli(frame.ppa, args); assert.ifError(denied.error); assert.equal(denied.status, 1); assert.equal(denied.signal, null); }
observed("no-cli-approval-import", 2);
const opa = cli(frame.opa, ["document", "describe", "--format", "json"]); assert.ifError(opa.error); assert.equal(opa.status, 1); assert.equal(opa.signal, null); observed("no-opa-native-parity");
// This fixture issues NO decision for a real ticket. The actual native host is
// exercised against an isolated registry and current process-incarnation anchor.
const deploymentId = "d-283001", deploymentDirectory = core.ensureDeployDir(deploymentId);
core.emitStartedEvent({ deploymentId, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, note: session.DOCUMENT_SESSION_VERSION });
core.emitPidEvent({ deploymentId, team: "requirements", pid: process.pid });
assert.equal(identity.recordPiProcessIdentity(deploymentId, deploymentDirectory, process.pid), true);
Object.assign(process.env, { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: deploymentDirectory, PA_TEAM: "requirements", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
process.chdir(repo);
let staleOnApproval = false, selected = "Approve exact package and displayed publication/queue effects", mutablePath;
const context = { cwd: repo, mode: "tui", sessionManager: { getSessionId: () => "disposable-installed-document-session-not-human" }, ui: { select: async (_title, choices) => {
  if (choices.includes("Continue review")) return "Continue review";
  if (staleOnApproval) { writeFileSync(mutablePath, "Changed during synthetic consent.\n"); staleOnApproval = false; }
  return selected;
} } };
const tools = new Map(), handlers = new Map();
native.registerDocumentModule({ registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler) });
assert.equal(tools.size, 0); await handlers.get("session_start")({}, context); assert.equal(tools.has("pa_document"), true); observed("default-native-registration");
const tool = tools.get("pa_document"); let calls = 0;
const invoke = async request => {
  const result = await tool.execute(`installed-document-${++calls}`, { request: JSON.stringify(request) }, undefined, undefined, context);
  return JSON.parse(result.content[0].text);
};
const call = async request => { const result = await invoke(request); assert.equal(result.ok, true, JSON.stringify(result)); return result.result; };
const intake = { action: "ticket-create", title: "Disposable PAP-283 installed qualification", content: "Synthetic fixture, not a real requested task.\nNo human approval or UAT is asserted.", intakeId: "installed-document-fixture" };
const ticket = (await call(intake)).ticket; assert.equal(ticket.status, "requirement-review"); assert.equal((await call(intake)).ticket.id, ticket.id); observed("native-ticket-first", 2);
const texts = { brief: "Review this disposable document-package fixture. It proves installed mechanics only, not human acceptance.", requirements: "# FR-1\nDisposable installed document behavior.\n# AC-1\nCovered by TS-1.\n", uat: "# TS-1\nTrace FR-1 and AC-1. Not human-executed UAT.\n", mockup: "# Reference mockup\nSynthetic design, not an observed product UI.\n" };
const members = [];
for (const [id, content] of Object.entries(texts)) {
  const path = `agent-teams/requirements/artifacts/drafts/${deploymentId}/${id}.md`, result = await call({ action: "draft", path, content, expectedSha256: null });
  members.push({ id, role: id === "mockup" ? "specification" : id, source: path, mediaType: "text/markdown", description: `${id}: disposable fixture`, bytes: result.bytes, sha256: result.sha256 });
}
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN3sAAAAASUVORK5CYII=", "base64");
const imageSource = `agent-teams/requirements/artifacts/drafts/${deploymentId}/opaque.png`;
writeFileSync(join(core.getAiUsageDir(), imageSource), image, { mode: 0o600 }); // explicitly fixture-owned media setup, not a native image writer
members.push({ id: "image", role: "specification", source: imageSource, mediaType: "image/png", description: "Opaque disposable PNG; not product observation", bytes: image.length, sha256: core.workflowDigest(image) });
const subject = { schemaVersion: "pa-document-package/v1", packageId: "installed-fixture", revision: 1, repository: { key: "example", root: repo }, ticket: ticket.id, predecessor: null, members, references: [{ locator: "https://example.invalid/not-fetched", version: "fixture", description: "Informative metadata only" }], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
const checks = await call({ action: "check", package: subject }); assert.equal(checks.structuralPass, true); assert.equal(checks.semanticCompleteness, "not-assessed"); observed("native-draft-and-check", members.length + 1);
const revision = async () => (await call({ action: "status", ticket: ticket.id })).expectedRevision;
const frozen = await call({ action: "freeze", package: subject, expectedRevision: await revision() }), sha256 = frozen.sha256;
assert.equal(sha256, core.documentPackageSha(subject));
for (const [id, content] of Object.entries(texts)) { const read = await call({ action: "read", sha256, path: id, offset: 0 }); assert.equal(read.content, content); assert.equal(read.nextOffset, null); }
assert.equal((await call({ action: "show", sha256 })).decisions.length, 0); observed("native-snapshot-and-paged-read", 6);
mutablePath = join(core.getAiUsageDir(), members.find(m => m.id === "mockup").source); staleOnApproval = true;
assert.equal((await invoke({ action: "capture", sha256, expectedRevision: await revision() })).code, "DOCUMENT_STALE");
assert.equal((await call({ action: "show", sha256 })).decisions.length, 0); writeFileSync(mutablePath, texts.mockup); observed("native-stale-consent", 2);
const captured = await call({ action: "capture", sha256, expectedRevision: await revision() }), decisionId = captured.decisions.at(-1).decisionId;
assert.equal(captured.outcome, "approved"); assert.equal(captured.decisions.at(-1).revoked, false);
const forged = await invoke({ action: "capture", sha256, expectedRevision: await revision(), outcome: "approved" }); assert.equal(forged.ok, false); observed("native-exact-decision", 2);
const published = await call({ action: "publish", sha256, decisionId, expectedRevision: await revision() }); assert.equal(published.outcome, "completed");
const store = new core.TicketStore(); const refs = store.get(ticket.id).doc_refs;
assert.equal(refs.length, members.length); assert.equal(refs.filter(r => r.primary).length, 1);
for (const member of members) assert.equal(core.workflowDigest(readFileSync(join(core.getAiUsageDir(), core.documentDestination(subject, member)))), member.sha256);
assert.equal(store.get(ticket.id).status, "requirement-review"); observed("native-full-publication", members.length + 3);
const queued = await call({ action: "queue", sha256, decisionId, expectedRevision: await revision() }); assert.equal(queued.outcome, "completed");
assert.equal(store.get(ticket.id).status, "pending-implementation"); assert.equal(store.get(ticket.id).assignee, "builder/team-manager");
const auditLength = store.readAudit().length;
assert.equal((await call({ action: "publish", sha256, decisionId, expectedRevision: await revision() })).reused, true);
assert.equal((await call({ action: "queue", sha256, decisionId, expectedRevision: await revision() })).reused, true); assert.equal(store.readAudit().length, auditLength);
assert.equal(core.getDeploymentEvents(deploymentId).filter(e => e.event === "started").length, 1); observed("native-queue-and-reuse", 6);
for (const name of ["bash", "write", "edit", "pa_preparation", "pa_workflow_policy", "pa_execution"]) assert.equal(handlers.get("tool_call")({ toolName: name, input: {} }, context).block, true);
assert.equal(handlers.get("tool_call")({ toolName: "pa_document", input: { request: '{"action":"capabilities"}' } }, context), undefined); observed("native-role-denials", 7);
const legacyId = "d-283002", legacyDirectory = core.ensureDeployDir(legacyId);
core.emitStartedEvent({ deploymentId: legacyId, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo });
core.emitPidEvent({ deploymentId: legacyId, team: "requirements", pid: process.pid }); identity.recordPiProcessIdentity(legacyId, legacyDirectory, process.pid);
const before = JSON.stringify(core.getDeploymentEvents(legacyId));
Object.assign(process.env, { PA_DEPLOYMENT_ID: legacyId, PA_DEPLOYMENT_DIR: legacyDirectory });
const legacyTools = new Map(), legacyHandlers = new Map(); native.registerDocumentModule({ registerTool: t => legacyTools.set(t.name, t), on: (name, handler) => legacyHandlers.set(name, handler) });
await legacyHandlers.get("session_start")({}, context); assert.equal(legacyTools.has("pa_document"), false);
assert.equal((await invoke({ action: "capabilities" })).code, "DOCUMENT_AUTHORITY"); assert.equal(JSON.stringify(core.getDeploymentEvents(legacyId)), before); observed("native-retained-no-upgrade", 3);
core.closeDb();
console.log(JSON.stringify({ schemaVersion: "pa-document-public-observations/v1", evidenceClass: "disposable-default-native-synthetic-ui-not-human-approval", cases, sourceFallback: false, humanUat: false }));
