import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import { CommittedConfigSource, closeDb, createModeCapabilityBinding, emitPidEvent, emitStartedEvent, ensureDeployDir, MODE_CAPABILITY_SESSION, parseModeCapabilityPolicy, parseTeamYamlContent, READONLY_DOCUMENT_SESSION, selectModeCapabilities, selectedCapabilityTools, type ModeCapabilityBinding } from "@pa-platform/pa-core";
import { recordPiProcessIdentity } from "../process-identity.js";
import { createPiPaModules, createPiSessionLifecycle, registerPiSessionModules, type PiToolDefinition, type PiToolResult } from "../pi-extension/index.js";
import { createSecureLocalReadTool } from "../pi-extension/local-source-tools.js";
import { FakeComposedHost, createHostContext } from "./fixtures/pi-composed-host.js";

const resource = "skills/global/method/details.md", locator = `selected-resource:${resource}`;
const body = "\ufeffImmutable host reference é\r\nsecond exact line\r\n";
const blocked = (results: unknown[]) => results.some(result => !!result && typeof result === "object" && "block" in result && result.block === true);
const text = (result: PiToolResult) => result.content.map(block => block.text).join("\n");

async function fixture(run: (f: {
  root: string; repo: string; config: string;
  launch: (capability: string, retained?: boolean) => ModeCapabilityBinding;
  host: (nativeRead?: PiToolDefinition) => Promise<ReturnType<typeof compose>>;
}) => Promise<void>): Promise<void> {
  const prior = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap327-host-"));
  closeDb();
  const config = join(root, "config"), repo = join(root, "repo"), usage = join(root, "usage");
  const context = { ...createHostContext("tui", repo), sessionManager: { ...createHostContext("tui", repo).sessionManager, getSessionId: () => "disposable-composed-native-session" } };
  const lifecycles: ReturnType<typeof createPiSessionLifecycle>[] = [];
  let sequence = 0;
  function compose(nativeRead?: PiToolDefinition) {
    const host = new FakeComposedHost();
    let active: string[] = [], closes = 0;
    host.runtime.setActiveTools = names => { active = names; };
    const lifecycle = createPiSessionLifecycle(() => { closes++; });
    lifecycles.push(lifecycle);
    // Use the production module composition and final native-reader override seam.
    registerPiSessionModules(host.runtime, lifecycle, createPiPaModules([]), nativeRead);
    const direct = (input: Record<string, unknown>, ctx: unknown = context, signal?: AbortSignal, update?: (r: PiToolResult) => void) => host.tools.get("read")!.execute("direct-read", input, signal, update, ctx);
    const call = async (input: Record<string, unknown>, ctx: unknown = context) => {
      const decisions = await host.dispatch("tool_call", { toolName: "read", input }, ctx);
      if (blocked(decisions)) return { isError: true, content: [{ type: "text" as const, text: "blocked before execution" }], details: { blocked: true } };
      const result = await direct(input, ctx);
      const replacements = await host.dispatch("tool_result", { ...result, toolName: "read", toolCallId: "nested-read" }, ctx);
      const replacement = replacements.find((value): value is PiToolResult => !!value && typeof value === "object" && "content" in value && "details" in value);
      return replacement ?? result;
    };
    return { host, context, lifecycle, direct, call, active: () => active, closes: () => closes };
  }
  try {
    for (const path of [config, repo, usage]) mkdirSync(path);
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_)/.test(key)) delete process.env[key];
    Object.assign(process.env, { PA_PLATFORM_HOME: config, PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: join(config, "teams"), PA_PLATFORM_SKILLS: join(config, "skills/global"), PA_AI_USAGE_HOME: usage, PA_REGISTRY_DB: join(root, "registry.db"), NO_COLOR: "1" });
    const raw = JSON.stringify({ name: "analyst", agents: [], global_docs: [], deploy_modes: [{ id: "research", label: "Research", objective: "docs/objective.md", document_profile: "pa-readonly-document/v1", capability_policy: { version: "pa-mode-capabilities/v1", allow: ["context.read"] }, skills: [{ name: "method", "inject-as": "reference" }] }] });
    const files = { "config.yaml": `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`, "teams/analyst.yaml": raw, "docs/objective.md": "Selected objective.",
      "primers/budgets.yaml": JSON.stringify({ $schema: "contracts/schemas/primer-budgets.schema.json", kind: "pa-primer-budgets", contractVersion: "1.0.0", unit: "lines", defaultMax: 1200, modes: [{ team: "analyst", mode: "research", max: 9000 }] }),
      "skills/global/method/SKILL.md": "[Details](details.md)", [resource]: body, "docs/unselected.md": "Not selected." };
    for (const [path, content] of Object.entries(files)) { mkdirSync(join(config, path, ".."), { recursive: true }); writeFileSync(join(config, path), content); }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: config, stdio: "pipe" });
    git("init", "-b", "fixture"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Disposable host selection");
    execFileSync("git", ["init", "-b", "fixture"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(repo, "ordinary.txt"), "ordinary local body\n"); writeFileSync(join(root, "outside.txt"), "outside local body\n");
    process.chdir(repo);
    const launch = (capability: string, retained = false) => {
      const policy = parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: capability === "omitted" ? [] : [capability] });
      const selectedRaw = raw.replace('"allow":["context.read"]', `"allow":${JSON.stringify(policy.allow)}`);
      writeFileSync(join(config, "teams/analyst.yaml"), selectedRaw);
      git("add", "teams/analyst.yaml"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Disposable exact policy row");
      const team = parseTeamYamlContent(selectedRaw), binding = retained ? createModeCapabilityBinding("a".repeat(40), Buffer.from("retained host fixture"), policy)
        : selectModeCapabilities(policy, CommittedConfigSource.at(config), { team, mode: "research", repoKey: "example" }).binding;
      const id = `d-3271${(++sequence).toString(16).padStart(2, "0")}`, directory = ensureDeployDir(id);
      const selectedTeam = retained ? "requirements" : "analyst", mode = retained ? "analyze" : "research";
      emitStartedEvent({ deploymentId: id, team: selectedTeam, mode, runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, note: retained ? MODE_CAPABILITY_SESSION : READONLY_DOCUMENT_SESSION, modeCapabilityBinding: JSON.stringify(binding) });
      emitPidEvent({ deploymentId: id, team: selectedTeam, pid: process.pid }); assert.equal(recordPiProcessIdentity(id, directory, process.pid), true);
      Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: directory, PA_TEAM: selectedTeam, PA_MODE: mode, PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
      return binding;
    };
    await run({ root, repo, config, launch, host: async nativeRead => { const composed = compose(nativeRead); await composed.host.dispatch("session_start", { type: "session_start", reason: "startup" }, context); return composed; } });
  } finally {
    await Promise.all(lifecycles.map(lifecycle => lifecycle.shutdown()));
    closeDb(); process.chdir(cwd); process.env = prior; rmSync(root, { recursive: true, force: true });
  }
}

