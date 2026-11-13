import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { closeDb, MAX_LOCAL_SECURITY_BYTES, loadSensitivePatterns } from "@pa-platform/pa-core";
import { createSecureLocalReadTool, createSecureLocalBashTool, registerLocalSourceToolsModule } from "../pi-extension/local-source-tools.js";
import { filterLocalToolResult, markNativePublicContent, registerLocalContentResultModule } from "../pi-extension/local-content-security.js";
import { createPiSessionLifecycle, registerPiSessionModules, interceptToolCall, type PiToolDefinition, type PiToolResult, type PiRuntime } from "../pi-extension/index.js";

async function fixture(run: (f: { root: string; config: string; context: any; canary: string; file: string }) => Promise<void>): Promise<void> {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "local-source-security-")); closeDb();
  try {
    const config = join(root, "config"); mkdirSync(config);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") });
    delete process.env.PA_DEPLOYMENT_ID; delete process.env.PA_DEPLOYMENT_DIR;
    writeFileSync(join(config, "sensitive-patterns.yaml"), "filenames:\n - '^blocked-source\\.txt$'\ncontents:\n - 'INERT_LOCAL_CANARY_[A-Z0-9]+'\n");
    const canary = "INERT_LOCAL_CANARY_1234567890", file = join(root, "allowed-source.txt");
    writeFileSync(file, `ordinary before\napi_key = ${canary}\nordinary after\n`);
    const context = { cwd: root, mode: "tui", sessionManager: { getSessionId: () => "source-security-fixture", getSessionFile: () => undefined } };
    await run({ root, config, context, canary, file });
  } finally { closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); }
}
const invoke = (tool: PiToolDefinition, input: Record<string, unknown>, context: unknown, update?: (r: PiToolResult) => void) => tool.execute("inert-source-fixture", input, undefined, update, context);
const text = (result: PiToolResult) => result.content.map(c => c.text).join("\n");

test("ordinary read checks source and complete local bytes before pagination; no origin claim bypass", async () => fixture(async f => {
  const tool = createSecureLocalReadTool();
  const result = await invoke(tool, { path: f.file, source: "public-web-response" }, f.context);
  assert.notEqual(result.isError, true, text(result)); assert.doesNotMatch(JSON.stringify(result), /INERT_LOCAL_CANARY_1234567890/);
  assert.match(text(result), /ordinary before/); assert.match(text(result), /ordinary after/); assert.match(text(result), /REDACTED/);
  assert.ok(readFileSync(f.file, "utf8").includes(f.canary), "projection never edits source bytes");
  const key = join(f.root, "key-example.txt");
  writeFileSync(key, "ordinary\n-----BEGIN OPENSSH PRIVATE KEY-----\nOPAQUE_BODY_WITHOUT_A_TOKEN_PREFIX\n-----END OPENSSH PRIVATE KEY-----\nordinary end\n");
  const tail = await invoke(tool, { path: key, offset: 3, limit: 1 }, f.context);
  assert.doesNotMatch(text(tail), /OPAQUE_BODY/); assert.match(text(tail), /REDACTED/);
  const ordinary = await invoke(tool, { path: key, offset: 5, limit: 1 }, f.context);
  assert.match(text(ordinary), /ordinary end/);
  const blocked = join(f.root, "blocked-source.txt"); writeFileSync(blocked, "INERT_BLOCKED_BODY");
  symlinkSync(blocked, join(f.root, "innocent-alias.txt"));
  for (const path of [blocked, join(f.root, "innocent-alias.txt"), join(f.root, ".env")]) {
    const denied = await invoke(tool, { path }, f.context);
    assert.equal(denied.isError, true); assert.doesNotMatch(JSON.stringify(denied), /INERT_BLOCKED_BODY/); assert.match(text(denied), /LOCAL_SOURCE_BLOCKED/);
  }
  const paths = interceptToolCall({ toolName: "bash", input: { command: `cat ${JSON.stringify(blocked)}` } });
  assert.equal(paths.allowed, false, "configured file rules also protect known shell operands");
}));

