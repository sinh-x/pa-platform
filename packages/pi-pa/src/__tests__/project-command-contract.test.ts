import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workflowDigest } from "@pa-platform/pa-core";
import { ProjectCommandContract } from "../project-command-contract.js";

function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap268-commands-")), env = process.env; process.env = { ...env };
  try { run(setup(root)); } finally { process.env = env; rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
  const repo = join(root, "canonical"), checkout = join(root, "checkout"), config = join(root, "config");
  mkdirSync(repo); mkdirSync(checkout); mkdirSync(config); process.env.PA_PLATFORM_CONFIG = config;
  const script = "console.log('fixture command')\n"; writeFileSync(join(checkout, "test.cjs"), script);
  const manifest = { schemaVersion: "project-command-contract/v1", effects: ["project-read", "isolated-temp-write"], checks: [
    { id: "test", executable: realpathSync(process.execPath), argv: ["test.cjs"], environment: { PROJECT_MODE: "test" }, readPaths: [] as string[], prerequisites: [{ path: "test.cjs", sha256: workflowDigest(script) }], timeoutSeconds: 10, maximumOutputBytes: 1024 },
  ] };
  const save = () => { const bytes = JSON.stringify(manifest); writeFileSync(join(checkout, "checks.json"), bytes);
    writeFileSync(join(config, "config.yaml"), `repos:\n  fixture:\n    path: ${repo}\n    projectCommands:\n      manifest: checks.json\n      sha256: ${workflowDigest(bytes)}\n`); };
  save();
  const resolve = () => ProjectCommandContract.resolve("fixture", repo, checkout)!;
  return { root, repo, checkout, config, manifest, save, resolve };
}

test("PAP-268 versioned project contract resolves exact argv/environment and mandatory isolated effects", () => fixture((f) => {
  const contract = f.resolve(); const check = contract.check("test")!;
  assert.equal(check.command, "node 'test.cjs'"); assert.equal(contract.check("test; true"), undefined);
  const program = contract.program(check); assert.ok(program.argv.includes("--unshare-all")); assert.ok(program.argv.includes("--clearenv"));
  assert.equal(program.environment.PROJECT_MODE, "test"); assert.equal(program.environment.HOME, "/tmp/pa-check-home");
  assert.deepEqual(program.argv.slice(-3), ["--", realpathSync(process.execPath), "test.cjs"]);
  writeFileSync(join(f.checkout, "test.cjs"), "changed script\n"); assert.throws(() => contract.program(check), /EXECUTION_PROJECT_CONTRACT_INVALID/);
}));

for (const variant of ["environment", "effect", "missing-field", "extra-field", "bad-digest", "malformed-json", "path", "duplicate", "timeout", "output", "script-alias", "script-hardlink", "script-permissions", "sensitive-read", "read-escape", "manifest-drift", "canonical-root", "unavailable-containment"] as const) {
  test(`PAP-268 project command ${variant} is rejected before project dispatch`, () => fixture((f) => {
    if (variant === "environment") Object.assign(f.manifest.checks[0]!.environment, { NODE_OPTIONS: "--require /outside" });
    if (variant === "effect") f.manifest.effects.push("external-account");
    if (variant === "missing-field") delete (f.manifest.checks[0] as { readPaths?: string[] }).readPaths;
    if (variant === "extra-field") Object.assign(f.manifest, { extraAuthority: true });
    if (variant === "bad-digest") f.manifest.checks[0]!.prerequisites[0]!.sha256 = "A".repeat(64);
    if (variant === "path") f.manifest.checks[0]!.prerequisites[0]!.path = "../outside";
    if (variant === "sensitive-read") f.manifest.checks[0]!.readPaths = [".env"];
    if (variant === "read-escape") f.manifest.checks[0]!.readPaths = ["../outside"];
    if (variant === "duplicate") f.manifest.checks.push({ ...f.manifest.checks[0]! });
    if (variant === "timeout") f.manifest.checks[0]!.timeoutSeconds = 1801;
    if (variant === "output") f.manifest.checks[0]!.maximumOutputBytes = 0;
    if (variant === "script-alias") { rmSync(join(f.checkout, "test.cjs")); writeFileSync(join(f.root, "outside.cjs"), "outside"); symlinkSync(join(f.root, "outside.cjs"), join(f.checkout, "test.cjs")); }
    if (variant === "script-hardlink") linkSync(join(f.checkout, "test.cjs"), join(f.root, "linked.cjs"));
    if (variant === "script-permissions") chmodSync(join(f.checkout, "test.cjs"), 0o666);
    f.save();
    if (variant === "manifest-drift") writeFileSync(join(f.checkout, "checks.json"), "{}");
    if (variant === "malformed-json") {
      writeFileSync(join(f.checkout, "checks.json"), "{");
      const config = join(f.config, "config.yaml");
      writeFileSync(config, readFileSync(config, "utf8").replace(/sha256: [0-9a-f]{64}/, `sha256: ${workflowDigest("{")}`));
    }
    if (variant === "unavailable-containment") process.env.PATH = f.root;
    const action = variant === "canonical-root" ? () => ProjectCommandContract.resolve("fixture", f.repo, f.repo) : f.resolve;
    assert.throws(action, /EXECUTION_PROJECT_(?:CONTRACT_INVALID|PREREQUISITE)/);
  }));
}

test("PAP-268 changed registration cannot upgrade or retarget a running command contract", () => fixture((f) => {
  const contract = f.resolve(); f.manifest.checks[0]!.environment.PROJECT_MODE = "different"; f.save();
  assert.throws(() => contract.program(contract.checks[0]!), /EXECUTION_PROJECT_CONTRACT_INVALID/);
}));
