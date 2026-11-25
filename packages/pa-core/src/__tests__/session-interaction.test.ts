import assert from "node:assert/strict";
import test from "node:test";
import { interactionCatalogue } from "../interactions/catalogue.js";

test("PAP-281 inventory is a finite PPA read, never lifecycle or native session control", () => {
  const row = interactionCatalogue.find(row => row.operationId === "sessions.list")!;
  assert.equal(row.effectClass, "read");
  assert.deepEqual(row.channels, ["cli"]);
  assert.equal(row.nativeBinding, null); assert.equal(row.delegationBinding, null);
  for (const flag of ["--all", "--json", "--deployment", "--ticket", "--repo", "--help"]) assert.ok(row.cliForms.includes(`sessions ${flag}`));
  assert.ok(!row.cliForms.some(form => /start|stop|attach|focus|remote/.test(form)));
  assert.match(row.reason, /no activity inference, lifecycle reconciliation, session control or native port/);
});
