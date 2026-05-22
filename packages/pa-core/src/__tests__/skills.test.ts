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
    assert.ok(report.openCodeVisibility.primerSkillSummary.length <= report.openCodeVisibility.primerSummaryBudgetChars);

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

test("buildSkillRegistryReport enforces OpenCode primer skill summary budget", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-skills-budget-"));
  try {
    const skillsDir = join(root, "skills", "global");
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir, { recursive: true });
    for (let i = 0; i < 160; i++) {
      const name = `skill-${String(i).padStart(3, "0")}-very-long-name-for-primer-summary-budget`;
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: budget test\n---\n# ${name}\n`);
    }
    const report = buildSkillRegistryReport({ skillsDir, teamsDir, platformHomeDir: root });
    assert.ok(report.openCodeVisibility.primerSkillSummary.length <= report.openCodeVisibility.primerSummaryBudgetChars);
    assert.match(report.openCodeVisibility.primerSkillSummary, /truncated to 5000 chars/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSkillRegistryReport exposes required_credential_files metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-skills-credentials-valid-"));
  try {
    const skillsDir = join(root, "skills", "global");
    const teamsDir = join(root, "teams");
    mkdirSync(join(skillsDir, "google-workspace"), { recursive: true });
    mkdirSync(teamsDir, { recursive: true });

    writeFileSync(join(skillsDir, "google-workspace", "SKILL.md"), [
      "---",
      "name: google-workspace",
      "description: Google Workspace commands",
      "platforms: [pa-platform]",
      "runtimes: [opencode]",
      "required_credential_files:",
      "  - path: auth/google-workspace/token.json",
      "    description: OAuth token cache",
      "  - path: auth/google-workspace/client-secret.json",
      "    description: OAuth desktop client secret",
      "---",
      "# Google Workspace",
    ].join("\n"));

    const report = buildSkillRegistryReport({ skillsDir, teamsDir, platformHomeDir: root });
    const skill = report.inventory.find((item) => item.name === "google-workspace");

    assert.ok(skill);
    assert.equal(skill.validationStatus, "valid");
    assert.deepEqual(skill.metadata.required_credential_files, [
      { path: "auth/google-workspace/token.json", description: "OAuth token cache" },
      { path: "auth/google-workspace/client-secret.json", description: "OAuth desktop client secret" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSkillRegistryReport validates malformed required_credential_files metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-skills-credentials-invalid-"));
  try {
    const skillsDir = join(root, "skills", "global");
    const teamsDir = join(root, "teams");
    mkdirSync(join(skillsDir, "bad-type"), { recursive: true });
    mkdirSync(join(skillsDir, "missing-path"), { recursive: true });
    mkdirSync(join(skillsDir, "missing-description"), { recursive: true });
    mkdirSync(teamsDir, { recursive: true });

    writeFileSync(join(skillsDir, "bad-type", "SKILL.md"), [
      "---",
      "name: bad-type",
      "description: Invalid metadata type",
      "platforms: [pa-platform]",
      "runtimes: [opencode]",
      "required_credential_files: token.json",
      "---",
      "# Bad Type",
    ].join("\n"));

    writeFileSync(join(skillsDir, "missing-path", "SKILL.md"), [
      "---",
      "name: missing-path",
      "description: Missing path field",
      "platforms: [pa-platform]",
      "runtimes: [opencode]",
      "required_credential_files:",
      "  - description: OAuth token cache",
      "---",
      "# Missing Path",
    ].join("\n"));

    writeFileSync(join(skillsDir, "missing-description", "SKILL.md"), [
      "---",
      "name: missing-description",
      "description: Missing description field",
      "platforms: [pa-platform]",
      "runtimes: [opencode]",
      "required_credential_files:",
      "  - path: auth/google-workspace/token.json",
      "---",
      "# Missing Description",
    ].join("\n"));

    const report = buildSkillRegistryReport({ skillsDir, teamsDir, platformHomeDir: root });
    const badType = report.inventory.find((item) => item.name === "bad-type");
    const missingPath = report.inventory.find((item) => item.name === "missing-path");
    const missingDescription = report.inventory.find((item) => item.name === "missing-description");

    assert.ok(badType);
    assert.equal(badType.validationStatus, "invalid");
    assert.ok(badType.issues.some((issue) => issue.code === "invalid-metadata" && issue.message.includes("must be a list")));

    assert.ok(missingPath);
    assert.equal(missingPath.validationStatus, "invalid");
    assert.ok(missingPath.issues.some((issue) => issue.code === "invalid-metadata" && issue.message.includes("non-empty path")));

    assert.ok(missingDescription);
    assert.equal(missingDescription.validationStatus, "invalid");
    assert.ok(missingDescription.issues.some((issue) => issue.code === "invalid-metadata" && issue.message.includes("non-empty description")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
