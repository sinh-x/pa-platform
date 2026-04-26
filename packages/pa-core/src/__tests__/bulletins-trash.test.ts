import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { BulletinStore, isTeamBlocked, TrashStore } from "../index.js";

test("bulletin guard detects blocked and exempt teams", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-guard-"));
  try {
    const store = new BulletinStore(root);
    store.create({ title: "Block builders", block: ["builder"], except: ["requirements"], body: "Stop" });
    assert.equal(isTeamBlocked("builder", store).blocked, true);
    assert.equal(isTeamBlocked("requirements", store).blocked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TrashStore moves, restores, and lists entries", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-trash-"));
  try {
    const source = join(root, "source.md");
    writeFileSync(source, "hello");
    const store = new TrashStore(join(root, "trash"));
    const entry = store.move({ path: source, reason: "test", actor: "builder", fileType: "other" });
    assert.equal(existsSync(source), false);
    assert.equal(store.list({ status: "trashed" }).length, 1);
    store.restore(entry.id);
    assert.equal(existsSync(source), true);
    assert.equal(store.get(entry.id)?.status, "restored");
    mkdirSync(join(root, "old"), { recursive: true });
    const oldSource = join(root, "old", "file.md");
    writeFileSync(oldSource, "old");
    const oldEntry = store.move({ path: oldSource, reason: "old", actor: "builder" });
    assert.deepEqual(store.purge({ days: -1 }).map((item) => item.id), [oldEntry.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
