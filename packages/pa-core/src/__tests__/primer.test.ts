import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  assert.match(primer, /Task tool/);
  assert.match(primer, /Do not assume Claude-only TeamCreate/);
  assert.match(primer, /Plan the work/);
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
