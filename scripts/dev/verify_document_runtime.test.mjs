import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DOCUMENT_CASES, DOCUMENT_ENTRY_CASES, accountDocumentCases, accountDocumentEntries, accountDocumentImports, initialDocumentCases, qualifyDocumentRuntime, validateDocumentProfile } from "./verify_document_runtime.mjs";
import { createHarness, runHarness } from "./workflow_installed_harness.mjs";
import { cleanEnvironment, digest, git, implementationFiles, physicalFile } from "./workflow_installed_support.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const events = () => [...DOCUMENT_CASES.map(([, owner, name]) => ({ type: "test:pass", data: { name, file: join("/fixture/harness", owner.replace(/\.ts$/, ".js")), details: { type: "test" } } })), { type: "test:summary", data: { success: true, counts: { passed: DOCUMENT_CASES.length, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } }];
test("PAP-283 installed accounting requires all 45 exact document owners, not advisory cases or caller totals", () => {
  assert.equal(DOCUMENT_CASES.length, 45); assert.equal(new Set(initialDocumentCases().map(r => r.id)).size, initialDocumentCases().length);
  assert.equal(accountDocumentCases(events(), "/fixture/harness").cases.length, 45);
  for (const change of [
    e => e.splice(0, 1), e => e.unshift(e[0]), e => e[0].data.file = "/foreign/file.js", e => e[0].data.name = "actual Pi operation tool: failed check then safe diagnosis and recheck, no plan/catalogue/order",
    e => e[0].data.skip = true, e => e[0].data.todo = true, e => e[0].type = "test:fail", e => e.pop(), e => e.at(-1).data.success = false,
    e => e.at(-1).data.counts.cancelled = 1, e => e.at(-1).data.counts.passed = 100, e => e.at(-1).data.file = "/fixture/file.js",
  ]) { const e = events(); change(e); assert.throws(() => accountDocumentCases(e, "/fixture/harness")); }
  assert.throws(() => accountDocumentCases(events(), undefined));
});
test("default native/CLI entry inventory refuses omitted, substituted, duplicate or claimed-human observations", () => {
  const fixture = () => ({ schemaVersion: "pa-document-public-observations/v1", evidenceClass: "disposable-default-native-synthetic-ui-not-human-approval", cases: DOCUMENT_ENTRY_CASES.map(id => ({ id, status: "passed", observations: 1 })), sourceFallback: false, humanUat: false });
  assert.equal(accountDocumentEntries(fixture()).cases.length, 13);
  for (const change of [v => v.cases.pop(), v => v.cases[0] = v.cases[1], v => v.cases[0].status = "skipped", v => v.cases[0].observations = 0, v => v.sourceFallback = true, v => v.humanUat = true, v => v.evidenceClass = "human-accepted"]) { const v = fixture(); change(v); assert.throws(() => accountDocumentEntries(v)); }
});
test("document import audit requires document implementations and default native/CLI entry modules", () => {
  assert.throws(() => accountDocumentImports([{ kind: "implementation", path: "/installed/packages/pa-core/dist/operations/service.js" }], "/installed"));
  assert.throws(() => accountDocumentImports([], "/installed"));
});
test("new profile qualification requires the actual separate PAPC document selector, not advisory policy", async () => {
  const core = await import("../../packages/pa-core/dist/index.js");
  const yaml = "name: requirements\nobjective: test\ndeploy_modes:\n  - id: analyze\n    document_profile: pa-document-package/v1\n    skills:\n      - name: pa-requirements-workflow\n        inject-as: shared-skill\n";
  assert.equal(validateDocumentProfile(core, yaml, "Canonical new requirements process.").name, "requirements");
  for (const [candidate, skill] of [[yaml.replace("    document_profile: pa-document-package/v1\n", ""), "Advisory instructions"], [yaml, ""], [yaml.replace("requirements", "builder"), "text"], [yaml.replace("v1", "v2"), "text"], [yaml.replace("shared-skill", "reference"), "text"], [yaml.replace("pa-requirements-workflow", "other-skill"), "text"]]) assert.throws(() => validateDocumentProfile(core, candidate, skill));
});
test("document installed verifier rejects source/config/result/skip overrides and emits not-run facts without mutation", async () => {
  const before = git(root, "status", "--porcelain=v2", "--untracked-files=all");
  for (const args of [[], ["--source"], ["--selected-installed", "--require-candidate", "HEAD", "--require-paired-config"], ["--selected-installed", "--require-candidate", "a".repeat(40), "--require-paired-config", "--skip"], ["--selected-installed", "--require-candidate", "a".repeat(40), "--config-root", "/fixture"], ["--selected-installed", "--require-candidate", "a".repeat(40), "--require-paired-config", "--results", "PRIVATE_SENTINEL"]]) await assert.rejects(() => qualifyDocumentRuntime(args));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./verify_document_runtime.mjs", import.meta.url)), "--source", "PRIVATE_SENTINEL"], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 1); assert.equal(run.stderr, ""); assert.ok(!run.stdout.includes("PRIVATE_SENTINEL"));
  const report = JSON.parse(run.stdout); assert.equal(report.status, "blocked"); assert.equal(report.installationPerformed, false); assert.equal(report.enablementPerformed, false); assert.equal(report.humanApproval, false); assert.equal(report.humanUat, false);
  assert.ok(report.cases.every(row => row.status === "not-run")); assert.deepEqual(report.cases.map(r => r.id), initialDocumentCases().map(r => r.id)); assert.equal(git(root, "status", "--porcelain=v2", "--untracked-files=all"), before);
});
test("source-built document driver unit runs the pinned 45-case harness and default entry mechanics without an installed-pass claim", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pap283-driver-unit-")), directory = join(scratch, "harness");
  try {
    // No public source-mode exists. This internal harness/driver unit is NOT
    // selected-installed qualification and never runs qualifyDocumentRuntime.
    const sourceRoot = join(scratch, "source"); mkdirSync(sourceRoot);
    cpSync(join(root, "package.json"), join(sourceRoot, "package.json"));
    for (const name of ["pa-core", "pi-pa"]) { mkdirSync(join(sourceRoot, "packages", name), { recursive: true }); cpSync(join(root, "packages", name, "src"), join(sourceRoot, "packages", name, "src"), { recursive: true }); }
    symlinkSync(join(root, "node_modules"), join(sourceRoot, "node_modules"), "dir");
    git(sourceRoot, "init", "-q", "-b", "fixture"); git(sourceRoot, "add", "--", "package.json", "packages");
    git(sourceRoot, "-c", "user.name=Source-built driver unit", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Disposable driver fixture, not installed qualification");
    const sourceSha = git(sourceRoot, "rev-parse", "HEAD"), modules = Object.fromEntries(implementationFiles(root).map(path => [path, digest(physicalFile(join(root, path), 16_777_216))]));
    const harness = await createHarness({ sourceRoot, sourceSha, moduleRoot: root, directory, requiredTestFiles: [...new Set(DOCUMENT_CASES.map(([, owner]) => owner))] });
    const audit = join(scratch, "imports.jsonl"), frame = join(scratch, "imports-frame.json");
    writeFileSync(frame, JSON.stringify({ sourceRoot, moduleRoot: root, harness: directory, modules, bridges: harness.bridges, audit }), { mode: 0o600 });
    const loader = new URL("./workflow_import_register.mjs", import.meta.url); loader.searchParams.set("frame", frame);
    const env = { ...cleanEnvironment(), NODE_OPTIONS: `--import=${loader.href}`, HOME: join(scratch, "home"), PA_PLATFORM_CONFIG: join(scratch, "config"), PA_AI_USAGE_HOME: join(scratch, "usage"), PA_REGISTRY_DB: join(scratch, "registry.db"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...(process.env.PA_SQLITE_NATIVE_BINDING ? { PA_SQLITE_NATIVE_BINDING: process.env.PA_SQLITE_NATIVE_BINDING } : {}) };
    for (const name of ["HOME", "PA_PLATFORM_CONFIG", "PA_AI_USAGE_HOME"]) mkdirSync(env[name], { recursive: true });
    const result = runHarness({ directory, harness, env, reporter: fileURLToPath(new URL("./workflow_test_reporter.mjs", import.meta.url)), evidenceRoot: scratch, account: accountDocumentCases });
    assert.equal(result.cases.length, 45); assert.equal(result.tests.skipped, 0); assert.equal(result.tests.failed, 0);
    const bin = join(scratch, "bin"); mkdirSync(bin);
    for (const [binary, pkg] of [["ppa", "pi-pa"], ["opa", "opencode-pa"]]) writeFileSync(join(bin, binary), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(root, `packages/${pkg}/dist/cli.js`).replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    const entryFrame = join(scratch, "entry-frame.json"); writeFileSync(entryFrame, JSON.stringify({ share: root, ppa: join(bin, "ppa"), opa: join(bin, "opa"), evidenceRoot: scratch }), { mode: 0o600 });
    const entry = spawnSync(process.execPath, [fileURLToPath(new URL("./document_installed_entries.mjs", import.meta.url)), entryFrame], { cwd: directory, env, encoding: "utf8", timeout: 120000, maxBuffer: 1_048_576 });
    assert.ifError(entry.error); assert.equal(entry.signal, null); assert.equal(entry.status, 0, entry.stderr); assert.equal(entry.stderr, "");
    assert.equal(accountDocumentEntries(JSON.parse(entry.stdout)).cases.length, 13);
    const imports = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line)); accountDocumentImports(imports, root);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
