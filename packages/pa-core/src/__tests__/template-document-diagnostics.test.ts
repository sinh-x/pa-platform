import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateDocument } from "../templates/documents.js";
import { digest, TemplateError } from "../templates/schema.js";
import { templateService } from "../templates/service.js";
import { DOCUMENT_DIAGNOSTIC_CASES } from "./template-document-diagnostic-fixture.js";
import { documentFixture } from "./template-document-fixture.js";
import { templateFixture } from "./template-fixture.js";

for (const [index, c] of DOCUMENT_DIAGNOSTIC_CASES.entries()) test(`bounded first-failing document rule ${c.rule} (${index + 1})`, () => {
  const f = templateFixture();
  try {
    const entry = f.registry.entries.find(e => e.id === c.id)!;
    const path = join(f.root, entry.source.path), original = readFileSync(path, "utf8"), mutated = c.mutate(original);
    assert.notEqual(mutated, original, "mutation must exercise the declared rule");
    const request = { action: "render", id: c.id, version: "1", bindings: { ticket: "FIX-1" } };
    const valid = templateService(request, { selection: f.selection }); assert.equal(valid.ok, true);
    writeFileSync(path, mutated); entry.source.sha256 = digest(mutated); f.selection = f.save();
    const before = { source: readFileSync(path), registry: readFileSync(join(f.root, "contracts/templates-v1.json")) };
    for (const action of ["render", "validate"]) for (let n = 0; n < 2; n++) {
      const result = templateService({ ...request, action, ...(action === "validate" ? { candidate: valid.candidate } : {}) }, { selection: f.selection });
      assert.equal(result.ok, false); assert.equal(result.unsigned, true); assert.equal(result.code, "TEMPLATE_STRUCTURE");
      const diagnostic = result.diagnostic as string;
      assert.ok(diagnostic.includes(`\nSource: document.${c.rule}\n`), diagnostic);
      for (const field of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(diagnostic.split("\n").filter(line => line.startsWith(field + ": ")).length, 1);
      assert.ok(diagnostic.length <= 2000); assert.ok(!JSON.stringify(result).includes("SECRET-SENTINEL"));
      assert.ok(!JSON.stringify(result).includes(f.root), "no raw selected paths or OS exceptions");
    }
    assert.deepEqual({ source: readFileSync(path), registry: readFileSync(join(f.root, "contracts/templates-v1.json")) }, before);
    // Correcting the same selected source restores its original deterministic
    // candidate, not an approval, a normalized substitute or a persisted record.
    writeFileSync(path, original); entry.source.sha256 = digest(original);
    assert.deepEqual(templateService(request, { selection: f.save() }), valid);
  } finally { f.dispose(); }
});

test("profile and numbered-section diagnostics remain runtime-owned without echoing selected headings", () => {
  const f = documentFixture("project-agent-guide");
  const candidate = f.source.replaceAll("{{ticket}}", "FIX-1");
  for (const [rule, body, sections] of [
    ["profile", candidate, []],
    ["numbered-sections", candidate.replace("## 1. Synthetic fixture", "## SECRET-SENTINEL"), f.sections.map(s => s.replace("## 1. Synthetic fixture", "## SECRET-SENTINEL"))],
  ] as const) assert.throws(() => validateDocument(body, "project-agent-guide", [...sections]), (error: unknown) => {
    assert.ok(error instanceof TemplateError); assert.equal(error.code, "TEMPLATE_STRUCTURE");
    assert.equal(error.source, `document.${rule}`); assert.ok(!error.message.includes("SECRET-SENTINEL")); return true;
  });
});
