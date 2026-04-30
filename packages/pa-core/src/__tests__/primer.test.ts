import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrimer, parseTeamYamlContent } from "../index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function repoPath(...parts: string[]): string {
  return join(repoRoot, ...parts);
}

function resolveRepoFile(relativePath: string): string | undefined {
  return repoPath(relativePath);
}

function assertNoBannedOpencodeOperationalReferences(primer: string): void {
  assert.doesNotMatch(primer, /(^|[\s`'"(=:{])pa\s+(board|bulletin|daily|deploy|health|idea|registry|remove-timer|report|repos|requirements|schedule|serve|status|teams|ticket|timers|trash)\b/m);
  assert.doesNotMatch(primer, /\.claude\/skills|~\/\.claude\/skills|\/home\/[^\s"`<>]+\/\.claude\/skills/);
  assert.doesNotMatch(primer, /TeamCreate|SendMessage|AskUserQuestion|ScheduleWakeup/);
  assert.doesNotMatch(primer, /Claude Code team deployments may use|\buse\s+Agent\b|\bAgent\b\s+tool/i);
  assert.doesNotMatch(primer, /--interactive\b/);
}

function assertNoLegacyPaCliExamples(primer: string): void {
  assert.doesNotMatch(primer, /`pa (deploy|bulletin|status|ticket|registry|report|daily|idea|serve|health|teams|requirements|search|create|update|list|remove-timer)\b/);
  assert.doesNotMatch(primer, /\bpa (deploy|bulletin|status|ticket|registry|report|daily|idea|serve|health|teams|requirements|search|create|update|list|remove-timer)\b/);
}

const team = parseTeamYamlContent(`
name: requirements
description: Requirements team
objective: Write clear requirements
agents:
  - name: researcher
    role: Researches context
deploy_modes:
  - id: plan
    label: Plan
    agents: [researcher]
    objective: Plan the work
`);

test("generatePrimer renders opencode-specific tool guidance", () => {
  const primer = generatePrimer({ runtime: "opencode", teamConfig: team, mode: "plan" });
  assert.match(primer, /Runtime: opencode/);
  assert.match(primer, /updated pa-core command set/);
  assert.match(primer, /Use `pa-core serve` for Agent API server lifecycle/);
  assert.match(primer, /`opa` is the default deployment adapter, not the server owner/);
  assert.match(primer, /Task-style delegation/);
  assert.match(primer, /Do not assume Claude-only operational tools exist/);
  assert.match(primer, /## Active Bulletins/);
  assert.match(primer, /opa bulletin list/);
  assert.match(primer, /## Deployment Instructions/);
  assert.match(primer, /Plan the work/);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer skips missing terse-mode until pa-platform source exists", () => {
  const terseTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
terse_mode: true
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
`);
  const primer = generatePrimer({ runtime: "opencode", teamConfig: terseTeam, mode: "implement" });
  assert.doesNotMatch(primer, /terse-mode/);
  assert.doesNotMatch(primer, /missing skill/);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer adapts PA CLI references to opa for opencode", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-"));
  try {
    mkdirSync(join(root, "pa-cli"));
    writeFileSync(join(root, "pa-cli", "SKILL.md"), [
      "# PA CLI Reference",
      "All agents have access to the `pa` CLI.",
      "Run `pa deploy builder` and `pa ticket list`.",
      "Always `unset CLAUDECODE` before nested `pa deploy`.",
      "```bash",
      "unset CLAUDECODE && pa deploy requirements --background",
      "CLAUDECODE=0 pa status d-123456",
      "pa registry complete d-123456",
      "```",
      "Project key `pa` remains unchanged.",
    ].join("\n"));
    const teamWithSkill = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Run pa deploy builder and pa ticket list
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    skills:
      - name: pa-cli
        inject-as: shared-skill
`);

    const primer = generatePrimer({ runtime: "opencode", teamConfig: teamWithSkill, mode: "implement", skillsDir: root });
    assert.match(primer, /# OPA CLI Reference/);
    assert.match(primer, /`opa` CLI/);
    assert.match(primer, /Run opa deploy builder and opa ticket list/);
    assert.match(primer, /opa deploy requirements --background/);
    assert.match(primer, /opa status d-123456/);
    assert.match(primer, /opa registry complete d-123456/);
    assert.match(primer, /Project key `pa` remains unchanged/);
    assert.doesNotMatch(primer, /CLAUDECODE/);
    assertNoBannedOpencodeOperationalReferences(primer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer requirements analyze fixture preserves required opencode-safe procedures", () => {
  const requirements = parseTeamYamlContent(readFileSync(repoPath("teams", "requirements.yaml"), "utf-8"));
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: requirements,
    mode: "analyze",
    objective: "Analyze opencode primer parity for PAP-022.",
    resolveFile: resolveRepoFile,
    skillsDir: repoPath("skills", "global"),
    extraInstructions: [
      "<deployment-context>",
      "deployment_id: d-test00",
      "repo_root: /tmp/example-repo",
      "ticket_id: PAP-022",
      "</deployment-context>",
    ].join("\n"),
  });

  assert.match(primer, /Runtime: opencode/);
  assert.match(primer, /## Active Bulletins/);
  assert.match(primer, /Before starting work, run `opa bulletin list`/);
  assert.match(primer, /ticket\/objective alignment/);
  assert.match(primer, /## AMBIGUITY PROTOCOL/);
  assert.match(primer, /\[Ambiguity detected/);
  assert.match(primer, /## PHASE CHECKLIST/);
  assert.match(primer, /Phase 0: Validate Codebase Assumptions/);
  assert.match(primer, /Gate Criteria/);
  assert.match(primer, /Phase 6\.5: Self-Review Against Quality Bar/);
  assert.match(primer, /Self-review passed all 8 checks/);
  assert.match(primer, /Phase 6\.6: Sinh Walkthrough & Sign-off/);
  assert.match(primer, /Explicit "yes" or equivalent from Sinh/);
  assert.match(primer, /Sign-off before save/);
  assert.match(primer, /doc-ref handling/);
  assert.match(primer, /Attach both doc-refs before advancing ticket status/);
  assert.match(primer, /Generate UAT Document/);
  assert.match(primer, /one test scenario per Acceptance Criteria item/i);
  assert.match(primer, /pa-session-log/);
  assert.match(primer, /Save session logs under `sessions\/YYYY\/MM\/agent-team\/`/);
  assert.match(primer, /Session logs, artifact finalization, shutdown, and registry completion/i);
  assert.match(primer, /requirements:agent-teams\/requirements\/artifacts/);
  assert.match(primer, /uat:agent-teams\/requirements\/artifacts/);
  assert.match(primer, /Use the injected pa-platform skills below as the canonical operational procedures/);
  assert.match(primer, /path=".*skills\/global\/pa-cli\/SKILL\.md"/);
  assert.match(primer, /path=".*skills\/global\/pa-session-log\/SKILL\.md"/);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer requirements spike fixture keeps ticket-driven orchestration", () => {
  const requirements = parseTeamYamlContent(readFileSync(repoPath("teams", "requirements.yaml"), "utf-8"));
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: requirements,
    mode: "spike",
    objective: "Research spike for PAP-030",
    resolveFile: resolveRepoFile,
    skillsDir: repoPath("skills", "global"),
    extraInstructions: [
      "<deployment-context>",
      "deployment_id: d-test00",
      "repo_root: /tmp/example-repo",
      "ticket_id: PAP-030",
      "topic: API timeout and retry",
      "</deployment-context>",
    ].join("\n"),
  });

  assert.match(primer, /You are an orchestrated spike researcher/);
  assert.match(primer, /`?spike`? is a ticket-driven parent orchestrator/);
  assert.match(primer, /Parent mode is the only mode that advances the ticket to `review-uat`/);
  assert.match(primer, /spike-minimax/);
  assert.match(primer, /spike-openai/);
  assert.match(primer, /3600/);
  assert.match(primer, /1200/);
  assert.match(primer, /--ticket <ticket-id>/);
  assert.match(primer, /sub-deploy/i);
  assert.match(primer, /--status review-uat/);
  assert.match(primer, /child mode output is report-only/);
  assert.match(primer, /uncertainty/i);
  assert.match(primer, /spike-research-report\.md/);
  assert.match(primer, /spike-learning-note\.md/);
  assert.match(primer, /spike:agent-teams\/requirements\/artifacts/);
  assert.match(primer, /attachment:learning-management\/areas\/spike-research\/YYYY-MM-DD-<topic-slug>\.md/);
  assert.match(primer, /Add completion comment first|completion comment/);
  assertNoLegacyPaCliExamples(primer);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer representative builder fixture stays free of legacy opencode references", () => {
  const builder = parseTeamYamlContent(readFileSync(repoPath("teams", "builder.yaml"), "utf-8"));
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: builder,
    mode: "implement",
    objective: "Implement PAP-022 phase 4.4.",
    resolveFile: resolveRepoFile,
    skillsDir: repoPath("skills", "global"),
  });

  assert.match(primer, /Runtime: opencode/);
  assert.match(primer, /Use `opa` for PA platform workflow commands/);
  assert.match(primer, /Use `pa-core serve` for Agent API server lifecycle/);
  assert.match(primer, /`opa` is the default deployment adapter/);
  assert.match(primer, /## Active Bulletins/);
  assert.match(primer, /## Deployment Instructions/);
  assert.match(primer, /path=".*skills\/global\/pa-cli\/SKILL\.md"/);
  assert.doesNotMatch(primer, /missing skill/);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer renders claude-specific tool guidance", () => {
  const primer = generatePrimer({ runtime: "claude", teamConfig: team });
  assert.match(primer, /Runtime: claude/);
  assert.match(primer, /TeamCreate/);
  assert.match(primer, /Write clear requirements/);
});

test("generatePrimer reads mode objective files and applies template vars", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-"));
  try {
    const objectivePath = join(root, "objective.md");
    writeFileSync(objectivePath, "Plan for {{TODAY}} using {{TEAM_NAME}}\n");
    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: team,
      mode: "plan",
      resolveFile: (relativePath) => (relativePath === "Plan the work" ? objectivePath : undefined),
      templateVars: { TODAY: "2026-04-26", TEAM_NAME: "requirements" },
    });
    assert.match(primer, /Plan for 2026-04-26 using requirements/);
    assert.doesNotMatch(primer, /\{\{TODAY\}\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer preserves interactive mode instructions when user objective is supplied", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-"));
  try {
    const objectivePath = join(root, "analyze-objective.md");
    const instructionPath = join(root, "analyze.md");
    writeFileSync(objectivePath, [
      "Your job is to gather requirements interactively with the user.",
      "Sign-off before save.",
      "Run pa ticket list before handoff.",
    ].join("\n"));
    writeFileSync(instructionPath, [
      "This is an interactive session.",
      "Always interactive — ask the user, don't assume.",
      "Use pa ticket update only after approval.",
    ].join("\n"));

    const requirements = parseTeamYamlContent(`
name: requirements
description: Requirements team
objective: Team fallback objective
agents:
  - name: analyst
    role: Gathers requirements
    instruction: skills/requirements/analyze.md
deploy_modes:
  - id: analyze
    label: Analyze
    mode_type: interactive
    agents: [analyst]
    objective: skills/requirements/analyze-objective.md
`);

    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: requirements,
      mode: "analyze",
      objective: "Build a daily instructor performance table",
      resolveFile: (relativePath) => {
        if (relativePath === "skills/requirements/analyze-objective.md") return objectivePath;
        if (relativePath === "skills/requirements/analyze.md") return instructionPath;
        return undefined;
      },
    });

    assert.match(primer, /## Objective\nYour job is to gather requirements interactively with the user\./);
    assert.match(primer, /Sign-off before save\./);
    assert.match(primer, /## User Objective\nBuild a daily instructor performance table/);
    assert.match(primer, /<instruction-file name="analyst">/);
    assert.match(primer, /Always interactive/);
    assert.match(primer, /Run opa ticket list before handoff\./);
    assert.match(primer, /Use opa ticket update only after approval\./);
    assert.match(primer, /## Active Bulletins/);
    assert.match(primer, /## Available Procedures/);
    assert.match(primer, /## Deployment Instructions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
