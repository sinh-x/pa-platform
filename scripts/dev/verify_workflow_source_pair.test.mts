import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { templateFixture } from "../../packages/pa-core/src/__tests__/template-fixture.js";
import { bundle, bytes, definition, fixtureEvidence } from "../../packages/pa-core/src/__tests__/workflow-fixtures.js";
import { digest, parseReviewBundle } from "../../packages/pa-core/src/workflows/contracts.js";
import { templateService } from "../../packages/pa-core/src/templates/service.js";

const source = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", TSX_DISABLE_CACHE: "1" };
const git = (root: string, ...args: string[]) => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function init(root: string) { git(root, "init", "-q", "-b", "fixture"); git(root, "config", "user.name", "Synthetic source pairing"); git(root, "config", "user.email", "fixture@example.invalid"); git(root, "config", "commit.gpgsign", "false"); git(root, "config", "core.hooksPath", "/dev/null"); }
function commit(root: string) { git(root, "add", "."); git(root, "commit", "-qm", "synthetic source pair fixture"); return git(root, "rev-parse", "HEAD"); }
function snapshot(root: string): string {
  const files: string[] = [];
  const visit = (dir: string) => { for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stat = lstatSync(path); if (name === "node_modules") continue;
    if (stat.isDirectory()) visit(path); else files.push(`${path}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${digest(readFileSync(path))}`);
  } }; visit(root); return files.join("\n");
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pap271-source-handoff-"))), runtime = join(root, "runtime"), t = templateFixture(); mkdirSync(runtime);
  // Copy only tracked runtime code plus this handoff's small overlay, never the selected install/config.
  const archive = execFileSync("git", ["-C", source, "archive", "HEAD", ".gitignore", "package.json", "pnpm-lock.yaml", "packages/pa-core"], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", runtime], { input: archive });
  mkdirSync(join(runtime, "scripts/dev"), { recursive: true });
  cpSync(join(source, "scripts/dev/verify_workflow_source_pair.mts"), join(runtime, "scripts/dev/verify_workflow_source_pair.mts"));
  cpSync(join(source, "packages/pa-core/src/workflows"), join(runtime, "packages/pa-core/src/workflows"), { recursive: true });
  cpSync(join(source, "packages/pa-core/src/registry/workflows.ts"), join(runtime, "packages/pa-core/src/registry/workflows.ts"));
  symlinkSync(join(source, "node_modules"), join(runtime, "node_modules"));
  symlinkSync(join(source, "packages/pa-core/node_modules"), join(runtime, "packages/pa-core/node_modules"));
  init(runtime); const runtimeSha = commit(runtime);
  t.registry.configRevision = "selected";
  const entry = structuredClone(t.registry.entries[0]!); entry.id = "review-bundle"; entry.source = { path: "skills/templates/review-bundle.md", sha256: digest("{{bundle}}\n"), selector: null };
  entry.bindings = { bundle: { type: "json", required: true } }; entry.validation = { kind: "review-bundle", sections: [] };
  t.registry.entries.push(entry); writeFileSync(join(t.root, entry.source.path), "{{bundle}}\n"); t.save();
  const d = definition(), b = bundle(), evidence = fixtureEvidence(b), raw = bytes(d);
  mkdirSync(join(t.root, "workflows/definitions"), { recursive: true }); mkdirSync(join(t.root, "workflows/fixtures"));
  writeFileSync(join(t.root, "workflows/definitions/software.json"), raw);
  const manifest = { schemaVersion: "pa-workflow-manifest/v1", definitions: [{ workflowId: d.workflowId, version: d.version, file: "workflows/definitions/software.json", sha256: digest(raw) }], bindings: [{ schemaVersion: "pa-workflow-binding/v1", team: "requirements", mode: "analyze", enabled: false, workflowId: d.workflowId, workflowVersion: d.version }] };
  writeFileSync(join(t.root, "workflows/manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(t.root, "workflows/fixtures/requirements.md"), evidence.get(b.requirements.ref)!); writeFileSync(join(t.root, "workflows/fixtures/uat.md"), evidence.get(b.uat.ref)!);
  const templates = { root: t.root, configRevision: "a".repeat(40), registrySha256: digest(readFileSync(join(t.root, "contracts/templates-v1.json"))) };
  const fixtures = ["fresh", "amendment"].map(id => {
    const subject = structuredClone(b); if (id === "amendment") subject.handoff = { type: "amendment", baseSha: b.handoff.baseSha, branch: b.handoff.branch, branchAction: "reuse", featureSha: "c".repeat(40) };
    const request = { action: "render", id: "review-bundle", version: "1", bindings: { bundle: subject } };
    const rendered = templateService(request, { selection: templates, team: "requirements", mode: "analyze", reviewBundleConsumer: { schemaVersion: "pa-review-bundle/v1", validate: parseReviewBundle } }); assert.equal(rendered.ok, true);
    return { id, team: "requirements", mode: "analyze", producer: JSON.stringify(request), requirementsFile: "workflows/fixtures/requirements.md", uatFile: "workflows/fixtures/uat.md", candidateSha256: digest(rendered.candidate as string) };
  });
  const document = { schemaVersion: "pa-workflow-fixtures/v1", fixtures }; writeFileSync(join(t.root, "workflows/fixtures-v1.json"), JSON.stringify(document));
  init(t.root); let configSha = commit(t.root);
  const invoke = (extra: string[] = [], override: { runtimeSha?: string; configSha?: string } = {}) => {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(runtime, "scripts/dev/verify_workflow_source_pair.mts"), "--runtime-sha", override.runtimeSha ?? runtimeSha, "--config-root", t.root, "--config-sha", override.configSha ?? configSha, ...extra], { env, encoding: "utf8", timeout: 30_000, maxBuffer: 131_072 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.stderr, "");
    return { code: result.status, report: JSON.parse(result.stdout.trim()) };
  };
  return { root, runtime, runtimeSha, config: t.root, manifest, document, invoke, commitConfig: () => { configSha = commit(t.root); return configSha; }, close: () => { t.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test("pinned disabled source pair exercises actual producer/CLI/selector with zero source/config/metadata mutations", () => {
  const f = fixture(); try {
    const before = [snapshot(f.runtime), snapshot(f.config)];
    const result = f.invoke(); assert.equal(result.code, 0, JSON.stringify(result.report));
    assert.equal(result.report.status, "compatible-disabled-source-drafts"); assert.equal(result.report.bindingsEnabled, false); assert.equal(result.report.executionAdmitted, false); assert.equal(result.report.humanApproval, false);
    assert.equal(result.report.fixtures.length, 2); assert.ok(result.report.fixtures.every((c: { bindingEnabled: boolean }) => !c.bindingEnabled));
    assert.equal(result.report.checks.find((c: { id: string }) => c.id === "source-cli-template-consumer-parity").cases, 24);
    assert.deepEqual([snapshot(f.runtime), snapshot(f.config)], before);
  } finally { f.close(); }
});
test("wrong revisions, dirty sources and forbidden override flags block without mutation or secret echoes", () => {
  const f = fixture(); try {
    for (const override of [{ runtimeSha: "b".repeat(40) }, { configSha: "c".repeat(40) }]) assert.equal(f.invoke([], override).code, 1);
    for (const flag of ["--force", "--allow-dirty", "--enabled", "--passed"]) { const result = f.invoke([flag, "SECRET-SENTINEL"]); assert.equal(result.code, 1); assert.ok(!JSON.stringify(result.report).includes("SECRET-SENTINEL")); }
    writeFileSync(join(f.runtime, "untracked.txt"), "preserve runtime change"); assert.equal(f.invoke().report.code, "RUNTIME_DIRTY"); rmSync(join(f.runtime, "untracked.txt"));
    writeFileSync(join(f.config, "workflows/fixtures/uat.md"), "preserve config change"); assert.equal(f.invoke().report.code, "CONFIG_DIRTY");
  } finally { f.close(); }
});
test("enabled bindings, missing handoff coverage and changed artifact digests are blocking, never skipped", () => {
  const f = fixture(); try {
    f.manifest.bindings[0]!.enabled = true; writeFileSync(join(f.config, "workflows/manifest.json"), JSON.stringify(f.manifest)); f.commitConfig(); assert.equal(f.invoke().report.code, "DISABLED_BINDINGS_REQUIRED");
    f.manifest.bindings[0]!.enabled = false; writeFileSync(join(f.config, "workflows/manifest.json"), JSON.stringify(f.manifest));
    const original = structuredClone(f.document.fixtures); f.document.fixtures.pop(); writeFileSync(join(f.config, "workflows/fixtures-v1.json"), JSON.stringify(f.document)); f.commitConfig(); assert.equal(f.invoke().code, 1);
    f.document.fixtures = original; writeFileSync(join(f.config, "workflows/fixtures-v1.json"), JSON.stringify(f.document)); writeFileSync(join(f.config, "workflows/fixtures/uat.md"), "changed but not reflected in the subject"); f.commitConfig(); assert.equal(f.invoke().code, 1);
  } finally { f.close(); }
});
test("ignored substitutions and hostile Git fsmonitor cannot execute or supply fixture authority", () => {
  const f = fixture(); try {
    const sentinel = join(f.root, "forbidden-effect"), monitor = join(f.root, "monitor.sh"); writeFileSync(monitor, `#!/bin/sh\necho forbidden > '${sentinel}'\n`, { mode: 0o700 });
    git(f.config, "config", "core.fsmonitor", monitor); assert.equal(f.invoke().code, 0); assert.equal(existsSync(sentinel), false);
    // An ignored overlay is not present in the pinned Git tree, even when status looks clean.
    git(f.config, "rm", "--cached", "workflows/fixtures/uat.md"); writeFileSync(join(f.config, ".gitignore"), "workflows/fixtures/uat.md\n"); f.commitConfig();
    const result = f.invoke(); assert.equal(result.code, 1); assert.equal(existsSync(sentinel), false);
  } finally { f.close(); }
});
