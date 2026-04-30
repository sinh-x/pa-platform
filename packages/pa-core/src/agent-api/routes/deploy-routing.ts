import { Hono } from "hono";
import { loadConfig } from "../../config.js";
import { listRepos } from "../../repos.js";
import { listTeamConfigs } from "../../teams/index.js";

interface DeployRoutingTeam {
  name: string;
  description: string;
  default_provider: string | null;
  default_model: string | null;
  modes: Array<{ id: string; label: string; modeType: string | null }>;
}

export function deployRoutingRoutes(): Hono {
  const app = new Hono();
  app.get("/api/deploy-routing", (c) => {
    const config = loadConfig();
    const teams: DeployRoutingTeam[] = listTeamConfigs().flatMap((team) => {
      const defaultProvider = config.defaults?.opencode?.provider ?? config.provider_defaults?.default_provider ?? null;
      const defaultModel = config.defaults?.opencode?.model ?? config.provider_defaults?.default_model ?? team.model ?? null;
      const modes = team.deploy_modes
        .filter((mode) => mode.phone_visible !== false && mode.mode_type !== "interactive")
        .map((mode) => ({ id: mode.id, label: mode.label, modeType: mode.mode_type ?? null }));
      return modes.length > 0 ? [{ name: team.name, description: team.description, default_provider: defaultProvider, default_model: defaultModel, modes }] : [];
    });

    const repos = listRepos().map((repo) => ({ name: repo.name, path: repo.path, description: repo.description }));
    return c.json({ teams, repos });
  });
  return app;
}
