import { Hono } from "hono";
import { getDeploymentEvents, queryDeploymentStatus } from "../../registry/index.js";
import { emitAmendedEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent } from "../../deploy/index.js";
import type { RuntimeName } from "../../types.js";

export interface StartDeployBody {
  deploymentId: string;
  team: string;
  primer?: string;
  agents?: string[];
  models?: Record<string, string>;
  ticketId?: string;
  objective?: string;
  provider?: string;
  repo?: string;
  runtime?: RuntimeName;
  binary?: string;
  resumedFromDeploymentId?: string;
}

export interface PidBody {
  deploymentId: string;
  team: string;
  pid: number;
}

export interface CompleteBody {
  deploymentId: string;
  team: string;
  status?: "success" | "partial" | "failed";
  summary?: string;
  logFile?: string;
  exitCode?: number;
  fallback?: boolean;
}

export interface CrashBody {
  deploymentId: string;
  team: string;
  error?: string;
  exitCode?: number;
}

export interface AmendedBody {
  deploymentId: string;
  team: string;
  note?: string;
  status?: "success" | "partial" | "failed";
  summary?: string;
}

export function deployStatusRoutes(): Hono {
  const app = new Hono();

  // GET /api/deploy/status/:id - get deployment status
  app.get("/api/deploy/status/:id", (c) => {
    const id = c.req.param("id");
    const status = queryDeploymentStatus(id);
    if (!status) return c.json({ error: "Deployment not found", code: "NOT_FOUND" }, 404);
    return c.json({ status });
  });

  // GET /api/deploy/events/:id - get deployment events
  app.get("/api/deploy/events/:id", (c) => {
    const id = c.req.param("id");
    const events = getDeploymentEvents(id);
    return c.json({ events });
  });

  // POST /api/deploy/start - emit started event
  app.post("/api/deploy/start", async (c) => {
    const body = await c.req.json<StartDeployBody>();
    if (!body.deploymentId || !body.team) {
      return c.json({ error: "deploymentId and team are required", code: "BAD_REQUEST" }, 400);
    }
    emitStartedEvent({
      deploymentId: body.deploymentId,
      team: body.team,
      primer: body.primer,
      agents: body.agents,
      models: body.models,
      ticketId: body.ticketId,
      objective: body.objective,
      provider: body.provider,
      repo: body.repo,
      runtime: body.runtime,
      binary: body.binary,
      resumedFromDeploymentId: body.resumedFromDeploymentId,
    });
    return c.json({ ok: true, event: "started" });
  });

  // POST /api/deploy/pid - emit pid event
  app.post("/api/deploy/pid", async (c) => {
    const body = await c.req.json<PidBody>();
    if (!body.deploymentId || !body.team || body.pid === undefined) {
      return c.json({ error: "deploymentId, team, and pid are required", code: "BAD_REQUEST" }, 400);
    }
    emitPidEvent({ deploymentId: body.deploymentId, team: body.team, pid: body.pid });
    return c.json({ ok: true, event: "pid" });
  });

  // POST /api/deploy/complete - emit completed event
  app.post("/api/deploy/complete", async (c) => {
    const body = await c.req.json<CompleteBody>();
    if (!body.deploymentId || !body.team) {
      return c.json({ error: "deploymentId and team are required", code: "BAD_REQUEST" }, 400);
    }
    emitCompletedEvent({
      deploymentId: body.deploymentId,
      team: body.team,
      status: body.status,
      summary: body.summary,
      logFile: body.logFile,
      exitCode: body.exitCode,
      fallback: body.fallback,
    });
    return c.json({ ok: true, event: "completed" });
  });

  // POST /api/deploy/crash - emit crashed event
  app.post("/api/deploy/crash", async (c) => {
    const body = await c.req.json<CrashBody>();
    if (!body.deploymentId || !body.team) {
      return c.json({ error: "deploymentId and team are required", code: "BAD_REQUEST" }, 400);
    }
    emitCrashedEvent({ deploymentId: body.deploymentId, team: body.team, error: body.error, exitCode: body.exitCode });
    return c.json({ ok: true, event: "crashed" });
  });

  // POST /api/deploy/amend - emit amended event
  app.post("/api/deploy/amend", async (c) => {
    const body = await c.req.json<AmendedBody>();
    if (!body.deploymentId || !body.team) {
      return c.json({ error: "deploymentId and team are required", code: "BAD_REQUEST" }, 400);
    }
    emitAmendedEvent({ deploymentId: body.deploymentId, team: body.team, note: body.note, status: body.status, summary: body.summary });
    return c.json({ ok: true, event: "amended" });
  });

  return app;
}
