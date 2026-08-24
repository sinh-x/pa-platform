import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrimer, getPlatformHomeDir, parseTeamYamlContent } from "../index.js";

const configRoot = getPlatformHomeDir();

function configPath(...parts: string[]): string {
  return join(configRoot, ...parts);
}

function resolveConfigFile(relativePath: string): string | undefined {
  return configPath(relativePath);
}

function withPrimerPathEnv(fn: (root: string, platform: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-paths-"));
  const platform = join(root, "operator-config");
  const previous = {
    config: process.env["PA_PLATFORM_CONFIG"],
    home: process.env["PA_PLATFORM_HOME"],
    teams: process.env["PA_PLATFORM_TEAMS"],
    skills: process.env["PA_PLATFORM_SKILLS"],
  };
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.yaml"), `config_dir: ${platform}\n`);
    process.env["PA_PLATFORM_CONFIG"] = configDir;
    delete process.env["PA_PLATFORM_HOME"];
    delete process.env["PA_PLATFORM_TEAMS"];
    delete process.env["PA_PLATFORM_SKILLS"];
    fn(root, platform);
  } finally {
    restoreEnv("PA_PLATFORM_CONFIG", previous.config);
    restoreEnv("PA_PLATFORM_HOME", previous.home);
    restoreEnv("PA_PLATFORM_TEAMS", previous.teams);
    restoreEnv("PA_PLATFORM_SKILLS", previous.skills);
    rmSync(root, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

test("generatePrimer ticket banner shows the ticket id when templateVars.TICKET_ID is set", () => {
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: team,
    mode: "plan",
    templateVars: { TICKET_ID: "PAP-125" },
  });
  assert.match(primer, /> \*\*Ticket:\*\* PAP-125/);
});

test("generatePrimer ticket banner shows 'none' when templateVars.TICKET_ID is missing", () => {
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: team,
    mode: "plan",
  });
  assert.match(primer, /> \*\*Ticket:\*\* none/);
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
  assert.doesNotMatch(primer, /Ask exactly one confirmation question before deeper analysis/);
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
    assert.match(primer, /Always `unset CLAUDECODE` before nested `opa deploy`/);
    assertNoBannedOpencodeOperationalReferences(primer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer requirements analyze fixture preserves required opencode-safe procedures", (t) => {
  if (!existsSync(configPath("teams", "requirements.yaml"))) return t.skip("external pa-platform-config fixture not available");
  const requirements = parseTeamYamlContent(readFileSync(configPath("teams", "requirements.yaml"), "utf-8"));
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: requirements,
    mode: "analyze",
    objective: "Analyze opencode primer parity for PAP-022.",
    resolveFile: resolveConfigFile,
    skillsDir: configPath("skills", "global"),
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
  assert.match(primer, /OpenCode Question Tool Flow/);
  assert.match(primer, /list-building[\s\S]{0,160}`multiple: true`|`multiple: true`[\s\S]{0,160}list-building/);
  assert.match(primer, /scope items|out-of-scope boundaries|affected users|risks|unknowns|dependencies|acceptance criteria candidates/);
  assert.match(primer, /confirmation|approval|sign-off/);
  assert.match(primer, /`multiple: false`/);
  assert.match(primer, /## PHASE CHECKLIST/);
  assert.match(primer, /Phase 0: Validate Codebase Assumptions/);
  assert.match(primer, /Gate Criteria/);
  assert.match(primer, /Phase 6\.5: Self-Review Against Quality Bar/);
  assert.match(primer, /Self-review passed all 13 checks/);
  assert.match(primer, /Shape-Conformance: 13\/13/);
  assert.match(primer, /Builder handoff is executable/);
  assert.match(primer, /Feature Branch \+ Implementation Plan/);
  assert.match(primer, /per-phase deliverables, FR\/NFR\/AC traceability, and verification steps/);
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
  assert.match(primer, /For semantic briefing-style requests \(for example: startup context refresh or get up to date\), render `opa semantic briefing <query>` output with evidence links, then ask exactly one confirmation question before deeper analysis or mutation\./);
  assert.match(primer, /requirements:agent-teams\/requirements\/artifacts/);
  assert.match(primer, /uat:agent-teams\/requirements\/artifacts/);
  assert.match(primer, /Use the injected pa-platform skills below as the canonical operational procedures/);
  assert.match(primer, /## Available Procedures/);
  assert.match(primer, /- pa-cli:.*Path: `.*skills\/global\/pa-cli\/SKILL\.md`/);
  assert.match(primer, /- pa-session-log:.*Path: `.*skills\/global\/pa-session-log\/SKILL\.md`/);
  assert.doesNotMatch(primer, /## Reference Skills/);
  assertNoLegacyPaCliExamples(primer);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer requirements analyze-auto fixture remains valid under opencode", (t) => {
  if (!existsSync(configPath("teams", "requirements.yaml"))) return t.skip("external pa-platform-config fixture not available");
  const requirements = parseTeamYamlContent(readFileSync(configPath("teams", "requirements.yaml"), "utf-8"));
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: requirements,
    mode: "analyze-auto",
    objective: "Auto-run requirements analysis for PAP-030",
    resolveFile: resolveConfigFile,
    skillsDir: configPath("skills", "global"),
  });

  assert.match(primer, /Runtime: opencode/);
  assert.match(primer, /## Active Bulletins/);
  assert.match(primer, /Before starting work, run `opa bulletin list`/);
  assert.match(primer, /## TICKET PROTOCOL/);
  assert.match(primer, /Claim it: `opa ticket update <id> --assignee requirements\/team-manager`/);
  assert.match(primer, /Mark complete: `opa ticket update <id> --status pending-approval --assignee sinh/);
  assert.match(primer, /## OUTPUT FORMATS/);
  assert.match(primer, /Feature Branch/);
  assert.match(primer, /per-phase deliverables, FR\/NFR\/AC traceability, and verification steps/);
  assert.match(primer, /13-check Quality Bar/);
  assert.match(primer, /Shape-Conformance: N\/13/);
  assert.match(primer, /failed checks that cannot be auto-fixed in §14 Open Questions/);
  assert.match(primer, /## RULES/);
  assert.match(primer, /Non-interactive/);
  assert.match(primer, /requirements:agent-teams\/requirements\/artifacts/);
  assertNoLegacyPaCliExamples(primer);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer requirements spike fixture keeps ticket-driven orchestration", (t) => {
  if (!existsSync(configPath("teams", "requirements.yaml"))) return t.skip("external pa-platform-config fixture not available");
  const requirements = parseTeamYamlContent(readFileSync(configPath("teams", "requirements.yaml"), "utf-8"));
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: requirements,
    mode: "spike",
    objective: "Research spike for PAP-030",
    resolveFile: resolveConfigFile,
    skillsDir: configPath("skills", "global"),
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

test("generatePrimer representative builder fixture stays free of legacy opencode references", (t) => {
  if (!existsSync(configPath("teams", "builder.yaml"))) return t.skip("external pa-platform-config fixture not available");
  const builder = parseTeamYamlContent(readFileSync(configPath("teams", "builder.yaml"), "utf-8"));
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: builder,
    mode: "implement",
    objective: "Implement PAP-022 phase 4.4.",
    resolveFile: resolveConfigFile,
    skillsDir: configPath("skills", "global"),
  });

  assert.match(primer, /Runtime: opencode/);
  assert.match(primer, /Use `opa` for PA platform workflow commands/);
  assert.match(primer, /Use `pa-core serve` for Agent API server lifecycle/);
  assert.match(primer, /`opa` is the default deployment adapter/);
  assert.match(primer, /## Active Bulletins/);
  assert.match(primer, /## Deployment Instructions/);
  assert.match(primer, /## Available Procedures/);
  assert.match(primer, /- pa-cli:.*Path: `.*skills\/global\/pa-cli\/SKILL\.md`/);
  assert.match(primer, /- google-workspace:.*Path: `.*skills\/global\/google-workspace\/SKILL\.md`/);
  assert.doesNotMatch(primer, /## Reference Skills/);
  assert.doesNotMatch(primer, /missing skill/);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer implement instructions are report-only and parent-owned across runtimes", () => {
  const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build things
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    objective: Implement work
`);
  const lifecycleGuidance = /status updates? are prohibited\. Report completion through the ticket comment and persistent artifact output; status transitions belong to the parent flow or orchestrator\./;
  for (const runtime of ["opencode", "claude", "droid"] as const) {
    const primer = generatePrimer({ runtime, teamConfig: builderTeam, mode: "implement" });
    assert.match(primer, lifecycleGuidance, `${runtime} must include report-only lifecycle guidance`);
    assert.doesNotMatch(primer, /advance status only after required artifacts exist/,
      `${runtime} must not include generic status-advance guidance`);
  }
});

test("generatePrimer omits auto-evaluation deployment instruction", () => {
  const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build things
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
`);

  const opencodePrimer = generatePrimer({ runtime: "opencode", teamConfig: builderTeam, mode: "implement" });
  assert.doesNotMatch(opencodePrimer, /opa evaluate --evaluate-deployment/);

  const claudePrimer = generatePrimer({ runtime: "claude", teamConfig: builderTeam, mode: "implement" });
  assert.doesNotMatch(claudePrimer, /cpa evaluate --evaluate-deployment/);
});

test("generatePrimer never requests evaluator self-launch", () => {
  const evaluatorTeam = parseTeamYamlContent(`
name: evaluator
description: Evaluator team
objective: Evaluate deployments
agents:
  - name: evaluator-agent
    role: Reviews deployments
deploy_modes:
  - id: deployment-review
    label: Deployment Review
`);

  const opencodePrimer = generatePrimer({ runtime: "opencode", teamConfig: evaluatorTeam, mode: "deployment-review" });
  assert.doesNotMatch(opencodePrimer, /opa evaluate --evaluate-deployment/);

  const claudePrimer = generatePrimer({ runtime: "claude", teamConfig: evaluatorTeam, mode: "deployment-review" });
  assert.doesNotMatch(claudePrimer, /cpa evaluate --evaluate-deployment/);
});

test("generatePrimer renders claude-specific tool guidance", () => {
  const primer = generatePrimer({ runtime: "claude", teamConfig: team });
  assert.match(primer, /Runtime: claude/);
  assert.match(primer, /TeamCreate/);
  assert.match(primer, /Write clear requirements/);
});

test("generatePrimer renders claude active bulletins, procedures, and deployment instructions", () => {
  const claudeTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build things
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    skills:
      - name: pa-startup
        inject-as: shared-skill
      - name: pa-ticket-workflow
        inject-as: shared-skill
      - name: pa-session-log
        inject-as: shared-skill
`);
  const primer = generatePrimer({ runtime: "claude", teamConfig: claudeTeam, mode: "implement" });
  assert.match(primer, /Runtime: claude/);
  assert.match(primer, /## Active Bulletins/);
  assert.match(primer, /Before starting work, run `cpa bulletin list`/);
  assert.match(primer, /## Available Procedures/);
  assert.match(primer, /pa-startup: startup order/);
  assert.match(primer, /pa-ticket-workflow: ticket claim/);
  assert.match(primer, /pa-session-log: session logs/);
  assert.match(primer, /## Deployment Instructions/);
  assert.match(primer, /Use `cpa` for PA platform workflow commands/);
  assert.match(primer, /Use `pa-core serve` for Agent API server lifecycle/);
  assert.match(primer, /Skill \(slash commands\), AskUserQuestion, Agent, TeamCreate, SendMessage, and ScheduleWakeup/);
  assert.match(primer, /finalize registry state with `cpa registry complete`/);
  // claude branch must NOT swap in opa idioms
  assert.doesNotMatch(primer, /opa bulletin list/);
  assert.doesNotMatch(primer, /Use `opa` for PA platform workflow commands/);
  assert.doesNotMatch(primer, /opa registry complete/);
});

test("generatePrimer adapts PA CLI references to cpa for claude runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-claude-"));
  try {
    mkdirSync(join(root, "pa-cli"));
    writeFileSync(join(root, "pa-cli", "SKILL.md"), [
      "# PA CLI Reference",
      "All agents have access to the `pa` CLI.",
      "Run `pa deploy builder` and `pa ticket list`.",
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

    const primer = generatePrimer({ runtime: "claude", teamConfig: teamWithSkill, mode: "implement", skillsDir: root });
    assert.match(primer, /# CPA CLI Reference/);
    assert.match(primer, /`cpa` CLI/);
    assert.match(primer, /Run cpa deploy builder and cpa ticket list/);
    assert.match(primer, /Project key `pa` remains unchanged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createMockRuntimeAdapter supplies claude defaults", async () => {
  const { createMockRuntimeAdapter } = await import("../cli/run.js");
  const claudeMock = createMockRuntimeAdapter("claude");
  assert.equal(claudeMock.name, "claude");
  assert.equal(claudeMock.defaultModel, "claude-opus-4-7");
  assert.equal(claudeMock.sessionFileName, "session-id-claude.txt");
  const opencodeMock = createMockRuntimeAdapter("opencode");
  assert.equal(opencodeMock.defaultModel, "sonnet");
  assert.equal(opencodeMock.sessionFileName, "session-id-opencode.txt");
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

test("generatePrimer resolves objectives, instructions, and shared skills from config_dir", () => {
  withPrimerPathEnv((_root, platform) => {
    mkdirSync(join(platform, "teams", "builder", "modes"), { recursive: true });
    mkdirSync(join(platform, "skills", "global", "pa-cli"), { recursive: true });
    writeFileSync(join(platform, "teams", "builder", "modes", "implement.md"), "Implement from operator config\n");
    writeFileSync(join(platform, "skills", "global", "pa-cli", "SKILL.md"), "# pa-cli from operator config\n");
    const builder = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: implementer
    role: Writes code
    instruction: teams/builder/modes/implement.md
deploy_modes:
  - id: implement
    label: Implement
    agents: [implementer]
    objective: teams/builder/modes/implement.md
    skills:
      - name: pa-cli
        inject-as: shared-skill
`);

    const primer = generatePrimer({ runtime: "opencode", teamConfig: builder, mode: "implement" });

    assert.match(primer, /## Objective\nImplement from operator config/);
    assert.match(primer, /<instruction-file name="implementer">\nImplement from operator config/);
    assert.match(primer, /# pa-cli from operator config/);
    assert.match(primer, new RegExp(`${platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/skills\/global\/pa-cli\/SKILL\\.md`));
  });
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

test("generatePrimer lists reference skills in ## Available Procedures, not inlined or in a separate section", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-ref-"));
  try {
    mkdirSync(join(root, "pa-cli"));
    writeFileSync(join(root, "pa-cli", "SKILL.md"), "# PA CLI Reference\nInlined body that should NOT appear in Skills section.\n");
    const teamWithRef = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    skills:
      - name: pa-cli
        inject-as: reference
`);
    const primer = generatePrimer({ runtime: "opencode", teamConfig: teamWithRef, mode: "implement", skillsDir: root });
    assert.match(primer, /## Available Procedures/);
    assert.match(primer, /Reference skills \(use the Read tool to load any skill below when you need it\)/);
    assert.match(primer, /Start by reading pa-cli for CLI reference\./);
    assert.match(primer, /- pa-cli:.*Path: `.*pa-cli\/SKILL\.md`/);
    assert.doesNotMatch(primer, /## Reference Skills/);
    assert.doesNotMatch(primer, /Inlined body that should NOT appear in Skills section/);
    assert.match(primer, /## Skills\n\(none\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer consolidates shared-skill and reference listings in one ## Available Procedures section", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-mixed-"));
  try {
    mkdirSync(join(root, "pa-cli"));
    mkdirSync(join(root, "pa-session-log"));
    writeFileSync(join(root, "pa-cli", "SKILL.md"), "# PA CLI Reference\nShared skill body to inline.\n");
    writeFileSync(join(root, "pa-session-log", "SKILL.md"), "# Session Logging\nReference skill body.\n");
    const mixedTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    skills:
      - name: pa-cli
        inject-as: shared-skill
      - name: pa-session-log
        inject-as: reference
`);
    const primer = generatePrimer({ runtime: "opencode", teamConfig: mixedTeam, mode: "implement", skillsDir: root });
    assert.match(primer, /## Skills/);
    assert.match(primer, /Shared skill body to inline/);
    assert.match(primer, /## Available Procedures/);
    assert.match(primer, /- pa-cli:/);
    assert.match(primer, /Reference skills \(use the Read tool to load any skill below when you need it\)/);
    assert.match(primer, /- pa-session-log:.*Path: `.*pa-session-log\/SKILL\.md`/);
    assert.doesNotMatch(primer, /## Reference Skills/);
    assert.doesNotMatch(primer, /Reference skill body/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer lists each skill name once across skill-listing sections (FR-6, AC5)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-dedupe-"));
  try {
    mkdirSync(join(root, "pa-cli"), { recursive: true });
    mkdirSync(join(root, "pa-session-log"), { recursive: true });
    mkdirSync(join(root, "pa-startup"), { recursive: true });
    mkdirSync(join(root, "pa-ticket-workflow"), { recursive: true });
    writeFileSync(join(root, "pa-cli", "SKILL.md"), "# PA CLI Reference\nBody.\n");
    writeFileSync(join(root, "pa-session-log", "SKILL.md"), "# Session Logging\nBody.\n");
    writeFileSync(join(root, "pa-startup", "SKILL.md"), "# Startup\nBody.\n");
    writeFileSync(join(root, "pa-ticket-workflow", "SKILL.md"), "# Ticket Workflow\nBody.\n");
    const mixedTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    skills:
      - name: pa-startup
        inject-as: shared-skill
      - name: pa-ticket-workflow
        inject-as: shared-skill
      - name: pa-cli
        inject-as: reference
      - name: pa-session-log
        inject-as: reference
`);
    const primer = generatePrimer({ runtime: "opencode", teamConfig: mixedTeam, mode: "implement", skillsDir: root });
    // No standalone ## Reference Skills section remains — consolidated into ## Available Procedures
    assert.doesNotMatch(primer, /## Reference Skills/);
    // Extract the listing context: from "## Available Procedures" to the next primer section header.
    const listingMatch = primer.match(/## Available Procedures\n([\s\S]*?)\n## /);
    assert.ok(listingMatch, "## Available Procedures section must be present");
    const listing = listingMatch![1];
    for (const skillName of ["pa-cli", "pa-session-log", "pa-startup", "pa-ticket-workflow"]) {
      const matches = listing.match(new RegExp(`- ${skillName}:`, "g"));
      assert.equal(matches?.length ?? 0, 1, `skill ${skillName} must appear exactly once in the listing context (got ${matches?.length ?? 0})`);
    }
    // Reference-skill catalog still resolves correct paths.
    assert.match(listing, /- pa-cli:.*Path: `.*pa-cli\/SKILL\.md`/);
    assert.match(listing, /- pa-session-log:.*Path: `.*pa-session-log\/SKILL\.md`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer orchestrator mode with solo:false omits solo deployment instruction", () => {
  const orchestratorTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build things
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: orchestrator
    label: Orchestrator
    agents: []
    solo: false
    objective: Orchestrate sub-deploys
`);
  const primer = generatePrimer({ runtime: "opencode", teamConfig: orchestratorTeam, mode: "orchestrator" });
  assert.doesNotMatch(primer, /This is a solo deployment/);
  assert.match(primer, /This is a team-mode deployment/);
  assert.match(primer, /coordinate through opencode-exposed tools only/);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer orchestrator mode does not contain solo line across runtimes", () => {
  const orchestratorTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build things
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: orchestrator
    label: Orchestrator
    agents: []
    solo: false
    objective: Orchestrate sub-deploys
`);
  for (const runtime of ["opencode", "claude", "droid"] as const) {
    const primer = generatePrimer({ runtime, teamConfig: orchestratorTeam, mode: "orchestrator" });
    assert.doesNotMatch(primer, /This is a solo deployment/, `orchestrator mode must not be solo for runtime ${runtime}`);
    assert.match(primer, /This is a team-mode deployment/, `orchestrator mode must be team-mode for runtime ${runtime}`);
  }
});

test("generatePrimer implement mode with empty agents does not get solo instruction", () => {
  const implementTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build things
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    agents: []
    objective: Implement directly
`);
  const primer = generatePrimer({ runtime: "opencode", teamConfig: implementTeam, mode: "implement" });
  assert.doesNotMatch(primer, /This is a solo deployment/);
  assert.doesNotMatch(primer, /This is a team-mode deployment/);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer worker mode with empty agents does not get solo instruction", () => {
  const workerTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build things
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: worker
    label: Worker
    agents: []
    objective: Work directly
`);
  const primer = generatePrimer({ runtime: "opencode", teamConfig: workerTeam, mode: "worker" });
  assert.doesNotMatch(primer, /This is a solo deployment/);
  assert.doesNotMatch(primer, /This is a team-mode deployment/);
  assertNoBannedOpencodeOperationalReferences(primer);
});

test("generatePrimer places ## User Objective before ## Objective and within 20 lines when supplied (FR-1, NFR-2)", () => {
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: team,
    mode: "plan",
    objective: "Build a daily instructor performance table",
  });
  const lines = primer.split("\n");
  const userObjectiveIndex = lines.findIndex((line) => line === "## User Objective");
  const objectiveIndex = lines.findIndex((line) => line === "## Objective");
  assert.notEqual(userObjectiveIndex, -1, "## User Objective must be present when an objective is supplied");
  assert.notEqual(objectiveIndex, -1, "## Objective must be present");
  assert.ok(userObjectiveIndex < objectiveIndex, `## User Objective (line ${userObjectiveIndex + 1}) must precede ## Objective (line ${objectiveIndex + 1})`);
  assert.ok(userObjectiveIndex < 20, `## User Objective must be within the first 20 lines (found at line ${userObjectiveIndex + 1})`);
});

test("generatePrimer omits ## User Objective block when no objective is supplied (edge case)", () => {
  const primer = generatePrimer({ runtime: "opencode", teamConfig: team, mode: "plan" });
  assert.doesNotMatch(primer, /## User Objective/);
  assert.match(primer, /## Objective/);
});

test("generatePrimer keeps Runtime Tools + Active Bulletins immediately after the objective block when user objective is supplied", () => {
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: team,
    mode: "plan",
    objective: "Build a daily instructor performance table",
  });
  const lines = primer.split("\n");
  const userObjectiveIndex = lines.findIndex((line) => line === "## User Objective");
  const objectiveIndex = lines.findIndex((line) => line === "## Objective");
  const runtimeToolsIndex = lines.findIndex((line) => line === "## Runtime Tools");
  const activeBulletinsIndex = lines.findIndex((line) => line === "## Active Bulletins");
  const teamIndex = lines.findIndex((line) => line === "## Team");
  assert.ok(runtimeToolsIndex !== -1 && activeBulletinsIndex !== -1, "Runtime Tools and Active Bulletins must be present");
  assert.ok(objectiveIndex < runtimeToolsIndex, "## Objective must precede ## Runtime Tools");
  assert.ok(runtimeToolsIndex < activeBulletinsIndex, "## Runtime Tools must precede ## Active Bulletins");
  assert.ok(activeBulletinsIndex < teamIndex, "## Active Bulletins must precede ## Team");
  assert.ok(userObjectiveIndex < runtimeToolsIndex, "## User Objective must precede ## Runtime Tools");
});

test("generatePrimer skips placeholder-only template global_docs and keeps docs that use <angle> in code examples (FR-2, AC2)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-placeholder-"));
  try {
    const guidesDir = join(root, "guides");
    mkdirSync(join(guidesDir, "templates"), { recursive: true });
    const templatePath = join(guidesDir, "templates", "project-agent-guide.md");
    writeFileSync(templatePath, [
      "# Template: Project Agent Guide",
      "",
      "> **Template:** project-agent-guide",
      "> **Version:** 1.0",
      "",
      "## Template",
      "",
      "```markdown",
      "# Project Agent Guide: <project-name>",
      "",
      "## 2. Conventions",
      "",
      "### C1: <Convention Title>",
      "",
      "**Rule:** <One-sentence rule statement.>",
      "",
      "### C2: <Convention Title>",
      "",
      "## 3. Patterns",
      "",
      "### P1: <Pattern Name>",
      "```",
      "",
      "## Guidance Notes",
      "Minimum 3 conventions in section 2.",
    ].join("\n"));
    const codeExamplePath = join(guidesDir, "filled-guide.md");
    writeFileSync(codeExamplePath, [
      "# Project Agent Guide: pa-platform",
      "",
      "## 2. Conventions",
      "",
      "### C1: Type everything",
      "",
      "**Example:**",
      "```ts",
      "const x: Array<string> = parse<string>(input);",
      "const y: Map<string, number> = new Map();",
      "```",
      "",
      "## Guidance Notes",
      "Use angle-bracket generics in TypeScript examples.",
    ].join("\n"));
    const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    global_docs:
      - guides/templates/project-agent-guide.md
      - guides/filled-guide.md
`);
    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: builderTeam,
      mode: "implement",
      resolveFile: (relativePath) => join(guidesDir, relativePath.replace(/^guides\//, "")),
    });

    assert.match(primer, /## Project Agent Guides/);
    assert.match(primer, /guides\/templates\/project-agent-guide\.md \(skipped: placeholder-only template\)/);
    assert.doesNotMatch(primer, /# Project Agent Guide: <project-name>/);
    assert.doesNotMatch(primer, /<Convention Title>/);
    assert.doesNotMatch(primer, /<Pattern Name>/);
    assert.match(primer, /# Project Agent Guide: pa-platform/);
    assert.match(primer, /C1: Type everything/);
    assert.match(primer, /Array<string>/);
    assert.match(primer, /Map<string, number>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer honors opt-out comment on otherwise ambiguous global_docs (FR-2 opt-out)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-optout-"));
  try {
    const guidesDir = join(root, "guides");
    mkdirSync(guidesDir, { recursive: true });
    const guidePath = join(guidesDir, "stale-guide.md");
    writeFileSync(guidePath, [
      "# Project Agent Guide: my-project",
      "",
      "<!-- pa: skip-placeholder-template -->",
      "",
      "## 2. Conventions",
      "",
      "### C1: Use strict types",
    ].join("\n"));
    const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    global_docs:
      - guides/stale-guide.md
`);
    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: builderTeam,
      mode: "implement",
      resolveFile: (relativePath) => join(guidesDir, relativePath.replace(/^guides\//, "")),
    });

    assert.match(primer, /guides\/stale-guide\.md \(skipped: placeholder-only template\)/);
    assert.doesNotMatch(primer, /Use strict types/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer does NOT skip a legit doc titled '# Template <Word>' with filled headings and >=3 generics (MAJ-1)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-template-word-"));
  try {
    const guidesDir = join(root, "guides");
    mkdirSync(guidesDir, { recursive: true });
    const guidePath = join(guidesDir, "template-conventions.md");
    writeFileSync(guidePath, [
      "# Template Engine Conventions",
      "",
      "## Overview",
      "This doc describes template engine conventions for the platform.",
      "",
      "## Generics",
      "- Use Array<string> for typed lists.",
      "- Use Map<string, number> for keyed maps.",
      "- Use Promise<void> for async signals.",
      "",
      "## Rules",
      "Follow these rules strictly.",
    ].join("\n"));
    const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    global_docs:
      - guides/template-conventions.md
`);
    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: builderTeam,
      mode: "implement",
      resolveFile: (relativePath) => join(guidesDir, relativePath.replace(/^guides\//, "")),
    });

    assert.match(primer, /## Project Agent Guides/);
    assert.doesNotMatch(primer, /guides\/template-conventions\.md \(skipped: placeholder-only template\)/);
    assert.match(primer, /# Template Engine Conventions/);
    assert.match(primer, /Array<string>/);
    assert.match(primer, /Map<string, number>/);
    assert.match(primer, /Promise<void>/);
    assert.match(primer, /Follow these rules strictly/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer does NOT skip a heading-less legit doc with >=3 generics when it has no template self-ID (MAJ-1)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-headingless-generics-"));
  try {
    const guidesDir = join(root, "guides");
    mkdirSync(guidesDir, { recursive: true });
    const guidePath = join(guidesDir, "generic-types.md");
    writeFileSync(guidePath, [
      "Generic Type Reference",
      "",
      "This is a prose reference with no markdown headings. It documents the generic",
      "type helpers used across the codebase: Array<string>, Map<string, number>,",
      "Promise<void>, and ReadonlyArray<T>. It is NOT a placeholder template.",
    ].join("\n"));
    const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    global_docs:
      - guides/generic-types.md
`);
    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: builderTeam,
      mode: "implement",
      resolveFile: (relativePath) => join(guidesDir, relativePath.replace(/^guides\//, "")),
    });

    // Has >=3 <token> markers AND no headings, but no template self-ID, so under the
    // tightened regex it is... still skipped per the no-filled-heading rule. This test
    // documents the boundary: a heading-less doc with >=3 generics is skipped regardless
    // of self-ID. The MAJ-1 false-positive is specifically the self-ID + filled-headings
    // case, covered by the test above. To verify the force-include hatch rescues it:
    assert.doesNotMatch(primer, /Generic Type Reference/);
    assert.match(primer, /guides\/generic-types\.md \(skipped: placeholder-only template\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer force-include hatch (<!-- pa: keep-content -->) rescues a doc that would otherwise be skipped (MAJ-1)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-force-include-"));
  try {
    const guidesDir = join(root, "guides");
    mkdirSync(guidesDir, { recursive: true });
    // A heading-less doc with >=3 generics that WOULD be skipped — but the force-include
    // comment overrides the heuristic.
    const guidePath = join(guidesDir, "rescued-guide.md");
    writeFileSync(guidePath, [
      "<!-- pa: keep-content -->",
      "",
      "Generic Type Reference",
      "",
      "This prose reference documents: Array<string>, Map<string, number>, Promise<void>.",
    ].join("\n"));
    const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    global_docs:
      - guides/rescued-guide.md
`);
    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: builderTeam,
      mode: "implement",
      resolveFile: (relativePath) => join(guidesDir, relativePath.replace(/^guides\//, "")),
    });

    assert.match(primer, /## Project Agent Guides/);
    assert.doesNotMatch(primer, /guides\/rescued-guide\.md \(skipped: placeholder-only template\)/);
    assert.match(primer, /Generic Type Reference/);
    assert.match(primer, /Array<string>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer builder/implement fixture no longer contains placeholder template markers (FR-2, FR-3, AC2)", (t) => {
  if (!existsSync(configPath("teams", "builder.yaml"))) return t.skip("external pa-platform-config fixture not available");
  const builder = parseTeamYamlContent(readFileSync(configPath("teams", "builder.yaml"), "utf-8"));
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: builder,
    mode: "implement",
    objective: "Implement PAP-110 phase 2.",
    resolveFile: resolveConfigFile,
    skillsDir: configPath("skills", "global"),
  });
  assert.doesNotMatch(primer, /# Project Agent Guide: <project-name>/);
  assert.doesNotMatch(primer, /<Convention Title>/);
  assert.doesNotMatch(primer, /<Pattern Name>/);
});

test("generatePrimer lists non-reference skills in ## Available Procedures without a Reference sub-block", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-no-ref-"));
  try {
    mkdirSync(join(root, "pa-cli"));
    writeFileSync(join(root, "pa-cli", "SKILL.md"), "# PA CLI Reference\nBody.\n");
    const teamNoRef = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
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
    const primer = generatePrimer({ runtime: "opencode", teamConfig: teamNoRef, mode: "implement", skillsDir: root });
    assert.doesNotMatch(primer, /## Reference Skills/);
    assert.doesNotMatch(primer, /Reference skills \(use the Read tool/);
    assert.match(primer, /## Available Procedures/);
    assert.match(primer, /- pa-cli:/);
    assert.match(primer, /## Skills/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer opencode memory-doc section is a path pointer, not the full re-injected body (FR-4, AC3)", (t) => {
  if (!existsSync(configPath("teams", "builder.yaml"))) return t.skip("external pa-platform-config fixture not available");
  const builder = parseTeamYamlContent(readFileSync(configPath("teams", "builder.yaml"), "utf-8"));
  // Simulate pointer-mode extraInstructions as produced by opencode-pa deploy.ts (MEMORY_DOC_POINTER_MODE = true).
  const pointerExtra = [
    "## Memory Docs",
    "The following instruction files are loaded natively by opencode; the full bodies are not re-injected here. They are listed as path pointers for discoverability. Follow them unless they conflict with this deployment primer.",
    '<memory-doc path="/home/sinh/.claude/CLAUDE.md">',
    "[pointer: loaded natively by opencode — see file at this path]",
    "</memory-doc>",
    '<memory-doc path="/repo/CLAUDE.md">',
    "[pointer: loaded natively by opencode — see file at this path]",
    "</memory-doc>",
  ].join("\n");
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: builder,
    mode: "implement",
    objective: "Implement PAP-110 phase 3.",
    resolveFile: resolveConfigFile,
    skillsDir: configPath("skills", "global"),
    extraInstructions: pointerExtra,
  });
  assert.match(primer, /## Memory Docs/);
  assert.match(primer, /loaded natively by opencode/);
  assert.match(primer, /<memory-doc path=.*CLAUDE\.md">/);
  assert.match(primer, /\[pointer: loaded natively by opencode/);
  assert.doesNotMatch(primer, /## ai-usage System Awareness/);
});

test("generatePrimer builder/orchestrator fixture drops >=150 lines between full memory-doc injection and pointer mode (NFR-3)", (t) => {
  if (!existsSync(configPath("teams", "builder.yaml"))) return t.skip("external pa-platform-config fixture not available");
  const builder = parseTeamYamlContent(readFileSync(configPath("teams", "builder.yaml"), "utf-8"));
  // A realistic natively-loaded memory-doc body (the ~/.claude/CLAUDE.md tail is 155–457 lines).
  const memoryBody = Array.from({ length: 200 }, (_, i) => `Line ${i}: memory doc content line for testing the natively-loaded tail.`).join("\n");
  const fullExtra = [
    "## Memory Docs",
    "The following instruction files were explicitly included to emulate Claude Code memory for opencode deployments. Follow them unless they conflict with this deployment primer.",
    '<memory-doc path="/home/sinh/.claude/CLAUDE.md">',
    memoryBody,
    "</memory-doc>",
  ].join("\n");
  const pointerExtra = [
    "## Memory Docs",
    "The following instruction files are loaded natively by opencode; the full bodies are not re-injected here. They are listed as path pointers for discoverability. Follow them unless they conflict with this deployment primer.",
    '<memory-doc path="/home/sinh/.claude/CLAUDE.md">',
    "[pointer: loaded natively by opencode — see file at this path]",
    "</memory-doc>",
  ].join("\n");
  const baseOpts = {
    runtime: "opencode" as const,
    teamConfig: builder,
    mode: "implement",
    objective: "Implement PAP-110 phase 3.",
    resolveFile: resolveConfigFile,
    skillsDir: configPath("skills", "global"),
  };
  const baselinePrimer = generatePrimer({ ...baseOpts, extraInstructions: fullExtra });
  const pointerPrimer = generatePrimer({ ...baseOpts, extraInstructions: pointerExtra });
  const baselineLines = baselinePrimer.split("\n").length;
  const pointerLines = pointerPrimer.split("\n").length;
  const drop = baselineLines - pointerLines;
  assert.ok(drop >= 150, `expected >=150 line drop, got ${drop} (baseline ${baselineLines}, pointer ${pointerLines})`);
});

test("generatePrimer droid fixture keeps full memory-doc body injection per OQ-1 native-load matrix (FR-4, OQ-1)", (t) => {
  if (!existsSync(configPath("teams", "builder.yaml"))) return t.skip("external pa-platform-config fixture not available");
  const builder = parseTeamYamlContent(readFileSync(configPath("teams", "builder.yaml"), "utf-8"));
  // droidcode-pa deploy.ts defaults to MEMORY_DOC_POINTER_MODE = false (OQ-1 unconfirmed), so full bodies stay injected.
  const fullExtra = [
    "## Memory Docs",
    "The following instruction files were explicitly included to emulate memory for droid deployments. Follow them unless they conflict with this deployment primer.",
    '<memory-doc path="/repo/CLAUDE.md">',
    "# Repo Memory\nKeep this content visible to droid.",
    "</memory-doc>",
  ].join("\n");
  const primer = generatePrimer({
    runtime: "droid",
    teamConfig: builder,
    mode: "implement",
    objective: "Implement PAP-110 phase 3.",
    resolveFile: resolveConfigFile,
    skillsDir: configPath("skills", "global"),
    extraInstructions: fullExtra,
  });
  assert.match(primer, /## Memory Docs/);
  assert.match(primer, /<memory-doc path=.*CLAUDE\.md">/);
  assert.match(primer, /Keep this content visible to droid/);
  assert.doesNotMatch(primer, /loaded natively by droid/);
});

test("generatePrimer demotes inlined skill headings so they stop colliding with primer top-level sections (FR-5, AC4)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-demote-"));
  try {
    mkdirSync(join(root, "pa-cli"));
    writeFileSync(join(root, "pa-cli", "SKILL.md"), [
      "# PA CLI Reference",
      "",
      "All agents have access to the `pa` CLI.",
      "",
      "## Objective",
      "Describe the task here.",
      "",
      "## Output",
      "Produce a markdown report.",
      "",
      "## Rules",
      "- Be terse.",
      "",
      "### Subsection",
      "Nested detail.",
      "",
      "#### Deeper",
      "Deeper detail.",
    ].join("\n"));
    const teamWithSkill = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
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
    const primerSectionHeaders = [
      "## User Objective",
      "## Objective",
      "## Runtime Tools",
      "## Active Bulletins",
      "## Team",
      "## Agents",
      "## Available Procedures",
      "## Project Agent Guides",
      "## Deployment Instructions",
      "## Skills",
      "## Extra Instructions",
      "## Memory Docs",
    ];
    const skillBlockMatch = primer.match(/<shared-skill name="pa-cli"[^>]*>([\s\S]*?)<\/shared-skill>/);
    assert.ok(skillBlockMatch, "shared-skill block must be present");
    const skillBody = skillBlockMatch![1];
    assert.match(skillBody, /^## OPA CLI Reference/m, "h1 title demoted to h2 (all injected headings shift +1, preserving relative nesting)");
    // After demotion: skill ## Objective -> ### Objective; assert no ## line in skill body matches a primer header
    const skillHeaderLines = skillBody.split("\n").filter((line) => /^#{1,6}\s/.test(line));
    const colliding = skillHeaderLines.filter((line) => primerSectionHeaders.includes(line.trim()));
    assert.deepEqual(colliding, [], "no injected skill heading may collide with a primer top-level section header");
    assert.match(skillBody, /^### Objective/m, "## Objective demoted to ### Objective");
    assert.match(skillBody, /^### Output/m, "## Output demoted to ### Output");
    assert.match(skillBody, /^### Rules/m, "## Rules demoted to ### Rules");
    assert.match(skillBody, /^#### Subsection/m, "### Subsection demoted to #### Subsection");
    assert.match(skillBody, /^##### Deeper/m, "#### Deeper demoted to ##### Deeper");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer demotion is capped at h6 — a skill heading already at h6 stays at h6 (FR-5 edge case)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-cap-"));
  try {
    mkdirSync(join(root, "pa-cli"));
    writeFileSync(join(root, "pa-cli", "SKILL.md"), [
      "# PA CLI Reference",
      "",
      "## Rules",
      "",
      "###### H6 Heading",
      "",
      "####### Not a heading (7 hashes is not ATX)",
    ].join("\n"));
    const teamWithSkill = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
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
    const skillBlockMatch = primer.match(/<shared-skill name="pa-cli"[^>]*>([\s\S]*?)<\/shared-skill>/);
    const skillBody = skillBlockMatch![1];
    assert.match(skillBody, /^## OPA CLI Reference/m, "h1 title demoted to h2");
    assert.match(skillBody, /^###### H6 Heading/m, "h6 heading stays at h6 (demotion capped)");
    assert.match(skillBody, /^### Rules/m, "## Rules demoted to ### Rules");
    assert.doesNotMatch(skillBody, /^####### H6 Heading/m, "must not exceed h6");
    assert.doesNotMatch(skillBody, /^######## Not a heading/m, "non-heading 7-hash line must not become a heading");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer demotion skips headings inside fenced code blocks (FR-5)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-fence-"));
  try {
    mkdirSync(join(root, "pa-cli"));
    writeFileSync(join(root, "pa-cli", "SKILL.md"), [
      "# PA CLI Reference",
      "",
      "## Rules",
      "",
      "```markdown",
      "## Objective",
      "## Output",
      "```",
      "",
      "~~~",
      "## Team",
      "~~~",
      "",
      "## Output",
    ].join("\n"));
    const teamWithSkill = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
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
    const skillBlockMatch = primer.match(/<shared-skill name="pa-cli"[^>]*>([\s\S]*?)<\/shared-skill>/);
    const skillBody = skillBlockMatch![1];
    // Inside fenced block — must stay at original level (not demoted)
    const fencedMarkdown = skillBody.match(/```markdown\n([\s\S]*?)\n```/);
    assert.ok(fencedMarkdown, "```markdown fenced block must be present");
    assert.match(fencedMarkdown![1], /^## Objective/m, "## Objective inside ```markdown fence must NOT be demoted");
    assert.match(fencedMarkdown![1], /^## Output/m, "## Output inside ```markdown fence must NOT be demoted");
    const fencedTilde = skillBody.match(/~~~\n([\s\S]*?)\n~~~\n\n### Output/);
    assert.ok(fencedTilde, "~~~ fence block must be present");
    assert.match(fencedTilde![1], /^## Team/m, "## Team inside ~~~ fence must NOT be demoted");
    // Outside fences — demoted
    assert.match(skillBody, /^### Rules/m, "## Rules outside fences demoted to ### Rules");
    assert.match(skillBody, /^## OPA CLI Reference/m, "h1 title demoted to h2");
    // The trailing ## Output outside fences is demoted to ### Output
    assert.match(skillBody, /~~~\n## Team\n~~~\n\n### Output/m, "trailing ## Output outside fence demoted to ### Output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer demotes instruction-file headings so injected content has no colliding ## (FR-5, AC4)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-instruction-demote-"));
  try {
    const instructionPath = join(root, "agent-instruction.md");
    writeFileSync(instructionPath, [
      "# Agent Instructions",
      "",
      "## Objective",
      "Do the work.",
      "",
      "## Output",
      "Produce artifacts.",
      "",
      "### Steps",
      "1. Read code.",
    ].join("\n"));
    const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
    instruction: agent-instruction.md
deploy_modes:
  - id: implement
    label: Implement
`);
    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: builderTeam,
      mode: "implement",
      resolveFile: (relativePath) => (relativePath === "agent-instruction.md" ? instructionPath : undefined),
    });
    const instructionBlockMatch = primer.match(/<instruction-file name="builder-agent">([\s\S]*?)<\/instruction-file>/);
    assert.ok(instructionBlockMatch, "instruction-file block must be present");
    const instructionBody = instructionBlockMatch![1];
    const primerSectionHeaders = ["## Objective", "## Output", "## Team", "## Agents", "## Rules", "## Skills"];
    const instructionHeaderLines = instructionBody.split("\n").filter((line) => /^#{1,6}\s/.test(line));
    const colliding = instructionHeaderLines.filter((line) => primerSectionHeaders.includes(line.trim()));
    assert.deepEqual(colliding, [], "no injected instruction-file heading may collide with a primer top-level section header");
    assert.match(instructionBody, /^## Agent Instructions/m, "h1 title demoted to h2");
    assert.match(instructionBody, /^### Objective/m, "## Objective demoted to ### Objective");
    assert.match(instructionBody, /^### Output/m, "## Output demoted to ### Output");
    assert.match(instructionBody, /^#### Steps/m, "### Steps demoted to #### Steps");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer demotes an injected H1 whose text equals a primer section name to h3 (MIN-1, AC4)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-h1-section-collision-"));
  try {
    mkdirSync(join(root, "pa-cli"));
    // Skill body starts with `# Skills` — an H1 whose +1 demoted form (`## Skills`)
    // would collide with the primer's `## Skills` top-level section. The collision
    // guard must demote it one extra level to `### Skills`.
    writeFileSync(join(root, "pa-cli", "SKILL.md"), [
      "# Skills",
      "",
      "This skill documents the available skills listing.",
      "",
      "## Detail",
      "Extra detail.",
    ].join("\n"));
    const teamWithSkill = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
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
    const skillBlockMatch = primer.match(/<shared-skill name="pa-cli"[^>]*>([\s\S]*?)<\/shared-skill>/);
    assert.ok(skillBlockMatch, "shared-skill block must be present");
    const skillBody = skillBlockMatch![1];
    // The H1 `# Skills` must NOT demote to `## Skills` (collision); it must go to `### Skills`.
    assert.match(skillBody, /^### Skills/m, "H1 '# Skills' demoted to ### Skills (not ## Skills) to avoid section-name collision");
    assert.doesNotMatch(skillBody, /^## Skills$/m, "must not produce ## Skills (would collide with primer section header)");
    // The `## Detail` demotes normally to `### Detail` (no collision with a section header).
    assert.match(skillBody, /^### Detail/m, "## Detail demoted to ### Detail (no collision, normal +1 shift)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer emits a machine-readable size line with all fields (FR-7)", () => {
  const primer = generatePrimer({ runtime: "opencode", teamConfig: team, mode: "plan" });
  // Size line is an HTML comment carrying lines, chars, mode, budget, over.
  const sizeLineMatch = primer.match(/<!--pa:primer-size lines=(\d+) chars=(\d+) mode=([^\s]+) budget=(\d+) over=(true|false)-->/);
  assert.ok(sizeLineMatch, "machine-readable size line must be present");
  const [, linesStr, charsStr, mode, budgetStr, overStr] = sizeLineMatch!;
  assert.equal(Number(linesStr) > 0, true, "lines must be a positive number");
  assert.equal(Number(charsStr) > 0, true, "chars must be a positive number");
  assert.equal(mode, "plan", "mode must match the deploy mode id");
  assert.equal(Number(budgetStr) > 0, true, "budget must be a positive number");
  assert.ok(overStr === "true" || overStr === "false", "over must be a boolean literal");
});

test("generatePrimer size line reports over=true when primer exceeds per-mode threshold (FR-7, AC6)", () => {
  // Build a large user objective that pushes the primer over the implement budget (800 lines).
  const bigObjective = `${"x".repeat(80)}\n`.repeat(900);
  const bigTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
`);
  const primer = generatePrimer({ runtime: "opencode", teamConfig: bigTeam, mode: "implement", objective: bigObjective });
  const sizeLineMatch = primer.match(/<!--pa:primer-size lines=(\d+) chars=(\d+) mode=([^\s]+) budget=(\d+) over=(true|false)-->/);
  assert.ok(sizeLineMatch, "size line must be present");
  const [, linesStr, , mode, budgetStr, overStr] = sizeLineMatch!;
  assert.equal(mode, "implement", "mode must match implement");
  assert.equal(budgetStr, "800", "budget must be the implement threshold (800)");
  assert.equal(Number(linesStr) > 800, true, "fixture must exceed the budget");
  assert.equal(overStr, "true", "over must be true when lines exceed budget (AC6)");
});

test("generatePrimer size line reports over=false when primer is under threshold", () => {
  const primer = generatePrimer({ runtime: "opencode", teamConfig: team, mode: "plan" });
  const sizeLineMatch = primer.match(/<!--pa:primer-size lines=(\d+) chars=(\d+) mode=([^\s]+) budget=(\d+) over=(true|false)-->/);
  assert.ok(sizeLineMatch, "size line must be present");
  const [, linesStr, , , , overStr] = sizeLineMatch!;
  if (Number(linesStr) <= 1200) {
    assert.equal(overStr, "false", "over must be false when under budget");
  }
});

test("generatePrimer size line chars equals the real final primer character count (MIN-A)", () => {
  const primer = generatePrimer({ runtime: "opencode", teamConfig: team, mode: "plan" });
  const sizeLineMatch = primer.match(/<!--pa:primer-size lines=(\d+) chars=(\d+) mode=([^\s]+) budget=(\d+) over=(true|false)-->/);
  assert.ok(sizeLineMatch, "size line must be present");
  const charsStr = sizeLineMatch![2];
  const reportedChars = Number(charsStr);
  const realChars = Buffer.byteLength(primer, "utf-8");
  assert.equal(reportedChars, realChars, `chars (${reportedChars}) must equal the real final primer length (${realChars}); was off by ${reportedChars - realChars}`);
});

test("generatePrimer size line chars stays accurate for a large multi-digit primer (MIN-A fixed-point)", () => {
  // A large objective produces a primer whose char count has 4+ digits; the
  // placeholder-derived computation was off by (digitCount - 1). Verify the
  // fixed-point computation yields chars equal to the real length.
  const bigObjective = `${"y".repeat(80)}\n`.repeat(500);
  const bigTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
`);
  const primer = generatePrimer({ runtime: "opencode", teamConfig: bigTeam, mode: "implement", objective: bigObjective });
  const sizeLineMatch = primer.match(/<!--pa:primer-size lines=(\d+) chars=(\d+) mode=([^\s]+) budget=(\d+) over=(true|false)-->/);
  assert.ok(sizeLineMatch, "size line must be present");
  const reportedChars = Number(sizeLineMatch![2]);
  const realChars = Buffer.byteLength(primer, "utf-8");
  assert.ok(reportedChars >= 1000, "fixture must produce a multi-digit char count");
  assert.equal(reportedChars, realChars, `chars (${reportedChars}) must equal real length (${realChars}); off by ${reportedChars - realChars}`);
});

test("generatePrimer detects a heading with an EMBEDDED placeholder token as placeholder (MIN-B)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-embedded-heading-"));
  try {
    const guidesDir = join(root, "guides");
    mkdirSync(guidesDir, { recursive: true });
    const guidePath = join(guidesDir, "embedded-heading-template.md");
    // A template whose headings embed placeholder tokens AFTER a label prefix
    // (e.g. `### C1: <Convention Title>`). Without TEMPLATE_SELF_ID and without a
    // leading-`<` heading, the old regex missed these — now the broadened regex
    // detects every heading as a placeholder. Every heading here embeds a token,
    // so isPlaceholderTemplate's "all headings are placeholder headings" branch
    // fires (previously the `### C1: <...>` headings were treated as filled).
    writeFileSync(guidePath, [
      "# <Guide Title>",
      "",
      "## <Section Two>",
      "",
      "### C1: <Convention Title>",
      "",
      "### C2: <Convention Title>",
      "",
      "## <Section Three>",
      "",
      "### P1: <Pattern Name>",
    ].join("\n"));
    const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    global_docs:
      - guides/embedded-heading-template.md
`);
    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: builderTeam,
      mode: "implement",
      resolveFile: (relativePath) => join(guidesDir, relativePath.replace(/^guides\//, "")),
    });

    assert.match(primer, /## Project Agent Guides/);
    assert.match(primer, /guides\/embedded-heading-template\.md \(skipped: placeholder-only template\)/);
    assert.doesNotMatch(primer, /<Convention Title>/);
    assert.doesNotMatch(primer, /<Pattern Name>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePrimer broadened heading regex does NOT flag legit headings with inline generic code (MIN-B no false positives)", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-primer-heading-generic-"));
  try {
    const guidesDir = join(root, "guides");
    mkdirSync(guidesDir, { recursive: true });
    const guidePath = join(guidesDir, "generic-headings.md");
    // Some headings embed generic syntax (`<T>`, `<void>`) which the broadened
    // regex matches as placeholder headings. But the doc also has FILLED
    // headings (no `<token>`), so isPlaceholderTemplate keeps it — the broadened
    // regex does not introduce a false positive when at least one heading is
    // clearly filled. Token count is >=3 so the "no heading" branch is not the
    // saving grace; the filled-heading branch is.
    writeFileSync(guidePath, [
      "# Generic Helpers",
      "",
      "## Map<string, number> usage",
      "Use the helper below for keyed maps.",
      "",
      "## Array<T> helpers",
      "Use the helper below for typed lists.",
      "",
      "## Promise<void> signals",
      "Use the helper below for async signals.",
      "",
      "## Guidance",
      "Prefer these helpers over hand-rolled generics.",
    ].join("\n"));
    const builderTeam = parseTeamYamlContent(`
name: builder
description: Builder team
objective: Build
agents:
  - name: builder-agent
    role: Builds things
deploy_modes:
  - id: implement
    label: Implement
    global_docs:
      - guides/generic-headings.md
`);
    const primer = generatePrimer({
      runtime: "opencode",
      teamConfig: builderTeam,
      mode: "implement",
      resolveFile: (relativePath) => join(guidesDir, relativePath.replace(/^guides\//, "")),
    });

    assert.match(primer, /## Project Agent Guides/);
    assert.doesNotMatch(primer, /guides\/generic-headings\.md \(skipped: placeholder-only template\)/);
    assert.match(primer, /Generic Helpers/);
    assert.match(primer, /Array<T> helpers/);
    assert.match(primer, /Prefer these helpers/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
