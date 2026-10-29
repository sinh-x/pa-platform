import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { linkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTemplateRegistry } from "../templates/registry.js";
import { digest, parseTemplateRegistry, strictJson, TEMPLATE_IDS, TemplateError } from "../templates/schema.js";
import { templateFixture } from "./template-fixture.js";

test("explicit 16-entry inventory returns exact raw CRLF bytes and pins", () => {
  const f = templateFixture(); try { const loaded = loadTemplateRegistry(f.selection); assert.equal(loaded.registry.entries.length, 16); assert.deepEqual(loaded.registry.entries.map((e) => e.id), [...TEMPLATE_IDS].sort()); assert.equal(digest(loaded.sources.get("requirements")!.raw), f.registry.entries[0]!.source.sha256); } finally { f.dispose(); }
});
for (const variant of ["missing", "extra-standard", "symlink", "hardlink", "digest", "pair", "duplicate-id", "version", "traversal", "malformed-utf8", "bom", "oversize"] as const) test(`registry rejects ${variant} without leaking body`, () => {
  const f = templateFixture(); try {
    const path = join(f.root, "skills/templates/requirements.md"); let selection = f.selection;
    if (variant === "missing") unlinkSync(path);
    if (variant === "extra-standard") writeFileSync(join(f.root, "skills/templates/new.md"), "SENTINEL");
    if (variant === "symlink" || variant === "hardlink") { unlinkSync(path); (variant === "symlink" ? symlinkSync : linkSync)(join(f.root, "skills/templates/uat-review.md"), path); }
    if (variant === "digest") writeFileSync(path, "SENTINEL");
    if (variant === "pair") selection = { ...selection, configRevision: "b".repeat(40) };
    if (variant === "duplicate-id") { f.registry.entries[1]!.id = "requirements"; selection = f.save(); }
    if (variant === "version") { (f.registry as unknown as Record<string, unknown>).runtimeContract = "future"; selection = f.save(); }
    if (variant === "traversal") { f.registry.entries[0]!.source.path = "skills/templates/../secret.md"; selection = f.save(); }
    if (["malformed-utf8", "bom", "oversize"].includes(variant)) {
      const bytes = variant === "malformed-utf8" ? Buffer.from([255]) : variant === "bom" ? Buffer.from([239,187,191,65]) : Buffer.alloc(1_048_577, 65);
      writeFileSync(path, bytes); f.registry.entries[0]!.source.sha256 = digest(bytes); selection = f.save();
    }
    assert.throws(() => loadTemplateRegistry(selection), (e: unknown) => e instanceof TemplateError && e.message.length < 2000 && !e.message.includes("SENTINEL"));
  } finally { f.dispose(); }
});
test("a previously read source changing while another entry loads invalidates the whole selected snapshot", (t) => {
  const f = templateFixture(); const original = fs.lstatSync; let changed = false;
  try {
    t.mock.method(fs, "lstatSync", ((path: fs.PathLike, options?: unknown) => {
      if (!changed && String(path).endsWith("/skills/templates/spike-full-requirements.md")) { changed = true; fs.appendFileSync(join(f.root, "skills/templates/requirements.md"), "CHANGED-SECRET-SENTINEL"); }
      return original(path, options as never);
    }) as typeof fs.lstatSync); syncBuiltinESMExports();
    assert.throws(() => loadTemplateRegistry(f.selection), (e: unknown) => e instanceof TemplateError && e.code === "TEMPLATE_IO" && !e.message.includes("SECRET-SENTINEL"));
    assert.equal(changed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.dispose(); }
});

test("strict shared JSON rejects escaped duplicate, depth, BOM, invalid Unicode and oversized requests", () => {
  for (const input of ['{"x":1,"\\u0078":2}', '{"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}', '{"x":"\\ud800"}', ' '.repeat(65537), '\ufeff{}']) assert.throws(() => strictJson(Buffer.from(input)), TemplateError);
  const f = templateFixture(); try { assert.throws(() => parseTemplateRegistry(Buffer.from(JSON.stringify({ ...f.registry, secretUnknownField: "SENTINEL" }))), TemplateError); } finally { f.dispose(); }
});
