import assert from "node:assert/strict";
import fs, {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  artifactSha256, serializeArtifactManifest, validateArtifactManifest,
  type ArtifactManifest,
} from "../manifest.js";
import { renderArtifact } from "../render.js";
import { ArtifactPolicyError } from "../policy.js";

const env = { PATH: process.env.PATH };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync("/tmp/pa-manifest-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source.md"), output = join(root, "output");
  writeFileSync(source, "# Source\n\nParagraph é.\n");
  const result = renderArtifact(source, output, env);
  return { root, source, output, path: result.manifest, result };
}
function stale(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof ArtifactPolicyError
    && error.exitCode === 4 && error.message === "ARTIFACT_STALE: Artifact identity is stale or tampered.");
}
function getManifest(path: string): ArtifactManifest {
  return JSON.parse(readFileSync(path, "utf8")) as ArtifactManifest;
}

test("canonical manifest v1 has only exact deterministic fields, versions and line ranges", (t) => {
  const f = fixture(t);
  const validated = validateArtifactManifest(f.path);
  assert.equal(validated.manifest.sourceRef, f.source);
  assert.equal(validated.manifest.sourceSha256, artifactSha256(readFileSync(f.source)));
  assert.equal(validated.manifest.htmlSha256, artifactSha256(readFileSync(join(f.output, "index.html"))));
  assert.equal(validated.manifest.rendererVersion, "pa-artifact-renderer/v1");
  assert.equal(validated.manifest.policyVersion, "pa-artifact-policy/v1");
  assert.deepEqual(validated.manifest.anchors, [
    { id: "source-L1-L1", startLine: 1, endLine: 1 },
    { id: "source-L3-L3", startLine: 3, endLine: 3 },
  ]);
  const expected = `{
  "schema": "pa-artifact-manifest/v1",
  "sourceRef": ${JSON.stringify(f.source)},
  "sourceSha256": "${validated.identity.sourceSha256}",
  "htmlSha256": "${validated.identity.htmlSha256}",
  "rendererVersion": "pa-artifact-renderer/v1",
  "policyVersion": "pa-artifact-policy/v1",
  "anchors": [
    {
      "id": "source-L1-L1",
      "startLine": 1,
      "endLine": 1
    },
    {
      "id": "source-L3-L3",
      "startLine": 3,
      "endLine": 3
    }
  ]
}\n`;
  assert.deepEqual(validated.manifestBytes, Buffer.from(expected));
  assert.deepEqual(serializeArtifactManifest(validated.manifest), validated.manifestBytes);
  assert.equal(validated.identity.manifestSha256, f.result.manifestSha256);
  assert.deepEqual(validateArtifactManifest(f.path, validated.identity).identity, validated.identity);
});

test("raw source changes, even line-ending-only changes, are stale without source mutation or regeneration", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.path), html = readFileSync(join(f.output, "index.html"));
  const source = readFileSync(f.source);
  for (const bytes of [Buffer.from("# Changed\n"), Buffer.from(source.toString().replace(/\n/g, "\r\n")), Buffer.from([0xff])]) {
    writeFileSync(f.source, bytes);
    stale(() => validateArtifactManifest(f.path));
    assert.deepEqual(readFileSync(f.source), bytes);
    assert.deepEqual(readFileSync(f.path), before);
    assert.deepEqual(readFileSync(join(f.output, "index.html")), html);
  }
});

test("HTML tampering cannot be concealed by updating htmlSha256 or relabeling anchors", (t) => {
  const f = fixture(t);
  const manifest = getManifest(f.path);
  const evil = Buffer.from('<script>secret-sentinel</script>');
  writeFileSync(join(f.output, "index.html"), evil);
  stale(() => validateArtifactManifest(f.path));
  manifest.htmlSha256 = artifactSha256(evil);
  writeFileSync(f.path, serializeArtifactManifest(manifest));
  stale(() => validateArtifactManifest(f.path));
  assert.deepEqual(readFileSync(join(f.output, "index.html")), evil);
  assert.equal(existsSync(join(f.root, "feedback.json")), false);
});

test("the caller's pinned manifest identity detects otherwise-valid replacement with a new artifact", (t) => {
  const f = fixture(t);
  const old = validateArtifactManifest(f.path).identity;
  writeFileSync(f.source, "# Newly authorized source is still a different artifact\n");
  const replacement = renderArtifact(f.source, join(f.root, "new"), env);
  const fresh = validateArtifactManifest(replacement.manifest);
  assert.notEqual(fresh.identity.sourceSha256, old.sourceSha256);
  stale(() => validateArtifactManifest(replacement.manifest, old));
  for (const key of Object.keys(fresh.identity) as (keyof typeof old)[]) {
    stale(() => validateArtifactManifest(replacement.manifest, { ...fresh.identity, [key]: "not-the-original" }));
  }
});

