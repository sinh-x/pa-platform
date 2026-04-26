import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { Agent, DeployMode, Hierarchy, HierarchyMember, SkillEntry, TeamConfig } from "./types.js";

// Ported from PA yaml-parser.ts at frozen PA source on 2026-04-26; pa-platform owns future changes.

export function parseTeamYaml(filePath: string): TeamConfig {
  return parseTeamYamlContent(readFileSync(filePath, "utf-8"));
}

export function parseTeamYamlContent(content: string): TeamConfig {
  const raw = (yaml.load(content) as Record<string, unknown> | undefined) ?? {};
  const agents = ((raw["agents"] as Array<Record<string, unknown>> | undefined) ?? []).map<Agent>((agent) => ({
    name: String(agent["name"] ?? ""),
    role: String(agent["role"] ?? ""),
    instruction: agent["instruction"] as string | undefined,
    skill: agent["skill"] as string | undefined,
    model: agent["model"] as Agent["model"],
  }));

  const rawModes = raw["deploy_modes"] as Array<Record<string, unknown>> | undefined;
  const deployModes = rawModes?.map<DeployMode>((mode) => {
    const skills = (mode["skills"] as Array<Record<string, string>> | undefined)?.map<SkillEntry>((skill) => ({
      name: skill["name"],
      "inject-as": skill["inject-as"] as SkillEntry["inject-as"],
    }));
    return {
      id: String(mode["id"] ?? ""),
      label: String(mode["label"] ?? ""),
      phone_visible: mode["phone_visible"] as boolean | undefined,
      objective: mode["objective"] as string | undefined,
      agents: mode["agents"] as string[] | undefined,
      skills,
      mode_type: mode["mode_type"] as DeployMode["mode_type"],
      solo: mode["solo"] as boolean | undefined,
      model: mode["model"] as DeployMode["model"],
      provider: mode["provider"] as DeployMode["provider"],
      timeout: mode["timeout"] as number | undefined,
      global_docs: mode["global_docs"] as string[] | undefined,
    };
  });

  const hierarchy = parseHierarchy(raw["hierarchy"] as Record<string, unknown> | undefined);

  return {
    name: String(raw["name"] ?? ""),
    description: String(raw["description"] ?? ""),
    context: raw["context"] as TeamConfig["context"],
    variables: raw["variables"] as Record<string, string> | undefined,
    agents,
    objective: String(raw["objective"] ?? ""),
    model: raw["model"] as TeamConfig["model"],
    default_mode: raw["default_mode"] as string | undefined,
    deploy_modes: deployModes,
    hierarchy,
    timeout: raw["timeout"] as number | undefined,
    global_docs: raw["global_docs"] as string[] | undefined,
    terse_mode: raw["terse_mode"] as boolean | undefined,
  };
}

function parseHierarchy(raw: Record<string, unknown> | undefined): Hierarchy | undefined {
  if (!raw) return undefined;
  const parseMember = (member: Record<string, unknown>): HierarchyMember => ({
    role: member["role"] as string | undefined,
    participates_in: member["participates_in"] as HierarchyMember["participates_in"],
  });
  const teamManager = raw["team-manager"] as Record<string, unknown> | undefined;
  const agents = raw["agents"] as Array<Record<string, unknown>> | undefined;
  return {
    ...(teamManager ? { "team-manager": parseMember(teamManager) } : {}),
    ...(agents ? { agents: agents.map((agent) => ({ name: String(agent["name"] ?? ""), ...parseMember(agent) })) } : {}),
  };
}
