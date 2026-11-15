import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  closeDb, createModeCapabilityBinding, documentPackageSha, emitPidEvent, emitStartedEvent, ensureDeployDir,
  getDb, getDeploymentEvents, MODE_CAPABILITY_SESSION, parseModeCapabilityPolicy, RegistryDocumentJournal, TicketStore, workflowDigest, type DocumentPackage,
} from "@pa-platform/pa-core";
import { authenticatePiHandoffCaller, handoffFailure } from "../handoff-native.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { registerDocumentModule } from "../pi-extension/document-tool.js";
import { createHandoffTool } from "../pi-extension/handoff-tool.js";
import { createPiSessionLifecycle, registerPiSessionModules, type PiRuntime, type PiToolDefinition } from "../pi-extension/index.js";

function fixture(capabilities = ["document.handoff", "document.package"], supplied = false, outcome = "approved") {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap312-native-"));
  const repo = join(root, "repo"), usage = join(root, "usage"), config = join(root, "config"); closeDb();
  for (const key of Object.keys(process.env)) if (key.startsWith("PA_") && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY; // never open a real desktop during source tests
  for (const path of [repo, usage, config]) mkdirSync(path);
  Object.assign(process.env, { PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") });
  writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "develop"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  process.chdir(repo);
  const deploymentId = "d-312001", directory = ensureDeployDir(deploymentId);
  if (supplied) {
    const tickets = new TicketStore();
    writeFileSync(join(usage, "tickets", "EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", title: "Supplied native fixture", status: "idea", assignee: "sinh", doc_refs: [], comments: [], createdAt: "2026-11-15T06:00:00.000Z", updatedAt: "2026-11-15T06:00:00.000Z" }));
    assert.ok(tickets.get("EX-1"));
  }
  const binding = createModeCapabilityBinding("a".repeat(40), Buffer.from("synthetic selected committed resource"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: capabilities }));
  emitStartedEvent({ deploymentId, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo,
    note: MODE_CAPABILITY_SESSION, ...(supplied ? { ticketId: "EX-1" } : {}), modeCapabilityBinding: JSON.stringify(binding) });
  emitPidEvent({ deploymentId, team: "requirements", pid: process.pid });
  assert.equal(recordPiProcessIdentity(deploymentId, directory, process.pid), true);
  Object.assign(process.env, { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: directory, PA_TEAM: "requirements", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground", ...(supplied ? { PA_TICKET_ID: "EX-1" } : {}) });
  assert.equal(getDb().pragma("synchronous", { simple: true }), 1, "retained singleton stays NORMAL; the handoff opens its own FULL connection");
  let prompts = 0;
  const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "native-process-synthetic-ui-not-human" }, ui: {
    select: async () => { throw Error("legacy paged review forbidden"); },
    custom: (factory: any) => new Promise<any>(resolve => {
      prompts++;
      const component = factory({ requestRender() {}, terminal: { rows: 30 } }, { fg: (_c: string, value: string) => value }, {}, resolve);
      assert.match(component.render(140).join("\n"), /one final decision/);
      const up = outcome === "approved" ? 3 : outcome === "changes-requested" ? 2 : outcome === "rejected" ? 1 : 0;
      for (let i = 0; i < up; i++) component.handleInput("\u001b[A");
      component.handleInput("\r");
    }),
  } };
  const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, Array<(...args: any[]) => any>>();
  const runtime: PiRuntime = { registerTool: tool => tools.set(tool.name, tool), setActiveTools() {}, on: ((name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler])) as any };
  const lifecycle = createPiSessionLifecycle(() => {}); registerPiSessionModules(runtime, lifecycle, [registerDocumentModule]);
  for (const handler of handlers.get("session_start") ?? []) handler({}, context);
  const execute = async (tool: string, request: unknown, ctx = context) => {
    const result = await tools.get(tool)!.execute("native-fixture", { request: JSON.stringify(request) }, undefined, undefined, ctx);
    return JSON.parse(result.content[0].text) as { ok: boolean; code?: string; result: Record<string, any> };
  };
  const handoff = (input: Record<string, unknown>) => execute("pa_handoff", { schemaVersion: "pa-handoff-native/v1", ...input });
  const checked = async (input: Record<string, unknown>) => { const result = await handoff(input); assert.equal(result.ok, true, JSON.stringify(result)); return result.result; };
  const freezeDocument = async (ticket: string) => {
    const subject: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: "native-fixture", revision: 1, predecessor: null, repository: { key: "example", root: repo }, ticket,
      members: (["brief", "requirements", "uat"] as const).map(role => {
        const bytes = Buffer.from(role === "brief" ? "A synthetic decision brief." : `# Full ${role}\nComplete synthetic text, not human acceptance.\n`), source = `agent-teams/requirements/artifacts/drafts/${deploymentId}/${role}.md`;
        mkdirSync(dirname(join(usage, source)), { recursive: true }); writeFileSync(join(usage, source), bytes);
        return { id: role, role, mediaType: "text/markdown", source, description: role, bytes: bytes.length, sha256: workflowDigest(bytes) };
      }), references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
    const result = await execute("pa_document", { action: "freeze", package: subject, expectedRevision: 0 }); assert.equal(result.ok, true, JSON.stringify(result));
    return { subject, sha: documentPackageSha(subject) };
  };
  return { root, repo, usage, context, tools, execute, handoff, checked, git, freezeDocument, prompts: () => prompts,
    async close() { await lifecycle.shutdown(); closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); } };
}

