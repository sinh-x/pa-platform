import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
const builtRoot = process.env.PA_TEST_SELECTED_PPA_ROOT;
const selectedModule = (built, source) => builtRoot
  ? pathToFileURL(join(builtRoot, "share", "pa-platform", "packages", built)).href
  : new URL(source, import.meta.url).href;
const { acquireLocalSourceFile, closeDb } = await import(selectedModule("pa-core/dist/index.js", "../../packages/pa-core/src/index.ts"));
const { createPiSessionLifecycle, registerPiSessionModules } = await import(selectedModule("pi-pa/dist/pi-extension/index.js", "../../packages/pi-pa/src/pi-extension/index.ts"));
const { ReadPublicationOwner, withholdUnownedReadEvent } = await import(selectedModule("pi-pa/dist/pi-extension/read-publication.js", "../../packages/pi-pa/src/pi-extension/read-publication.ts"));

// Test-driver selection only, never a runtime documentation root or read grant.
// This lane uses real Pi registration/transformation/emission with ordinary
// disposable sources. Immutable selected-host authority is a separate lane.
const selectedPi = process.env.PA_TEST_SELECTED_PI;
test("selected Pi filters only duplicate native entrypoints before discovery, trust preload and reload", { skip: !selectedPi }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resource-discovery-")), agentDir = join(root, "agent");
  const packageDir = join(root, "native-package"), excluded = join(packageDir, "index.mjs");
  const oldOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    mkdirSync(packageDir);
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(agentDir, "skills", "inert-user-skill"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "inert-native-package", pi: { extensions: ["./index.mjs"] } }));
    writeFileSync(excluded, 'throw new Error("INERT_DUPLICATE_FACTORY_MUST_NOT_EXECUTE");\n');
    symlinkSync(excluded, join(agentDir, "extensions", "native-alias.js"));
    writeFileSync(join(agentDir, "extensions", "user.ts"), 'export default pi => pi.registerCommand("inert-user-command", { description: "Disposable user extension", handler: async () => {} });\n');
    writeFileSync(join(agentDir, "skills", "inert-user-skill", "SKILL.md"), "---\nname: inert-user-skill\ndescription: Disposable user skill.\n---\nInert skill.\n");
    const host = await import(pathToFileURL(join(selectedPi, "lib", "node_modules", "pi-monorepo", "dist", "bundle", "index.js")).href);
    assert.equal(host.PA_EXTENSION_PATH_FILTER_VERSION, "pa-extension-path-filter/v1");
    const settingsManager = host.SettingsManager.inMemory({ packages: [packageDir] });
    let registrations = 0;
    const loader = new host.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
      paExtensionPathFilter: path => realpathSync(path) !== excluded,
      extensionFactories: [pi => { registrations++; pi.registerCommand("inert-native-command", { description: "Disposable native owner", handler: async () => {} }); }],
    });
    for (const resolveProjectTrust of [undefined, async () => true, undefined]) {
      await loader.reload({ resolveProjectTrust });
      const extensions = loader.getExtensions();
      assert.deepEqual(extensions.errors, []);
      assert.equal(extensions.extensions.filter(extension => extension.commands.has("inert-user-command")).length, 1);
      assert.equal(extensions.extensions.filter(extension => extension.commands.has("inert-native-command")).length, 1);
      assert.equal(loader.getSkills().skills.some(skill => skill.name === "inert-user-skill"), true);
    }
    assert.equal(registrations, 3, "one native registration per load, including trust preload and reload");
  } finally {
    if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual Pi runtime withholds a read revoked after tool completion but before its public sink", { skip: !selectedPi }, async () => {
  const surrounding = process.env;
  const root = mkdtempSync(join(tmpdir(), "pi-read-native-"));
  const config = join(root, "config"), agentDir = join(root, "agent");
  mkdirSync(config); mkdirSync(agentDir);
  writeFileSync(join(config, "sensitive-patterns.yaml"), "contents: []\n");
  const file = join(root, "ordinary.txt"); writeFileSync(file, "INERT_NATIVE_PUBLICATION_BODY\n");
  const image = join(root, "ordinary.png");
  // Newly authored, CRC-valid 1x1 transparent PNG; no external image fixture.
  writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64"));
  process.env = { ...surrounding, PI_OFFLINE: "1", PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
  delete process.env.PA_DEPLOYMENT_ID; delete process.env.PA_DEPLOYMENT_DIR;
  closeDb();
  let session;
  const owner = new ReadPublicationOwner(), lifecycle = createPiSessionLifecycle(() => {});
  try {
    const host = await import(pathToFileURL(join(selectedPi, "lib", "node_modules", "pi-monorepo", "dist", "bundle", "index.js")).href);
    let revokeBeforeSink = false;
    const readUsage = { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const settingsManager = host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new host.DefaultResourceLoader({
      cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        lifecycle.addShutdownStep(() => owner.revoke());
        registerPiSessionModules(pi, lifecycle, [runtime => runtime.registerTool(owner.createTool(host.createReadToolDefinition, acquireLocalSourceFile))]);
        pi.on("tool_result", event => event.toolCallId === "valid-native-read/1" ? { usage: readUsage } : undefined);
        pi.on("message_end", event => {
          if (event.message.role === "toolResult" && event.message.toolCallId === "valid-native-read/1") {
            event.message.content.push({ type: "text", text: "INERT_UNCHECKED_RUNTIME_ALIAS" });
            event.message.details.injected = "INERT_UNCHECKED_RUNTIME_ALIAS";
          }
        });
        pi.on("tool_execution_end", async event => {
          if (revokeBeforeSink && event.toolName === "read") await lifecycle.shutdown({ reason: "reload" });
        });
      }],
    });
    await resourceLoader.reload();
    const modelRuntime = await host.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const model = modelRuntime.getModel("openai", "gpt-4o");
    assert.ok(model, "fixed catalog fixture model exists; no provider is invoked");
    ({ session } = await host.createAgentSession({
      cwd: root, agentDir, modelRuntime, model, resourceLoader, settingsManager,
      tools: ["read"], sessionManager: host.SessionManager.inMemory(root),
      paReadPublication: event => { if (!owner.publishEvent(event)) withholdUnownedReadEvent(event); },
    }));
    await session.bindExtensions({});
    const observed = [];
    session.subscribe(event => observed.push(JSON.parse(JSON.stringify(event))));
    assert.ok(session.agent.state.tools.find(tool => tool.name === "read"));
    // An explicitly synthetic assistant fixture supplies the nested-call
    // parent. It is not provider output, human approval or a restored session.
    session.agent.state.messages.push({
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: ["valid-native-read", "valid-native-image", "revoked-native-read"].map(id => ({ type: "toolCall", id, name: "inert-parent", arguments: {} })),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 0,
    });
    const completed = [];
    for (const id of ["valid-native-read", "valid-native-image", "revoked-native-read"]) {
      revokeBeforeSink = id === "revoked-native-read";
      // This is the real ctx.executeTool pipeline: argument validation,
      // tool_call/tool_result, normalization, awaited tool_execution_end and
      // synchronous public output. It makes no provider/model request.
      const outcome = await session._executeNestedToolCall(id, "read", { path: id === "valid-native-image" ? image : file }, {});
      const event = observed.find(event => event.type === "tool_execution_end" && event.toolCallId === `${id}/1`);
      assert.ok(event);
      assert.equal(outcome.isError, revokeBeforeSink, "nested caller sees the same committed result as public output");
      if (revokeBeforeSink) {
        assert.equal(event.isError, true, "real public event must reflect withholding");
        assert.equal(event.result.details.code, "LOCAL_SOURCE_UNAVAILABLE");
        assert.doesNotMatch(JSON.stringify([event, outcome]), /INERT_NATIVE_PUBLICATION_BODY/);
      } else if (id === "valid-native-image") {
        assert.equal(event.isError, false);
        // This exact nested result is consumed by real codemode toScriptValue:
        // preserving only the image's textual note changes its script value.
        assert.equal(outcome.result.structuredContent?.type, "image");
        assert.equal(outcome.result.structuredContent?.mimeType, "image/png");
        assert.equal(outcome.result.structuredContent?.data, outcome.result.content.find(block => block.type === "image")?.data);
      } else {
        assert.equal(event.isError, false);
        assert.match(JSON.stringify(event), /INERT_NATIVE_PUBLICATION_BODY/);
      }
      completed.push(outcome);
    }
    // Message persistence follows later, after cancellation. Already committed
    // valid content remains valid; the cancelled operation remains withheld.
    for (const outcome of completed) {
      const message = { role: "toolResult", toolName: "read", toolCallId: outcome.toolCall.id,
        content: outcome.result.content, details: outcome.result.details, isError: outcome.isError, timestamp: 0 };
      await session._handleAgentEvent({ type: "message_start", message });
      await session._handleAgentEvent({ type: "message_end", message });
    }
    const persisted = session.sessionManager.buildSessionContext().messages.filter(message => message.role === "toolResult");
    assert.equal(persisted.length, 3);
    assert.doesNotMatch(JSON.stringify([observed, persisted]), /INERT_UNCHECKED_RUNTIME_ALIAS/);
    assert.match(JSON.stringify(persisted[0]), /INERT_NATIVE_PUBLICATION_BODY/);
    assert.equal(persisted[1].content.find(block => block.type === "image")?.mimeType, "image/png");
    assert.equal("structuredContent" in persisted[1], false, "do not invent a new ToolResultMessage field");
    assert.equal(persisted[2].isError, true);
    assert.doesNotMatch(JSON.stringify(persisted[2]), /INERT_NATIVE_PUBLICATION_BODY/);
    // These are the actual parent messages that consume takeRecord(). A
    // withheld nested outcome must not leave an earlier success in history.
    for (const outcome of completed) {
      const message = { role: "toolResult", toolName: "inert-parent", toolCallId: outcome.toolCall.id.split("/")[0],
        content: [{ type: "text", text: "INERT_PARENT_SUMMARY" }], details: {}, isError: outcome.isError, timestamp: 0 };
      await session._handleAgentEvent({ type: "message_start", message });
      await session._handleAgentEvent({ type: "message_end", message });
    }
    const parents = session.sessionManager.buildSessionContext().messages.filter(message => message.role === "toolResult" && message.toolName === "inert-parent");
    assert.equal(parents.length, 3);
    assert.deepEqual(parents.map(parent => parent.nestedCalls.calls[0].status), ["ok", "ok", "error"]);
    assert.deepEqual(parents[0].usage, readUsage, "publication projection must not discard already-accounted nested usage");
    assert.doesNotMatch(JSON.stringify(parents[2].nestedCalls), /INERT_NATIVE_PUBLICATION_BODY/);
  } finally {
    await lifecycle.shutdown(); owner.revoke(); session?.dispose();
    closeDb(); process.env = surrounding; rmSync(root, { recursive: true, force: true });
  }
});

