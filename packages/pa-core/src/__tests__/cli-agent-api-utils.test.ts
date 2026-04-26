import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isInsideSandbox, normalizeSandboxPath, resolveContentInput, validateSandboxPath } from "../index.js";

test("resolveContentInput reads inline or file content and rejects ambiguous input", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-cli-utils-"));
  try {
    writeFileSync(join(root, "body.md"), "from file");
    assert.equal(resolveContentInput("inline", undefined, "summary", { cwd: root }), "inline");
    assert.equal(resolveContentInput(undefined, "body.md", "summary", { cwd: root }), "from file");
    assert.throws(() => resolveContentInput("inline", "body.md", "summary", { cwd: root }), /mutually exclusive/);
    assert.throws(() => resolveContentInput(undefined, "missing.md", "summary", { cwd: root }), /failed to read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox helpers normalize and validate ai-usage paths", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-sandbox-"));
  try {
    assert.equal(normalizeSandboxPath("agent-teams/builder/inbox/a.md", root), join(root, "agent-teams/builder/inbox/a.md"));
    assert.equal(normalizeSandboxPath("~/Documents/ai-usage/tickets/PAP-001.json", root), join(root, "tickets/PAP-001.json"));
    assert.equal(validateSandboxPath(join(root, "tickets/PAP-001.json"), root), join(root, "tickets/PAP-001.json"));
    assert.equal(isInsideSandbox(join(root, "tickets/PAP-001.json"), root), true);
    assert.equal(isInsideSandbox("/tmp/outside.md", root), false);
    assert.throws(() => validateSandboxPath("/tmp/outside.md", root), /outside sandbox root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
