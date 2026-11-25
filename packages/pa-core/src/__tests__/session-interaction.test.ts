import assert from "node:assert/strict";
import test from "node:test";
import { interactionCatalogue, validateInteractionCatalogue } from "../interactions/catalogue.js";

test("PAP-281 inventory is a finite PPA read, never lifecycle or native session control", () => {
  const row = interactionCatalogue.find(row => row.operationId === "sessions.list")!;
  assert.equal(row.effectClass, "read");
  assert.deepEqual(row.channels, ["cli"]);
  assert.equal(row.nativeBinding, null); assert.equal(row.delegationBinding, null);
  for (const flag of ["--all", "--json", "--deployment", "--ticket", "--repo", "--help"]) assert.ok(row.cliForms.includes(`sessions ${flag}`));
  assert.ok(!row.cliForms.some(form => /start|stop|attach|focus|remote/.test(form)));
  assert.match(row.reason, /no activity inference, lifecycle reconciliation, session control or native port/);
});
test("PAP-286 listener start is a resource effect, separate from help and inventory reads", () => {
  const row = interactionCatalogue.find(row => row.operationId === "sessions.dashboard")!;
  assert.equal(row.effectClass, "resource"); assert.equal(row.targetDisposition, "operator-only");
  assert.equal(row.nativeBinding, null); assert.equal(row.delegationBinding, null); assert.deepEqual(row.nativeForms, []);
  assert.match(row.reason, /no separate user authentication/);
  assert.equal(interactionCatalogue.find(row => row.operationId === "sessions.dashboard-help")!.effectClass, "read");
  assert.ok(validateInteractionCatalogue(interactionCatalogue.map(entry => entry.operationId === row.operationId ? { ...entry, effectClass: "read" } : entry)).includes("effect-regression"));
  assert.ok(validateInteractionCatalogue(interactionCatalogue.map(entry => entry.operationId === row.operationId ? { ...entry, targetDisposition: "native-supported" } : entry)).includes("operator-boundary"));
});
