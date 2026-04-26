import { existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { getImageContentType, insertDocumentSection, listMarkdownFiles, readMarkdownDocument } from "../../documents/index.js";
import { normalizeSandboxPath, validateSandboxPath } from "../utils/sandbox.js";

export function documentsRoutes(): Hono {
  const app = new Hono();
  app.get("/api/documents", (c) => {
    const pathParam = c.req.query("path");
    if (!pathParam) return c.json({ error: "path query param is required", code: "BAD_REQUEST" }, 400);
    const resolved = safeResolve(pathParam);
    if (!resolved.ok) return c.json({ error: resolved.error, code: resolved.code }, resolved.status);
    if (!existsSync(resolved.path)) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (statSync(resolved.path).isDirectory()) return c.json({ path: pathParam, items: listMarkdownFiles(resolved.path), total: listMarkdownFiles(resolved.path).length });
    const doc = readMarkdownDocument(resolved.path);
    return c.json({ path: pathParam, content: doc.content, metadata: doc.metadata });
  });
  app.get("/api/images", (c) => {
    const pathParam = c.req.query("path");
    if (!pathParam) return c.json({ error: "path query param is required", code: "BAD_REQUEST" }, 400);
    const resolved = safeResolve(pathParam);
    if (!resolved.ok) return c.json({ error: resolved.error, code: resolved.code }, resolved.status);
    if (!existsSync(resolved.path)) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    const contentType = getImageContentType(resolved.path);
    if (!contentType) return c.json({ error: "Unsupported image format", code: "UNSUPPORTED_MEDIA_TYPE" }, 415);
    c.header("Content-Type", contentType);
    c.header("Content-Length", String(statSync(resolved.path).size));
    return c.body(readFileSync(resolved.path));
  });
  app.post("/api/folders/:folderId/files/:fileId/sections", async (c) => {
    const resolved = safeResolve(`${c.req.param("folderId")}/${c.req.param("fileId")}`);
    if (!resolved.ok) return c.json({ error: resolved.error, code: resolved.code }, resolved.status);
    if (!existsSync(resolved.path)) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    let body: { title: string | null; content: string; location?: number; lineText?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400); }
    try {
      const result = insertDocumentSection(resolved.path, body);
      return c.json({ path: `${c.req.param("folderId")}/${c.req.param("fileId")}`, content: result.content, status: result.status, insertedAt: result.insertedAt, lineNumber: result.lineNumber, metadata: result.metadata });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error), code: "BAD_REQUEST" }, 400);
    }
  });
  return app;
}

function safeResolve(path: string): { ok: true; path: string } | { ok: false; error: string; code: string; status: 403 } {
  try {
    return { ok: true, path: validateSandboxPath(normalizeSandboxPath(path)) };
  } catch {
    return { ok: false, error: "Path traversal denied", code: "SANDBOX_VIOLATION", status: 403 };
  }
}
