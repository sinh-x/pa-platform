import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DocumentPackageError, parseDocumentPackage } from "../documents/package-contract.js";
import { renderDocumentReader, type DocumentReaderBundle } from "../documents/reader.js";
import { inspectFullDocumentReader, presentFullDocumentReader } from "../documents/reader-publication.js";
import { renderDocumentReaderInWorker, renderHistoricalDocumentReaderInWorker, documentReaderWorkerStatus } from "../documents/reader-worker-owner.js";
import { digest } from "../workflows/contracts.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

// Captured from the P0 compiled worker BEFORE any P4 source/build change. The
// fixed subject/raw/manifest/output digests are independent of the new renderer.
const frozen: { subject: unknown; sources: Record<string, string>; deliverySha256: string; manifestSha256: string; manifest: DocumentReaderBundle["manifest"] } =
  JSON.parse(readFileSync(new URL("./document-reader-v1-fixture.json", import.meta.url), "utf8"));
function fixture() {
  const subject = parseDocumentPackage(frozen.subject);
  const snapshot = (sha: string) => {
    const value: unknown = Reflect.get(frozen.sources, sha);
    assert.ok(typeof value === "string");
    return Buffer.from(value, "base64");
  };
  return { subject, snapshot };
}
const failure = (error: unknown) => error instanceof DocumentPackageError;

function checkPlanned(html: string, roles: string[]) {
  const sections = [...html.matchAll(/<details class="member member-disclosure"( open)?><summary id="member-([0-9]+)-title">(.*?)<\/summary><article class="member-body" id="member-\2"[^>]*>(.*?)<\/article><\/details>/gs)];
  assert.equal(sections.length, roles.length, "one full independent disclosure per required member");
  assert.deepEqual(sections.map(section => Number(section[2])), roles.map((_, index) => index + 1));
  assert.deepEqual(sections.map(section => Boolean(section[1])), roles.map(role => role === "brief"));
  assert.doesNotMatch(html, /<details[^>]*\bname=|\bhidden=|aria-expanded=|id="executive-summary"/, "native state, no exclusive accordion or duplicate brief");
  assert.match(html, /details::details-content\{display:block;content-visibility:visible\}/, "print overrides native closed-content visibility");
  assert.match(html, /summary:focus-visible/);
  assert.doesNotMatch(html, /<(?:script|form|input|button|iframe|link)\b|<[^>]*\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:|\/\/|data:|javascript:)|@import|url\(/i);
  for (const [index, section] of sections.entries()) {
    assert.ok(section[4]!.includes(`href="raw/member-${index + 1}.md"`));
    assert.ok(section[4]!.includes(`href="members/member-${index + 1}.html"`));
  }
}

test("P4 ordered complete collapsibles open only the role-selected brief, including non-first brief", async () => {
  const f = fixture();
  for (const members of [f.subject.members, [...f.subject.members.slice(1), f.subject.members[0]!]]) {
    const subject = { ...f.subject, members }, bundle = renderDocumentReader(subject, f.snapshot);
    assert.equal(bundle.manifest.renderer.id, "pa-document-reader/v2");
    checkPlanned(bundle.files.get("index.html")!.toString(), members.map(member => member.role));
    for (const member of bundle.manifest.members) {
      assert.deepEqual(bundle.files.get(member.raw), f.snapshot(member.sha256));
      assert.doesNotMatch(bundle.files.get(member.companion)!.toString(), /class="member member-disclosure"/);
    }
  }
  const worker = await renderDocumentReaderInWorker(f.subject, f.snapshot);
  checkPlanned(worker.files.get("index.html")!.toString(), f.subject.members.map(member => member.role));
});

test("P4 retained v1 derivation reproduces every pre-P4 compiled output byte digest and manifest identity", () => {
  const f = fixture(), old = renderDocumentReader(f.subject, f.snapshot, frozen.manifest.renderer);
  assert.equal(old.deliverySha256, frozen.deliverySha256);
  assert.equal(old.manifestSha256, frozen.manifestSha256);
  assert.deepEqual(old.manifest, frozen.manifest);
  for (const output of frozen.manifest.outputs) {
    assert.equal(digest(old.files.get(output.path)!), output.sha256, output.path);
    assert.equal(old.files.get(output.path)!.length, output.bytes, output.path);
  }
  assert.notEqual(renderDocumentReader(f.subject, f.snapshot).deliverySha256, old.deliverySha256);
});

