import { Hono } from "hono";

const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 7200;

export interface DeployRequest {
  team: string;
  mode?: string;
  objective?: string;
  repo?: string;
  ticket?: string;
  timeout?: number;
}

export interface DeployHookResult {
  status: "pending" | "failed";
  team?: string;
  mode?: string | null;
  reason?: string;
  deploymentId?: string;
}

export interface SelfUpdateStatusResult {
  status: "idle" | "building" | "success" | "error";
  startedAt: string | null;
  completedAt: string | null;
  log: string[];
}

export interface SelfUpdateStartResult extends SelfUpdateStatusResult {
  status: "building" | "success" | "error";
}

export interface AgentApiHooks {
  deploy?(request: DeployRequest): Promise<DeployHookResult> | DeployHookResult;
  selfUpdate?(): Promise<SelfUpdateStartResult> | SelfUpdateStartResult;
  getSelfUpdateStatus?(): Promise<SelfUpdateStatusResult> | SelfUpdateStatusResult;
}

export function deployControlRoutes(hooks: AgentApiHooks = {}): Hono {
  const app = new Hono();

  app.post("/api/deploy", async (c) => {
    const parsed = await parseDeployRequest(c.req.json.bind(c.req));
    if ("error" in parsed) return c.json({ error: parsed.error, code: "BAD_REQUEST" }, 400);
    if (!hooks.deploy) return c.json({ error: "Deployment execution requires an adapter hook", code: "NOT_IMPLEMENTED" }, 501);
    try {
      const result = await hooks.deploy(parsed.request);
      return c.json({ team: parsed.request.team, mode: parsed.request.mode ?? null, ...result }, 202);
    } catch (error) {
      return c.json({ status: "failed", reason: error instanceof Error ? error.message : String(error), team: parsed.request.team, mode: parsed.request.mode ?? null }, 202);
    }
  });

  app.post("/api/self-update", async (c) => {
    if (!hooks.selfUpdate) return c.json({ error: "Self-update execution requires an adapter hook", code: "NOT_IMPLEMENTED" }, 501);
    const result = await hooks.selfUpdate();
    return c.json(result, 202);
  });

  app.get("/api/self-update/status", async (c) => {
    if (!hooks.getSelfUpdateStatus) return c.json({ error: "Self-update status requires an adapter hook", code: "NOT_IMPLEMENTED" }, 501);
    return c.json(await hooks.getSelfUpdateStatus());
  });

  return app;
}

async function parseDeployRequest(readJson: () => Promise<unknown>): Promise<{ request: DeployRequest } | { error: string }> {
  let body: Record<string, unknown>;
  try {
    const parsed = await readJson();
    body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return { error: "Invalid JSON body" };
  }

  const team = stringField(body, "team");
  const mode = stringField(body, "mode");
  const objective = stringField(body, "objective");
  const repo = stringField(body, "repo");
  const ticket = stringField(body, "ticket");
  const rawTimeout = body["timeout"];
  const timeout = typeof rawTimeout === "number" ? rawTimeout : undefined;

  if (!team?.trim()) return { error: "team is required" };
  if (!isSafeIdentifier(team)) return { error: "Invalid team name" };
  if (mode && !isSafeIdentifier(mode)) return { error: "Invalid mode name" };
  if (repo && !isSafeIdentifier(repo)) return { error: "Invalid repo name" };
  if (ticket && !/^[A-Z][A-Z0-9]+-[0-9]+$/.test(ticket)) return { error: "Invalid ticket ID" };
  if (rawTimeout !== undefined && typeof rawTimeout !== "number") return { error: "timeout must be a number" };
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_SECONDS || timeout > MAX_TIMEOUT_SECONDS)) return { error: `timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds` };
  if (objective && objective.trim()) {
    if (objective.length > 500) return { error: "objective exceeds max length of 500 characters" };
    if (/[\x00-\x1f\x7f`$\\;&|><]/.test(objective)) return { error: "objective contains invalid characters" };
  }

  return { request: { team, mode, objective: objective?.trim(), repo, ticket: ticket?.trim(), timeout: timeout as number | undefined } };
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}
