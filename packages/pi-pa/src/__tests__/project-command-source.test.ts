import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workflowDigest } from "@pa-platform/pa-core";
import { ProjectCommandContract } from "../project-command-contract.js";
import { piWorkflowObservations } from "../workflow-host.js";

function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap273-command-source-")), environment = process.env; process.env = { ...environment };
  try { run(setup(root)); } finally { process.env = environment; rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
  const repo = join(root, "registered"), checkout = join(root, "checkout"), config = join(root, "config");
  for (const path of [repo, checkout, config]) mkdirSync(path);
  process.env.PA_PLATFORM_CONFIG = config;
  const script = "console.log('fixture only')\n";
  const commands = ["unit", "lint"].map(id => ({ id, executable: "/nix/store/nonexistent-fixture/bin/node", argv: ["test.cjs", id], environment: {}, readPaths: [],
    prerequisites: [{ path: "test.cjs", sha256: workflowDigest(script) }], timeoutSeconds: 10, maximumOutputBytes: 1024 }));
  const manifest = JSON.stringify({ schemaVersion: "project-command-contract/v1", effects: ["project-read", "isolated-temp-write"], checks: commands });
  for (const path of [repo, checkout]) { writeFileSync(join(path, "checks.json"), manifest); writeFileSync(join(path, "test.cjs"), script); }
  const registration = (legacy: boolean) => writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: repo,
    ...(legacy ? { projectCommands: { manifest: "checks.json", sha256: workflowDigest(manifest) } } : {}) } } }));
  registration(false);
  const local = (path = repo) => {
    const parent = join(path, ".pa"); mkdirSync(parent, { mode: 0o700 });
    const file = join(parent, "project-commands.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: "project-command-catalogue/v1", repository: { key: "example", root: repo },
      effects: ["project-read", "isolated-temp-write"], commands }), { mode: 0o600 });
    return file;
  };
  const readers = () => [() => ProjectCommandContract.inspect("example", repo), () => ProjectCommandContract.inspectWorktree("example", repo, checkout),
    () => ProjectCommandContract.resolve("example", repo, checkout)];
  return { root, repo, checkout, registration, local, readers };
}

test("unapproved local catalogue never admits a profile or command, including with no available confinement executable", () => fixture(f => {
  f.local(); process.env.PATH = f.root;
  for (const read of f.readers()) assert.throws(read, /EXECUTION_PROJECT_APPROVAL_REQUIRED/);
  assert.equal(piWorkflowObservations(undefined, { key: "example", root: f.repo }).projectProfile, "unsupported");
}));

test("legacy/local conflict rejects before command or confinement admission rather than selecting legacy", () => fixture(f => {
  f.registration(true); f.local(); process.env.PATH = f.root;
  for (const read of f.readers()) assert.throws(read, /EXECUTION_PROJECT_SOURCE_CONFLICT/);
}));

for (const variant of ["invalid-local", "dangling-local", "unsafe-parent"] as const) test(`legacy cannot fall back through ${variant}`, () => fixture(f => {
  f.registration(true); const file = f.local();
  if (variant === "invalid-local") writeFileSync(file, '{"approved":true}');
  if (variant === "dangling-local") { rmSync(file); symlinkSync(join(f.root, "absent"), file); }
  if (variant === "unsafe-parent") { const actual = join(f.repo, ".pa"), target = join(f.root, "administrative");
    rmSync(actual, { recursive: true }); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, actual); }
  for (const read of f.readers()) assert.throws(read, /EXECUTION_PROJECT_CONTRACT_INVALID/);
}));

for (const legacy of [false, true]) test(`linked checkout administrative data cannot substitute for the registered source (legacy=${legacy})`, () => fixture(f => {
  f.registration(legacy); f.local(f.checkout);
  for (const read of f.readers().slice(1)) assert.throws(read, /EXECUTION_PROJECT_SOURCE_CONFLICT/);
}));
