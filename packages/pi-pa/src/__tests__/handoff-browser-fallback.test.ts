import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { SystemDocumentBrowserFallback } from "../handoff-browser-fallback.js";

// These are disposable DESKTOP-LAUNCHER STUBS, not real browser/viewing,
// installed qualification, network isolation or external child cleanup proofs.
for (const exit of [0, 1]) test(`system-browser fallback invokes only the bound file once and reports launcher exit ${exit} honestly`, () => {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "pap312-default-browser-"));
  try {
    const bin = join(root, "bin"), marker = join(root, "arguments"), entry = join(root, "space & ' quote.html"); mkdirSync(bin); writeFileSync(entry, "inert local reader");
    writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$#" "$1" > "$BROWSER_FIXTURE_MARKER"\nexit ${exit}\n`); chmodSync(join(bin, "xdg-open"), 0o700);
    Object.assign(process.env, { PATH: bin, DISPLAY: ":999", BROWSER_FIXTURE_MARKER: marker });
    const owner = new SystemDocumentBrowserFallback(entry); assert.equal(owner.available(), true);
    const result = owner.request("a".repeat(64), "b".repeat(64));
    assert.equal(readFileSync(marker, "utf8"), `1\n${pathToFileURL(entry).href}\n`);
    assert.equal(result.state, exit === 0 ? "open-requested" : "uncertain");
    assert.equal(result.cleanup, exit === 0 ? "settled" : "unknown");
    const before = readFileSync(marker); assert.equal(owner.reconcile("a".repeat(64), "b".repeat(64)).state, "uncertain");
    assert.deepEqual(readFileSync(marker), before, "reconciliation must never launch a replacement");
  } finally { process.env = env; rmSync(root, { recursive: true, force: true }); }
});

test("system-browser fallback remains unavailable without a display or supported desktop launcher", () => {
  const env = { ...process.env };
  try {
    delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY; process.env.PATH = "/nonexistent";
    const owner = new SystemDocumentBrowserFallback("/native-derived/index.html"); assert.equal(owner.available(), false);
    assert.equal(owner.request("a".repeat(64), "b".repeat(64)).state, "unavailable");
  } finally { process.env = env; }
});
