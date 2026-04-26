import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSkillsDir } from "../paths.js";
import type { DeployMode, RuntimeName, SkillEntry, TeamConfig } from "../types.js";
import type { ToolReference } from "../runtime-api/types.js";

export interface GeneratePrimerOptions {
  runtime: RuntimeName;
  teamConfig: TeamConfig;
  mode?: string;
  objective?: string;
  skillsDir?: string;
  extraInstructions?: string;
  toolReference?: ToolReference;
}

export function generatePrimer(options: GeneratePrimerOptions): string {
  const mode = selectMode(options.teamConfig, options.mode);
  const agents = selectAgents(options.teamConfig, mode);
  const skills = collectSkills(options.teamConfig, mode);
  const objective = options.objective ?? mode?.objective ?? options.teamConfig.objective;

  return [
    `# PA Deployment Primer`,
    ``,
    `Runtime: ${options.runtime}`,
    `Team: ${options.teamConfig.name}`,
    `Mode: ${mode?.id ?? "default"}`,
    ``,
    `## Objective`,
    objective,
    ``,
    `## Team`,
    options.teamConfig.description,
    ``,
    `## Agents`,
    ...agents.map((agent) => `- ${agent.name}: ${agent.role}`),
    ``,
    `## Runtime Tools`,
    options.toolReference?.markdown ?? defaultToolReference(options.runtime),
    ``,
    `## Skills`,
    renderSkills(skills, options.skillsDir ?? getSkillsDir()),
    options.extraInstructions ? `\n## Extra Instructions\n${options.extraInstructions}` : "",
  ].filter((part) => part !== "").join("\n");
}

function selectMode(teamConfig: TeamConfig, requestedMode?: string): DeployMode | undefined {
  const id = requestedMode ?? teamConfig.default_mode;
  return id ? teamConfig.deploy_modes?.find((mode) => mode.id === id) : undefined;
}

function selectAgents(teamConfig: TeamConfig, mode: DeployMode | undefined): TeamConfig["agents"] {
  if (!mode?.agents) return teamConfig.agents;
  const selected = new Set(mode.agents);
  return teamConfig.agents.filter((agent) => selected.has(agent.name));
}

function collectSkills(teamConfig: TeamConfig, mode: DeployMode | undefined): SkillEntry[] {
  const skills: SkillEntry[] = [];
  if (teamConfig.terse_mode) skills.push({ name: "terse-mode", "inject-as": "global-skill" });
  skills.push(...(mode?.skills ?? []));
  return skills;
}

function renderSkills(skills: SkillEntry[], skillsDir: string): string {
  if (skills.length === 0) return "(none)";
  return skills.map((skill) => {
    const path = resolve(skillsDir, skill.name, "SKILL.md");
    const body = existsSync(path) ? readFileSync(path, "utf-8") : `(missing skill: ${path})`;
    return `<${skill["inject-as"]} name="${skill.name}" path="${path}">\n${body}\n</${skill["inject-as"]}>`;
  }).join("\n\n");
}

function defaultToolReference(runtime: RuntimeName): string {
  if (runtime === "opencode") {
    return [
      "Use opencode tools exposed in the current session.",
      "Task tool is available for sub-agent style delegation when configured.",
      "Do not assume Claude-only TeamCreate, SendMessage, Agent, AskUserQuestion, or ScheduleWakeup tools exist.",
    ].join("\n");
  }

  return [
    "Claude Code team deployments may use TeamCreate, SendMessage, Agent, AskUserQuestion, and ScheduleWakeup when provided by the adapter.",
    "Use tool availability from the active session as the source of truth.",
  ].join("\n");
}
