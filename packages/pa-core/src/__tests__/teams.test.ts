import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { getTeamModel, listAgentTeamWorkspaces, listTeamConfigs, loadTeamConfig, parseTeamYamlContent } from "../index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

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

test("builder team config has no Anthropic deploy modes", () => {
  const builder = parseTeamYamlContent(readFileSync(join(repoRoot, "teams", "builder.yaml"), "utf-8"));
  const modeIds = builder.deploy_modes?.map((mode) => mode.id) ?? [];

  assert.ok(modeIds.length > 0);
  assert.equal(builder.default_mode, "implement");
  assert.equal(builder.deploy_modes?.find((mode) => mode.id === "implement")?.provider, "openai");
  assert.equal(builder.deploy_modes?.find((mode) => mode.id === "implement")?.model, undefined);
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