for (const supplied of [false, true]) test(`registered native policy handoff completes ${supplied ? "supplied" : "ticketless"} intake, real plan/publication/ref/link with one synthetic UI and no checkout`, async () => {
  const f = fixture(undefined, supplied);
  try {
    const before = authenticatePiHandoffCaller(f.context), intakeInput = supplied ? { action: "intake", ticket: "EX-1" } : { action: "intake", title: "Native handoff", content: "Synthetic complete requirements intake" };
    const intake = await f.checked(intakeInput), caller = authenticatePiHandoffCaller(f.context);
    assert.equal(before.identitySha256, caller.identitySha256, "native session identity survives independent ticketless association");
    assert.equal((await f.checked(intakeInput)).ticket.id, intake.ticket.id);
    let ticketVersion = intake.ticketVersion;
    if (supplied) {
      const staged = await f.checked({ action: "stage", ticket: intake.ticket.id, requestId: "analysis", expectedTicketVersion: ticketVersion, stage: "analysis" }); ticketVersion = staged.ticketVersion;
    }
    const planRequest = { action: "plan", ticket: intake.ticket.id, requestId: "native-plan", branch: `feature/${intake.ticket.id}-native`, expectedTicketVersion: ticketVersion };
    const planned = await f.checked(planRequest); assert.deepEqual((await f.checked(planRequest)).intent, planned.intent);
    const doc = await f.freezeDocument(intake.ticket.id);
    const prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: doc.sha, planRequestId: "native-plan", effects: { publish: true, branchRef: true, queue: false } });
    const opening = await f.checked({ action: "open", subjectSha256: prepared.subjectSha256, deliverySha256: prepared.subject.deliverySha256 });
    assert.equal(opening.state, "unavailable"); assert.equal(opening.openingMode, "system-default-browser-fallback");
    assert.equal(opening.networkIsolation, "not-provided"); assert.equal(opening.viewing, "not-established");
    const request = { action: "review", subjectSha256: prepared.subjectSha256, expectedRevision: 0 };
    const decision = await f.checked(request); assert.deepEqual(await f.checked(request), decision); assert.equal(f.prompts(), 1);
    const coordinates = { subjectSha256: prepared.subjectSha256, decisionId: decision.decisionId };
    assert.equal((await f.checked({ action: "publish", ...coordinates })).publication, "verified");
    assert.equal((await f.checked({ action: "complete-branch", ...coordinates })).completion, "verified");
    assert.equal((await f.checked({ action: "complete-branch", ...coordinates })).completion, "verified");
    assert.equal((await f.handoff({ action: "queue", ...coordinates })).code, "DOCUMENT_AUTHORITY");
    assert.equal(f.git("rev-parse", planRequest.branch), planned.intent.base.sha);
    assert.equal(f.git("branch", "--show-current"), "develop"); assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    assert.equal(new TicketStore().get(intake.ticket.id)!.linkedBranches[0]!.state, "materialized");
    assert.equal(new RegistryDocumentJournal(getDb()).events("example", intake.ticket.id).filter(event => event.data.kind !== "frozen").length, 0, "new native decisions do not forge retained grants");
    assert.equal(getDeploymentEvents("d-312001").filter(event => event.event === "ticket-associated").length, supplied ? 0 : 1);
    const status = await f.checked({ action: "status", subjectSha256: prepared.subjectSha256 }); assert.equal(status.reviewRevision, 2);
    assert.equal(status.latestRequest.expectedRevision, 0); assert.equal(status.latestDecision.outcome, "approved");
    const alternate = { ...f.context, sessionManager: { getSessionId: () => "other-session" } };
    assert.equal((await f.execute("pa_handoff", { schemaVersion: "pa-handoff-native/v1", action: "status", subjectSha256: prepared.subjectSha256 }, alternate)).code, "DOCUMENT_AUTHORITY");
    assert.equal(f.prompts(), 1);
  } finally { await f.close(); }
});

