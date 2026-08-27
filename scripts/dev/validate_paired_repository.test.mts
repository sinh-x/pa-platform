import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePairedRepository } from "./validate_paired_repository.mts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function createFixture(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "paired-config-"));
  mkdirSync(join(root, "teams"));
  mkdirSync(join(root, "skills", "global"), { recursive: true });
  writeFileSync(join(root, "config.yaml"), "config_dir: .\n");
  for (let teamIndex = 0; teamIndex < 9; teamIndex += 1) {
    const count = teamIndex === 0 ? 10 : 6;
    const modes = Array.from({ length: count }, (_, modeIndex) => [
      `  - id: mode-${modeIndex}`,
      `    label: Mode ${modeIndex}`,
      "    provider: openai",
      "    model: openai/gpt-test",
    ].join("\n")).join("\n");
    writeFileSync(join(root, "teams", `team-${teamIndex}.yaml`), `name: team-${teamIndex}\ndescription: Team\nobjective: Work\nagents: []\ndefault_mode: mode-0\ndeploy_modes:\n${modes}\n`);
  }
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return { root, sha: git(root, "rev-parse", "HEAD") };
}

test("paired repository gate accepts the exact clean 9-team/58-mode checkout", () => {
  const fixture = createFixture();
  try {
    const evidence = validatePairedRepository({ configRoot: fixture.root, expectedSha: fixture.sha });
    assert.ok(evidence.includes("TEAMS_VALID=9/9"));
    assert.ok(evidence.includes("MODES_VALID=58/58"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects dirty and wrong-SHA checkouts", () => {
  const fixture = createFixture();
  try {
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: "0".repeat(40) }), /HEAD mismatch/);
    writeFileSync(join(fixture.root, "untracked.txt"), "dirty\n");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: fixture.sha }), /must be clean/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects committed legacy runtime schema", () => {
  const fixture = createFixture();
  try {
    const file = join(fixture.root, "teams", "team-0.yaml");
    writeFileSync(file, "name: team-0\ndescription: Team\nobjective: Work\nagents: []\nruntimes: {}\ndeploy_modes: []\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "legacy");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /runtimes is no longer supported/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects mismatched qualified namespaces", () => {
  const fixture = createFixture();
  try {
    const file = join(fixture.root, "teams", "team-0.yaml");
    const content = readFileSync(file, "utf8").replace("model: openai/gpt-test", "model: deepseek/deepseek-v4-pro");
    writeFileSync(file, content);
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "mismatch");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /model namespace does not match provider openai/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate enforces origin/develop ancestry", () => {
  const fixture = createFixture();
  try {
    git(fixture.root, "update-ref", "refs/remotes/origin/develop", fixture.sha);
    assert.doesNotThrow(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: fixture.sha, requireOriginDevelop: true }));
    writeFileSync(join(fixture.root, "config.yaml"), "config_dir: changed\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "new head");
    const newSha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: newSha, requireOriginDevelop: true }), /not contained in origin\/develop/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
