import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDb } from "../registry/db.js";
import { OBJECTIVE_PREVIEW_LIMIT, OBJECTIVE_SOURCE_LIMIT, OBJECTIVE_TEXT_LIMIT, readSessionObjectivePreviews, screenSessionObjective } from "../registry/session-objectives.js";
import { loadSensitivePatterns } from "../sensitive-patterns.js";
const patterns = loadSensitivePatterns("/nonexistent/objective-fixture-policy.yaml");

test("objective preview normalizes whitespace, bounds display text and screens the full source before clipping", () => {
  assert.deepEqual(screenSessionObjective("  Build the\n session dashboard.  ", patterns), { state: "available", preview: "Build the session dashboard.", text: "Build the session dashboard.", truncated: false });
  const long = screenSessionObjective("Build dashboard views. ".repeat(100), patterns); assert.equal(long.state, "available");
  if (long.state === "available") { assert.equal(long.preview.length, OBJECTIVE_PREVIEW_LIMIT); assert.equal(long.text.length, OBJECTIVE_TEXT_LIMIT); assert.equal(long.truncated, true); }
  const unicode = screenSessionObjective("a ".repeat(89) + "a😀 tail", patterns);
  assert.equal(unicode.state, "available"); if (unicode.state === "available") assert.equal(unicode.preview, "a ".repeat(89) + "a");
  const suffix = "Build dashboard views. ".repeat(60) + "password=" + "synthetic-fixture";
  const denied = screenSessionObjective(suffix, patterns); assert.equal(denied.state, "withheld"); assert.ok(!("text" in denied)); assert.ok(!("preview" in denied));
  for (const value of [null, undefined, "", " \n "]) assert.deepEqual(screenSessionObjective(value, patterns), { state: "unavailable", reason: "not-recorded" });
});
test("sensitive, path, structured, oversized and control-bearing objectives are wholly withheld", () => {
  const values = ["access_token=" + "x".repeat(40), "Bearer " + "a".repeat(40), "ssh-rsa " + "a".repeat(80), "-----BEGIN " + "PRIVATE KEY-----", "eyJ" + "a".repeat(10) + "." + "b".repeat(10) + "." + "c".repeat(10),
    "Inspect /private/project", "Open C:\\private\\project", "See https://example.invalid", '{"binding":"private"}', "[private metadata]", "x".repeat(OBJECTIVE_SOURCE_LIMIT + 1), "Build\u001b[31m view", "Build\u202e view", { raw: "private" }];
  for (const value of values) { const result = screenSessionObjective(value, patterns); assert.equal(result.state, "withheld"); assert.ok(!("text" in result)); }
  const local = { ...patterns, patterns: [...patterns.patterns, { inputClass: "content" as const, source: "local-config" as const, regex: /client-private/i }] };
  assert.equal(screenSessionObjective("Build view for client-private", local).state, "withheld");
  assert.equal(screenSessionObjective("Build view", { ...patterns, patterns: [{ inputClass: "content", source: "local-config", regex: { test: () => { throw new Error("private"); } } as unknown as RegExp }] }).state, "unavailable");
});
test("exact existing-only registry reads are fresh, exclude other runtimes, never export raw objectives or mutate DB", () => {
  const root = mkdtempSync(join(tmpdir(), "session-objectives-")), prior = process.env.PA_REGISTRY_DB, config = process.env.PA_PLATFORM_CONFIG;
  process.env.PA_REGISTRY_DB = join(root, "registry.db"); process.env.PA_PLATFORM_CONFIG = root;
  try {
    assert.deepEqual(readSessionObjectivePreviews([]), {}); assert.equal(existsSync(process.env.PA_REGISTRY_DB), false);
    assert.equal(readSessionObjectivePreviews(["d-000001"])["d-000001"]!.state, "unavailable"); assert.equal(existsSync(process.env.PA_REGISTRY_DB), false);
    const db = getDb();
    const add = db.prepare("INSERT INTO deployments (deployment_id, team, runtime, binary, objective) VALUES (?, 'fixture', ?, ?, ?)");
    add.run("d-000001", "pi", "ppa", "Build the session dashboard"); add.run("d-000002", "pi", "ppa", "password=" + "synthetic-value");
    add.run("d-000003", "pi", "ppa", "Build dashboard. ".repeat(400)); add.run("d-000004", "pi", "ppa", null); add.run("d-ffffff", "opencode", "opa", "Do not show this objective");
    db.pragma("wal_checkpoint(TRUNCATE)"); closeDb();
    const before = readFileSync(process.env.PA_REGISTRY_DB), result = readSessionObjectivePreviews(["d-000001", "d-000002", "d-000003", "d-000004", "d-ffffff"]);
    assert.equal(result["d-000001"]!.state, "available"); assert.equal(result["d-000002"]!.state, "withheld"); assert.equal(result["d-000003"]!.state, "withheld");
    assert.equal(result["d-000004"]!.state, "unavailable"); assert.equal(result["d-ffffff"]!.state, "unavailable");
    assert.ok(!JSON.stringify(result).includes("synthetic-value")); assert.ok(!JSON.stringify(result).includes("Do not show")); assert.deepEqual(readFileSync(process.env.PA_REGISTRY_DB), before);
    // Backup the disposable fixture before changing its existing data.
    copyFileSync(process.env.PA_REGISTRY_DB, join(root, "before-update.db"));
    getDb().prepare("UPDATE deployments SET objective = ? WHERE deployment_id = ?").run("Check changed dashboard text", "d-000001");
    const changed = readSessionObjectivePreviews(["d-000001"])["d-000001"]!; assert.equal(changed.state, "available"); if (changed.state === "available") assert.equal(changed.text, "Check changed dashboard text");
    writeFileSync(join(root, "sensitive-patterns.yaml"), "contents: ['[']\n");
    assert.deepEqual(readSessionObjectivePreviews(["d-000001"])["d-000001"], { state: "unavailable", reason: "screening-unavailable" });
  } finally { closeDb(); if (prior === undefined) delete process.env.PA_REGISTRY_DB; else process.env.PA_REGISTRY_DB = prior; if (config === undefined) delete process.env.PA_PLATFORM_CONFIG; else process.env.PA_PLATFORM_CONFIG = config; rmSync(root, { recursive: true, force: true }); }
});
test("objective selection rejects invalid IDs and over-limit requests without path interpolation", () => {
  for (const ids of [["../private"], ["d-000001'"], Array(10001).fill("d-000001")]) assert.throws(() => readSessionObjectivePreviews(ids), /Invalid objective selection/);
});
