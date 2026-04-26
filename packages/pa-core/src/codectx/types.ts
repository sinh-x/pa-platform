// Ported from PA codectx/types.ts at frozen PA source on 2026-04-26; pa-platform owns future changes.

export const SCHEMA_VERSION = "1.0.0";

export interface GraphNode {
  id: string;
  type: "file" | "function" | "class" | "method" | "interface" | "type" | "enum";
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  exports?: string[];
  imports?: string[];
  children?: string[];
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: "imports" | "calls" | "extends" | "implements" | "member-of";
}

export interface CodeGraph {
  schemaVersion: string;
  repo: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
  fileIndex: Record<string, string[]>;
}

export interface ParseResult {
  file: string;
  success: boolean;
  error?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphStats {
  files: number;
  functions: number;
  classes: number;
  methods: number;
  interfaces: number;
  types: number;
  enums: number;
  edges: number;
}
