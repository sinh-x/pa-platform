import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { appendEvaluatorResult, appendRegistryEvent, closeDb, computeDeploymentStatuses, getDb, getDeploymentEvents, queryDeploymentStatus, queryEvaluatorResultsByTargetDeployment } from "../index.js";

test("registry appends WAL-backed events and materializes deployment status", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-test", team: "builder", event: "started", timestamp: "2026-04-26T10:00:00Z", agents: ["team-manager"], runtime: "opencode", binary: "opa", effective_timeout_seconds: 1200 });
    appendRegistryEvent({ deployment_id: "d-test", team: "builder", event: "completed", timestamp: "2026-04-26T10:01:00Z", status: "success", summary: "ok" });
    const events = getDeploymentEvents("d-test");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.effective_timeout_seconds, 1200);
    const status = queryDeploymentStatus("d-test");
    assert.equal(status?.status, "success");
    assert.equal(status?.runtime, "opencode");
    assert.equal(status?.effective_timeout_seconds, 1200);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry materializes effective timeout metadata from started events", () => {
  const statuses = computeDeploymentStatuses([
    { deployment_id: "d-timeout", team: "builder", event: "started", timestamp: "2026-04-26T10:00:00Z", effective_timeout_seconds: 1800 },
  ]);
  assert.equal(statuses[0]?.status, "running");
  assert.equal(statuses[0]?.effective_timeout_seconds, 1800);
});

test("registry migration preserves legacy deployments without timeout metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-legacy-"));
  const dbPath = join(root, "registry.db");
  const previous = process.env["PA_REGISTRY_DB"];
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO _meta (key, value) VALUES ('schema_version', '7');
    CREATE TABLE registry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id TEXT NOT NULL,
      team TEXT NOT NULL,
      event TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      pid INTEGER,
      status TEXT,
      summary TEXT,
      log_file TEXT,
      primer TEXT,
      agents TEXT,
      models TEXT,
      error TEXT,
      exit_code INTEGER,
      ticket_id TEXT,
      provider TEXT,
      rating TEXT,
      objective TEXT,
      repo TEXT,
      fallback INTEGER DEFAULT 0,
      resumed_from_deployment_id TEXT,
      note TEXT,
      runtime TEXT,
      binary TEXT
    );
    CREATE TABLE deployments (
      deployment_id TEXT PRIMARY KEY,
      team TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      started_at TEXT,
      completed_at TEXT,
      pid INTEGER,
      summary TEXT,
      log_file TEXT,
      primer TEXT,
      agents TEXT,
      models TEXT,
      ticket_id TEXT,
      objective TEXT,
      repo TEXT,
      provider TEXT,
      error TEXT,
      exit_code INTEGER,
      rating TEXT,
      fallback INTEGER DEFAULT 0,
      resumed_from_deployment_id TEXT,
      runtime TEXT,
      binary TEXT
    );
    INSERT INTO deployments (deployment_id, team, status, started_at, runtime, binary)
    VALUES ('d-legacy', 'builder', 'running', '2026-04-26T10:00:00Z', 'opencode', 'opa');
  `);
  legacyDb.close();

  process.env["PA_REGISTRY_DB"] = dbPath;
  try {
    const db = getDb();
    const eventColumns = db.prepare("PRAGMA table_info(registry_events)").all() as Array<{ name: string }>;
    const deploymentColumns = db.prepare("PRAGMA table_info(deployments)").all() as Array<{ name: string }>;
    assert.equal(eventColumns.some((entry) => entry.name === "effective_timeout_seconds"), true);
    assert.equal(deploymentColumns.some((entry) => entry.name === "effective_timeout_seconds"), true);
    assert.deepEqual(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get(), { value: "9" });

    const status = queryDeploymentStatus("d-legacy");
    assert.equal(status?.status, "running");
    assert.equal(status?.runtime, "opencode");
    assert.equal(status?.effective_timeout_seconds, undefined);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry stores evaluator ratings linked to deployments", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-evaluator-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-target", team: "builder", event: "started", timestamp: "2026-05-10T09:00:00Z" });
    appendRegistryEvent({ deployment_id: "d-eval", team: "builder", event: "started", timestamp: "2026-05-10T09:05:00Z" });
    appendEvaluatorResult({
      target_deployment_id: "d-target",
      evaluator_deployment_id: "d-eval",
      summary: "Evaluator pass complete",
      report_path: "agent-teams/builder/artifacts/2026-05-10-evaluator-report.md",
      evidence_refs: ["deployments/d-target/primer.md", "sessions/2026/05/agent-team/2026-05-10-d-target-builder.md"],
      findings: "All findings include evidence links.",
      rating: {
        source: "system",
        overall: 4,
        metrics: {
          productivity: 4,
          quality: 4,
          human_agency: 5,
        },
      },
      created_at: "2026-05-10T09:06:00Z",
    });

    const db = getDb();
    const fks = db.prepare("PRAGMA foreign_key_list(evaluator_ratings)").all() as Array<{ table: string; from: string; to: string }>;
    assert.equal(fks.some((entry) => entry.table === "deployments" && entry.from === "target_deployment_id" && entry.to === "deployment_id"), true);
    assert.equal(fks.some((entry) => entry.table === "deployments" && entry.from === "evaluator_deployment_id" && entry.to === "deployment_id"), true);

    const results = queryEvaluatorResultsByTargetDeployment("d-target");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.evaluator_deployment_id, "d-eval");
    assert.equal(results[0]?.rating.metrics.human_agency, 5);
    assert.equal(results[0]?.evidence_refs.length, 2);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
