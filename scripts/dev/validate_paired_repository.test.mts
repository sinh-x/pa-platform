import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundle, fixtureEvidence, definition, bytes } from "../../packages/pa-core/src/__tests__/workflow-fixtures.js";
import { workflowDigest, parseReviewBundle, templateService } from "../../packages/pa-core/src/index.js";
import { templateFixture } from "../../packages/pa-core/src/__tests__/template-fixture.js";
import { validatePairedRepository, validateReviewProducerFixtures } from "./validate_paired_repository.mts";

test("v1 paired producer fixtures require exact three-profile manifest, shared parser and digest agreement", () => {
  const root = mkdtempSync(join(tmpdir(), "pap237-paired-"));
  const source = fileURLToPath(new URL("../../packages/pa-core/src/__tests__/fixtures/protected-review-v1/", import.meta.url));
  try {
    assert.throws(() => validateReviewProducerFixtures(root), /cannot read/);
    mkdirSync(join(root, "contracts/fixtures"), { recursive: true });
    const fixtures = [
      ["producer-node-pnpm", "node-pnpm/v1"], ["mvm-179-migrated", "npm-subprojects/v1"], ["nx-055-migrated", "non-node-nix/v1"],
    ].map(([name, profile]) => {
      const objective = `contracts/fixtures/${name}.objective.json`; const artifact = `contracts/fixtures/${name}.md`;
      writeFileSync(join(root, objective), readFileSync(join(source, `${name}.objective.json`)));
      writeFileSync(join(root, artifact), readFileSync(join(source, `${name}.md`)));
      return { objective, artifact, profile };
    });
    const manifest = { schemaVersion: "pa-review-producer-fixtures/v1", fixtures };
    const path = join(root, "contracts/protected-review-v1.json"); writeFileSync(path, JSON.stringify(manifest));
    assert.equal(validateReviewProducerFixtures(root), 3);
    writeFileSync(path, JSON.stringify({ ...manifest, fixtures: [fixtures[0], fixtures[0], fixtures[2]] }));
    assert.throws(() => validateReviewProducerFixtures(root), /profile/);
    writeFileSync(path, JSON.stringify({ ...manifest, fixtures: [{ ...fixtures[0], artifact: "contracts/fixtures/../escape.md" }, fixtures[1], fixtures[2]] }));
    assert.throws(() => validateReviewProducerFixtures(root), /contained/);
    writeFileSync(path, JSON.stringify(manifest));
    writeFileSync(join(root, fixtures[0]!.artifact), readFileSync(join(root, fixtures[0]!.artifact), "utf8").replace("Policy: parser", "Policy: changed"));
    assert.throws(() => validateReviewProducerFixtures(root), /binding|agree/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
  "OPA/OpenCode makes no Treehouse behavior claim. Config wording does not prove PAP-189 runtime enforcement; PAP-215 owns paired runtime enforcement.",
  "",
].join("\n");

const ppaBranchContract = [
  "For Pi/PPA, the approved requirements plan supplies only canonical `repo_key`/`repo_root`, exact ticket, approved full base SHA, exact linked branch, `planned` state, and `create` action. It does not supply or require a requirements-time builder checkout, worktree, or lease.",
  "At builder/orchestrator launch, the trusted PPA launcher reserves capacity, acquires or reuses and authenticates the distinct Treehouse ticket checkout.",
  "Branch evidence is planned or materialized for the exact linked branch. The orchestrator alone may use ordinary Git to create the exact planned branch from its approved base, or select the exact materialized branch.",
  "Admission permits one active builder lineage per repository/ticket and at most four active ticket checkouts per canonical repository.",
  "Any conflicting identity, ticket, branch state, base, branch, action, lineage, or capacity evidence rejects before project-file or branch mutation and before builder child/runtime spawn.",
  "OPA/OpenCode retains supported non-Treehouse seven-state branch behavior and makes no Treehouse claim.",
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

function createDirectFixture() {
  const fixture = createFixture(), { root } = fixture;
  mkdirSync(join(root, "scripts"));
  // Synthetic producer module proves profile selection/response checks only;
  // the real selected PAPC producer has its own source/mutation test suite.
  const checker = `import { readFileSync } from 'node:fs';\nexport const DIRECT_ONLY_DECLARATION = {version:4,candidatePolicy:'orchestrator-direct-only'};\nexport function checkScopedLocalText(source) { if (!source.includes('scoped ordinary fixture')) throw new Error('scoped instruction control missing'); }\nexport function checkDirectOnlyWorkflow(root, read) { if(read!==undefined&&typeof read!=='function')throw new Error('existing optional reader must remain callable'); checkScopedLocalText(readFileSync(root+'/teams/builder/modes/orchestrator.md','utf8')); return {ok:true,evidenceClass:'current-structural-and-synthetic-not-runtime-proof',scopedLocal:{runtimeOwner:'PAP-268',presentation:'Markdown-sufficient-rich-view-optional',acceptance:'paired-proof-required',sources:[{path:'fixture'}]}}; }\n`;
  writeFileSync(join(root, "scripts/check-prepared-autonomy-workflow.mjs"), checker);
  writeFileSync(join(root, "teams/builder/modes/orchestrator.md"), "# scoped ordinary fixture\nOne authenticated writer, explicit native command contract, Markdown only; no retired implement fallback.\n");
  for (const [name, ids] of [["builder", ["orchestrator", "worker", "housekeeping", "data-analysis"]], ["requirements", ["analyze", "analyze-auto", "spike", "review", "review-auto", "focus"]]] as const) {
    const modes = ids.map((id) => `  - id: ${id}\n    label: ${id}\n    provider: openai\n    model: openai/gpt-test\n${id === "orchestrator" ? "    objective: teams/builder/modes/orchestrator.md\n" : ["analyze", "analyze-auto", "spike"].includes(id) ? `    objective: skills/requirements/${id}-objective.md\n` : ""}`).join("");
    writeFileSync(join(root, `teams/${name}.yaml`), `name: ${name}\ndescription: Fixture\nobjective: ${name === "builder" ? "teams/builder/modes/orchestrator.md" : "Read-only requirements"}\nagents: []\ndefault_mode: ${ids[0]}\ndeploy_modes:\n${modes}`);
  }
  git(root, "add", "."); git(root, "commit", "-qm", "direct fixture");
  return { root, sha: git(root, "rev-parse", "HEAD"), checker };
}

function addWorkflowPair(root: string, enabled: boolean) {
  const t = templateFixture();
  try {
    t.registry.configRevision = "selected";
    const entry = structuredClone(t.registry.entries[0]!); entry.id = "review-bundle";
    entry.source = { path: "skills/templates/review-bundle.md", sha256: workflowDigest("{{bundle}}\n"), selector: null };
    entry.bindings = { bundle: { type: "json", required: true } }; entry.validation = { kind: "review-bundle", sections: [] };
    t.registry.entries.push(entry); writeFileSync(join(t.root, entry.source.path), "{{bundle}}\n");
    for (const resource of t.registry.entries) {
      const path = join(root, resource.source.path);
      if (existsSync(path)) resource.source.sha256 = workflowDigest(readFileSync(path));
      else cpSync(join(t.root, resource.source.path), path);
    }
    t.save(); mkdirSync(join(root, "contracts"), { recursive: true }); cpSync(join(t.root, "contracts/templates-v1.json"), join(root, "contracts/templates-v1.json"));
    const d = definition(), b = bundle(), evidence = fixtureEvidence(b), raw = bytes(d);
    mkdirSync(join(root, "workflows/definitions"), { recursive: true }); mkdirSync(join(root, "workflows/fixtures"));
    writeFileSync(join(root, "workflows/definitions/software.json"), raw);
    const manifest = { schemaVersion: "pa-workflow-manifest/v1", definitions: [{ workflowId: d.workflowId, version: d.version, file: "workflows/definitions/software.json", sha256: workflowDigest(raw) }], bindings: [{ schemaVersion: "pa-workflow-binding/v1", team: "requirements", mode: "analyze", enabled, workflowId: d.workflowId, workflowVersion: d.version }] };
    writeFileSync(join(root, "workflows/manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(root, "workflows/fixtures/requirements.md"), evidence.get(b.requirements.ref)!); writeFileSync(join(root, "workflows/fixtures/uat.md"), evidence.get(b.uat.ref)!);
    const fixtures = ["fresh", "amendment"].map(id => {
      const subject = structuredClone(b); if (id === "amendment") subject.handoff = { type: "amendment", baseSha: b.handoff.baseSha, branch: b.handoff.branch, branchAction: "reuse", featureSha: "c".repeat(40) };
      const request = { action: "render", id: "review-bundle", version: "1", bindings: { bundle: subject } };
      const result = templateService(request, { selection: { root, configRevision: "a".repeat(40), registrySha256: workflowDigest(readFileSync(join(root, "contracts/templates-v1.json"))) }, team: "requirements", mode: "analyze", reviewBundleConsumer: { schemaVersion: "pa-review-bundle/v1", validate: parseReviewBundle } });
      assert.equal(result.ok, true, JSON.stringify(result));
      return { id, team: "requirements", mode: "analyze", producer: JSON.stringify(request), requirementsFile: "workflows/fixtures/requirements.md", uatFile: "workflows/fixtures/uat.md", candidateSha256: workflowDigest(result.candidate as string) };
    });
    writeFileSync(join(root, "workflows/fixtures-v1.json"), JSON.stringify({ schemaVersion: "pa-workflow-fixtures/v1", fixtures }));
    return manifest;
  } finally { t.dispose(); }
}

for (const direct of [false, true]) test(`selected v1 analyze isolates legacy procedural paragraphs, not unselected safety (direct=${direct})`, () => {
  const f = direct ? createDirectFixture() : createFixture();
  try {
    const manifest = addWorkflowPair(f.root, true);
    writeFileSync(join(f.root, "skills/requirements/analyze-objective.md"), "# Short selected route\nUse the pinned native workflow and decision interfaces. No copied approval paragraphs.\n");
    const commit = () => { git(f.root, "add", "."); git(f.root, "commit", "-qm", "synthetic selected route"); return git(f.root, "rev-parse", "HEAD"); };
    let sha = commit();
    if (direct) {
      assert.throws(() => validatePairedRepository({ configRoot: f.root, expectedSha: sha }), /producer failed/); // old companion checker cannot silently certify adoption
      const checker = join(f.root, "scripts/check-prepared-autonomy-workflow.mjs");
      writeFileSync(checker, readFileSync(checker, "utf8").replace("checkDirectOnlyWorkflow(root, read)", "checkDirectOnlyWorkflow(root, read, options)").replace("return {ok:true", "return {workflowRoutes:options.workflowRoutes,ok:true")); sha = commit();
    }
    const result = validatePairedRepository({ configRoot: f.root, expectedSha: sha });
    assert.ok(result.includes("JSON_WORKFLOW_PROCEDURAL_ROUTES=requirements/analyze")); assert.ok(result.includes("JSON_WORKFLOW_PRIMER_IDENTITY=verified-structural-only"));
    assert.ok(result.includes("JSON_WORKFLOW_STRUCTURAL_FIXTURES=2"));
    const other = join(f.root, "skills/requirements/analyze-auto-objective.md"), before = readFileSync(other);
    writeFileSync(other, "Missing unselected legacy safety\n"); sha = commit();
    assert.throws(() => validatePairedRepository({ configRoot: f.root, expectedSha: sha }), /requirements\/analyze-auto.*missing plan-first/);
    writeFileSync(other, before);
    manifest.bindings[0]!.enabled = false; writeFileSync(join(f.root, "workflows/manifest.json"), JSON.stringify(manifest)); sha = commit();
    assert.throws(() => validatePairedRepository({ configRoot: f.root, expectedSha: sha }), /requirements\/analyze.*missing plan-first/); // disable does not select short guidance for new runs
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const enabled of [false, true]) test(`declared v1 incomplete handoff coverage fails closed (enabled=${enabled})`, () => {
  const f = createFixture(); try {
    addWorkflowPair(f.root, enabled);
    const path = join(f.root, "workflows/fixtures-v1.json"), document = JSON.parse(readFileSync(path, "utf8"));
    document.fixtures.pop(); writeFileSync(path, JSON.stringify(document));
    git(f.root, "add", "."); git(f.root, "commit", "-qm", "missing typed handoff");
    assert.throws(() => validatePairedRepository({ configRoot: f.root, expectedSha: git(f.root, "rev-parse", "HEAD") }), /WORKFLOW_SOURCE/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("selected unsupported v1 procedural modes cannot borrow analyze or legacy compatibility", () => {
  const f = createFixture(); try {
    const manifest = addWorkflowPair(f.root, true); manifest.bindings[0]!.mode = "analyze-auto";
    writeFileSync(join(f.root, "workflows/manifest.json"), JSON.stringify(manifest));
    const path = join(f.root, "workflows/fixtures-v1.json"), document = JSON.parse(readFileSync(path, "utf8"));
    document.fixtures.forEach((row: { mode: string }) => row.mode = "analyze-auto"); writeFileSync(path, JSON.stringify(document));
    git(f.root, "add", "."); git(f.root, "commit", "-qm", "unsupported selected procedural route");
    assert.throws(() => validatePairedRepository({ configRoot: f.root, expectedSha: git(f.root, "rev-parse", "HEAD") }), /Unsupported selected v1 procedural route/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("JSON workflow pairing rejects ignored overlays and missing enabled producer/fixture counterparts", () => {
  for (const variant of ["ignored", "missing-counterpart"] as const) {
    const f = createFixture();
    try {
      const d = definition(), raw = bytes(d);
      if (variant === "ignored") { writeFileSync(join(f.root, ".gitignore"), "workflows/\n"); git(f.root, "add", ".gitignore"); git(f.root, "commit", "-qm", "ignored overlay fixture"); }
      mkdirSync(join(f.root, "workflows/definitions"), { recursive: true });
      writeFileSync(join(f.root, "workflows/definitions/software.json"), raw);
      writeFileSync(join(f.root, "workflows/manifest.json"), JSON.stringify({ schemaVersion: "pa-workflow-manifest/v1", definitions: [{ workflowId: d.workflowId, version: d.version, file: "workflows/definitions/software.json", sha256: workflowDigest(raw) }], bindings: [{ schemaVersion: "pa-workflow-binding/v1", team: "requirements", mode: "analyze", enabled: true, workflowId: d.workflowId, workflowVersion: d.version }] }));
      if (variant === "missing-counterpart") { git(f.root, "add", "."); git(f.root, "commit", "-qm", "enabled workflow without producer fixtures"); }
      assert.equal(git(f.root, "status", "--porcelain", "--untracked-files=all"), "");
      assert.throws(() => validatePairedRepository({ configRoot: f.root, expectedSha: git(f.root, "rev-parse", "HEAD") }), variant === "ignored" ? /WORKFLOW_SOURCE/ : /Required pinned workflow fixture is missing/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("PAP-268 paired direct-only profile validates source producer without restoring retired borrower policy", () => {
  const f = createDirectFixture();
  try {
    const result = validatePairedRepository({ configRoot: f.root, expectedSha: f.sha });
    assert.ok(result.includes("SOURCE_PROFILE=ordinary-local/v1")); assert.ok(result.includes("MODES_VALID=52/52"));
    assert.ok(result.includes("BUILDER_EXCLUSIVE=4/4")); assert.ok(result.includes("REQUIREMENTS_READ_ONLY=6/6"));
    assert.ok(result.includes("DIRTY_DIRECT_BORROWER_EXCEPTION=retired-no-fallback"));
    assert.ok(!result.some((line) => line.includes("INSTALLED") || line.includes("UAT_PASSED")));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("PAP-268 paired producer cannot reuse a cached module from a different selected SHA", () => {
  const f = createDirectFixture();
  try {
    assert.doesNotThrow(() => validatePairedRepository({ configRoot: f.root, expectedSha: f.sha }));
    writeFileSync(join(f.root, "scripts/check-prepared-autonomy-workflow.mjs"), f.checker.replace("version:4", "version:3"));
    git(f.root, "add", "."); git(f.root, "commit", "-qm", "changed selected producer");
    assert.throws(() => validatePairedRepository({ configRoot: f.root, expectedSha: git(f.root, "rev-parse", "HEAD") }), /producer failed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const variant of ["producer-version", "producer-failed", "presentation", "empty-sources", "instruction-missing", "inventory"] as const) {
  test(`PAP-268 paired direct-only ${variant} rejects without legacy fallback`, () => {
    const f = createDirectFixture();
    try {
      let checker = f.checker;
      if (variant === "producer-version") checker = checker.replace("version:4", "version:3");
      if (variant === "producer-failed") checker = checker.replace("ok:true", "ok:false");
      if (variant === "presentation") checker = checker.replace("Markdown-sufficient-rich-view-optional", "HTML-required");
      if (variant === "empty-sources") checker = checker.replace("sources:[{path:'fixture'}]", "sources:[]");
      writeFileSync(join(f.root, "scripts/check-prepared-autonomy-workflow.mjs"), checker);
      if (variant === "instruction-missing") writeFileSync(join(f.root, "teams/builder/modes/orchestrator.md"), "unknown instruction\n");
      if (variant === "inventory") { const path = join(f.root, "teams/builder.yaml"); writeFileSync(path, readFileSync(path, "utf8").replace(/  - id: worker\n[\s\S]*?(?=  - id:)/, "")); }
      git(f.root, "add", "."); git(f.root, "commit", "--allow-empty", "-qm", "mutation");
      assert.throws(() => validatePairedRepository({ configRoot: f.root, expectedSha: git(f.root, "rev-parse", "HEAD") }));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
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

test("implementation-first baseline compatibility does not certify v1 rollout pairing", () => {
  const fixture = createFixture();
  try {
    const baseline = validatePairedRepository({ configRoot: fixture.root, expectedSha: fixture.sha });
    assert.ok(!baseline.some((line) => line.startsWith("REVIEW_V1_PRODUCER_PROFILES=")));
    assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: fixture.sha, requireReviewV1: true }), /cannot read/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("paired boundaries accept historical combined subjects without requiring a config ticket", () => {
  for (const [relative, subject, replacement] of [
    ["skills/requirements/analyze-objective.md", "OPA/OpenCode makes", "OPA/OpenCode and legacy-synthetic make"],
    ["teams/builder/modes/orchestrator.md", "OPA/OpenCode retains", "OPA/OpenCode and legacy-synthetic only retain"],
  ] as const) {
    const fixture = createFixture();
    try {
      const path = join(fixture.root, relative);
      writeFileSync(path, readFileSync(path, "utf8").replace(subject, replacement));
      git(fixture.root, "add", "."); git(fixture.root, "commit", "-qm", "preserve historical subject wording");
      assert.doesNotThrow(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: git(fixture.root, "rev-parse", "HEAD") }));
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("historical subject compatibility never removes OPA's non-Treehouse boundary", () => {
  for (const [relative, subject, replacement, required, weakened, diagnostic] of [
    ["skills/requirements/analyze-objective.md", "OPA/OpenCode makes", "OPA/OpenCode and legacy-synthetic make", "no Treehouse behavior claim", "a Treehouse behavior claim", /adapter and runtime-authority boundaries/],
    ["teams/builder/modes/orchestrator.md", "OPA/OpenCode retains", "OPA/OpenCode and legacy-synthetic only retain", "supported non-Treehouse seven-state branch behavior", "supported Treehouse seven-state branch behavior", /non-Pi branch boundary/],
    ["teams/builder/modes/orchestrator.md", "OPA/OpenCode retains", "OPA/OpenCode and legacy-synthetic only retain", "no Treehouse claim", "a Treehouse claim", /non-Pi branch boundary/],
  ] as const) {
    const fixture = createFixture();
    try {
      const path = join(fixture.root, relative);
      writeFileSync(path, readFileSync(path, "utf8").replace(subject, replacement).replace(required, weakened));
      git(fixture.root, "add", "."); git(fixture.root, "commit", "-qm", "reject weakened OPA safety boundary");
      assert.throws(() => validatePairedRepository({ configRoot: fixture.root, expectedSha: git(fixture.root, "rev-parse", "HEAD") }), diagnostic);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
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
