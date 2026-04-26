import { Hono } from "hono";
import { validateDeployRequestFields } from "../../deploy/index.js";
import type { CoreExecutionHooks as AgentApiHooks, DeployRequest } from "../../deploy/index.js";

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

  return validateDeployRequestFields(body);
}
