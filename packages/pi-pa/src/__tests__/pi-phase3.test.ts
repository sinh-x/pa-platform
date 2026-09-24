import { mkdtempSync, readFileSync, statSync } from "node:fs";
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

test("Pi extension writes an unfiltered structured terminal status side channel", () => {
  const dir = mkdtempSync(join(tmpdir(), "ppa-terminal-status-"));
  const value = "synthetic-side-channel-value";
  const prefix = ["Bea", "rer"].join("");
  persistTerminalStatus([{ role: "assistant", stopReason: "error", errorMessage: `${prefix} ${value}` }], dir, { PA_DEPLOYMENT_ID: "d-extension-audit", PA_DEPLOYMENT_DIR: dir });
  const statusPath = join(dir, "pi-terminal-status.json");
  const status = readPiTerminalStatus(dir);
  assert.equal(status?.stopReason, "error");
  assert.equal(status?.error, `${prefix} ${value}`);
  assert.match(readFileSync(statusPath, "utf8"), new RegExp(value));
  assert.equal(statSync(statusPath).mode & 0o777, 0o600);
  const auditPath = join(dir, "pi-redaction-audit.jsonl");
  const audit = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { surfaceId: string; ruleId: string });
  assert.ok(audit.some((record) => record.surfaceId === "terminal-status" && record.ruleId === "bearer"));
  assert.ok(audit.some((record) => record.surfaceId === "extension-diagnostic" && record.ruleId === "bearer"));
  assert.equal(statSync(auditPath).mode & 0o777, 0o600);
});

test("trusted entrypoint registers only selected editors while preserving attributed PA modules", () => {
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
  const expectedEditorCommands = BUNDLED_EDITOR_FACTORIES.flatMap((factory) => {
    if (factory.startsWith("pi-vimmode@")) return ["vimmode"];
    if (factory.startsWith("proper-base@")) return ["fast-global", "__proper-restore-model", "clear", "__proper-cancel-prompt"];
    return [];
  });
  assert.deepEqual(registered, ["pa_ticket", "pa_bulletin", "pa_registry", "pa_status", "question", "todo"]);
  assert.deepEqual(commands, [...expectedEditorCommands, "pa-context", "pa-git-context"]);
  assert.deepEqual(shortcuts, ["alt+i", "alt+g"]);
});

test("Pi extension exposes bounded typed PA tools and native ticket read aliases", async () => {
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

  const ticket = tools.get("pa_ticket")!;
  for (const action of ["read", "show", "list", "comment"]) assert.equal(Check(ticket.parameters, { action }), true, action);
  for (const action of ["update", "delete", "other"]) assert.equal(Check(ticket.parameters, { action }), false, action);
  const read = await ticket.execute("tool-call-read", { action: "read", id: "PAP-218" }, undefined, undefined, undefined);
  const show = await ticket.execute("tool-call-show", { action: "show", id: "PAP-218" }, undefined, undefined, undefined);
  assert.equal(read.content[0]?.text, show.content[0]?.text);
  await assert.rejects(ticket.execute("tool-call-unknown", { action: "update" }, undefined, undefined, undefined), /Accepted actions: read, show, list, comment/);
  await assert.rejects(tools.get("pa_bulletin")!.execute("tool-call-error", { action: "other" }, undefined, undefined, undefined), /Only bulletin list is available/);
  assert.match(boundJson({ output: "x".repeat(60_000) }), /truncated/);
});

test("Pi safety interception uses declared path and bounded shell contexts", () => {
  const redirect = String.fromCharCode(62);
  for (const call of [
    { name: "question", input: { question: "Does credentials.json belong in this prose?", options: [] } },
    { name: "todo", input: { action: "add", text: "Document ~/.ssh/id_ed25519 without opening it" } },
    { name: "bash", input: { command: `ppa ticket list --project pa-platform --json ${redirect} /tmp/pap218-tickets.json` } },
    { name: "bash", input: { command: "ppa ticket list --json | python -c 'import json,sys; print(len(json.load(sys.stdin)))'" } },
    { name: "bash", input: { command: "for c in HEAD develop; do git cat-file -e $c && git merge-base HEAD $c && git log -1 $c; done" } },
    { name: "bash", input: { command: `printf ok 2${redirect}&1; exec 3${redirect}&-` } },
  ]) assert.equal(interceptToolCall(call).allowed, true, JSON.stringify(call));

  for (const call of [
    { name: "read", input: { path: ".env" } },
    { name: "bash", input: { command: "cat ~/.ssh/id_ed25519" } },
    { name: "bash", input: { command: `printf unsafe ${redirect} ./report.json` } },
    { name: "bash", input: { command: "/bin/" + "r" + "m /tmp/pap218-qualified-delete" } },
    { name: "bash", input: { command: "/usr/bin/sudo ./git cle" + "an -fd" } },
    { name: "bash", input: { command: "/bin/bash -lc '/usr/bin/git pu" + "sh origin main --for" + "ce'" } },
    { name: "bash", input: { command: `printf unsafe 2${redirect}1` } },
    { name: "bash", input: { command: `printf unsafe 1${redirect}2` } },
  ]) assert.equal(interceptToolCall(call).allowed, false, JSON.stringify(call));

  const deletion = interceptToolCall({ name: "bash", input: { command: "rm -rf /tmp/pap218-cleanup" } });
  assert.equal(deletion.allowed, false);
  assert.match(deletion.reason ?? "", /ppa trash move '\/tmp\/pap218-cleanup'/);
  assert.match(deletion.reason ?? "", /--reason '[^']+'/);
  assert.match(deletion.reason ?? "", /--yes/);
  assert.equal(interceptToolCall({ name: "read", input: { path: "README.md" } }).allowed, true);
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
