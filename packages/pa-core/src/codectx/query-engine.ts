import { findCallers, getTopExports } from "./graph-builder.js";
import type { CodeGraph, GraphNode } from "./types.js";

// Ported from PA codectx/query-engine.ts at frozen PA source on 2026-04-26.

export interface FileQueryResult {
  type: "file";
  file: string;
  declarations: Array<{ name: string; declarationType: string; startLine: number; endLine: number; signature?: string }>;
}

export interface FunctionQueryResult {
  type: "function";
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
  callers: Array<{ name: string; file: string; line: number }>;
}

export interface ClassQueryResult {
  type: "class";
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  methods: Array<{ name: string; line: number }>;
}

export interface ExportsQueryResult {
  type: "exports";
  exports: string[];
  byFile: Record<string, string[]>;
}

export type QueryResult = FileQueryResult | FunctionQueryResult | ClassQueryResult | ExportsQueryResult;

export function queryFile(graph: CodeGraph, filePath: string): FileQueryResult | null {
  const matchingNodes = Object.values(graph.nodes).filter((node) => node.file.includes(filePath) || node.file.endsWith(filePath));
  if (matchingNodes.length === 0) return null;
  const fileNode = matchingNodes.find((node) => node.type === "file");
  return { type: "file", file: fileNode?.file || matchingNodes[0].file, declarations: matchingNodes.filter((node) => node.type !== "file").map((node) => ({ name: node.name, declarationType: node.type, startLine: node.startLine, endLine: node.endLine, signature: extractSignature(node) })) };
}

export function queryFunction(graph: CodeGraph, functionName: string): FunctionQueryResult | null {
  const node = Object.values(graph.nodes).find((candidate) => candidate.type === "function" && candidate.name === functionName);
  if (!node) return null;
  return { type: "function", name: node.name, file: node.file, startLine: node.startLine, endLine: node.endLine, signature: extractSignature(node), callers: findCallers(graph, functionName).map((caller) => ({ name: caller.name, file: caller.file, line: caller.startLine })) };
}

export function queryClass(graph: CodeGraph, className: string): ClassQueryResult | null {
  const node = Object.values(graph.nodes).find((candidate) => candidate.type === "class" && candidate.name === className);
  if (!node) return null;
  const methods = Object.values(graph.nodes).filter((candidate) => candidate.type === "method" || (candidate.type === "function" && candidate.file === node.file && candidate.startLine > node.startLine && candidate.startLine < node.endLine));
  return { type: "class", name: node.name, file: node.file, startLine: node.startLine, endLine: node.endLine, methods: methods.map((method) => ({ name: method.name, line: method.startLine })) };
}

export function queryExports(graph: CodeGraph): ExportsQueryResult {
  const byFile: Record<string, string[]> = {};
  for (const node of Object.values(graph.nodes).filter((candidate) => candidate.type === "function" || candidate.type === "class" || candidate.type === "interface")) {
    const fileName = node.file.split("/").pop() || node.file;
    byFile[fileName] ??= [];
    byFile[fileName].push(node.name);
  }
  return { type: "exports", exports: getTopExports(graph), byFile };
}

export function formatFileResult(result: FileQueryResult): string {
  const lines = [`File: ${result.file}`, `Declarations (${result.declarations.length}):`, ""];
  const byType = new Map<string, typeof result.declarations>();
  for (const declaration of result.declarations) byType.set(declaration.declarationType, [...(byType.get(declaration.declarationType) ?? []), declaration]);
  for (const [type, declarations] of byType) {
    lines.push(`**${type}s:**`);
    for (const declaration of declarations) lines.push(`- \`${declaration.name}\` (line ${declaration.startLine})${declaration.signature ? ` — ${declaration.signature}` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatFunctionResult(result: FunctionQueryResult): string {
  return [`Function: ${result.name}`, `File: ${result.file}`, `Lines: ${result.startLine}-${result.endLine}`, result.signature ? `Signature: ${result.signature}` : undefined, result.callers.length > 0 ? `Callers: ${result.callers.map((caller) => caller.name).join(", ")}` : "Callers: none"].filter(Boolean).join("\n");
}

export function formatClassResult(result: ClassQueryResult): string {
  return [`Class: ${result.name}`, `File: ${result.file}`, `Lines: ${result.startLine}-${result.endLine}`, `Methods: ${result.methods.map((method) => method.name).join(", ") || "none"}`].join("\n");
}

export function formatExportsResult(result: ExportsQueryResult): string {
  return [`Top exports (${result.exports.length} total):`, "", ...result.exports.map((name) => `  ${name}`)].join("\n");
}

function extractSignature(node: GraphNode): string | undefined {
  if (node.metadata?.signature) return String(node.metadata.signature);
  if (node.type === "function") return `function ${node.name}(...)`;
  if (node.type === "method") return `method ${node.name}(...)`;
  if (node.type === "class") return `class ${node.name}`;
  if (node.type === "interface") return `interface ${node.name}`;
  if (node.type === "type") return `type ${node.name}`;
  if (node.type === "enum") return `enum ${node.name}`;
  return undefined;
}