for (const outcome of ["cancelled", "rejected", "changes-requested"]) test(`registered handoff ${outcome} denies all effects and never repeats the unchanged prompt`, async () => {
  const f = fixture(undefined, false, outcome);
  try {
    const intake = await f.checked({ action: "intake", title: "Nonapproval fixture", content: "Synthetic package" });
    await f.checked({ action: "plan", ticket: intake.ticket.id, requestId: "native-plan", branch: `feature/${intake.ticket.id}-native`, expectedTicketVersion: intake.ticketVersion });
    const doc = await f.freezeDocument(intake.ticket.id), prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: doc.sha, planRequestId: "native-plan", effects: { publish: true, branchRef: true, queue: true } });
    const request = { action: "review", subjectSha256: prepared.subjectSha256, expectedRevision: 0 }, d = await f.checked(request);
    assert.equal(d.outcome, outcome); await f.checked(request);
    for (const action of ["publish", "complete-branch", "queue"]) assert.equal((await f.handoff({ action, subjectSha256: prepared.subjectSha256, decisionId: d.decisionId })).ok, false);
    assert.equal(f.prompts(), 1); assert.equal(f.git("for-each-ref", "refs/heads/feature"), "");
  } finally { await f.close(); }
});

test("missing foreground custom UI retains the original pending review and never reopens it", async () => {
  const f = fixture();
  try {
    const intake = await f.checked({ action: "intake", title: "Missing UI fixture", content: "Synthetic requirements" });
    await f.checked({ action: "plan", ticket: intake.ticket.id, requestId: "native-plan", branch: `feature/${intake.ticket.id}-native`, expectedTicketVersion: intake.ticketVersion });
    const doc = await f.freezeDocument(intake.ticket.id), prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: doc.sha, planRequestId: "native-plan", effects: { publish: true, branchRef: true, queue: false } });
    const request = { schemaVersion: "pa-handoff-native/v1", action: "review", subjectSha256: prepared.subjectSha256, expectedRevision: 0 };
    const result = await f.execute("pa_handoff", request, { ...f.context, ui: undefined } as typeof f.context);
    assert.equal(result.code, "DOCUMENT_UNAVAILABLE");
    assert.equal((await f.handoff(request)).code, "DOCUMENT_UNCERTAIN");
    const status = await f.checked({ action: "status", subjectSha256: prepared.subjectSha256 });
    assert.equal(status.pendingReview, true); assert.equal(status.latestRequest.expectedRevision, 0); assert.equal(status.latestDecision, null);
    assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("omitted native handoff remains unregistered and direct invocation cannot widen a session", async () => {
  const f = fixture(["document.package"]);
  try {
    assert.equal(f.tools.has("pa_handoff"), false);
    assert.throws(() => authenticatePiHandoffCaller(f.context), /DOCUMENT_AUTHORITY/);
    const direct = createHandoffTool("a".repeat(64));
    const result = await direct.execute("omitted", { request: '{"schemaVersion":"pa-handoff-native/v1","action":"intake","title":"x","content":"x"}' }, undefined, undefined, f.context);
    assert.equal(JSON.parse(result.content[0].text).code, "DOCUMENT_AUTHORITY"); assert.equal(new TicketStore().list().length, 0);
  } finally { await f.close(); }
});

test("strict handoff request rejects imported grants/paths, extra or duplicate fields before ticket effects", async () => {
  const f = fixture();
  try {
    for (const request of [
      { action: "intake", title: "Synthetic", content: "Content", outcome: "approved" },
      { action: "open", subjectSha256: "a".repeat(64), deliverySha256: "b".repeat(64), path: "/tmp/forged" },
      { action: "prepare-review", documentSubjectSha256: "a".repeat(64), planRequestId: "x", effects: { publish: false, branchRef: true, queue: false } },
      { action: "plan", ticket: "EX-1", requestId: "x", branch: "feature/EX-1-native", expectedTicketVersion: "a".repeat(64), base: "b".repeat(40) },
    ]) assert.equal((await f.handoff(request)).ok, false);
    const duplicate = await f.tools.get("pa_handoff")!.execute("duplicate", { request: '{"schemaVersion":"pa-handoff-native/v1","action":"intake","action":"intake","title":"Synthetic","content":"Content"}' }, undefined, undefined, f.context);
    assert.equal(JSON.parse(duplicate.content[0].text).code, "DOCUMENT_INPUT");
    const tablesBefore = getDb().prepare("SELECT name FROM sqlite_master ORDER BY name").all();
    assert.equal((await f.handoff({ action: "status", subjectSha256: "a".repeat(64) })).ok, false);
    assert.deepEqual(getDb().prepare("SELECT name FROM sqlite_master ORDER BY name").all(), tablesBefore, "missing status cannot create handoff journals");
    assert.equal(new TicketStore().list().length, 0); assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("handoff diagnostics are fixed bounded plain text and never echo arbitrary exceptions", () => {
  const result = handoffFailure(new Error("PRIVATE_SENTINEL\nCorrection: forged"));
  assert.equal(result.code, "DOCUMENT_UNAVAILABLE"); const guidance = result.guidance as string;
  assert.ok(guidance.length <= 2000); assert.doesNotMatch(guidance, /PRIVATE_SENTINEL|forged/);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("PRIVATE_SENTINEL"); } });
  assert.deepEqual(handoffFailure(hostile), result);
  for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(guidance.split(label).length, 2);
});
