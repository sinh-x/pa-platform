import { Hono } from "hono";
import { validateDeployRequestFields, withResolvedDeployTimeout } from "../../deploy/index.js";
import type { CoreExecutionHooks as AgentApiHooks, DeployRequest } from "../../deploy/index.js";
import { loadTeamConfig, validateTeamSkillReferences } from "../../teams/index.js";
import type { SessionManager } from "../ws/session-hub.js";

export function deployControlRoutes(hooks: AgentApiHooks = {}, sessionManager?: SessionManager): Hono {
  const app = new Hono();

  app.post("/api/deploy", async (c) => {
    const parsed = await parseDeployRequest(c.req.json.bind(c.req));
    if ("error" in parsed) return c.json({ error: parsed.error, code: "BAD_REQUEST" }, 400);
    try {
      const controlResponse = resolveControlOnlyResponse(parsed.request);
      if (controlResponse) return c.json(controlResponse, 202);
      const resolved = withResolvedDeployTimeout(parsed.request);
      if ("error" in resolved) return c.json({ error: resolved.error, code: "BAD_REQUEST" }, 400);
      const selectedRuntime = resolved.request.runtime ?? "opencode";
      const deployRequest = { ...resolved.request, background: resolved.request.background ?? true };
       const selectedHooks = hooks.runtimeHooks?.[selectedRuntime];
      if (!selectedHooks) return c.json({ error: `No adapter registered for runtime ${selectedRuntime}`, code: "NOT_IMPLEMENTED" }, 501);
      if (!selectedHooks.deploy) return c.json({ error: `No adapter registered for runtime ${selectedRuntime}`, code: "NOT_IMPLEMENTED" }, 501);
      const result = await selectedHooks.deploy(deployRequest);
      const response = toPhoneDeployResponse({ team: deployRequest.team, mode: deployRequest.mode ?? null, ...result });
      // PAP-131 FR2: register deploy session with SessionManager on success/pending.
      // Best-effort — a missing deploymentId or at-capacity hub must not fail the deploy.
      if (sessionManager && result.deploymentId && result.status !== "failed") {
        const model = deployRequest.teamModel;
         sessionManager.register(result.deploymentId, model, selectedRuntime);
      }
      return c.json(response, 202);
    } catch (error) {
      // PAP-042 AC2 phone contract: always 202 with structured failed JSON — never 500, never throws
      return c.json({ status: "failed", reason: boundedControlDiagnostic(error), team: parsed.request.team, mode: parsed.request.mode ?? null }, 202);
    }
  });

  app.post("/api/self-update", async (c) => {
    if (!hooks.selfUpdate) return c.json({ error: "Self-update execution requires an adapter hook", code: "NOT_IMPLEMENTED" }, 501);
    const result = await hooks.selfUpdate();
    return c.json(result, 202);
  });

  app.get("/api/self-update/status", async (c) => {
    if (!hooks.getSelfUpdateStatus) return c.json({ error: "Self-update status requires an adapter hook", code: "NOT_IMPLEMENTED" }, 501);
    return c.json(await hooks.getSelfUpdateStatus());
  });

  return app;
}

async function parseDeployRequest(readJson: () => Promise<unknown>): Promise<{ request: DeployRequest } | { error: string }> {
  let body: Record<string, unknown>;
  try {
    const parsed = await readJson();
    body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return { error: "Invalid JSON body" };
  }

  return validateDeployRequestFields(body);
}

function resolveControlOnlyResponse(request: DeployRequest): Record<string, unknown> | undefined {
  if (!request.listModes && !request.validate) return undefined;
  const team = loadTeamConfig(request.team);
  if (request.listModes) {
    return {
      team: team.name,
      mode: request.mode ?? null,
      status: "success",
      modes: (team.deploy_modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
    };
  }
  const missingReferences = validateTeamSkillReferences().filter((reference) => reference.team === team.name);
  if (missingReferences.length > 0) {
    return {
      team: team.name,
      mode: request.mode ?? null,
      status: "failed",
      reason: boundedControlDiagnostic(`Team config validation failed: ${missingReferences.length} missing referenced file(s) for ${team.name}.`),
    };
  }
  const modes = team.deploy_modes ?? [];
  const configuredPairs = modes.filter((mode) => mode.provider !== undefined && mode.model !== undefined).length;
  return {
    team: team.name,
    mode: request.mode ?? null,
    status: "success",
    validation: {
      agents: team.agents.length,
      modes: modes.length,
      configuredProviderModelPairs: configuredPairs,
      adapterDefaultProviderModelPairs: modes.length - configuredPairs,
    },
  };
}

function boundedControlDiagnostic(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 2_000 ? value : `${value.slice(0, 1_997)}...`;
}

function toPhoneDeployResponse(response: Record<string, unknown>): Record<string, unknown> {
  const deploymentId = stringValue(response["deploymentId"]) ?? stringValue(response["deployment_id"]) ?? stringValue(response["deploy_id"]);
  const { deploymentId: _deploymentId, deploy_id: _deployId, ...rest } = response;
  return deploymentId ? { ...rest, deployment_id: deploymentId } : rest;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
