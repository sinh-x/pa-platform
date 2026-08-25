import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { Agent, AutonomyLevel, DeployMode, Hierarchy, HierarchyMember, RuntimeConfigMap, SkillEntry, TeamConfig } from "./types.js";

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
      runtimes: parseRuntimes(mode["runtimes"] as Record<string, unknown> | undefined),
      require_ticket: mode["require_ticket"] as boolean | undefined,
    };
  });

  const hierarchy = parseHierarchy(raw["hierarchy"] as Record<string, unknown> | undefined);
  const runtimes = parseRuntimes(raw["runtimes"] as Record<string, unknown> | undefined);

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
    runtimes,
  };
}

function parseRuntimes(raw: Record<string, unknown> | undefined): RuntimeConfigMap | undefined {
  if (!raw) return undefined;
  const result: RuntimeConfigMap = {};
  for (const runtime of ["droid", "opencode", "claude", "pi"] as const) {
    const block = raw[runtime] as Record<string, unknown> | undefined;
    if (!block) continue;
    if (typeof block !== "object" || Array.isArray(block)) throw new Error(`runtimes.${runtime} must be a mapping`);
    if (runtime === "pi") validatePiRuntimeBlock(block);
    result[runtime] = {
      model: block["model"] as string | undefined,
      provider: block["provider"] as string | undefined,
      autonomy: block["autonomy"] as AutonomyLevel | undefined,
      timeout: block["timeout"] as number | undefined,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function validatePiRuntimeBlock(block: Record<string, unknown>): void {
  for (const field of ["provider", "model"] as const) {
    const value = block[field];
    if (value !== undefined && (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value))) {
      throw new Error(`runtimes.pi.${field} must be a non-empty Pi identifier`);
    }
  }
  const autonomy = block["autonomy"];
  if (autonomy !== undefined && autonomy !== "low" && autonomy !== "medium" && autonomy !== "high") {
    throw new Error("runtimes.pi.autonomy must be low, medium, or high");
  }
  const timeout = block["timeout"];
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0)) {
    throw new Error("runtimes.pi.timeout must be a positive integer");
  }
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
