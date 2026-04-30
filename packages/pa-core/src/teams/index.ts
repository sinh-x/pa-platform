import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentTeamsDir, getTeamsDir } from "../paths.js";
import { queryDeploymentStatuses } from "../registry/index.js";
import { parseTeamYaml } from "../yaml-parser.js";
import type { Agent, DeployMode, TeamConfig } from "../types.js";

export interface TeamConfigSummary {
  name: string;
  description: string;
  model?: TeamConfig["model"];
  default_mode?: string;
  timeout?: number;
  agents: Array<Pick<Agent, "name" | "role" | "model">>;
  deploy_modes: Array<Pick<DeployMode, "id" | "label" | "phone_visible" | "mode_type" | "model" | "provider" | "timeout" | "solo" | "agents">>;
  filePath: string;
}

export interface AgentTeamWorkspace {
  name: string;
  path: string;
  folders: string[];
  inbox_count: number;
  ongoing_count: number;
  waiting_for_response_count: number;
}

export interface TeamRuntimeStatus {
  name: string;
  model: string;
  runningDeployments: string[];
}

export function listTeamConfigFiles(teamsDir = getTeamsDir()): string[] {
  if (!existsSync(teamsDir)) return [];
  return readdirSync(teamsDir)
    .filter((name) => name.endsWith(".yaml") && name !== "example.yaml")
    .map((name) => resolve(teamsDir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

export function loadTeamConfig(team: string, teamsDir = getTeamsDir()): TeamConfig {
  const candidates = [resolve(teamsDir, `${team}.yaml`), ...listTeamConfigFiles(teamsDir)];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    const config = parseTeamYaml(filePath);
    if (config.name === team || filePath.endsWith(`/${team}.yaml`)) return config;
  }
  throw new Error(`Team not found: ${team}`);
}

export function listTeamConfigs(teamsDir = getTeamsDir()): TeamConfigSummary[] {
  const seen = new Set<string>();
  const teams: TeamConfigSummary[] = [];
  for (const filePath of listTeamConfigFiles(teamsDir)) {
    try {
      const config = parseTeamYaml(filePath);
      if (!config.name || seen.has(config.name)) continue;
      seen.add(config.name);
      teams.push({
        name: config.name,
        description: config.description ?? "",
        model: config.model,
        default_mode: config.default_mode,
        timeout: config.timeout,
        agents: config.agents.map((agent) => ({ name: agent.name, role: agent.role, model: agent.model })),
        deploy_modes: (config.deploy_modes ?? []).filter((mode) => mode.phone_visible !== false).map((mode) => ({ id: mode.id, label: mode.label, phone_visible: mode.phone_visible, mode_type: mode.mode_type, model: mode.model, provider: mode.provider, timeout: mode.timeout, solo: mode.solo, agents: mode.agents })),
        filePath,
      });
    } catch {
      // skip malformed team YAML
    }
  }
  return teams.sort((a, b) => a.name.localeCompare(b.name));
}

export function listAgentTeamWorkspaces(agentTeamsDir = getAgentTeamsDir()): AgentTeamWorkspace[] {
  if (!existsSync(agentTeamsDir)) return [];
  return readdirSync(agentTeamsDir)
    .filter((name) => !name.startsWith("."))
    .map((name) => workspaceFromDir(agentTeamsDir, name))
    .filter((workspace): workspace is AgentTeamWorkspace => !!workspace)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTeamModel(teamName: string, teamsDir = getTeamsDir()): string {
  try {
    return loadTeamConfig(teamName, teamsDir).model ?? "-";
  } catch {
    return "-";
  }
}

export function getRunningDeploymentsForTeam(teamName: string): string[] {
  return queryDeploymentStatuses()
    .filter((deployment) => deployment.team === teamName && deployment.status === "running" && (!deployment.pid || isProcessAlive(deployment.pid)))
    .map((deployment) => deployment.deploy_id);
}

export function getTeamRuntimeStatus(teamName: string, teamsDir = getTeamsDir()): TeamRuntimeStatus {
  return { name: teamName, model: getTeamModel(teamName, teamsDir), runningDeployments: getRunningDeploymentsForTeam(teamName) };
}

function workspaceFromDir(agentTeamsDir: string, name: string): AgentTeamWorkspace | undefined {
  const path = join(agentTeamsDir, name);
  try {
    if (!statSync(path).isDirectory()) return undefined;
    const folders = readdirSync(path).filter((entry) => statSync(join(path, entry)).isDirectory());
    return { name, path, folders, inbox_count: countFiles(join(path, "inbox")), ongoing_count: countFiles(join(path, "ongoing")), waiting_for_response_count: countFiles(join(path, "waiting-for-response")) };
  } catch {
    return undefined;
  }
}

function countFiles(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return readdirSync(path).filter((entry) => statSync(join(path, entry)).isFile()).length;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
