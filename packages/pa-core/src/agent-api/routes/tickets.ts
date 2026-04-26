import { Hono } from "hono";
import { marked } from "marked";
import { buildBoardView } from "../../tickets/board.js";
import { deriveDocRefTitle } from "../../tickets/doc-ref.js";
import { TicketStore } from "../../tickets/store.js";
import type { CreateTicketInput, TicketListFilters, UpdateTicketInput } from "../../tickets/types.js";
import { validateAssignee, validateAuthor } from "../../tickets/validate.js";
import { getDeploymentsByTicketId } from "../../registry/index.js";
import { listRepos } from "../../repos.js";

export function ticketRoutes(store = new TicketStore()): Hono {
  const app = new Hono();

  app.get("/api/tickets", (c) => {
    const filters: TicketListFilters = {};
    const project = c.req.query("project");
    const status = c.req.query("status") as TicketListFilters["status"] | undefined;
    const assignee = c.req.query("assignee");
    const priority = c.req.query("priority") as TicketListFilters["priority"] | undefined;
    const type = c.req.query("type") as TicketListFilters["type"] | undefined;
    const tags = c.req.query("tags");
    const excludeTags = c.req.query("excludeTags");
    const search = c.req.query("search");
    if (project) filters.project = project;
    if (status) filters.status = status;
    if (assignee) filters.assignee = assignee;
    if (priority) filters.priority = priority;
    if (type) filters.type = type;
    if (tags) filters.tags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (excludeTags) filters.excludeTags = excludeTags.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (search) filters.search = search;
    const tickets = store.list(filters).map((ticket) => ({ ...ticket, doc_refs: ticket.doc_refs.map((ref) => ({ ...ref, title: deriveDocRefTitle(ref) })) }));
    return c.json({ tickets, count: tickets.length });
  });

  app.post("/api/tickets", async (c) => {
    let body: CreateTicketInput & { actor?: string; team?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
    }
    const actor = body.actor ?? "api";
    const { actor: _actor, team, ...input } = body;
    if (!input.assignee && team) input.assignee = team;
    if (!input.assignee) return c.json({ error: "assignee is required, team field is deprecated", code: "BAD_REQUEST" }, 400);
    try {
      validateAssignee(input.assignee);
      return c.json({ ticket: store.create(input, actor) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error), code: "CREATE_FAILED" }, 400);
    }
  });

  app.get("/api/tickets/:id/review", (c) => {
    const ticket = store.get(c.req.param("id"));
    if (!ticket) return c.json({ error: "Ticket not found", code: "NOT_FOUND" }, 404);
    const doc_refs = ticket.doc_refs.map((ref) => ({ ...ref, url: `/api/documents?path=${encodeURIComponent(ref.path)}`, title: deriveDocRefTitle(ref) }));
    return c.json({ ticket, doc_refs });
  });

  app.get("/api/tickets/:id", (c) => {
    const ticket = store.get(c.req.param("id"));
    if (!ticket) return c.json({ error: "Ticket not found", code: "NOT_FOUND" }, 404);
    const withTitles = { ...ticket, doc_refs: ticket.doc_refs.map((ref) => ({ ...ref, title: deriveDocRefTitle(ref) })) };
    const deployments = getDeploymentsByTicketId(ticket.id);
    if (c.req.query("render") !== "html") return c.json({ ticket: withTitles, deployments });
    const render = (content: string): string => content ? (marked.parse(content, { async: false }) as string) : "";
    return c.json({ ticket: { ...withTitles, summary: render(withTitles.summary), description: render(withTitles.description), comments: withTitles.comments.map((comment) => ({ ...comment, content: render(comment.content) })) }, deployments });
  });

  app.patch("/api/tickets/:id", async (c) => {
    let body: UpdateTicketInput & { actor?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
    }
    const actor = body.actor ?? "api";
    const { actor: _actor, ...input } = body;
    if (input.assignee) {
      try { validateAssignee(input.assignee); } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error), code: "BAD_REQUEST" }, 400); }
    }
    try {
      return c.json({ ticket: store.update(c.req.param("id"), input, actor) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, code: message.includes("not found") ? "NOT_FOUND" : "UPDATE_FAILED" }, message.includes("not found") ? 404 : 400);
    }
  });

  app.post("/api/tickets/:id/comments", async (c) => {
    let body: { author?: string; content?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400); }
    if (!body.author || !body.content) return c.json({ error: "author and content are required", code: "BAD_REQUEST" }, 400);
    try {
      validateAuthor(body.author);
      const comment = store.comment(c.req.param("id"), body.author, body.content);
      return c.json({ ticket: store.get(c.req.param("id")), comment }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, code: message.includes("not found") ? "NOT_FOUND" : "COMMENT_FAILED" }, message.includes("not found") ? 404 : 400);
    }
  });

  app.get("/api/board", (c) => c.json({ board: buildBoardView(c.req.query("project") ?? undefined) }));
  app.get("/api/projects", (c) => c.json({ projects: listRepos().map((repo) => ({ ...repo, active_ticket_count: store.list({ project: repo.name }).filter((ticket) => !["done", "rejected", "cancelled"].includes(ticket.status)).length })) }));

  return app;
}