test("changed sourceRef, schema, versions, digests and anchors fail without repair", (t) => {
  const f = fixture(t);
  const original = readFileSync(f.path);
  const mutations: ((m: ArtifactManifest) => void)[] = [
    (m) => { m.schema = "unknown" as ArtifactManifest["schema"]; },
    (m) => { m.sourceRef = `${f.source}.other`; },
    (m) => { m.sourceRef = f.source.replace("/source.md", "/./source.md"); },
    (m) => { m.sourceSha256 = "0".repeat(64); },
    (m) => { m.htmlSha256 = "0".repeat(64); },
    (m) => { m.sourceSha256 = "A".repeat(64); },
    (m) => { m.rendererVersion = "pa-artifact-renderer/v2"; },
    (m) => { m.policyVersion = "pa-artifact-policy/v2"; },
    (m) => { m.anchors[0]!.endLine = 2; m.anchors[0]!.id = "source-L1-L2"; },
    (m) => { m.anchors[0]!.startLine = 0; },
    (m) => { m.anchors[0]!.startLine = 1.5; },
    (m) => { m.anchors[0]!.id = 'x" onmouseover="execute'; },
    (m) => { m.anchors = []; },
    (m) => { m.anchors.reverse(); },
  ];
  for (const mutate of mutations) {
    const manifest = JSON.parse(original.toString()) as ArtifactManifest;
    mutate(manifest);
    const changed = serializeArtifactManifest(manifest);
    writeFileSync(f.path, changed);
    stale(() => validateArtifactManifest(f.path));
    assert.deepEqual(readFileSync(f.path), changed);
  }
});

test("noncanonical, malformed, extra/missing/duplicate-field, BOM and invalid UTF-8 manifests are stale", (t) => {
  const f = fixture(t);
  const original = readFileSync(f.path, "utf8");
  const manifest = getManifest(f.path);
  const extra = { ...manifest, timestamp: "must-not-enter-v1" };
  for (const bytes of [
    Buffer.from("not JSON secret-sentinel"), Buffer.from("[]"), Buffer.from("null"), Buffer.from("{}"),
    Buffer.from(JSON.stringify(manifest)), Buffer.from(original.replace(/\n/g, "\r\n")),
    Buffer.from(`\ufeff${original}`), Buffer.from([0xff]), Buffer.from(`${original}\n`),
    Buffer.from(JSON.stringify(extra, null, 2) + "\n"),
    Buffer.from(original.replace('  "schema":', '  "schema": "pa-artifact-manifest/v1",\n  "schema":')),
    Buffer.from(original.replace(/  "policyVersion":.*\n/, "")),
    Buffer.from(original.replace('      "id":', '      "extra": 1,\n      "id":')),
    Buffer.from(original.replace('  "anchors": [', '  "anchors": [null,')),
  ]) {
    writeFileSync(f.path, bytes);
    stale(() => validateArtifactManifest(f.path));
    assert.deepEqual(readFileSync(f.path), bytes);
  }
});

test("symlink, hardlink, nonregular, absent inputs and symlink ancestors are never adopted", (t) => {
  const f = fixture(t);
  const original = readFileSync(f.path);
  unlinkSync(f.path);
  stale(() => validateArtifactManifest(f.path));
  mkdirSync(f.path);
  stale(() => validateArtifactManifest(f.path));
  rmSync(f.path, { recursive: true });
  writeFileSync(join(f.root, "manifest-copy"), original);
  symlinkSync(join(f.root, "manifest-copy"), f.path);
  stale(() => validateArtifactManifest(f.path));
  unlinkSync(f.path);
  linkSync(join(f.root, "manifest-copy"), f.path);
  stale(() => validateArtifactManifest(f.path));
  unlinkSync(f.path);
  writeFileSync(f.path, original);
  symlinkSync(f.output, join(f.root, "output-link"));
  stale(() => validateArtifactManifest(join(f.root, "output-link/manifest.json")));
  const html = join(f.output, "index.html");
  renameSync(html, `${html}.own`);
  symlinkSync(`${html}.own`, html);
  stale(() => validateArtifactManifest(f.path));
  unlinkSync(html);
  renameSync(`${html}.own`, html);
  renameSync(f.source, `${f.source}.own`);
  symlinkSync(`${f.source}.own`, f.source);
  stale(() => validateArtifactManifest(f.path));
  assert.deepEqual(readFileSync(`${f.source}.own`), Buffer.from("# Source\n\nParagraph é.\n"));
});

test("canonical sourceRef participates in deterministic HTML/manifest identity even for equal source bytes", (t) => {
  const f = fixture(t);
  const other = join(f.root, "other.md");
  writeFileSync(other, readFileSync(f.source));
  const next = renderArtifact(other, join(f.root, "other-output"), env);
  assert.equal(next.sourceSha256, f.result.sourceSha256);
  assert.notEqual(next.htmlSha256, f.result.htmlSha256);
  assert.notEqual(next.manifestSha256, f.result.manifestSha256);
  assert.equal(validateArtifactManifest(next.manifest).manifest.sourceRef, other);
});

test("validator has no write path and notices changes while validating, rather than pinning mixed identities", (t) => {
  const f = fixture(t);
  const originalWrite = fs.writeFileSync;
  const originalRead = fs.readSync;
  let reads = 0;
  const mock = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    // Initial manifest, source, HTML are each read to EOF; change source before
    // its final reread. Use the actual syscall path, not a fake validation result.
    const result = originalRead(...args);
    if (++reads === 6) originalWrite(f.source, "# Changed during validation\n");
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  stale(() => validateArtifactManifest(f.path));
  assert.equal(readFileSync(f.source, "utf8"), "# Changed during validation\n");
  assert.deepEqual(readdirSync(f.output).sort(), ["index.html", "manifest.json"]);
});
