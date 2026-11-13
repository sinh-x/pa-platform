import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, emitStartedEvent, emitPidEvent, ensureDeployDir, MODE_CAPABILITY_SESSION, createModeCapabilityBinding, parseModeCapabilityPolicy, TicketStore, DocumentPackageError, publicationRecoveryGuidance } from "@pa-platform/pa-core";
import { recordPiProcessIdentity } from "../process-identity.js";
import { DOCUMENT_CONFIRMATION_SESSION_VERSION } from "../document-session.js";
import { registerDocumentModule, createDocumentTool } from "../pi-extension/document-tool.js";
import type { PiToolDefinition } from "../pi-extension/index.js";
import type { PiDocumentConfirmationContext } from "../document-confirmation-native.js";

test("policy default native entry retires exact pending intent once; retained profiles cannot recover", async () => {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "document-retirement-entry-"));
  const repo = join(root, "repo"), usage = join(root, "usage"), config = join(root, "config"); closeDb();
  try {
    for (const path of [repo, usage, config]) mkdirSync(path);
    Object.assign(process.env, { PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") });
    for (const key of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_ROGUE_ONE", "PA_REPO", "PA_WORKTREE_ROOT"]) delete process.env[key];
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    const store = new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true });
    const ticket = store.create({ project: "example", title: "Disposable recovery source fixture", type: "bug", status: "requirement-review", priority: "medium", assignee: "requirements/team-manager", estimate: "M", summary: "", from: "", to: "", description: "Synthetic source evidence, not a live request", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "test").id;
    const launch = (id: string, policy: boolean) => {
      const directory = ensureDeployDir(id), binding = createModeCapabilityBinding("a".repeat(40), Buffer.from("source-fixture"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ["document.package"] }));
      emitStartedEvent({ deploymentId: id, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, ticketId: ticket,
        note: policy ? MODE_CAPABILITY_SESSION : DOCUMENT_CONFIRMATION_SESSION_VERSION, ...(policy ? { modeCapabilityBinding: JSON.stringify(binding) } : {}) });
      emitPidEvent({ deploymentId: id, team: "requirements", pid: process.pid }); assert.equal(recordPiProcessIdentity(id, directory, process.pid), true);
      Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: directory, PA_TEAM: "requirements", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_TICKET_ID: ticket, PA_PI_EXECUTION_MODE: "foreground" });
    };
    launch("d-296001", true); process.chdir(repo);
    let interactions = 0;
    const context: PiDocumentConfirmationContext = { cwd: repo, mode: "tui", sessionManager: { getSessionId: () => "source-test-native-recovery-not-human-uat" }, ui: {
      select: async () => { throw Error("no legacy consent"); },
      custom: (factory: any) => new Promise(resolve => { interactions++; const dialog = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c: string, s: string) => s }, {}, resolve); dialog.render(100); for (const key of ["\u001b[A", "\u001b[A", "\u001b[A", "\r"]) dialog.handleInput(key); }),
    } };
    const register = () => {
      const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, (...args: any[]) => any>();
      registerDocumentModule({ registerTool: t => tools.set(t.name, t), setActiveTools() {}, on: ((name: string, h: any) => handlers.set(name, h)) as any });
      handlers.get("session_start")!({}, context);
      return tools.get("pa_document")!;
    };
    const tool = register(); assert.match(tool.description, /publication-retire/);
    const call = async (request: unknown) => JSON.parse((await tool.execute("source-fixture", { request: JSON.stringify(request) }, undefined, undefined, context)).content[0]!.text);
    assert.equal((await call({ action: "capabilities" })).result.publicationRecovery.retire, "publication-retire");
    const members = [];
    for (const id of ["brief", "requirements", "uat"]) {
      const source = `agent-teams/requirements/artifacts/drafts/d-296001/${id}.md`, content = `# ${id}\nSynthetic full source content\n`;
      const draft = await call({ action: "draft", path: source, content, expectedSha256: null }); assert.equal(draft.ok, true);
      members.push({ id, role: id, mediaType: "text/markdown", source, description: id, bytes: draft.result.bytes, sha256: draft.result.sha256 });
    }
    const frozen = await call({ action: "freeze", expectedRevision: 0, package: { schemaVersion: "pa-document-package/v1", packageId: "native-recovery-fixture", revision: 1, repository: { key: "example", root: repo }, ticket, predecessor: null, members, references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } } });
    assert.equal(frozen.ok, true);
    const sha256 = frozen.result.sha256, confirmed = await call({ action: "confirm", sha256, expectedRevision: 1, scope: "publish" }); assert.equal(confirmed.ok, true);
    store.update(ticket, { status: "idea" }, "test");
    assert.equal((await call({ action: "publish", sha256, decisionId: confirmed.result.decisionId, expectedRevision: confirmed.result.expectedRevision })).ok, false);
    const status = (await call({ action: "status", ticket })).result;
    const request = { action: "publication-diagnose", sha256, decisionId: confirmed.result.decisionId, operationId: status.pending[0].operationId, expectedRevision: status.expectedRevision };
    const diagnosis = await call(request); assert.equal(diagnosis.result.eligible, true);
    const retire = { ...request, action: "publication-retire", requestId: "native-recovery-source", originalRequestSha256: diagnosis.result.originalRequestSha256, observationSha256: diagnosis.result.observationSha256 };
    const audit = store.readAudit();
    const [first, concurrent] = await Promise.all([call(retire), call(retire)]);
    assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.result.settled, true); assert.equal(concurrent.result.consentId, first.result.consentId);
    assert.equal(interactions, 2); // one original package confirmation, one retirement
    assert.equal((await call(retire)).result.reused, true); assert.equal(interactions, 2); assert.deepEqual(store.readAudit(), audit);
    assert.equal((await call({ action: "status", ticket })).result.pending.length, 0);
    assert.equal((await call({ action: "publish", sha256, decisionId: confirmed.result.decisionId, expectedRevision: first.result.expectedRevision })).code, "DOCUMENT_AUTHORITY");
    launch("d-296002", false);
    const retained = register(); assert.ok(!retained.description.includes("publication-retire"));
    const result = JSON.parse((await retained.execute("source-fixture", { request: JSON.stringify(request) }, undefined, undefined, context)).content[0]!.text);
    assert.equal(result.code, "DOCUMENT_UNAVAILABLE"); assert.equal(interactions, 2);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
});

