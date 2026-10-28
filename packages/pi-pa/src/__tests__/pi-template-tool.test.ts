import assert from "node:assert/strict";
import test from "node:test";
import { templateService } from "@pa-platform/pa-core";
import { templateFixture } from "../../../pa-core/src/__tests__/template-fixture.js";
import { producerFixture } from "../../../pa-core/src/__tests__/template-producer-fixture.js";
import { completeTemplateFixture } from "../../../pa-core/src/__tests__/template-complete-fixture.js";
import { runCoreCommand } from "../../../pa-core/src/cli/core-command.js";
import { createTemplateModule } from "../pi-extension/template-tool.js";
import type { PiToolDefinition } from "../pi-extension/index.js";

test("all sixteen selected producers have four-operation native/public-dispatcher parity and deterministic bytes", async () => {
  const f = completeTemplateFixture(); try {
    let tool: PiToolDefinition | undefined;
    createTemplateModule({ selection: f.selection })({ registerTool: (t) => { tool = t as PiToolDefinition; } });
    for (const entry of f.registry.entries) {
      const bindings = f.allBindings[entry.id]!;
      const rendered = templateService({ action: "render", id: entry.id, version: entry.revision, bindings }, { selection: f.selection });
      assert.equal(rendered.ok, true, JSON.stringify(rendered));
      for (const action of ["list", "show", "render", "validate"]) {
        const body = action === "render" ? { bindings } : action === "validate" ? { bindings, candidate: rendered.candidate } : undefined;
        const request = { action, ...(action === "list" ? {} : { id: entry.id, version: entry.revision }), ...body };
        const expected = JSON.stringify(templateService(request, { selection: f.selection }));
        for (let n = 0; n < 20; n++) {
          const out: string[] = [];
          assert.equal(await runCoreCommand(["template", action, ...(action === "list" ? [] : [entry.id, "--version", entry.revision])], { binaryName: "ppa", templateHost: { selection: f.selection, input: (async function* () { if (body) yield JSON.stringify(body); })() }, io: { stdout: s => out.push(s), stderr: s => assert.fail(s) } }), 0);
          const native = await tool!.execute("synthetic-all-sixteen", { request: JSON.stringify(request) }, undefined, undefined, undefined);
          assert.equal(native.isError, false); assert.equal(native.content[0]!.text, expected); assert.equal(out[0], expected);
        }
      }
      for (const bindingName of Object.keys(entry.bindings).filter(key => entry.bindings[key]!.required)) {
        const bad = { ...bindings }; delete bad[bindingName];
        const request = { action: "render", id: entry.id, version: entry.revision, bindings: bad };
        const native = await tool!.execute("synthetic-missing", { request: JSON.stringify(request) }, undefined, undefined, undefined);
        assert.equal(native.isError, true); assert.deepEqual(JSON.parse(native.content[0]!.text), templateService(request, { selection: f.selection }));
      }
    }
    assert.equal(templateService({ action: "render", id: "pair-signoff", version: "1", bindings: f.amendmentPairBindings }, { selection: f.selection }).ok, true, "one selected pair source supports both handoff variants");
  } finally { f.dispose(); }
});

for (const kind of ["fresh", "amendment"] as const) test(`public CLI/native ${kind} producer bytes reach the actual consumer without authority effects`, async () => {
  const f = producerFixture(kind); try {
    let tool: PiToolDefinition | undefined;
    createTemplateModule({ selection: f.selection })({ registerTool: (t) => { tool = t as PiToolDefinition; } });
    for (const [id, bindings, candidate] of [[`handoff-${kind}`, f.handoffBindings, f.handoff.candidate], ["pair-signoff", f.bindings, f.pair.candidate]] as const) {
      for (const action of ["render", "validate"]) for (let i = 0; i < 20; i++) {
        const body = { bindings, ...(action === "validate" ? { candidate } : {}) };
        const input = { action, id, version: "1", ...body };
        const output: string[] = [];
        assert.equal(await runCoreCommand(["template", action, id, "--version", "1"], { binaryName: "ppa", templateHost: { selection: f.selection, input: (async function* () { yield JSON.stringify(body); })() }, io: { stdout: (s) => output.push(s), stderr: (s) => assert.fail(s) } }), 0);
        const native = await tool!.execute("synthetic-fixture", { request: JSON.stringify(input) }, undefined, undefined, undefined);
        assert.equal(native.isError, false); assert.deepEqual(JSON.parse(native.content[0]!.text), JSON.parse(output[0]!));
        assert.equal(JSON.parse(output[0]!).candidate, candidate);
      }
    }
    assert.equal(f.resolveBaseline().baseSha, f.bindings.baseSha);
    f.record.comments[0]!.author = "requirements/analyst"; f.saveTicket();
    assert.throws(f.resolveBaseline, /ORDINARY_BASELINE_/);
  } finally { f.dispose(); }
});