// Phase-1 historical reproduction, NOT the repaired positive acceptance case.
// Replace the denial expectation only after the selected-host design is reviewed;
// the original result is retained in docs/PAP-298-phase-1-design.md and Git history.
test("PAP-298 baseline: guarded direct and registered reads reject inert read-only hard links", async t => fixture(async f => {
  const body = "ordinary inert documentation\nsecond ordinary line\n";
  const ordinary = join(f.root, "ordinary-document.txt"), linked = join(f.root, "linked-document.txt");
  writeFileSync(ordinary, body);
  writeFileSync(linked, body);
  linkSync(linked, join(f.root, "second-document-name.txt"));
  chmodSync(linked, 0o444);
  const before = statSync(linked, { bigint: true });
  assert.equal(before.isFile(), true);
  assert.equal(before.nlink, 2n);
  assert.equal(before.mode & 0o222n, 0n);
  assert.equal(statSync(ordinary).nlink, 1);

  const tools = new Map<string, PiToolDefinition>();
  const lifecycle = createPiSessionLifecycle(() => {});
  registerPiSessionModules({ registerTool: tool => tools.set(tool.name, tool) }, lifecycle, [registerLocalSourceToolsModule]);
  try {
    for (const [route, tool] of [["direct", createSecureLocalReadTool()], ["registered", tools.get("read")!]] as const) {
      const allowed = await invoke(tool, { path: ordinary }, f.context);
      assert.notEqual(allowed.isError, true, text(allowed));
      assert.equal(text(allowed), body);
      const updates: PiToolResult[] = [];
      const denied = await invoke(tool, { path: linked }, f.context, result => updates.push(result));
      assert.equal(denied.isError, true);
      assert.equal(denied.details.code, "LOCAL_SOURCE_UNAVAILABLE");
      assert.equal(denied.details.outputWithheld, true);
      assert.equal(denied.details.effectState, "not-established");
      assert.equal(denied.details.fullOutputPath, undefined);
      assert.doesNotMatch(JSON.stringify([denied, updates]), /ordinary inert documentation|second ordinary line/);
      t.diagnostic(`${route}: single-link text delivered; regular mode=0444 nlink=2 denied as ${denied.details.code}; no document text/update/spill delivered`);
    }
    // Metadata only after denial: never obtain denied bytes via another reader.
    const after = statSync(linked, { bigint: true });
    for (const field of ["dev", "ino", "size", "uid", "gid", "mode", "nlink", "mtimeNs", "ctimeNs"] as const) {
      assert.equal(after[field], before[field], `fixture ${field} must remain unchanged`);
    }
  } finally { await lifecycle.shutdown(); }
}));

test("local bash buffers split/UTF-8 chunks before updates, truncation or spill; preserves real exit failures", async () => fixture(async f => {
  const updates: PiToolResult[] = []; let executing = false;
  const fake = createSecureLocalBashTool({ exec: async (_command, _cwd, options) => {
    executing = true;
    const bytes = Buffer.from(`ordinary λ\napi_key = ${f.canary}\nordinary last\n`);
    for (let n = 0; n < bytes.length; n++) options.onData(bytes.subarray(n, n + 1));
    assert.ok(updates.every(update => !JSON.stringify(update).includes(f.canary)), "no raw partial updates");
    executing = false; return { exitCode: 0 };
  } });
  const result = await invoke(fake, { command: "inert-fixture" }, f.context, r => { updates.push(r); assert.ok(!executing || r.content.length === 0); });
  assert.match(text(result), /ordinary λ/); assert.match(text(result), /ordinary last/); assert.doesNotMatch(JSON.stringify([result, updates]), /INERT_LOCAL_CANARY_1234567890/);
  const real = createSecureLocalBashTool();
  const observed = await invoke(real, { command: `cat ${JSON.stringify(f.file)}` }, f.context);
  assert.match(text(observed), /ordinary before/); assert.doesNotMatch(JSON.stringify(observed), /INERT_LOCAL_CANARY_1234567890/);
  await assert.rejects(() => invoke(real, { command: `cat ${JSON.stringify(f.file)}; exit 7` }, f.context), error => error instanceof Error && /code 7/.test(error.message) && !error.message.includes(f.canary));
  await assert.rejects(() => invoke(real, { command: `cat ${JSON.stringify(join(f.root, "blocked-source.txt"))}` }, f.context), /SAFETY_PROTECTED_PATH/);
}));

