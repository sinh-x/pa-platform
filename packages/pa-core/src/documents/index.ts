import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { detectDocumentType, parseMarkdownMetadata, type MarkdownMetadata } from "../agent-api/utils/markdown.js";
import { getAgentTeamsDir, getAiUsageDir, getDailyDir, getDeploymentsDir, getKnowledgeBaseDir, getSessionsDir, getSinhInputsDir, getTrashDir } from "../paths.js";
import { nowUtc } from "../time.js";

export type DocumentArea = "agent-teams" | "sinh-inputs" | "daily" | "sessions" | "knowledge-base" | "deployments" | "trash";

export interface DocumentRef {
  area: DocumentArea;
  relativePath: string;
  absolutePath: string;
}

export interface DocumentEntry extends DocumentRef {
  size: number;
  mtime: Date;
}

export interface MarkdownFileItem {
  id: string;
  title: string;
  date?: string;
  type?: string;
  size: number;
  modified: string;
}

export interface MarkdownDocument {
  path: string;
  content: string;
  metadata: MarkdownMetadata & { type: string; size: number; modified: string };
}

export interface InsertDocumentSectionInput {
  title: string | null;
  content: string;
  location?: number;
  lineText?: string;
}

export interface InsertDocumentSectionResult extends MarkdownDocument {
  status: "ok" | "warning";
  insertedAt: string;
  lineNumber: number;
}

const AREA_DIRS: Record<DocumentArea, () => string> = {
  "agent-teams": getAgentTeamsDir,
  "sinh-inputs": getSinhInputsDir,
  daily: getDailyDir,
  sessions: getSessionsDir,
  "knowledge-base": getKnowledgeBaseDir,
  deployments: getDeploymentsDir,
  trash: getTrashDir,
};

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function documentPath(area: DocumentArea, relativePath = ""): string {
  return resolve(AREA_DIRS[area](), relativePath);
}

export function documentRef(area: DocumentArea, relativePath: string): DocumentRef {
  return { area, relativePath, absolutePath: documentPath(area, relativePath) };
}

export function readDocument(area: DocumentArea, relativePath: string): string {
  return readFileSync(documentPath(area, relativePath), "utf-8");
}

export function writeDocument(area: DocumentArea, relativePath: string, content: string): DocumentRef {
  const absolutePath = documentPath(area, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return { area, relativePath, absolutePath };
}

export function listDocuments(area: DocumentArea, relativeDir = ""): DocumentEntry[] {
  const root = documentPath(area, relativeDir);
  if (!existsSync(root)) return [];
  const entries: DocumentEntry[] = [];
  for (const name of readdirSync(root)) {
    const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
    const absolutePath = documentPath(area, relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) entries.push(...listDocuments(area, relativePath));
    else entries.push({ area, relativePath, absolutePath, size: stat.size, mtime: stat.mtime });
  }
  return entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export function aiUsageRelativePath(absolutePath: string): string {
  const root = getAiUsageDir();
  return absolutePath.startsWith(`${root}/`) ? absolutePath.slice(root.length + 1) : absolutePath;
}

export function listMarkdownFiles(dirPath: string): MarkdownFileItem[] {
  if (!existsSync(dirPath)) return [];
  const items: MarkdownFileItem[] = [];
  for (const filename of readdirSync(dirPath)) {
    if (!filename.endsWith(".md")) continue;
    const filePath = resolve(dirPath, filename);
    try {
      const content = readFileSync(filePath, "utf-8");
      const metadata = parseMarkdownMetadata(content, filename);
      const stat = statSync(filePath);
      items.push({ id: filename, title: metadata.title, date: metadata.date, type: detectDocumentType(content, filename), size: stat.size, modified: nowUtc(stat.mtime) });
    } catch {
      // Skip unreadable files to match route-list behavior.
    }
  }
  return items.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

export function readMarkdownDocument(path: string): MarkdownDocument {
  const content = readFileSync(path, "utf-8");
  return markdownDocumentFromContent(path, content);
}

export function insertDocumentSection(path: string, input: InsertDocumentSectionInput): InsertDocumentSectionResult {
  if (typeof input.content !== "string" || input.content.trim() === "") throw new Error("content must be a non-empty string");
  if (input.lineText !== undefined && typeof input.lineText !== "string") throw new Error("lineText must be a string if provided");
  const lines = readFileSync(path, "utf-8").split("\n");
  const { insertPos, insertedAt, lineNumber } = documentInsertPosition(lines, input.location, input.lineText);
  const suppressHeader = input.title === null || input.title === "" || input.title === "NA" || input.title === "NULL";
  const newSection = suppressHeader ? `${input.content}\n` : `### ${input.title}\n\n${input.content}\n`;
  lines.splice(insertPos, 0, newSection);
  const content = lines.join("\n");
  writeFileSync(path, content, "utf-8");
  return { ...markdownDocumentFromContent(path, content), status: insertedAt === "end" && input.lineText !== undefined ? "warning" : "ok", insertedAt, lineNumber };
}

export function getImageContentType(path: string): string | undefined {
  return IMAGE_CONTENT_TYPES[extname(path).toLowerCase()];
}

function markdownDocumentFromContent(path: string, content: string): MarkdownDocument {
  const filename = basename(path);
  const stat = statSync(path);
  const metadata = parseMarkdownMetadata(content, filename);
  return { path, content, metadata: { ...metadata, type: detectDocumentType(content, filename), size: stat.size, modified: nowUtc(stat.mtime) } };
}

function documentInsertPosition(lines: string[], location: number | undefined, lineText: string | undefined): { insertPos: number; insertedAt: string; lineNumber: number } {
  if (lineText !== undefined && lineText.trim() !== "") {
    let lastIndex = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i] === lineText.trim()) lastIndex = i;
    if (lastIndex === -1) return { insertPos: lines.length, insertedAt: "end", lineNumber: lines.length };
    return { insertPos: lastIndex + 1, insertedAt: `after:${lastIndex + 1}`, lineNumber: lastIndex + 1 };
  }
  if (location !== undefined) {
    const insertPos = location <= 0 ? 0 : Math.min(location - 1, lines.length);
    return { insertPos, insertedAt: `after:${insertPos + 1}`, lineNumber: insertPos + 1 };
  }
  return { insertPos: lines.length, insertedAt: "end", lineNumber: lines.length };
}
