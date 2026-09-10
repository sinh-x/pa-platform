import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundleExtensionSources } from "./bundle-extension-sources.mjs";
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
    [{ "pi-vimmode": true, "proper-base": true }, ["pi-vimmode", "proper-base"]],
  ];
  for (const [selection, expectedSources] of matrix) {
    assert.deepEqual(normalizePluginSelection(lock, selection), selection);
    assert.deepEqual(selectedExtensionSources(lock, selection).map(({ name }) => name), expectedSources);
  }
  assert.throws(() => normalizePluginSelection(lock, { "pi-vimmode": "yes" }), /pi-vimmode must be a boolean/);
  assert.throws(() => normalizePluginSelection(lock, { arbitrary: true }), /unknown reviewed plugin arbitrary/);
});

test("bundle pipeline emits only selected artifacts, imports, notices, and immutable provenance for 4/4 selections", async () => {
  const packageJson = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"));
  const lock = readSourceLock();
  const bundler = readFileSync(resolve(PACKAGE_ROOT, "scripts/bundle-extension-sources.mjs"), "utf8");
  assert.equal(lock.sources.length, 2);
  assert.deepEqual(lock.sources.map(({ name, version, license }) => ({ name, version, license })), [
    { name: "proper-base", version: "0.5.0", license: "MIT" },
    { name: "pi-vimmode", version: "0.9.0", license: "MIT" },
  ]);
  assert.deepEqual(selectedExtensionSources(lock, { "pi-vimmode": true, "proper-base": true }).map(({ name }) => name), ["pi-vimmode", "proper-base"]);
  assert.equal(packageJson.dependencies.sharp, "0.35.3");
  assert.equal(packageJson.devDependencies.esbuild, "0.27.7");
  assert.equal(packageJson.imports, undefined, "installed import mappings must be generated only for selected sources");
  for (const dependency of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "sharp", "typebox"]) {
    assert.match(bundler, new RegExp(`\\"${dependency.replaceAll("/", "\\/")}\\"`));
  }
  assert.doesNotMatch(bundler, /Date\(|generatedAt|timestamp/);

  const selectionMatrix = [
    [{ "pi-vimmode": false, "proper-base": false }, []],
    [{ "pi-vimmode": true, "proper-base": false }, ["pi-vimmode"]],
    [{ "pi-vimmode": false, "proper-base": true }, ["proper-base"]],
    [{ "pi-vimmode": true, "proper-base": true }, ["pi-vimmode", "proper-base"]],
  ];
  for (const [selection, expectedNames] of selectionMatrix) {
    const outputRoot = mkdtempSync(join(tmpdir(), "pi-pa-bundle-selection-"));
    const generatedSourcePath = resolve(outputRoot, "source/bundled-editor-factories.ts");
    try {
      await bundleExtensionSources({
        outputRoot,
        generatedSourcePath,
        environment: { PI_PA_PLUGIN_SELECTION: JSON.stringify(selection) },
      });
      const provenance = JSON.parse(readFileSync(resolve(outputRoot, "pi-extension/vendor/provenance.json"), "utf8"));
      const generatedFactories = readFileSync(resolve(outputRoot, "pi-extension/bundled-editor-factories.js"), "utf8");
      const generatedSourceFactories = readFileSync(generatedSourcePath, "utf8");
      const generatedPackage = JSON.parse(readFileSync(resolve(outputRoot, "pi-pa-package.json"), "utf8"));
      const generatedNotice = readFileSync(resolve(outputRoot, "THIRD_PARTY_NOTICES.md"), "utf8");

      assert.deepEqual(provenance.selectedSources, expectedNames);
      assert.deepEqual(provenance.sources.map(({ name }) => name), expectedNames);
      assert.deepEqual(generatedPackage.imports, Object.fromEntries(expectedNames.map((name) => {
        const source = lock.sources.find((candidate) => candidate.name === name);
        return [source.import, source.importTarget];
      })));
      for (const source of lock.sources) {
        const enabled = expectedNames.includes(source.name);
        assert.equal(existsSync(resolve(outputRoot, "pi-extension/vendor", source.bundle)), enabled);
        assert.equal(existsSync(resolve(outputRoot, "pi-extension/vendor", `${source.bundle}.map`)), enabled);
        assert.equal(existsSync(resolve(outputRoot, "pi-extension/vendor/licenses", `${source.name}-LICENSE.txt`)), enabled);
        assert.equal(generatedFactories.includes(source.import), enabled);
        assert.equal(generatedSourceFactories.includes(`./vendor/${source.bundle}`), enabled);
        assert.equal(existsSync(resolve(outputRoot, "source/vendor", source.bundle)), enabled);
        assert.equal(existsSync(resolve(outputRoot, "source/vendor", `${source.bundle}.map`)), enabled);
        assert.equal(existsSync(resolve(outputRoot, "source/vendor", source.bundle.replace(/\.js$/, ".d.ts"))), enabled);
        assert.equal(generatedNotice.includes(`## ${source.name} ${source.version}`), enabled);
        assert.equal(provenance.sources.some(({ name }) => name === source.name), enabled);
        if (enabled) {
          const record = provenance.sources.find(({ name }) => name === source.name);
          assert.deepEqual(
            [record.commit, record.contentSha256, record.license, record.licenseSha256],
            [source.commit, source.contentSha256, source.license, source.licenseSha256],
          );
          assert.equal(readFileSync(resolve(outputRoot, "pi-extension/vendor/licenses", `${source.name}-LICENSE.txt`), "utf8"), readFileSync(resolve(PACKAGE_ROOT, source.licensePath), "utf8"));
        }
      }
      if (expectedNames.length === 2) {
        assert.ok(generatedFactories.indexOf("#pi-pa-vimmode") < generatedFactories.indexOf("#pi-pa-proper-base"));
        assert.match(readFileSync(resolve(outputRoot, "pi-extension/vendor/proper-base.js"), "utf8"), /from "sharp"/);
      }
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }
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
  assert.match(nixSmoke, /supported_systems=\(x86_64-linux aarch64-linux\)/);
  assert.match(nixSmoke, /nix build --impure --expr "\$expr" --dry-run --no-link/);
  assert.match(nixSmoke, /#pi-pa-vimmode/);
  assert.match(nixSmoke, /sharp\.versions\.sharp/);
  assert.match(flake, /supportedSystems = \[ "x86_64-linux" "aarch64-linux" \]/);
  assert.match(flake, /THIRD_PARTY_NOTICES\.md/);
  assert.match(workspace, /onlyBuiltDependencies:[\s\S]*- sharp/);
  assert.match(lockfile, /'@img\/sharp-linux-x64@0\.35\.3'/);
  assert.match(lockfile, /'@img\/sharp-linux-arm64@0\.35\.3'/);
});
