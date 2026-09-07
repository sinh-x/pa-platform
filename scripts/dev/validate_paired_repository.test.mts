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

const admissionContract = [
  "Every `requirements/*` mode bypasses dirty-state inspection and repository-ownership admission, including while a live builder owns the same canonical repository.",
  "Foreground admission permits a dirty canonical checkout for every `builder/*` mode, including `builder/orchestrator`.",
  "After a dirty foreground launch, re-evaluate the current branch, full HEAD, and complete staged, unstaged, and untracked status.",
  "Classify whether each observed change belongs to the active ticket, propose one concrete preserve, wait, or stop action, and ask Sinh before any agent-initiated Git mutation or project-file mutation.",
  "Immediately before an approved action, re-read branch, HEAD, and status; if repository state or proposed scope changed, ask Sinh again.",
  "Dirty background `builder/*` deployments reject before runtime spawn and leave no ownership evidence.",
  "Exactly one process-verified live builder may own an exact canonical repository across `ppa` and `opa`.",
  "`--force` recovery applies only to stale or malformed ownership evidence and never overrides process-verified live ownership.",
  "Execution remains direct: PA-managed worktrees and sandbox access classes are prohibited.",
  "",
].join("\n");

const directBranchContract = [
  "# Orchestrator",
  admissionContract,
  "| Repository state | Outcome |",
  "|---|---|",
  "| Already on the exact ticket branch with zero status entries | Proceed. |",
  "| On zero-entry `develop`, `develop` equals `origin/develop`, exact ticket branch is absent | Create the exact ticket branch from `develop`, then proceed. |",
  "| On zero-entry `develop`, `develop` equals `origin/develop`, exact ticket branch exists | Check out the exact ticket branch, then proceed. |",
  "| Any dirty state | Preserve it; classify ticket relationship, propose preserve/wait/stop, and ask Sinh before Git or project-file mutation. |",
  "| `develop` is ahead, behind, or diverged from `origin/develop` | Stop unchanged. |",
  "| On the release branch or any unrelated branch | Stop unchanged. |",
  "| Detached HEAD | Stop unchanged. |",
  "Use `opa branch create` for creation, a direct checkout only for the existing exact branch outcome, then validate.",
  "Every stop preserves observed state before project-file mutation or child launch.",
  "",
].join("\n");

function createFixture(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "paired-config-"));
  mkdirSync(join(root, "teams", "builder", "modes"), { recursive: true });
  mkdirSync(join(root, "skills", "global"), { recursive: true });
  mkdirSync(join(root, "skills", "templates"), { recursive: true });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "config.yaml"), "config_dir: .\n");
  for (const mode of ["data-analysis", "implement", "routine", "worker"]) {
    writeFileSync(join(root, "teams", "builder", "modes", `${mode}.md`), `# ${mode}\n${admissionContract}`);
  }
  writeFileSync(join(root, "teams", "builder", "modes", "orchestrator.md"), directBranchContract);
  writeFileSync(join(root, "skills", "templates", "builder-objective.md"), `# Builder Objective\n${admissionContract}`);
  writeFileSync(join(root, "docs", "runtime-neutral-config.md"), `# Runtime-Neutral Configuration\n${admissionContract}`);
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
    const objective = teamName === "builder"
      ? `objective: |\n${admissionContract.split("\n").map((line) => `  ${line}`).join("\n")}`
      : "objective: Work";
    writeFileSync(join(root, "teams", `${teamName}.yaml`), `name: ${teamName}\ndescription: Team\n${objective}\nagents: []\ndefault_mode: mode-0\ndeploy_modes:\n${modes}\n`);
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
    writeFileSync(path, readFileSync(path, "utf8").replace("PA-managed worktrees and sandbox access classes", "managed checkout isolation"));
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "remove no-worktree contract");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /no-worktree\/no-sandbox/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate requires affirmative admission clauses rather than negated keywords", () => {
  const fixture = createFixture();
  try {
    const path = join(fixture.root, "teams", "builder", "modes", "worker.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(
      "Every `requirements/*` mode bypasses dirty-state inspection and repository-ownership admission",
      "No `requirements/*` mode bypasses dirty-state inspection or repository-ownership admission",
    ));
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "negate requirements contract");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /missing affirmative requirements bypass clause/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects retired blanket no-admission semantics", () => {
  const fixture = createFixture();
  try {
    const path = join(fixture.root, "docs", "runtime-neutral-config.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nRepository admission has no per-mode repository access class; leases and repository ownership are not part of the active contract.\n`);
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "restore retired contract");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /retired blanket no-admission\/no-ownership semantics/);
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
