import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { createPaTools, interceptToolCall, boundJson, persistTerminalStatus } from "../pi-extension/index.js";
import { readPiTerminalStatus } from "../terminal-status.js";
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

test("Pi extension writes a redacted structured terminal status side channel", () => {
  const dir = mkdtempSync(join(tmpdir(), "ppa-terminal-status-"));
  const value = "sentinel-side-channel-value";
  const prefix = ["Bea", "rer"].join("");
  persistTerminalStatus([{ role: "assistant", stopReason: "error", errorMessage: `${prefix} ${value}` }], dir, {});
  const status = readPiTerminalStatus(dir);
  assert.equal(status?.stopReason, "error");
  assert.equal(status?.error, "[REDACTED]");
  assert.doesNotMatch(readFileSync(join(dir, "pi-terminal-status.json"), "utf8"), new RegExp(value));
});

test("Pi extension exposes only bounded typed PA tools and shared safety policy", async () => {
  const tools = new Map(createPaTools().map((tool) => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], ["pa_ticket", "pa_bulletin", "pa_registry", "pa_status"]);
  for (const [name, input] of [
    ["pa_ticket", { action: "list" }],
    ["pa_bulletin", { action: "list" }],
    ["pa_registry", { action: "list" }],
    ["pa_status", { id: "d-not-found" }],
  ] as const) {
    const tool = tools.get(name)!;
    assert.equal(Check(tool.parameters, input), true);
    const result = await tool.execute(`tool-call-${name}`, input, undefined, undefined, undefined);
    assert.deepEqual(result.details, {});
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(typeof result.content[0]?.text, "string");
  }
  await assert.rejects(tools.get("pa_bulletin")!.execute("tool-call-error", { action: "other" }, undefined, undefined, undefined), /Only bulletin list is available/);
  assert.equal(interceptToolCall({ name: "bash", input: { command: "rm -rf build" } }).allowed, false);
  assert.equal(interceptToolCall({ name: "read", input: { path: ".env" } }).allowed, false);
  assert.equal(interceptToolCall({ name: "read", input: { path: "README.md" } }).allowed, true);
  assert.match(boundJson({ output: "x".repeat(60_000) }), /truncated/);
});
