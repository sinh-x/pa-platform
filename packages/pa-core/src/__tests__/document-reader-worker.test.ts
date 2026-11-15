import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inspectFullDocumentReader, presentFullDocumentReader } from "../documents/reader-publication.js";
import { DocumentPackageError } from "../documents/package-contract.js";
import { DOCUMENT_READER_LIMITS } from "../documents/reader.js";
import { documentReaderWorkerStatus, renderDocumentReaderInWorker } from "../documents/reader-worker-owner.js";
import { digest } from "../workflows/contracts.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

function fixture() {
  const f = documentRuntimeFixture();
  const sources = new Map(f.subject.members.map(member => [member.sha256, readFileSync(join(f.root, member.source))]));
  const snapshot = (sha: string) => { const bytes = sources.get(sha); if (!bytes) throw new DocumentPackageError("DOCUMENT_SOURCE"); return bytes; };
  return { ...f, sources, snapshot };
}
const unavailable = (error: unknown) => error instanceof DocumentPackageError && error.code === "DOCUMENT_UNAVAILABLE";
const stopped = () => assert.deepEqual(documentReaderWorkerStatus(), { active: 0, uncertain: 0 });

test("fixed native worker exits before exposing a complete reproducible validated bundle", async () => {
  const f = fixture();
  try {
    const first = await renderDocumentReaderInWorker(f.subject, f.snapshot); stopped();
    const second = await renderDocumentReaderInWorker(f.subject, f.snapshot); stopped();
    assert.deepEqual(first, second);
    assert.equal(first.manifest.members.length, f.subject.members.length);
    assert.equal(first.files.size, f.subject.members.length * 2 + 2);
    for (const output of first.manifest.outputs) assert.equal(digest(first.files.get(output.path)!), output.sha256);
  } finally { f.close(); }
});

test("real wall deadline terminates the actual worker and publishes no intent, entry or result", async () => {
  const f = fixture(); let spawned = 0;
  const hook = createHook({ init(_id, type) { if (type === "WORKER") spawned++; } });
  try {
    // Warm parent admission/hashing, not the isolated worker's parser/imports.
    await renderDocumentReaderInWorker(f.subject, f.snapshot); stopped();
    hook.enable();
    await assert.rejects(() => presentFullDocumentReader(f.subject, f.root, f.snapshot, { milliseconds: 1 }), unavailable);
    assert.equal(spawned, 1, "timeout must exercise a real worker, not only pre-admission rejection");
    stopped();
    assert.equal(existsSync(join(f.root, "agent-teams/requirements/artifacts/presentations")), false);
    assert.equal(existsSync(join(f.root, "agent-teams/requirements/artifacts/presentation-results")), false);
    // Successful retry is a fresh computation only after the prior exit.
    assert.ok((await renderDocumentReaderInWorker(f.subject, f.snapshot)).files.has("index.html")); stopped();
  } finally { hook.disable(); f.close(); }
});

test("cancellation terminates a live worker before returning and does not advertise delivery", async () => {
  const f = fixture(), controller = new AbortController(); let spawned = 0;
  const hook = createHook({ init(_id, type) { if (type === "WORKER") { spawned++; setImmediate(() => controller.abort()); } } });
  try {
    hook.enable();
    await assert.rejects(() => presentFullDocumentReader(f.subject, f.root, f.snapshot, { signal: controller.signal }), unavailable);
    assert.equal(spawned, 1); stopped();
    assert.equal(existsSync(join(f.root, "agent-teams/requirements/artifacts/presentation-results")), false);
  } finally { hook.disable(); f.close(); }
});

test("trusted controls cannot increase finite ceilings; pre-abort launches no worker", async () => {
  const f = fixture(), controller = new AbortController(); let spawned = 0;
  const hook = createHook({ init(_id, type) { if (type === "WORKER") spawned++; } });
  try {
    hook.enable();
    for (const control of [{ milliseconds: 30_001 }, { milliseconds: 0 }, { milliseconds: NaN }, { outputBytes: DOCUMENT_READER_LIMITS.outputBytes + 1 }, { outputBytes: -1 }]) {
      await assert.rejects(() => renderDocumentReaderInWorker(f.subject, f.snapshot, control), (error: unknown) => error instanceof DocumentPackageError && error.code === "DOCUMENT_INPUT");
    }
    controller.abort();
    await assert.rejects(() => renderDocumentReaderInWorker(f.subject, f.snapshot, { signal: controller.signal }), unavailable);
    assert.equal(spawned, 0); stopped();
  } finally { hook.disable(); f.close(); }
});

test("output ceiling rejects the entire worker bundle before any filesystem publication", async () => {
  const f = fixture();
  try {
    await assert.rejects(() => presentFullDocumentReader(f.subject, f.root, f.snapshot, { outputBytes: 1 }), unavailable); stopped();
    assert.equal(existsSync(join(f.root, "agent-teams/requirements/artifacts/presentations")), false);
  } finally { f.close(); }
});

test("bound inspection never creates, repairs, accepts another delivery or skips the completion record", async () => {
  const f = fixture();
  try {
    const bundle = await renderDocumentReaderInWorker(f.subject, f.snapshot);
    await assert.rejects(() => inspectFullDocumentReader(f.subject, f.root, f.snapshot, bundle.deliverySha256));
    assert.equal(existsSync(join(f.root, "agent-teams/requirements/artifacts/presentations")), false);
    const published = await presentFullDocumentReader(f.subject, f.root, f.snapshot);
    await assert.rejects(() => inspectFullDocumentReader(f.subject, f.root, f.snapshot, "0".repeat(64)), (error: unknown) => error instanceof DocumentPackageError && error.code === "DOCUMENT_STALE");
    const record = join(f.root, "agent-teams/requirements/artifacts/presentation-results", bundle.manifest.subjectSha256, `${bundle.deliverySha256}.json`);
    unlinkSync(record);
    await assert.rejects(() => inspectFullDocumentReader(f.subject, f.root, f.snapshot, published.deliverySha256 as string));
    assert.equal(existsSync(record), false); stopped();
  } finally { f.close(); }
});

test("bounded worker handles complete near-ceiling input with maximum member count without truncation", async () => {
  const f = fixture();
  try {
    const bytes = Buffer.from("ordinary ".repeat(31_000)), hash = digest(bytes); f.sources.set(hash, bytes);
    while (f.subject.members.length < 64) {
      const i = f.subject.members.length;
      f.subject.members.push({ id: `spec-${i}`, role: "specification", mediaType: "text/markdown", source: `agent-teams/requirements/artifacts/reviews/EX-1/r001/spec-${i}.md`, description: `Complete member ${i}`, bytes: bytes.length, sha256: hash });
    }
    const inputBytes = f.subject.members.reduce((total, member) => total + member.bytes, 0);
    assert.ok(inputBytes > 15 * 1024 * 1024 && inputBytes <= 16 * 1024 * 1024);
    const started = performance.now(), bundle = await renderDocumentReaderInWorker(f.subject, f.snapshot); stopped();
    assert.equal(bundle.manifest.members.length, 64); assert.equal(bundle.files.size, 130);
    assert.deepEqual(bundle.files.get("raw/member-64.md"), bytes);
    assert.ok(performance.now() - started < DOCUMENT_READER_LIMITS.milliseconds);
    assert.ok([...bundle.files.values()].reduce((total, bytes) => total + bytes.length, 0) < DOCUMENT_READER_LIMITS.outputBytes);
  } finally { f.close(); }
});
