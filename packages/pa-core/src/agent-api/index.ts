import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Server } from "node:http";
import type { Http2SecureServer, Http2Server } from "node:http2";
import type { spawn as spawnType } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import type { CoreExecutionHooks } from "../deploy/index.js";
import { isInsideSandbox, normalizeSandboxPath } from "./utils/sandbox.js";
import { actionRoutes, bulletinRoutes, configRoutes, dashboardRoutes, deployControlRoutes, deploymentsRoutes, deployRoutingRoutes, deployStatusRoutes, documentsRoutes, focusRoutes, foldersRoutes, knowledgeRoutes, repoCommitsRoutes, repoDeploymentsRoutes, repoGitExtRoutes, reposRoutes, sessionRoutes, skillsRoutes, teamsRoutes, ticketRoutes, timersRoutes } from "./routes/index.js";
import { hub, startWatchers } from "./ws/index.js";
import { SessionManager, type SessionStreamEvent } from "./ws/session-hub.js";
import { resolveTrustedTicketMutationContext, TicketStore } from "../tickets/store.js";
import type { TicketMutationPrincipal } from "../tickets/store.js";

export interface AgentApiOptions {
  enableCors?: boolean;
  hooks?: CoreExecutionHooks;
  enableLiveUpdates?: boolean;
  /**
   * Test seam for the /ws/session SessionManager spawn function. Production
   * callers leave this unset so the real `child_process.spawn` is used; tests
   * inject a fake to verify WebSocket message handling without spawning opencode.
   */
  sessionSpawnFn?: typeof spawnType;
  /**
   * When true, dev mode is active and the `SessionManager` consults the
   * `PA_OPENCODE_BINARY` env var before falling back to `"opencode"` on PATH.
   * Propagated from `pa-core serve --dev` / `PA_DEV_MODE`. See FR6.
   */
  devMode?: boolean;
  /** Credentials issued/configured by the server owner for ticket mutations. */
  ticketMutationAuth?: {
    deploymentId?: string;
    credential?: string;
    operatorCredential?: string;
  };
}

export interface AgentApiInstance {
  app: Hono;
  injectWebSocket: (server: Server | Http2Server | Http2SecureServer) => void;
  cleanup: () => void;
}

