import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { closeDb, emitStartedEvent, emitPidEvent, ensureDeployDir, MODE_CAPABILITY_SESSION, createModeCapabilityBinding, parseModeCapabilityPolicy, MODE_CAPABILITIES } from "@pa-platform/pa-core";
import { recordPiProcessIdentity } from "../process-identity.js";
import { authenticatePiDocumentCaller, confirmationDocumentCaller, workspaceDocumentCaller } from "../document-session.js";
import { registerDocumentModule } from "../pi-extension/document-tool.js";
import { createPublicWebTool } from "../pi-extension/web-read-tool.js";
import { registerPiSessionModules, createPiSessionLifecycle, type PiToolDefinition, type PiRuntime } from "../pi-extension/index.js";

test("native immutable policy drives exposure and actual custom/builtin/delegated boundaries; reload/env do not widen", async () => {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "mode-policy-native-"));
  const repo = join(root, "repo"), usage = join(root, "usage"), config = join(root, "config"); closeDb();
  try {
    for (const path of [repo, usage, config]) mkdirSync(path);
    Object.assign(process.env, { PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") });
    for (const key of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_ROGUE_ONE", "PA_REPO", "PA_WORKTREE_ROOT"]) delete process.env[key];
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    writeFileSync(join(repo, "public.txt"), "safe fixture"); writeFileSync(join(root, "outside.txt"), "not admitted");
    process.chdir(repo);
    const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "native-synthetic-fixture-not-human" } };
    const launch = (id: string, ids: string[], override?: string) => {
      const directory = ensureDeployDir(id);
      const policy = parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ids });
      const binding = createModeCapabilityBinding("a".repeat(40), Buffer.from("fixture config identity"), policy);
      emitStartedEvent({ deploymentId: id, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, note: MODE_CAPABILITY_SESSION, modeCapabilityBinding: override ?? JSON.stringify(binding) });
      emitPidEvent({ deploymentId: id, team: "requirements", pid: process.pid });
      assert.equal(recordPiProcessIdentity(id, directory, process.pid), true);
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
      return { tools, emit, active: () => active };
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
    const baseline = register(); assert.equal(baseline.active().length, 10);
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
    const switched = { ...context, sessionManager: { getSessionId: () => "different-session" } };
    assert.equal((await reader.execute("page-2", { url: "https://www.public-site.com/" }, undefined, undefined, switched)).isError, true);
    // Same runtime/config omission: neither registration/exposure nor direct invocation grants the reader.
    launch("d-289006", []);
    const withoutReader = register(); assert.deepEqual(withoutReader.active(), []);
    assert.equal((await reader.execute("page-3", { url: "https://www.public-site.com/" }, undefined, undefined, context)).isError, true);
    const omitted = createPublicWebTool("d-289006", context.sessionManager.getSessionId());
    const denial = await omitted.execute("page-4", { url: "https://www.public-site.com/" }, undefined, undefined, context);
    assert.equal(JSON.parse(denial.content[0].text).code, "CAPABILITY_OMITTED"); assert.equal(fetches, 1);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
});
