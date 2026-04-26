import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { aiUsageRelativePath, documentPath, listDocuments, readDocument, writeDocument } from "../index.js";

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
