import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { acquireLocalSourceFile, closeDb } from "@pa-platform/pa-core";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { ReadPublicationOwner, publishReadEvent, withholdUnownedReadEvent } from "../pi-extension/read-publication.js";
import { createPiSessionLifecycle, registerPiSessionModules, type PiToolDefinition, type PiToolResult } from "../pi-extension/index.js";
import { registerLocalSourceToolsModule } from "../pi-extension/local-source-tools.js";

// Promise resolution is the registered API handoff, not the later awaiting
// caller's observation. Native runtime emission still needs its own integration
// coverage; this regression must not mistake late observation for a new publish.
test("registered read checks revocation at its actual API handoff, not an inner promise", async () => {
  const environment = process.env;
  const root = mkdtempSync(join(tmpdir(), "read-publication-"));
  const config = join(root, "config"); mkdirSync(config);
  writeFileSync(join(config, "sensitive-patterns.yaml"), "contents: []\n");
  const file = join(root, "ordinary.txt"); writeFileSync(file, "INERT_PUBLICATION_BODY\n");
  process.env = { ...environment, PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
  delete process.env.PA_DEPLOYMENT_ID; delete process.env.PA_DEPLOYMENT_DIR;
  closeDb();
  const violations: string[] = [];
  let lateObservations = 0, denied = 0, allowed = 0;
  try {
    for (const actual of [false, true]) {
      for (let depth = 1; depth <= 24; depth++) {
        const tools = new Map<string, PiToolDefinition>();
        const lifecycle = createPiSessionLifecycle(() => {});
        registerPiSessionModules({ registerTool: tool => tools.set(tool.name, tool) }, lifecycle, actual ? [registerLocalSourceToolsModule] : [pi => pi.registerTool?.({
          name: "read", label: "Inert reader", description: "Publication regression fixture", parameters: Type.Object({ path: Type.String() }),
          execute: async () => ({ content: [{ type: "text", text: "INERT_PUBLICATION_BODY" }], details: {} }),
        })]);
        const promises = new WeakMap<object, number>();
        let target: number | undefined, revoked = false, revokedAtHandoff: boolean | undefined;
        const hook = createHook({
          init(id, type, _parent, resource) { if (type === "PROMISE") promises.set(resource, id); },
          promiseResolve(id) { if (id === target) revokedAtHandoff = revoked; },
        }).enable();
        try {
          const pending = tools.get("read")!.execute("publication-fixture", { path: file }, undefined, undefined, { cwd: root });
          target = promises.get(pending);
          assert.notEqual(target, undefined);
          const shutdown = new Promise<void>(resolve => {
            const schedule = (remaining: number) => queueMicrotask(() => {
              if (remaining > 1) schedule(remaining - 1);
              else { revoked = true; void lifecycle.shutdown({ reason: "reload" }).then(resolve); }
            });
            schedule(depth);
          });
          const result: PiToolResult = await pending;
          assert.equal(typeof revokedAtHandoff, "boolean", "observe actual returned promise settlement");
          const body = JSON.stringify(result).includes("INERT_PUBLICATION_BODY");
          if (revokedAtHandoff && body) violations.push(`${actual ? "actual" : "delegated"} depth=${depth}`);
          if (body) { allowed++; if (revoked && !revokedAtHandoff) lateObservations++; }
          else { denied++; assert.equal(result.details.code, "LOCAL_SOURCE_UNAVAILABLE"); }
          await shutdown;
        } finally { hook.disable(); await lifecycle.shutdown(); }
      }
    }
    assert.deepEqual(violations, [], `content crossed the registered API after revocation: ${violations.join(", ")}`);
    assert.ok(denied > 0 && allowed > 0, "exercise both sides of publication");
    assert.ok(lateObservations > 0, "already-published results may be observed after shutdown without retraction");
  } finally { closeDb(); process.env = environment; rmSync(root, { recursive: true, force: true }); }
});

// Acquirer fixtures here test transport custody only. They do not authenticate
// selected-host provenance or grant immutable multi-link access.
test("read transport retains descriptors until its synchronous native emission and never retracts committed output", async t => {
  const environment = process.env;
  const root = mkdtempSync(join(tmpdir(), "read-transport-")), config = join(root, "config");
  mkdirSync(config); writeFileSync(join(config, "sensitive-patterns.yaml"), "contents: []\n");
  process.env = { ...environment, PA_PLATFORM_CONFIG: config };
  try {
    for (const action of ["publish", "error-override", "abort", "revoke", "replace", "close-failure", "foreign-id", "foreign-content"] as const) {
      await t.test(action, async () => {
        const owner = new ReadPublicationOwner(), caller = new AbortController();
        const file = join(root, `${action}.txt`); writeFileSync(file, "INERT_TRANSPORT_BODY\n");
        let acquired = 0, closed = 0;
        const reader = owner.createTool(createReadToolDefinition, (path, patterns, signal) => {
          const source = acquireLocalSourceFile(path, patterns, signal); acquired++;
          return { bytes: source.bytes, assertStable: () => source.assertStable(), close() {
            source.close(); closed++;
            if (action === "close-failure") throw new Error("inert close failure");
          } };
        });
        try {
          const result = await reader.execute("read-1", { path: file }, caller.signal, undefined, { cwd: root });
          assert.equal(acquired, 1); assert.equal(closed, 0, "formatter transfers descriptor ownership");
          if (action === "abort") caller.abort();
          if (action === "revoke") owner.revoke();
          if (action === "replace") writeFileSync(file, "INERT_CHANGED_BODY\n");
          const event = { type: "tool_execution_end", toolName: "read", toolCallId: action === "foreign-id" ? "foreign" : "read-1", result: action === "foreign-content" ? { ...result, content: [...result.content] } : result, isError: action === "error-override" };
          const owned = owner.publishEvent(event);
          assert.equal(owned, true);
          assert.equal(closed, 1, "even a lost correlation settles the original source immediately");
          const serialized = JSON.stringify(event);
          if (action === "publish" || action === "error-override") {
            assert.match(serialized, /INERT_TRANSPORT_BODY/);
            assert.equal(event.isError, action === "error-override"); assert.equal(closed, 1);
            owner.revoke();
            const message = { type: "message_end", message: { role: "toolResult", toolName: "read", toolCallId: "read-1", content: event.result.content, details: event.result.details, isError: false } };
            assert.equal(owner.publishEvent(message), true);
            assert.match(JSON.stringify(message), /INERT_TRANSPORT_BODY/, "late observation of committed output is not a new read");
            assert.equal(message.message.isError, action === "error-override", "committed event-only errors remain errors in later history");
            assert.equal(closed, 1);
          } else {
            assert.equal(event.isError, true);
            assert.equal(event.result.details.code, "LOCAL_SOURCE_UNAVAILABLE");
            assert.doesNotMatch(serialized, /INERT_TRANSPORT_BODY|INERT_CHANGED_BODY|inert close failure/);
          }
        } finally { owner.revoke(); assert.equal(closed, acquired, "every owned source closes exactly once"); }
      });
    }
  } finally { process.env = environment; rmSync(root, { recursive: true, force: true }); }
});

test("selected publication validates the host for first commitment but never retracts authenticated committed output", async () => {
  // Transport mechanics with ordinary single-link sources, not a producer
  // declaration or a positive immutable-document permission fixture.
  const environment = process.env, root = mkdtempSync(join(tmpdir(), "read-host-commit-")), config = join(root, "config");
  mkdirSync(config); writeFileSync(join(config, "sensitive-patterns.yaml"), "contents: []\n");
  process.env = { ...environment, PA_PLATFORM_CONFIG: config };
  try {
    for (const drift of ["after", "before"]) {
      const owner = new ReadPublicationOwner(), owners = new Set([owner]);
      const file = join(root, `${drift}.txt`); writeFileSync(file, "INERT_HOST_COMMITTED_BODY");
      let valid = true, checks = 0;
      const assertHost = () => { checks++; if (!valid) throw new Error("inert host drift"); };
      const read = owner.createTool(createReadToolDefinition, acquireLocalSourceFile);
      try {
        const result = await read.execute("host-read", { path: file }, undefined, undefined, { cwd: root });
        if (drift === "before") valid = false;
        const end = { type: "tool_execution_end", toolName: "read", toolCallId: "host-read", result, isError: false };
        publishReadEvent(owners, end, assertHost);
        assert.equal(end.isError, drift === "before");
        valid = false; owner.revoke();
        const checkedAtCommit = checks;
        const late = { type: "message_end", message: { role: "toolResult", toolName: "read", toolCallId: "host-read", content: end.result.content, details: end.result.details, isError: false } };
        publishReadEvent(owners, late, assertHost);
        assert.equal(checks, checkedAtCommit, "committed correlation must not depend on current host validity");
        assert.equal(late.message.isError, drift === "before");
        assert.equal(JSON.stringify(late).includes("INERT_HOST_COMMITTED_BODY"), drift === "after");
        const unowned = { type: "tool_execution_end", toolName: "read", toolCallId: "host-read", result: { content: [...end.result.content], details: {} }, isError: false };
        publishReadEvent(owners, unowned, assertHost);
        assert.equal(unowned.isError, true, "new content identity cannot borrow a committed result");
      } finally { owner.revoke(); }
    }
  } finally { process.env = environment; rmSync(root, { recursive: true, force: true }); }
});

test("public aliases cannot mutate the private committed snapshot before a later sink", async () => {
  const environment = process.env, root = mkdtempSync(join(tmpdir(), "read-public-alias-")), config = join(root, "config");
  mkdirSync(config); writeFileSync(join(config, "sensitive-patterns.yaml"), "contents: []\n");
  process.env = { ...environment, PA_PLATFORM_CONFIG: config };
  const owner = new ReadPublicationOwner(), owners = new Set([owner]);
  try {
    const file = join(root, "ordinary.txt"); writeFileSync(file, "INERT_ALIAS_CHECKED_BODY");
    const read = owner.createTool(createReadToolDefinition, acquireLocalSourceFile);
    const result = await read.execute("alias-read", { path: file }, undefined, undefined, { cwd: root });
    const end = { type: "tool_execution_end", toolName: "read", toolCallId: "alias-read", result, isError: false };
    publishReadEvent(owners, end, () => {});
    end.result.content.push({ type: "text", text: "INERT_UNCHECKED_ALIAS_ADDITION" });
    end.result.details["injected"] = "INERT_UNCHECKED_ALIAS_ADDITION";
    if (end.result.structuredContent && typeof end.result.structuredContent === "object") Object.assign(end.result.structuredContent, { injected: "INERT_UNCHECKED_ALIAS_ADDITION" });
    owner.revoke();
    const late = { type: "message_end", message: { role: "toolResult", toolName: "read", toolCallId: "alias-read",
      content: end.result.content, details: end.result.details, structuredContent: end.result.structuredContent, isError: false } };
    publishReadEvent(owners, late, () => { throw new Error("no current host needed for old checked data"); });
    assert.equal(late.message.isError, false);
    assert.match(JSON.stringify(late), /INERT_ALIAS_CHECKED_BODY/);
    assert.doesNotMatch(JSON.stringify(late), /INERT_UNCHECKED_ALIAS_ADDITION/);
    assert.notEqual(late.message.content, end.result.content);
  } finally { owner.revoke(); process.env = environment; rmSync(root, { recursive: true, force: true }); }
});

test("committed history keeps its checked page but does not retain a complete acquired source buffer", () => {
  const script = `
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';
    import { acquireLocalSourceFile } from ${JSON.stringify(new URL("../../../pa-core/src/index.ts", import.meta.url).href)};
    import { ReadPublicationOwner } from ${JSON.stringify(new URL("../pi-extension/read-publication.ts", import.meta.url).href)};
    const root = mkdtempSync(join(tmpdir(), 'read-buffer-release-')), config = join(root, 'config');
    mkdirSync(config); writeFileSync(join(config, 'sensitive-patterns.yaml'), 'contents: []\\n');
    process.env.PA_PLATFORM_CONFIG = config;
    delete process.env.PA_DEPLOYMENT_ID; delete process.env.PA_DEPLOYMENT_DIR;
    const file = join(root, 'ordinary.txt'); writeFileSync(file, 'INERT_RETAINED_PAGE\\n'.repeat(20000));
    const owner = new ReadPublicationOwner(), sources = []; let closed = 0;
    try {
      const read = owner.createTool(createReadToolDefinition, (path, patterns, signal) => {
        const acquired = acquireLocalSourceFile(path, patterns, signal);
        const source = { bytes: acquired.bytes, assertStable() { acquired.assertStable(); }, close() { acquired.close(); closed++; } };
        sources.push(new WeakRef(source)); return source;
      });
      const result = await read.execute('buffer-read', { path: file, limit: 1 }, undefined, undefined, { cwd: root });
      const event = { type: 'tool_execution_end', toolName: 'read', toolCallId: 'buffer-read', result, isError: false };
      owner.publishEvent(event);
      let retained = sources.length;
      for (let attempt = 0; attempt < 30 && retained; attempt++) {
        await new Promise(resolve => setImmediate(resolve)); global.gc();
        retained = sources.filter(source => source.deref() !== undefined).length;
      }
      owner.revoke();
      const late = { type: 'message_end', message: { role: 'toolResult', toolName: 'read', toolCallId: 'buffer-read', content: event.result.content, details: event.result.details } };
      const owned = owner.publishEvent(late);
      console.log(JSON.stringify({ retained, closed, owned, body: JSON.stringify(late).includes('INERT_RETAINED_PAGE') }));
    } finally { owner.revoke(); rmSync(root, { recursive: true, force: true }); }
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "--import=tsx", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 20000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { retained: 0, closed: 1, owned: true, body: true });
});
