import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { nativeAutoDraftDriver } from "../auto-draft.js";
import { autoVisibleTerminalText } from "../auto-terminal.js";
import type { PiAutoPair } from "../auto-contract.js";

test("finite producer transports a large bounded prompt on stdin, never argv, with every isolation flag", () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-producer-transport-")), old = process.env.PATH;
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    const file = join(bin, "pi");
    writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
const required = ["--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-approve", "--no-prompt-templates", "--no-session"];
if (process.argv.includes("--help")) process.stdout.write(required.join(" "));
else { const argv = process.argv.slice(2); if (!required.every(f => argv.includes(f))) process.exit(5);
const input = fs.readFileSync(0); process.stdout.write(JSON.stringify({ bytes: input.length, finalArgument: argv.at(-1), containsPrompt: argv.some(a => a.includes("SYNTHETIC-LARGE-SOURCE")) })); }
`); chmodSync(file, 0o755); process.env.PATH = `${bin}:${old}`;
    let checked = 0;
    const pair: PiAutoPair = { schemaVersion: "pa-auto-pair/v1", configRoot: root, configRevision: "a".repeat(40), resourcesSha256: "b".repeat(64), producer: "pa-auto-draft/v1", review: "pa-auto-start/v1", draftInstructions: "Synthetic source transport fixture, not real provider qualification",
      draft: { team: "requirements", mode: "auto-draft", provider: "openai", model: "fixture" }, implementation: { team: "builder", mode: "orchestrator", provider: "openai", model: "fixture" }, assertCurrent() { checked++; } };
    const prompt = "SYNTHETIC-LARGE-SOURCE\n".repeat(20000);
    const response = JSON.parse(nativeAutoDraftDriver().invoke(prompt, pair, 10000, root).toString("utf8"));
    assert.equal(response.bytes, Buffer.byteLength(prompt)); assert.equal(response.finalArgument, "--"); assert.equal(response.containsPrompt, false); assert.equal(checked, 1);
  } finally { if (old === undefined) delete process.env.PATH; else process.env.PATH = old; rmSync(root, { recursive: true, force: true }); }
});
test("native terminal rendering makes carriage returns/Unicode format controls visible without probing hostile values", () => {
  assert.equal(autoVisibleTerminalText("A\rB\r\nC\u061c\u202e\u0000\u009b"), "A\\u000dB\nC\\u061c\\u202e\\u0000\\u009b");
  assert.equal(autoVisibleTerminalText("Normal café\n\t🙂"), "Normal café\n\t🙂");
  let touched = false; const hostile = { get replace() { touched = true; throw new Error("must not probe"); }, toString() { touched = true; throw new Error("must not coerce"); } };
  assert.equal(autoVisibleTerminalText(hostile), "[unprintable text]"); assert.equal(touched, false);
});
