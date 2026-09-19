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

const dirtyBorrowPolicy = [
  "Classified dirty direct-borrower exception: default dirty-background rejection remains fail-closed; the only dirty-background exception is one runtime-authenticated direct `builder/implement` child of the process-verified, registry-running `builder/orchestrator` that owns the exact canonical repository. Before approval, every entry in the complete NUL-safe porcelain-v2 path/status metadata set must be classified as active-ticket work. Protected one-use evidence is mode `0600`, at most 65,536 bytes, and non-user-visible; approval binds canonical repository key/root, ticket, exact linked branch, full HEAD, that complete path/status set, and exactly one delegated action: `commit` or `cleanup`. File contents are not part of the approval hash.",
  "The parent performs an immediate pre-intent reread and the runtime performs the mutex-serialized admission reread. Any state, scope, context, action, or reread difference must reject before spawn and requires fresh approval and evidence.",
  "While admitted, the child must touch only the approved path set for the approved action; the parent must not mutate or dispatch a sibling, the child must not delegate, and the parent retains phase acceptance and commit/cleanup accountability. Active sibling, descendant, unrelated builder, forbidden-mode, self-asserted, context-mismatch, snapshot-mismatch, and public or force bypass requests reject before spawn.",
  "Under the canonical-repository mutex, matching finalization publishes the exact final Git snapshot, clears only matching borrower/transient/approval evidence, retains authority for the same process-verified live parent or releases it for a terminal or unverifiable parent, and is idempotent.",
  "PAPC-017 must merge first, after which PAP-191 must pin its exact 40-lowercase-hex merged `develop` SHA before paired completion. Config-only and paired config UAT evidence do not prove runtime-admission success.",
].join("\n\n");

const admissionContract = [
  "Every `requirements/*` mode bypasses dirty-state inspection and repository-ownership admission, including while a live builder owns the same canonical repository.",
  "Foreground admission permits a dirty canonical checkout for every `builder/*` mode, including `builder/orchestrator`.",
  "After a dirty foreground launch, re-evaluate the current branch, full HEAD, and complete staged, unstaged, and untracked status.",
  "Classify whether each observed change belongs to the active ticket, propose one concrete preserve, wait, or stop action, and ask Sinh before any agent-initiated Git mutation or project-file mutation.",
  "Immediately before an approved action, re-read branch, HEAD, and status; if repository state or proposed scope changed, ask Sinh again.",
  "Dirty background `builder/*` deployments reject before runtime spawn and leave no ownership evidence.",
  "Admission permits one active builder lineage per canonical repository/ticket and at most four active ticket checkouts per canonical repository.",
  "`--force` recovery applies only to stale or malformed ownership evidence and never overrides process-verified live ownership.",
  "Execution remains direct: PA-managed worktrees and sandbox access classes are prohibited.",
  dirtyBorrowPolicy,
  "",
].join("\n");

const planFirstRequirementsContract = [
  "Requirements records canonical `repo_key`/`repo_root`, exact ticket, approved full base SHA, exact feature branch, `planned` state, and `create` action.",
  "A requirements-time builder checkout, worktree, and lease are neither required nor accepted as a handoff prerequisite.",
  "Requirements performs no Treehouse checkout lifecycle operation and no branch action.",
  "The trusted PPA builder/orchestrator launcher reserves capacity, acquires or reuses and authenticates the checkout, performs ordinary-Git branch materialization, persists durable correlation evidence, and only then spawns implementation.",
  "Admission permits one active builder lineage per repository/ticket and at most four active ticket checkouts per canonical repository.",
  "Only Sinh/operator may return the checkout after explicit approval.",
  "OPA/OpenCode and CPA/Claude Code make no Treehouse behavior claim. Config wording does not prove PAP-189 runtime enforcement; PAP-215 owns paired runtime enforcement.",
  "",
].join("\n");

const ppaBranchContract = [
  "For Pi/PPA, the approved requirements plan supplies only canonical `repo_key`/`repo_root`, exact ticket, approved full base SHA, exact linked branch, `planned` state, and `create` action. It does not supply or require a requirements-time builder checkout, worktree, or lease.",
  "At builder/orchestrator launch, the trusted PPA launcher reserves capacity, acquires or reuses and authenticates the distinct Treehouse ticket checkout.",
  "Branch evidence is planned or materialized for the exact linked branch. The orchestrator alone may use ordinary Git to create the exact planned branch from its approved base, or select the exact materialized branch.",
  "Admission permits one active builder lineage per repository/ticket and at most four active ticket checkouts per canonical repository.",
  "Any conflicting identity, ticket, branch state, base, branch, action, lineage, or capacity evidence rejects before project-file or branch mutation and before builder child/runtime spawn.",
  "OPA/OpenCode and CPA/Claude Code retain supported non-Treehouse seven-state branch behavior and make no Treehouse claim.",
  "",
].join("\n");

const planFirstRuntimeContract = "Every requirements mode uses canonical repo_root as its read-only analysis root; no requirements-time authenticated builder checkout, worktree, lease, holder, ticket slot, or repository permit is required. PAP-215 owns plan-first Treehouse runtime enforcement and must pin the exact merged PAPC-024 `develop` SHA.\n";

const directBranchContract = [
  "# Orchestrator",
  admissionContract,
  ppaBranchContract,
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
  "Use the dedicated TUI approval tool for complete classification and concrete action, perform an immediate reread, make no parent mutation, and require a new approval on drift.",
  "",
].join("\n");

