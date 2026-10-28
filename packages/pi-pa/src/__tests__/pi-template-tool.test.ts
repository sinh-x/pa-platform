import assert from "node:assert/strict";
import test from "node:test";
import { templateService } from "@pa-platform/pa-core";
import { templateFixture } from "../../../pa-core/src/__tests__/template-fixture.js";
import { runCoreCommand } from "../../../pa-core/src/cli/core-command.js";
import { createTemplateModule } from "../pi-extension/template-tool.js";
import type { PiToolDefinition } from "../pi-extension/index.js";

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
        const native = await tool!.execute("fixture", request, undefined, undefined, undefined);
        assert.equal(code, 0); assert.equal(native.isError, false); assert.deepEqual(JSON.parse(native.content[0]!.text), JSON.parse(output[0]!));
      }
    }
    for (const request of [{ action: "unknown", secret: "SENTINEL" }, { action: "show", id: "no-such-id", version: "1" }, { action: "render", id: "requirements", version: "1", bindings: {} }]) {
      const result = await tool!.execute("fixture", request, undefined, undefined, undefined); assert.equal(result.isError, true); assert.deepEqual(JSON.parse(result.content[0]!.text), templateService(request, { selection: f.selection })); assert.ok(!result.content[0]!.text.includes("SENTINEL"));
    }
  } finally { f.dispose(); }
});
