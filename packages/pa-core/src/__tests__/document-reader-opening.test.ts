import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryReaderOpeningJournal, openBoundDocumentReader, type ReaderOpeningHost, type ReaderOpeningObservation } from "../documents/reader-opening.js";
import { DocumentPackageError } from "../documents/package-contract.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

function fixture() {
  const f = documentRuntimeFixture(), journal = new RegistryReaderOpeningJournal(f.db);
  let launches = 0, reconciles = 0, available = true, verified = true, identity = "a".repeat(64), throwAfterLaunch = false;
  let observation: ReaderOpeningObservation = { state: "open-requested", cleanup: "owned-active", evidenceSha256: "d".repeat(64) };
  const host: ReaderOpeningHost = {
    serialize: run => run(), authenticate: () => ({ identitySha256: identity, selectionSha256: "b".repeat(64) }), available: () => available,
    verifyDelivery() { if (!verified) throw new DocumentPackageError("DOCUMENT_STALE"); },
    requestOpen(delivery, operation) { assert.match(delivery, /^[a-f0-9]{64}$/); assert.match(operation, /^[a-f0-9]{64}$/); launches++; if (throwAfterLaunch) throw Error("lost launch reply"); return observation; },
    reconcile() { reconciles++; return observation; },
  };
  return { ...f, journal, host, run: () => openBoundDocumentReader(journal, host, "c".repeat(64)), counts: () => ({ launches, reconciles }),
    unavailable: () => { available = false; }, available: () => { available = true; }, tamper: () => { verified = false; },
    foreign: () => { identity = "e".repeat(64); }, loseReply: () => { throwAfterLaunch = true; }, observe: (next: ReaderOpeningObservation) => { observation = next; } };
}

test("bound opening core requests once per original delivery, retains identity and never asserts viewing or approval", () => {
  const f = fixture();
  try {
    const first = f.run(), second = openBoundDocumentReader(new RegistryReaderOpeningJournal(f.db), f.host, "c".repeat(64));
    assert.deepEqual(second, first); assert.deepEqual(f.counts(), { launches: 1, reconciles: 1 });
    assert.equal(first.state, "open-requested"); assert.equal(first.observation, "not-performed"); assert.equal(first.approval, "not-issued");
    assert.equal(f.journal.records(first.operationId as string).length, 2);
  } finally { f.close(); }
});

test("bound opening core observes original active child settlement without launching again", () => {
  const f = fixture();
  try {
    const first = f.run();
    f.observe({ state: "open-requested", cleanup: "settled", evidenceSha256: "e".repeat(64) });
    const settled = f.run();
    assert.equal(settled.operationId, first.operationId); assert.equal(settled.cleanup, "settled");
    assert.deepEqual(f.run(), settled); assert.deepEqual(f.counts(), { launches: 1, reconciles: 1 });
  } finally { f.close(); }
});

test("bound opening core reconciles a lost launch reply without a duplicate browser request", () => {
  const f = fixture();
  try {
    f.loseReply(); assert.throws(() => f.run(), /lost launch reply/);
    const result = f.run(); assert.equal(result.state, "open-requested");
    assert.deepEqual(f.counts(), { launches: 1, reconciles: 1 });
  } finally { f.close(); }
});

test("bound opening core retains unknown child/cleanup and blocks another delivery rather than switching identity", () => {
  const f = fixture();
  try {
    f.observe({ state: "uncertain", cleanup: "unknown", evidenceSha256: "e".repeat(64) });
    assert.equal(f.run().state, "uncertain");
    assert.equal(f.run().state, "uncertain");
    assert.throws(() => openBoundDocumentReader(f.journal, f.host, "f".repeat(64)), (e: unknown) => e instanceof DocumentPackageError && e.code === "DOCUMENT_UNCERTAIN");
    assert.deepEqual(f.counts(), { launches: 1, reconciles: 1 });
  } finally { f.close(); }
});

test("a fresh caller cannot bypass another original delivery's uncertain or active child owner", () => {
  for (const result of [
    { state: "uncertain", cleanup: "unknown", evidenceSha256: "e".repeat(64) },
    { state: "open-requested", cleanup: "owned-active", evidenceSha256: "e".repeat(64) },
  ] as const) {
    const f = fixture();
    try {
      f.observe(result); f.run(); f.foreign();
      assert.throws(() => f.run(), (error: unknown) => error instanceof DocumentPackageError && error.code === "DOCUMENT_UNCERTAIN");
      assert.equal(f.counts().launches, 1);
    } finally { f.close(); }
  }
});

test("bound opening core distinguishes unavailable/failed/cancelled and resumes an unavailable original only after launcher availability", () => {
  for (const state of ["unavailable", "failed", "cancelled"] as const) {
    const f = fixture();
    try {
      if (state === "unavailable") f.unavailable();
      else f.observe({ state, cleanup: "settled", evidenceSha256: "e".repeat(64) });
      const result = f.run(); assert.equal(result.state, state); assert.equal(f.run().state, state);
      assert.equal(f.counts().launches, state === "unavailable" ? 0 : 1);
      if (state === "unavailable") { f.available(); const opened = f.run(); assert.equal(opened.state, "open-requested"); assert.equal(opened.operationId, result.operationId); assert.equal(f.counts().launches, 1); }
    } finally { f.close(); }
  }
});

test("bound opening core rejects path/URL/program substitutes and tampered delivery before launching", () => {
  const f = fixture();
  try {
    for (const value of ["file:///tmp/index.html", "https://example.invalid", "/tmp/index.html", "chromium", "C".repeat(64)]) assert.throws(() => openBoundDocumentReader(f.journal, f.host, value));
    f.tamper(); assert.throws(() => f.run()); assert.deepEqual(f.counts(), { launches: 0, reconciles: 0 });
  } finally { f.close(); }
});
