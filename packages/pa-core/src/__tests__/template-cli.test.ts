import assert from "node:assert/strict";
import test from "node:test";
import { runCoreCommand } from "../cli/core-command.js";
import { templateService } from "../templates/service.js";
import { templateFixture } from "./template-fixture.js";
export async function cliTemplate(argv: string[], selection: ReturnType<typeof templateFixture>["selection"], body?: string) {
  const output: string[] = []; const errors: string[] = [];
  const status = await runCoreCommand(["template", ...argv], { binaryName: "ppa", templateHost: { selection, input: (async function* () { if (body) yield Buffer.from(body); })() }, io: { stdout: (s) => output.push(s), stderr: (s) => errors.push(s) } });
  return { status, output, errors };
}
test("public PPA dispatcher matches shared service for all operations twenty times", async () => {
  const f = templateFixture(); try {
    const bindings = { ticket: "FIX-1" }; const rendered = templateService({ action: "render", id: "requirements", version: "1", bindings }, { selection: f.selection });
    for (const action of ["list", "show", "render", "validate"]) {
      const body = action === "render" ? { bindings } : action === "validate" ? { bindings, candidate: rendered.candidate } : undefined;
      const request = { action, ...(action !== "list" ? { id: "requirements", version: "1" } : {}), ...body };
      for (let i = 0; i < 20; i++) {
        const r = await cliTemplate([action, ...(action !== "list" ? ["requirements", "--version", "1"] : []), "--format", "json"], f.selection, body ? JSON.stringify(body) : undefined);
        assert.equal(r.status, 0); assert.deepEqual(r.errors, []); assert.deepEqual(JSON.parse(r.output[0]!), JSON.parse(JSON.stringify(templateService(request, { selection: f.selection }))));
      }
    }
  } finally { f.dispose(); }
});
test("CLI rejects duplicate/foreign options, strict stdin duplicates and oversized input", async () => {
  const f = templateFixture(); try {
    for (const args of [["show", "requirements", "--version", "1", "--version", "1"], ["list", "--output", "SENTINEL"], ["list", "--format", "SENTINEL"]]) {
      const r = await cliTemplate(args, f.selection); assert.equal(r.status, 1); assert.ok(!r.output.join().includes("SENTINEL"));
    }
    for (const body of ['{"bindings":{"ticket":"FIX-1","\\u0074icket":"FIX-2"}}', ' '.repeat(65537)]) assert.equal((await cliTemplate(["render", "requirements", "--version", "1"], f.selection, body)).status, 1);
  } finally { f.dispose(); }
});
