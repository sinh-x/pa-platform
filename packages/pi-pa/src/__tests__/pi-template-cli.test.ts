import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { templateService } from "../../../pa-core/src/templates/service.js";
import { completeTemplateFixture } from "../../../pa-core/src/__tests__/template-complete-fixture.js";
import { DOCUMENT_DIAGNOSTIC_CASES } from "../../../pa-core/src/__tests__/template-document-diagnostic-fixture.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
function snapshot(root: string): string[] {
  const result: string[] = [];
  const walk = (path: string, relative = "") => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`, child = join(path, entry.name);
    if (entry.isDirectory()) { result.push(`directory:${name}`); walk(child, name); }
    else if (entry.isSymbolicLink()) result.push(`alias:${name}`);
    else result.push(`file:${name}:${createHash("sha256").update(readFileSync(child)).digest("hex")}`);
  } };
  walk(root); return result.sort();
}
test("actual built PPA entry handles template revisions and all sixteen producers without global-version interception", { timeout: 120000 }, () => {
  const f = completeTemplateFixture(), stage = mkdtempSync(join(tmpdir(), "pap270-public-ppa-"));
  try {
    // Disposable config commit binds its registry externally, avoiding self-hash.
    f.registry.configRevision = "selected"; const unpinned = f.save();
    const ids = f.registry.entries.map(e => e.id);
    const consumers = [{ team: "requirements", mode: "analyze", templates: ids }, { team: "requirements", mode: "review-auto", templates: ids }, { team: "builder", mode: "orchestrator", templates: ids }];
    for (const row of consumers) { const path = join(f.root, "teams", row.team, "modes", `${row.mode}.md`); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `# Synthetic selected template adoption\nUse ppa template list --format json and pa_template with a raw request document. All outputs remain unsigned; no human authority or native facts.\nSelected IDs: ${ids.join(", ")}.\n`); }
    writeFileSync(join(f.root, "teams/requirements.yaml"), "name: requirements\ndescription: Synthetic fixture only\nobjective: Compile selected instructions only\nagents:\n  - name: analyst\n    role: Synthetic analyst\n    instruction: teams/requirements/modes/analyze.md\n  - name: reviewer\n    role: Synthetic reviewer\n    instruction: teams/requirements/modes/review-auto.md\ndeploy_modes:\n  - id: analyze\n    label: Synthetic analyze\n    agents: [analyst]\n  - id: review-auto\n    label: Synthetic review\n    agents: [reviewer]\n");
    writeFileSync(join(f.root, "teams/builder.yaml"), "name: builder\ndescription: Synthetic fixture only\nobjective: Compile selected instructions only\nagents:\n  - name: orchestrator\n    role: Synthetic direct phase owner\n    instruction: teams/builder/modes/orchestrator.md\ndeploy_modes:\n  - id: orchestrator\n    label: Synthetic direct owner\n    agents: [orchestrator]\n");
    writeFileSync(join(f.root, ".gitignore"), "/repository/\n/ai/\n/user-config/\n");
    writeFileSync(join(f.root, "contracts/templates-adoption-v1.json"), JSON.stringify({ schemaVersion: "pa-template-adoption/v1", registrySha256: unpinned.registrySha256, consumers }));
    const provisional = { ...unpinned, configRevision: f.selection.configRevision };
    writeFileSync(join(f.root, "contracts/templates-fixtures-v1.json"), JSON.stringify({ schemaVersion: "pa-template-fixtures/v1", fixtures: f.registry.entries.map(e => { const r = templateService({ action: "render", id: e.id, version: e.revision, bindings: f.allBindings[e.id] }, { selection: provisional }); assert.equal(r.ok, true); return { id: e.id, version: e.revision, bindings: f.allBindings[e.id], candidateSha256: createHash("sha256").update(r.candidate as string).digest("hex"), context: { team: "requirements", mode: "analyze" } }; }) }));
    const env = { PATH: process.env.PATH, HOME: join(stage, "home"), LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", f.root, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q", "-b", "develop"); git("config", "user.name", "Synthetic template fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", "/dev/null");
    git("add", ".gitignore", "contracts", "skills", "teams"); git("commit", "-qm", "synthetic config resources");
    const selection = { ...unpinned, configRevision: git("rev-parse", "HEAD") };
    git("update-ref", "refs/remotes/origin/develop", selection.configRevision); // synthetic cache only, never a real merge
    for (const pkg of ["pa-core", "pi-pa"]) {
      const target = join(stage, "packages", pkg); mkdirSync(target, { recursive: true });
      cpSync(join(workspace, "packages", pkg, "dist"), join(target, "dist"), { recursive: true });
      cpSync(join(workspace, "packages", pkg, "package.json"), join(target, "package.json"));
    }
    // External dependencies retain their real package identity; workspace PA
    // imports must resolve to the copied candidate, not the original checkout.
    const modules = join(stage, "node_modules"); mkdirSync(modules);
    const link = (name: string, source: string) => { const target = join(modules, name); if (existsSync(target)) return; mkdirSync(dirname(target), { recursive: true }); symlinkSync(realpathSync(source), target); };
    for (const root of [join(workspace, "node_modules"), join(workspace, "packages/pa-core/node_modules"), join(workspace, "packages/pi-pa/node_modules")]) {
      for (const e of readdirSync(root)) {
        if (e.startsWith(".")) continue;
        if (e.startsWith("@")) { if (e !== "@pa-platform") for (const child of readdirSync(join(root, e))) link(`${e}/${child}`, join(root, e, child)); }
        else link(e, join(root, e));
      }
    }
    mkdirSync(join(modules, "@pa-platform"), { recursive: true }); symlinkSync(join(stage, "packages/pa-core"), join(modules, "@pa-platform/pa-core"));
    writeFileSync(join(stage, ".pa-platform-config.sha"), selection.configRevision + "\n"); writeFileSync(join(stage, ".pa-template-registry.sha"), selection.registrySha256 + "\n");
    const cases: Array<{ argv: string[]; body?: string; exitCode: number; repeats: number; expected: unknown; request: Record<string, unknown> }> = [];
    const add = (request: Record<string, unknown>, repeats = 1) => {
      const action = request.action as string, body = action === "render" ? { bindings: request.bindings } : action === "validate" ? { bindings: request.bindings, candidate: request.candidate } : undefined;
      const expected = templateService(request, { selection });
      cases.push({ argv: ["template", action, ...(action === "list" ? [] : [request.id as string, "--version", request.version as string]), "--format", "json"], ...(body ? { body: JSON.stringify(body) } : {}), expected, exitCode: expected.ok ? 0 : 1, repeats, request });
    };
    add({ action: "list" });
    for (const entry of f.registry.entries) {
      const input = { id: entry.id, version: entry.revision }, bindings = f.allBindings[entry.id]!;
      const r = templateService({ action: "render", ...input, bindings }, { selection }); assert.equal(r.ok, true, JSON.stringify(r));
      add({ action: "show", ...input }); add({ action: "render", ...input, bindings }, 20); add({ action: "validate", ...input, bindings, candidate: r.candidate });
      add({ action: "render", ...input, bindings: { ...bindings, foreignField: "SECRET-SENTINEL" } });
      add({ action: "show", ...input, version: "unsupported" });
    }
    const packet = join(stage, "fixture-cases.json"); writeFileSync(packet, JSON.stringify(cases));
    const cli = join(stage, "packages/pi-pa/dist/cli.js");
    const before = { config: snapshot(f.root), candidate: snapshot(stage) };
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./template-cli-worker.mjs", import.meta.url)), cli, packet], { env: { ...env, PA_PLATFORM_HOME: f.root, PA_PLATFORM_TEAMS: join(f.root, "teams"), PA_PLATFORM_CONFIG: join(stage, "empty-config") }, encoding: "utf8", timeout: 110000, maxBuffer: 1_048_576 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout); assert.equal(report.passed, true); assert.equal(report.cases, cases.reduce((sum, c) => sum + c.repeats, 0));
    assert.ok(!result.stdout.includes("SECRET-SENTINEL"));
    assert.deepEqual({ config: snapshot(f.root), candidate: snapshot(stage) }, before, "success/rejection created no persistent artifacts, approvals or workflow state");
    assert.equal(readFileSync(join(stage, ".pa-template-registry.sha"), "utf8"), selection.registrySha256 + "\n");
    // Exercise the actual qualification driver in a disposable candidate layout.
    const driver = join(stage, "scripts/dev/verify_template_contracts.mjs"); mkdirSync(dirname(driver), { recursive: true }); cpSync(join(workspace, "scripts/dev/verify_template_contracts.mjs"), driver);
    cpSync(join(workspace, "scripts/dev/workflow_installed_support.mjs"), join(stage, "scripts/dev/workflow_installed_support.mjs"));
    const marker = join(stage, "forbidden-fsmonitor-effect"), monitor = join(stage, "unsafe-monitor.sh"); writeFileSync(monitor, `#!/bin/sh\nprintf forbidden > '${marker}'\n`, { mode: 0o700 }); git("config", "core.fsmonitor", monitor);
    const qualify = (args: string[]) => spawnSync(process.execPath, [driver, ...args], { env: { ...env, PA_PLATFORM_HOME: f.root, PA_PLATFORM_TEAMS: join(f.root, "teams"), PA_PLATFORM_CONFIG: join(stage, "empty-config") }, encoding: "utf8", timeout: 90000, maxBuffer: 1_048_576 });
    const paired = qualify(["--mode", "paired-config"]); assert.equal(paired.status, 0, paired.stdout + paired.stderr); const qualified = JSON.parse(paired.stdout);
    assert.equal(qualified.status, "passed"); assert.equal(qualified.consumers, 3); assert.equal(qualified.comparisons, 16 * 4 * 20); assert.equal(qualified.negativeCases, 16 * 5); assert.ok(qualified.runtime.moduleSha256["packages/pi-pa/dist/cli.js"]); assert.equal(existsSync(marker), false, "qualification never runs config-provided Git hooks/monitors");
    // Bad but exactly selected sources must expose the SAME bounded first-rule
    // error through the built public CLI and default native registration. Each
    // revision is a synthetic disposable commit, never a production pin change.
    for (const c of DOCUMENT_DIAGNOSTIC_CASES) {
      const entry = f.registry.entries.find(e => e.id === c.id)!, path = join(f.root, entry.source.path), original = readFileSync(path, "utf8");
      const mutated = c.mutate(original); assert.notEqual(mutated, original);
      writeFileSync(path, mutated); entry.source.sha256 = createHash("sha256").update(mutated).digest("hex");
      const selected = f.save(); git("add", "contracts/templates-v1.json", "skills/templates"); git("commit", "-qm", "synthetic malformed document rule");
      const current = { ...selected, configRevision: git("rev-parse", "HEAD") };
      // Same candidate and build-provenance pins across every compatible config revision.
      const rejectedCases = ["render", "validate"].map(action => {
        const body = { bindings: f.allBindings[c.id], ...(action === "validate" ? { candidate: "SECRET-SENTINEL" } : {}) };
        const request = { action, id: c.id, version: entry.revision, ...body }, expected = templateService(request, { selection: current });
        assert.equal(expected.code, "TEMPLATE_STRUCTURE"); assert.ok((expected.diagnostic as string).includes(`Source: document.${c.rule}\n`));
        assert.ok(!JSON.stringify(expected).includes("SECRET-SENTINEL"));
        return { argv: ["template", action, c.id, "--version", entry.revision, "--format", "json"], body: JSON.stringify(body), request, expected, exitCode: 1, repeats: 1 };
      });
      writeFileSync(packet, JSON.stringify(rejectedCases));
      const beforeRejection = { config: snapshot(f.root), candidate: snapshot(stage) };
      const rejected = spawnSync(process.execPath, [fileURLToPath(new URL("./template-cli-worker.mjs", import.meta.url)), cli, packet], { env: { ...env, PA_PLATFORM_HOME: f.root, PA_PLATFORM_TEAMS: join(f.root, "teams"), PA_PLATFORM_CONFIG: join(stage, "empty-config") }, encoding: "utf8", timeout: 15000, maxBuffer: 65536 });
      assert.equal(rejected.status, 0, rejected.stderr); assert.equal(rejected.stderr, ""); assert.equal(JSON.parse(rejected.stdout).cases, 2);
      assert.deepEqual({ config: snapshot(f.root), candidate: snapshot(stage) }, beforeRejection, "rejection is read-only through both default public entry points");
      writeFileSync(path, original); entry.source.sha256 = createHash("sha256").update(original).digest("hex");
    }
    const restored = f.save(); git("add", "contracts/templates-v1.json", "skills/templates"); git("commit", "-qm", "restore synthetic valid document sources");
    assert.equal(restored.registrySha256, selection.registrySha256);
    // An adopted instruction disappearing at a newly pinned clean revision is a
    // blocked required case, not a skipped consumer or a fallback formatter.
    writeFileSync(join(f.root, "teams/builder/modes/orchestrator.md"), "# Missing template adoption\nNo source/approval effects.\n"); git("add", "teams"); git("commit", "-qm", "synthetic missing adoption"); git("update-ref", "refs/remotes/origin/develop", git("rev-parse", "HEAD"));
    const rejected = qualify(["--mode", "paired-config"]); assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stdout).status, "blocked"); assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(join(stage, ".pa-platform-config.sha"), "utf8"), selection.configRevision + "\n");
    assert.equal(readFileSync(join(stage, ".pa-template-registry.sha"), "utf8"), selection.registrySha256 + "\n");
  } finally { f.dispose(); rmSync(stage, { recursive: true, force: true }); }
});
