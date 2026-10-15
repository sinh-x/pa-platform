import assert from "node:assert/strict";
import fs, { closeSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { appendFeedback, exportFeedback, readJournal, type FeedbackBinding } from "../feedback.js";
import { ArtifactPolicyError } from "../policy.js";
import { privateDirectory, REVIEW_JOURNAL_BYTES } from "../runtime.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync("/tmp/pa-feedback-test-");
  const fd = privateDirectory(root);
  t.after(() => { closeSync(fd); rmSync(root, { recursive: true, force: true }); });
  const binding: FeedbackBinding = { sessionId: "a".repeat(48), identity: {
    sourceRef: "/tmp/synthetic-source.md", sourceSha256: "1".repeat(64), htmlSha256: "2".repeat(64),
    manifestSha256: "3".repeat(64), rendererVersion: "pa-artifact-renderer/v1", policyVersion: "pa-artifact-policy/v1",
  }, anchors: [{ id: "source-L1-L2", startLine: 1, endLine: 2 }] };
  const event = (id = "event-000000000001") => ({ schema: "pa-artifact-feedback/v1", eventId: id, sessionId: binding.sessionId,
    sourceRef: binding.identity.sourceRef, sourceSha256: binding.identity.sourceSha256, htmlSha256: binding.identity.htmlSha256,
    target: { type: "anchor", anchor: "source-L1-L2", startLine: 1, endLine: 2 }, selectedText: "Synthetic selection", feedbackText: "Untrusted quoted feedback" });
  return { root, fd, binding, event };
}
const policy = (error: unknown): boolean => error instanceof ArtifactPolicyError && error.diagnostic === "ARTIFACT_POLICY_REJECTED";
const conflict = (error: unknown): boolean => error instanceof ArtifactPolicyError && error.diagnostic === "ARTIFACT_OUTPUT_CONFLICT";

test("stable IDs/sequence/source/anchor targets survive fsynced acknowledgement, retries and reopen", t => {
  const f = fixture(t);
  const first = appendFeedback(f.fd, f.binding, [f.event()]);
  assert.equal(first[0]!.sequence, 1);
  assert.equal(first[0]!.sourceRef, f.binding.identity.sourceRef);
  assert.deepEqual(first[0]!.target, f.event().target);
  const journal = readFileSync(join(f.root, "journal.json"));
  assert.equal(lstatSync(join(f.root, "journal.json")).mode & 0o777, 0o600);
  assert.deepEqual(appendFeedback(f.fd, f.binding, [f.event()]), first);
  assert.deepEqual(readFileSync(join(f.root, "journal.json")), journal);
  const reopened = privateDirectory(f.root);
  try { assert.deepEqual(readJournal(reopened, f.binding), first); } finally { closeSync(reopened); }
  const second = { ...f.event("event-000000000002"), target: { type: "document" } };
  assert.equal(appendFeedback(f.fd, f.binding, [second])[0]!.sequence, 2);
  assert.deepEqual(readJournal(f.fd, f.binding).map(e => e.sequence), [1, 2]);
});

test("whole malformed/cross-source/conflicting-ID/unknown target batches reject atomically", t => {
  const f = fixture(t);
  appendFeedback(f.fd, f.binding, [f.event()]);
  const before = readFileSync(join(f.root, "journal.json"));
  const valid = f.event("event-000000000002");
  const invalid: unknown[] = [
    null, {}, { ...valid, sourceSha256: "9".repeat(64) }, { ...valid, htmlSha256: "9".repeat(64) },
    { ...valid, sourceRef: "/tmp/other-source.md" }, { ...valid, sessionId: "b".repeat(48) },
    { ...valid, target: { type: "anchor", anchor: "source-L1-L2", startLine: 2, endLine: 2 } },
    { ...valid, target: { type: "document", command: "approval" } }, { ...valid, sequence: 90 },
    { ...valid, feedbackText: "\ud800" }, { ...valid, selectedText: "\udfff" },
    // A surrogate cannot be completed by a different event field.
    { ...valid, feedbackText: "\ud800", selectedText: "\udfff" },
    { ...valid, feedbackText: " " }, { ...valid, attachments: [] },
    { ...f.event(), feedbackText: "Changed retry" },
  ];
  for (const bad of invalid) {
    assert.throws(() => appendFeedback(f.fd, f.binding, [valid, bad]), policy);
    assert.deepEqual(readFileSync(join(f.root, "journal.json")), before);
  }
  assert.throws(() => appendFeedback(f.fd, f.binding, []), policy);
});

test("inclusive UTF-8 feedback/selection limits refuse oversize without queue consumption", t => {
  const f = fixture(t);
  const exact = { ...f.event(), feedbackText: "é".repeat(32_768), selectedText: "é".repeat(8192) };
  assert.equal(Buffer.byteLength(exact.feedbackText), 65_536);
  assert.equal(Buffer.byteLength(exact.selectedText), 16_384);
  appendFeedback(f.fd, f.binding, [exact]);
  const before = readFileSync(join(f.root, "journal.json"));
  for (const event of [{ ...f.event("event-000000000002"), feedbackText: exact.feedbackText + "a" },
    { ...f.event("event-000000000002"), selectedText: exact.selectedText + "a" }]) {
    assert.throws(() => appendFeedback(f.fd, f.binding, [event]), policy);
    assert.deepEqual(readFileSync(join(f.root, "journal.json")), before);
  }
});

