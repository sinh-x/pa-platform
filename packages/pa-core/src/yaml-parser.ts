import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { Agent, DeployMode, Hierarchy, HierarchyMember, SkillEntry, TeamConfig } from "./types.js";

// Ported from PA yaml-parser.ts at frozen PA source on 2026-04-26; pa-platform owns future changes.

export function parseTeamYaml(filePath: string): TeamConfig {
  return parseTeamYamlContent(readFileSync(filePath, "utf-8"));
}

export function parseTeamYamlContent(content: string): TeamConfig {
  const loaded = yaml.load(content);
  const raw = loaded === undefined ? {} : asRecord(loaded, "team config");
  rejectRemovedRuntimeConfig(raw, "runtimes");
  const agents = ((raw["agents"] as Array<Record<string, unknown>> | undefined) ?? []).map<Agent>((agent) => ({
    name: String(agent["name"] ?? ""),
    role: String(agent["role"] ?? ""),
    instruction: agent["instruction"] as string | undefined,
    skill: agent["skill"] as string | undefined,
    model: agent["model"] as Agent["model"],
  }));

  const rawModes = raw["deploy_modes"] as Array<Record<string, unknown>> | undefined;
  const deployModes = rawModes?.map<DeployMode>((mode, index) => {
    const modeRecord = asRecord(mode, `deploy_modes[${index}]`);
    rejectRemovedRuntimeConfig(modeRecord, `deploy_modes[${index}].runtimes`);
    validateFlatModePair(modeRecord, index);
    const provider = optionalString(modeRecord["provider"]);
    const model = optionalString(modeRecord["model"]);
    const skills = (modeRecord["skills"] as Array<Record<string, string>> | undefined)?.map<SkillEntry>((skill) => ({
      name: skill["name"],
      "inject-as": skill["inject-as"] as SkillEntry["inject-as"],
    }));
    return {
      id: String(modeRecord["id"] ?? ""),
      label: String(modeRecord["label"] ?? ""),
      phone_visible: modeRecord["phone_visible"] as boolean | undefined,
      objective: modeRecord["objective"] as string | undefined,
      agents: modeRecord["agents"] as string[] | undefined,
      skills,
      mode_type: modeRecord["mode_type"] as DeployMode["mode_type"],
      solo: modeRecord["solo"] as boolean | undefined,
      model,
      provider,
      timeout: modeRecord["timeout"] as number | undefined,
      global_docs: modeRecord["global_docs"] as string[] | undefined,
      require_ticket: modeRecord["require_ticket"] as boolean | undefined,
      repository_access: parseRepositoryAccess(modeRecord["repository_access"], index),
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

function rejectRemovedRuntimeConfig(raw: Record<string, unknown>, path: string): void {
  if (Object.prototype.hasOwnProperty.call(raw, "runtimes")) {
    throw new Error(`${path} is no longer supported; configure flat deploy_modes[].provider and deploy_modes[].model instead.`);
  }
}

function validateFlatModePair(mode: Record<string, unknown>, index: number): void {
  const basePath = `deploy_modes[${index}]`;
  const hasProvider = Object.prototype.hasOwnProperty.call(mode, "provider");
  const hasModel = Object.prototype.hasOwnProperty.call(mode, "model");
  const provider = mode["provider"];
  const model = mode["model"];
  if (hasProvider && (typeof provider !== "string" || provider.trim() === "")) throw new Error(`${basePath}.provider must be a non-empty string`);
  if (hasModel && (typeof model !== "string" || model.trim() === "")) throw new Error(`${basePath}.model must be a non-empty string`);
  if (hasProvider !== hasModel) {
    const missingPath = hasProvider ? `${basePath}.model` : `${basePath}.provider`;
    throw new Error(`${missingPath} is required when configuring a deploy mode pair; deploy_modes[].provider and deploy_modes[].model must both be present or both be absent.`);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseRepositoryAccess(value: unknown, index: number): DeployMode["repository_access"] {
  if (value === undefined) return undefined;
  if (value === "read-only" || value === "mutating") return value;
  throw new Error(`deploy_modes[${index}].repository_access must be 'read-only' or 'mutating'`);
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

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be a mapping`);
  return value as Record<string, unknown>;
}