for (const capability of ["context.read", "ordinary.read"]) test(`PAP-327 composed host: ${capability} routes exact references through direct/nested guards`, async () => fixture(async f => {
  const binding = f.launch(capability), native = createSecureLocalReadTool();
  let fallbacks = 0;
  const session = await f.host({ ...native, execute: (...args) => { fallbacks++; return native.execute(...args); } });
  assert.deepEqual(session.active(), selectedCapabilityTools(binding.policy));
  assert.equal(session.host.tools.get("read")!.parameters, native.parameters, "the final native schema is preserved");
  assert.match(session.host.tools.get("read")!.description, /selected-resource:/);
  assert.equal([...session.host.tools.keys()].filter(name => name.includes("selected") || name === "read").join(","), "read");
  writeFileSync(join(f.config, resource), "mutable checkout replacement");
  for (const route of [session.direct, session.call]) {
    const result = await route({ path: locator });
    assert.notEqual(result.isError, true, text(result)); assert.equal(text(result), body);
    assert.equal(result.details.status, "reference-only"); assert.equal(result.details.configRevision, binding.configRevision);
    const first = await route({ path: locator, limit: 1 }), rest = await route({ path: locator, offset: first.details.nextOffset });
    assert.equal(text(first) + text(rest), body);
  }
  assert.equal(fallbacks, 0, "selected reads never reach the final filesystem implementation");
  for (const path of ["selected-resource:docs/unselected.md", "selected-resource:../outside.txt", "selected-resource:", "selected-resource:/etc/passwd"]) {
    assert.equal((await session.call({ path })).isError, true);
    await assert.rejects(() => session.direct({ path }));
  }
  assert.equal(fallbacks, 0, "denied locators never fall through");
  const local = await session.call({ path: join(f.repo, "ordinary.txt") }); assert.match(text(local), /ordinary local body/);
  assert.equal(fallbacks, 1);
  const outside = await session.call({ path: join(f.root, "outside.txt") });
  assert.equal(outside.isError === true, capability === "context.read", "ordinary read and context-root rules remain distinct");
  if (capability === "context.read") await assert.rejects(() => session.direct({ path: join(f.root, "outside.txt") }));
  for (const path of [join(f.repo, ".env"), join(f.repo, "missing.txt")]) assert.equal((await session.call({ path })).isError, true);
  writeFileSync(join(f.config, "sensitive-patterns.yaml"), JSON.stringify({ content_patterns: ["second exact line"] }));
  for (const route of [session.direct, session.call]) {
    const denied = await route({ path: locator, limit: 1 }); assert.equal(denied.isError, true); assert.equal(denied.details.code, "LOCAL_CONTENT_POLICY");
    assert.doesNotMatch(JSON.stringify(denied), /Immutable host reference|second exact line/);
  }
  rmSync(join(f.config, "sensitive-patterns.yaml"));
  const changed = { ...session.context, sessionManager: { ...session.context.sessionManager, getSessionId: () => "foreign-session" } };
  assert.equal((await session.call({ path: locator }, changed)).isError, true);
  await assert.rejects(() => session.direct({ path: locator }, changed));
  await assert.rejects(() => session.direct({ path: locator, filePath: join(f.repo, ".env") }), /SAFETY_PROTECTED_PATH/);
}));

