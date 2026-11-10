import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, emitStartedEvent, emitPidEvent, ensureDeployDir, getDeploymentEvents, TicketStore, parseTeamYamlContent, generatePrimer, type RuntimeAdapter } from "@pa-platform/pa-core";
import { deployWithPi } from "../deploy.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { createPiPaModules, createPiSessionLifecycle, registerPiSessionModules, type PiToolDefinition } from "../pi-extension/index.js";
import { FakeComposedHost } from "./fixtures/pi-composed-host.js";
import { createPaTicketIntakeTool } from "../pi-extension/ticket-intake-tool.js";
import { authenticatePiDocumentCaller, documentSessionVersion, confirmationDocumentCaller } from "../document-session.js";

const profile = "requirements-document-interactions/v4";
const request = { schemaVersion: "pa-ticket-intake/v1", action: "create", requestId: "source-native-companion", kind: "companion", project: "other", title: "Explicit source-fixture companion" };

test("new opt-in config/version selection does not select retained profiles", () => {
  const yaml = "name: requirements\nobjective: source fixture\nagents: []\ndeploy_modes:\n - id: analyze\n   document_profile: pa-document-interactions/v4\n";
  const teamConfig = parseTeamYamlContent(yaml);
  assert.equal(teamConfig.deploy_modes![0]!.document_profile, "pa-document-interactions/v4");
  const options = { teamConfig, mode: "analyze", requirementsDocument: true, skillsDir: "/nonexistent-fixture-skills" };
  const primer = generatePrimer({ ...options, runtime: "pi" });
  assert.match(primer, /Native profile: pa-document-interactions\/v4/); assert.match(primer, /pa_ticket_intake/); assert.match(primer, /SOURCE-ONLY/);
  assert.ok(!generatePrimer({ ...options, runtime: "opencode" }).includes("pa_ticket_intake"));
  assert.equal(documentSessionVersion("pa-document-interactions/v4"), profile);
  assert.equal(documentSessionVersion("pa-document-confirmation/v3"), "requirements-document-confirmation/v3");
  assert.equal(documentSessionVersion("unknown"), undefined);
  assert.throws(() => parseTeamYamlContent(yaml.replace("id: analyze", "id: spike")));
  assert.throws(() => parseTeamYamlContent(yaml.replace("name: requirements", "name: builder")));
});