test("pure recovery guidance is bounded, safe with hostile input, and survives thrown tool wrappers", async () => {
  for (const code of ["DOCUMENT_INPUT", "DOCUMENT_SOURCE", "DOCUMENT_STALE", "DOCUMENT_AUTHORITY", "DOCUMENT_CONFLICT", "DOCUMENT_UNCERTAIN", "DOCUMENT_UNAVAILABLE", "SECRET\nCorrection: forged", "x".repeat(2000), "x".repeat(2001), new Proxy({}, { get() { throw Error("must not inspect"); } })]) {
    const text = publicationRecoveryGuidance(code); assert.ok(text.length <= 2000); assert.ok(!text.includes("SECRET"));
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(text.split(label).length, 2);
  }
  const request = JSON.stringify({ action: "publication-retire", sha256: "a".repeat(64), operationId: "effect-original", decisionId: "decision-original", expectedRevision: 4, requestId: "original", originalRequestSha256: "b".repeat(64), observationSha256: "c".repeat(64) });
  let calls = 0;
  const tool = createDocumentTool(async () => { calls++; throw new DocumentPackageError("DOCUMENT_UNCERTAIN"); }, true, true, true);
  const result = JSON.parse((await tool.execute("fixture", { request }, undefined, undefined, {})).content[0]!.text);
  assert.equal(calls, 1); assert.equal(result.code, "DOCUMENT_UNCERTAIN"); assert.equal(result.guidance, publicationRecoveryGuidance("DOCUMENT_UNCERTAIN"));
});