test("P4 bound historical inspection reproduces v1 without upgrading or rewriting it; missing/tampered outputs fail closed", async () => {
  const f = fixture(), runtime = documentRuntimeFixture();
  try {
    const old = renderDocumentReader(f.subject, f.snapshot, frozen.manifest.renderer);
    assert.equal(old.deliverySha256, frozen.deliverySha256);
    const folder = join(runtime.root, "agent-teams/requirements/artifacts/presentations", old.manifest.subjectSha256, old.deliverySha256);
    for (const [path, bytes] of old.files) { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), bytes); }
    const results = join(runtime.root, "agent-teams/requirements/artifacts/presentation-results", old.manifest.subjectSha256);
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, `${old.deliverySha256}.json`), JSON.stringify({ schemaVersion: "pa-document-reader-publication/v1", deliverySha256: old.deliverySha256, manifestSha256: old.manifestSha256 }));
    const original = readFileSync(join(folder, "index.html"));
    const maximumBytes = [...old.files.values()].reduce((total, bytes) => total + bytes.length, 0);
    const currentBytes = [...renderDocumentReader(f.subject, f.snapshot).files.values()].reduce((total, bytes) => total + bytes.length, 0);
    assert.ok(currentBytes > maximumBytes, "control: this fixture's new stylesheet makes current delivery larger than v1");
    const inspected = await inspectFullDocumentReader(f.subject, runtime.root, f.snapshot, old.deliverySha256, { outputBytes: maximumBytes });
    assert.deepEqual(inspected.renderer, frozen.manifest.renderer);
    assert.equal(inspected.deliverySha256, frozen.deliverySha256);
    const current = await presentFullDocumentReader(f.subject, runtime.root, f.snapshot);
    assert.notEqual(current.deliverySha256, old.deliverySha256);
    assert.deepEqual(readFileSync(join(folder, "index.html")), original);
    assert.equal((await inspectFullDocumentReader(f.subject, runtime.root, f.snapshot, old.deliverySha256)).entry, inspected.entry);
    const manifestPath = join(folder, "manifest.json"), manifestBytes = readFileSync(manifestPath);
    for (const bytes of [Buffer.from("not JSON"), Buffer.from(JSON.stringify({ ...old.manifest, renderer: { ...old.manifest.renderer, path: "/tmp/foreign.js" } })), Buffer.from(JSON.stringify({ ...old.manifest, renderer: { ...old.manifest.renderer, id: "pa-document-reader/v0" } }))]) {
      writeFileSync(manifestPath, bytes);
      await assert.rejects(() => inspectFullDocumentReader(f.subject, runtime.root, f.snapshot, old.deliverySha256), failure);
      assert.deepEqual(readFileSync(manifestPath), bytes);
    }
    writeFileSync(manifestPath, manifestBytes);
    const record = join(results, `${old.deliverySha256}.json`), recordBytes = readFileSync(record);
    unlinkSync(record);
    await assert.rejects(() => inspectFullDocumentReader(f.subject, runtime.root, f.snapshot, old.deliverySha256));
    writeFileSync(record, recordBytes);
    const raw = join(folder, old.manifest.members[0]!.raw), rawBytes = readFileSync(raw);
    writeFileSync(raw, "tampered raw");
    await assert.rejects(() => inspectFullDocumentReader(f.subject, runtime.root, f.snapshot, old.deliverySha256), failure);
    writeFileSync(raw, rawBytes);
    writeFileSync(join(folder, "members/member-3.html"), "tampered");
    await assert.rejects(() => inspectFullDocumentReader(f.subject, runtime.root, f.snapshot, old.deliverySha256), failure);
    assert.equal(readFileSync(join(folder, "members/member-3.html"), "utf8"), "tampered");
    assert.notEqual(fileURLToPath(String(current.entry)), join(folder, "index.html"));
  } finally { runtime.close(); }
});

test("P4 historical derivation uses the real bounded worker and settles before exposing bytes", async () => {
  const f = fixture(), bundle = await renderHistoricalDocumentReaderInWorker(f.subject, f.snapshot, frozen.manifest.renderer);
  assert.equal(bundle.manifestSha256, frozen.manifestSha256);
  assert.equal(bundle.deliverySha256, frozen.deliverySha256);
  assert.deepEqual(documentReaderWorkerStatus(), { active: 0, uncertain: 0 });
  await assert.rejects(() => renderHistoricalDocumentReaderInWorker(f.subject, f.snapshot, frozen.manifest.renderer, { outputBytes: 1 }), failure);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => renderHistoricalDocumentReaderInWorker(f.subject, f.snapshot, frozen.manifest.renderer, { signal: controller.signal }), failure);
  assert.deepEqual(documentReaderWorkerStatus(), { active: 0, uncertain: 0 });
});

test("P4 unknown historical renderer versions, injected renderer fields and invalid identities cannot select a compatibility path", () => {
  const f = fixture();
  for (const renderer of [
    { id: "pa-document-reader/v0", implementationSha256: "0".repeat(64) },
    { id: "pa-document-reader/v1", implementationSha256: "bad" },
    { ...frozen.manifest.renderer, path: "/tmp/untrusted-renderer.js" },
  ]) assert.throws(() => renderDocumentReader(f.subject, f.snapshot, renderer), failure);
});
