import { Hono } from "hono";
import { listImprovementCandidates, listKnowledgeBoundaries } from "../../knowledge/index.js";

export function knowledgeRoutes(): Hono {
  const app = new Hono();
  app.get("/api/knowledge-boundaries", (c) => c.json({ boundaries: listKnowledgeBoundaries() }));
  app.get("/api/improvement-candidates", (c) => c.json({ candidates: listImprovementCandidates() }));
  return app;
}
