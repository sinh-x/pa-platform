import { getDb } from "./db.js";
import type { DeploymentStatus, RegistryEvent } from "../types.js";

// Ported from PA registry.ts/registry-db.ts at frozen PA source on 2026-04-26; runtime/binary columns are additive for pa-platform.

export { closeDb, getDb } from "./db.js";

export function validateRegistryEvent(event: RegistryEvent): void {
  for (const field of ["deployment_id", "team", "event", "timestamp"] as const) {
    if (!event[field]) throw new Error(`Registry event missing required field: ${field}`);
  }
}

export function appendRegistryEvent(event: RegistryEvent): void {
  validateRegistryEvent(event);
  const db = getDb();
  const row = toRow(event);
  db.prepare(`
    INSERT INTO registry_events (
      deployment_id, team, event, timestamp, pid, status, summary, log_file,
      primer, agents, models, error, exit_code, ticket_id, provider, rating,
      objective, repo, fallback, resumed_from_deployment_id, note, runtime, binary
    ) VALUES (
      @deployment_id, @team, @event, @timestamp, @pid, @status, @summary, @log_file,
      @primer, @agents, @models, @error, @exit_code, @ticket_id, @provider, @rating,
      @objective, @repo, @fallback, @resumed_from_deployment_id, @note, @runtime, @binary
    )
  `).run(row);
  upsertDeployment(db, event);
}

export function readRegistry(): RegistryEvent[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM registry_events ORDER BY id").all() as Record<string, unknown>[]).map(fromRow);
}

export function getDeploymentEvents(deployId: string): RegistryEvent[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM registry_events WHERE deployment_id = ? ORDER BY id").all(deployId) as Record<string, unknown>[]).map(fromRow);
}

export function queryDeploymentStatuses(): DeploymentStatus[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM deployments ORDER BY started_at DESC").all() as Record<string, unknown>[]).map(deploymentFromRow);
}

export function queryDeploymentStatus(deployId: string): DeploymentStatus | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM deployments WHERE deployment_id = ?").get(deployId) as Record<string, unknown> | undefined;
  return row ? deploymentFromRow(row) : null;
}

export function computeDeploymentStatuses(events: RegistryEvent[]): DeploymentStatus[] {
  const grouped = new Map<string, RegistryEvent[]>();
  for (const event of events) grouped.set(event.deployment_id, [...(grouped.get(event.deployment_id) ?? []), event]);
  return [...grouped.entries()].map(([deployId, deploymentEvents]) => {
    const started = deploymentEvents.find((event) => event.event === "started");
    const completed = deploymentEvents.find((event) => event.event === "completed");
    const crashed = deploymentEvents.find((event) => event.event === "crashed");
    const pid = deploymentEvents.find((event) => event.event === "pid");
    return {
      deploy_id: deployId,
      team: started?.team ?? deploymentEvents[0]?.team ?? "",
      status: (completed?.status ?? (crashed ? "crashed" : started ? "running" : "unknown")) as DeploymentStatus["status"],
      started_at: started?.timestamp ?? deploymentEvents[0]?.timestamp ?? "",
      completed_at: completed?.timestamp ?? crashed?.timestamp,
      pid: pid?.pid,
      agents: started?.agents ?? [],
      summary: completed?.summary,
      log_file: completed?.log_file ?? started?.log_file,
      primer: started?.primer,
      ticket_id: started?.ticket_id,
      objective: started?.objective,
      models: started?.models,
      provider: started?.provider,
      repo: started?.repo,
      fallback: completed?.fallback,
      resumed_from_deployment_id: started?.resumed_from_deployment_id,
      runtime: started?.runtime,
      binary: started?.binary,
    };
  }).sort((a, b) => b.started_at.localeCompare(a.started_at));
}

