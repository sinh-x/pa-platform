import { Hono } from "hono";
import { buildFocusList } from "../../tickets/focus.js";

export function focusRoutes(): Hono {
  const app = new Hono();
  app.get("/api/focus", (c) => {
    const result = buildFocusList({ project: c.req.query("project") || undefined, assignee: c.req.query("assignee") || undefined, includeAll: c.req.query("all") === "true" });
    return c.json({ focus: result.focus, wip: result.wip, ...(c.req.query("enrich") === "true" ? { suggestions: [], report_age_minutes: null } : {}) });
  });
  return app;
}
