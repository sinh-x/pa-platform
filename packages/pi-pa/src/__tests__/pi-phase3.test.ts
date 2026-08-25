import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createPaTools, interceptToolCall, boundJson } from "../pi-extension/index.js";
import { removePi, setupPi, statusPi } from "../setup.js";

test("Pi setup is confirmation-gated and idempotent for local settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "ppa-setup-"));
  const extension = join(root, "extension");
  const config = join(root, "config");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(extension); mkdirSync(config);
  const first = await setupPi({ local: true, cwd: root, extensionPath: extension, configDir: config, piVersion: "0.80.8", confirm: async () => true });
  const second = await setupPi({ local: true, cwd: root, extensionPath: extension, configDir: config, piVersion: "0.80.8", confirm: async () => { throw new Error("should not confirm"); } });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(JSON.parse(readFileSync(first.settingsPath, "utf8")).packages, [extension, config]);
  assert.equal(statusPi({ local: true, cwd: root, extensionPath: extension, configDir: config }).configured, true);
  const removed = await removePi({ local: true, cwd: root, extensionPath: extension, configDir: config, confirm: async () => true });
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(readFileSync(first.settingsPath, "utf8")).packages, []);
});

test("Pi extension exposes only bounded typed PA tools and shared safety policy", () => {
  assert.deepEqual(createPaTools().map((tool) => tool.name), ["pa_ticket", "pa_bulletin", "pa_registry", "pa_status"]);
  assert.equal(interceptToolCall({ name: "bash", input: { command: "rm -rf build" } }).allowed, false);
  assert.equal(interceptToolCall({ name: "read", input: { path: ".env" } }).allowed, false);
  assert.equal(interceptToolCall({ name: "read", input: { path: "README.md" } }).allowed, true);
  assert.match(boundJson({ output: "x".repeat(60_000) }), /truncated/);
});
