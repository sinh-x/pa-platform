import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Server } from "node:http";
import type { Http2SecureServer, Http2Server } from "node:http2";
import type { Context, Next } from "hono";
import type { CoreExecutionHooks } from "../deploy/index.js";
import { isInsideSandbox, normalizeSandboxPath } from "./utils/sandbox.js";
import { actionRoutes, bulletinRoutes, configRoutes, deployControlRoutes, deploymentsRoutes, deployRoutingRoutes, deployStatusRoutes, documentsRoutes, focusRoutes, foldersRoutes, repoCommitsRoutes, repoDeploymentsRoutes, repoGitExtRoutes, reposRoutes, teamsRoutes, ticketRoutes, timersRoutes } from "./routes/index.js";
import { hub, startWatchers } from "./ws/index.js";

export interface AgentApiOptions {
  enableCors?: boolean;
  hooks?: CoreExecutionHooks;
  enableLiveUpdates?: boolean;
}

export interface AgentApiInstance {
  app: Hono;
  injectWebSocket: (server: Server | Http2Server | Http2SecureServer) => void;
  cleanup: () => void;
}

export function createAgentApiApp(opts: AgentApiOptions = {}): AgentApiInstance {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  if (opts.enableCors) app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Av-Pair-Token", "X-Av-Node-Id"],
    exposeHeaders: ["Content-Length", "Content-Type"],
    maxAge: 600,
  }));
  app.use("*", async (c: Context, next: Next) => {
    const pathParam = c.req.query("path");
    if (pathParam !== undefined && !isInsideSandbox(normalizeSandboxPath(pathParam))) return c.json({ error: "Path traversal denied", code: "SANDBOX_VIOLATION" }, 403);
    if (c.req.path.includes("..")) return c.json({ error: "Invalid path", code: "BAD_REQUEST" }, 400);
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message, code: "INTERNAL_ERROR" }, 500));
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/ws", upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      hub.addClient(ws);
    },
    onMessage(event, ws) {
      try {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message["type"] === "pong") hub.recordPong(ws);
      } catch {
        // Ignore non-JSON heartbeat noise from older clients.
      }
    },
    onClose(_event, ws) {
      hub.removeClient(ws);
    },
    onError(_event, ws) {
      hub.removeClient(ws);
    },
  })));
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
  app.route("/", actionRoutes());
  app.route("/", focusRoutes());
  app.route("/", bulletinRoutes());
  app.route("/", documentsRoutes());
  app.route("/", foldersRoutes());
  let watchers: ReturnType<typeof startWatchers> | null = null;
  if (opts.enableLiveUpdates) {
    hub.startPing();
    watchers = startWatchers(hub, { ensureDirs: true });
  }
  return {
    app,
    injectWebSocket,
    cleanup: () => {
      watchers?.cleanup();
      watchers = null;
      hub.cleanup();
    },
  };
}

export const createApp = createAgentApiApp;

export * from "./utils/index.js";
export * from "./routes/index.js";
export * from "./ws/index.js";
