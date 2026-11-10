import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { INTERACTION_CASES, INTERACTION_TEST_FILES, accountInteractionCases, interactionProvenance, parseInteractionArguments, publicInteractionError, qualifyInteractions, unchangedInteractionRuntime } from "./verify_interactions_runtime.mjs";

import { QualificationBlocked } from "./workflow_installed_support.mjs";

const sha = "a".repeat(40), harness = "/fixture/interactions-harness";
function events() {
  return [...INTERACTION_CASES.map(([, owner, name]) => ({ type: "test:pass", data: { name, file: join(harness, owner.replace(/\.ts$/, ".js")), details: { type: "test" } } })),
    { type: "test:summary", data: { success: true, counts: { passed: INTERACTION_CASES.length, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } }];
}
test("interaction verifier fixes every implemented-slice anchor to its exact test owner", () => {
  assert.equal(INTERACTION_CASES.length, 22);
  assert.equal(INTERACTION_TEST_FILES.length, 7);
  assert.equal(new Set(INTERACTION_CASES.map(([id]) => id)).size, INTERACTION_CASES.length);
  assert.equal(new Set(INTERACTION_CASES.map(([, , name]) => name)).size, INTERACTION_CASES.length);
  const result = accountInteractionCases(events(), harness);
  assert.equal(result.cases.length, INTERACTION_CASES.length);
  assert.ok(result.cases.every(row => row.status === "passed" && row.observations === 1));
});
test("no omitted, duplicate, foreign-owner, skipped, todo, failed or cancelled observation can pass", () => {
  for (let index = 0; index < INTERACTION_CASES.length; index++) {
    for (const mutate of [
      e => { e.splice(index, 1); }, e => { e.push(structuredClone(e[index])); },
      e => { e[index].data.file = "/foreign/file.js"; }, e => { e[index].data.name = "substituted-name"; },
      e => { e[index].data.skip = true; }, e => { e[index].data.todo = true; }, e => { e[index].type = "test:fail"; },
    ]) { const e = events(); mutate(e); assert.throws(() => accountInteractionCases(e, harness)); }
  }
  for (const mutate of [e => e.pop(), e => { e.at(-1).data.success = false; }, ...["failed", "cancelled", "skipped", "todo", "passed"].map(key => e => { e.at(-1).data.counts[key]++; })]) {
    const e = events(); mutate(e); assert.throws(() => accountInteractionCases(e, harness));
  }
  for (const root of [undefined, "relative", ""]) assert.throws(() => accountInteractionCases(events(), root));
  for (const value of [[], null, {}]) assert.throws(() => accountInteractionCases(value, harness));
});
test("only exact fixed observation modes are accepted, never imported results, paths or permissions", async () => {
  assert.deepEqual(parseInteractionArguments(["--selected-installed", "--require-candidate", sha]), { sourceSha: sha, comparison: false });
  assert.deepEqual(parseInteractionArguments(["--selected-installed", "--compare-worktree", sha]), { sourceSha: sha, comparison: true });
  for (const args of [[], ["--source"], ["--selected-installed", "--compare-worktree", "HEAD"], ["--selected-installed", "--compare-worktree", "unversioned-dirty-source"],
    ["--selected-installed", "--require-candidate", sha, "--allow-dirty"], ["--selected-installed", "--compare-worktree", sha, "--passed"],
    ["--selected-installed", "--binary", "/fixture/ppa"], ["--selected-installed", "--config-root", "/fixture"],
    ["--selected-installed", "--compare-worktree", sha, "--approve"], ["--selected-installed", "--compare-worktree", sha.toUpperCase()]]) {
    assert.throws(() => parseInteractionArguments(args)); await assert.rejects(() => qualifyInteractions(args));
  }
});
test("byte-comparison mode never upgrades dirty provenance or accepts a different commit or malformed metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "interactions-provenance-")), path = join(root, "review-runtime-provenance.json");
  const value = { schemaVersion: "pa-review-runtime/v1", sourceSha: sha, configSha: "b".repeat(40), packageName: "pa-platform", packageVersion: "0.1.158-pap282.1", objectiveSchema: "pa-review-objective/v1", matrixSchema: "pa-review-matrix/v1" };
  try {
    writeFileSync(path, JSON.stringify(value));
    for (const comparison of [false, true]) assert.equal(interactionProvenance({ share: root }, sha, comparison).exactCandidateProvenance, true);
    writeFileSync(path, JSON.stringify({ ...value, sourceSha: "unversioned-dirty-source" }));
    assert.throws(() => interactionProvenance({ share: root }, sha, false));
    const observed = interactionProvenance({ share: root }, sha, true);
    assert.equal(observed.exactCandidateProvenance, false); assert.equal(observed.metadata.sourceSha, "unversioned-dirty-source");
    for (const raw of [JSON.stringify({ ...value, sourceSha: "c".repeat(40) }), JSON.stringify(value).replace("{", '{"sourceSha":"unversioned-dirty-source",'), JSON.stringify(value).replace("sourceSha", "source\\u0053ha"), JSON.stringify({ ...value, approved: true }), "{}"] ) {
      writeFileSync(path, raw);
      for (const comparison of [false, true]) assert.throws(() => interactionProvenance({ share: root }, sha, comparison));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("newer documentation/tooling cannot conceal runtime/test/build-input drift", () => {
  const root = mkdtempSync(join(tmpdir(), "interactions-runtime-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  try {
    git("init", "-b", "feature/fixture");
    for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "flake.nix", "flake.lock", ".pa-platform-config.sha", ".pa-template-registry.sha"]) writeFileSync(join(root, path), "fixture\n");
    mkdirSync(join(root, "packages/pa-core/src/interactions"), { recursive: true });
    writeFileSync(join(root, "packages/runtime.ts"), "fixture\n");
    git("add", "."); git("commit", "-m", "candidate"); const candidate = git("rev-parse", "HEAD");
    unchangedInteractionRuntime(root, candidate);
    mkdirSync(join(root, "docs")); writeFileSync(join(root, "docs/report.md"), "tooling observation\n");
    writeFileSync(join(root, "packages/pa-core/src/interactions/README.md"), "documentation only\n");
    git("add", "."); git("commit", "-m", "docs only"); unchangedInteractionRuntime(root, candidate);
    for (const path of ["packages/runtime.ts", "package.json", ".pa-platform-config.sha"]) {
      writeFileSync(join(root, path), "changed\n"); assert.throws(() => unchangedInteractionRuntime(root, candidate)); git("restore", path);
    }
    writeFileSync(join(root, "packages/untracked.test.ts"), "untracked test\n"); assert.throws(() => unchangedInteractionRuntime(root, candidate)); rmSync(join(root, "packages/untracked.test.ts"));
    writeFileSync(join(root, "packages/runtime.ts"), "committed drift\n"); git("add", "."); git("commit", "-m", "runtime drift");
    assert.throws(() => unchangedInteractionRuntime(root, candidate));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("only typed owner codes become public causes, without accessing hostile exception getters", () => {
  const fallback = { code: "INTERACTIONS_REQUIRED_EVIDENCE_UNAVAILABLE", gate: "qualification" };
  assert.deepEqual(publicInteractionError(new QualificationBlocked("INTERACTIONS_ARGUMENTS", "arguments")), { code: "INTERACTIONS_ARGUMENTS", gate: "arguments" });
  for (const error of [new Error("SYNTHETIC_SECRET"), { code: "SYNTHETIC_SECRET", gate: "arguments" }, new Proxy({}, { getPrototypeOf() { throw Error("SYNTHETIC_SECRET"); } }), Object.defineProperty(new QualificationBlocked("VALID"), "code", { get() { throw Error("SYNTHETIC_SECRET"); } }), new QualificationBlocked("unsafe\nsecret"), new QualificationBlocked("VALID", "/private/path")]) assert.deepEqual(publicInteractionError(error), fallback);
});
test("public blocked result is bounded, non-sensitive, outcome-first and never claims installation or acceptance", () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./verify_interactions_runtime.mjs", import.meta.url)), "--SYNTHETIC_SECRET"], { env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8", timeout: 10000 });
  assert.ifError(run.error); assert.equal(run.status, 1); assert.equal(run.stderr, "");
  assert.ok(Buffer.byteLength(run.stdout) <= 51200);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "blocked"); assert.equal(result.code, "INTERACTIONS_ARGUMENTS");
  for (const key of ["installationPerformed", "enablementPerformed", "humanUat", "fullTicketAcceptance"]) assert.equal(result[key], false);
  assert.ok(result.cases.every(row => row.status === "not-run"));
  assert.ok(!run.stdout.includes("SYNTHETIC_SECRET"));
  assert.match(result.diagnostic, /^Installed interaction verification could not complete\./);
  assert.ok(result.diagnostic.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(result.diagnostic.split(`${label}:`).length - 1, 1);
});
