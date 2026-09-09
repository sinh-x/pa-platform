import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_ROOT,
  normalizePluginSelection,
  readSourceLock,
  selectedExtensionSources,
  validateExtensionSources,
} from "./extension-sources.mjs";

const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "pi-pa-sources-"));
  cpSync(resolve(PACKAGE_ROOT, "extension-sources.lock.json"), resolve(root, "extension-sources.lock.json"));
  return root;
}

function createEntrypoint(root, path, content) {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

test("exact extension source validator accepts the approved initialized gitlinks", () => {
  const lock = validateExtensionSources();
  assert.deepEqual(lock.sources.map((source) => source.commit), [
    "859feb321ec81d773beea379d28e21d0b7d0c8c0",
    "52bd6ac5e905157ac46ec15c120b7d0cc61a62df",
  ]);
});

test("exact extension source validator rejects missing sources before runtime", () => {
  const root = fixtureRoot();
  try {
    assert.throws(() => validateExtensionSources({ packageRoot: root }), /Missing proper-base entrypoint.*submodule update --init --recursive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact extension source validator rejects content drift without changing the worktree", () => {
  const root = fixtureRoot();
  try {
    const lock = readSourceLock(root);
    for (const source of lock.sources) {
      cpSync(resolve(PACKAGE_ROOT, source.sourcePath), resolve(root, source.sourcePath), { recursive: true });
    }
    createEntrypoint(root, lock.sources[0].entrypoint, "export default function drifted() {}\n");
    assert.throws(() => validateExtensionSources({ packageRoot: root }), /proper-base content drifted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin selection normalizes all four boolean combinations from reviewed source metadata", () => {
  const lock = readSourceLock();
  const matrix = [
    [{ "pi-vimmode": false, "proper-base": false }, []],
    [{ "pi-vimmode": true, "proper-base": false }, ["pi-vimmode"]],
    [{ "pi-vimmode": false, "proper-base": true }, ["proper-base"]],
    [{ "pi-vimmode": true, "proper-base": true }, ["proper-base", "pi-vimmode"]],
  ];
  for (const [selection, expectedSources] of matrix) {
    assert.deepEqual(normalizePluginSelection(lock, selection), selection);
    assert.deepEqual(selectedExtensionSources(lock, selection).map(({ name }) => name), expectedSources);
  }
  assert.throws(() => normalizePluginSelection(lock, { "pi-vimmode": "yes" }), /pi-vimmode must be a boolean/);
  assert.throws(() => normalizePluginSelection(lock, { arbitrary: true }), /unknown reviewed plugin arbitrary/);
});

test("bundle pipeline records the deterministic selection with eligible source provenance", () => {
  const packageJson = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"));
  const lock = readSourceLock();
  const bundlerPath = resolve(PACKAGE_ROOT, "scripts/bundle-extension-sources.mjs");
  const bundler = readFileSync(bundlerPath, "utf8");
  assert.equal(lock.sources.length, 2);
  assert.deepEqual(lock.sources.map(({ name, version, license }) => ({ name, version, license })), [
    { name: "proper-base", version: "0.5.0", license: "MIT" },
    { name: "pi-vimmode", version: "0.9.0", license: "MIT" },
  ]);
  assert.deepEqual(lock.sources.map((source) => source.entrypoint), [
    "vendor/proper-pi-extensions/proper-base/index.ts",
    "vendor/pi-vimmode/index.ts",
  ]);
  assert.equal(packageJson.dependencies.sharp, "0.35.3");
  assert.equal(packageJson.devDependencies.esbuild, "0.27.7");
  for (const dependency of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "sharp", "typebox"]) {
    assert.match(bundler, new RegExp(`\\"${dependency.replaceAll("/", "\\/")}\\"`));
  }
  assert.doesNotMatch(bundler, /Date\(|generatedAt|timestamp/);

  const outputRoot = resolve(PACKAGE_ROOT, "dist/pi-extension/vendor");
  const selectionMatrix = [
    [{ "pi-vimmode": false, "proper-base": false }, []],
    [{ "pi-vimmode": true, "proper-base": false }, ["pi-vimmode"]],
    [{ "pi-vimmode": false, "proper-base": true }, ["proper-base"]],
    [{ "pi-vimmode": true, "proper-base": true }, ["proper-base", "pi-vimmode"]],
  ];
  let provenance;
  for (const [selection, expectedSources] of selectionMatrix) {
    execFileSync(process.execPath, [bundlerPath], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, PI_PA_PLUGIN_SELECTION: JSON.stringify(selection) },
      stdio: "pipe",
    });
    provenance = JSON.parse(readFileSync(resolve(outputRoot, "provenance.json"), "utf8"));
    assert.deepEqual(provenance.pluginSelection, selection);
    assert.deepEqual(provenance.selectedSources, expectedSources);
  }
  assert.deepEqual(provenance.sources.map((source) => source.commit), lock.sources.map((source) => source.commit));
  assert.deepEqual(provenance.sources.map(({ version, license, licenseSha256 }) => ({ version, license, licenseSha256 })), lock.sources.map(({ version, license, licenseSha256 }) => ({ version, license, licenseSha256 })));
  assert.equal(provenance.sources.length, 2);
  for (const source of lock.sources) {
    assert.equal(provenance.sources.find((item) => item.name === source.name)?.packagedLicense, `licenses/${source.name}-LICENSE.txt`);
    assert.equal(readFileSync(resolve(outputRoot, "licenses", `${source.name}-LICENSE.txt`), "utf8"), readFileSync(resolve(PACKAGE_ROOT, source.licensePath), "utf8"));
  }
  assert.match(readFileSync(resolve(outputRoot, "proper-base.js"), "utf8"), /from "sharp"/);
  assert.match(readFileSync(resolve(outputRoot, "proper-base.js"), "utf8"), /from "@earendil-works\/pi-/);
  assert.match(readFileSync(resolve(outputRoot, "pi-vimmode.js"), "utf8"), /from "@earendil-works\/pi-/);
});

test("CI and Nix inputs require recursive exact sources and both Linux sharp artifacts", () => {
  const ci = readFileSync(resolve(REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8");
  const nixWorkflow = readFileSync(resolve(REPOSITORY_ROOT, ".github/workflows/nix-build.yml"), "utf8");
  const nixSmoke = readFileSync(resolve(REPOSITORY_ROOT, "scripts/nix-store-output-smoke.sh"), "utf8");
  const flake = readFileSync(resolve(REPOSITORY_ROOT, "flake.nix"), "utf8");
  const workspace = readFileSync(resolve(REPOSITORY_ROOT, "pnpm-workspace.yaml"), "utf8");
  const lockfile = readFileSync(resolve(REPOSITORY_ROOT, "pnpm-lock.yaml"), "utf8");
  for (const workflow of [ci, nixWorkflow]) {
    assert.match(workflow, /submodules: recursive/);
    assert.match(workflow, /validate-extension-sources\.mjs/);
  }
  assert.match(nixWorkflow, /\.\?submodules=1#pa-platform/);
  assert.match(nixSmoke, /flake_ref='\.\?submodules=1'/);
  assert.match(nixSmoke, /nix build "\$flake_ref#ppa"/);
  assert.match(nixSmoke, /packages\.aarch64-linux\.ppa/);
  assert.match(nixSmoke, /#pi-pa-vimmode/);
  assert.match(nixSmoke, /sharp\.versions\.sharp/);
  assert.match(flake, /supportedSystems = \[ "x86_64-linux" "aarch64-linux" \]/);
  assert.match(flake, /THIRD_PARTY_NOTICES\.md/);
  assert.match(workspace, /onlyBuiltDependencies:[\s\S]*- sharp/);
  assert.match(lockfile, /'@img\/sharp-linux-x64@0\.35\.3'/);
  assert.match(lockfile, /'@img\/sharp-linux-arm64@0\.35\.3'/);
});
