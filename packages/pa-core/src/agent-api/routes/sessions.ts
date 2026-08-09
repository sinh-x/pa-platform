import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SessionManager, SessionStreamEvent, SessionStreamSink } from "../ws/session-hub.js";

/**
 * REST routes for opencode session lifecycle.
 *
 * - `GET  /api/sessions`         — list active sessions
 * - `POST /api/sessions`         — register a deploy session (CLI `opa deploy`)
 * - `POST /api/sessions/:id/stop` — terminate a session by id
 * - `GET  /api/sessions/:id/stream` — SSE stream of a session's JSONL events
 *
 * The routes are stateless: all session state lives on the shared
 * `SessionManager` instance owned by `createAgentApiApp`.
 */
export function sessionRoutes(sessionManager: SessionManager): Hono {
  const app = new Hono();

  // FR4 / AC3: return a JSON array of active sessions.
  app.get("/api/sessions", (c) => {
    const sessions = sessionManager.list();
    return c.json(sessions);
  });

  // FR3 / AC2: register a deploy session from CLI `opa deploy`.
  // Accepts `{ deploymentId: string, model?: string }` and returns the new
  // session record. Responds 503 when the hub is at capacity (NFR4).
  app.post("/api/sessions", async (c) => {
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
    }
    const deploymentId = typeof body["deploymentId"] === "string" ? body["deploymentId"] : "";
    if (!deploymentId) {
      return c.json({ error: "Missing deploymentId", code: "BAD_REQUEST" }, 400);
    }
    const model = typeof body["model"] === "string" && body["model"].length > 0 ? body["model"] : undefined;
    const result = sessionManager.register(deploymentId, model);
    if (!result.ok) {
      return c.json({ error: result.error, code: "CAPACITY_REACHED", limit: result.limit }, 503);
    }
    return c.json({
      sessionId: result.session.id,
      deploymentId: result.session.deploymentId,
      model: result.session.model,
      status: result.session.status,
    }, 201);
  });

  // FR5 / AC4: terminate a session's opencode process and remove it.
  app.post("/api/sessions/:id/stop", (c) => {
    const id = c.req.param("id");
    const result = sessionManager.stop(id);
    if (!result.ok) return c.json({ error: result.error, code: "NOT_FOUND" }, 404);
    return c.json({ status: "stopped" });
  });

  // FR6: SSE stream of an existing session's events (read-only).
  // The prompt must be sent via WebSocket or POST first; this endpoint only
  // forwards events the session already produces.
  app.get("/api/sessions/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!sessionManager.get(id)) {
      return c.json({ error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    // FR6 / AC4: deploy sessions have no child process — return a distinct
    // 404 message so clients can distinguish "no stream support" from "unknown".
    if (sessionManager.isDeploySession(id)) {
      return c.json({ error: "Deploy sessions do not support streaming", code: "NOT_FOUND" }, 404);
    }
    return streamSSE(c, async (stream) => {
      // Resolve this promise when either the client disconnects (AbortSignal)
      // or the session terminates (end/error event). Either way we unsubscribe
      // and let the stream close, so the connection is never held open forever.
      let resolveWait: () => void;
      const done = new Promise<void>((resolveDone) => {
        resolveWait = resolveDone;
      });
      const sink: SessionStreamSink = {
        send(event: SessionStreamEvent): void {
          if (event.type === "end" || event.type === "error") {
            // Session finished — flush then close the stream.
            void stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
              .catch(() => undefined)
              .finally(() => resolveWait());
            return;
          }
          // writeSSE is async but we must not await inside a synchronous sink;
          // fire-and-forget and let the stream queue handle backpressure.
          void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {
            // client disconnected — ignore write failures
          });
        },
      };
      const unsubscribe = sessionManager.subscribe(id, sink);
      if (!unsubscribe) {
        // Session disappeared between the existence check and subscribe.
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "Session not found" }) });
        return;
      }

      // Send an initial "ready" event so the client knows the stream is live.
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ type: "ready", sessionId: id }) });

      // Close on client disconnect.
      const abort = c.req.raw.signal;
      const onAbort = (): void => {
        unsubscribe();
        resolveWait();
      };
      if (abort.aborted) {
        unsubscribe();
        return;
      }
      abort.addEventListener("abort", onAbort, { once: true });

      await done;
      abort.removeEventListener("abort", onAbort);
      unsubscribe();
    });
  });

  return app;
}