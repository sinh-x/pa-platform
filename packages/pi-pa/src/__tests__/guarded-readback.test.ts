import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { acquireLocalSourceFile, closeDb, SourceContentSecurityError } from "@pa-platform/pa-core";
import { bindLocalReadTool } from "../pi-extension/bound-local-read.js";
import { ReadPublicationOwner } from "../pi-extension/read-publication.js";
import { createPiSessionLifecycle, registerPiSessionModules, type PiToolDefinition, type PiToolResult } from "../pi-extension/index.js";
import { registerLocalContentResultModule } from "../pi-extension/local-content-security.js";

const text = (result: PiToolResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
async function fixture(run: (root: string) => Promise<void>) {
  const environment = process.env, root = fs.mkdtempSync(join(tmpdir(), "guarded-readback-"));
  const config = join(root, "config"); fs.mkdirSync(config);
  fs.writeFileSync(join(config, "sensitive-patterns.yaml"), "contents: []\n");
  process.env = { ...environment, PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") };
  delete process.env.PA_DEPLOYMENT_ID; delete process.env.PA_DEPLOYMENT_DIR;
  closeDb();
  try { await run(root); }
  finally { closeDb(); process.env = environment; fs.rmSync(root, { recursive: true, force: true }); }
}

test("PAP-332: actual write/read roundtrips similarly sized JSON; pagination failure is not source failure", async () => fixture(async root => {
  const context = { cwd: root }, owner = new ReadPublicationOwner();
  const tools = new Map<string, PiToolDefinition>(), lifecycle = createPiSessionLifecycle(() => {});
  lifecycle.addShutdownStep(() => owner.revoke());
  registerPiSessionModules({ registerTool: tool => tools.set(tool.name, tool) }, lifecycle, [pi => pi.registerTool?.(owner.createTool(createReadToolDefinition, acquireLocalSourceFile)), registerLocalContentResultModule]);
  try {
    for (const layout of ["compact", "multiline"] as const) {
      const data = { rows: Array.from({ length: 150 }, () => "ordinary inert fixture"), padding: "" };
      const initial = JSON.stringify(data, null, layout === "multiline" ? 2 : undefined) + "\n";
      data.padding = "x".repeat(27237 - Buffer.byteLength(initial));
      const content = JSON.stringify(data, null, layout === "multiline" ? 2 : undefined) + "\n";
      assert.equal(Buffer.byteLength(content), 27237);
      const file = join(root, `${layout}.json`);
      await createWriteToolDefinition(root).execute("inert-write", { path: file, content }, undefined, undefined, context as any);
      const before = fs.statSync(file, { bigint: true });
      assert.equal(before.nlink, 1n);
      for (const input of [{ path: file }, { path: file, offset: 100, limit: 43 }, { path: file, offset: 1000, limit: 43 }]) {
        const id = `${layout}-${input.offset ?? 1}`;
        const direct = await bindLocalReadTool(createReadToolDefinition, acquireLocalSourceFile).execute(id, input, undefined, undefined, context);
        const registered = await tools.get("read")!.execute(id, input, undefined, undefined, context);
        const event = { type: "tool_execution_end", toolName: "read", toolCallId: id, result: registered, isError: registered.isError === true };
        assert.equal(owner.publishEvent(event), true);
        const outOfRange = (input.offset ?? 1) > content.split("\n").length;
        for (const result of [direct, event.result]) {
          assert.equal(result.isError === true, outOfRange);
          if (outOfRange) {
            assert.equal(result.details.code, "LOCAL_SOURCE_UNAVAILABLE", "retain the public code contract");
            assert.equal(result.details.failureClass, "read-range");
            assert.equal(result.details.outputWithheld, true);
            assert.match(text(result), /Source acquisition succeeded/);
            assert.doesNotMatch(text(result), /ordinary inert fixture/);
            assert.ok(text(result).length <= 2000);
          } else if (input.offset === undefined) assert.equal(text(result), content);
          else assert.match(text(result), /ordinary inert fixture/);
        }
      }
      const after = fs.statSync(file, { bigint: true });
      for (const key of ["dev", "ino", "size", "nlink", "mode", "mtimeNs", "ctimeNs"] as const) assert.equal(after[key], before[key]);
    }
  } finally { await lifecycle.shutdown(); }
}));

test("range diagnosis follows complete redaction and source admission, never precedes them", async () => fixture(async root => {
  const tool = bindLocalReadTool(createReadToolDefinition, acquireLocalSourceFile);
  const context = { cwd: root }, file = join(root, "inert-key-example.txt");
  const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" "), footer = ["-----END", "PRIVATE KEY-----"].join(" ");
  fs.writeFileSync(file, [header, ...Array(140).fill("INERT_BODY_NOT_FOR_DELIVERY"), footer, "ordinary end"].join("\n"));
  const checked = await tool.execute("redacted-page", { path: file, offset: 100, limit: 43 }, undefined, undefined, context);
  assert.notEqual(checked.isError, true);
  assert.match(text(checked), /REDACTED/);
  assert.doesNotMatch(JSON.stringify(checked), /INERT_BODY_NOT_FOR_DELIVERY/);
  const blocked = await tool.execute("blocked-range", { path: join(root, ".env"), offset: 100 }, undefined, undefined, context);
  assert.equal(blocked.details.code, "LOCAL_SOURCE_BLOCKED");
  assert.equal(blocked.details.failureClass, undefined);
  const missing = await tool.execute("missing-range", { path: join(root, "missing.json"), offset: 100 }, undefined, undefined, context);
  assert.equal(missing.details.failureClass, "source-open");
  const controller = new AbortController(); controller.abort();
  const cancelled = await tool.execute("cancelled-range", { path: file, offset: 1000 }, controller.signal, undefined, context);
  assert.equal(cancelled.details.failureClass, "cancelled");
}));

test("untyped formatter failures and typed acquisition failures remain distinct and private", async () => fixture(async root => {
  const factory = ((...args: Parameters<typeof createReadToolDefinition>) => ({ ...createReadToolDefinition(...args), execute: async () => { throw Error(`inert private formatter ${root}`); } })) as typeof createReadToolDefinition;
  const result = await bindLocalReadTool(factory, acquireLocalSourceFile).execute("formatter", { path: join(root, "ordinary.json") }, undefined, undefined, { cwd: root });
  assert.equal(result.details.failureClass, "read-processing");
  assert.ok(!text(result).includes(root));
  assert.doesNotMatch(text(result), /inert private formatter/);
  const file = join(root, "ordinary.json"); fs.writeFileSync(file, "{}\n");
  const denied = await bindLocalReadTool(createReadToolDefinition, () => { throw new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE", "source-stat"); }).execute("stat", { path: file }, undefined, undefined, { cwd: root });
  assert.equal(denied.details.failureClass, "source-stat");
}));

test("registered caller abort and shutdown preserve cancellation classification", async () => fixture(async root => {
  const file = join(root, "ordinary.txt"); fs.writeFileSync(file, "inert ordinary body\n");
  for (const action of ["caller", "shutdown"]) {
    const tools = new Map<string, PiToolDefinition>(), lifecycle = createPiSessionLifecycle(() => {});
    registerPiSessionModules({ registerTool: tool => tools.set(tool.name, tool) }, lifecycle, [pi => pi.registerTool?.(bindLocalReadTool(createReadToolDefinition, acquireLocalSourceFile))]);
    const caller = new AbortController();
    try {
      const pending = tools.get("read")!.execute(action, { path: file, offset: 100 }, caller.signal, undefined, { cwd: root });
      if (action === "caller") caller.abort();
      else void lifecycle.shutdown({ reason: "reload" });
      const result = await pending;
      assert.equal(result.details.failureClass, "cancelled");
      assert.doesNotMatch(text(result), /inert ordinary body/);
    } finally { await lifecycle.shutdown(); }
  }
}));

test("EOF and withheld projections use projected line boundaries, with no unscanned tail", async () => fixture(async root => {
  const tool = bindLocalReadTool(createReadToolDefinition, acquireLocalSourceFile);
  const file = join(root, "lines.txt"); fs.writeFileSync(file, "one\nsecond\n");
  for (const offset of [2, 3, 4]) {
    const result = await tool.execute(`eof-${offset}`, { path: file, offset, limit: 1 }, undefined, undefined, { cwd: root });
    assert.equal(result.isError === true, offset === 4);
    if (offset === 4) assert.equal(result.details.failureClass, "read-range");
  }
  fs.writeFileSync(join(root, "config/sensitive-patterns.yaml"), "contents:\n - 'INERT_MATCH'\n");
  const withheld = join(root, "withheld.txt"); fs.writeFileSync(withheld, "INERT_MATCH\n".repeat(10002));
  const result = await tool.execute("collapsed-range", { path: withheld, offset: 100 }, undefined, undefined, { cwd: root });
  assert.equal(result.details.failureClass, "read-range");
  assert.doesNotMatch(JSON.stringify(result), /INERT_MATCH/);
}));

test("later mutation, cancellation or cleanup failure supersedes a checked range diagnostic at publication", async () => fixture(async root => {
  for (const action of ["replace", "abort", "close-failure"] as const) {
    const file = join(root, `${action}.txt`); fs.writeFileSync(file, "inert unpublished body\n");
    const owner = new ReadPublicationOwner(), controller = new AbortController();
    let closes = 0;
    const tool = owner.createTool(createReadToolDefinition, (path, patterns, signal) => {
      const source = acquireLocalSourceFile(path, patterns, signal);
      return { bytes: source.bytes, assertStable: source.assertStable, close() {
        source.close(); closes++;
        if (action === "close-failure") throw Error("inert private cleanup error");
      } };
    });
    try {
      const result = await tool.execute(action, { path: file, offset: 100 }, controller.signal, undefined, { cwd: root });
      assert.equal(result.details.failureClass, "read-range");
      assert.equal(closes, 0);
      if (action === "replace") { fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, "inert replacement body\n"); }
      if (action === "abort") controller.abort();
      const event = { type: "tool_execution_end", toolName: "read", toolCallId: action, result, isError: true };
      assert.equal(owner.publishEvent(event), true);
      assert.equal(event.result.details.failureClass, action === "abort" ? "cancelled" : "read-publication");
      assert.doesNotMatch(JSON.stringify(event), /inert unpublished body|inert replacement body|inert private cleanup error/);
      assert.equal(closes, 1);
    } finally { owner.revoke(); }
    assert.equal(closes, 1);
  }
}));
