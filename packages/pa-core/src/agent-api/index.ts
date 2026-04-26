import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, Next } from "hono";
import { isInsideSandbox, normalizeSandboxPath } from "./utils/sandbox.js";
import { bulletinRoutes, configRoutes, deployControlRoutes, deploymentsRoutes, deployRoutingRoutes, deployStatusRoutes, documentsRoutes, focusRoutes, foldersRoutes, repoCommitsRoutes, repoDeploymentsRoutes, repoGitExtRoutes, reposRoutes, teamsRoutes, ticketRoutes, timersRoutes } from "./routes/index.js";
import type { AgentApiHooks } from "./routes/index.js";

export interface AgentApiOptions {
  enableCors?: boolean;
  hooks?: AgentApiHooks;
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
  app.route("/", deployControlRoutes(opts.hooks));
  app.route("/", deploymentsRoutes());
  app.route("/", deployRoutingRoutes());
  app.route("/", deployStatusRoutes());
  app.route("/", reposRoutes());
  app.route("/", repoCommitsRoutes());
  app.route("/", repoDeploymentsRoutes());
  app.route("/", repoGitExtRoutes());
  app.route("/", teamsRoutes());
  app.route("/", timersRoutes());
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
