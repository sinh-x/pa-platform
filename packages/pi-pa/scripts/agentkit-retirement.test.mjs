import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Maintenance regression only, NOT a runtime blacklist or a host inventory.
// Keep historical docs, fixtures and vendored originals outside this boundary.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const RETIRED = /agent[-_]?kit|privacy-block\.cjs|security-sentinel\.cjs/i;
const EXCLUDED_PARTS = new Set(["__tests__", "fixtures", "vendor", "node_modules", "dist"]);
const TEXT = /\.(?:[cm]?[jt]s|json|ya?ml|nix|sh|fish|c|h|py)$/;
const ROOT_INPUTS = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "flake.nix", "flake.lock", ".gitmodules"]);

function maintainedInput(path) {
  const parts = path.split("/");
  if (parts.some(part => EXCLUDED_PARTS.has(part)) || /\.(?:test|spec)\.[cm]?[jt]s$/.test(path)) return false;
  if (ROOT_INPUTS.has(path)) return true;
  if (path === ".pi/settings.json" || path.startsWith(".pi/extensions/")) return TEXT.test(path);
  if (path.startsWith(".github/workflows/") || path.startsWith("scripts/")) return TEXT.test(path);
  if (parts[0] !== "packages") return false;
  if (parts.length === 3) return /(?:package\.json|extension-sources\.lock\.json)$/.test(parts[2]);
  return ["src", "scripts", "runtime"].includes(parts[2]) && TEXT.test(path);
}

function retiredInputs(files) {
  return Object.entries(files)
    .filter(([path, text]) => maintainedInput(path) && (RETIRED.test(path) || RETIRED.test(text)))
    .map(([path]) => path).sort();
}

function collectInputs(root) {
  const files = {};
  function visit(path) {
    const absolute = resolve(root, path);
    const info = lstatSync(absolute);
    // Do not follow an input into an ambient profile or external dependency.
    assert.equal(info.isSymbolicLink(), false, `Maintain an explicit source inventory for linked input: ${path}`);
    if (info.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) {
        if (!EXCLUDED_PARTS.has(entry)) visit(`${path}/${entry}`);
      }
    } else if (maintainedInput(path)) {
      assert.equal(info.isFile(), true, `Unsupported maintained input: ${path}`);
      files[path] = readFileSync(absolute, "utf8");
    }
  }
  for (const path of ROOT_INPUTS) {
    if (existsSync(resolve(root, path))) visit(path);
  }
  // Required roots cannot silently disappear and turn this check green.
  for (const path of ["scripts", "packages", ".github/workflows"]) visit(path);
  for (const path of [".pi/settings.json", ".pi/extensions"]) {
    if (existsSync(resolve(root, path))) visit(path);
  }
  return files;
}

test("PAP-351 maintained runtime, dependency and selection inputs have no retired AgentKit references", () => {
  const files = collectInputs(ROOT);
  for (const required of ["packages/pi-pa/src/adapter.ts", "packages/pi-pa/package.json", "packages/pi-pa/extension-sources.lock.json", "packages/pa-core/src/security-policy.ts", "flake.nix", "pnpm-lock.yaml"]) {
    assert.ok(Object.hasOwn(files, required), `Missing regression coverage: ${required}`);
  }
  assert.deepEqual(retiredInputs(files), [], "Retired hook reference in maintained inputs; correct its owning producer, not extension discovery or PA policy");
});

test("PAP-351 seeded recurrence is caught on every claimed maintained selection surface", () => {
  const seeds = {
    ".pi/extensions/agentkit-hooks-engineer/index.ts": "export default () => {};",
    ".pi/extensions/renamed/index.ts": 'import bridge from "agentkit-hooks-engineer";',
    ".pi/settings.json": JSON.stringify({ packages: ["npm:agentkit"], extensions: ["/profile/agentkit-hooks-engineer"] }),
    "package.json": JSON.stringify({ dependencies: { "agentkit-agent": "1.0.0" } }),
    "pnpm-lock.yaml": "packages:\n  agentkit-hooks-engineer: {}",
    "flake.nix": 'extension = "agentkit-hooks-engineer";',
    ".github/workflows/ci.yml": "run: install-agentkit",
    "scripts/install-hooks.sh": "cp agentkit-hooks-engineer ~/.pi/agent/extensions/",
    "packages/pi-pa/package.json": JSON.stringify({ pi: { extensions: ["agentkit-hooks-engineer"] } }),
    "packages/pi-pa/extension-sources.lock.json": JSON.stringify({ sources: [{ name: "agentkit-hooks-engineer" }] }),
    "packages/pi-pa/src/adapter.ts": 'args.push("--extension", "agentkit-hooks-engineer");',
    "packages/pi-pa/runtime/child.mjs": 'spawn("node", ["privacy-block.cjs"]);',
    "packages/pa-core/src/evaluator.ts": 'readFileSync("/profile/.agentkit/runtime.json");',
    "packages/pi-pa/scripts/bundle-extension-sources.mjs": 'copyFileSync("security-sentinel.cjs", output);',
  };
  for (const [path, text] of Object.entries(seeds)) {
    assert.deepEqual(retiredInputs({ [path]: text }), [path], path);
  }
});

test("PAP-351 history, fixtures and archived vendor originals do not become active dependencies", () => {
  const inert = Object.fromEntries([
    "docs/PAP-351-agentkit-retirement.md",
    "plans/historical-incident.md",
    "packages/pi-pa/vendor/archived-original/index.ts",
    "packages/pi-pa/src/__tests__/fixtures/old-hooks.json",
    "packages/pi-pa/src/__tests__/retirement.test.ts",
    "packages/pi-pa/scripts/agentkit-retirement.test.mjs",
  ].map(path => [path, "agentkit-hooks-engineer privacy-block.cjs security-sentinel.cjs"]));
  assert.deepEqual(retiredInputs(inert), []);
});

test("PAP-351 actual input discovery detects a newly added selector without following external links", () => {
  const root = mkdtempSync(resolve(tmpdir(), "pap351-inputs-"));
  const put = (path, text) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), text);
  };
  try {
    for (const path of ["scripts", "packages", ".github/workflows"]) mkdirSync(resolve(root, path), { recursive: true });
    put(".pi/extensions/ordinary/index.ts", "export default () => {};");
    put("packages/pi-pa/vendor/archive/index.ts", "agentkit-hooks-engineer");
    assert.deepEqual(retiredInputs(collectInputs(root)), []);
    const selector = ".pi/extensions/agentkit-hooks-engineer/index.ts";
    put(selector, "export default () => {};");
    assert.deepEqual(retiredInputs(collectInputs(root)), [selector]);
    rmSync(resolve(root, selector));
    symlinkSync(resolve(root, ".pi/extensions/ordinary/index.ts"), resolve(root, selector));
    assert.throws(() => collectInputs(root), /explicit source inventory for linked input/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PAP-351 unrelated extension and skill declarations remain admissible", () => {
  assert.deepEqual(retiredInputs({
    ".pi/settings.json": JSON.stringify({ packages: ["npm:pi-web-access"], extensions: ["./herdr-agent-state.ts"], skills: ["./skills/ordinary"] }),
    "packages/pi-pa/extension-sources.lock.json": JSON.stringify({ sources: [{ name: "proper-base" }, { name: "pi-vimmode" }] }),
    "packages/pi-pa/src/adapter.ts": 'args.push("--extension", plan.trustedExtension);',
  }), []);
});
