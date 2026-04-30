import { Hono } from "hono";
import { loadConfig } from "../../config.js";
import { DEFAULT_DEPLOY_TIMEOUT_SECONDS } from "../../deploy/control.js";
import { listRepos } from "../../repos.js";
import { listTeamConfigs } from "../../teams/index.js";

interface DeployRoutingTeam {
  name: string;
  description: string;
  defaultMode: string | null;
  modes: Array<{ id: string; label: string; modeType: string | null; phoneVisible: boolean; provider: string | null; model: string | null; timeout: number | null }>;
}

const OPA_SUPPORTED_PROVIDERS = ["minimax", "openai"] as const;
type OpaSupportedProvider = typeof OPA_SUPPORTED_PROVIDERS[number];

export function deployRoutingRoutes(): Hono {
  const app = new Hono();
  app.get("/api/deploy-routing", (c) => {
    const config = loadConfig();
    const teams: DeployRoutingTeam[] = listTeamConfigs().flatMap((team) => {
      const modes = team.deploy_modes
        .filter((mode) => mode.phone_visible !== false && mode.mode_type !== "interactive")
        .map((mode) => ({ id: mode.id, label: mode.label, modeType: mode.mode_type ?? null, phoneVisible: mode.phone_visible !== false, provider: mode.provider ?? null, model: mode.model ?? null, timeout: mode.timeout ?? null }));
      return modes.length > 0 ? [{ name: team.name, description: team.description, defaultMode: team.default_mode ?? null, modes }] : [];
    });

    const repos = listRepos().map((repo) => ({ name: repo.name, path: repo.path, description: repo.description }));
    return c.json({
      teams,
      repos,
      routing: {
        defaultRuntime: config.defaults?.runtime ?? "opencode",
        defaultAdapter: "opa",
        defaultProvider: config.defaults?.opencode?.provider ?? "openai",
        defaultModel: config.defaults?.opencode?.model ?? "gpt-5.5",
        supportedProviders: OPA_SUPPORTED_PROVIDERS,
        providerDefaults: providerDefaults(config.provider_defaults?.providers),
        modelFields: ["provider", "model", "teamModel", "agentModel"],
        defaultTimeoutSeconds: DEFAULT_DEPLOY_TIMEOUT_SECONDS,
      },
    });
  });
  return app;
}

function providerDefaults(providers: Record<string, unknown> | undefined): Record<OpaSupportedProvider, unknown> {
  return Object.fromEntries(OPA_SUPPORTED_PROVIDERS.map((provider) => [provider, providers?.[provider] ?? null])) as Record<OpaSupportedProvider, unknown>;
}