test("native raw request documents retain escaped duplicates and exact UTF-8 byte limits", async () => {
  const f = templateFixture(); try {
    let tool: PiToolDefinition | undefined;
    createTemplateModule({ selection: f.selection })({ registerTool: t => { tool = t as PiToolDefinition; } });
    for (const request of [
      '{"action":"list","\\u0061ction":"list"}',
      '{"action":"render","id":"requirements","version":"1","bindings":{"ticket":"FIX-1","\\u0074icket":"SENTINEL"}}',
      '\ufeff{"action":"list"}', ' '.repeat(65537), '\ud800',
      '{"action":"list","SENTINEL":"private body"}',
      '{"action":"list","x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}',
    ]) {
      const native = await tool!.execute("synthetic-raw-negative", { request }, undefined, undefined, undefined);
      assert.equal(native.isError, true); assert.deepEqual(JSON.parse(native.content[0]!.text), templateService(request, { selection: f.selection }));
      assert.ok(!native.content[0]!.text.includes("SENTINEL"));
    }
    const exact = '{"action":"list"}'.padEnd(65536);
    assert.equal((await tool!.execute("synthetic-boundary", { request: exact }, undefined, undefined, undefined)).isError, false);
    for (const framing of [{ action: "list" }, { request: "{}", secret: "SENTINEL" }, { request: {} }]) {
      const result = await tool!.execute("synthetic-framing", framing, undefined, undefined, undefined);
      assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0]!.text).code, "TEMPLATE_FIELD"); assert.ok(!result.content[0]!.text.includes("SENTINEL"));
    }
  } finally { f.dispose(); }
});

test("actual registered native tool matches public PPA CLI for list/show/render/validate and errors", async () => {
  const f = templateFixture(); try {
    let tool: PiToolDefinition | undefined;
    createTemplateModule({ selection: f.selection })({ registerTool: (t) => { tool = t as PiToolDefinition; } });
    assert.equal(tool!.name, "pa_template");
    const bindings = { ticket: "FIX-1" };
    const candidate = templateService({ action: "render", id: "requirements", version: "1", bindings }, { selection: f.selection }).candidate;
    for (const action of ["list", "show", "render", "validate"]) {
      const body = action === "render" ? { bindings } : action === "validate" ? { bindings, candidate } : undefined;
      const request = { action, ...(action !== "list" ? { id: "requirements", version: "1" } : {}), ...body };
      for (let i = 0; i < 20; i++) {
        const output: string[] = [];
        const code = await runCoreCommand(["template", action, ...(action !== "list" ? ["requirements", "--version", "1"] : [])], { binaryName: "ppa", templateHost: { selection: f.selection, input: (async function* () { if (body) yield Buffer.from(JSON.stringify(body)); })() }, io: { stdout: (s) => output.push(s), stderr: (s) => assert.fail(s) } });
        const native = await tool!.execute("fixture", { request: JSON.stringify(request) }, undefined, undefined, undefined);
        assert.equal(code, 0); assert.equal(native.isError, false); assert.deepEqual(JSON.parse(native.content[0]!.text), JSON.parse(output[0]!));
      }
    }
    for (const request of [{ action: "unknown", secret: "SENTINEL" }, { action: "show", id: "no-such-id", version: "1" }, { action: "render", id: "requirements", version: "1", bindings: {} }]) {
      const result = await tool!.execute("fixture", { request: JSON.stringify(request) }, undefined, undefined, undefined); assert.equal(result.isError, true); assert.deepEqual(JSON.parse(result.content[0]!.text), templateService(request, { selection: f.selection })); assert.ok(!result.content[0]!.text.includes("SENTINEL"));
    }
  } finally { f.dispose(); }
});
