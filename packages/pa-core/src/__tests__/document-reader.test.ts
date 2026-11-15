import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPackageMarkdown, renderMarkdown } from "../artifacts/render.js";
import { DOCUMENT_READER_VERSION, renderDocumentReader } from "../documents/reader.js";
import { inspectFullDocumentReader, presentFullDocumentReader } from "../documents/reader-publication.js";
import { renderDocumentReaderInWorker } from "../documents/reader-worker-owner.js";
import { digest } from "../workflows/contracts.js";
import { DocumentPackageError } from "../documents/package-contract.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

function fixture() {
  const f = documentRuntimeFixture(), sources = new Map<string, Buffer>();
  const markdown = "# Repeated heading\n\nComplete paragraph with **strong** and *emphasis*.\n\n## Nested heading\n\n- first\n  - nested\n\n| Item | Value |\n| --- | --- |\n| full | table |\n\n```text\ncomplete code\n```\n\n# Repeated heading\n\n[Requirements](requirements.md) [Remote](https://example.invalid/action)\n\nLAST-MEMBER-SENTINEL\n";
  for (const member of f.subject.members) {
    const bytes = Buffer.from(markdown);
    member.bytes = bytes.length; member.sha256 = digest(bytes); sources.set(member.sha256, bytes);
  }
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64");
  f.subject.members.push({ id: "diagram", role: "specification", mediaType: "image/png", source: "agent-teams/requirements/artifacts/reviews/EX-1/r001/diagram.png", description: "A one-pixel described test diagram", bytes: image.length, sha256: digest(image) });
  sources.set(digest(image), image);
  const snapshot = (hash: string) => { const bytes = sources.get(hash); if (!bytes) throw new DocumentPackageError("DOCUMENT_SOURCE"); return bytes; };
  return { ...f, sources, snapshot, render: () => renderDocumentReader(f.subject, snapshot), present: () => presentFullDocumentReader(f.subject, f.root, snapshot) };
}

test("full reader contains every ordered semantic member and described image, with exact raw and standalone fallbacks", () => {
  const f = fixture();
  try {
    const bundle = f.render(), html = bundle.files.get("index.html")!.toString();
    assert.equal(bundle.manifest.schemaVersion, DOCUMENT_READER_VERSION);
    assert.equal(bundle.manifest.members.length, f.subject.members.length);
    for (const tag of ["<strong>", "<em>", "<ul>", "<table>", "<pre>", "<code>", "<main", "<aside", "<details"]) assert.ok(html.includes(tag), tag);
    assert.equal((html.match(/LAST-MEMBER-SENTINEL/g) ?? []).length, 5);
    assert.match(html, /<img src="raw\/member-6.png" alt="A one-pixel described test diagram">/);
    let position = -1;
    for (const [i, member] of bundle.manifest.members.entries()) {
      const next = html.indexOf(`<article class="member" id="member-${i + 1}"`); assert.ok(next > position); position = next;
      assert.deepEqual(bundle.files.get(member.raw), f.snapshot(member.sha256));
      const fallback = bundle.files.get(member.companion)!.toString();
      assert.match(fallback, /Full package reader/); assert.match(fallback, /UNAPPROVED-at-generation/);
    }
    assert.match(html, /href="#member-2" rel="noreferrer">Requirements<\/a>/);
    assert.match(html, /\[Remote\]\(https:\/\/example.invalid\/action\)/);
    assert.doesNotMatch(html, /href="https?:/);
    assert.equal(bundle.manifest.observation, "not-performed");
    assert.equal(bundle.manifest.generationState, "UNAPPROVED-at-generation");
    assert.match(html, /Browser find and print cover every required member/);
  } finally { f.close(); }
});

test("full reader anchors are unique, all internal links resolve, and member neighbors are real", () => {
  const f = fixture();
  try {
    const html = f.render().files.get("index.html")!.toString();
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]!);
    assert.equal(new Set(ids).size, ids.length);
    for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(anchor!), anchor);
    assert.match(html, /id="member-1-section-1"/); assert.match(html, /id="member-1-section-3"/);
    assert.doesNotMatch(html, /href="#member-0"|href="#member-7"/);
    assert.match(html, /aria-label="Code block"/); assert.match(html, /aria-label="Data table"/);
    assert.match(html, /tabindex="0" role="region"/); assert.match(html, /@media print/);
    assert.match(html, /@media\(max-width:900px\)/); assert.match(html, /focus-visible/);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  } finally { f.close(); }
});

test("full reader is deterministic, hashes all outputs except its own manifest and binds source/order/effects/renderer", () => {
  const f = fixture();
  try {
    const first = f.render(), second = f.render();
    assert.equal(first.deliverySha256, second.deliverySha256); assert.equal(first.manifestSha256, second.manifestSha256);
    assert.deepEqual([...first.files], [...second.files]);
    for (const output of first.manifest.outputs) {
      const bytes = first.files.get(output.path)!; assert.equal(output.sha256, digest(bytes)); assert.equal(output.bytes, bytes.length);
    }
    assert.equal(first.manifest.outputs.some(o => o.path === "manifest.json"), false);
    assert.equal(digest(first.files.get("manifest.json")!), first.manifestSha256);
    assert.match(first.manifest.renderer.implementationSha256, /^[a-f0-9]{64}$/);
    const html = first.files.get("index.html")!.toString(); assert.ok(html.includes(first.manifest.renderer.implementationSha256));
    f.subject.effects.queue = !f.subject.effects.queue; assert.notEqual(f.render().deliverySha256, first.deliverySha256);
    f.subject.effects.queue = !f.subject.effects.queue;
    [f.subject.members[3], f.subject.members[4]] = [f.subject.members[4]!, f.subject.members[3]!];
    assert.notEqual(f.render().deliverySha256, first.deliverySha256);
  } finally { f.close(); }
});

