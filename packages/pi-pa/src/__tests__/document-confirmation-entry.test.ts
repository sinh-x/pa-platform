import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, emitStartedEvent, emitPidEvent, ensureDeployDir, getDeploymentEvents, TicketStore } from "@pa-platform/pa-core";
import { recordPiProcessIdentity } from "../process-identity.js";
import { DOCUMENT_CONFIRMATION_SESSION_VERSION, DOCUMENT_WORKSPACE_SESSION_VERSION } from "../document-session.js";
import { registerDocumentModule } from "../pi-extension/document-tool.js";
import type { PiToolDefinition } from "../pi-extension/index.js";
import type { PiDocumentConfirmationContext } from "../document-confirmation-native.js";

test("default v3 tool and slash command share issuance/recovery using disposable native registry/process evidence and synthetic UI", async () => {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "document-confirm-entry-")), repo = join(root, "repo"), usage = join(root, "usage"), config = join(root, "config");
  closeDb();
  try {
    for (const path of [repo, usage, config]) mkdirSync(path);
    Object.assign(process.env, { PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") });
    for (const key of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_ROGUE_ONE", "PA_REPO", "PA_WORKTREE_ROOT"]) delete process.env[key];
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    const launch = (deploymentId: string, note: string) => {
      const directory = ensureDeployDir(deploymentId);
      emitStartedEvent({ deploymentId, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, note });
      emitPidEvent({ deploymentId, team: "requirements", pid: process.pid });
      assert.equal(recordPiProcessIdentity(deploymentId, directory, process.pid), true);
      Object.assign(process.env, { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: directory, PA_TEAM: "requirements", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
    };
    const deploymentId = "d-273601"; launch(deploymentId, DOCUMENT_CONFIRMATION_SESSION_VERSION); process.chdir(repo);
    let interactions = 0;
    const messages: string[] = [];
    const context: PiDocumentConfirmationContext = { cwd: repo, mode: "tui", sessionManager: { getSessionId: () => "disposable-real-native-context-synthetic-ui-not-human" }, ui: {
      select: async () => { throw Error("no legacy confirmation permitted"); }, notify: s => messages.push(s),
      custom: (factory: any) => new Promise(resolve => { interactions++; const dialog = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color: string, s: string) => s }, {}, resolve); dialog.render(100); for (const key of ["\u001b[A", "\u001b[A", "\u001b[A", "\r"]) dialog.handleInput(key); }),
    } };
    const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, (...args: any[]) => any>(), commands = new Map<string, (...args: any[]) => any>();
    registerDocumentModule({ registerTool: t => tools.set(t.name, t), on: ((name: string, h: any) => handlers.set(name, h)) as any, registerCommand: (name, options) => commands.set(name, options.handler) });
    assert.equal(tools.size, 0); handlers.get("session_start")!({}, context); assert.ok(tools.has("pa_document")); assert.ok(tools.has("pa_workspace")); assert.ok(commands.has("pa-approve"));
    const call = async (request: unknown) => JSON.parse((await tools.get("pa_document")!.execute("native-source-fixture", { request: JSON.stringify(request) }, undefined, undefined, context)).content[0]!.text);
    const intake = await call({ action: "ticket-create", title: "Disposable native confirmation", content: "Source fixture only, not a real requested ticket or human approval.", intakeId: "native-confirmation-fixture" }); assert.equal(intake.ok, true);
    const ticket = intake.result.ticket.id, members = [];
    for (const id of ["brief", "requirements", "uat"]) {
      const path = `agent-teams/requirements/artifacts/drafts/${deploymentId}/${id}.md`, content = `# ${id}\nDisposable full content\n`;
      const draft = await call({ action: "draft", path, content, expectedSha256: null }); assert.equal(draft.ok, true);
      members.push({ id, role: id, mediaType: "text/markdown", source: path, description: id, bytes: draft.result.bytes, sha256: draft.result.sha256 });
    }
    const subject = { schemaVersion: "pa-document-package/v1", packageId: "native-fixture", revision: 1, repository: { key: "example", root: repo }, ticket, predecessor: null, members, references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
    const frozen = await call({ action: "freeze", package: subject, expectedRevision: 0 }); assert.equal(frozen.ok, true);
    const request = { action: "confirm", sha256: frozen.result.sha256, expectedRevision: frozen.result.expectedRevision, scope: "content" };
    const [confirmed, concurrentCommand, forged] = await Promise.all([call(request), commands.get("pa-approve")!(JSON.stringify(request), context), call({ ...request, path: "/tmp/forged.json" })]);
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed)); assert.equal(concurrentCommand.ok, true); assert.equal(concurrentCommand.result.decisionId, confirmed.result.decisionId);
    assert.equal(forged.ok, false); assert.equal(forged.code, "DOCUMENT_INPUT"); assert.equal(interactions, 1);
    const receipt = JSON.parse(readFileSync(join(usage, confirmed.result.approval.path), "utf8")); assert.equal(receipt.confirmationMethod, "pi-native-confirmation"); assert.equal(receipt.ticket, ticket); assert.equal(receipt.sessionId, context.sessionManager!.getSessionId());
    const store = new TicketStore(), audit = store.readAudit().length;
    const command = await commands.get("pa-approve")!(JSON.stringify(request), context); assert.equal(command.ok, true); assert.equal(command.result.reused, true); assert.equal(interactions, 1); assert.equal(store.readAudit().length, audit);
    assert.ok(messages.some(s => s.includes("no new prompt")));
    assert.equal((await call({ action: "branch-inspect", ticket })).result.code, "MISSING_LINK");
    assert.equal(getDeploymentEvents(deploymentId).filter(e => e.event === "started").length, 1);
    assert.equal((await call({ action: "publish", sha256: request.sha256, expectedRevision: confirmed.result.expectedRevision, decisionId: confirmed.result.decisionId })).code, "DOCUMENT_AUTHORITY");
    launch("d-273602", DOCUMENT_WORKSPACE_SESSION_VERSION);
    const legacyCommands = new Map(); registerDocumentModule({ on: ((name: string, h: any) => handlers.set(name, h)) as any, registerCommand: (name, options) => legacyCommands.set(name, options) }); handlers.get("session_start")!({}, context);
    assert.equal(legacyCommands.has("pa-approve"), false); assert.equal((await call(request)).code, "DOCUMENT_UNAVAILABLE"); assert.equal(interactions, 1);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
});
