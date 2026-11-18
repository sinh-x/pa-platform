import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTeamYamlContent } from "../yaml-parser.js";
import { generatePrimer } from "../primer/index.js";

const staged = parseTeamYamlContent(`name: analyst\nobjective: Ordinary source-only objective.\nagents: []\ndefault_mode: analyze\ndeploy_modes:\n - {id: analyze, label: Analyze}\n - {id: investigate, label: Investigate}\n - {id: research, label: Research}\n`);
for (const runtime of ["pi", "opencode"] as const) for (const mode of ["analyze", "investigate", "research"]) {
  test(`PAP-316 ordinary unselected Analyst ${runtime}/${mode} composes source/report text without native authority`, () => {
    const primer = generatePrimer({ runtime, teamConfig: staged, mode });
    assert.match(primer, /Ordinary source-only objective/);
    assert.match(primer, new RegExp(`Runtime: ${runtime}`)); assert.match(primer, new RegExp(`Mode: ${mode}`));
    assert.doesNotMatch(primer, /Requirements supporting capabilities|Effective native identity|Selected capability IDs/);
  });
}

test("PAP-316 explicit native Analyst composition still requires captured V2 resources", () => {
  assert.throws(() => generatePrimer({ runtime: "pi", teamConfig: staged, mode: "analyze", requirementsDocument: true }), /CAPABILITY_BINDING/);
});
