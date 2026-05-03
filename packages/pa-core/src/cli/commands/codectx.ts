import { resolve } from "node:path";
import { analyzeRepo, formatClassResult, formatExportsResult, formatFileResult, formatFunctionResult, generateSummary, graphExists, loadGraph, queryClass, queryExports, queryFile, queryFunction, saveGraph } from "../../codectx/index.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

export function runCodeCtxCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === "analyze" || subcommand === "refresh") {
    const repoPath = rest[0] ? resolve(rest[0]) : process.cwd();
    const result = analyzeRepo(repoPath);
    saveGraph(result.graph);
    io.stdout(`${subcommand === "refresh" ? "Refreshed" : "Analyzed"} ${repoPath}: ${result.processed} files, ${result.errors} errors`);
    io.stdout(generateSummary(result.graph));
    return 0;
  }
  if (subcommand === "summary") {
    const repo = rest[0] ?? process.cwd();
    const graph = loadGraph(repo);
    if (!graph) return printError(`No graph found for ${repo}`, io);
    io.stdout(generateSummary(graph));
    return 0;
  }
  if (subcommand === "status") {
    const repo = rest[0] ?? process.cwd();
    const graph = loadGraph(repo);
    if (!graph) {
      io.stdout(`No graph found for: ${repo}`);
      return 1;
    }
    io.stdout(`Graph exists for: ${repo}`);
    io.stdout(`Generated: ${graph.generatedAt}`);
    io.stdout(`Nodes: ${graph.nodeCount}`);
    io.stdout(`Edges: ${graph.edgeCount}`);
    return 0;
  }
  if (subcommand === "query") {
    const queryTypes = new Set(["exports", "file", "function", "fn", "class"]);
    const [first, second, third] = rest;
    const oldStyle = first ? queryTypes.has(first) : false;
    const repo = oldStyle ? third ?? process.cwd() : first;
    const type = oldStyle ? first : second;
    const target = oldStyle ? second : third;
    if (!repo || !type) return printError("codectx query requires repo and type", io);
    const graph = loadGraph(repo);
    if (!graph) return printError(`No graph found for ${repo}`, io);
    if (type === "exports") io.stdout(formatExportsResult(queryExports(graph)));
    else if (type === "file" && target) {
      const result = queryFile(graph, target);
      if (!result) return printError(`File not found: ${target}`, io);
      io.stdout(formatFileResult(result));
    } else if ((type === "function" || type === "fn") && target) {
      const result = queryFunction(graph, target);
      if (!result) return printError(`Function not found: ${target}`, io);
      io.stdout(formatFunctionResult(result));
    } else if (type === "class" && target) {
      const result = queryClass(graph, target);
      if (!result) return printError(`Class not found: ${target}`, io);
      io.stdout(formatClassResult(result));
    } else return printError(`Unsupported codectx query: ${type}`, io);
    return 0;
  }
  if (subcommand === "exists") {
    const repo = rest[0] ?? process.cwd();
    io.stdout(graphExists(repo) ? "yes" : "no");
    return graphExists(repo) ? 0 : 1;
  }
  io.stderr(`Unknown codectx subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: analyze, refresh, summary, status, query, exists");
  return 1;
}
