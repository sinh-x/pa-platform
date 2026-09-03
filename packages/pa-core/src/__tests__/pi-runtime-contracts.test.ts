import assert from "node:assert/strict";
import test from "node:test";
import { createAgentApiApp, generatePrimer, modelMatchesProvider, parseTeamYamlContent, resolveRuntimeConfig, validateDeployRequestFields } from "../index.js";

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

test("explicit malformed provider/model values fail at their exact YAML paths", () => {
  const malformed = ["\"\"", "\"   \"", "null"];
  for (const value of malformed) {
    for (const suffix of ["", "    model: openai/gpt-5\n"]) {
      assert.throws(
        () => parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: invalid\n    label: Invalid\n    provider: ${value}\n${suffix}`),
        (error: unknown) => error instanceof Error && error.message === "deploy_modes[0].provider must be a non-empty string",
      );
    }
    for (const suffix of ["", "    provider: openai\n"]) {
      assert.throws(
        () => parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: invalid\n    label: Invalid\n    model: ${value}\n${suffix}`),
        (error: unknown) => error instanceof Error && error.message === "deploy_modes[0].model must be a non-empty string",
      );
    }
  }
});

test("valid explicit provider/model values are trimmed", () => {
  const config = parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: valid\n    label: Valid\n    provider: \" openai \"\n    model: \" openai/gpt-5 \"\n`);
  assert.equal(config.deploy_modes?.[0]?.provider, "openai");
  assert.equal(config.deploy_modes?.[0]?.model, "openai/gpt-5");
});

test("retired deploy-mode fields are not exposed by parsed team types", () => {
  const retiredKey = ["repository", "access"].join("_");
  const config = parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: inspect\n    label: Inspect\n    ${retiredKey}: read-only\n`);
  const mode = config.deploy_modes?.[0];
  assert.ok(mode);
  assert.equal(Object.prototype.hasOwnProperty.call(mode, retiredKey), false);
});

test("project guides are parsed as repository-keyed path lists", () => {
  const config = parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: implement\n    label: Implement\n    project_guides:\n      pa-platform:\n        - docs/pa-platform.md\n      avodah:\n        - docs/avodah.md\n`);
  assert.deepEqual(config.deploy_modes?.[0]?.project_guides, {
    "pa-platform": ["docs/pa-platform.md"],
    avodah: ["docs/avodah.md"],
  });
  assert.throws(
    () => parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: invalid\n    label: Invalid\n    project_guides:\n      pa-platform: docs/pa-platform.md\n`),
    /deploy_modes\[0\]\.project_guides\.pa-platform must be an array of non-empty paths/,
  );
});

test("qualified models must match the selected provider namespace", () => {
  assert.equal(modelMatchesProvider("gpt-5", ["openai"]), true);
  assert.equal(modelMatchesProvider("openai/gpt-5", ["openai"]), true);
  assert.equal(modelMatchesProvider("deepseek/deepseek-v4-pro", ["openai"]), false);
  assert.equal(modelMatchesProvider("minimax-coding-plan/MiniMax-M2.7", ["minimax-coding-plan"]), true);
});

test("shared runtime resolution returns one frozen effective pair and source", () => {
  const team = parseTeamYamlContent(`${baseConfig}deploy_modes:\n  - id: implement\n    label: Implement\n    provider: mode-provider\n    model: mode-model\n`);
  const mode = team.deploy_modes?.[0];
  const fromMode = resolveRuntimeConfig({ runtime: "pi", request: { team: "builder" }, team, mode });
  assert.deepEqual(fromMode, { provider: "mode-provider", model: "mode-model", source: "mode" });
  assert.ok(Object.isFrozen(fromMode));

  const fromCli = resolveRuntimeConfig({ runtime: "pi", request: { team: "builder", provider: "cli-provider", model: "cli-model" }, team, mode, local: { provider: "default-provider", model: "default-model" } });
  assert.deepEqual(fromCli, { provider: "cli-provider", model: "cli-model", source: "cli" });

  const providerOnly = resolveRuntimeConfig({ runtime: "opencode", request: { team: "builder", provider: "cli-provider" }, team, mode });
  assert.deepEqual(providerOnly, { provider: "cli-provider", model: "mode-model", source: "cli" });

  assert.throws(
    () => resolveRuntimeConfig({ runtime: "pi", request: { team: "builder", provider: "cli-provider" }, team, mode, requireCompleteCliPair: true }),
    /--model is required when --provider is supplied/,
  );
  assert.throws(
    () => resolveRuntimeConfig({ runtime: "pi", request: { team: "builder", model: "cli-model" }, team, mode, requireCompleteCliPair: true }),
    /--provider is required when --model is supplied/,
  );

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

test("PPA deploy help documents normalized Sol defaults and supported legacy flags", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await import("../cli/core-command.js").then(({ runCoreCommand }) => runCoreCommand(["deploy", "--help"], { binaryName: "ppa", io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } }));
  assert.equal(code, 0);
  const help = stdout.join("\n");
  assert.match(help, /openai.*openai-codex/);
  assert.match(help, /gpt-5\.6-sol/);
  assert.match(help, /--team-model.*PAP-147/);
  assert.match(help, /--agent-model.*PAP-148/);
  assert.doesNotMatch(help, /ollama-cloud/);
  assert.deepEqual(stderr, []);
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