test("Pi truncation spills only already-filtered local output", async () => fixture(async f => {
  const tool = createSecureLocalBashTool({ exec: async (_c, _cwd, options) => {
    options.onData(Buffer.from(`ordinary first\napi_key = ${f.canary}\n${"ordinary repeated source line\n".repeat(4000)}`));
    return { exitCode: 0 };
  } });
  const result = await invoke(tool, { command: "inert-fixture" }, f.context);
  const path = result.details.fullOutputPath;
  assert.equal(typeof path, "string", "real Pi output collector must exercise its spill path");
  try { assert.doesNotMatch(readFileSync(path as string, "utf8"), /INERT_LOCAL_CANARY_1234567890/); }
  finally { rmSync(path as string, { force: true }); }
}));

test("excess shell output is discarded before raw spill and does not imply absent effects", async () => fixture(async f => {
  const tool = createSecureLocalBashTool({ exec: async (_c, _cwd, options) => {
    options.onData(Buffer.alloc(MAX_LOCAL_SECURITY_BYTES + 1, 120)); return { exitCode: 0 };
  } });
  const result = await invoke(tool, { command: "inert-fixture" }, f.context);
  assert.equal(result.isError, true); assert.equal(result.details.outputWithheld, true);
  assert.match(text(result), /may have changed state/); assert.ok(JSON.stringify(result).length < 4000);
}));

test("result checks protect text, JSON, diff details and structured content without importing source labels", async () => fixture(async f => {
  const patterns = loadSensitivePatterns();
  const result = { content: [{ type: "text" as const, text: JSON.stringify({ safe: "ordinary", source: "public-web-response", api_key: f.canary }) }], details: { diff: `line\n${f.canary}`, safe: "ordinary" }, structuredContent: { api_key: f.canary, safe: "ordinary" } };
  const checked = filterLocalToolResult("read", result, patterns) as typeof result;
  assert.doesNotMatch(JSON.stringify(checked), /INERT_LOCAL_CANARY_1234567890/);
  assert.equal(JSON.parse(checked.content[0].text).safe, "ordinary");
  assert.equal(checked.structuredContent.safe, "ordinary"); assert.equal(checked.details.safe, "ordinary");
  const clean: PiToolResult = { content: [{ type: "text", text: "ordinary content" }], details: { count: 1 } };
  assert.equal(filterLocalToolResult("read", clean, patterns), clean);
  const forged: PiToolResult = { content: [{ type: "text", text: f.canary }], details: { source: "public-web-response" } };
  assert.doesNotMatch(JSON.stringify(filterLocalToolResult("pa_web_read", forged, patterns)), /INERT_LOCAL_CANARY_1234567890/);
  const native: PiToolResult = { content: markNativePublicContent([{ type: "text", text: f.canary }]), details: {} };
  assert.equal(filterLocalToolResult("pa_web_read", native, patterns), native, "trusted native public response keeps prior allowance");
  assert.doesNotMatch(JSON.stringify(filterLocalToolResult("bash", native, patterns)), /INERT_LOCAL_CANARY_1234567890/);
  const split: PiToolResult = { content: [{ type: "text", text: "INERT_LOCAL_CANARY_" }, { type: "text", text: "1234567890" }], details: {} };
  assert.doesNotMatch(JSON.stringify(filterLocalToolResult("read", split, patterns)), /1234567890/);
}));

