import "./workflow_installed_support.test.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createHarness } from "./workflow_installed_harness.mjs";
import { committedRead, digest, git, implementationFiles, physicalFile } from "./workflow_installed_support.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, ""), driver = fileURLToPath(new URL("./verify_json_workflow_runtime.mjs", import.meta.url));
for (const args of [[], ["--selected-installed", "--require-candidate", "HEAD", "--require-paired-config"], ["--selected-installed", "--require-candidate", "a".repeat(40), "--require-paired-config", "--module", "PRIVATE-SENTINEL"], ["--selected-installed", "--require-candidate", "f".repeat(40), "--require-paired-config"]]) test(`public verifier fails closed for unsupported or mismatched shape ${args.length}`, () => {
  const before = git(root, "status", "--porcelain=v2", "--untracked-files=all");
  const r = spawnSync(process.execPath, [driver, ...args], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.equal(r.stderr, ""); const result = JSON.parse(r.stdout);
  assert.equal(result.status, "blocked"); assert.equal(result.installationPerformed, false); assert.equal(result.enablementPerformed, false); assert.equal(result.humanApproval, false);
  assert.equal(result.cases.length, 21); assert.ok(!result.cases.some(row => row.status === "passed")); assert.ok(!r.stdout.includes("PRIVATE-SENTINEL"));
  assert.ok(result.diagnostic.length < 2000); assert.equal(git(root, "status", "--porcelain=v2", "--untracked-files=all"), before);
});

test("private qualification bridges resolve real built modules, reject modified bridges and runtime source fallback", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pap271-loader-regression-")), directory = join(scratch, "harness");
  try {
    // This is a loader unit fixture, not exact-candidate qualification. Pin a
    // disposable copy of current test/source bytes instead of requiring the
    // developer's checkout to be clean. Real qualification still authenticates
    // the actual source checkout and installed closure without this seam.
    const sourceRoot = join(scratch, "source"); mkdirSync(sourceRoot);
    cpSync(join(root, "package.json"), join(sourceRoot, "package.json"));
    for (const name of ["pa-core", "pi-pa"]) {
      mkdirSync(join(sourceRoot, "packages", name), { recursive: true });
      cpSync(join(root, "packages", name, "src"), join(sourceRoot, "packages", name, "src"), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(sourceRoot, "node_modules"), "dir");
    git(sourceRoot, "init", "-q", "-b", "fixture");
    git(sourceRoot, "add", "--", "package.json", "packages");
    git(sourceRoot, "-c", "user.name=Synthetic loader fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Disposable loader fixture only");
    const sourceSha = git(sourceRoot, "rev-parse", "HEAD");
    const harness = await createHarness({ sourceRoot, sourceSha, moduleRoot: root, directory });
    for (const pkg of ["pa-core", "pi-pa"]) assert.ok(harness.tests.includes(join(directory, "packages", pkg, "src/__tests__/workflow-startup.test.js")));
    const modules = Object.fromEntries(implementationFiles(root).map(path => [path, digest(physicalFile(join(root, path), 16_777_216))]));
    const frame = join(scratch, "frame.json"), audit = join(scratch, "imports.jsonl");
    writeFileSync(frame, JSON.stringify({ sourceRoot, moduleRoot: root, harness: directory, modules, bridges: harness.bridges, audit }), { mode: 0o600 });
    const register = new URL("./workflow_import_register.mjs", import.meta.url); register.searchParams.set("frame", frame);
    const env = { PATH: process.env.PATH, HOME: scratch, NODE_OPTIONS: `--import=${register.href}` };
    const target = join(directory, "packages/pa-core/src/workflows/contracts.js");
    const invoke = path => spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path).href)})`], { cwd: directory, env, encoding: "utf8" });
    const valid = invoke(target); assert.equal(valid.status, 0, valid.stderr);
    const observed = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(observed.some(row => row.path === join(root, "packages/pa-core/dist/workflows/contracts.js")));
    writeFileSync(target, "export const substituted = true;\n");
    const changed = invoke(target); assert.notEqual(changed.status, 0); assert.match(changed.stderr, /modified implementation bridge/);
    const source = invoke(join(sourceRoot, "packages/pa-core/src/workflows/contracts.ts")); assert.notEqual(source.status, 0); assert.match(source.stderr, /runtime source fallback/);
    const sourcePath = "packages/pa-core/src/workflows/contracts.ts";
    writeFileSync(join(sourceRoot, sourcePath), "export const substituted = true;\n");
    assert.throws(() => committedRead(sourceRoot, sourceSha, sourcePath), error => error.code === "WORKFLOW_SOURCE_SUBSTITUTION");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