test("journal caps are 1024 events or 16777216 bytes, never discard acknowledged events", t => {
  const f = fixture(t);
  const events = Array.from({ length: 1024 }, (_, i) => f.event(`event-${String(i).padStart(16, "0")}`));
  appendFeedback(f.fd, f.binding, events);
  const full = readFileSync(join(f.root, "journal.json"));
  assert.throws(() => appendFeedback(f.fd, f.binding, [f.event("event-overflow-000001")]), policy);
  assert.deepEqual(readFileSync(join(f.root, "journal.json")), full);
  assert.equal(appendFeedback(f.fd, f.binding, [events[0]])[0]!.sequence, 1);
  const g = fixture(t);
  const large = Array.from({ length: 256 }, (_, i) => ({ ...g.event(`event-${String(i).padStart(16, "0")}`), feedbackText: "x".repeat(65_536) }));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > REVIEW_JOURNAL_BYTES);
  assert.throws(() => appendFeedback(g.fd, g.binding, large), policy);
  assert.equal(existsSync(join(g.root, "journal.json")), false);
});

test("journal fsync failure publishes no ACK; crash after durable write retries identically", t => {
  const f = fixture(t);
  const real = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error("synthetic fsync fault"); }; syncBuiltinESMExports();
    assert.throws(() => appendFeedback(f.fd, f.binding, [f.event()]), /synthetic fsync fault/);
    assert.equal(existsSync(join(f.root, "journal.json")), false);
  } finally { fs.fsyncSync = real; syncBuiltinESMExports(); }
  let beforeAck = false;
  assert.throws(() => appendFeedback(f.fd, f.binding, [f.event()], () => {
    beforeAck = true;
    assert.equal(readJournal(f.fd, f.binding).length, 1);
    throw new Error("synthetic ACK interruption");
  }), /synthetic ACK interruption/);
  assert.equal(beforeAck, true);
  assert.equal(appendFeedback(f.fd, f.binding, [f.event()])[0]!.sequence, 1);
  assert.equal(readJournal(f.fd, f.binding).length, 1);
  assert.deepEqual(readdirSync(f.root), ["journal.json"]);
});

test("exports are complete, private, atomic, byte-identical retry only and no-feedback creates no file", t => {
  const f = fixture(t);
  const output = join(f.root, "export.json");
  assert.equal(exportFeedback(f.fd, f.binding, output).status, "no-feedback");
  assert.equal(existsSync(output), false);
  appendFeedback(f.fd, f.binding, [f.event()]);
  assert.equal(exportFeedback(f.fd, f.binding, output).status, "exported");
  assert.equal(lstatSync(output).mode & 0o777, 0o600);
  const first = readFileSync(output);
  assert.equal(exportFeedback(f.fd, f.binding, output).status, "exported");
  assert.deepEqual(readFileSync(output), first);
  appendFeedback(f.fd, f.binding, [f.event("event-000000000002")]);
  assert.throws(() => exportFeedback(f.fd, f.binding, output), conflict);
  assert.deepEqual(readFileSync(output), first);
  const newer = join(f.root, "new-export.json");
  assert.equal(exportFeedback(f.fd, f.binding, newer).eventCount, 2);
  assert.equal((JSON.parse(readFileSync(newer, "utf8")) as { events: unknown[] }).events.length, 2);
});

test("export fsync/link interruption never overwrites or leaves a partial destination", t => {
  const f = fixture(t); appendFeedback(f.fd, f.binding, [f.event()]);
  const output = join(f.root, "export.json");
  const real = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error("synthetic export fsync fault"); }; syncBuiltinESMExports();
    assert.throws(() => exportFeedback(f.fd, f.binding, output), conflict);
    assert.equal(existsSync(output), false);
  } finally { fs.fsyncSync = real; syncBuiltinESMExports(); }
  const realLink = fs.linkSync;
  try {
    fs.linkSync = (source, destination) => { realLink(source, destination); throw new Error("synthetic post-publication fault"); }; syncBuiltinESMExports();
    assert.equal(exportFeedback(f.fd, f.binding, output).status, "exported");
  } finally { fs.linkSync = realLink; syncBuiltinESMExports(); }
  assert.equal((JSON.parse(readFileSync(output, "utf8")) as { events: unknown[] }).events.length, 1);
  assert.deepEqual(readdirSync(f.root).sort(), ["export.json", "journal.json"]);
});

test("symlink/conflicting destinations and corrupt journals are preserved, never repaired or emptied", t => {
  const f = fixture(t); appendFeedback(f.fd, f.binding, [f.event()]);
  const sibling = join(f.root, "sibling.txt"); writeFileSync(sibling, "sentinel");
  const output = join(f.root, "escape.json"); symlinkSync(sibling, output);
  assert.throws(() => exportFeedback(f.fd, f.binding, output), conflict);
  assert.equal(readFileSync(sibling, "utf8"), "sentinel");
  const journal = join(f.root, "journal.json"); writeFileSync(journal, "not json", { mode: 0o600 });
  assert.throws(() => appendFeedback(f.fd, f.binding, [f.event()]));
  assert.equal(readFileSync(journal, "utf8"), "not json");
});