test("shared registration protects direct custom calls and unchecked updates; result hook covers nested/builtin results", async () => fixture(async f => {
  const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, Array<(...args: any[]) => any>>();
  const runtime: PiRuntime = { registerTool: tool => tools.set(tool.name, tool), on: ((name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler])) as any };
  const lifecycle = createPiSessionLifecycle(() => {});
  registerPiSessionModules(runtime, lifecycle, [registerLocalSourceToolsModule, registerLocalContentResultModule, pi => pi.registerTool!({
    name: "inert_local", label: "inert", description: "fixture", parameters: Type.Object({}),
    execute: async (_id, _input, _signal, update) => {
      update?.({ content: [{ type: "text", text: f.canary.slice(0, 10) }], details: {} });
      update?.({ content: [{ type: "text", text: f.canary.slice(10) }], details: {} });
      return { content: [{ type: "text", text: f.canary }], details: { diff: f.canary } };
    },
  })]);
  const updates: PiToolResult[] = [];
  const direct = await invoke(tools.get("inert_local")!, {}, f.context, r => updates.push(r));
  assert.doesNotMatch(JSON.stringify([direct, updates]), /INERT_LOCAL_CANARY_1234567890/);
  assert.ok(updates.every(r => /being checked/.test(text(r))));
  const raw = { toolName: "edit", content: [{ type: "text", text: "changed" }], details: { diff: f.canary }, structuredContent: { api_key: f.canary }, isError: false };
  const nested = await handlers.get("tool_result")![0](raw, f.context);
  assert.doesNotMatch(JSON.stringify(nested), /INERT_LOCAL_CANARY_1234567890/);
  await lifecycle.shutdown();
  await assert.rejects(() => invoke(tools.get("inert_local")!, {}, f.context), /shutting down/);
}));

test("actual Pi ExtensionRunner applies the result replacement without swallowing a handler error", async () => fixture(async f => {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  registerLocalContentResultModule({ on: ((name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn])) as any });
  const runner = new ExtensionRunner([{ path: "inert-fixture", handlers } as any], {} as any, f.root, {} as any, {} as any);
  const errors: unknown[] = []; runner.onError(error => errors.push(error));
  const result = await runner.emitToolResult({ type: "tool_result", toolCallId: "inert", toolName: "edit", input: {}, content: [{ type: "text", text: "ordinary" }], details: { diff: f.canary }, isError: false });
  assert.ok(result); assert.doesNotMatch(JSON.stringify(result), /INERT_LOCAL_CANARY_1234567890/); assert.deepEqual(errors, []);
  writeFileSync(join(f.config, "sensitive-patterns.yaml"), "contents:\n - '[INERT_INVALID_PATTERN'\n");
  const unavailable = await runner.emitToolResult({ type: "tool_result", toolCallId: "inert-unavailable", toolName: "read", input: {}, content: [{ type: "text", text: f.canary }], details: {}, isError: false });
  assert.equal(unavailable?.isError, true); assert.doesNotMatch(JSON.stringify(unavailable), /INERT_LOCAL_CANARY_1234567890/); assert.deepEqual(errors, []);
}));

test("invalid policy fails closed before file/shell delivery, hostile getters are never invoked", async () => fixture(async f => {
  let getterCalls = 0;
  const details = Object.defineProperty({}, "danger", { enumerable: true, get() { getterCalls++; throw Error("inert getter"); } });
  const checked = filterLocalToolResult("read", { content: [{ type: "text", text: "ordinary" }], details });
  assert.equal(checked.isError, true); assert.equal(getterCalls, 0);
  writeFileSync(join(f.config, "sensitive-patterns.yaml"), "contents:\n - '[INERT_INVALID_PATTERN'\n");
  const read = await invoke(createSecureLocalReadTool(), { path: f.file }, f.context);
  assert.equal(read.isError, true); assert.doesNotMatch(text(read), /INERT_LOCAL_CANARY|INERT_INVALID_PATTERN/);
  let spawns = 0;
  const shell = createSecureLocalBashTool({ exec: async () => { spawns++; return { exitCode: 0 }; } });
  const result = await invoke(shell, { command: "inert-fixture" }, f.context);
  assert.equal(result.isError, true); assert.equal(spawns, 0);
}));
