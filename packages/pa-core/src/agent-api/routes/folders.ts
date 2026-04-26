import { existsSync } from "node:fs";
import { Hono } from "hono";
import { resolve } from "node:path";
import { getAgentTeamsDir, getSinhInputsDir } from "../../paths.js";
import { listMarkdownFiles, readMarkdownDocument } from "../../documents/index.js";
import { validateSandboxPath } from "../utils/sandbox.js";

const SINH_INPUTS_SUBFOLDERS = new Set(["approved", "rejected", "deferred", "done", "ideas", "for-later"]);

export function foldersRoutes(): Hono {
  const app = new Hono();
  app.get("/api/folders/*", (c) => {
    const rest = c.req.path.substring("/api/folders/".length);
    const segments = rest.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.length < 1) return c.json({ error: "source is required", code: "BAD_REQUEST" }, 400);
    const resolved = resolveFolderSegments(segments);
    if (!resolved.ok) return c.json({ error: resolved.error, code: resolved.code }, resolved.status);
    if (resolved.filename) {
      const filePath = resolve(resolved.dirPath, resolved.filename);
      if (!existsSync(filePath)) return c.json({ error: "File not found", code: "NOT_FOUND" }, 404);
      const doc = readMarkdownDocument(filePath);
      return c.json({ id: resolved.filename, source: resolved.source, folder: resolved.folder, ...doc.metadata, content: doc.content });
    }
    const items = listMarkdownFiles(resolved.dirPath);
    return c.json({ source: resolved.source, folder: resolved.folder, items, total: items.length, hasMore: false });
  });
  return app;
}

function resolveFolderSegments(segments: string[]): { ok: true; source: string; folder: string; dirPath: string; filename?: string } | { ok: false; error: string; code: string; status: 400 | 403 | 404 } {
  const source = segments[0] ?? "";
  let folder: string;
  let dirPath: string | null = null;
  let filename: string | undefined;
  if (source === "teams") {
    const teamName = segments[1];
    folder = segments[2] ?? "";
    filename = segments[3];
    if (!teamName || !folder) return { ok: false, error: "team name and folder required", code: "BAD_REQUEST", status: 400 };
    if (!isSafeSegment(teamName) || !isSafeSegment(folder)) return { ok: false, error: "Invalid path", code: "SANDBOX_VIOLATION", status: 403 };
    dirPath = resolve(getAgentTeamsDir(), teamName, folder);
  } else if (source === "inbox" || source === "for-later") {
    folder = source;
    filename = segments[1];
    dirPath = resolve(getSinhInputsDir(), source === "inbox" ? "inbox" : "for-later");
  } else if (source === "sinh-inputs") {
    folder = segments[1] ?? "";
    filename = segments[2];
    if (!SINH_INPUTS_SUBFOLDERS.has(folder)) return { ok: false, error: "Unknown source or folder", code: "NOT_FOUND", status: 404 };
    dirPath = resolve(getSinhInputsDir(), folder);
  } else {
    return { ok: false, error: "Unknown source", code: "NOT_FOUND", status: 404 };
  }
  if (!isSafeSegment(source) || !isSafeSegment(folder) || (filename !== undefined && !isSafeSegment(filename))) return { ok: false, error: "Invalid path", code: "SANDBOX_VIOLATION", status: 403 };
  try { validateSandboxPath(dirPath); } catch { return { ok: false, error: "Path traversal denied", code: "SANDBOX_VIOLATION", status: 403 }; }
  return { ok: true, source, folder, dirPath, ...(filename ? { filename } : {}) };
}

function isSafeSegment(segment: string): boolean {
  return !!segment && !segment.includes("..") && !segment.includes("/") && !segment.includes("\\") && !segment.startsWith(".");
}
