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

const directBranchContract = [
  "# Orchestrator",
  "| Repository state | Outcome |",
  "|---|---|",
  "| Already on the exact ticket branch | Proceed. |",
  "| On zero-entry `develop`, `develop` equals `origin/develop`, exact ticket branch is absent | Create the exact ticket branch from `develop`, then proceed. |",
  "| On zero-entry `develop`, `develop` equals `origin/develop`, exact ticket branch exists | Check out the exact ticket branch, then proceed. |",
  "| Dirty `develop` | Stop unchanged. |",
  "| `develop` is ahead, behind, or diverged from `origin/develop` | Stop unchanged. |",
  "| On the release branch or any unrelated branch | Stop unchanged. |",
  "| Detached HEAD | Stop unchanged. |",
  "Use `opa branch create` for creation, a direct checkout only for the existing exact branch outcome, then validate.",
  "Every stop occurs before project-file mutation or child launch.",
  "",
].join("\n");

function createFixture(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "paired-config-"));
  mkdirSync(join(root, "teams", "builder", "modes"), { recursive: true });
  mkdirSync(join(root, "skills", "global"), { recursive: true });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "config.yaml"), "config_dir: .\n");
  writeFileSync(join(root, "teams", "builder", "modes", "orchestrator.md"), directBranchContract);
  writeFileSync(join(root, "docs", "runtime-neutral-config.md"), "# Runtime-Neutral Configuration\nDirect registered checkout; PA-managed worktrees and sandbox access classes are not part of the active contract.\n");
  const teams = [
    ["builder", 6],
    ["requirements", 11],
    ["evaluator", 1],
    ["insights", 5],
    ["kpi-reviewer", 6],
    ["learner", 10],
    ["maintenance", 5],
    ["planner", 10],
    ["sprint-master", 4],
  ] as const;
  for (const [teamName, count] of teams) {
    const modes = Array.from({ length: count }, (_, modeIndex) => [
      `  - id: mode-${modeIndex}`,
      `    label: Mode ${modeIndex}`,
      "    provider: openai",
      "    model: openai/gpt-test",
    ].join("\n")).join("\n");
    writeFileSync(join(root, "teams", `${teamName}.yaml`), `name: ${teamName}\ndescription: Team\nobjective: Work\nagents: []\ndefault_mode: mode-0\ndeploy_modes:\n${modes}\n`);
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
    assert.ok(evidence.includes("BUILDER_EXCLUSIVE=6/6"));
    assert.ok(evidence.includes("REQUIREMENTS_READ_ONLY=11/11"));
    assert.ok(evidence.includes("OTHER_NON_LOCKING=41/41"));
    assert.ok(evidence.includes("REPOSITORY_ADMISSION_MATRIX=58/58"));
    assert.ok(evidence.includes("BRANCH_GATE=7/7"));
    assert.ok(evidence.includes("NO_WORKTREE_ORCHESTRATION=true"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate leaves absolute operator project guides to runtime validation", () => {
  const fixture = createFixture();
  try {
    const teamPath = join(fixture.root, "teams", "learner.yaml");
    writeFileSync(teamPath, `${readFileSync(teamPath, "utf8")}    project_guides:\n      sample:\n        - /missing/operator/project-guide.md\n`);
    git(fixture.root, "add", teamPath);
    git(fixture.root, "commit", "-qm", "add operator guide");
    const sha = git(fixture.root, "rev-parse", "HEAD");

    const evidence = validatePairedRepository({ configRoot: fixture.root, expectedSha: sha });
    assert.ok(evidence.includes("REFERENCES_MISSING=0"));
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

test("paired repository gate rejects incomplete direct branch contracts", () => {
  const fixture = createFixture();
  try {
    const path = join(fixture.root, "teams", "builder", "modes", "orchestrator.md");
    writeFileSync(path, directBranchContract.replace("| Detached HEAD | Stop unchanged. |\n", ""));
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "incomplete branch gate");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /missing branch-gate outcome/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects removal of the no-worktree/no-sandbox contract", () => {
  const fixture = createFixture();
  try {
    const path = join(fixture.root, "docs", "runtime-neutral-config.md");
    writeFileSync(path, "# Runtime-Neutral Configuration\nDirect registered checkout.\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "remove no-worktree contract");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /no-worktree\/no-sandbox/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects a builder team that escapes exclusive admission", () => {
  const fixture = createFixture();
  try {
    const file = join(fixture.root, "teams", "builder.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("name: builder", "name: builder-helper"));
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "break builder admission");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /Expected 6 exclusive builder modes, found 0/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects committed legacy runtime schema", () => {
  const fixture = createFixture();
  try {
    const file = join(fixture.root, "teams", "learner.yaml");
    writeFileSync(file, "name: learner\ndescription: Team\nobjective: Work\nagents: []\nruntimes: {}\ndeploy_modes: []\n");
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
    const file = join(fixture.root, "teams", "learner.yaml");
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
