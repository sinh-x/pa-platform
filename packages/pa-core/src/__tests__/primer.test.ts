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
  assert.match(primer, /Task tool/);
  assert.match(primer, /Do not assume Claude-only TeamCreate/);
  assert.match(primer, /Plan the work/);
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
