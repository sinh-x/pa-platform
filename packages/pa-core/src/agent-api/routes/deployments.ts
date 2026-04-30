import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getDeploymentDir } from "../../paths.js";
import { computeDeploymentStatuses, getDeploymentEvents, getDeploymentsByTicketId, readRegistry } from "../../registry/index.js";
import { readDeploymentActivity } from "../../activity/index.js";
import { nowUtc } from "../../time.js";
import type { ActivityEvent } from "../../activity/index.js";
import type { DeploymentStatus, RegistryEvent } from "../../types.js";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(date: string): boolean {
  return DATE_REGEX.test(date) && !Number.isNaN(new Date(date).getTime());
}

export function getTodayDateString(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function get48HoursAgoISO(now = new Date()): string {
  const then = new Date(now);
  then.setUTCHours(then.getUTCHours() - 48);
  return nowUtc(then);
}

export function deploymentsRoutes(): Hono {
  const app = new Hono();

  app.get("/api/deployments", (c) => {
    const sinceParam = c.req.query("since");
    if (sinceParam && !isValidDateString(sinceParam)) return c.json({ error: "Invalid 'since' parameter. Expected YYYY-MM-DD format.", code: "BAD_REQUEST" }, 400);
    const since = c.req.query("all") === "true" ? undefined : sinceParam ?? get48HoursAgoISO();
    const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const ticketId = c.req.query("ticket_id");
    let deployments = ticketId ? getDeploymentsByTicketId(ticketId) : computeDeploymentStatuses(readRegistry());
    if (since) deployments = deployments.filter((deployment) => deployment.started_at >= since);
    return c.json({ deployments: deployments.slice(0, limit), total: deployments.length, filter: { since, limit, status: "all", ticket_id: ticketId ?? null } });
  });

  app.get("/api/deployments/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidDeploymentId(id)) return c.json({ error: "Invalid deployment id", code: "BAD_REQUEST" }, 400);
    const events = getDeploymentEvents(id);
    if (events.length === 0) return c.json({ error: "Deployment not found", code: "NOT_FOUND" }, 404);
    return c.json(deploymentDetail(id, events));
  });

  app.get("/api/deployments/:id/activity", (c) => {
    const id = c.req.param("id");
    if (!isValidDeploymentId(id)) return c.json({ error: "Invalid deployment id", code: "BAD_REQUEST" }, 400);
    const since = c.req.query("since");
    const activity = readDeploymentActivity(id).filter((event) => !since || event.timestamp > since).map(toPhoneActivityEvent);
    const registryEvents = activity.length > 0 ? [] : getDeploymentEvents(id).filter((event) => !since || event.timestamp > since).map(registryToPhoneActivityEvent);
    return c.json({ activity_events: activity.length > 0 ? activity : registryEvents });
  });

  return app;
}

function isValidDeploymentId(id: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(id);
}

function deploymentDetail(id: string, events: ReturnType<typeof getDeploymentEvents>): DeploymentStatus & { primer_path?: string; error?: string; exit_code?: number; rating?: unknown } {
  const status = computeDeploymentStatuses(events)[0]!;
  const completed = events.find((event) => event.event === "completed");
  const crashed = events.find((event) => event.event === "crashed");
  const primerPath = resolve(getDeploymentDir(id), "primer.md");
  return { ...status, primer_path: existsSync(primerPath) ? `deployments/${id}/primer.md` : undefined, error: completed?.error ?? crashed?.error, exit_code: completed?.exit_code ?? crashed?.exit_code, rating: completed?.rating };
}

function toPhoneActivityEvent(event: ActivityEvent): Record<string, unknown> {
  return {
    ts: event.timestamp,
    deploy_id: event.deployId,
    agent: event.source,
    event: phoneEventName(event),
    data: {
      body: event.body,
      kind: event.kind,
      ...(event.partType ? { partType: event.partType } : {}),
      ...(event.metadata ? compactActivityMetadata(event.metadata) : {}),
    },
  };
}

function phoneEventName(event: ActivityEvent): string {
  if (event.kind === "thinking") return "thinking";
  if (event.kind === "tool_use" || event.kind === "tool_result") return "tool_use_detail";
  if (event.kind === "error") return "task_failed";
  return "text";
}

function registryToPhoneActivityEvent(event: RegistryEvent): Record<string, unknown> {
  const eventName = event.event === "started" ? "deployment_started" : event.event === "completed" || event.event === "crashed" ? "deployment_completed" : event.event;
  return {
    ts: event.timestamp,
    deploy_id: event.deployment_id,
    agent: event.team,
    event: eventName,
    data: {
      status: event.status,
      summary: event.summary,
      error: event.error,
      pid: event.pid,
      ticket_id: event.ticket_id,
      repo: event.repo,
    },
  };
}

function compactActivityMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const data = recordValue(metadata["data"]);
  const part = recordValue(metadata["part"]);
  const state = recordValue(part?.["state"]);
  const input = recordValue(state?.["input"]);
  return {
    ...(stringValue(part?.["tool"] ?? metadata["tool"]) ? { tool: stringValue(part?.["tool"] ?? metadata["tool"]) } : {}),
    ...(stringValue(state?.["status"]) ? { status: stringValue(state?.["status"]) } : {}),
    ...(input ? { input: JSON.stringify(input) } : {}),
    ...(stringValue(data?.["message"] ?? metadata["message"]) ? { message: stringValue(data?.["message"] ?? metadata["message"]) } : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
