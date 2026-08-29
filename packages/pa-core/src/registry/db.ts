import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getRegistryDbPath } from "../paths.js";

let singleton: Database.Database | null = null;
const SCHEMA_VERSION = 10;
export const REGISTRY_NATIVE_BINDING_ENV = "PA_SQLITE_NATIVE_BINDING";

export interface RegistryNativeAddonEvidence {
  node: string;
  modules: string;
  v8: string;
  addonPath: string;
}

export function getDb(dbPath = getRegistryDbPath()): Database.Database {
  if (singleton && dbPath === getRegistryDbPath()) return singleton;
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
  const db = openRegistryDatabase(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  if (dbPath === getRegistryDbPath()) singleton = db;
  return db;
}

export function closeDb(): void {
  singleton?.close();
  singleton = null;
}

export function verifyRegistryNativeAddon(addonPath: string): RegistryNativeAddonEvidence {
  const db = openRegistryDatabase(":memory:", addonPath);
  try {
    db.pragma("user_version");
  } finally {
    db.close();
  }
  return {
    node: process.version,
    modules: process.versions.modules ?? "unknown",
    v8: process.versions.v8,
    addonPath,
  };
}

function openRegistryDatabase(dbPath: string, nativeBinding = process.env[REGISTRY_NATIVE_BINDING_ENV]?.trim()): Database.Database {
  return nativeBinding ? new Database(dbPath, { nativeBinding }) : new Database(dbPath);
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS registry_events (
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
      mode TEXT,
      fallback INTEGER DEFAULT 0,
      resumed_from_deployment_id TEXT,
      note TEXT,
      runtime TEXT,
      binary TEXT,
      effective_timeout_seconds INTEGER
    );
    CREATE TABLE IF NOT EXISTS deployments (
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
      mode TEXT,
      provider TEXT,
      error TEXT,
      exit_code INTEGER,
      rating TEXT,
      fallback INTEGER DEFAULT 0,
      resumed_from_deployment_id TEXT,
      runtime TEXT,
      binary TEXT,
      effective_timeout_seconds INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_events_deployment_id ON registry_events(deployment_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON registry_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_deployments_team ON deployments(team);
    CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
    CREATE INDEX IF NOT EXISTS idx_deployments_started_at ON deployments(started_at);
    CREATE INDEX IF NOT EXISTS idx_deployments_ticket_id ON deployments(ticket_id);
    CREATE TABLE IF NOT EXISTS evaluator_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_deployment_id TEXT NOT NULL,
      evaluator_deployment_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      rating TEXT NOT NULL,
      summary TEXT,
      report_path TEXT,
      evidence_refs TEXT NOT NULL,
      findings TEXT,
      FOREIGN KEY (target_deployment_id) REFERENCES deployments(deployment_id),
      FOREIGN KEY (evaluator_deployment_id) REFERENCES deployments(deployment_id),
      UNIQUE(target_deployment_id, evaluator_deployment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evaluator_target ON evaluator_ratings(target_deployment_id);
    CREATE INDEX IF NOT EXISTS idx_evaluator_evaluator ON evaluator_ratings(evaluator_deployment_id);
    CREATE INDEX IF NOT EXISTS idx_evaluator_created_at ON evaluator_ratings(created_at);
    CREATE TABLE IF NOT EXISTS health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      overall_score INTEGER NOT NULL,
      window_since TEXT NOT NULL,
      window_until TEXT NOT NULL,
      categories TEXT NOT NULL,
      findings_summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_health_timestamp ON health_snapshots(timestamp);
  `);

  addColumn(db, "registry_events", "fallback", "INTEGER DEFAULT 0");
  addColumn(db, "registry_events", "resumed_from_deployment_id", "TEXT");
  addColumn(db, "registry_events", "note", "TEXT");
  addColumn(db, "registry_events", "runtime", "TEXT");
  addColumn(db, "registry_events", "binary", "TEXT");
  addColumn(db, "registry_events", "effective_timeout_seconds", "INTEGER");
  addColumn(db, "registry_events", "mode", "TEXT");
  addColumn(db, "deployments", "fallback", "INTEGER DEFAULT 0");
  addColumn(db, "deployments", "resumed_from_deployment_id", "TEXT");
  addColumn(db, "deployments", "runtime", "TEXT");
  addColumn(db, "deployments", "binary", "TEXT");
  addColumn(db, "deployments", "effective_timeout_seconds", "INTEGER");
  addColumn(db, "deployments", "mode", "TEXT");
  db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

function addColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
