import { SCHEMA_VERSION } from "./types.js";
import { nowUtc } from "../time.js";
import type { CodeGraph, GraphEdge, GraphNode, GraphStats } from "./types.js";

// Ported from PA codectx/graph-builder.ts at frozen PA source on 2026-04-26.

export function createEmptyGraph(repo: string): CodeGraph {
  return { schemaVersion: SCHEMA_VERSION, repo, generatedAt: nowUtc(), nodeCount: 0, edgeCount: 0, nodes: {}, edges: {}, fileIndex: {} };
}

export function addNode(graph: CodeGraph, node: GraphNode): void {
  graph.nodes[node.id] = node;
  graph.fileIndex[node.file] ??= [];
  if (!graph.fileIndex[node.file].includes(node.id)) graph.fileIndex[node.file].push(node.id);
  graph.nodeCount = Object.keys(graph.nodes).length;
}

export function addEdge(graph: CodeGraph, edge: GraphEdge): void {
  graph.edges[edge.id] = edge;
  graph.edgeCount = Object.keys(graph.edges).length;
}

export function buildRelationships(_graph: CodeGraph): void {
  // Relationship inference remains intentionally conservative until adapters need richer call graphs.
}

export function mergeParseResult(graph: CodeGraph, file: string, nodes: GraphNode[], edges: GraphEdge[]): void {
  const fileNodeId = `file:${file}`;
  if (!graph.nodes[fileNodeId]) addNode(graph, { id: fileNodeId, type: "file", name: file.split("/").pop() || file, file, startLine: 1, endLine: 1, exports: nodes.map((node) => node.name), imports: [] });
  for (const node of nodes) addNode(graph, node);
  for (const edge of edges) if (graph.nodes[edge.source] && graph.nodes[edge.target]) addEdge(graph, edge);
}

export function computeStats(graph: CodeGraph): GraphStats {
  const stats: GraphStats = { files: 0, functions: 0, classes: 0, methods: 0, interfaces: 0, types: 0, enums: 0, edges: graph.edgeCount };
  const files = new Set<string>();
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "file") files.add(node.file);
    if (node.type === "function") stats.functions++;
    else if (node.type === "class") stats.classes++;
    else if (node.type === "method") stats.methods++;
    else if (node.type === "interface") stats.interfaces++;
    else if (node.type === "type") stats.types++;
    else if (node.type === "enum") stats.enums++;
  }
  stats.files = files.size;
  return stats;
}

export function getTopExports(graph: CodeGraph): string[] {
  return Object.values(graph.nodes).filter((node) => node.type === "function" || node.type === "class" || node.type === "interface").map((node) => node.name).slice(0, 20);
}

export function findNodeByName(graph: CodeGraph, name: string): GraphNode | undefined {
  return Object.values(graph.nodes).find((node) => node.name === name);
}

export function findNodesByFile(graph: CodeGraph, file: string): GraphNode[] {
  return (graph.fileIndex[file] ?? []).map((id) => graph.nodes[id]).filter((node): node is GraphNode => !!node);
}

export function findCallers(graph: CodeGraph, functionName: string): GraphNode[] {
  return Object.values(graph.edges).filter((edge) => edge.type === "calls" && edge.target.endsWith(`:${functionName}:function`)).map((edge) => graph.nodes[edge.source]).filter((node): node is GraphNode => !!node);
}
