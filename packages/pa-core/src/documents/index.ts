import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentTeamsDir, getAiUsageDir, getDailyDir, getDeploymentsDir, getKnowledgeBaseDir, getSessionsDir, getSinhInputsDir, getTrashDir } from "../paths.js";

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

const AREA_DIRS: Record<DocumentArea, () => string> = {
  "agent-teams": getAgentTeamsDir,
  "sinh-inputs": getSinhInputsDir,
  daily: getDailyDir,
  sessions: getSessionsDir,
  "knowledge-base": getKnowledgeBaseDir,
  deployments: getDeploymentsDir,
  trash: getTrashDir,
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
