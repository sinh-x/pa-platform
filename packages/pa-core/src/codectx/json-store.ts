import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDataDir } from "../paths.js";
import type { CodeGraph } from "./types.js";

// Ported from PA codectx/json-store.ts at frozen PA source on 2026-04-26; data dir follows pa-platform data root.

export function getCodeContextDir(dataDir = resolve(getDataDir(), "code-context")): string {
  return dataDir;
}

export function getGraphPath(repo: string, dataDir?: string): string {
  const repoName = repo.split("/").pop() || repo;
  return resolve(getCodeContextDir(dataDir), repoName, "graph.json");
}

export function saveGraph(graph: CodeGraph, dataDir?: string): string {
  const graphPath = getGraphPath(graph.repo, dataDir);
  mkdirSync(dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, JSON.stringify(graph, null, 2), "utf-8");
  return graphPath;
}

export function loadGraph(repo: string, dataDir?: string): CodeGraph | null {
  const graphPath = getGraphPath(repo, dataDir);
  if (!existsSync(graphPath)) return null;
  try {
    return JSON.parse(readFileSync(graphPath, "utf-8")) as CodeGraph;
  } catch {
    return null;
  }
}

export function graphExists(repo: string, dataDir?: string): boolean {
  return existsSync(getGraphPath(repo, dataDir));
}

export function deleteGraph(repo: string, dataDir?: string): boolean {
  const graphPath = getGraphPath(repo, dataDir);
  if (!existsSync(graphPath)) return false;
  try {
    unlinkSync(graphPath);
    return true;
  } catch {
    return false;
  }
}
