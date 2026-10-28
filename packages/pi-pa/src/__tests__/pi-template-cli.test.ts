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
    f.registry.configRevision = "selected"; const unpinned = f.save(); mkdirSync(join(f.root, "teams"));
    const env = { PATH: process.env.PATH, HOME: join(stage, "home"), LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => execFileSync("git", ["-C", f.root, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q", "-b", "develop"); git("config", "user.name", "Synthetic template fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", "/dev/null");
    git("add", "contracts", "skills"); git("commit", "-qm", "synthetic config resources");
    const selection = { ...unpinned, configRevision: git("rev-parse", "HEAD") };
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
    const cases: Array<{ argv: string[]; body?: string; exitCode: number; repeats: number; expected: unknown }> = [];
    const add = (request: Record<string, unknown>, repeats = 1) => {
      const action = request.action as string, body = action === "render" ? { bindings: request.bindings } : action === "validate" ? { bindings: request.bindings, candidate: request.candidate } : undefined;
      const expected = templateService(request, { selection });
      cases.push({ argv: ["template", action, ...(action === "list" ? [] : [request.id as string, "--version", request.version as string]), "--format", "json"], ...(body ? { body: JSON.stringify(body) } : {}), expected, exitCode: expected.ok ? 0 : 1, repeats });
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
  } finally { f.dispose(); rmSync(stage, { recursive: true, force: true }); }
});
