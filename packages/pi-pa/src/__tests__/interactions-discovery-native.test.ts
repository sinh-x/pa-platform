import assert from "node:assert/strict";
import { test } from "node:test";
import { createPaCapabilitiesTool } from "../pi-extension/capability-tool.js";

const request = JSON.stringify({ schemaVersion: "pa-interactions/v1", action: "list", family: "ticket", limit: 2 });
const call = (tool: ReturnType<typeof createPaCapabilitiesTool>, input: Record<string, unknown>) => tool.execute("fixture-call", input, undefined, undefined, {});

test("native source discovery preserves bounded continuation and never advertises installed support", async () => {
  const tool = createPaCapabilitiesTool(() => true);
  assert.equal(tool.name, "pa_capabilities");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.match(tool.description, /source-only/);
  assert.match(tool.description, /not permission/);
  const result = await call(tool, { request });
  assert.equal(result.isError, false);
  const page = JSON.parse(result.content[0]!.text);
  assert.equal(page.scope, "source-only");
  assert.equal(page.availability.installed, "unproven");
  assert.ok(page.page.nextCursor);
  const second = await call(tool, { request: JSON.stringify({ schemaVersion: "pa-interactions/v1", action: "list", family: "ticket", limit: 2, cursor: page.page.nextCursor }) });
  assert.equal(second.isError, false);
  assert.equal(JSON.parse(second.content[0]!.text).page.offset, 2);
  assert.ok(Buffer.byteLength(result.content[0]!.text) <= 51200);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["request"]);
});

test("new port requires its current native owner check on every call and fails closed", async () => {
  let current = true;
  let checks = 0;
  const tool = createPaCapabilitiesTool(() => { checks++; return current; });
  assert.equal((await call(tool, { request })).isError, false);
  current = false;
  const denied = await call(tool, { request });
  assert.equal(denied.isError, true);
  assert.equal(denied.details.code, "INTERACTION_SESSION");
  assert.equal(checks, 2);
  assert.equal((await call(createPaCapabilitiesTool(), { request })).isError, true);
  const thrown = await call(createPaCapabilitiesTool(() => { throw new Error("SYNTHETIC_SECRET"); }), { request });
  assert.equal(thrown.isError, true);
  assert.ok(!thrown.content[0]!.text.includes("SYNTHETIC_SECRET"));
});

test("native framing rejects structured/unknown/duplicate/authority fields without echo or effects", async () => {
  const tool = createPaCapabilitiesTool(() => true);
  for (const input of [
    { action: "list" }, { request, actor: "sinh" }, { request, root: "/other" }, { request: {} },
    { request: '{"schemaVersion":"pa-interactions/v1","action":"list","action":"describe"}' },
    { request: JSON.stringify({ schemaVersion: "pa-interactions/v1", action: "list", approval: "SYNTHETIC_SECRET" }) },
    { request: " ".repeat(65537) },
  ]) {
    const result = await call(tool, input);
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.length <= 2000);
    assert.ok(!result.content[0]!.text.includes("SYNTHETIC_SECRET"));
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(result.content[0]!.text.split(`${label}:`).length - 1, 1);
  }
});