test("PAP-327 composed host: omitted, retained and unselected sessions do not gain a resource route", async () => fixture(async f => {
  // A real local file with the reserved spelling must never become a fallback.
  mkdirSync(join(f.repo, "selected-resource:skills/global/method"), { recursive: true });
  writeFileSync(join(f.repo, locator), "mutable namespace collision");
  for (const retained of [false, true]) for (const capability of ["omitted", "context.read", "ordinary.read"]) {
    if (!retained && capability !== "omitted") continue;
    f.launch(capability, retained);
    const session = await f.host();
    assert.equal(session.active().includes("read"), capability !== "omitted");
    assert.doesNotMatch(session.host.tools.get("read")!.description, /selected-resource:/);
    assert.equal((await session.call({ path: locator })).isError, true);
    await assert.rejects(() => session.direct({ path: locator }));
  }
  for (const key of Object.keys(process.env)) if (/^(PA_DEPLOYMENT|PA_TEAM|PA_MODE|PA_REPO|PA_WORKTREE|PA_PI_EXECUTION)/.test(key)) delete process.env[key];
  const unselected = await f.host();
  assert.doesNotMatch(unselected.host.tools.get("read")!.description, /selected-resource:/);
  await assert.rejects(() => unselected.direct({ path: locator }));
  assert.match(text(await unselected.direct({ path: join(f.repo, "ordinary.txt") })), /ordinary local body/);
}));

