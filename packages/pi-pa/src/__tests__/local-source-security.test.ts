import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import sharp from "sharp";
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

// Phase 1's original unavailable result is retained in commit 3e73a1f and
// docs/PAP-298-phase-1-design.md. This is still NOT selected-Pi positive acceptance:
// unqualified hard links remain denied, now before any data/media read.
test("PAP-298: guarded direct and registered reads reject unqualified hard links with a typed cause", async t => fixture(async f => {
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
      assert.equal(denied.details.code, "LOCAL_SOURCE_UNSUPPORTED_FILE");
      assert.equal(denied.details.outputWithheld, true);
      assert.equal(denied.details.effectState, "not-established");
      assert.equal(denied.details.fullOutputPath, undefined);
      assert.ok(text(denied).length <= 2000); assert.doesNotMatch(text(denied), /\u001b/);
      for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(text(denied).split(`${label}:`).length, 2);
      assert.doesNotMatch(text(denied), new RegExp(f.root));
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

test("protected direct and registered requests perform no upstream existence or payload probe", async t => fixture(async f => {
  const blocked = join(f.root, "blocked-source.txt"), alias = join(f.root, "innocent-blocked-alias.txt");
  writeFileSync(blocked, "INERT_BLOCKED_PREFLIGHT_BODY"); symlinkSync(blocked, alias);
  writeFileSync(join(f.root, ".env"), "INERT_BLOCKED_ENV_BODY");
  const originalAccess = fs.promises.access, originalRead = fs.readSync;
  let probes = 0, reads = 0;
  t.mock.method(fs.promises, "access", (async (...args: Parameters<typeof originalAccess>) => { probes++; return originalAccess(...args); }) as typeof originalAccess);
  t.mock.method(fs, "readSync", ((...args: Parameters<typeof originalRead>) => { reads++; return originalRead(...args); }) as typeof originalRead);
  syncBuiltinESMExports();
  const tools = new Map<string, PiToolDefinition>(), lifecycle = createPiSessionLifecycle(() => {});
  registerPiSessionModules({ registerTool: tool => tools.set(tool.name, tool) }, lifecycle, [registerLocalSourceToolsModule]);
  try {
    for (const path of [blocked, alias, join(f.root, ".env")]) {
      const direct = await invoke(createSecureLocalReadTool(), { path }, f.context);
      assert.equal(direct.details.code, "LOCAL_SOURCE_BLOCKED");
      assert.doesNotMatch(text(direct), /INERT_BLOCKED_/);
      // The registered session's existing safety owner may reject even earlier.
      await assert.rejects(() => invoke(tools.get("read")!, { path }, f.context), /SAFETY_PROTECTED_PATH/);
    }
    assert.equal(probes, 0, "no upstream F_OK probe before source admission");
    assert.equal(reads, 0, "no payload was read");
  } finally { await lifecycle.shutdown(); t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("protected fallback and original spellings deny before Pi probes any candidate", async t => fixture(async f => {
  const originalAccess = fs.promises.access;
  let probes = 0;
  t.mock.method(fs.promises, "access", (async (...args: Parameters<typeof originalAccess>) => { probes++; return originalAccess(...args); }) as typeof originalAccess);
  syncBuiltinESMExports();
  try {
    for (const [request, blockedPattern] of [["Café.txt", "Café"], ["Café.txt", "Café"], ["Capture 10.30 PM.png", "\u202f"], ["Capture d'écran.txt", "\u2019"], ["raw\u00a0space.txt", "\u00a0"]]) {
      writeFileSync(join(f.config, "sensitive-patterns.yaml"), `filenames:\n - '${blockedPattern}'\n`);
      const result = await invoke(createSecureLocalReadTool(), { path: request }, f.context);
      assert.equal(result.details.code, "LOCAL_SOURCE_BLOCKED", request);
    }
    assert.equal(probes, 0, "the complete finite candidate set must be admitted before delegation");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("read normalization and finite safe fallback spellings preserve supported text delivery", async () => fixture(async f => {
  const tool = createSecureLocalReadTool();
  const variants = [
    { path: "relative-note.txt", request: "@relative-note.txt" },
    { path: "unicode space.txt", request: "unicode\u00a0space.txt" },
    { path: "Café.txt", request: "Café.txt" },
    { path: "Capture 10.30\u202fPM.txt", request: "Capture 10.30 PM.txt" },
    { path: "Capture d’écran.txt", request: "Capture d'écran.txt" },
  ];
  for (const { path, request } of variants) {
    writeFileSync(join(f.root, path), "ordinary safe spelling fixture");
    const result = await invoke(tool, { path: request }, f.context);
    assert.notEqual(result.isError, true, text(result)); assert.equal(text(result), "ordinary safe spelling fixture");
  }
}));

test("read acquires once before MIME; unsupported links cause no sniff or data read", async t => fixture(async f => {
  const target = statSync(f.file), linked = join(f.root, "linked.txt");
  writeFileSync(linked, "inert linked document"); linkSync(linked, join(f.root, "linked-alias.txt"));
  const linkedInode = statSync(linked).ino, originalOpen = fs.promises.open, originalRead = fs.readSync;
  let ordinaryReads = 0, deniedReads = 0, pathOpens = 0;
  t.mock.method(fs.promises, "open", (async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === f.file || args[0] === linked) pathOpens++;
    return originalOpen(...args);
  }) as typeof originalOpen);
  t.mock.method(fs, "readSync", ((...args: Parameters<typeof originalRead>) => {
    const stat = fs.fstatSync(args[0]);
    if (stat.ino === target.ino && stat.dev === target.dev) ordinaryReads++;
    if (stat.ino === linkedInode && stat.dev === target.dev) deniedReads++;
    return originalRead(...args);
  }) as typeof originalRead);
  syncBuiltinESMExports();
  try {
    const tool = createSecureLocalReadTool();
    const allowed = await invoke(tool, { path: f.file }, f.context);
    assert.notEqual(allowed.isError, true, text(allowed));
    const denied = await invoke(tool, { path: linked }, f.context);
    assert.equal(denied.details.code, "LOCAL_SOURCE_UNSUPPORTED_FILE");
    assert.equal(deniedReads, 0); assert.equal(pathOpens, 0);
    assert.equal(ordinaryReads, 2, "one acquisition: body then bounded EOF probe, never a MIME re-read");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("actual direct and registered FIFO reads settle without a writer under an isolated watchdog", async () => fixture(async f => {
  const fifo = join(f.root, "inert-pipe.txt"); execFileSync("mkfifo", [fifo]);
  const child = spawnSync(process.execPath, ["--import=tsx", "--input-type=module", "--eval", `
    import { createSecureLocalReadTool, registerLocalSourceToolsModule } from ${JSON.stringify(new URL("../pi-extension/local-source-tools.ts", import.meta.url).href)};
    import { createPiSessionLifecycle, registerPiSessionModules } from ${JSON.stringify(new URL("../pi-extension/index.ts", import.meta.url).href)};
    const tools = new Map(), lifecycle = createPiSessionLifecycle(() => {});
    registerPiSessionModules({ registerTool: t => tools.set(t.name, t) }, lifecycle, [registerLocalSourceToolsModule]);
    const start = Date.now(), outcomes = [];
    for (const tool of [createSecureLocalReadTool(), tools.get("read")]) {
      const result = await tool.execute("inert-fifo", { path: ${JSON.stringify(fifo)} }, undefined, undefined, { cwd: ${JSON.stringify(f.root)} });
      outcomes.push({ code: result.details.code, isError: result.isError, outputWithheld: result.details.outputWithheld });
    }
    await lifecycle.shutdown();
    console.log(JSON.stringify({ outcomes, elapsed: Date.now() - start }));
  `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 8000, killSignal: "SIGKILL" });
  assert.equal(child.status, 0, `FIFO child must settle, not time out: ${child.error?.message ?? child.stderr}`);
  const observed = JSON.parse(child.stdout);
  assert.ok(observed.elapsed < 2000);
  assert.deepEqual(observed.outcomes, Array(2).fill({ code: "LOCAL_SOURCE_UNSUPPORTED_FILE", isError: true, outputWithheld: true }));
}));

test("single-link PNG keeps Pi image delivery; multi-linked media remains denied", async () => fixture(async f => {
  const image = join(f.root, "inert.png");
  writeFileSync(image, await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
  const tool = createSecureLocalReadTool(), result = await invoke(tool, { path: image }, f.context);
  assert.notEqual(result.isError, true, text(result));
  assert.ok(result.content.some(block => (block as { type: string }).type === "image"), `actual Pi image processing/delivery remains in use: ${text(result)}`);
  linkSync(image, join(f.root, "second-image.png"));
  const denied = await invoke(tool, { path: image }, f.context);
  assert.equal(denied.details.code, "LOCAL_SOURCE_UNSUPPORTED_FILE");
  assert.ok(denied.content.every(block => block.type === "text"));
}));

test("read rejects inode replacement during acquisition and abort without unchecked updates or leaks", async t => fixture(async f => {
  const originalRead = fs.readSync, originalOpen = fs.openSync, originalClose = fs.closeSync, target = statSync(f.file);
  const owned = new Set<number>();
  t.mock.method(fs, "openSync", ((...args: Parameters<typeof originalOpen>) => { const fd = originalOpen(...args); owned.add(fd); return fd; }) as typeof originalOpen);
  t.mock.method(fs, "closeSync", (fd: number) => { owned.delete(fd); return originalClose(fd); });
  let changed = false;
  t.mock.method(fs, "readSync", ((...args: Parameters<typeof originalRead>) => {
    const stat = fs.fstatSync(args[0]), count = originalRead(...args);
    if (!changed && stat.ino === target.ino && stat.dev === target.dev) {
      changed = true; fs.renameSync(f.file, join(f.root, "old-source.txt")); writeFileSync(f.file, "unchecked replacement text");
    }
    return count;
  }) as typeof originalRead);
  const updates: PiToolResult[] = [];
  const result = await invoke(createSecureLocalReadTool(), { path: f.file }, f.context, r => updates.push(r));
  assert.equal(result.details.code, "LOCAL_SOURCE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify([result, updates]), /ordinary before|unchecked replacement text|INERT_LOCAL_CANARY/);
  const controller = new AbortController(); controller.abort();
  const aborted = await createSecureLocalReadTool().execute("inert-abort", { path: f.file }, controller.signal, undefined, f.context);
  assert.equal(aborted.isError, true); assert.doesNotMatch(text(aborted), /unchecked replacement text/);
  assert.equal(owned.size, 0, "every descriptor opened by the synchronous reader closes");
}));

test("read revalidates between async callbacks; abort after ingress suppresses checked text", async t => fixture(async f => {
  for (const action of ["replace", "abort"] as const) {
    const controller = new AbortController(), originalRead = fs.readSync, target = statSync(f.file);
    let scheduled = false;
    t.mock.method(fs, "readSync", ((...args: Parameters<typeof originalRead>) => {
      const stat = fs.fstatSync(args[0]), count = originalRead(...args);
      if (!scheduled && stat.ino === target.ino && stat.dev === target.dev) {
        scheduled = true;
        queueMicrotask(() => {
          if (action === "abort") controller.abort();
          else { fs.renameSync(f.file, join(f.root, "old-between-callbacks.txt")); writeFileSync(f.file, "replacement between callbacks"); }
        });
      }
      return count;
    }) as typeof originalRead);
    try {
      const result = await createSecureLocalReadTool().execute("inert-after-ingress", { path: f.file }, controller.signal, undefined, f.context);
      assert.equal(result.isError, true); assert.equal(result.details.code, "LOCAL_SOURCE_UNAVAILABLE");
      assert.doesNotMatch(text(result), /ordinary before|replacement between callbacks|INERT_LOCAL_CANARY/);
    } finally { t.mock.restoreAll(); }
  }
}));

test("registered read lifetime revokes in-flight acquired bytes before session shutdown delivery", async t => fixture(async f => {
  const originalRead = fs.readSync, originalOpen = fs.openSync, originalClose = fs.closeSync;
  const target = statSync(f.file), owned = new Set<number>();
  let shutdown: Promise<void> | undefined, scheduled = false, registryClosed = false;
  const tools = new Map<string, PiToolDefinition>(), lifecycle = createPiSessionLifecycle(() => { registryClosed = true; });
  registerPiSessionModules({ registerTool: tool => tools.set(tool.name, tool) }, lifecycle, [registerLocalSourceToolsModule]);
  t.mock.method(fs, "openSync", ((...args: Parameters<typeof originalOpen>) => { const fd = originalOpen(...args); owned.add(fd); return fd; }) as typeof originalOpen);
  t.mock.method(fs, "closeSync", (fd: number) => { owned.delete(fd); return originalClose(fd); });
  t.mock.method(fs, "readSync", ((...args: Parameters<typeof originalRead>) => {
    const stat = fs.fstatSync(args[0]), count = originalRead(...args);
    if (!scheduled && stat.ino === target.ino && stat.dev === target.dev) {
      scheduled = true;
      queueMicrotask(() => { shutdown = lifecycle.shutdown({ reason: "reload" }); });
    }
    return count;
  }) as typeof originalRead);
  try {
    const result = await invoke(tools.get("read")!, { path: f.file }, f.context);
    assert.equal(scheduled, true, "exercise actual acquisition, not a late-call-only rejection");
    await shutdown;
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "LOCAL_SOURCE_UNAVAILABLE");
    assert.equal(result.details.outputWithheld, true);
    assert.equal(result.details.effectState, "not-established");
    assert.doesNotMatch(JSON.stringify(result), /ordinary before|ordinary after|INERT_LOCAL_CANARY/);
    assert.equal(owned.size, 0, "reader pins close even when shutdown revokes delivery");
    assert.equal(registryClosed, true);
    await assert.rejects(() => invoke(tools.get("read")!, { path: f.file }, f.context), /shutting down/);
  } finally { await lifecycle.shutdown(); t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("registered reader revokes all shutdown reasons, drops late updates/results/errors and never borrows replacement lifetime", async () => fixture(async f => {
  for (const reason of ["reload", "new", "resume", "fork", "quit"]) {
    for (const thrown of [false, true]) {
      let finish!: () => void, receivedSignal: AbortSignal | undefined, closes = 0, calls = 0;
      const tools = new Map<string, PiToolDefinition>(), updates: PiToolResult[] = [];
      const lifecycle = createPiSessionLifecycle(() => { closes++; });
      registerPiSessionModules({ registerTool: tool => tools.set(tool.name, tool) }, lifecycle, [pi => pi.registerTool?.({
        name: "read", label: "Inert delegated reader", description: "Inert lifetime fixture", parameters: Type.Object({ path: Type.String() }),
        execute: async (_id, _input, signal, update) => {
          calls++; receivedSignal = signal;
          await new Promise<void>(resolve => { finish = resolve; });
          const result = { content: [{ type: "text" as const, text: "INERT_REVOKED_READER_BODY" }], details: {} };
          update?.(result);
          if (thrown) throw new Error("INERT_REVOKED_READER_BODY");
          return result;
        },
      })]);
      const pending = invoke(tools.get("read")!, { path: f.file }, f.context, result => updates.push(result));
      assert.equal(receivedSignal?.aborted, false);
      const shutdown = lifecycle.shutdown({ reason });
      assert.equal(receivedSignal?.aborted, true, "revocation precedes cleanup/settlement");
      assert.equal(closes, 0, "registry remains owned until pending read settles");
      finish();
      const result = await pending;
      await shutdown;
      assert.equal(closes, 1);
      assert.equal(result.details.code, "LOCAL_SOURCE_UNAVAILABLE");
      assert.equal(result.isError, true);
      assert.deepEqual(updates, [], "no progress or unchecked late update after revocation");
      assert.doesNotMatch(JSON.stringify(result), /INERT_REVOKED_READER_BODY/);
      await assert.rejects(() => invoke(tools.get("read")!, { path: f.file }, f.context), /shutting down/);
      assert.equal(calls, 1, "late rejection must precede delegation");
    }
  }
  const replacementTools = new Map<string, PiToolDefinition>(), replacement = createPiSessionLifecycle(() => {});
  registerPiSessionModules({ registerTool: tool => replacementTools.set(tool.name, tool) }, replacement, [registerLocalSourceToolsModule]);
  try {
    const allowed = await invoke(replacementTools.get("read")!, { path: f.file }, f.context);
    assert.notEqual(allowed.isError, true, text(allowed));
    assert.match(text(allowed), /ordinary before/);
  } finally { await replacement.shutdown(); }
}));

test("registered read combines caller cancellation without revoking another call in the same session", async () => fixture(async f => {
  let finish!: () => void, receivedSignal: AbortSignal | undefined;
  const tools = new Map<string, PiToolDefinition>(), lifecycle = createPiSessionLifecycle(() => {});
  registerPiSessionModules({ registerTool: tool => tools.set(tool.name, tool) }, lifecycle, [pi => pi.registerTool?.({
    name: "read", label: "Inert delegated reader", description: "Inert lifetime fixture", parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, _input, signal) => {
      receivedSignal = signal;
      await new Promise<void>(resolve => { finish = resolve; });
      return { content: [{ type: "text" as const, text: "ordinary delegated fixture" }], details: {} };
    },
  })]);
  try {
    const controller = new AbortController();
    const pending = tools.get("read")!.execute("caller-abort", { path: f.file }, controller.signal, undefined, f.context);
    controller.abort();
    assert.equal(receivedSignal?.aborted, true);
    finish();
    const denied = await pending;
    assert.equal(denied.details.code, "LOCAL_SOURCE_UNAVAILABLE");
    assert.doesNotMatch(text(denied), /ordinary delegated fixture/);
    const next = invoke(tools.get("read")!, { path: f.file }, f.context);
    assert.equal(receivedSignal?.aborted, false, "caller cancellation does not revoke the session");
    finish();
    const allowed = await next;
    assert.notEqual(allowed.isError, true, text(allowed));
    assert.equal(text(allowed), "ordinary delegated fixture");
  } finally { await lifecycle.shutdown(); }
}));

test("read distinguishes unknown I/O from unsupported policy without exposing private exceptions", async t => fixture(async f => {
  const target = statSync(f.file), originalRead = fs.readSync;
  t.mock.method(fs, "readSync", ((...args: Parameters<typeof originalRead>) => {
    if (fs.fstatSync(args[0]).ino === target.ino) throw new Error(`inert private failure ${f.root} ${f.canary}`);
    return originalRead(...args);
  }) as typeof originalRead);
  const unavailable = await invoke(createSecureLocalReadTool(), { path: f.file }, f.context);
  assert.equal(unavailable.details.code, "LOCAL_SOURCE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(unavailable), /inert private failure|INERT_LOCAL_CANARY/);
  const missing = await invoke(createSecureLocalReadTool(), { path: join(f.root, "missing.txt") }, f.context);
  assert.equal(missing.details.code, "LOCAL_SOURCE_UNAVAILABLE");
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
  assert.equal(read.isError, true); assert.equal(read.details.code, "LOCAL_CONTENT_POLICY");
  assert.doesNotMatch(text(read), /INERT_LOCAL_CANARY|INERT_INVALID_PATTERN/);
  let spawns = 0;
  const shell = createSecureLocalBashTool({ exec: async () => { spawns++; return { exitCode: 0 }; } });
  const result = await invoke(shell, { command: "inert-fixture" }, f.context);
  assert.equal(result.isError, true); assert.equal(spawns, 0);
}));
