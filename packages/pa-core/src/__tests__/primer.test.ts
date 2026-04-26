import test from "node:test";
import assert from "node:assert/strict";
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
