import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, emitStartedEvent, emitPidEvent, ensureDeployDir, parseModeCapabilityBinding, READONLY_DOCUMENT_SESSION,
  TicketStore, getTicketsDir, RegistryDocumentJournal, documentPackageSha, workflowDigest, associateDeploymentTicket, getDb, queryDeploymentStatus, type DocumentPackage } from "@pa-platform/pa-core";
import { recordPiProcessIdentity, recordPiReadonlyRoleProcessIdentity, PI_PROCESS_IDENTITY_FILE } from "../process-identity.js";
import { authenticatePiTicketCaller } from "../ticket-session.js";
import { mutatePiDocument } from "../document-native.js";
import { DOCUMENT_SESSION_VERSION } from "../document-session.js";
import { createPaTicketTool } from "../pi-extension/ticket-tool.js";
import { createPiSessionLifecycle, registerPiSessionModules, type PiToolDefinition } from "../pi-extension/index.js";
import { registerDocumentModule, assertPolicyDocumentTool } from "../pi-extension/document-tool.js";

const modes = [["requirements", "analyze"], ["requirements", "review-auto"], ["analyst", "analyze"], ["builder", "orchestrator"], ["builder", "implement"],
  ["builder", "worker"], ["coordinator", "coordinate"], ["instruction-lab", "develop"], ["review", "verify"], ["rollout", "rollout"], ["repo-setup", "setup"], ["rogue-one", "rogue-one"]] as const;
