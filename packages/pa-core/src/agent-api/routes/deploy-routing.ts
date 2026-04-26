import { Hono } from "hono";
import { listRepos } from "../../repos.js";
import { listTeamConfigFiles } from "../../teams/index.js";
import { parseTeamYaml } from "../../yaml-parser.js";

interface DeployRoutingTeam {
  name: string;
  description: string;
  modes: Array<{ id: string; label: string; modeType: string | null }>;
}

export function deployRoutingRoutes(): Hono {
  const app = new Hono();
  app.get("/api/deploy-routing", (c) => {
    const teams: DeployRoutingTeam[] = [];
    for (const filePath of listTeamConfigFiles()) {
      try {
        const config = parseTeamYaml(filePath);
        const modes = (config.deploy_modes ?? [])
          .filter((mode) => mode.mode_type !== "interactive")
          .map((mode) => ({ id: mode.id, label: mode.label, modeType: mode.mode_type ?? null }));
        if (modes.length > 0) teams.push({ name: config.name, description: config.description ?? "", modes });
      } catch {
        // Skip malformed team YAML to keep the routing UI usable.
      }
    }
    teams.sort((a, b) => a.name.localeCompare(b.name));

    const repos = listRepos().map((repo) => ({ name: repo.name, path: repo.path, description: repo.description }));
    return c.json({ teams, repos });
  });
  return app;
}