test("PAP-327 real Pi loader/runner registers only read and applies native selected-reference guards", async () => fixture(async f => {
  f.launch("context.read");
  const lifecycle = createPiSessionLifecycle(() => {}), errors: string[] = [];
  const loader = new DefaultResourceLoader({ cwd: f.repo, agentDir: join(f.root, "isolated-pi"), settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => { registerPiSessionModules(pi, lifecycle, createPiPaModules([])); }],
  });
  try {
    await loader.reload();
    const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
    // Empty fixture storage, no availability refresh or provider/model request.
    const models = await ModelRuntime.create({ authPath: join(f.root, "inert-auth.json"), modelsPath: null, modelsStorePath: join(f.root, "inert-models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, f.repo, SessionManager.inMemory(f.repo), new ModelRegistry(models));
    let active: string[] = [];
    runner.bindCore({ sendMessage: () => {}, sendUserMessage: () => {}, appendEntry: () => {}, setSessionName: () => {}, getSessionName: () => undefined,
      setLabel: () => {}, getActiveTools: () => active, getAllTools: () => [], setActiveTools: names => { active = names; }, refreshTools: () => {},
      getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: () => {},
    }, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined,
      abort: () => {}, hasPendingMessages: () => false, shutdown: () => {}, getContextUsage: () => undefined, compact: () => {}, getSystemPrompt: () => "",
    });
    runner.setUIContext(undefined, "tui"); runner.onError(error => errors.push(error.error));
    await runner.emit({ type: "session_start", reason: "startup" });
    assert.deepEqual(errors, []); assert.deepEqual(active, ["read"]);
    const registered = runner.getAllRegisteredTools().filter(tool => tool.definition.name === "read");
    assert.equal(registered.length, 1); assert.match(registered[0]!.definition.description, /selected-resource:/);
    assert.equal(runner.getAllRegisteredTools().some(tool => tool.definition.name.includes("selected")), false);
    const read = wrapRegisteredTool(registered[0]!, runner);
    const direct = await read.execute("real-direct", { path: locator });
    assert.deepEqual(direct.content, [{ type: "text", text: body }]);
    const decision = await runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "parent/1", input: { path: locator } });
    assert.equal(decision?.block, undefined);
    const nested = await read.execute("parent/1", { path: locator });
    assert.deepEqual(nested.content, direct.content);
    const filtered = await runner.emitToolResult({ type: "tool_result", toolName: "read", toolCallId: "parent/1", input: { path: locator }, ...nested, isError: false });
    assert.equal(filtered, undefined, "real tool_result hook retains already-checked exact bytes");
    assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "functions.read", toolCallId: "alias", input: { path: locator } }))?.block, true);
    for (const path of ["selected-resource:docs/unselected.md", join(f.root, "outside.txt")]) {
      assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "denied", input: { path } }))?.block, true);
      await assert.rejects(() => read.execute("denied-direct", { path }));
    }
    const pending = read.execute("real-reload", { path: locator });
    const shutdown = runner.emit({ type: "session_shutdown", reason: "reload" });
    const revoked = await pending; await shutdown;
    assert.equal(revoked.isError, true); assert.doesNotMatch(JSON.stringify(revoked), /Immutable host reference|second exact line/);
    await assert.rejects(() => read.execute("late", { path: locator }), /shutting down/);
    assert.deepEqual(errors, []);
  } finally { await lifecycle.shutdown(); }
}));

test("PAP-327 composed host: reload/shutdown and caller cancellation withhold already-read bytes at delivery", async () => fixture(async f => {
  f.launch("context.read");
  let previous: Awaited<ReturnType<typeof f.host>> | undefined;
  for (const reason of ["reload", "quit"]) {
    const session = await f.host(), updates: PiToolResult[] = [];
    if (previous) await assert.rejects(() => previous!.direct({ path: locator }), /shutting down/);
    const pending = session.direct({ path: locator }, session.context, undefined, result => updates.push(result));
    const shutdown = session.lifecycle.shutdown({ type: "session_shutdown", reason }, session.context);
    const denied = await pending; await shutdown;
    assert.equal(denied.isError, true); assert.equal(denied.details.code, "LOCAL_SOURCE_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify([denied, updates]), /Immutable host reference|second exact line/);
    assert.equal(session.closes(), 1);
    await assert.rejects(() => session.direct({ path: locator }), /shutting down/);
    previous = session;
  }
  const replacement = await f.host();
  assert.equal(text(await replacement.call({ path: locator })), body, "fresh registration works without reviving the old lifetime");
  const controller = new AbortController(), pending = replacement.direct({ path: locator }, replacement.context, controller.signal);
  controller.abort(); const cancelled = await pending;
  assert.equal(cancelled.details.code, "LOCAL_SOURCE_UNAVAILABLE"); assert.doesNotMatch(text(cancelled), /Immutable host reference/);
  const sessionId = replacement.context.sessionManager.getSessionId;
  const changedCaller = replacement.direct({ path: locator });
  replacement.context.sessionManager.getSessionId = () => "changed-before-delivery";
  await assert.rejects(() => changedCaller, /CAPABILITY_BINDING/);
  replacement.context.sessionManager.getSessionId = sessionId;
  assert.equal(text(await replacement.direct({ path: locator })), body);
  f.launch("omitted");
  assert.equal((await replacement.call({ path: locator })).isError, true);
  await assert.rejects(() => replacement.direct({ path: locator }));
}));