function upsertDeployment(db: ReturnType<typeof getDb>, event: RegistryEvent): void {
  const row = toRow(event);
  if (event.event === "started") {
    db.prepare(`
      INSERT INTO deployments (
        deployment_id, team, status, started_at, pid, primer, agents, models,
        ticket_id, objective, repo, provider, resumed_from_deployment_id, runtime, binary
      ) VALUES (
        @deployment_id, @team, 'running', @timestamp, @pid, @primer, @agents, @models,
        @ticket_id, @objective, @repo, @provider, @resumed_from_deployment_id, @runtime, @binary
      ) ON CONFLICT(deployment_id) DO UPDATE SET
        status = excluded.status,
        started_at = excluded.started_at,
        pid = excluded.pid,
        primer = excluded.primer,
        agents = excluded.agents,
        models = excluded.models,
        ticket_id = excluded.ticket_id,
        objective = excluded.objective,
        repo = excluded.repo,
        provider = excluded.provider,
        resumed_from_deployment_id = excluded.resumed_from_deployment_id,
        runtime = excluded.runtime,
        binary = excluded.binary
    `).run(row);
  } else if (event.event === "pid") {
    db.prepare("UPDATE deployments SET pid = ? WHERE deployment_id = ?").run(event.pid ?? null, event.deployment_id);
  } else if (event.event === "completed") {
    db.prepare(`
      UPDATE deployments SET status = @status, completed_at = @timestamp, summary = @summary,
        log_file = @log_file, rating = @rating, exit_code = @exit_code, fallback = @fallback
      WHERE deployment_id = @deployment_id
    `).run({ ...row, status: event.status ?? "success" });
  } else if (event.event === "crashed") {
    db.prepare("UPDATE deployments SET status = 'crashed', completed_at = @timestamp, error = @error, exit_code = @exit_code WHERE deployment_id = @deployment_id").run(row);
  }
}

function toRow(event: RegistryEvent): Record<string, unknown> {
  return {
    deployment_id: event.deployment_id,
    team: event.team,
    event: event.event,
    timestamp: event.timestamp,
    pid: event.pid ?? null,
    status: event.status ?? null,
    summary: event.summary ?? null,
    log_file: event.log_file ?? null,
    primer: event.primer ?? null,
    agents: event.agents ? JSON.stringify(event.agents) : null,
    models: event.models ? JSON.stringify(event.models) : null,
    error: event.error ?? null,
    exit_code: event.exit_code ?? null,
    ticket_id: event.ticket_id ?? null,
    provider: event.provider ?? null,
    rating: event.rating ? JSON.stringify(event.rating) : null,
    objective: event.objective ?? null,
    repo: event.repo ?? null,
    fallback: event.fallback ? 1 : 0,
    resumed_from_deployment_id: event.resumed_from_deployment_id ?? null,
    note: event.note ?? null,
    runtime: event.runtime ?? null,
    binary: event.binary ?? null,
  };
}

function fromRow(row: Record<string, unknown>): RegistryEvent {
  return {
    deployment_id: String(row["deployment_id"]),
    team: String(row["team"]),
    event: row["event"] as RegistryEvent["event"],
    timestamp: String(row["timestamp"]),
    pid: optionalNumber(row["pid"]),
    status: row["status"] as RegistryEvent["status"],
    summary: optionalString(row["summary"]),
    log_file: optionalString(row["log_file"]),
    primer: optionalString(row["primer"]),
    agents: parseJson<string[]>(row["agents"]),
    models: parseJson<Record<string, string>>(row["models"]),
    error: optionalString(row["error"]),
    exit_code: optionalNumber(row["exit_code"]),
    ticket_id: optionalString(row["ticket_id"]),
    provider: optionalString(row["provider"]),
    rating: parseJson<RegistryEvent["rating"]>(row["rating"]),
    objective: optionalString(row["objective"]),
    repo: optionalString(row["repo"]),
    fallback: Boolean(row["fallback"]),
    resumed_from_deployment_id: optionalString(row["resumed_from_deployment_id"]),
    note: optionalString(row["note"]),
    runtime: row["runtime"] as RegistryEvent["runtime"],
    binary: optionalString(row["binary"]),
  };
}

function deploymentFromRow(row: Record<string, unknown>): DeploymentStatus {
  return {
    deploy_id: String(row["deployment_id"]),
    team: String(row["team"]),
    status: row["status"] as DeploymentStatus["status"],
    started_at: String(row["started_at"] ?? ""),
    completed_at: optionalString(row["completed_at"]),
    pid: optionalNumber(row["pid"]),
    agents: parseJson<string[]>(row["agents"]) ?? [],
    summary: optionalString(row["summary"]),
    log_file: optionalString(row["log_file"]),
    primer: optionalString(row["primer"]),
    ticket_id: optionalString(row["ticket_id"]),
    objective: optionalString(row["objective"]),
    models: parseJson<Record<string, string>>(row["models"]),
    provider: optionalString(row["provider"]),
    repo: optionalString(row["repo"]),
    fallback: Boolean(row["fallback"]),
    resumed_from_deployment_id: optionalString(row["resumed_from_deployment_id"]),
    runtime: row["runtime"] as DeploymentStatus["runtime"],
    binary: optionalString(row["binary"]),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return JSON.parse(value) as T;
}
