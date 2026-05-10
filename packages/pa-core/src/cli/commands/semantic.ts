import { countIndexedSourcesByType, getSemanticIndexPath, querySemanticCandidates, rebuildSemanticCandidateIndex } from "../../semantic/index.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

export function runSemanticCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === "rebuild" || subcommand === "refresh") {
    const index = rebuildSemanticCandidateIndex();
    io.stdout(`Semantic index rebuilt: ${index.documents.length} sources`);
    io.stdout(`Index file: ${getSemanticIndexPath()}`);
    const counts = countIndexedSourcesByType(index);
    for (const [type, count] of Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))) io.stdout(`${type}: ${count}`);
    return 0;
  }
  if (subcommand === "query") {
    const topKFlag = rest.find((value) => value.startsWith("--top-k="));
    const topK = topKFlag ? Number(topKFlag.split("=")[1]) : 5;
    const query = rest.filter((value) => !value.startsWith("--top-k=")).join(" ").trim();
    if (!query) return printError("semantic query requires a search query", io);
    if (!Number.isFinite(topK) || topK <= 0) return printError("--top-k must be a positive number", io);
    const results = querySemanticCandidates(query, topK);
    io.stdout(`Query: ${results.query}`);
    io.stdout("Reflections:");
    if (results.reflections.length === 0) io.stdout("- none");
    for (const item of results.reflections) io.stdout(`- ${item.metadata.link} | ${item.title} | score=${item.score.toFixed(3)}`);
    io.stdout("System:");
    if (results.system.length === 0) io.stdout("- none");
    for (const item of results.system) io.stdout(`- ${item.metadata.link} | ${item.title} | score=${item.score.toFixed(3)}`);
    return 0;
  }
  io.stderr(`Unknown semantic subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: rebuild, refresh, query");
  return 1;
}