export function createAgentApiApp(opts: AgentApiOptions = {}): AgentApiInstance {
  const app = new Hono();
  const ticketStore = new TicketStore(undefined, { privileged: false });
  const mutationAuth = opts.ticketMutationAuth ?? {
    deploymentId: process.env["PA_DEPLOYMENT_ID"],
    credential: process.env["PA_AGENT_API_CREDENTIAL"],
    operatorCredential: process.env["PA_AGENT_API_OPERATOR_CREDENTIAL"],
  };
  const callerMutationContext = (c: Context) => resolveTrustedTicketMutationContext(authenticateMutationPrincipal(c, mutationAuth), true);
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  if (opts.enableCors) app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Av-Pair-Token", "X-Av-Node-Id", "X-PA-Deployment-ID"],
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
  // Phase 2: WebSocket session endpoint at /ws/session.
  // One SessionManager is shared across all connections; each connection
  // tracks its own active session id and auto-terminates on disconnect.
  const sessionManager = new SessionManager({
    normalizer: opts.hooks?.sessionNormalizer,
    runtimes: opts.hooks?.runtimeHooks,
    runtimeNormalizers: {
      ...(opts.hooks?.runtimeHooks?.opencode?.sessionNormalizer ? { opencode: opts.hooks.runtimeHooks.opencode.sessionNormalizer } : {}),
      ...(opts.hooks?.runtimeHooks?.pi?.sessionNormalizer ? { pi: opts.hooks.runtimeHooks.pi.sessionNormalizer } : {}),
    },
    runtimeCommands: {
      ...(opts.hooks?.runtimeHooks?.opencode?.sessionCommand ? { opencode: opts.hooks.runtimeHooks.opencode.sessionCommand } : {}),
      ...(opts.hooks?.runtimeHooks?.pi?.sessionCommand ? { pi: opts.hooks.runtimeHooks.pi.sessionCommand } : {}),
    },
    devMode: opts.devMode === true,
    ...(opts.sessionSpawnFn ? { spawnFn: opts.sessionSpawnFn } : {}),
  });
  app.get("/ws/session", upgradeWebSocket(() => {
    let activeSessionId: string | undefined;
    const pendingMessages: string[] = [];
    let sessionWs: { send(message: string): void; readyState: number } = { send(message: string) { pendingMessages.push(message); }, readyState: 3 };
    const sink = {
      send(event: SessionStreamEvent): void {
        if (event.type === "end" || event.type === "error") activeSessionId = undefined;
        // WSContext.send is provided by @hono/node-ws at runtime; readyState 1 = OPEN.
        // Late sends after close are silently dropped by the sink guard below.
        try { sessionWs.send(JSON.stringify(event)); } catch { /* socket closed */ }
      },
    };
    return {
      onOpen(_event, ws) {
        sessionWs = ws as unknown as { send(message: string): void; readyState: number };
        // Flush any messages buffered before the WebSocket opened.
        while (pendingMessages.length > 0) {
          const buffered = pendingMessages.shift();
          if (buffered !== undefined) {
            try { sessionWs.send(buffered); } catch { /* socket closed during flush */ }
          }
        }
      },
      onMessage(event) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          sink.send({ type: "error", message: "Invalid JSON message", timestamp: new Date().toISOString() });
          return;
        }
        const type = typeof parsed["type"] === "string" ? parsed["type"] : undefined;
        if (type === "start") {
          if (activeSessionId) {
            sink.send({ type: "error", message: "Session already started on this connection", timestamp: new Date().toISOString() });
            return;
          }
          const prompt = typeof parsed["prompt"] === "string" ? parsed["prompt"] : "";
          if (!prompt) {
            sink.send({ type: "error", message: "Missing prompt", timestamp: new Date().toISOString() });
            return;
          }
           const model = typeof parsed["model"] === "string" ? parsed["model"] : undefined;
           const runtime = parseSessionRuntime(parsed["runtime"]);
           if (parsed["runtime"] !== undefined && !runtime) {
             sink.send({ type: "error", message: "runtime must be opencode or pi", timestamp: new Date().toISOString() });
             return;
           }
           const result = sessionManager.start({ prompt, ...(model ? { model } : {}), ...(runtime ? { runtime } : {}) }, sink);
          if (result.ok) {
            activeSessionId = result.session.id;
            sink.send({ type: "session-id", sessionId: result.session.id, timestamp: new Date().toISOString() });
          } else {
            sink.send({ type: "error", message: result.error, timestamp: new Date().toISOString() });
          }
        } else if (type === "resume") {
          if (activeSessionId) {
            sink.send({ type: "error", message: "Session already started on this connection", timestamp: new Date().toISOString() });
            return;
          }
          const sessionId = typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : "";
          const prompt = typeof parsed["prompt"] === "string" ? parsed["prompt"] : "";
          if (!sessionId || !prompt) {
            sink.send({ type: "error", message: "Missing sessionId or prompt", timestamp: new Date().toISOString() });
            return;
          }
           const model = typeof parsed["model"] === "string" ? parsed["model"] : undefined;
           const runtime = parseSessionRuntime(parsed["runtime"]);
           if (parsed["runtime"] !== undefined && !runtime) {
             sink.send({ type: "error", message: "runtime must be opencode or pi", timestamp: new Date().toISOString() });
             return;
           }
           const result = sessionManager.resume({ prompt, sessionId, ...(model ? { model } : {}), ...(runtime ? { runtime } : {}) }, sink);
          if (result.ok) {
            activeSessionId = result.session.id;
            sink.send({ type: "session-id", sessionId: result.session.id, timestamp: new Date().toISOString() });
          } else {
            sink.send({ type: "error", message: result.error, timestamp: new Date().toISOString() });
          }
        } else if (type === "stop") {
          if (!activeSessionId) {
            sink.send({ type: "error", message: "No active session to stop", timestamp: new Date().toISOString() });
            return;
          }
          const stopped = sessionManager.stop(activeSessionId);
          activeSessionId = undefined;
          if (stopped.ok) sink.send({ type: "end", data: { reason: "stopped" }, timestamp: new Date().toISOString() });
          else sink.send({ type: "error", message: stopped.error, timestamp: new Date().toISOString() });
        } else {
          sink.send({ type: "error", message: `Unknown message type: ${type ?? "missing"}`, timestamp: new Date().toISOString() });
        }
      },
      onClose() {
        if (activeSessionId) {
          sessionManager.disconnect(activeSessionId);
          activeSessionId = undefined;
        }
      },
      onError() {
        if (activeSessionId) {
          sessionManager.disconnect(activeSessionId);
          activeSessionId = undefined;
        }
      },
    };
  }));
  app.route("/", configRoutes());
  app.route("/", deployControlRoutes(opts.hooks, sessionManager));
  app.route("/", deploymentsRoutes());
  app.route("/", deployRoutingRoutes());
  app.route("/", deployStatusRoutes());
  app.route("/", reposRoutes());
  app.route("/", repoCommitsRoutes());
  app.route("/", repoDeploymentsRoutes());
  app.route("/", repoGitExtRoutes());
  app.route("/", teamsRoutes());
  app.route("/", skillsRoutes());
  app.route("/", knowledgeRoutes());
  app.route("/", dashboardRoutes(ticketStore));
  app.route("/", timersRoutes());
  app.route("/", ticketRoutes(ticketStore, callerMutationContext));
  app.route("/", actionRoutes(ticketStore));
  app.route("/", focusRoutes());
  app.route("/", bulletinRoutes());
  app.route("/", documentsRoutes());
  app.route("/", foldersRoutes());
  // Phase 3: REST endpoints for session lifecycle (list / stop / SSE stream).
  app.route("/", sessionRoutes(sessionManager));
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
      sessionManager.cleanup();
    },
  };
}

function authenticateMutationPrincipal(c: Context, auth: NonNullable<AgentApiOptions["ticketMutationAuth"]>): TicketMutationPrincipal {
  const authorization = c.req.header("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const claimedDeploymentId = c.req.header("X-PA-Deployment-ID");
  if (!token) return {};
  if (credentialsMatch(token, auth.operatorCredential)) {
    return claimedDeploymentId ? {} : { operator: true };
  }
  if (!auth.deploymentId || !credentialsMatch(token, auth.credential)) return {};
  if (claimedDeploymentId !== undefined && claimedDeploymentId !== auth.deploymentId) return {};
  return { deploymentId: auth.deploymentId };
}

function credentialsMatch(presented: string | undefined, configured: string | undefined): boolean {
  if (!presented || !configured) return false;
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const configuredDigest = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(presentedDigest, configuredDigest);
}

function parseSessionRuntime(value: unknown): "opencode" | "pi" | undefined {
  return value === "opencode" || value === "pi" ? value : undefined;
}

export const createApp = createAgentApiApp;

export * from "./utils/index.js";
export * from "./routes/index.js";
export * from "./ws/index.js";
