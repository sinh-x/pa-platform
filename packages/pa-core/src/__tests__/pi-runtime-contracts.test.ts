import assert from "node:assert/strict";
import test from "node:test";
import { createAgentApiApp, generatePrimer, parseTeamYamlContent, resolveRuntimeConfig, validateDeployRequestFields } from "../index.js";

const baseConfig = `name: builder
description: Builder
objective: Build
agents: []
`;

test("team and deploy-mode runtimes are rejected with migration paths", () => {
  assert.throws(() => parseTeamYamlContent(`${baseConfig}runtimes:\n  pi:\n    provider: anthropic\n    model: claude-sonnet\n`), (error: unknown) => {
    assert.match(String(error), /runtimes is no longer supported/);
    assert.match(String(error), /deploy_modes\[\]\.provider/);
    return true;
  });
  assert.throws(() => parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: implement\n    label: Implement\n    runtimes:\n      pi:\n        provider: openai\n        model: gpt-5\n`), /deploy_modes\[0\]\.runtimes.*deploy_modes\[\]\.provider/);
});

test("deploy mode provider/model must be both present or both absent", () => {
  assert.throws(() => parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: provider-only\n    label: Provider only\n    provider: openai\n`), /deploy_modes\[0\]\.model.*both be present or both be absent/);
  assert.throws(() => parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: model-only\n    label: Model only\n    model: gpt-5\n`), /deploy_modes\[0\]\.provider.*both be present or both be absent/);
  const config = parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: default\n    label: Default\n`);
  assert.equal(config.deploy_modes?.[0]?.provider, undefined);
  assert.equal(config.deploy_modes?.[0]?.model, undefined);
});

test("shared runtime resolution returns one frozen effective pair and source", () => {
  const team = parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: implement\n    label: Implement\n    provider: mode-provider\n    model: mode-model\n`);
  const mode = team.deploy_modes?.[0];
  const fromMode = resolveRuntimeConfig({ runtime: "pi", request: { team: "builder" }, team, mode });
  assert.deepEqual(fromMode, { provider: "mode-provider", model: "mode-model", source: "mode" });
  assert.ok(Object.isFrozen(fromMode));

  const fromCli = resolveRuntimeConfig({ runtime: "pi", request: { team: "builder", provider: "cli-provider" }, team, mode, local: { provider: "default-provider", model: "default-model" } });
  assert.deepEqual(fromCli, { provider: "cli-provider", model: "mode-model", source: "cli" });

  const fromDefault = resolveRuntimeConfig({ runtime: "pi", request: { team: "builder" }, team, local: { provider: "default-provider", model: "default-model" } });
  assert.deepEqual(fromDefault, { provider: "default-provider", model: "default-model", source: "default" });
});

test("deploy CLI preserves team-model alias warning and rejects agent-model with PAP-148 guidance", () => {
  const alias = validateDeployRequestFields({ team: "builder", teamModel: "legacy-model" });
  assert.equal("error" in alias, false);
  if (!("error" in alias)) {
    assert.equal(alias.request.teamModel, "legacy-model");
    assert.match(alias.warnings?.join("\n") ?? "", /--team-model.*--model.*PAP-147/);
  }
  assert.deepEqual(validateDeployRequestFields({ team: "builder", agentModel: "agent-model" }), {
    error: "--agent-model is not supported; per-agent model overrides are tracked by PAP-148. Use --model for the deployment model.",
  });
});

test("deploy request runtime accepts Pi and rejects unsupported runtimes", () => {
  const pi = validateDeployRequestFields({ team: "builder", runtime: "pi" });
  assert.equal("error" in pi, false);
  if (!("error" in pi)) assert.equal(pi.request.runtime, "pi");
  assert.deepEqual(validateDeployRequestFields({ team: "builder", runtime: "claude" }), { error: "runtime must be opencode or pi" });
});

test("REST deploy defaults to OpenCode and dispatches explicit Pi without spawning on invalid input", async () => {
  let opencodeCalls = 0;
  let piCalls = 0;
  const api = createAgentApiApp({
    hooks: {
      deploy: () => { opencodeCalls += 1; return { status: "pending", deploymentId: "d-open-1" }; },
      runtimeHooks: {
        pi: { deploy: () => { piCalls += 1; return { status: "pending", deploymentId: "d-pi-1" }; } },
      },
    },
  });

  const omitted = await api.app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder" }) });
  const pi = await api.app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder", runtime: "pi" }) });
  const invalid = await api.app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder", runtime: "claude" }) });

  assert.equal(omitted.status, 202);
  assert.equal(pi.status, 202);
  assert.equal(invalid.status, 400);
  assert.equal(opencodeCalls, 1);
  assert.equal(piCalls, 1);
  api.cleanup();
});

test("Pi primers identify ppa and preserve runtime labels", () => {
  const primer = generatePrimer({
    runtime: "pi",
    teamConfig: { name: "builder", description: "Builder", objective: "Build", agents: [] },
  });
  assert.match(primer, /Runtime: pi/);
  assert.match(primer, /ppa bulletin list/);
  assert.match(primer, /Runtime: Pi via `ppa`/);
});
