import { Hono } from "hono";
import { buildSkillRegistryReport } from "../../skills/index.js";

export function skillsRoutes(): Hono {
  const app = new Hono();
  app.get("/api/skills", (c) => c.json(buildSkillRegistryReport()));
  return app;
}
