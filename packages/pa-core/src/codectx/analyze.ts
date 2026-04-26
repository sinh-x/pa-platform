import { computeStats, createEmptyGraph, mergeParseResult } from "./graph-builder.js";
import { extractDeclarations, findSourceFiles, parseFile } from "./parser.js";
import type { CodeGraph, GraphStats } from "./types.js";

export interface AnalyzeRepoOptions {
  verbose?: boolean;
  fileLimit?: number;
  onProgress?: (event: { file: string; processed: number; errors: number }) => void;
}

export interface AnalyzeRepoResult {
  graph: CodeGraph;
  stats: GraphStats;
  duration: number;
  processed: number;
  errors: number;
}

export function analyzeRepo(repoPath: string, options: AnalyzeRepoOptions = {}): AnalyzeRepoResult {
  const startTime = Date.now();
  const files = findSourceFiles(repoPath, options.fileLimit ?? 500);
  const graph = createEmptyGraph(repoPath);
  let processed = 0;
  let errors = 0;

  for (const file of files) {
    try {
      const parseResult = parseFile(file);
      if (!parseResult.success) {
        errors++;
        continue;
      }
      const { nodes, edges } = extractDeclarations(file);
      mergeParseResult(graph, file, nodes, edges);
      processed++;
      options.onProgress?.({ file, processed, errors });
    } catch {
      errors++;
    }
  }

  return { graph, stats: computeStats(graph), duration: Date.now() - startTime, processed, errors };
}
