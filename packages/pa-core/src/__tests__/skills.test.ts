import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSkillRegistryReport } from "../index.js";

test("buildSkillRegistryReport inventories skills and validates metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-skills-"));
  try {
    const skillsDir = join(root, "skills", "global");
    const teamsDir = join(root, "teams");
    mkdirSync(join(skillsDir, "pa-cli"), { recursive: true });
    mkdirSync(join(skillsDir, "broken-skill"), { recursive: true });
    mkdirSync(teamsDir, { recursive: true });

    writeFileSync(join(skillsDir, "pa-cli", "SKILL.md"), [
      "---",
      "name: pa-cli",
      "description: CLI reference",
      "pa-tier: 2",
      "pa-inject-as: shared-skill",
      "platforms: [pa-platform]",
      "runtimes: [opencode]",
      "---",
      "# OPA CLI",
    ].join("\n"));

    writeFileSync(join(skillsDir, "broken-skill", "SKILL.md"), [
      "---",
      "name: broken-skill",
      "platforms: [other-platform]",
      "runtimes: [claude]",
      "---",
      "run `opencode run` directly",
    ].join("\n"));

    writeFileSync(join(teamsDir, "builder.yaml"), [
      "name: builder",
      "description: builder",
      "objective: Build",
      "agents:",
      "  - name: team-manager",
      "    role: lead",
      "deploy_modes:",
      "  - id: implement",
      "    label: Implement",
      "    skills:",
      "      - name: pa-cli",
      "        inject-as: shared-skill",
      "      - name: missing-shared",
      "        inject-as: shared-skill",
    ].join("\n"));

    const report = buildSkillRegistryReport({ skillsDir, teamsDir, platformHomeDir: root });
    assert.equal(report.hermesDecisionMatrix.length >= 6, true);
    assert.equal(report.openCodeVisibility.commandAdapter, "opa");

    const paCli = report.inventory.find((item) => item.name === "pa-cli");
    assert.ok(paCli);
    assert.deepEqual(paCli.injectAs, ["shared-skill"]);
    assert.equal(paCli.validationStatus, "valid");
    assert.equal(paCli.owner, "builder");

    const broken = report.inventory.find((item) => item.name === "broken-skill");
    assert.ok(broken);
    assert.equal(broken.validationStatus, "invalid");
    assert.ok(broken.issues.some((issue) => issue.code === "invalid-metadata"));
    assert.ok(broken.issues.some((issue) => issue.code === "platform-mismatch"));
    assert.ok(broken.issues.some((issue) => issue.code === "runtime-mismatch"));
    assert.ok(broken.issues.some((issue) => issue.code === "opencode-incompatible"));

    assert.ok(report.issues.some((issue) => issue.code === "missing-team-skill-reference" && issue.skillName === "missing-shared"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
