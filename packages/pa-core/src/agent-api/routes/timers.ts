import { Hono } from "hono";
import { listSystemdTimers } from "../../timers.js";
export { parseTimersOutput } from "../../timers.js";

export function timersRoutes(): Hono {
  const app = new Hono();
  app.get("/api/timers", (c) => {
    try {
      return c.json(listSystemdTimers());
    } catch (error) {
      return c.json({ error: `Failed to list timers: ${error instanceof Error ? error.message : String(error)}`, code: "INTERNAL_ERROR" }, 500);
    }
  });
  return app;
}
