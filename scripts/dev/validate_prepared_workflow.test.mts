import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertInputPair, CHECKS, containedPath, copyInput, copyOrdinaryDependencies, fixedExpansion, inspectInput, INVENTORY_CALLS, parseArguments, PHASE5_DEBT, prepareScaffold, scaffoldLedger } from "./validate_prepared_workflow.mts";

/** Disposable ordinary repositories only: no worktree/lease/deployment/production authority. */
function fixture(action: (root: string, home: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pap256-runner-selftest-")); const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  try { action(root, home); } finally { rmSync(root, { recursive: true, force: true }); }
}
const SETUP_CALLS = [
  ["init", "-b", "fixture"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"],
  ["add", "--", "."], ["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"], ["rev-parse", "HEAD"],
] as const;
function git(root: string, home: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env["PATH"], HOME: home, LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" } }).trim();
}
function repository(root: string, home: string, files: Readonly<Record<string, string>>): string {
  mkdirSync(root, { mode: 0o700 });
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body, { mode: 0o600 });
  let sha = "";
  for (const args of SETUP_CALLS) sha = git(root, home, args);
  return sha;
}
function pair(root: string, home: string) {
  const configRoot = join(root, "config-source"); const configSha = repository(configRoot, home, { "config.md": "pinned fixture config\n" });
  const candidateRoot = join(root, "candidate-source");
  const candidateSha = repository(candidateRoot, home, { ".pa-platform-config.sha": `${configSha}\n`, "source.ts": "export const fixture = true;\n", "space\n雪.txt": "lossless pathname\n" });
  return { candidate: inspectInput(candidateRoot, candidateSha, home), config: inspectInput(configRoot, configSha, home) };
}

test("AC20 initial scaffold: exact fixed allowlist; no arbitrary argv, shell or root override", () => {
  assert.deepEqual(CHECKS, ["typecheck", "build", "runtime", "pi", "regression", "paired", "completions", "secrets", "packaging", "closure"]);
  for (const check of CHECKS) {
    assert.equal(parseArguments(["--check", check]), check);
    assert.ok(Object.isFrozen(fixedExpansion(check)));
    for (const argv of fixedExpansion(check)) assert.ok(Object.isFrozen(argv));
  }
  for (const args of [[], ["--check"], ["--check", "unknown"], ["--check", "build; true"], ["--check", "build", "--root", "/tmp"], ["--shell", "true"]]) assert.throws(() => parseArguments(args));
  assert.throws(() => fixedExpansion("../../escape"));
  assert.deepEqual(INVENTORY_CALLS, [["rev-parse", "--show-toplevel"], ["rev-parse", "HEAD"], ["status", "--porcelain=v2", "-z", "--untracked-files=all"], ["ls-files", "-z"]]);
  assert.deepEqual(SETUP_CALLS.map((argv) => argv[0]), ["init", "config", "config", "add", "-c", "rev-parse"]);
});

test("scaffold allowlist retains every exact expansion and mandatory bootstrap; no execution implied", () => {
  const stringify = (check: string) => fixedExpansion(check).map((argv) => argv.join(" "));
  assert.deepEqual(stringify("typecheck"), ["corepack pnpm typecheck"]);
  assert.deepEqual(stringify("build"), ["corepack pnpm build"]);
  assert.deepEqual(stringify("runtime"), ["corepack pnpm --filter @pa-platform/pa-core build", "corepack pnpm exec tsx --test packages/pa-core/src/__tests__/prepared-workflow.test.ts packages/pa-core/src/__tests__/execution-custody.test.ts packages/pa-core/src/__tests__/phase-report.test.ts"]);
  assert.deepEqual(stringify("pi"), ["corepack pnpm --filter @pa-platform/pa-core build", "corepack pnpm exec tsx --test --test-concurrency=1 packages/pi-pa/src/__tests__/pi-prepared-workflow.test.ts packages/pi-pa/src/__tests__/pi-execution-custody.test.ts packages/pi-pa/src/__tests__/pi-phase-report.test.ts"]);
  assert.deepEqual(stringify("regression"), ["corepack pnpm test"]);
  assert.deepEqual(stringify("paired"), ["corepack pnpm --filter @pa-platform/pa-core build", "corepack pnpm verify:paired-config -- --require-origin-develop", "corepack pnpm test:paired-gate", "corepack pnpm test:paired"]);
  assert.deepEqual(stringify("completions"), ["corepack pnpm completions"]);
  assert.deepEqual(stringify("secrets"), ["corepack pnpm secrets:scan"]);
  assert.deepEqual(stringify("packaging"), ["corepack pnpm --filter @pa-platform/pa-core build", "node packages/pi-pa/scripts/validate-extension-sources.mjs", ...stringify("pi").slice(1)]);
  assert.deepEqual(stringify("closure"), ["corepack pnpm exec tsx --test scripts/dev/validate_prepared_workflow.test.mts"]);
});

test("all ten expansions fail closed: unknown inputs/coverage, no executed command, no stub success", () => {
  assert.equal(PHASE5_DEBT.length, 10);
  for (const check of CHECKS) {
    const ledger = scaffoldLedger(check);
    assert.equal(ledger.status, "blocked"); assert.equal(ledger.stage, "phase-1-scaffold");
    assert.equal(ledger.candidate, null); assert.equal(ledger.config, null);
    assert.equal(ledger.exit, null); assert.equal(ledger.stdoutRef, null); assert.equal(ledger.stderrRef, null);
    assert.equal(ledger.automatedCoverage, "unknown"); assert.deepEqual(ledger.executedCommands, []);
    assert.equal(ledger.debt.length, 10); assert.equal("passed" in ledger, false);
    assert.equal("skipped" in ledger, false);
  }
});

test("AC20 initial: candidate/config full HEAD and digests bind ordinary isolated copies; source .git never copied", () => fixture((root, home) => {
  const { candidate, config } = pair(root, home);
  const snapshot = prepareScaffold(candidate, config, root);
  assert.deepEqual(snapshot.sourceDigests, [candidate.sha256, config.sha256]);
  assert.equal(existsSync(join(snapshot.root, "candidate", ".git")), false);
  assert.equal(existsSync(join(snapshot.root, "config", ".git")), false);
  for (const name of ["home", "cache", "pa-state", "outputs"]) assert.equal(lstatSync(join(snapshot.root, name)).mode & 0o777, 0o700);
  for (const input of [candidate, config]) {
    const copyRoot = join(snapshot.root, input === candidate ? "candidate" : "config");
    for (const file of input.files) {
      assert.deepEqual(readFileSync(join(copyRoot, file.path)), readFileSync(join(input.root, file.path)));
      assert.equal(lstatSync(join(copyRoot, file.path)).nlink, 1);
      assert.notEqual(lstatSync(join(copyRoot, file.path)).ino, lstatSync(join(input.root, file.path)).ino);
    }
    assert.equal(inspectInput(input.root, input.head, home).sha256, input.sha256);
  }
  writeFileSync(join(snapshot.root, "candidate", "source.ts"), "isolated mutation\n");
  assert.match(readFileSync(join(candidate.root, "source.ts"), "utf8"), /fixture = true/);
  const ledger = scaffoldLedger("closure", candidate, config);
  assert.deepEqual(ledger.candidate, { head: candidate.head, sha256: candidate.sha256 });
  assert.deepEqual(ledger.config, { head: config.head, sha256: config.sha256 });
  assert.equal(ledger.status, "blocked"); // known identity is NOT complete acceptance
  assert.doesNotMatch(JSON.stringify(ledger), /\/home\/|protectedToken|bootId|startTimeTicks/);
}));

test("candidate/config identity, clean complete inventory, changed bytes and exact config pin fail closed", () => fixture((root, home) => {
  const { candidate, config } = pair(root, home);
  assert.throws(() => inspectInput(candidate.root, "0".repeat(40), home), /identity mismatch/);
  assert.throws(() => inspectInput(candidate.root, "short", home), /full.*SHA/);
  assert.throws(() => assertInputPair(candidate, candidate), /overlap/);
  writeFileSync(join(candidate.root, "untracked\nfile"), "untracked\n");
  assert.throws(() => inspectInput(candidate.root, candidate.head, home), /clean/); rmSync(join(candidate.root, "untracked\nfile"));
  writeFileSync(join(candidate.root, "source.ts"), "changed\n");
  assert.throws(() => copyInput(candidate, join(root, "copy")), /source bytes/);
  assert.equal(existsSync(join(root, "copy")), false);
  assert.throws(() => inspectInput(candidate.root, candidate.head, home), /clean/);
  writeFileSync(join(candidate.root, "source.ts"), "export const fixture = true;\n");
  writeFileSync(join(candidate.root, ".pa-platform-config.sha"), `${"0".repeat(40)}\n`);
  assert.throws(() => assertInputPair(candidate, config), /source bytes/);
}));

test("input copy rejects source escapes, symlink/hard-link aliases, forged manifest and preexisting destinations", () => fixture((root, home) => {
  const { candidate } = pair(root, home);
  for (const path of ["../escape", "/tmp/escape", ".git/config", "nested/../../escape", "source.ts/../source.ts", "bad\\path", "bad\0path"]) assert.throws(() => containedPath(candidate.root, path));
  assert.throws(() => copyInput(candidate, candidate.root), /overlap/);
  assert.throws(() => copyInput(candidate, join(candidate.root, "copy")), /overlap/);
  assert.throws(() => copyInput({ ...candidate, sha256: "f".repeat(64) }, join(root, "forged")), /forged/);
  const existing = join(root, "existing"); mkdirSync(existing); assert.throws(() => copyInput(candidate, existing));
  symlinkSync(candidate.root, join(root, "alias"));
  assert.throws(() => inspectInput(join(root, "alias"), candidate.head, home), /physical/);
  symlinkSync(join(candidate.root, "source.ts"), join(candidate.root, "symbolic"));
  assert.throws(() => containedPath(candidate.root, "symbolic/child")); rmSync(join(candidate.root, "symbolic"));
  const original = readFileSync(join(candidate.root, "source.ts"));
  rmSync(join(candidate.root, "source.ts")); symlinkSync(join(root, "outside"), join(candidate.root, "source.ts"));
  assert.throws(() => copyInput(candidate, join(root, "symbolic-copy")), /ordinary/); rmSync(join(candidate.root, "source.ts"));
  writeFileSync(join(candidate.root, "source.ts"), original, { mode: 0o600 });
  linkSync(join(candidate.root, "source.ts"), join(root, "hard-alias"));
  assert.throws(() => copyInput(candidate, join(root, "hard-copy")), /ordinary/);
}));

test("ordinary dependency copy is independent; real pnpm/external aliases and missing dependencies remain explicit Phase 5 debt", () => fixture((root) => {
  const dependencies = join(root, "dependencies"); mkdirSync(dependencies);
  writeFileSync(join(dependencies, "runtime.js"), "// synthetic dependency\n");
  const output = join(root, "dependency-copy"); const digest = copyOrdinaryDependencies(dependencies, output);
  assert.match(digest, /^[0-9a-f]{64}$/);
  writeFileSync(join(output, "runtime.js"), "// isolated output\n");
  assert.equal(readFileSync(join(dependencies, "runtime.js"), "utf8"), "// synthetic dependency\n");
  assert.notEqual(lstatSync(join(output, "runtime.js")).ino, lstatSync(join(dependencies, "runtime.js")).ino);
  symlinkSync(join(dependencies, "runtime.js"), join(dependencies, "pnpm-alias.js"));
  assert.throws(() => copyOrdinaryDependencies(dependencies, join(root, "alias-copy")), /alias unsupported/);
  rmSync(join(dependencies, "pnpm-alias.js"));
  linkSync(join(dependencies, "runtime.js"), join(root, "hard-dependency"));
  assert.throws(() => copyOrdinaryDependencies(dependencies, join(root, "hard-copy")), /single-link/);
  const empty = join(root, "empty"); mkdirSync(empty);
  assert.throws(() => copyOrdinaryDependencies(empty, join(root, "empty-copy")), /missing/);
  assert.throws(() => copyOrdinaryDependencies(dependencies, join(dependencies, "nested")), /overlap/);
}));

test("executable-mode drift invalidates input digest; missing config input never counts passed", () => fixture((root, home) => {
  const { candidate, config } = pair(root, home);
  chmodSync(join(candidate.root, "source.ts"), 0o700);
  assert.throws(() => copyInput(candidate, join(root, "mode-copy")), /mode changed/);
  assert.equal(scaffoldLedger("paired", candidate, null).status, "blocked");
  chmodSync(join(candidate.root, "source.ts"), 0o600);
  rmSync(config.root, { recursive: true });
  assert.throws(() => prepareScaffold(candidate, config, root));
  assert.ok(readdirSync(root).includes("candidate-source"));
}));
