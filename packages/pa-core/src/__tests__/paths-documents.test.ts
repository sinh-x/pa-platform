import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { aiUsageRelativePath, documentPath, getImageContentType, insertDocumentSection, listDocuments, listMarkdownFiles, readDocument, readMarkdownDocument, writeDocument } from "../index.js";

test("documents use the shared ai-usage root", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-docs-"));
  const previous = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_AI_USAGE_HOME"] = root;
  try {
    const ref = writeDocument("agent-teams", "builder/artifacts/example.md", "hello");
    assert.equal(readDocument("agent-teams", "builder/artifacts/example.md"), "hello");
    assert.equal(documentPath("agent-teams", "builder/artifacts/example.md"), ref.absolutePath);
    assert.equal(aiUsageRelativePath(ref.absolutePath), "agent-teams/builder/artifacts/example.md");
    assert.deepEqual(listDocuments("agent-teams").map((entry) => entry.relativePath), ["builder/artifacts/example.md"]);
  } finally {
    if (previous === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("document helpers list markdown and insert sections", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-doc-sections-"));
  try {
    const dir = join(root, "docs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "2026-04-26-review-note.md");
    writeFileSync(file, ["# Review", "> **Date:** 2026-04-26", "> **Type:** Review", "", "Existing", "Anchor"].join("\n"));
    const items = listMarkdownFiles(dir);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.title, "Review");
    assert.equal(items[0]?.type, "review-request");
    const doc = readMarkdownDocument(file);
    assert.equal(doc.metadata.type, "review-request");
    const inserted = insertDocumentSection(file, { title: "Notes", content: "New content", lineText: "Anchor" });
    assert.equal(inserted.status, "ok");
    assert.equal(inserted.insertedAt, "after:6");
    assert.match(readFileSync(file, "utf-8"), /Anchor\n### Notes\n\nNew content/);
    const appended = insertDocumentSection(file, { title: null, content: "Trailing", lineText: "missing" });
    assert.equal(appended.status, "warning");
    assert.equal(appended.insertedAt, "end");
    assert.equal(getImageContentType("example.webp"), "image/webp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
