import assert from "node:assert/strict";
import { test } from "node:test";
import { createSourceCatalogueReader, InteractionDiscoveryError } from "../interactions/discovery.js";
import { interactionCatalogue } from "../interactions/catalogue.js";
import { INTERACTIONS_VERSION, MAX_INTERACTION_PAGE_BYTES } from "../interactions/contract.js";

const list = (extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: INTERACTIONS_VERSION, action: "list", ...extra });

test("source discovery traverses all records without omission, duplicates or availability promotion", () => {
  const reader = createSourceCatalogueReader();
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const raw = reader(list({ limit: 7, ...(cursor ? { cursor } : {}) }));
    assert.ok(Buffer.byteLength(raw) <= MAX_INTERACTION_PAGE_BYTES);
    assert.ok(raw.split("\n").length <= 2000);
    const page = JSON.parse(raw);
    assert.equal(page.scope, "source-only");
    assert.equal(page.availability.installed, "unproven");
    assert.equal(page.availability.registeredInSession, "unproven");
    assert.equal(page.availability.admitted, "not-checked");
    assert.equal(page.page.complete, page.page.nextCursor === null);
    assert.equal(page.page.offset, ids.length);
    assert.equal(page.page.total, interactionCatalogue.length);
    ids.push(...page.operations.map((row: { operationId: string }) => row.operationId));
    cursor = page.page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, interactionCatalogue.map(row => row.operationId).sort());
  assert.equal(new Set(ids).size, ids.length);
});

test("family/effect filters and description are observational with stable view identity", () => {
  const reader = createSourceCatalogueReader();
  const page = JSON.parse(reader(list({ family: "health", effect: "write" })));
  assert.deepEqual(page.operations.map((row: { operationId: string }) => row.operationId), ["health.save"]);
  assert.equal(page.page.complete, true);
  const described = JSON.parse(reader(JSON.stringify({ schemaVersion: INTERACTIONS_VERSION, action: "describe", operationId: "health.save" })));
  assert.equal(described.operation.operationId, "health.save");
  assert.equal(described.viewVersion, page.viewVersion);
  assert.equal(described.availability.available, "unproven");
  assert.equal(described.operation.nativeBinding, null);
  assert.deepEqual(JSON.parse(reader(list({ family: "unknown" }))).operations, []);
  assert.throws(() => reader(JSON.stringify({ schemaVersion: INTERACTIONS_VERSION, action: "describe", operationId: "unknown" })), { code: "INTERACTION_NOT_FOUND" });
});

test("cursors are issuer/view/query-bound, reject tampering, and allow unchanged read replay", () => {
  const reader = createSourceCatalogueReader();
  const first = JSON.parse(reader(list({ limit: 1 })));
  const cursor = first.page.nextCursor as string;
  assert.ok(cursor);
  const request = list({ limit: 1, cursor });
  assert.equal(reader(request), reader(request));
  for (const other of [
    list({ limit: 2, cursor }), list({ limit: 1, family: "ticket", cursor }),
    list({ limit: 1, effect: "write", cursor }), list({ limit: 1, cursor: cursor.slice(1) }),
    list({ limit: 1, cursor: "A".repeat(2048) }),
  ]) assert.throws(() => reader(other), { code: "INTERACTION_CURSOR" });
  assert.throws(() => createSourceCatalogueReader()(request), { code: "INTERACTION_CURSOR" });
});

test("byte-bound pages continue before omission and cannot return an oversized single record", () => {
  // Trusted fixture constructor, never a caller-controlled catalogue or runtime identity.
  const enlarged = interactionCatalogue.map(row => ({ ...row, reason: "é".repeat(10_000) }));
  const reader = createSourceCatalogueReader(enlarged);
  const raw = reader(list({ limit: 100 }));
  assert.ok(Buffer.byteLength(raw) <= MAX_INTERACTION_PAGE_BYTES);
  const page = JSON.parse(raw);
  assert.ok(page.operations.length > 0 && page.operations.length < 100);
  assert.equal(page.page.complete, false);
  const next = JSON.parse(reader(list({ limit: 100, cursor: page.page.nextCursor })));
  assert.equal(next.page.offset, page.operations.length);
  assert.throws(() => createSourceCatalogueReader(interactionCatalogue.map(row => ({ ...row, reason: "x".repeat(60_000) })))(list()), { code: "INTERACTION_OUTPUT_LIMIT" });
});

test("reader owns an immutable snapshot and errors cannot leak caller strings", () => {
  const mutable = interactionCatalogue.map(row => ({ ...row }));
  const reader = createSourceCatalogueReader(mutable);
  const before = reader(list());
  mutable[0]!.reason = "changed after construction";
  assert.equal(reader(list()), before);
  assert.throws(() => createSourceCatalogueReader([]), { code: "INTERACTION_CATALOGUE" });
  const error = new InteractionDiscoveryError("INTERACTION_CURSOR");
  assert.ok(error.message.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(error.message.split(`${label}:`).length - 1, 1);
});
