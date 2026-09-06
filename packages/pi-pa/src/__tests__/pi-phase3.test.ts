import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import registerPiPaExtension, {
  PI_EXAMPLE_SOURCES,
  PI_EXAMPLE_VERSION,
  PI_PA_MODULES,
  createPaTools,
  interceptToolCall,
  boundJson,
  persistTerminalStatus,
} from "../pi-extension/index.js";
import { readPiTerminalStatus } from "../terminal-status.js";
import { BUNDLED_EDITOR_FACTORIES } from "../pi-extension/bundled-editors.js";
import { removePi, setupPi, statusPi } from "../setup.js";

test("Pi setup is confirmation-gated and idempotent for local settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "ppa-setup-"));
  const extension = join(root, "extension");
  const config = join(root, "config");
  const unrelated = join(root, "existing-package");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(extension); mkdirSync(config); mkdirSync(unrelated); mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi", "settings.json"), `${JSON.stringify({ packages: [unrelated], theme: "dark" }, null, 2)}\n`);
  const first = await setupPi({ local: true, cwd: root, extensionPath: extension, configDir: config, piVersion: "0.84.4", confirm: async () => true });
  const second = await setupPi({ local: true, cwd: root, extensionPath: extension, configDir: config, piVersion: "0.84.4", confirm: async () => { throw new Error("should not confirm"); } });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(JSON.parse(readFileSync(first.settingsPath, "utf8")).packages, [unrelated, extension, config]);
  assert.deepEqual(first.packages.filter((entry) => entry === extension || entry === config), [extension, config]);
  assert.equal(statusPi({ local: true, cwd: root, extensionPath: extension, configDir: config }).configured, true);
  const removed = await removePi({ local: true, cwd: root, extensionPath: extension, configDir: config, confirm: async () => true });
  assert.equal(removed.changed, true);
  const afterRemove = JSON.parse(readFileSync(first.settingsPath, "utf8")) as { packages: string[]; theme: string };
  assert.deepEqual(afterRemove.packages, [unrelated]);
  assert.equal(afterRemove.theme, "dark");
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

test("Pi extension composes attributed modules through the trusted entrypoint", () => {
  const registered: string[] = [];
  const commands: string[] = [];
  const shortcuts: string[] = [];
  registerPiPaExtension({
    registerTool: (tool) => registered.push(tool.name),
    registerCommand: (name) => { commands.push(name); },
    registerShortcut: (shortcut) => { shortcuts.push(shortcut); },
  });
  assert.equal(PI_EXAMPLE_VERSION, "0.80.8");
  assert.deepEqual(PI_EXAMPLE_SOURCES, [
    "examples/extensions/question.ts",
    "examples/extensions/todo.ts",
    "examples/extensions/status-line.ts",
    "examples/extensions/overlay-qa-tests.ts",
  ]);
  assert.equal(PI_PA_MODULES.length, 6);
  assert.deepEqual(BUNDLED_EDITOR_FACTORIES, ["pi-vimmode@0.9.0", "proper-base@0.5.0"]);
  assert.deepEqual(registered, ["pa_ticket", "pa_bulletin", "pa_registry", "pa_status", "question", "todo"]);
  assert.deepEqual(commands, ["vimmode", "fast-global", "__proper-restore-model", "clear", "__proper-cancel-prompt", "pa-context", "pa-git-context"]);
  assert.deepEqual(shortcuts, ["alt+i", "alt+g"]);
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
  assert.equal(interceptToolCall({ name: "question", input: { question: ".env", options: [] } }).allowed, false);
  assert.equal(interceptToolCall({ name: "todo", input: { action: "add", text: ".env" } }).allowed, false);
  assert.equal(interceptToolCall({ name: "read", input: { path: "README.md" } }).allowed, true);
  assert.match(boundJson({ output: "x".repeat(60_000) }), /truncated/);
});

test("PA JSON output is valid and bounded for ASCII, lines, and multibyte UTF-8", () => {
  for (const value of ["x".repeat(60_000), "é".repeat(30_000), "漢".repeat(30_000), "🔥".repeat(20_000), Array.from({ length: 2_500 }, (_, index) => `line-${index}`)]) {
    const output = boundJson({ output: value });
    assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
    assert.ok(output.split("\n").length <= 2_000);
    const parsed = JSON.parse(output) as { truncated?: boolean; preview?: string };
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.preview?.includes("�"), false);
  }
});
