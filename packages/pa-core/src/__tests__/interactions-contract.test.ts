import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INTERACTIONS_VERSION, MAX_INTERACTION_REQUEST_BYTES, InteractionInputError,
  parseCapabilityRequest, capabilityRequestSchema,
} from "../interactions/contract.js";

const parse = (input: unknown) => parseCapabilityRequest(JSON.stringify(input));
const version = { schemaVersion: "pa-interactions/v1" };

test("discovery has a strict discriminated request and no execution channel", () => {
  assert.equal(INTERACTIONS_VERSION, version.schemaVersion);
  assert.deepEqual(parse({ ...version, action: "list" }), { ...version, action: "list", limit: 20 });
  assert.deepEqual(parse({ ...version, action: "describe", operationId: "ticket.create" }), {
    ...version, action: "describe", operationId: "ticket.create",
  });
  assert.deepEqual(parse({ ...version, action: "list", family: "ticket", effect: "write", limit: 1 }), {
    ...version, action: "list", family: "ticket", effect: "write", limit: 1,
  });
  for (const field of ["actor", "approval", "root", "environment", "command", "argv", "outcome", "installed", "role", "nativeBinding", "__proto__"]) {
    assert.throws(() => parse({ ...version, action: "list", [field]: "untrusted" }), InteractionInputError);
  }
  for (const input of [
    {}, [], null, { action: "list" }, { ...version, action: "execute" },
    { ...version, action: "list", operationId: "ticket.create" },
    { ...version, action: "describe", operationId: "ticket.create", limit: 2 },
    { ...version, action: "describe", operationId: "../secret" },
    { ...version, action: "list", family: "ticket\nCondition: injected" },
    { ...version, action: "list", effect: "admin" },
    { ...version, action: "list", limit: 0 }, { ...version, action: "list", limit: 101 },
    { ...version, action: "list", limit: 1.5 }, { ...version, action: "list", limit: "1" },
    { ...version, action: "list", family: null }, { ...version, action: "list", cursor: "" },
    { ...version, action: "list", family: "ticket\n" }, { ...version, action: "list", cursor: "abc\n" },
    { ...version, action: "describe", operationId: "ticket.create\n" },
  ]) assert.throws(() => parse(input), InteractionInputError);
});

test("raw input rejects duplicate decoded keys, invalid Unicode, BOM and excessive nesting", () => {
  for (const raw of [
    '{"schemaVersion":"pa-interactions/v1","action":"list","action":"describe"}',
    '{"schemaVersion":"pa-interactions/v1","action":"list","\\u0061ction":"list"}',
    '{"schemaVersion":"pa-interactions/v1","action":"list","family":"\\ud800"}',
    '\ufeff{"schemaVersion":"pa-interactions/v1","action":"list"}',
    '{"schemaVersion":"pa-interactions/v1","action":"list"} {}',
    '{"x":' + '['.repeat(66) + '0' + ']'.repeat(66) + '}',
    '\ud800',
  ]) assert.throws(() => parseCapabilityRequest(raw), InteractionInputError);
  assert.throws(() => parseCapabilityRequest(Uint8Array.from([123, 34, 0xff, 34, 58, 48, 125])), InteractionInputError);
});

test("request limit is UTF-8 bytes and exact boundary is accepted", () => {
  const raw = JSON.stringify({ ...version, action: "list" });
  assert.equal(parseCapabilityRequest(raw.padEnd(MAX_INTERACTION_REQUEST_BYTES)).action, "list");
  assert.throws(() => parseCapabilityRequest(raw.padEnd(MAX_INTERACTION_REQUEST_BYTES + 1)), { code: "INTERACTION_SIZE" });
  assert.throws(() => parseCapabilityRequest(JSON.stringify({ ...version, action: "list", family: "é".repeat(33_000) })), { code: "INTERACTION_SIZE" });
});

test("input errors expose bounded schema-owned guidance, never input or arbitrary exceptions", () => {
  const secret = "SYNTHETIC_SECRET_DO_NOT_ECHO\u001b[31m\nReason: forged";
  for (const raw of [JSON.stringify({ ...version, action: secret }), `{\"${secret}\":0}`, secret]) {
    try { parseCapabilityRequest(raw); assert.fail("accepted invalid input"); }
    catch (error) {
      assert.ok(error instanceof InteractionInputError);
      assert.ok(error.message.length <= 2000);
      assert.ok(!error.message.includes("SYNTHETIC_SECRET"));
      for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) {
        assert.equal(error.message.split(`${label}:`).length - 1, 1);
      }
      assert.match(error.message, /Impact: none/);
      assert.match(error.message, /Actor: agent/);
      assert.match(error.message, /New approval: not required/);
    }
  }
});

test("published JSON schema and parser agree on discriminator, fields, limits and enums", () => {
  assert.equal(capabilityRequestSchema.oneOf.length, 2);
  assert.ok(Object.isFrozen(capabilityRequestSchema));
  assert.ok(Object.isFrozen(capabilityRequestSchema.oneOf[0].properties));
  assert.ok(Object.isFrozen(capabilityRequestSchema.oneOf[0].properties.effect.enum));
  for (const schema of capabilityRequestSchema.oneOf) {
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.schemaVersion.const, INTERACTIONS_VERSION);
    assert.ok(schema.required.includes("action"));
    assert.ok(schema.required.includes("schemaVersion"));
  }
  const list = capabilityRequestSchema.oneOf[0];
  assert.equal(list.properties.limit.maximum, 100);
  assert.equal(list.properties.limit.minimum, 1);
  for (const effect of list.properties.effect.enum) assert.equal(parse({ ...version, action: "list", effect }).action, "list");
});
