import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureRepositoryGitSnapshot } from "../deploy/repository-admission.js";
import { assertSupportedLocalGitEffects, assertLocalGitIndexMatchesWorking, localGitIndexFingerprint, localGitTreeFingerprint } from "../deploy/local-git-effects.js";

function fixture(run: (f: { root: string; git: (args: readonly string[], cwd?: string) => Buffer; hooks: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap268-git-proof-")), hooks = join(root, "hooks");
  const git = (args: readonly string[], cwd = root) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
  try {
    git(["init", "-q", "-b", "develop"]); mkdirSync(hooks);
    for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"], ["core.hooksPath", hooks], ["commit.gpgsign", "false"]]) git(["config", key!, value!]);
    writeFileSync(join(root, "README.md"), "base\n"); git(["add", "README.md"]); git(["commit", "-qm", "base"]);
    run({ root, git, hooks });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("PAP-268 native Git index attestation equals the actual committed tree, not a guessed HEAD", () => fixture(({ root, git }) => {
  writeFileSync(join(root, "README.md"), "checked content\n"); git(["add", "README.md"]);
  assertSupportedLocalGitEffects(root, git, { action: "commit", paths: ["README.md"] });
  assertLocalGitIndexMatchesWorking(root, git, ["README.md"]);
  const expected = localGitIndexFingerprint(root, git);
  git(["commit", "-qm", "checked"]);
  assert.equal(localGitTreeFingerprint(root, git, git(["rev-parse", "HEAD"]).toString().trim()), expected);
}));

test("PAP-268 final tree attestation detects content changed by a commit-time extension", () => fixture(({ root, git, hooks }) => {
  writeFileSync(join(root, "README.md"), "checked\n"); git(["add", "README.md"]);
  const checkedIndex = localGitIndexFingerprint(root, git);
  // Controlled negative fixture: invoke Git directly to generate a mismatching
  // real tree, never a native passing receipt or a production guard bypass.
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nprintf 'changed by hook\\n' > README.md\ngit add -- README.md\n", { mode: 0o700 });
  git(["commit", "-qm", "hook changed content"]);
  assert.notEqual(localGitTreeFingerprint(root, git, git(["rev-parse", "HEAD"]).toString().trim()), checkedIndex);
}));

for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction", "post-index-change"]) {
  test(`PAP-268 unsupported ${name} effect is rejected without running it`, () => fixture(({ root, git, hooks }) => {
    writeFileSync(join(hooks, name), "#!/bin/sh\nexit 77\n", { mode: 0o700 });
    assert.throws(() => assertSupportedLocalGitEffects(root, git, { action: "commit", paths: ["README.md"] }), /EXECUTION_GIT_EFFECTS_UNSUPPORTED/);
  }));
}

test("PAP-268 inactive samples/disabled hooks are not silently disabled or mistaken for executable hooks", () => fixture(({ root, git, hooks }) => {
  writeFileSync(join(hooks, "pre-commit"), "not executable\n", { mode: 0o600 });
  writeFileSync(join(hooks, "pre-commit.sample"), "#!/bin/sh\nexit 77\n", { mode: 0o700 });
  assertSupportedLocalGitEffects(root, git, { action: "commit", paths: ["README.md"] });
  chmodSync(join(hooks, "pre-commit"), 0o700);
  assert.throws(() => assertSupportedLocalGitEffects(root, git, { action: "commit", paths: ["README.md"] }), /EXECUTION_GIT_EFFECTS_UNSUPPORTED/);
  git(["config", "core.hooksPath", "/dev/null"]);
  assertSupportedLocalGitEffects(root, git, { action: "commit", paths: ["README.md"] });
}));

test("PAP-268 hook aliases and signing/maintenance extensions require their own supported effect profile", () => fixture(({ root, git, hooks }) => {
  symlinkSync(join(root, "missing-hook"), join(hooks, "pre-commit"));
  assert.throws(() => assertSupportedLocalGitEffects(root, git, { action: "commit" }), /EXECUTION_GIT_EFFECTS_UNSUPPORTED/);
  rmSync(join(hooks, "pre-commit")); git(["config", "commit.gpgsign", "true"]);
  assert.throws(() => assertSupportedLocalGitEffects(root, git, { action: "commit" }), /EXECUTION_GIT_EFFECTS_UNSUPPORTED/);
  git(["config", "commit.gpgsign", "false"]); git(["config", "gc.recentObjectsHook", "not-run"]);
  assert.throws(() => assertSupportedLocalGitEffects(root, git, { action: "commit" }), /EXECUTION_GIT_EFFECTS_UNSUPPORTED/);
}));

test("PAP-268 affected clean/process filters reject before staging; unrelated configured filters do not run", () => fixture(({ root, git }) => {
  git(["config", "filter.fixture.clean", "must-not-run"]);
  assertSupportedLocalGitEffects(root, git, { action: "stage", paths: ["README.md"] });
  writeFileSync(join(root, ".gitattributes"), "README.md filter=fixture\n");
  assert.throws(() => assertSupportedLocalGitEffects(root, git, { action: "stage", paths: ["README.md"] }), /EXECUTION_GIT_EFFECTS_UNSUPPORTED/);
}));

test("PAP-268 real read-only Git snapshot rejects affected filters before status can execute them", () => fixture(({ root, git }) => {
  writeFileSync(join(root, ".gitattributes"), "README.md filter=fixture\n"); git(["add", ".gitattributes"]); git(["commit", "-qm", "attributes"]);
  git(["config", "filter.fixture.clean", `touch ${join(root, "filter-ran")}; cat`]);
  writeFileSync(join(root, "README.md"), "dirty bytes force a Git status content probe\n");
  assert.throws(() => captureRepositoryGitSnapshot(root), /EXECUTION_GIT_EFFECTS_UNSUPPORTED/);
  assert.throws(() => captureRepositoryGitSnapshot(root), /EXECUTION_GIT_EFFECTS_UNSUPPORTED/);
  assert.equal(existsSync(join(root, "filter-ran")), false);
}));

test("PAP-268 staged content/mode substitution or normalization cannot inherit working-byte passes", () => fixture(({ root, git }) => {
  writeFileSync(join(root, "README.md"), "checked\n"); git(["add", "README.md"]);
  writeFileSync(join(root, "README.md"), "different current content\n");
  assert.throws(() => assertLocalGitIndexMatchesWorking(root, git, ["README.md"]), /EXECUTION_CHECKED_CONTENT_UNPROVEN/);
  git(["config", "core.autocrlf", "true"]); writeFileSync(join(root, "README.md"), "line\r\n"); git(["add", "README.md"]);
  assert.throws(() => assertLocalGitIndexMatchesWorking(root, git, ["README.md"]), /EXECUTION_CHECKED_CONTENT_UNPROVEN/);
}));

test("PAP-268 NUL-safe index/tree fingerprints retain raw rename/newline endpoints", () => fixture(({ root, git }) => {
  writeFileSync(join(root, "new\nname"), "content\n"); git(["add", "new\nname"]);
  assertLocalGitIndexMatchesWorking(root, git, ["new\nname"]);
  const before = localGitIndexFingerprint(root, git); git(["commit", "-qm", "newline path"]);
  assert.equal(localGitTreeFingerprint(root, git, git(["rev-parse", "HEAD"]).toString().trim()), before);
  git(["mv", "new\nname", "renamed\tfile"]);
  assert.notEqual(localGitIndexFingerprint(root, git), before);
}));
