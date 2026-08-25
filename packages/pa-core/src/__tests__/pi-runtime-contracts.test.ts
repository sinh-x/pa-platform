import assert from "node:assert/strict";
import test from "node:test";
import { createAgentApiApp, generatePrimer, parseTeamYamlContent, resolveRuntimeConfig, validateDeployRequestFields } from "../index.js";

test("Pi runtime configuration parses at team and mode scope", () => {
  const team = parseTeamYamlContent(`
name: builder
description: Builder
objective: Build
agents: []
runtimes:
  pi:
    provider: anthropic
    model: claude-sonnet
deploy_modes:
  - id: implement
    label: Implement
    runtimes:
      pi:
        provider: openai
        model: gpt-5
`);

  assert.equal(team.runtimes?.pi?.provider, "anthropic");
  assert.equal(team.runtimes?.pi?.model, "claude-sonnet");
  assert.equal(team.deploy_modes?.[0]?.runtimes?.pi?.provider, "openai");
  assert.equal(team.deploy_modes?.[0]?.runtimes?.pi?.model, "gpt-5");
});

test("deploy request runtime accepts Pi and rejects unsupported runtimes", () => {
  const pi = validateDeployRequestFields({ team: "builder", runtime: "pi" });
  assert.equal("error" in pi, false);
  if (!("error" in pi)) assert.equal(pi.request.runtime, "pi");
  assert.deepEqual(validateDeployRequestFields({ team: "builder", runtime: "claude" }), { error: "runtime must be opencode or pi" });
});

test("Pi runtime resolution uses CLI, mode, team, then Pi-local values", () => {
  const team = parseTeamYamlContent(`
name: builder
description: Builder
objective: Build
agents: []
runtimes:
  pi:
    provider: team-provider
    model: team-model
deploy_modes:
  - id: implement
    label: Implement
    runtimes:
      pi:
        provider: mode-provider
        model: mode-model
`);
  const mode = team.deploy_modes?.[0];
  assert.deepEqual(resolveRuntimeConfig({ runtime: "pi", request: { team: "builder" }, team, mode, local: { provider: "local-provider", model: "local-model" } }), { provider: "mode-provider", model: "mode-model" });
  assert.deepEqual(resolveRuntimeConfig({ runtime: "pi", request: { team: "builder", provider: "cli-provider", teamModel: "cli-model" }, team, mode, local: { provider: "local-provider", model: "local-model" } }), { provider: "cli-provider", model: "cli-model" });
  assert.deepEqual(resolveRuntimeConfig({ runtime: "pi", request: { team: "builder" }, team: { ...team, runtimes: undefined }, local: { provider: "local-provider", model: "local-model" } }), { provider: "local-provider", model: "local-model" });
});

test("invalid Pi runtime configuration fails with an actionable field error", () => {
  assert.throws(() => parseTeamYamlContent(`name: builder\ndescription: Builder\nobjective: Build\nagents: []\nruntimes:\n  pi:\n    model: "bad model"\n`), /runtimes\.pi\.model/);
  assert.throws(() => parseTeamYamlContent(`name: builder\ndescription: Builder\nobjective: Build\nagents: []\nruntimes:\n  pi:\n    timeout: 0\n`), /runtimes\.pi\.timeout/);
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