test("owned main hands fatal startup diagnostics to its caller instead of advising an unguarded restart", { skip: !selectedPi }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-owned-startup-")), canary = randomUUID();
  const hostUrl = pathToFileURL(join(selectedPi, "lib", "node_modules", "pi-monorepo", "dist", "bundle", "index.js")).href;
  try {
    const script = `
      const host = await import(${JSON.stringify(hostUrl)});
      const displayed = [], write = process.stderr.write, output = process.stdout.write.bind(process.stdout);
      process.stderr.write = chunk => { displayed.push(String(chunk)); return true; };
      try {
        await host.main(['--print', '--mode', 'json', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--provider', 'openai', '--model', 'gpt-4o', 'Inert startup fixture'], {
          extensionFactories: [() => { throw new Error(${JSON.stringify(canary)}); }],
          // Negative transport mechanics only: no reader, source acquisition,
          // producer binding or permission is supplied by this fixture.
          paReadPublication: () => {},
        });
        process.exitCode = 2;
      } catch (error) {
        process.stderr.write = write;
        output(JSON.stringify({ message: error.message, privateCauseRetained: JSON.stringify(error.cause).includes(${JSON.stringify(canary)}), displayed: displayed.join('') }) + '\\n');
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", NO_COLOR: "1", PATH: process.env.PATH }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(child.status, 0, "owned startup must reject to its caller, not exit inside upstream reporting");
    const result = JSON.parse(child.stdout);
    assert.equal(result.message, "Selected Pi startup checks failed."); assert.equal(result.privateCauseRetained, true);
    assert.doesNotMatch(result.displayed, /pi -ne|without extensions/);
    assert.equal(result.displayed.includes(canary), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const execution of ["parallel", "sequential"]) test(`real ${execution} Pi agent loop withholds cancellation from output, model continuation and persisted history`, { skip: !selectedPi }, async () => {
  const surrounding = process.env, root = mkdtempSync(join(tmpdir(), "pi-publication-loop-"));
  const config = join(root, "config"), agentDir = join(root, "agent"); mkdirSync(config); mkdirSync(agentDir);
  writeFileSync(join(config, "sensitive-patterns.yaml"), "contents: []\n");
  const valid = join(root, "valid.txt"), cancelled = join(root, "cancelled.txt");
  writeFileSync(valid, "INERT_TOP_LEVEL_ALLOWED_BODY"); writeFileSync(cancelled, "INERT_TOP_LEVEL_CANCELLED_BODY");
  const calls = [{ id: "top-valid", path: valid }, { id: "top-revoked", path: cancelled }], requests = [];
  const topUsage = { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const first = requests.length === 1;
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      const message = delta => ({ id: "inert-completion", object: "chat.completion.chunk", created: 0, model: "pap298-fixture", choices: [{ index: 0, delta, finish_reason: null }] });
      const delta = first ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: "read", arguments: JSON.stringify({ path: call.path }) } })) }
        : { role: "assistant", content: "INERT_LOOP_DONE" };
      response.write(`data: ${JSON.stringify(message(delta))}\n\n`);
      const final = message({}); final.choices[0].finish_reason = first ? "tool_calls" : "stop";
      response.end(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  process.env = { ...surrounding, PI_OFFLINE: "1", PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
  delete process.env.PA_DEPLOYMENT_ID; delete process.env.PA_DEPLOYMENT_DIR; closeDb();
  const owner = new ReadPublicationOwner(), lifecycle = createPiSessionLifecycle(() => {});
  let session, revokeObserved = false;
  try {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { openai: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "inert",
      models: [{ id: "pap298-fixture", api: "openai-completions", reasoning: false, contextWindow: 131072, maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const host = await import(pathToFileURL(join(selectedPi, "lib", "node_modules", "pi-monorepo", "dist", "bundle", "index.js")).href);
    const settingsManager = host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new host.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        lifecycle.addShutdownStep(() => owner.revoke());
        registerPiSessionModules(pi, lifecycle, [runtime => runtime.registerTool(owner.createTool(host.createReadToolDefinition, acquireLocalSourceFile))]);
        pi.on("tool_result", event => ({ isError: event.toolCallId === "top-valid", usage: topUsage }));
        pi.on("tool_execution_end", async event => {
          if (event.toolCallId === "top-revoked") {
            await Promise.resolve(); revokeObserved = true; await lifecycle.shutdown({ reason: "reload" });
          }
        });
      }],
    });
    await resourceLoader.reload();
    const modelRuntime = await host.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const model = modelRuntime.getModel("openai", "pap298-fixture"); assert.ok(model);
    ({ session } = await host.createAgentSession({ cwd: root, agentDir, modelRuntime, model, resourceLoader, settingsManager,
      tools: ["read"], sessionManager: host.SessionManager.inMemory(root),
      paReadPublication: event => { if (!owner.publishEvent(event)) withholdUnownedReadEvent(event); },
    }));
    await session.bindExtensions({}); session.agent.toolExecution = execution;
    const events = []; session.subscribe(event => events.push(JSON.parse(JSON.stringify(event))));
    await session.prompt("Run the inert cancellation fixture.");
    assert.equal(revokeObserved, true); assert.equal(requests.length, 2);
    const history = session.sessionManager.buildSessionContext().messages.filter(message => message.role === "toolResult");
    assert.equal(history.length, 2);
    for (const message of history) assert.deepEqual(message.usage, topUsage, "top-level incurred usage survives successful or withheld projection");
    const ends = events.filter(event => event.type === "tool_execution_end"); assert.equal(ends.length, 2);
    assert.equal(ends.find(event => event.toolCallId === "top-valid").isError, true, "an error-only hook override is not a successful publication");
    assert.equal(ends.find(event => event.toolCallId === "top-revoked").isError, true);
    assert.equal(history.find(message => message.toolCallId === "top-valid").isError, true);
    assert.equal(history.find(message => message.toolCallId === "top-revoked").isError, true);
    assert.match(JSON.stringify([events, requests, history]), /INERT_TOP_LEVEL_ALLOWED_BODY/);
    assert.doesNotMatch(JSON.stringify([events, requests, history, session.agent.state.messages]), /INERT_TOP_LEVEL_CANCELLED_BODY/);
  } finally {
    await lifecycle.shutdown(); owner.revoke(); session?.dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    closeDb(); process.env = surrounding; rmSync(root, { recursive: true, force: true });
  }
});
