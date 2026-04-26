import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GraphEdge, GraphNode, ParseResult } from "./types.js";

// Ported from PA codectx/parser.ts at frozen PA source on 2026-04-26; tree-sitter CLI dependency removed for pa-core portability.

export type Language = "typescript" | "javascript" | "unknown";

export function getLanguage(filePath: string): Language {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  return "unknown";
}

export function parseFile(filePath: string): ParseResult {
  const file = resolve(filePath);
  const language = getLanguage(file);
  if (language === "unknown") return { file, success: false, error: `Unsupported file type: ${file}`, nodes: [], edges: [] };
  const { nodes, edges } = extractDeclarations(file);
  return { file, success: true, nodes, edges };
}

export function extractDeclarations(filePath: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const file = resolve(filePath);
  const language = getLanguage(file);
  if (language === "unknown") return { nodes: [], edges: [] };
  return extractDeclarationsFromContent(file, language, readFileSync(file, "utf-8"));
}

export function findSourceFiles(dirPath: string, limit = 500): string[] {
  const files: string[] = [];
  walkDir(resolve(dirPath), files, limit);
  return files;
}

function extractDeclarationsFromContent(file: string, language: Exclude<Language, "unknown">, content: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const functionPattern = language === "typescript"
    ? /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=.*?(?:async\s+)?\(|^(?:export\s+)?let\s+(\w+)\s*=.*?(?:async\s+)?\(/gm
    : /^(?:export\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=.*?(?:async\s+)?\(/gm;
  addPatternNodes(content, functionPattern, (match) => match[1] || match[2] || match[3], (name, line) => ({ id: `${file}:${name}:function`, type: "function", name, file, startLine: line, endLine: line + 10, exports: [], imports: [] }), nodes);
  addPatternNodes(content, /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/gm, (match) => match[1], (name, line, match) => {
    const nodeId = `${file}:${name}:class`;
    if (match[2]) edges.push({ id: `${nodeId}-extends-${match[2]}`, source: nodeId, target: `${file}:${match[2]}:unknown`, type: "extends" });
    return { id: nodeId, type: "class", name, file, startLine: line, endLine: line + 20, exports: [], imports: [] };
  }, nodes);
  addPatternNodes(content, /^(?:export\s+)?interface\s+(\w+)/gm, (match) => match[1], (name, line) => ({ id: `${file}:${name}:interface`, type: "interface", name, file, startLine: line, endLine: line + 10, exports: [], imports: [] }), nodes);
  addPatternNodes(content, /^(?:export\s+)?type\s+(\w+)\s*=/gm, (match) => match[1], (name, line) => ({ id: `${file}:${name}:type`, type: "type", name, file, startLine: line, endLine: line + 3, exports: [], imports: [] }), nodes);
  addPatternNodes(content, /^(?:export\s+)?enum\s+(\w+)/gm, (match) => match[1], (name, line) => ({ id: `${file}:${name}:enum`, type: "enum", name, file, startLine: line, endLine: line + 10, exports: [], imports: [] }), nodes);
  return { nodes, edges };
}

function addPatternNodes(content: string, pattern: RegExp, getName: (match: RegExpExecArray) => string | undefined, build: (name: string, line: number, match: RegExpExecArray) => GraphNode, nodes: GraphNode[]): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const name = getName(match);
    if (!name || isExcludedIdentifier(name)) continue;
    nodes.push(build(name, content.slice(0, match.index).split("\n").length, match));
  }
}

function isExcludedIdentifier(name: string): boolean {
  return new Set(["if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return", "throw", "try", "catch", "finally", "new", "delete", "typeof", "instanceof", "void", "yield", "await", "async", "export", "import", "default", "from", "of", "in"]).has(name);
}

function walkDir(dirPath: string, files: string[], limit: number): void {
  if (files.length >= limit || !existsSync(dirPath)) return;
  for (const entry of readdirSync(dirPath)) {
    if (["node_modules", "dist", ".git"].includes(entry)) continue;
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) walkDir(fullPath, files, limit);
    else if (stat.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry)) files.push(fullPath);
    if (files.length >= limit) return;
  }
}