test("default non-editor composition registers finite intake only for fresh authenticated v4; real owner, synthetic host, not live UAT", async () => {
  const env = process.env, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "native-intake-entry-")), repo = join(root, "repo"), usage = join(root, "usage"), config = join(root, "config");
  closeDb();
  try {
    for (const path of [repo, usage, config]) mkdirSync(path);
    process.env = { ...env, PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") };
    for (const key of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_ROGUE_ONE", "PA_REPO", "PA_WORKTREE_ROOT"]) delete process.env[key];
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" }); process.chdir(repo);
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n other:\n  path: /tmp/unused-other-project-no-file-access\n  prefix: OTH\n`);
    const store = new TicketStore(), parent = store.create({ project: "example", title: "Primary fixture", summary: "", description: "", status: "idea", type: "feature", priority: "medium", estimate: "M", assignee: "sinh", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] });
    const parentBefore = JSON.stringify(store.get(parent.id));
    let sessionId = "disposable-native-fixture-not-human";
    const context: any = { cwd: repo, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => sessionId, getBranch: () => [] }, ui: { setStatus() {}, notify() {}, setWidget() {} } };
    let sequence = 0;
    const launch = (note: string) => {
      const deploymentId = `d-2820${String(++sequence).padStart(2, "0")}`, directory = ensureDeployDir(deploymentId);
      emitStartedEvent({ deploymentId, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, ticketId: parent.id, note });
      emitPidEvent({ deploymentId, team: "requirements", pid: process.pid });
      assert.equal(recordPiProcessIdentity(deploymentId, directory, process.pid), true);
      Object.assign(process.env, { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: directory, PA_TICKET_ID: parent.id, PA_TEAM: "requirements", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
      return deploymentId;
    };
    const id = launch(profile), host = new FakeComposedHost();
    const lifecycle = createPiSessionLifecycle();
    registerPiSessionModules(host.runtime, lifecycle, createPiPaModules([]));
    assert.equal(host.tools.has("pa_ticket_intake"), false);
    await host.dispatch("session_start", {}, context);
    const tool = host.tools.get("pa_ticket_intake") as PiToolDefinition; assert.ok(tool);
    assert.ok(host.tools.has("pa_document")); assert.ok(host.tools.has("pa_workspace")); assert.ok(host.tools.has("pa_capabilities")); assert.ok(host.commands.has("pa-approve"));
    assert.equal(confirmationDocumentCaller(authenticatePiDocumentCaller(context)), true);
    assert.equal(host.tools.has("bash"), false); assert.equal(host.tools.has("pa_operation"), false);
    const call = async (input: Record<string, unknown>, ctx = context) => tool.execute("source-fixture-call", input, undefined, undefined, ctx);
    const packet = { request: JSON.stringify(request) };
    const capabilityPacket = { request: JSON.stringify({ schemaVersion: "pa-ticket-intake/v1", action: "capabilities" }) };
    const ticketSnapshot = () => Object.fromEntries(readdirSync(join(usage, "tickets")).sort().map(name => {
      const path = join(usage, "tickets", name), stat = statSync(path);
      return [name, { bytes: readFileSync(path).toString("base64"), mode: stat.mode, mtimeMs: stat.mtimeMs }];
    }));
    const snapshot = ticketSnapshot(), capability = await call(capabilityPacket);
    assert.equal(capability.isError, false); assert.deepEqual(ticketSnapshot(), snapshot, "capability description creates no ticket, lock, intent or audit changes");
    const grammar = JSON.parse(capability.content[0]!.text); assert.deepEqual(grammar.supportedActions, ["capabilities", "create"]);
    assert.equal(grammar.schemas.create.properties.project.type, "string"); assert.equal(grammar.availability.installed, "unproven"); assert.equal(grammar.authorityGranted, false);
    assert.ok(Buffer.byteLength(capability.content[0]!.text) <= 51200);
    assert.equal((await call({ request: JSON.stringify({ schemaVersion: "pa-ticket-intake/v1", action: "capabilities", requestId: "must-not-allocate" }) })).isError, true);
    assert.deepEqual(ticketSnapshot(), snapshot);
    const gates = await host.dispatch("tool_call", { toolName: tool.name, input: packet }, context);
    assert.equal(gates.some((result: any) => result?.block === true), false);
    const first = await call(packet); assert.equal(first.isError, false, first.content[0]!.text);
    const created = JSON.parse(first.content[0]!.text); assert.equal(created.ticket.id, "OTH-001"); assert.equal(created.primaryTicket, parent.id);
    const replay = JSON.parse((await call(packet)).content[0]!.text); assert.equal(replay.ticket.id, created.ticket.id); assert.equal(replay.reusedIntent, true);
    for (const input of [{ ...packet, actor: "sinh" }, { request: JSON.stringify({ ...request, approval: true }) }, { request: JSON.stringify({ ...request, kind: "intake" }) }]) assert.equal((await call(input)).isError, true);
    const changed = await call({ request: JSON.stringify({ ...request, title: "Changed intent" }) }); assert.equal(changed.details.code, "TICKET_CREATE_CONFLICT");
    assert.equal(JSON.stringify(store.get(parent.id)), parentBefore); assert.equal(store.readAudit().filter(row => row.ticket_id === created.ticket.id).length, 1);
    assert.equal(getDeploymentEvents(id).filter(e => e.event === "ticket-associated").length, 0);
    assert.equal(readFileSync(join(usage, "tickets", `${created.ticket.id}.json`), "utf8").includes("Explicit source-fixture companion"), true);
    assert.equal((await call(packet, { ...context, cwd: "/other" })).isError, true);
    assert.equal((await call(packet, { ...context, mode: "rpc" })).isError, true);
    sessionId = "replacement-session"; assert.equal((await call(packet)).isError, true); sessionId = "disposable-native-fixture-not-human";
    process.env.PA_PI_EXECUTION_MODE = "background"; assert.equal((await call(packet)).isError, true); process.env.PA_PI_EXECUTION_MODE = "foreground";
    process.env.PA_TEAM = "builder"; assert.equal((await call(packet)).isError, true); process.env.PA_TEAM = "requirements";
    for (const legacy of ["requirements-document-capabilities/v1", "requirements-document-workspace/v2", "requirements-document-confirmation/v3", "unmarked"]) {
      launch(legacy);
      const retained = new FakeComposedHost(), retainedLifecycle = createPiSessionLifecycle();
      registerPiSessionModules(retained.runtime, retainedLifecycle, createPiPaModules([])); await retained.dispatch("session_start", {}, context);
      assert.equal(retained.tools.has("pa_ticket_intake"), false); assert.equal(retained.tools.has("pa_capabilities"), false);
      const denied = await call(packet); assert.equal(denied.isError, true); assert.equal(denied.details.code, "TICKET_INTERACTION_SESSION");
      assert.equal((await call(capabilityPacket)).isError, true);
      await retainedLifecycle.shutdown({}, context);
    }
    assert.equal(store.list().length, 2);
    await lifecycle.shutdown({}, context);
    assert.equal((await call(packet)).isError, true);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
});

test("source launcher selects v4 before default native registration and one bound companion; simulated provider, no installed qualification", async () => {
  const env = process.env, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "intake-launch-source-"));
  closeDb();
  try {
    process.env = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(PA_|PI_|GIT_)/.test(key)));
    const repo = join(root, "repo"), config = join(root, "config"), teams = join(root, "teams"), usage = join(root, "usage");
    for (const path of [repo, config, teams, usage]) mkdirSync(path);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: teams, PA_PLATFORM_DATA: join(root, "data"), PA_AI_USAGE_HOME: usage, PA_REGISTRY_DB: join(root, "registry.db"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "source fixture"], { cwd: repo, stdio: "pipe" });
    process.chdir(repo);
    writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\nrepos:\n example:\n  path: ${repo}\n  prefix: EX\n other:\n  path: /tmp/unused-intake-destination\n  prefix: OTH\n`);
    writeFileSync(join(teams, "requirements.yaml"), "name: requirements\nobjective: Source fixture\nagents: []\ndeploy_modes:\n - id: analyze\n   require_ticket: true\n   document_profile: pa-document-interactions/v4\n");
    const store = new TicketStore(), parent = store.create({ project: "example", title: "Bound fixture", summary: "", description: "", status: "idea", type: "feature", priority: "medium", estimate: "M", assignee: "sinh", from: "", to: "", tags: [], blockedBy: [], comments: [], doc_refs: [] });
    let spawns = 0, created: string | undefined, bodyError: unknown;
    const adapter: RuntimeAdapter & { preflight(): Promise<void> } = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "source-launch-fixture", async preflight() {}, installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "Synthetic provider; real source extension registration below." }), extractActivity: () => [], resume: async () => { throw Error("no resume"); },
      async spawn(opts) {
        spawns++; const inherited = process.env; process.env = { ...inherited, ...opts.env };
        try {
          assert.equal(getDeploymentEvents(opts.deployId).find(event => event.event === "started")?.note, profile);
          assert.equal(recordPiProcessIdentity(opts.deployId, ensureDeployDir(opts.deployId), process.pid), true); opts.onPid?.(process.pid);
          const context: any = { cwd: repo, mode: "tui", sessionManager: { getSessionId: () => opts.sessionId!, getBranch: () => [] }, ui: { setStatus() {}, setWidget() {}, notify() {} } };
          const host = new FakeComposedHost(), lifecycle = createPiSessionLifecycle(); registerPiSessionModules(host.runtime, lifecycle, createPiPaModules([]));
          await host.dispatch("session_start", {}, context);
          assert.ok(host.tools.has("pa_ticket_intake"));
          const result = await host.tools.get("pa_ticket_intake")!.execute("source-fixture", { request: JSON.stringify(request) }, undefined, undefined, context);
          assert.equal(result.isError, false, result.content[0]!.text); created = JSON.parse(result.content[0]!.text).ticket.id;
          assert.equal(authenticatePiDocumentCaller(context).ticket, parent.id);
          await lifecycle.shutdown({}, context);
        } catch (error) { bodyError = error; throw error; }
        finally { process.env = inherited; }
        return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId! } };
      },
    };
    const result = await deployWithPi({ team: "requirements", mode: "analyze", repo: "example", ticket: parent.id, timeout: 60, provider: "openai-codex", model: "gpt-6.1-sol" }, adapter);
    if (bodyError) throw bodyError;
    assert.equal(spawns, 1, result.reason); assert.equal(created, "OTH-001"); assert.equal(store.list().length, 2);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
});

test("unbound intake framing fails closed without native owner or raw error disclosure", async () => {
  const tool = createPaTicketIntakeTool();
  const result = await tool.execute("fixture", { request: JSON.stringify(request) }, undefined, undefined, {});
  assert.equal(result.isError, true); assert.equal(result.details.code, "TICKET_INTERACTION_SESSION");
  assert.ok(result.content[0]!.text.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(result.content[0]!.text.split(`${label}:`).length - 1, 1);
});