test("full reader verifies complete input before delivery and rejects tampered, missing or oversized members", () => {
  const f = fixture();
  try {
    const hash = f.subject.members.at(-1)!.sha256, bytes = f.snapshot(hash);
    f.sources.set(hash, Buffer.from("tampered")); assert.throws(() => f.render(), DocumentPackageError);
    f.sources.delete(hash); assert.throws(() => f.render(), DocumentPackageError);
    f.sources.set(hash, bytes); f.subject.members[0]!.bytes = 1048577;
    assert.throws(() => f.render(), DocumentPackageError);
  } finally { f.close(); }
});

test("full reader hostile syntax remains inert at the direct renderer seam; package admission stays strict", () => {
  const raw = Buffer.from('# Hostile\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:evil) ![remote](https://example.invalid/image)\n\n<form><input></form>\n\n<svg></svg>\n');
  const rendered = renderPackageMarkdown(raw, "member-1").html;
  assert.doesNotMatch(rendered, /<(?:script|img|form|input|svg)\b|href=/i);
  assert.match(rendered, /&lt;script&gt;/);
  assert.throws(() => renderPackageMarkdown(Buffer.from("hello"), 'member-1" onload="x'));
  assert.throws(() => renderPackageMarkdown(Buffer.from("hello"), "member-1", new Map([["x", "https://example.invalid"]])));
  const f = fixture();
  try {
    const member = f.subject.members[0]!; member.sha256 = digest(raw); member.bytes = raw.length; f.sources.set(member.sha256, raw);
    assert.throws(() => f.render(), (e: unknown) => e instanceof DocumentPackageError && e.code === "DOCUMENT_SOURCE");
  } finally { f.close(); }
});

test("full reader publication uses native-derived paths, exact readback, repeat reuse and preserves old deliveries", async () => {
  const f = fixture();
  try {
    const first = await f.present(), entry = fileURLToPath(first.entry as string), original = readFileSync(entry);
    assert.equal(first.opening, "not-requested"); assert.equal(first.approval, "not-issued");
    assert.equal((await f.present()).entry, first.entry);
    assert.equal((await inspectFullDocumentReader(f.subject, f.root, f.snapshot, first.deliverySha256 as string)).entry, first.entry);
    f.subject.revision++; const second = await f.present(); assert.notEqual(first.entry, second.entry);
    assert.deepEqual(readFileSync(entry), original);
    writeFileSync(fileURLToPath(second.entry as string), "tampered output");
    await assert.rejects(() => f.present(), (e: unknown) => e instanceof DocumentPackageError && e.code === "DOCUMENT_CONFLICT");
    await assert.rejects(() => inspectFullDocumentReader(f.subject, f.root, f.snapshot, second.deliverySha256 as string));
  } finally { f.close(); }
});

test("full reader missing completed output fails without silently rebuilding or rewriting old snapshots", async () => {
  const f = fixture();
  try {
    const first = await f.present(), entry = fileURLToPath(first.entry as string), manifest = readFileSync(fileURLToPath(first.manifest as string));
    unlinkSync(join(entry, "..", "members", "member-1.html"));
    await assert.rejects(() => f.present());
    await assert.rejects(() => inspectFullDocumentReader(f.subject, f.root, f.snapshot, first.deliverySha256 as string));
    assert.deepEqual(readFileSync(fileURLToPath(first.manifest as string)), manifest);
  } finally { f.close(); }
});

test("full reader resumes an exact private pending prefix before a completed manifest exists", async () => {
  const f = fixture();
  try {
    const bundle = await renderDocumentReaderInWorker(f.subject, f.snapshot);
    const folder = join(f.root, "agent-teams/requirements/artifacts/presentations", bundle.manifest.subjectSha256, bundle.deliverySha256, "raw");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, ".member-1.md.pending"), f.snapshot(f.subject.members[0]!.sha256).subarray(0, 10), { mode: 0o600 });
    assert.equal((await f.present()).deliverySha256, bundle.deliverySha256);
    assert.deepEqual(readFileSync(join(folder, "member-1.md")), f.snapshot(f.subject.members[0]!.sha256));
    assert.equal(existsSync(join(folder, ".member-1.md.pending")), false);
  } finally { f.close(); }
});

test("full reader rejects derived output overflow without publishing a partial delivery", async () => {
  const f = fixture();
  try {
    const bytes = Buffer.from("```text\n" + "'".repeat(1_048_560) + "\n```\n"), hash = digest(bytes);
    for (let i = 0; i < 7; i++) f.subject.members.push({ id: `large-${i}`, role: "specification", mediaType: "text/markdown", source: `agent-teams/requirements/artifacts/reviews/EX-1/r001/large-${i}.md`, description: `Large member ${i}`, bytes: bytes.length, sha256: hash });
    f.sources.set(hash, bytes);
    await assert.rejects(() => f.present(), (e: unknown) => e instanceof DocumentPackageError && e.code === "DOCUMENT_UNAVAILABLE");
    assert.equal(existsSync(join(f.root, "agent-teams/requirements/artifacts/presentations")), false);
  } finally { f.close(); }
});

test("new package primitive does not alter the retained single-member companion interface", () => {
  const bytes = Buffer.from("# Heading\n\n[external](https://example.invalid)\n");
  const old = renderMarkdown(bytes, "/tmp/source.md");
  assert.match(old.html.toString(), /<h1>Heading<\/h1>/);
  assert.doesNotMatch(old.html.toString(), /class="member"|href="https?:/);
  assert.equal(old.anchors[0]!.id, "source-L1-L1");
});
