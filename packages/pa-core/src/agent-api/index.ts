import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, Next } from "hono";
import { isInsideSandbox, normalizeSandboxPath } from "./utils/sandbox.js";
import { bulletinRoutes, configRoutes, documentsRoutes, focusRoutes, foldersRoutes, reposRoutes, teamsRoutes, ticketRoutes } from "./routes/index.js";

export interface AgentApiOptions {
  enableCors?: boolean;
}

export interface AgentApiInstance {
  app: Hono;
}

export function createAgentApiApp(opts: AgentApiOptions = {}): AgentApiInstance {
  const app = new Hono();
  if (opts.enableCors) app.use("*", cors());
  app.use("*", async (c: Context, next: Next) => {
    const pathParam = c.req.query("path");
    if (pathParam !== undefined && !isInsideSandbox(normalizeSandboxPath(pathParam))) return c.json({ error: "Path traversal denied", code: "SANDBOX_VIOLATION" }, 403);
    if (c.req.path.includes("..")) return c.json({ error: "Invalid path", code: "BAD_REQUEST" }, 400);
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message, code: "INTERNAL_ERROR" }, 500));
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.route("/", configRoutes());
  app.route("/", reposRoutes());
  app.route("/", teamsRoutes());
  app.route("/", ticketRoutes());
  app.route("/", focusRoutes());
  app.route("/", bulletinRoutes());
  app.route("/", documentsRoutes());
  app.route("/", foldersRoutes());
  return { app };
}

export const createApp = createAgentApiApp;

export * from "./utils/index.js";
export * from "./routes/index.js";
