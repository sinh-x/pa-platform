import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectLocalProjectCommandCatalogue } from "../project-command-catalogue-files.js";
import { MAX_PROJECT_COMMAND_CATALOGUE_BYTES, ProjectCatalogueError } from "../project-command-catalogue.js";

function fixture(run: (f: { root: string; repo: string; parent: string; file: string; value: ReturnType<typeof candidate>; save(): void }) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap273-catalogue-files-")), environment = process.env;
  process.env = { ...environment };
  try {
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
    const repo = join(root, "repo"), config = join(root, "config"), parent = join(repo, ".pa"), file = join(parent, "project-commands.json");
    mkdirSync(repo); mkdirSync(config); process.env.PA_PLATFORM_CONFIG = config;
    writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: repo } } }));
    const value = candidate(repo);
    run({ root, repo, parent, file, value, save() { mkdirSync(parent, { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); } });
  } finally { process.env = environment; rmSync(root, { recursive: true, force: true }); }
}
function candidate(root: string) {
  return { schemaVersion: "project-command-catalogue/v1", repository: { key: "example", root }, effects: ["project-read", "isolated-temp-write"], commands: [
    { id: "unit", executable: "/nix/store/nonexistent-fixture/bin/node", argv: ["test.cjs"], environment: {}, readPaths: [],
      prerequisites: [{ path: "test.cjs", sha256: "a".repeat(64) }], timeoutSeconds: 60, maximumOutputBytes: 1024 },
  ] };
}
function tree(root: string): unknown {
  return readdirSync(root).sort().map(name => { const path = join(root, name), stat = lstatSync(path);
    return [name, stat.mode, stat.ino, stat.ctimeMs, stat.isDirectory() ? tree(path) : stat.isFile() ? readFileSync(path).toString("base64") : "alias"];
  });
}

test("local catalogue absence is a read-only observation and never bootstraps directories or approvals", () => fixture(f => {
  const before = tree(f.root); assert.equal(inspectLocalProjectCommandCatalogue("example", f.repo), null); assert.deepEqual(tree(f.root), before);
  mkdirSync(f.parent, { mode: 0o700 }); const empty = tree(f.root);
  assert.equal(inspectLocalProjectCommandCatalogue("example", f.repo), null); assert.deepEqual(tree(f.root), empty);
  // An unrelated real .pa directory is not itself command-source adoption.
  chmodSync(f.parent, 0o755); const unrelated = tree(f.root);
  assert.equal(inspectLocalProjectCommandCatalogue("example", f.repo), null); assert.deepEqual(tree(f.root), unrelated);
}));

test("registered-root candidate inspection reads only exact candidate bytes without probing project executables or prerequisites", () => fixture(f => {
  f.save(); const before = tree(f.root), observed = inspectLocalProjectCommandCatalogue("example", f.repo)!;
  assert.equal(observed.repository.root, f.repo); assert.equal(observed.commands.length, 1); assert.deepEqual(tree(f.root), before);
  f.value.commands[0]!.argv = ["changed.cjs"]; f.save();
  assert.notEqual(inspectLocalProjectCommandCatalogue("example", f.repo)!.sha256, observed.sha256);
  assert.equal(observed.commands[0]!.argv[0], "test.cjs");
}));

for (const variant of ["unknown-repo", "wrong-root", "root-alias", "parent-alias", "dangling-parent", "parent-permissions", "file-alias", "dangling-file", "file-directory", "hard-link", "file-permissions", "oversized", "malformed", "wrong-repository", "legacy-schema"] as const) {
  test(`local candidate rejects ${variant} without mutation or fallback`, () => fixture(f => {
    f.save(); let root = f.repo, key = "example";
    if (variant === "unknown-repo") key = "other";
    if (variant === "wrong-root") root = f.root;
    if (variant === "root-alias") { root = join(f.root, "repo-alias"); symlinkSync(f.repo, root); }
    if (variant === "parent-alias" || variant === "dangling-parent") {
      const other = join(f.root, "administrative"); renameSync(f.parent, other);
      symlinkSync(variant === "parent-alias" ? other : join(f.root, "absent"), f.parent);
    }
    if (variant === "parent-permissions") chmodSync(f.parent, 0o755);
    if (variant === "file-alias" || variant === "dangling-file") {
      const other = join(f.root, "candidate.json"); renameSync(f.file, other);
      symlinkSync(variant === "file-alias" ? other : join(f.root, "absent"), f.file);
    }
    if (variant === "file-directory") { rmSync(f.file); mkdirSync(f.file); }
    if (variant === "hard-link") linkSync(f.file, join(f.root, "hard-linked.json"));
    if (variant === "file-permissions") chmodSync(f.file, 0o644);
    if (variant === "oversized") writeFileSync(f.file, Buffer.alloc(MAX_PROJECT_COMMAND_CATALOGUE_BYTES + 1));
    if (variant === "malformed") writeFileSync(f.file, "PRIVATE-SENTINEL");
    if (variant === "wrong-repository") { f.value.repository.key = "elsewhere"; f.save(); }
    if (variant === "legacy-schema") { f.value.schemaVersion = "project-command-contract/v1"; f.save(); }
    const before = tree(f.root);
    assert.throws(() => inspectLocalProjectCommandCatalogue(key, root), error => error instanceof ProjectCatalogueError && !error.message.includes("PRIVATE-SENTINEL"));
    assert.deepEqual(tree(f.root), before);
  }));
}
