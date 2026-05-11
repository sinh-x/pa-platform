import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { getTeamModel, listAgentTeamWorkspaces, listTeamConfigs, loadTeamConfig, parseTeamYamlContent, validateTeamSkillReferences } from "../index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const configRoot = resolve(repoRoot, "../pa-platform-config");

function withConfigEnv(fn: (root: string, platform: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-core-teams-config-"));
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

test("teams module lists and loads team configs", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-teams-"));
  try {
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir, { recursive: true });
    writeFileSync(join(teamsDir, "builder.yaml"), [
      "name: builder",
      "description: Builder team",
      "model: sonnet",
      "objective: Build things",
      "agents:",
      "  - name: implementer",
      "    role: Writes code",
      "deploy_modes:",
      "  - id: default",
      "    label: Default",
      "  - id: hidden",
      "    label: Hidden",
      "    phone_visible: false",
    ].join("\n"));

    const configs = listTeamConfigs(teamsDir);
    assert.equal(configs.length, 1);
    assert.equal(configs[0]?.name, "builder");
    assert.equal(configs[0]?.deploy_modes.length, 1);
    assert.equal(loadTeamConfig("builder", teamsDir).agents[0]?.name, "implementer");
    assert.equal(getTeamModel("builder", teamsDir), "sonnet");
    assert.equal(getTeamModel("missing", teamsDir), "-");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("team discovery and validation use config_dir as the normal operator base", () => {
  withConfigEnv((_root, platform) => {
    const teamsDir = join(platform, "teams");
    mkdirSync(join(platform, "skills", "global", "pa-cli"), { recursive: true });
    mkdirSync(join(platform, "skills", "requirements"), { recursive: true });
    mkdirSync(join(platform, "teams", "builder", "modes"), { recursive: true });
    writeFileSync(join(platform, "skills", "global", "pa-cli", "SKILL.md"), "# pa-cli\n");
    writeFileSync(join(platform, "skills", "requirements", "review.md"), "# review\n");
    writeFileSync(join(platform, "teams", "builder", "modes", "implement.md"), "Implement\n");
    writeFileSync(join(teamsDir, "builder.yaml"), [
      "name: builder",
      "description: Builder team",
      "objective: Build things",
      "agents:",
      "  - name: implementer",
      "    role: Writes code",
      "    instruction: teams/builder/modes/implement.md",
      "deploy_modes:",
      "  - id: implement",
      "    label: Implement",
      "    objective: teams/builder/modes/implement.md",
      "    global_docs:",
      "      - skills/requirements/review.md",
      "    skills:",
      "      - name: pa-cli",
      "        inject-as: shared-skill",
    ].join("\n"));

    const configs = listTeamConfigs();
    assert.equal(configs.length, 1);
    assert.equal(configs[0]?.filePath, join(teamsDir, "builder.yaml"));
    assert.equal(loadTeamConfig("builder").agents[0]?.instruction, "teams/builder/modes/implement.md");
    assert.deepEqual(validateTeamSkillReferences(), []);
  });
});

test("validation reports objective, instruction, global doc, and shared skill paths", () => {
  withConfigEnv((_root, platform) => {
    const teamsDir = join(platform, "teams");
    mkdirSync(teamsDir, { recursive: true });
    writeFileSync(join(teamsDir, "builder.yaml"), [
      "name: builder",
      "description: Builder team",
      "objective: Build things",
      "agents:",
      "  - name: implementer",
      "    role: Writes code",
      "    instruction: teams/builder/missing-instruction.md",
      "deploy_modes:",
      "  - id: implement",
      "    label: Implement",
      "    objective: teams/builder/missing-objective.md",
      "    global_docs:",
      "      - skills/requirements/missing-review.md",
      "    skills:",
      "      - name: missing-shared-skill",
      "        inject-as: shared-skill",
    ].join("\n"));

    const missing = validateTeamSkillReferences();
    assert.deepEqual(missing.map((entry) => entry.kind).sort(), ["global_doc", "instruction", "objective", "shared_skill"]);
    assert.deepEqual(missing.map((entry) => entry.context).sort(), [
      "agent implementer instruction",
      "mode implement global_docs[0]",
      "mode implement objective",
      "mode implement shared skill missing-shared-skill",
    ]);
    assert.ok(missing.some((entry) => entry.resolvedPath === join(platform, "skills", "global", "missing-shared-skill", "SKILL.md")));
    assert.ok(missing.every((entry) => entry.teamConfigPath === join(teamsDir, "builder.yaml")));
  });
});

test("builder team config has no Anthropic deploy modes", () => {
  const builder = parseTeamYamlContent(readFileSync(join(configRoot, "teams", "builder.yaml"), "utf-8"));
  const modeIds = builder.deploy_modes?.map((mode) => mode.id) ?? [];

  assert.ok(modeIds.length > 0);
  assert.equal(builder.default_mode, "implement");
  assert.equal(builder.deploy_modes?.find((mode) => mode.id === "implement")?.provider, "openai");
  assert.equal(builder.deploy_modes?.find((mode) => mode.id === "implement")?.model, "gpt-5.3-codex");
  assert.deepEqual(modeIds.filter((id) => id.includes("anthropic")), []);
  for (const removedMode of ["housekeeping-anthropic", "implement-anthropic", "worker-anthropic", "orchestrator-anthropic", "routine-anthropic"]) {
    assert.equal(modeIds.includes(removedMode), false);
  }
});

test("teams module lists agent team workspace folder counts", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-workspaces-"));
  try {
    const workspace = join(root, "agent-teams", "builder");
    mkdirSync(join(workspace, "inbox"), { recursive: true });
    mkdirSync(join(workspace, "ongoing"), { recursive: true });
    mkdirSync(join(workspace, "waiting-for-response"), { recursive: true });
    writeFileSync(join(workspace, "inbox", "a.md"), "a");
    writeFileSync(join(workspace, "waiting-for-response", "b.md"), "b");

    const workspaces = listAgentTeamWorkspaces(join(root, "agent-teams"));
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.name, "builder");
    assert.equal(workspaces[0]?.inbox_count, 1);
    assert.equal(workspaces[0]?.waiting_for_response_count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateTeamSkillReferences reports missing path with mode and agent context", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-team-skill-validation-"));
  try {
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir, { recursive: true });
    mkdirSync(join(root, "skills", "global", "pa-cli"), { recursive: true });
    writeFileSync(join(root, "skills", "global", "pa-cli", "SKILL.md"), "# pa-cli\n");
    writeFileSync(join(root, "skills", "existing-agent.md"), "# agent\n");

    writeFileSync(join(teamsDir, "builder.yaml"), [
      "name: builder",
      "description: Builder team",
      "objective: Build things",
      "agents:",
      "  - name: implementer",
      "    role: Writes code",
      "    instruction: skills/missing-agent-instruction.md",
      "    skill: skills/existing-agent.md",
      "deploy_modes:",
      "  - id: implement",
      "    label: Implement",
      "    objective: skills/missing-mode-objective.md",
      "    skills:",
      "      - name: pa-cli",
      "        inject-as: shared-skill",
    ].join("\n"));

    const missing = validateTeamSkillReferences(teamsDir, root);
    assert.equal(missing.length, 2);
    assert.deepEqual(missing.map((entry) => entry.reference).sort(), ["skills/missing-agent-instruction.md", "skills/missing-mode-objective.md"]);
    assert.deepEqual(missing.map((entry) => entry.context).sort(), ["agent implementer instruction", "mode implement objective"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateTeamSkillReferences resolves production-style paths and reports missing references", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-prod-skill-validation-"));
  const originalHome = process.env["PA_PLATFORM_HOME"];
  const originalTeams = process.env["PA_PLATFORM_TEAMS"];
  try {
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir, { recursive: true });
    mkdirSync(join(root, "skills", "global", "pa-cli"), { recursive: true });
    writeFileSync(join(root, "skills", "global", "pa-cli", "SKILL.md"), "# pa-cli\n");

    writeFileSync(join(teamsDir, "builder.yaml"), [
      "name: builder",
      "description: Builder team",
      "objective: skills/missing-team-objective.md",
      "agents:",
      "  - name: implementer",
      "    role: Writes code",
      "deploy_modes:",
      "  - id: implement",
      "    label: Implement",
      "    objective: skills/missing-mode-objective.md",
      "    skills:",
      "      - name: pa-cli",
      "        inject-as: shared-skill",
    ].join("\n"));

    process.env["PA_PLATFORM_HOME"] = root;
    process.env["PA_PLATFORM_TEAMS"] = teamsDir;

    const missing = validateTeamSkillReferences();
    assert.equal(missing.length, 2);
    assert.deepEqual(missing.map((entry) => entry.context).sort(), ["mode implement objective", "team objective"]);
    assert.deepEqual(missing.map((entry) => entry.resolvedPath).sort(), [
      resolve(root, "skills", "missing-mode-objective.md"),
      resolve(root, "skills", "missing-team-objective.md"),
    ]);
    assert.deepEqual(missing.map((entry) => entry.teamConfigPath), [join(teamsDir, "builder.yaml"), join(teamsDir, "builder.yaml")]);
  } finally {
    if (originalHome === undefined) delete process.env["PA_PLATFORM_HOME"];
    else process.env["PA_PLATFORM_HOME"] = originalHome;
    if (originalTeams === undefined) delete process.env["PA_PLATFORM_TEAMS"];
    else process.env["PA_PLATFORM_TEAMS"] = originalTeams;
    rmSync(root, { recursive: true, force: true });
  }
});

test("external operator team skill references resolve", () => {
  const missing = validateTeamSkillReferences(join(configRoot, "teams"), configRoot, join(configRoot, "skills", "global"));
  assert.deepEqual(missing, []);
});
