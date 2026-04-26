import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRepo, deleteGraph, formatExportsResult, generateMarkdown, generateSummary, graphExists, loadGraph, queryClass, queryExports, queryFile, queryFunction, saveGraph } from "../index.js";

test("codectx analyzes, queries, renders, and stores a graph", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-codectx-"));
  const dataDir = join(root, "data");
  try {
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "sample.ts"), [
      "export interface Thing { id: string }",
      "export type ThingId = string",
      "export enum Status { Ready }",
      "export class Worker { run() { return true } }",
      "export function makeThing(): Thing { return { id: '1' } }",
      "export const useThing = () => makeThing()",
    ].join("\n"));

    const result = analyzeRepo(root);
    assert.equal(result.errors, 0);
    assert.equal(result.stats.files, 1);
    assert.equal(result.stats.functions, 2);
    assert.equal(result.stats.classes, 1);
    assert.equal(result.stats.interfaces, 1);
    assert.equal(result.stats.types, 1);
    assert.equal(result.stats.enums, 1);

    assert.equal(queryFile(result.graph, "sample.ts")?.declarations.length, 6);
    assert.equal(queryFunction(result.graph, "makeThing")?.signature, "function makeThing(...)");
    assert.equal(queryClass(result.graph, "Worker")?.name, "Worker");
    assert.match(formatExportsResult(queryExports(result.graph)), /makeThing/);
    assert.match(generateMarkdown(result.graph, { title: "Sample" }), /# Sample/);
    assert.match(generateSummary(result.graph), /Functions: 2/);

    saveGraph(result.graph, dataDir);
    assert.equal(graphExists(root, dataDir), true);
    assert.equal(loadGraph(root, dataDir)?.nodeCount, result.graph.nodeCount);
    assert.equal(deleteGraph(root, dataDir), true);
    assert.equal(graphExists(root, dataDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
