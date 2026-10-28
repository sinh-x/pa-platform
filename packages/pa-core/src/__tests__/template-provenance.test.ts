import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { loadTemplateRegistry, selectedConfigHead } from "../templates/registry.js";
import { digest, strictJson, TemplateError } from "../templates/schema.js";
import { templateService } from "../templates/service.js";
import { templateFixture } from "./template-fixture.js";

test("selected revision is externally bound, not an impossible self-referential config commit", () => {
  const f = templateFixture(); try {
    f.registry.configRevision = "selected"; const selection = { ...f.save(), configRevision: "b".repeat(40) };
    const loaded = loadTemplateRegistry(selection); assert.equal(loaded.registry.configRevision, selection.configRevision);
    assert.equal(loaded.identity.registrySha256, digest(fs.readFileSync(join(f.root, "contracts/templates-v1.json"))));
    assert.equal(JSON.parse(fs.readFileSync(join(f.root, "contracts/templates-v1.json"), "utf8")).configRevision, "selected", "source bytes were not rewritten");
  } finally { f.dispose(); }
});
test("selected loose, packed and linked-worktree HEAD observation is bounded and spawns nothing", (t) => {
  const f = templateFixture(); try {
    const git = (...args: string[]) => childProcess.execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
    git("init", "-q", "-b", "develop"); git("config", "user.name", "Synthetic"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", "/dev/null");
    f.registry.configRevision = "selected"; const selection = f.save(); git("add", "."); git("commit", "-qm", "synthetic selected config"); const sha = git("rev-parse", "HEAD");
    assert.equal(selectedConfigHead(f.root), sha); assert.equal(loadTemplateRegistry({ ...selection, configRevision: sha }).registry.configRevision, sha);
    git("pack-refs", "--all"); const worktree = join(f.root, "linked"); git("worktree", "add", "--detach", worktree, sha);
    const forbidden = (): never => { throw new Error("forbidden process or write"); };
    const traps = [t.mock.method(childProcess, "execFileSync", forbidden), t.mock.method(childProcess, "spawnSync", forbidden), t.mock.method(childProcess, "spawn", forbidden), t.mock.method(fs, "writeFileSync", forbidden), t.mock.method(fs, "appendFileSync", forbidden)];
    syncBuiltinESMExports();
    try {
      assert.equal(selectedConfigHead(f.root), sha); assert.equal(selectedConfigHead(worktree), sha);
      for (const trap of traps) assert.equal(trap.mock.callCount(), 0);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    fs.writeFileSync(join(f.root, ".git/HEAD"), "ref: refs/heads/../SECRET-SENTINEL\n");
    assert.throws(() => selectedConfigHead(f.root), (e: unknown) => e instanceof TemplateError && !e.message.includes("SECRET-SENTINEL"));
  } finally { f.dispose(); }
});
test("storage/request/depth limits accept the exact bound and reject one-over without truncation", () => {
  const f = templateFixture(); try {
    const entry = f.registry.entries[0]!, bytes = Buffer.alloc(1_048_576, 65);
    fs.writeFileSync(join(f.root, entry.source.path), bytes); entry.source.sha256 = digest(bytes);
    assert.equal(loadTemplateRegistry(f.save()).sources.get(entry.id)!.raw.length, bytes.length);
    fs.appendFileSync(join(f.root, entry.source.path), "A"); assert.throws(() => loadTemplateRegistry(f.selection), TemplateError);
    const request = '{"action":"list"}';
    // Restore exact source before testing the independent request boundary.
    fs.writeFileSync(join(f.root, entry.source.path), bytes); const selection = f.save();
    assert.equal(templateService(Buffer.from(request.padEnd(65536)), { selection }).ok, true);
    assert.equal(templateService(Buffer.from(request.padEnd(65537)), { selection }).code, "TEMPLATE_SIZE");
    assert.doesNotThrow(() => strictJson(Buffer.from('{"x":' + '['.repeat(63) + '0' + ']'.repeat(63) + '}')));
    assert.throws(() => strictJson(Buffer.from('{"x":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}')), TemplateError);
  } finally { f.dispose(); }
});
