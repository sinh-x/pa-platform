import { Hono } from "hono";
import { BulletinStore } from "../../bulletins/store.js";
import type { BulletinBlock } from "../../bulletins/types.js";

export function bulletinRoutes(store = new BulletinStore()): Hono {
  const app = new Hono();
  app.get("/api/bulletin", (c) => {
    const bulletins = store.readActive();
    return c.json({ bulletins, count: bulletins.length });
  });
  app.post("/api/bulletin", async (c) => {
    let body: { title?: string; block?: BulletinBlock; except?: string[]; message?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400); }
    if (!body.title) return c.json({ error: "title is required", code: "BAD_REQUEST" }, 400);
    if (body.block === undefined) return c.json({ error: "block is required", code: "BAD_REQUEST" }, 400);
    return c.json({ bulletin: store.create({ title: body.title, block: body.block, except: body.except, body: body.message ?? "" }) }, 201);
  });
  app.patch("/api/bulletin/:id", async (c) => {
    let body: { status?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400); }
    if (body.status !== "resolved") return c.json({ error: "Only status=resolved is supported for PATCH", code: "BAD_REQUEST" }, 400);
    if (!store.resolve(c.req.param("id"))) return c.json({ error: "Bulletin not found", code: "NOT_FOUND" }, 404);
    return c.json({ success: true, id: c.req.param("id") });
  });
  return app;
}
