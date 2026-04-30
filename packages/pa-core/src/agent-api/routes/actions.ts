import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Hono } from "hono";
import { getAiUsageDir, getSinhInputsDir } from "../../paths.js";
import { listRepos } from "../../repos.js";
import { TicketStore } from "../../tickets/store.js";
import type { Estimate, TicketPriority } from "../../tickets/types.js";
import { detectDocumentType, parseMarkdownMetadata, writeFeedbackAnnotation } from "../utils/markdown.js";
import { validateSandboxPath } from "../utils/sandbox.js";

const INBOX_ACTIONS = new Set(["approve", "reject", "defer", "acknowledge", "save-for-later", "append-section"]);
const SINH_INPUTS_FOLDERS = new Set(["approved", "rejected", "deferred", "done", "ideas"]);
const SINH_INPUTS_ACTIONS = new Set(["requeue", "archive", "save-for-later", "append-section"]);
const ALLOWED_UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function actionRoutes(store = new TicketStore()): Hono {
  const app = new Hono();

  app.get("/api/inbox", (c) => {
    const items = listInboxItems();
    const countByType: Record<string, number> = {};
    for (const item of items) countByType[item.type] = (countByType[item.type] ?? 0) + 1;
    return c.json({ items, count_by_type: countByType });
  });

  app.post("/api/inbox/:id/action", async (c) => {
    const id = c.req.param("id");
    if (!isSafeMarkdownFilename(id)) return c.json({ error: "Invalid filename", code: "INVALID_PATH" }, 403);
    const sourcePath = safeJoin(getSinhInputsDir(), "inbox", id);
    if (!sourcePath.ok) return c.json({ error: "Path traversal denied", code: "SANDBOX_VIOLATION" }, 403);
    if (!existsSync(sourcePath.path)) return c.json({ error: "File not found", code: "NOT_FOUND" }, 404);

    const parsed = await readJsonBody(c.req.json.bind(c.req));
    if (!parsed.ok) return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
    const action = stringField(parsed.body, "action");
    if (!action) return c.json({ error: "action is required", code: "BAD_REQUEST" }, 400);
    if (!INBOX_ACTIONS.has(action)) return c.json({ error: `Unknown action: ${action}`, code: "BAD_REQUEST" }, 400);

    const content = readFileSync(sourcePath.path, "utf-8");
    if (action === "append-section") {
      const title = stringField(parsed.body, "title")?.trim();
      if (!title) return c.json({ error: "title is required", code: "BAD_REQUEST" }, 400);
      writeFileSync(sourcePath.path, appendSection(content, title, stringField(parsed.body, "content") ?? ""), "utf-8");
      return c.json({ status: "section-appended", file: id, title });
    }

    if (action === "reject" && parsed.body["pending"] !== true && (!stringField(parsed.body, "what_is_wrong") || !stringField(parsed.body, "what_to_fix"))) {
      return c.json({ error: "what_is_wrong and what_to_fix are required", code: "BAD_REQUEST" }, 400);
    }

    const result = runInboxMoveAction(action, content, parsed.body, sourcePath.path, id);
    if (!result.ok) return c.json({ error: result.error, code: "BAD_REQUEST" }, 400);
    return c.json(result.body);
  });

  app.post("/api/sinh-inputs/:folder/:filename/action", async (c) => {
    const folder = c.req.param("folder");
    const filename = c.req.param("filename");
    if (!SINH_INPUTS_FOLDERS.has(folder)) return c.json({ error: "Unknown folder", code: "NOT_FOUND" }, 404);
    if (!isSafeMarkdownFilename(filename)) return c.json({ error: "Invalid filename", code: "INVALID_PATH" }, 403);
    const sourcePath = safeJoin(getSinhInputsDir(), folder, filename);
    if (!sourcePath.ok) return c.json({ error: "Path traversal denied", code: "SANDBOX_VIOLATION" }, 403);
    if (!existsSync(sourcePath.path)) return c.json({ error: "File not found", code: "NOT_FOUND" }, 404);

    const parsed = await readJsonBody(c.req.json.bind(c.req));
    if (!parsed.ok) return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
    const action = stringField(parsed.body, "action");
    if (!action) return c.json({ error: "action is required", code: "BAD_REQUEST" }, 400);
    if (!SINH_INPUTS_ACTIONS.has(action)) return c.json({ error: `Unknown action: ${action}`, code: "BAD_REQUEST" }, 400);

    if (action === "append-section") {
      const title = stringField(parsed.body, "title")?.trim();
      if (!title) return c.json({ error: "title is required", code: "BAD_REQUEST" }, 400);
      writeFileSync(sourcePath.path, appendSection(readFileSync(sourcePath.path, "utf-8"), title, stringField(parsed.body, "content") ?? ""), "utf-8");
      return c.json({ status: "section-appended", file: filename, title });
    }
    if (action === "save-for-later" && folder !== "approved") return c.json({ error: "save-for-later is only available for approved items", code: "BAD_REQUEST" }, 400);

    const destinationFolder = action === "requeue" ? "inbox" : action === "archive" ? "done" : "for-later";
    if (action === "requeue" || action === "save-for-later") {
      const key = action === "requeue" ? "requeued_from" : "saved_from";
      writeFileSync(sourcePath.path, insertFrontmatterKey(readFileSync(sourcePath.path, "utf-8"), key, folder), "utf-8");
    }
    const destination = moveMarkdownFile(sourcePath.path, destinationFolder, filename);
    if (!destination.ok) return c.json({ error: destination.error, code: destination.code }, destination.status);
    return c.json({ status: action === "requeue" ? "requeued" : action === "archive" ? "archived" : "saved-for-later", file: filename, from: folder });
  });

  app.post("/api/ideas", async (c) => {
    const parsed = await readJsonBody(c.req.json.bind(c.req));
    if (!parsed.ok) return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
    const title = stringField(parsed.body, "title")?.trim();
    if (!title) return c.json({ error: "title is required", code: "BAD_REQUEST" }, 400);
    const what = stringField(parsed.body, "what")?.trim() || stringField(parsed.body, "content")?.trim() || title;
    const why = stringField(parsed.body, "why")?.trim() || "";
    const notes = stringField(parsed.body, "notes")?.trim() || "";
    const tags = tagsField(parsed.body["tags"]);
    const ticket = store.create({
      project: stringField(parsed.body, "project") ?? defaultProject(),
      title,
      summary: what,
      description: [why ? `## Why\n${why}` : "", notes ? `## Notes\n${notes}` : ""].filter(Boolean).join("\n\n"),
      status: "idea",
      priority: priorityField(parsed.body["priority"]),
      type: "idea",
      assignee: stringField(parsed.body, "assignee") ?? "requirements",
      estimate: estimateField(parsed.body["effort"]),
      from: stringField(parsed.body, "from") ?? "api",
      to: stringField(parsed.body, "to") ?? "requirements",
      tags,
      blockedBy: [],
      doc_refs: [],
      comments: [],
    }, stringField(parsed.body, "actor") ?? "api");
    return c.json({ status: "created", ticket, file: null }, 201);
  });

  app.patch("/api/tickets/:id/comments/:commentId", async (c) => {
    const parsed = await readJsonBody(c.req.json.bind(c.req));
    if (!parsed.ok) return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
    const content = stringField(parsed.body, "content");
    if (!content) return c.json({ error: "content is required", code: "BAD_REQUEST" }, 400);
    try {
      const { comment, ticket } = store.editComment(c.req.param("id"), c.req.param("commentId"), content, stringField(parsed.body, "actor") ?? "api");
      return c.json({ ticket, comment });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, code: message.includes("not found") ? "NOT_FOUND" : "EDIT_FAILED" }, message.includes("not found") ? 404 : 400);
    }
  });

  app.delete("/api/tickets/:id/comments/:commentId", (c) => {
    try {
      store.deleteComment(c.req.param("id"), c.req.param("commentId"), c.req.query("actor") ?? "api");
      return new Response(null, { status: 204 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, code: message.includes("not found") ? "NOT_FOUND" : "DELETE_FAILED" }, message.includes("not found") ? 404 : 400);
    }
  });

  app.post("/api/tickets/:id/attachments", async (c) => {
    const parsed = await readJsonBody(c.req.json.bind(c.req));
    if (!parsed.ok) return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
    const path = stringField(parsed.body, "path");
    if (!path) return c.json({ error: "path is required", code: "BAD_REQUEST" }, 400);
    if (!isSafeAttachmentPath(path)) return c.json({ error: "Invalid attachment path", code: "SANDBOX_VIOLATION" }, 403);
    try {
      const ticket = store.attach(c.req.param("id"), path, stringField(parsed.body, "actor") ?? "api");
      return c.json({ ticket });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, code: message.includes("not found") ? "NOT_FOUND" : "ATTACH_FAILED" }, message.includes("not found") ? 404 : 400);
    }
  });

  app.post("/api/tickets/:id/attachments/upload", async (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ error: "Ticket not found", code: "NOT_FOUND" }, 404);
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ error: "Failed to parse body", code: "BAD_REQUEST" }, 400);
    }
    const file = body["file"];
    if (!(file instanceof File)) return c.json({ error: "file field is required and must be a file", code: "BAD_REQUEST" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "File too large", code: "PAYLOAD_TOO_LARGE" }, 413);
    const ext = extname(file.name).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) return c.json({ error: `File extension '${ext}' is not allowed. Allowed: png, jpg, jpeg, gif, webp`, code: "BAD_REQUEST" }, 400);
    const baseName = file.name.split("/").pop()?.split("\\").pop() ?? "upload";
    const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!isSafeFilename(sanitized)) return c.json({ error: "Invalid filename", code: "INVALID_PATH" }, 403);
    const storedFilename = `${Date.now()}-${sanitized}`;
    const attachmentDir = resolve(getAiUsageDir(), "attachments", id);
    const storedPath = resolve(attachmentDir, storedFilename);
    try {
      validateSandboxPath(storedPath);
      mkdirSync(attachmentDir, { recursive: true });
      writeFileSync(storedPath, Buffer.from(await file.arrayBuffer()));
      const docRef = `attachments/${id}/${storedFilename}`;
      store.attach(id, docRef, "api");
      return c.json({ docRef }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, code: "UPLOAD_FAILED" }, 500);
    }
  });

  app.post("/api/tickets/:id/move", async (c) => {
    const parsed = await readJsonBody(c.req.json.bind(c.req));
    if (!parsed.ok) return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
    const project = stringField(parsed.body, "project");
    if (!project) return c.json({ error: "project is required", code: "BAD_REQUEST" }, 400);
    try {
      const existing = store.get(c.req.param("id"));
      if (!existing) return c.json({ error: "Ticket not found", code: "NOT_FOUND" }, 404);
      if (existing.project === project) return c.json({ error: `Ticket is already in project ${project}`, code: "SAME_PROJECT" }, 400);
      return c.json({ ticket: store.move(existing.id, project, stringField(parsed.body, "actor") ?? "api") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Unknown project")) return c.json({ error: message, code: "INVALID_PROJECT", validProjects: listRepos().filter((repo) => repo.prefix).map((repo) => repo.name).sort().join(", ") }, 400);
      return c.json({ error: message, code: message.includes("not found") ? "NOT_FOUND" : "MOVE_FAILED" }, message.includes("not found") ? 404 : 400);
    }
  });

  return app;
}

interface InboxItem {
  id: string;
  type: string;
  size: number;
  modified: string;
  title: string;
  date?: string;
}

function listInboxItems(): InboxItem[] {
  const dir = resolve(getSinhInputsDir(), "inbox");
  if (!existsSync(dir)) return [];
  return safeDirectoryEntries(dir).map((filename) => {
    const filePath = resolve(dir, filename);
    const content = readFileSync(filePath, "utf-8");
    const metadata = parseMarkdownMetadata(content, filename);
    const item: InboxItem = { id: filename, type: detectDocumentType(content, filename), size: statSync(filePath).size, modified: statSync(filePath).mtime.toISOString(), title: metadata.title };
    if (metadata.date) item.date = metadata.date;
    return item;
  }).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

function safeDirectoryEntries(dir: string): string[] {
  validateSandboxPath(dir);
  return existsSync(dir) ? Array.from(new Set(requireSafeMarkdownFilenames(dir))) : [];
}

function requireSafeMarkdownFilenames(dir: string): string[] {
  return existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter(isSafeMarkdownFilename) : [];
}

function runInboxMoveAction(action: string, content: string, body: Record<string, unknown>, sourcePath: string, filename: string): { ok: true; body: Record<string, string> } | { ok: false; error: string } {
  if (action === "approve") {
    const annotated = writeFeedbackAnnotation(content, { kind: "approve", note: stringField(body, "note"), chips: stringArrayField(body["chips"]) });
    if (annotated !== content) writeFileSync(sourcePath, annotated, "utf-8");
    const moved = moveMarkdownFile(sourcePath, "approved", filename);
    return moved.ok ? { ok: true, body: { status: "approved", file: filename } } : { ok: false, error: moved.error };
  }
  if (action === "reject") {
    if (body["pending"] === true) {
      writeFileSync(sourcePath, writeFeedbackAnnotation(content, { kind: "pending-reject" }), "utf-8");
      return { ok: true, body: { status: "pending-reject-feedback", file: filename } };
    }
    writeFileSync(sourcePath, writeFeedbackAnnotation(content, { kind: "reject", what_is_wrong: stringField(body, "what_is_wrong") ?? "", what_to_fix: stringField(body, "what_to_fix") ?? "", priority: stringField(body, "priority") ?? "medium", chips: stringArrayField(body["chips"]) }), "utf-8");
    const moved = moveMarkdownFile(sourcePath, "rejected", filename);
    return moved.ok ? { ok: true, body: { status: "rejected", file: filename } } : { ok: false, error: moved.error };
  }
  if (action === "defer") {
    const annotated = writeFeedbackAnnotation(content, { kind: "defer", reason: stringField(body, "reason"), requeue_after: stringField(body, "requeue_after"), chips: stringArrayField(body["chips"]) });
    if (annotated !== content) writeFileSync(sourcePath, annotated, "utf-8");
    const moved = moveMarkdownFile(sourcePath, "deferred", filename);
    return moved.ok ? { ok: true, body: { status: "deferred", file: filename } } : { ok: false, error: moved.error };
  }
  if (action === "acknowledge") {
    const annotated = writeFeedbackAnnotation(content, { kind: "acknowledge", note: stringField(body, "note") });
    if (annotated !== content) writeFileSync(sourcePath, annotated, "utf-8");
    const moved = moveMarkdownFile(sourcePath, "done", filename);
    return moved.ok ? { ok: true, body: { status: "acknowledged", file: filename } } : { ok: false, error: moved.error };
  }
  writeFileSync(sourcePath, writeFeedbackAnnotation(content, { kind: "save-for-later" }), "utf-8");
  const moved = moveMarkdownFile(sourcePath, "for-later", filename);
  return moved.ok ? { ok: true, body: { status: "saved-for-later", file: filename } } : { ok: false, error: moved.error };
}

function moveMarkdownFile(sourcePath: string, destinationFolder: string, filename: string): { ok: true } | { ok: false; error: string; code: string; status: 400 | 403 | 409 } {
  const destinationDir = safeJoin(getSinhInputsDir(), destinationFolder);
  if (!destinationDir.ok) return { ok: false, error: "Path traversal denied", code: "SANDBOX_VIOLATION", status: 403 };
  const destinationPath = safeJoin(destinationDir.path, filename);
  if (!destinationPath.ok) return { ok: false, error: "Path traversal denied", code: "SANDBOX_VIOLATION", status: 403 };
  if (existsSync(destinationPath.path)) return { ok: false, error: "Destination file already exists", code: "CONFLICT", status: 409 };
  mkdirSync(destinationDir.path, { recursive: true });
  renameSync(sourcePath, destinationPath.path);
  return { ok: true };
}

function safeJoin(root: string, ...segments: string[]): { ok: true; path: string } | { ok: false } {
  if (segments.some((segment) => !isSafeFilename(segment))) return { ok: false };
  const path = resolve(root, ...segments);
  try {
    validateSandboxPath(path);
    return { ok: true, path };
  } catch {
    return { ok: false };
  }
}

async function readJsonBody(read: () => Promise<unknown>): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  try {
    const body = await read();
    return body && typeof body === "object" && !Array.isArray(body) ? { ok: true, body: body as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function appendSection(content: string, title: string, sectionContent: string): string {
  let result = content;
  if (!result.endsWith("\n")) result += "\n";
  if (!result.endsWith("\n\n")) result += "\n";
  return `${result}### ${title}\n\n${sectionContent}\n`;
}

function insertFrontmatterKey(content: string, key: string, value: string): string {
  if (content.startsWith("---\n")) {
    const endIdx = content.indexOf("\n---\n", 4);
    if (endIdx !== -1) {
      const frontmatter = content.substring(4, endIdx).split("\n").filter((line) => !line.startsWith(`${key}:`)).join("\n");
      return `---\n${frontmatter}${frontmatter ? "\n" : ""}${key}: ${value}\n---\n${content.substring(endIdx + 5)}`;
    }
  }
  return `---\n${key}: ${value}\n---\n${content}`;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function tagsField(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function isSafeFilename(name: string): boolean {
  return !!name && !name.includes("..") && !name.includes("/") && !name.includes("\\") && !name.startsWith(".");
}

function isSafeMarkdownFilename(name: string): boolean {
  return isSafeFilename(name) && name.endsWith(".md");
}

function isSafeAttachmentPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("..") || path.includes("\\")) return false;
  try {
    validateSandboxPath(resolve(getAiUsageDir(), path));
    return true;
  } catch {
    return false;
  }
}

function defaultProject(): string {
  return listRepos().find((repo) => repo.prefix)?.name ?? "pa-platform";
}

function priorityField(value: unknown): TicketPriority {
  return value === "critical" || value === "high" || value === "low" ? value : "medium";
}

function estimateField(value: unknown): Estimate {
  return value === "XS" || value === "S" || value === "L" || value === "XL" ? value : "M";
}