function createFixture(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "paired-config-"));
  mkdirSync(join(root, "teams", "builder", "modes"), { recursive: true });
  mkdirSync(join(root, "skills", "global"), { recursive: true });
  mkdirSync(join(root, "skills", "requirements"), { recursive: true });
  mkdirSync(join(root, "skills", "templates"), { recursive: true });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "config.yaml"), "config_dir: .\n");
  for (const mode of ["data-analysis", "routine", "worker"]) {
    writeFileSync(join(root, "teams", "builder", "modes", `${mode}.md`), `# ${mode}\n${admissionContract}`);
  }
  writeFileSync(join(root, "teams", "builder", "modes", "implement.md"), `# implement\n${admissionContract}The direct child is non-transitive, may mutate only exact approved current and planned-new paths, and reports final snapshot and cleanup without protected fields.\n`);
  writeFileSync(join(root, "teams", "builder", "modes", "orchestrator.md"), directBranchContract);
  writeFileSync(join(root, "skills", "templates", "builder-objective.md"), `# Builder Objective\n${admissionContract}`);
  writeFileSync(join(root, "skills", "templates", "orchestration-report.md"), `# Orchestration Report\n${admissionContract}The report never records receipt IDs, approval references, tokens, digests, raw receipts, or process fingerprints.\n`);
  writeFileSync(join(root, "docs", "runtime-neutral-config.md"), `# Runtime-Neutral Configuration\n${admissionContract}${planFirstRuntimeContract}`);
  for (const mode of ["analyze", "analyze-auto", "spike"]) {
    writeFileSync(join(root, "skills", "requirements", `${mode}-objective.md`), `# ${mode}\n${planFirstRequirementsContract}`);
  }
  const teams = [
    ["builder", 6],
    ["requirements", 11],
    ["rogue-one", 1],
    ["evaluator", 1],
    ["insights", 5],
    ["kpi-reviewer", 6],
    ["learner", 10],
    ["maintenance", 5],
    ["planner", 10],
    ["sprint-master", 4],
  ] as const;
  for (const [teamName, count] of teams) {
    const modeIds = teamName === "requirements"
      ? ["analyze", "analyze-auto", "spike", ...Array.from({ length: count - 3 }, (_, index) => `mode-${index}`)]
      : Array.from({ length: count }, (_, index) => `mode-${index}`);
    const modes = modeIds.map((modeId, modeIndex) => [
      `  - id: ${modeId}`,
      `    label: Mode ${modeIndex}`,
      ...(["analyze", "analyze-auto", "spike"].includes(modeId) ? [`    objective: skills/requirements/${modeId}-objective.md`] : []),
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

test("paired repository gate accepts the exact clean 10-team/59-mode checkout", () => {
  const fixture = createFixture();
  try {
    const evidence = validatePairedRepository({ configRoot: fixture.root, expectedSha: fixture.sha });
    assert.ok(evidence.includes("TEAMS_VALID=10/10"));
    assert.ok(evidence.includes("MODES_VALID=59/59"));
    assert.ok(evidence.includes("BUILDER_EXCLUSIVE=6/6"));
    assert.ok(evidence.includes("REQUIREMENTS_READ_ONLY=11/11"));
    assert.ok(evidence.includes("OTHER_NON_LOCKING=42/42"));
    assert.ok(evidence.includes("REPOSITORY_ADMISSION_MATRIX=59/59"));
    assert.ok(evidence.includes("PPA_BRANCH_GATE=6/6"));
    assert.ok(evidence.includes("PLAN_FIRST_REQUIREMENTS_PRIMERS=3/3"));
    assert.ok(evidence.includes("REQUIREMENTS_TIME_CHECKOUT_PREREQUISITES=0"));
    assert.ok(evidence.includes("BUILDER_OWNED_TREEHOUSE_MATERIALIZATION=true"));
    assert.ok(evidence.includes("DIRTY_DIRECT_BORROW_POLICY=6/6"));
    assert.ok(evidence.includes("DIRTY_DIRECT_BORROWER_EXCEPTION=1/1"));
    assert.ok(evidence.includes("GENERAL_DIRTY_BACKGROUND_REJECTION=true"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects requirements-time checkout prerequisites", () => {
  const fixture = createFixture();
  try {
    const path = join(fixture.root, "skills", "requirements", "analyze-objective.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nA builder-bound Pi/PPA handoff must carry authenticated worktree_root and operator-prepared checkout evidence before orchestrator dispatch.\n`);
    git(fixture.root, "add", path);
    git(fixture.root, "commit", "-qm", "restore stale checkout prerequisite");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /restores a requirements-time checkout prerequisite/);
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
    writeFileSync(path, directBranchContract.replace("Branch evidence is planned or materialized for the exact linked branch.", "Branch evidence is unspecified."));
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "incomplete branch gate");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /missing PPA branch-gate contract/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects removal of the plan-first runtime boundary", () => {
  const fixture = createFixture();
  try {
    const path = join(fixture.root, "docs", "runtime-neutral-config.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("no requirements-time authenticated builder checkout, worktree, lease, holder, ticket slot, or repository permit is required", "requirements must provide a prepared checkout and lease"));
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "remove plan-first boundary");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /plan-first requirements\/builder materialization boundary/);
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
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /missing affirmative requirements read-only admission clause/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects missing or weakened dirty direct-borrow policy", () => {
  const fixture = createFixture();
  try {
    const path = join(fixture.root, "teams", "builder.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("default dirty-background rejection remains fail-closed", "dirty-background admission is unrestricted"));
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "weaken dirty borrower contract");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /missing affirmative classified dirty direct-borrower case: default rejection and narrow exception/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("paired repository gate rejects protected evidence rendering", () => {
  const fixture = createFixture();
  try {
    const path = join(fixture.root, "skills", "templates", "orchestration-report.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("non-user-visible", "rendered with receipt IDs and digests"));
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-qm", "render protected evidence");
    const sha = git(fixture.root, "rev-parse", "HEAD");
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: sha }), /missing affirmative classified dirty direct-borrower case: protected evidence bounds/);
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
