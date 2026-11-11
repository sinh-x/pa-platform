import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { closeDb, emitStartedEvent, emitPidEvent, ensureDeployDir, MODE_CAPABILITY_SESSION, createModeCapabilityBinding, parseModeCapabilityPolicy, MODE_CAPABILITIES, TicketStore, getDeploymentEvents } from "@pa-platform/pa-core";
import { recordPiProcessIdentity } from "../process-identity.js";
import { authenticatePiDocumentCaller, confirmationDocumentCaller, workspaceDocumentCaller } from "../document-session.js";
import { registerDocumentModule } from "../pi-extension/document-tool.js";
import { createPublicWebTool } from "../pi-extension/web-read-tool.js";
import { createPaTicketIntakeTool } from "../pi-extension/ticket-intake-tool.js";
import { registerPiSessionModules, createPiSessionLifecycle, type PiToolDefinition, type PiRuntime } from "../pi-extension/index.js";

test("native immutable policy drives exposure and actual custom/builtin/delegated boundaries; reload/env do not widen", async () => {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "mode-policy-native-"));
  const repo = join(root, "repo"), usage = join(root, "usage"), config = join(root, "config"); closeDb();
  try {
    for (const path of [repo, usage, config]) mkdirSync(path);
    Object.assign(process.env, { PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") });
    for (const key of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_ROGUE_ONE", "PA_REPO", "PA_WORKTREE_ROOT"]) delete process.env[key];
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n other:\n  path: /tmp/unused-policy-companion-no-file-access\n  prefix: OTH\n`);
    writeFileSync(join(repo, "public.txt"), "safe fixture"); writeFileSync(join(root, "outside.txt"), "not admitted");
    process.chdir(repo);
    const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "native-synthetic-fixture-not-human" } };
    const launch = (id: string, ids: string[], override?: string, ticketId?: string) => {
      const directory = ensureDeployDir(id);
      const policy = parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ids });
      const binding = createModeCapabilityBinding("a".repeat(40), Buffer.from("fixture config identity"), policy);
      emitStartedEvent({ deploymentId: id, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, note: MODE_CAPABILITY_SESSION, ticketId, modeCapabilityBinding: override ?? JSON.stringify(binding) });
      emitPidEvent({ deploymentId: id, team: "requirements", pid: process.pid });
      assert.equal(recordPiProcessIdentity(id, directory, process.pid), true);
      if (ticketId) process.env.PA_TICKET_ID = ticketId; else delete process.env.PA_TICKET_ID;
      Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: directory, PA_TEAM: "requirements", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
    };
    let effects = 0;
    const register = () => {
      const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, Array<(...args: any[]) => any>>(); let active: string[] = [];
      const runtime: PiRuntime = { registerTool: tool => tools.set(tool.name, tool), setActiveTools: names => { active = names; }, on: ((name: string, handler: any) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }) as any };
      const lifecycle = createPiSessionLifecycle(() => {});
      registerPiSessionModules(runtime, lifecycle, [pi => {
        for (const name of ["pa_ticket", "bash", "write", "pa_web_read", "functions.pa_ticket"]) pi.registerTool!({ name, label: name, description: "fixture", parameters: Type.Object({}), execute: async () => { effects++; return { content: [{ type: "text", text: "fixture" }], details: {} }; } });
      }, registerDocumentModule]);
      const emit = (name: string, event: unknown = {}, ctx = context) => (handlers.get(name) ?? []).map(h => h(event, ctx));
      emit("session_start");
      return { tools, emit, lifecycle, active: () => active };
    };
    launch("d-289001", ["ticket.read-comment", "context.read", "document.package", "document.workspace"]);
    const session = register(), caller = authenticatePiDocumentCaller(context);
    assert.ok(confirmationDocumentCaller(caller)); assert.ok(workspaceDocumentCaller(caller));
    assert.deepEqual(session.active().sort(), ["pa_ticket", "read", "pa_document", "pa_workspace"].sort());
    assert.ok(session.tools.has("pa_document")); assert.ok(session.tools.has("pa_workspace"));
    await session.tools.get("pa_ticket")!.execute("fixture", {}, undefined, undefined, context); assert.equal(effects, 1);
    for (const name of ["bash", "write", "pa_web_read", "functions.pa_ticket"]) {
      assert.equal(session.emit("tool_call", { toolName: name, input: {} })[0]?.block, true);
      await assert.rejects(() => session.tools.get(name)!.execute("nested-fixture", {}, undefined, undefined, context));
    }
    assert.equal(effects, 1);
    assert.equal(session.emit("tool_call", { toolName: "read", input: { path: join(repo, "public.txt") } })[0], undefined);
    for (const name of ["read", "functions.read", "mcp.read"]) assert.equal(session.emit("tool_call", { toolName: name, input: { path: join(root, "outside.txt") } })[0]?.block, true);
    writeFileSync(join(config, "requirements.yaml"), "capability_policy: { allow: [bash, pa_web_read] }");
    assert.deepEqual(register().active().sort(), session.active().sort());
    process.env.PA_MODE = "rogue-one";
    assert.equal(session.emit("tool_call", { toolName: "pa_ticket", input: {} })[0]?.block, true);
    await assert.rejects(() => session.tools.get("pa_ticket")!.execute("fixture", {}, undefined, undefined, context));
    process.env.PA_MODE = "analyze";
    launch("d-289002", []);
    const empty = register(); assert.deepEqual(empty.active(), []); assert.equal(empty.tools.has("pa_document"), false); assert.equal(empty.tools.has("pa_workspace"), false);
    assert.equal(session.emit("tool_call", { toolName: "pa_ticket", input: {} })[0]?.block, true, "old closure rejects another deployment");
    await assert.rejects(() => empty.tools.get("pa_ticket")!.execute("fixture", {}, undefined, undefined, context));
    launch("d-289003", MODE_CAPABILITIES.map(c => c.id).filter(id => id !== "web.public-read"));
    const baseline = register(); assert.equal(baseline.active().length, 12);
    assert.ok(baseline.tools.has("pa_ticket_intake")); assert.ok(baseline.tools.has("pa_capabilities"));
    const intake = baseline.tools.get("pa_ticket_intake")!;
    const framing = { request: JSON.stringify({ schemaVersion: "pa-ticket-intake/v1", action: "capabilities" }) };
    const grammar = await intake.execute("interface", framing, undefined, undefined, context);
    assert.equal(grammar.isError, false);
    assert.equal(JSON.parse(grammar.content[0].text).requiredNativeProfile, MODE_CAPABILITY_SESSION);
    assert.equal(JSON.parse(grammar.content[0].text).requiredCapability, "ticket.intake");
    // Execute the unchanged finite intake grammar through the registered policy tool.
    const packet = { schemaVersion: "pa-ticket-intake/v1", action: "create", requestId: "policy-intake", kind: "intake", project: "example", title: "Synthetic primary", type: "feature", priority: "medium", estimate: "M", assignee: "sinh" };
    const created = await intake.execute("create", { request: JSON.stringify(packet) }, undefined, undefined, context);
    assert.equal(created.isError, false, created.content[0].text);
    const primary = JSON.parse(created.content[0].text).ticket.id;
    const store = new TicketStore(), primaryBefore = store.get(primary);
    launch("d-289008", ["ticket.intake", "capability.discover"], undefined, primary);
    const policyIntakeSession = register(), policyIntake = policyIntakeSession.tools.get("pa_ticket_intake")!;
    const call = (request: unknown) => policyIntake.execute("policy-intake", { request: JSON.stringify(request) }, undefined, undefined, context);
    const companion = { schemaVersion: "pa-ticket-intake/v1", action: "create", requestId: "policy-companion", kind: "companion", project: "other", title: "Synthetic companion" };
    const first = await call(companion); assert.equal(first.isError, false, first.content[0].text);
    const result = JSON.parse(first.content[0].text); assert.equal(result.ticket.id, "OTH-001"); assert.equal(result.primaryTicket, primary);
    const replay = JSON.parse((await call(companion)).content[0].text); assert.equal(replay.reusedIntent, true); assert.equal(replay.ticket.id, result.ticket.id);
    assert.equal((await call({ ...companion, title: "Changed original request" })).details.code, "TICKET_CREATE_CONFLICT");
    const inspect = { schemaVersion: "pa-ticket-intake/v1", action: "inspect", kind: "companion", project: "other", ticket: result.ticket.id };
    const beforeInspect = store.readAudit();
    const inspected = await call(inspect); assert.equal(inspected.isError, false, inspected.content[0].text);
    const selected = JSON.parse(inspected.content[0].text);
    const reuse = await call({ ...inspect, action: "reuse", expectedVersion: selected.version, expectedTitle: selected.ticket.title, expectedType: selected.ticket.type });
    assert.equal(reuse.isError, false, reuse.content[0].text); assert.deepEqual(store.readAudit(), beforeInspect);
    const planning = { ...inspect, action: "patch-planning", requestId: "policy-plan", expectedVersion: selected.version, expectedSnapshotVersion: selected.snapshotVersion, patch: { summary: "Finite policy-owned selection" } };
    const planned = await call(planning); assert.equal(planned.isError, false, planned.content[0].text);
    const audit = store.readAudit();
    assert.equal(JSON.parse((await call(planning)).content[0].text).reusedIntent, true); assert.deepEqual(store.readAudit(), audit);
    assert.equal((await call({ ...planning, requestId: "stale-new-intent" })).details.code, "TICKET_PLAN_STALE");
    assert.equal((await call({ ...planning, patch: { status: "done" } })).details.code, "TICKET_INTERACTION_INPUT");
    assert.deepEqual(store.get(primary), primaryBefore); assert.equal(getDeploymentEvents("d-289008").filter(e => e.event === "ticket-associated").length, 0);
    assert.equal(store.list().length, 2);
    const discovery = await policyIntakeSession.tools.get("pa_capabilities")!.execute("source-list", { request: JSON.stringify({ schemaVersion: "pa-interactions/v1", action: "list", limit: 1 }) }, undefined, undefined, context);
    assert.equal(discovery.isError, false, discovery.content[0].text); assert.equal(discovery.details.scope, "source-only");
    await policyIntakeSession.lifecycle.shutdown();
    process.env.PA_TEAM = "not-authenticated";
    await assert.rejects(() => call(companion), /Pi session is shutting down/, "lifecycle rejection precedes native registry authentication on late calls");
    process.env.PA_TEAM = "requirements";
    launch("d-289007", ["capability.discover"]);
    const discoveryOnly = register(); assert.deepEqual(discoveryOnly.active(), ["pa_capabilities"]);
    assert.equal(discoveryOnly.tools.has("pa_ticket_intake"), false);
    assert.equal(discoveryOnly.emit("tool_call", { toolName: "pa_ticket_intake", input: framing })[0]?.block, true);
    await assert.rejects(() => intake.execute("old-binding", framing, undefined, undefined, context));
    const rawOmitted = createPaTicketIntakeTool(authenticatePiDocumentCaller(context).identitySha256);
    assert.equal((await rawOmitted.execute("omitted", framing, undefined, undefined, context)).details.code, "TICKET_INTERACTION_SESSION");
    launch("d-289004", [], "{}"); assert.throws(() => authenticatePiDocumentCaller(context));
    assert.equal(effects, 1);
    launch("d-289005", ["web.public-read"]);
    const selectedReader = register(); assert.deepEqual(selectedReader.active(), ["pa_web_read"]);
    assert.match(selectedReader.tools.get("pa_web_read")!.description, /explicitly user-supplied/);
    const malformed = await selectedReader.tools.get("pa_web_read")!.execute("input", { url: "https://www.public-site.com/", headers: { Authorization: "synthetic" } }, undefined, undefined, context);
    assert.equal(malformed.isError, true); assert.equal(JSON.parse(malformed.content[0].text).code, "WEB_INPUT");
    let fetches = 0;
    const reader = createPublicWebTool("d-289005", context.sessionManager.getSessionId(), undefined, {
      patterns: () => ({ configPath: "synthetic", patterns: [] }), resolve: async () => ["93.184.216.34"],
      fetch: async () => { fetches++; return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("The synthetic value is 42."), compressedBytes: 26 }; },
    });
    const page = await reader.execute("page-1", { url: "https://www.public-site.com/" }, undefined, undefined, context);
    assert.equal(page.isError, undefined); assert.match(page.content[0].text, /synthetic value is 42/); assert.equal(fetches, 1);
    assert.equal(JSON.parse(page.content[0].text).evidence, "pi-tool-result:d-289005/page-1");
    const providerId = "call_f565fca6cce2478bbc77aeccf37d6a2a|fc_020a020a4dae1387016af4483f88bc87d096dfc8e90409de6a";
    for (const callId of [providerId, `${providerId}/1`, `${"a".repeat(100)}|${"b".repeat(99)}`]) {
      const retrieved = await reader.execute(callId, { url: "https://github.com/jaredpalmer/kev" }, undefined, undefined, context);
      assert.equal(retrieved.isError, undefined, retrieved.content[0].text);
      const result = JSON.parse(retrieved.content[0].text);
      assert.equal(result.ok, true); assert.match(result.text, /synthetic value is 42/);
      assert.equal(result.evidence, `pi-tool-result:d-289005/${callId}`);
    }
    assert.equal(fetches, 4, "synthetic connector only; no live GitHub request");
    for (const callId of ["", "a".repeat(201), "call_\nforged", "call_\u001b[31m", "call_\u202e", "call_<markup>"]) {
      const denied = await reader.execute(callId, { url: "https://github.com/jaredpalmer/kev" }, undefined, undefined, context);
      assert.equal(denied.isError, true); assert.equal(JSON.parse(denied.content[0].text).code, "WEB_INPUT");
      assert.equal(fetches, 4); assert.doesNotMatch(denied.content[0].text, /forged|markup/);
    }
    const extraInput = await reader.execute(providerId, { url: "https://github.com/jaredpalmer/kev", headers: {} }, undefined, undefined, context);
    assert.equal(JSON.parse(extraInput.content[0].text).code, "WEB_INPUT"); assert.equal(fetches, 4);
    const switched = { ...context, sessionManager: { getSessionId: () => "different-session" } };
    assert.equal((await reader.execute("page-2", { url: "https://www.public-site.com/" }, undefined, undefined, switched)).isError, true);
    // Same runtime/config omission: neither registration/exposure nor direct invocation grants the reader.
    launch("d-289006", []);
    const withoutReader = register(); assert.deepEqual(withoutReader.active(), []);
    assert.equal((await reader.execute("page-3", { url: "https://www.public-site.com/" }, undefined, undefined, context)).isError, true);
    const omitted = createPublicWebTool("d-289006", context.sessionManager.getSessionId());
    const denial = await omitted.execute("page-4", { url: "https://www.public-site.com/" }, undefined, undefined, context);
    assert.equal(JSON.parse(denial.content[0].text).code, "CAPABILITY_OMITTED"); assert.equal(fetches, 4);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
});
