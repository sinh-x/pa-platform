import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrimer, parseTeamYamlContent } from "../index.js";

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
  assert.match(primer, /Task-style delegation/);
  assert.match(primer, /Do not assume Claude-only operational tools exist/);
  assert.match(primer, /## Active Bulletins/);
  assert.match(primer, /opa bulletin list/);
  assert.match(primer, /## Deployment Instructions/);
  assert.match(primer, /Plan the work/);
  assert.doesNotMatch(primer, /TeamCreate|SendMessage|AskUserQuestion|ScheduleWakeup/);
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
    assert.doesNotMatch(primer, /(^|[\s`'"(=:{])pa\s+(deploy|ticket|registry)\b/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