async function fixture(run: (root: string, repo: string, config: string) => Promise<void>): Promise<void> {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap334-native-admin-")); closeDb();
  try {
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_)/.test(key)) delete process.env[key];
    const repo = join(root, "selected"), other = join(root, "other"), config = join(root, "config"), teams = join(root, "teams");
    for (const path of [repo, other, config, teams]) mkdirSync(path);
    for (const path of [repo, other]) execFileSync("git", ["init", "-b", "develop"], { cwd: path, stdio: "pipe" });
    for (const team of new Set(modes.map(([team]) => team))) writeFileSync(join(teams, `${team}.yaml`), `name: ${team}\nagents:\n - name: native-agent\n   role: Fixture\n`);
    writeFileSync(join(config, "config.yaml"), `repos:\n selected:\n  path: ${repo}\n  prefix: SEL\n other:\n  path: ${other}\n  prefix: OTH\n`);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: teams, PA_AI_USAGE_HOME: join(root, "usage"), PA_REGISTRY_DB: join(root, "registry.db"), NO_COLOR: "1" });
    process.chdir(repo); await run(root, repo, config);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
}
function launch(repo: string, config: string, index: number, team: string, mode: string, selected: boolean) {
  const id = `d-334${String(index).padStart(3, "0")}`, directory = ensureDeployDir(id);
  const binding = selected ? parseModeCapabilityBinding({ schemaVersion: "pa-mode-capability-binding/v3", configRoot: config, configRevision: "a".repeat(40),
    resourcePath: `teams/${team}.yaml`, resourceSha256: "b".repeat(64), profile: "pa-readonly-document/v1", policy: { version: "pa-mode-capabilities/v1", allow: [] }, repoKey: "selected",
    identity: { publicTeam: team, publicMode: mode, effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" },
    resources: [{ path: `teams/${team}.yaml`, sha256: "b".repeat(64) }] }) : undefined;
  emitStartedEvent({ deploymentId: id, team, mode, runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo,
    ...(binding ? { note: READONLY_DOCUMENT_SESSION, modeCapabilityBinding: JSON.stringify(binding) } : {}) });
  emitPidEvent({ deploymentId: id, team, pid: process.pid });
  Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: directory, PA_TEAM: team, PA_MODE: mode, PA_REPO: repo,
    PA_REPO_ROOT: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
  delete process.env.PA_TICKET_ID;
  recordPiReadonlyRoleProcessIdentity(process.env, id, directory, process.pid);
  return { id, directory, context: { cwd: repo, mode: "tui", sessionManager: { getSessionId: () => "native-admin-session", getCwd: () => repo } } };
}
test("all current public modes: direct native administration for selected and cross-project targets, with and without document selection", async () => fixture(async (_root, repo, config) => {
  let index = 0;
  for (const selected of [false, true]) for (const [team, mode] of modes) {
    const f = launch(repo, config, index++, team, mode, selected), tool = createPaTicketTool();
    const call = async (input: Record<string, unknown>) => {
      const result = await tool.execute("source-fixture", input, undefined, undefined, f.context);
      assert.notEqual(result.isError, true, `${team}/${mode}: ${result.content[0]!.text}`);
      return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    };
    for (const project of ["selected", "other"]) {
      const create = { action: "create", project, requestId: `create-${project}`, fields: { title: `${team}/${mode} administration` } };
      const created = await call(create); assert.equal((await call(create)).reusedIntent, true);
      assert.equal(new TicketStore().get(String(created.id))!.assignee, "sinh", "validated default is not a team/mode agent name");
      const inspected = await call({ action: "inspect", project, id: created.id });
      const updated = await call({ action: "update", project, id: created.id, expectedVersion: inspected.version,
        fields: { title: "Updated", summary: "Summary", description: "Description", assignee: "sinh", priority: "high", estimate: "L", type: "bug", tags: ["admin"], blockedBy: [] } });
      const status = { action: "set-status", project, id: created.id, requestId: `status-${project}`, expectedVersion: updated.version, status: "review-uat" };
      assert.equal((await call(status)).status, "review-uat"); assert.equal((await call(status)).reusedIntent, true);
      await call({ action: "comment", project, id: created.id, content: "Native actor" });
      const store = new TicketStore(); assert.equal(store.get(String(created.id))!.comments[0]!.author, `${team}/${mode}`);
      assert.equal(store.readAudit().at(-1)!.actor, `${team}/${mode}`, "public authenticated role, not profile's effective document actor");
      const legacy = { action: "comment", id: created.id, author: `${team}/native-agent`, content: "Legacy configured agent attribution" };
      assert.equal(Check(tool.parameters, legacy), true, "published schema preserves former comment callers");
      assert.equal(Check(tool.parameters, { ...legacy, privileged: true }), false);
      await call(legacy);
      assert.equal(store.get(String(created.id))!.comments.at(-1)!.author, `${team}/${mode}`);
      for (const author of ["sinh", "foreign/agent", `${team}/invented-agent`]) {
        assert.equal((await tool.execute("spoof", { action: "comment", id: created.id, author, content: "No spoof" }, undefined, undefined, f.context)).details.code, "TICKET_ADMIN_INPUT");
      }
      const stale = await tool.execute("stale", { action: "update", project, id: created.id, expectedVersion: inspected.version, fields: { title: "Not written" } }, undefined, undefined, f.context);
      assert.equal(stale.details.code, "TICKET_ADMIN_STALE");
    }
    if (selected) {
      // Actual guarded registration and model tool-call guard, not merely a
      // permissive direct tool factory. An empty document selection is not an
      // administrative omission and must not relabel read-comment as write.
      const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>(); let active: string[] = [];
      const lifecycle = createPiSessionLifecycle(() => {});
      registerPiSessionModules({ registerTool(tool) { tools.set(tool.name, tool); }, setActiveTools(names) { active = names; },
        on(event: string, handler: (event: unknown, context: unknown) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } }, lifecycle,
      [pi => { pi.registerTool?.(createPaTicketTool()); }, registerDocumentModule]);
      for (const handler of handlers.get("session_start") ?? []) await handler({}, f.context);
      assert.deepEqual(active, ["pa_ticket"]);
      const input = { action: "create", project: "other", requestId: "guarded", fields: { title: "Infrastructure" } };
      assert.doesNotThrow(() => assertPolicyDocumentTool(f.id, { toolName: "pa_ticket", input }, f.context));
      for (const handler of handlers.get("tool_call") ?? []) assert.equal(await handler({ toolName: "pa_ticket", input }, f.context), undefined);
      assert.notEqual((await tools.get("pa_ticket")!.execute("guarded", input, undefined, undefined, f.context)).isError, true);
      assert.throws(() => assertPolicyDocumentTool(f.id, { toolName: "pa_workspace", input: {} }, f.context), /CAPABILITY_OMITTED/);
      await lifecycle.shutdown();
      await assert.rejects(tools.get("pa_ticket")!.execute("late", input, undefined, undefined, f.context), /shutting down/);
      if (team === "coordinator") {
        const omittedHandlers: ((event: unknown, context: unknown) => unknown)[] = [], omittedTools = new Set<string>(); let omittedActive: string[] = [];
        const omittedLifecycle = createPiSessionLifecycle(() => {});
        registerPiSessionModules({ registerTool(t) { omittedTools.add(t.name); }, setActiveTools(names) { omittedActive = names; },
          on(name: string, handler: (event: unknown, context: unknown) => unknown) { if (name === "session_start") omittedHandlers.push(handler); } }, omittedLifecycle, [registerDocumentModule]);
        for (const handler of omittedHandlers) await handler({}, f.context);
        assert.equal(omittedTools.has("pa_ticket"), false); assert.deepEqual(omittedActive, [], "explicit module omission does not fabricate an executable tool");
        await omittedLifecycle.shutdown();
      }
    }
  }
}));
test("real native document publication and its own queue intent remain distinct from generic administration", async () => fixture(async (_root, repo, config) => {
  const f = launch(repo, config, 202, "requirements", "analyze", false), tool = createPaTicketTool();
  getDb().prepare("UPDATE registry_events SET note=? WHERE deployment_id=? AND event='started'").run(DOCUMENT_SESSION_VERSION, f.id);
  const context = { ...f.context, ui: { select: async (_title: string, choices: string[]) => choices[0] } };
  const created = await tool.execute("create", { action: "create", project: "selected", requestId: "document-ticket", fields: { title: "Document native ticket" } }, undefined, undefined, context);
  assert.notEqual(created.isError, true, JSON.stringify(created));
  const metadata = JSON.parse(created.content[0]!.text) as Record<string, unknown>, id = String(metadata.id);
  assert.notEqual((await tool.execute("document-status", { action: "set-status", project: "selected", id, requestId: "document-status", expectedVersion: metadata.version, status: "requirement-review" }, undefined, undefined, context)).isError, true);
  const artifactRoot = process.env.PA_AI_USAGE_HOME!;
  const members = (["brief", "requirements", "uat"] as const).map(role => {
    const content = `# ${role}\nNative document content.\n`, source = `agent-teams/requirements/artifacts/reviews/${id}/r001/${role}.md`;
    mkdirSync(join(artifactRoot, `agent-teams/requirements/artifacts/reviews/${id}/r001`), { recursive: true });
    writeFileSync(join(artifactRoot, source), content);
    return { id: role, role, source, mediaType: "text/markdown" as const, description: role, bytes: Buffer.byteLength(content), sha256: workflowDigest(content) };
  });
  const subject: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: "native", revision: 1, repository: { key: "selected", root: repo }, ticket: id,
    predecessor: null, members, references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
  const journal = new RegistryDocumentJournal(getDb()), revision = () => journal.events("selected", id).length;
  const document = (request: Record<string, unknown>) => mutatePiDocument(JSON.stringify(request), context);
  const frozen = await document({ action: "freeze", package: subject, expectedRevision: 0 }); assert.equal(frozen.ok, true, JSON.stringify(frozen));
  const sha256 = documentPackageSha(subject);
  const captured = await document({ action: "capture", sha256, expectedRevision: revision() }); assert.equal(captured.ok, true, JSON.stringify(captured));
  const decision = journal.events("selected", id).find(e => e.data.kind === "decision")!.data;
  assert.equal(decision.kind, "decision"); if (decision.kind !== "decision") throw Error("Missing native decision");
  const coordinates = { sha256, decisionId: decision.decisionId };
  const published = await document({ action: "publish", ...coordinates, expectedRevision: revision() }); assert.equal(published.ok, true, JSON.stringify(published));
  const generic = (content: string) => tool.execute("generic", { action: "comment", project: "selected", id, content }, undefined, undefined, context);
  assert.notEqual((await generic("Completed publication is history")).isError, true);
  const update = TicketStore.prototype.update;
  try {
    TicketStore.prototype.update = () => { throw Error("Synthetic interruption before native queue"); };
    assert.equal((await document({ action: "queue", ...coordinates, expectedRevision: revision() })).ok, false);
  } finally { TicketStore.prototype.update = update; }
  const pendingReply = await generic("Cannot overwrite the pending queue owner");
  assert.equal(pendingReply.details.code, "TICKET_STATUS_OWNER"); assert.equal(pendingReply.isError, true);
  const pendingText = pendingReply.content[0]!.text;
  assert.match(pendingText, /Document replay found pending publication or queue effects/);
  assert.match(pendingText, /competing-deployment checks were not evaluated/);
  assert.match(pendingText, /original document operation owner/);
  assert.ok(pendingText.length <= 2000);
  assert.deepEqual(Object.keys(pendingReply.details), ["code"]);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(pendingText.split(`${label}:`).length, 2);
  const queued = await document({ action: "queue", ...coordinates, expectedRevision: revision() }); assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(new TicketStore().get(id)!.status, "pending-implementation");
  assert.notEqual((await generic("Settled native queue is not a blanket stage fence")).isError, true);
}));
test("malformed native requests do not initialize an absent ticket directory", async () => fixture(async (_root, repo, config) => {
  const f = launch(repo, config, 200, "coordinator", "coordinate", false), tool = createPaTicketTool();
  assert.equal(existsSync(getTicketsDir()), false);
  for (const input of [
    { action: "create", project: "other", requestId: "bad", fields: { title: "Safe", status: "done" } },
    { action: "comment", id: "OTH-001", author: "sinh", content: "Invalid native attribution" },
    { action: "update", project: "other", id: "OTH-001", expectedVersion: "bad", fields: { title: "Bad" } },
    { action: "create", project: "other", requestId: "bad", fields: { title: "-----BEGIN PRIVATE; KEY-----" } },
  ]) {
    assert.equal((await tool.execute("bad", input, undefined, undefined, f.context)).details.code, "TICKET_ADMIN_INPUT");
    assert.equal(existsSync(getTicketsDir()), false);
  }
}));
test("well-shaped native semantic rejections do not initialize an absent ticket directory", async () => fixture(async (_root, repo, config) => {
  const f = launch(repo, config, 203, "coordinator", "coordinate", false), tool = createPaTicketTool();
  const deny = async (input: Record<string, unknown>) => {
    assert.equal((await tool.execute("semantic-preflight", input, undefined, undefined, f.context)).details.code, "TICKET_ADMIN_INPUT");
    assert.equal(existsSync(getTicketsDir()), false, "semantic preflight must precede writable context/store construction");
  };
  const create = { action: "create", project: "other", requestId: "semantic", fields: { title: "Safe" } };
  assert.equal(existsSync(getTicketsDir()), false);
  await deny({ ...create, project: "unknown-project" });
  for (const project of ["unknown-project", "other"]) for (const request of [
    { action: "inspect", project, id: "OTH-001" },
    { action: "comment", project, id: "OTH-001", content: "Safe" },
    { action: "update", project, id: "OTH-001", expectedVersion: "a".repeat(64), fields: { summary: "Safe" } },
    { action: "set-status", project, id: "OTH-001", expectedVersion: "a".repeat(64), requestId: "semantic", status: "idea" },
  ]) await deny(request);
  const policy = join(config, "sensitive-patterns.yaml");
  writeFileSync(policy, "contents:\n - '^sinh$'\n");
  await deny(create);
  await deny({ ...create, fields: { title: "Safe", assignee: "sinh" } });
  writeFileSync(policy, "contents:\n - '^medium$'\n");
  await deny(create);
  writeFileSync(policy, "contents: []\n");
  const created = await tool.execute("valid-after-preflight", create, undefined, undefined, f.context);
  assert.notEqual(created.isError, true); assert.equal(existsSync(getTicketsDir()), true);
  const store = new TicketStore(), before = store.get("OTH-001"), audit = store.readAudit();
  for (const action of ["inspect", "comment", "update", "set-status"]) {
    const input = { action, project: "selected", id: "OTH-001", ...(action === "comment" ? { content: "Safe" }
      : action === "update" ? { expectedVersion: "a".repeat(64), fields: { title: "Safe" } }
        : action === "set-status" ? { expectedVersion: "a".repeat(64), requestId: "mismatch", status: "idea" } : {}) };
    assert.equal((await tool.execute("mismatched-project", input, undefined, undefined, f.context)).details.code, "TICKET_ADMIN_INPUT");
    assert.deepEqual(store.get("OTH-001"), before); assert.deepEqual(store.readAudit(), audit);
  }
}));
test("linked worktree authentication retains physical and registered common-root checks", async () => fixture(async (root, repo, config) => {
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture"], { cwd: repo, stdio: "pipe" });
  const linked = join(root, "linked");
  execFileSync("git", ["worktree", "add", "--detach", linked], { cwd: repo, stdio: "pipe" });
  const f = launch(repo, config, 201, "coordinator", "coordinate", false);
  getDb().prepare("UPDATE registry_events SET repo=?, worktree_root=? WHERE deployment_id=? AND event='started'").run(linked, linked, f.id);
  getDb().prepare("UPDATE deployments SET repo=?, worktree_root=? WHERE deployment_id=?").run(linked, linked, f.id);
  Object.assign(process.env, { PA_REPO: linked, PA_WORKTREE_ROOT: linked }); process.chdir(linked);
  const context = { ...f.context, cwd: linked, sessionManager: { getSessionId: () => "native-admin-session", getCwd: () => linked } };
  assert.equal(authenticatePiTicketCaller(context).repoKey, "selected");
  assert.notEqual((await createPaTicketTool().execute("linked-create", { action: "create", project: "other", requestId: "linked", fields: { title: "Linked administration" } }, undefined, undefined, context)).isError, true);
  getDb().prepare("UPDATE registry_events SET repo_root=? WHERE deployment_id=? AND event='started'").run(config, f.id);
  getDb().prepare("UPDATE deployments SET repo_root=? WHERE deployment_id=?").run(config, f.id);
  process.env.PA_REPO_ROOT = config;
  assert.throws(() => authenticatePiTicketCaller(context), /TICKET_ADMIN_SESSION/);
}));
test("native identity: genuine child lineage, sibling process spoof, stale anchor, environment/session and association drift fail closed", async () => fixture(async (_root, repo, config) => {
  const f = launch(repo, config, 100, "coordinator", "coordinate", false), tool = createPaTicketTool();
  const input = { action: "create", project: "selected", requestId: "safe", fields: { title: "Safe" } };
  const deny = async () => assert.equal((await tool.execute("denied", input, undefined, undefined, f.context)).details.code, "TICKET_ADMIN_SESSION");
  const source = fileURLToPath(new URL("../ticket-session.ts", import.meta.url));
  const script = `import { authenticatePiTicketCaller } from ${JSON.stringify(source)}; console.log(authenticatePiTicketCaller({cwd:process.cwd(),mode:'tui',sessionManager:{getSessionId:()=> 'native-admin-session'}}).team);`;
  assert.equal(execFileSync(process.execPath, [`--import=${import.meta.resolve("tsx")}`, "--input-type=module", "-e", script], { cwd: repo, env: process.env, encoding: "utf8" }).trim(), "coordinator");
  for (const [key, wrong] of Object.entries({ PA_TEAM: "analyst", PA_MODE: "analyze", PA_REPO: config, PA_WORKTREE_ROOT: config, PA_DEPLOYMENT_DIR: config, PA_TICKET_ID: "SEL-999", PI_SESSION_ID: "foreign" })) {
    const before = process.env[key]; process.env[key] = wrong; await deny(); if (before === undefined) delete process.env[key]; else process.env[key] = before;
  }
  assert.throws(() => authenticatePiTicketCaller({ ...f.context, sessionManager: { getSessionId: () => "", getCwd: () => repo } }), /TICKET_ADMIN_SESSION/);
  const path = join(f.directory, PI_PROCESS_IDENTITY_FILE), original = readFileSync(path, "utf8");
  const identity: { processFingerprint: { startTimeTicks: string } } = JSON.parse(original); identity.processFingerprint.startTimeTicks = "0";
  writeFileSync(path, JSON.stringify(identity)); await deny(); writeFileSync(path, original);
  const sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    assert.ok(sibling.pid); emitPidEvent({ deploymentId: f.id, team: "coordinator", pid: sibling.pid });
    assert.equal(recordPiProcessIdentity(f.id, f.directory, sibling.pid), true); await deny();
  } finally { sibling.kill(); await new Promise<void>((resolve, reject) => { sibling.once("exit", () => resolve()); sibling.once("error", reject); }); }
  emitPidEvent({ deploymentId: f.id, team: "coordinator", pid: process.pid }); recordPiProcessIdentity(f.id, f.directory, process.pid);
  const created = await tool.execute("safe", input, undefined, undefined, f.context); assert.notEqual(created.isError, true);
  const id = String((JSON.parse(created.content[0]!.text) as Record<string, unknown>).id);
  associateDeploymentTicket({ deploymentId: f.id, ticketId: id, expectedTicketId: null, actor: "coordinator/coordinate", reason: "Disposable association" });
  assert.ok(authenticatePiTicketCaller(f.context)); assert.equal(queryDeploymentStatus(f.id)!.ticket_id, id);
  getDb().prepare("UPDATE deployments SET ticket_id=? WHERE deployment_id=?").run("SEL-999", f.id); await deny();
  getDb().prepare("UPDATE deployments SET ticket_id=? WHERE deployment_id=?").run(id, f.id);
  const inspected = await tool.execute("inspect-race", { action: "inspect", project: "selected", id }, undefined, undefined, f.context);
  const version = (JSON.parse(inspected.content[0]!.text) as Record<string, unknown>).version;
  const toolSource = fileURLToPath(new URL("../pi-extension/ticket-tool.ts", import.meta.url));
  const race = async (summary: string) => {
    const request = { action: "update", project: "selected", id, expectedVersion: version, fields: { summary } };
    const script = `import { createPaTicketTool } from ${JSON.stringify(toolSource)}; const r = await createPaTicketTool().execute('race',${JSON.stringify(request)},undefined,undefined,{cwd:process.cwd(),mode:'tui',sessionManager:{getSessionId:()=> 'native-admin-session'}}); console.log(JSON.stringify({isError:r.isError===true,code:r.details.code}));`;
    const child = await promisify(execFile)(process.execPath, [`--import=${import.meta.resolve("tsx")}`, "--input-type=module", "-e", script], { cwd: repo, env: process.env });
    return JSON.parse(child.stdout) as { isError: boolean; code?: string };
  };
  const contenders = await Promise.all([race("First contender"), race("Second contender")]);
  assert.equal(contenders.filter(row => !row.isError).length, 1);
  assert.equal(contenders.find(row => row.isError)!.code, "TICKET_ADMIN_STALE");
  const before = new TicketStore().readAudit();
  for (const bad of [{ ...input, actor: "sinh" }, { ...input, fields: { title: "-----BEGIN PRIVATE KEY-----" } }, { ...input, fields: { title: "Safe", status: "done" } }]) {
    assert.equal((await tool.execute("bad", bad, undefined, undefined, f.context)).details.code, "TICKET_ADMIN_INPUT");
  }
  assert.deepEqual(new TicketStore().readAudit(), before);
  const abort = new AbortController(); abort.abort(); assert.equal((await tool.execute("abort", input, abort.signal, undefined, f.context)).details.code, "TICKET_ADMIN_SESSION");
  const large = await tool.execute("large", { action: "create", project: "other", requestId: "large", fields: { title: "Large response", description: '"'.repeat(30000) } }, undefined, undefined, f.context);
  assert.notEqual(large.isError, true);
  const largeId = (JSON.parse(large.content[0]!.text) as Record<string, unknown>).id;
  const bounded = await tool.execute("inspect-large", { action: "inspect", project: "other", id: largeId }, undefined, undefined, f.context);
  const summary = JSON.parse(bounded.content[0]!.text) as Record<string, unknown>;
  assert.equal(summary.output, "bounded-summary-body-omitted"); assert.match(String(summary.version), /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(bounded.content[0]!.text) <= 50 * 1024);
  delete process.env.PA_DEPLOYMENT_ID; await deny();
}));
