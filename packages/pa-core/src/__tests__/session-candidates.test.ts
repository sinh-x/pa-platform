import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDb } from "../registry/db.js";
import { readSessionCandidates, SESSION_CANDIDATE_LIMIT } from "../registry/session-inventory.js";

test("existing-only candidate read refreshes all statuses, excludes other adapters, caps explicitly and does not mutate database", () => {
  const root = mkdtempSync(join(tmpdir(), "session-registry-")), prior = process.env.PA_REGISTRY_DB;
  process.env.PA_REGISTRY_DB = join(root, "registry.db");
  try {
    assert.throws(() => readSessionCandidates());
    const db = getDb();
    const insert = db.prepare("INSERT INTO deployments (deployment_id, team, status, runtime, binary, started_at) VALUES (?, 'fixture', ?, ?, ?, '2026-11-24')");
    for (let i = 0; i < 22; i++) insert.run(`d-${i.toString(16).padStart(6, "0")}`, i === 0 ? "success" : "running", "pi", "ppa");
    insert.run("d-ffffff", "running", "opencode", "opa");
    db.pragma("wal_checkpoint(TRUNCATE)"); closeDb();
    const before = readFileSync(process.env.PA_REGISTRY_DB);
    const capture = readSessionCandidates();
    assert.equal(capture.candidates.length, 22); assert.equal(capture.complete, true);
    assert.ok(capture.candidates.some(row => row.registryStatus === "success"));
    assert.deepEqual(readFileSync(process.env.PA_REGISTRY_DB), before);
    const next = getDb(); next.prepare("DELETE FROM deployments").run();
    assert.equal(readSessionCandidates().candidates.length, 0);
    next.transaction(() => {
      const add = next.prepare("INSERT INTO deployments (deployment_id, team, runtime, binary) VALUES (?, 'fixture', 'pi', 'ppa')");
      for (let i = 0; i <= SESSION_CANDIDATE_LIMIT; i++) add.run(`row-${i}`);
    })();
    assert.equal(readSessionCandidates().candidates.length, SESSION_CANDIDATE_LIMIT);
    assert.equal(readSessionCandidates().complete, false);
  } finally { closeDb(); if (prior === undefined) delete process.env.PA_REGISTRY_DB; else process.env.PA_REGISTRY_DB = prior; rmSync(root, { recursive: true, force: true }); }
});
