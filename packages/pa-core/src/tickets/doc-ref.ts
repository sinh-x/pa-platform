import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { getAiUsageDir } from "../paths.js";
import { DOC_REF_TYPE_DISPLAY } from "./types.js";

// Ported from PA tickets/doc-ref.ts at frozen PA source on 2026-04-26; path resolution now uses pa-core ai-usage helper.

export function normalizeDocRefType(raw: string): string {
  const lower = raw.toLowerCase();
  switch (lower) {
    case "requirements":
      return "req";
    case "implementation":
      return "impl";
    default:
      return lower;
  }
}

export function parseDocRefValue(value: string): { type: string; path: string } {
  const match = value.match(/^([a-zA-Z][a-zA-Z0-9_-]*):(.*)$/);
  if (!match) return { type: "attachment", path: value };
  return { type: normalizeDocRefType(match[1]), path: match[2] };
}

export function formatDocRefBadge(docRef: { type: string; primary?: boolean }): string {
  const display = DOC_REF_TYPE_DISPLAY[docRef.type] ?? docRef.type.toUpperCase();
  return `[${docRef.primary ? "*" : ""}${display}]`;
}

export function deriveDocRefTitle(docRef: { path: string }): string {
  const maxBytes = 16 * 1024;
  if (extname(docRef.path).toLowerCase() === ".md") {
    const resolved = resolveDocRefPath(docRef.path);
    if (existsSync(resolved)) {
      const content = readFileSync(resolved, "utf-8").slice(0, maxBytes);
      let inCodeBlock = false;
      for (const line of content.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (!inCodeBlock && trimmed.startsWith("# ")) return trimmed.slice(2).trim();
        if (!inCodeBlock && line.startsWith("title:")) {
          const value = line.slice("title:".length).trim();
          if (value) return value;
        }
      }
    }
    return basename(docRef.path).replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/i, "") || docRef.path;
  }
  return docRef.path;
}

export function resolveDocRefPath(path: string): string {
  if (/^https?:\/\//.test(path) || path.startsWith("/")) return path;
  return resolve(getAiUsageDir(), path);
}
