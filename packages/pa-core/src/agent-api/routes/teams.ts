import { Hono } from "hono";
import { listRepos } from "../../repos.js";
import { listAgentTeamWorkspaces, listTeamConfigs } from "../../teams/index.js";

export function teamsRoutes(): Hono {
  const app = new Hono();
  app.get("/api/teams", (c) => c.json({ teams: listAgentTeamWorkspaces().map((team) => ({ name: team.name, path: team.path, folders: team.folders, inbox_count: team.inbox_count, ongoing_count: team.ongoing_count, wfr_count: team.waiting_for_response_count, waiting_for_response_count: team.waiting_for_response_count })) }));
  app.get("/api/pa-teams", (c) => c.json({ teams: listTeamConfigs().map(({ filePath: _filePath, ...team }) => team) }));
  app.get("/api/pa-repos", (c) => c.json({ repos: listRepos().map((repo) => ({ name: repo.name, path: repo.path, description: repo.description, prefix: repo.prefix })) }));
  app.get("/api/agent-teams", (c) => c.json({ teams: listAgentTeamWorkspaces().map((team) => ({ name: team.name, inbox_exists: team.folders.includes("inbox"), folders: team.folders, inbox_count: team.inbox_count, ongoing_count: team.ongoing_count, wfr_count: team.waiting_for_response_count, waiting_for_response_count: team.waiting_for_response_count })) }));
  return app;
}
