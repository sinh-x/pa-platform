import { computeStats, getTopExports } from "./graph-builder.js";
import type { CodeGraph } from "./types.js";

// Ported from PA codectx/markdown-generator.ts at frozen PA source on 2026-04-26.

export function generateMarkdown(graph: CodeGraph, opts: { title?: string; includeExports?: boolean } = {}): string {
  const stats = computeStats(graph);
  const lines: string[] = [];
  lines.push(`# ${opts.title || "Codebase Overview"}`);
  lines.push("");
  lines.push(`> **Generated:** ${graph.generatedAt}`);
  lines.push(`> **Repository:** ${graph.repo}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Files | ${stats.files} |`);
  lines.push(`| Functions | ${stats.functions} |`);
  lines.push(`| Classes | ${stats.classes} |`);
  lines.push(`| Methods | ${stats.methods} |`);
  lines.push(`| Interfaces | ${stats.interfaces} |`);
  lines.push(`| Types | ${stats.types} |`);
  lines.push(`| Enums | ${stats.enums} |`);
  lines.push("");
  lines.push(`**Total nodes:** ${graph.nodeCount} | **Total edges:** ${graph.edgeCount}`);
  lines.push("");
  const topExports = getTopExports(graph);
  if (opts.includeExports !== false && topExports.length > 0) {
    lines.push("## Top-Level Exports");
    lines.push("");
    lines.push("```");
    for (const name of topExports) lines.push(`- ${name}`);
    lines.push("```");
    lines.push("");
  }
  lines.push("## Files");
  lines.push("");
  for (const fileNode of Object.values(graph.nodes).filter((node) => node.type === "file")) {
    lines.push(`### ${fileNode.name}${fileNode.exports?.length ? ` (exports: ${fileNode.exports.join(", ")})` : ""}`);
    lines.push("");
    lines.push(`Path: \`${fileNode.file}\``);
    lines.push("");
    const declarations = Object.values(graph.nodes).filter((node) => node.file === fileNode.file && node.type !== "file");
    if (declarations.length === 0) continue;
    lines.push("**Declarations:**");
    lines.push("");
    const byType = new Map<string, typeof declarations>();
    for (const declaration of declarations) byType.set(declaration.type, [...(byType.get(declaration.type) ?? []), declaration]);
    for (const [type, items] of byType) {
      lines.push(`**${type}s:**`);
      for (const item of items) lines.push(`- \`${item.name}\` (line ${item.startLine})`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function generateSummary(graph: CodeGraph): string {
  const stats = computeStats(graph);
  return [`Files: ${stats.files} | Functions: ${stats.functions} | Classes: ${stats.classes} | Interfaces: ${stats.interfaces}`, `Top exports: ${getTopExports(graph).slice(0, 10).join(", ")}`].join(" | ");
}
