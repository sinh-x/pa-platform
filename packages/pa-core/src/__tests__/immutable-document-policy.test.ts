import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertImmutableDocumentText, assertSelectedPiDocumentPath } from "../immutable-document-policy.js";
import { acquireLocalSourceFile, acquireSelectedPiDocument } from "../local-source-file.js";
import { SourceContentSecurityError } from "../source-content-security.js";
import * as publicCore from "../index.js";

const root = "/nix/store/00000000000000000000000000000000-inert-pi/lib/node_modules/pi-monorepo";
const code = (expected: string) => (error: unknown) => error instanceof SourceContentSecurityError && error.code === expected;

test("public core barrel exposes ordinary ingress, not the selected-document composition seam", () => {
  assert.equal(typeof publicCore.acquireLocalSourceFile, "function");
  assert.equal("acquireSelectedPiDocument" in publicCore, false);
});

test("selected document scope is finite/component-safe and is not an origin grant", () => {
  for (const path of ["README.md", "docs/extensions.md", "docs/nested/notes.txt", "examples/read.ts"]) assert.doesNotThrow(() => assertSelectedPiDocumentPath(`${root}/${path}`, root));
  for (const path of [root, `${root}/README.md/child`, `${root}/docs`, `${root}/docs-alt/a.txt`, `${root}/examples-alt/a.ts`, `${root}/package.json`, `${root}/docs/../package.json`, `${root}/docs//note.md`, `${root}/docs/./note.md`, `${root}2/docs/note.md`, `/tmp/README.md`])
    assert.throws(() => assertSelectedPiDocumentPath(path, root), code("LOCAL_SOURCE_UNSUPPORTED_FILE"), path);
  for (const forged of ["/tmp/pi", "/nix/store/not-a-store-name/pi", `${root}/..`, `${root}\0`])
    assert.throws(() => assertSelectedPiDocumentPath(`${forged}/README.md`, forged), code("LOCAL_SOURCE_UNSUPPORTED_FILE"));
});

test("immutable document text requires complete valid UTF-8 and finite controls, not an extension", () => {
  for (const text of ["", "ordinary documentation\n", "λ 日本語 😀\t\r\n", "\ufeffUTF-8 BOM\n", "console.log('inert example');\n"])
    assert.doesNotThrow(() => assertImmutableDocumentText(Buffer.from(text)));
  for (const bytes of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82]), Buffer.from([0xff, 0xfe]), Buffer.from("ordinary\0binary"), Buffer.from("escape\x1b[31m"), Buffer.from("delete\x7f"), Buffer.from("C1\u0085"), Buffer.from("GIF89aASCII-shaped-image"), Buffer.from("GIFambiguous-text-prefix"), Buffer.from("BMASCII-shaped-image"), Buffer.from("RIFF0000WEBPASCII"), Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("\x89PNG\r\n\x1a\n", "latin1")])
    assert.throws(() => assertImmutableDocumentText(bytes), code("LOCAL_SOURCE_UNSUPPORTED_FILE"));
});

test("mutable fixture/forged binding cannot turn ordinary hard-link denial into selected eligibility", () => {
  const directory = mkdtempSync(join(tmpdir(), "immutable-document-negative-"));
  try {
    mkdirSync(join(directory, "docs"));
    const path = join(directory, "docs/note.txt");
    writeFileSync(path, "inert ordinary fixture"); linkSync(path, join(directory, "alias.txt"));
    assert.throws(() => acquireLocalSourceFile(path), code("LOCAL_SOURCE_UNSUPPORTED_FILE"));
    assert.throws(() => acquireSelectedPiDocument(path, { packageRoot: directory, assertStable() {} }), code("LOCAL_SOURCE_UNSUPPORTED_FILE"));
    assert.throws(() => acquireSelectedPiDocument(path, { packageRoot: root, assertStable() {} }), code("LOCAL_SOURCE_UNSUPPORTED_FILE"));
    assert.throws(() => acquireSelectedPiDocument(`${root}/README.md`, { packageRoot: root, assertStable() { throw new Error("inert stale producer"); } }), code("LOCAL_SOURCE_UNAVAILABLE"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
