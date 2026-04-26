import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getRegistryDbPath } from "../paths.js";

let singleton: Database.Database | null = null;
const SCHEMA_VERSION = 7;

export function getDb(dbPath = getRegistryDbPath()): Database.Database {
  if (singleton && dbPath === getRegistryDbPath()) return singleton;
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
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
      fallback INTEGER DEFAULT 0,
      resumed_from_deployment_id TEXT,
      note TEXT,
      runtime TEXT,
      binary TEXT
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
      provider TEXT,
      error TEXT,
      exit_code INTEGER,
      rating TEXT,
      fallback INTEGER DEFAULT 0,
      resumed_from_deployment_id TEXT,
      runtime TEXT,
      binary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_deployment_id ON registry_events(deployment_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON registry_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_deployments_team ON deployments(team);
    CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
    CREATE INDEX IF NOT EXISTS idx_deployments_started_at ON deployments(started_at);
    CREATE INDEX IF NOT EXISTS idx_deployments_ticket_id ON deployments(ticket_id);
  `);

  addColumn(db, "registry_events", "fallback", "INTEGER DEFAULT 0");
  addColumn(db, "registry_events", "resumed_from_deployment_id", "TEXT");
  addColumn(db, "registry_events", "note", "TEXT");
  addColumn(db, "registry_events", "runtime", "TEXT");
  addColumn(db, "registry_events", "binary", "TEXT");
  addColumn(db, "deployments", "fallback", "INTEGER DEFAULT 0");
  addColumn(db, "deployments", "resumed_from_deployment_id", "TEXT");
  addColumn(db, "deployments", "runtime", "TEXT");
  addColumn(db, "deployments", "binary", "TEXT");
  db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

function addColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
