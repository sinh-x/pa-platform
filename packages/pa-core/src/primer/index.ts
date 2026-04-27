import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPlatformHomeDir, getSkillsDir } from "../paths.js";
import type { DeployMode, RuntimeName, SkillEntry, TeamConfig } from "../types.js";
import type { ToolReference } from "../runtime-api/types.js";

export interface GeneratePrimerOptions {
  runtime: RuntimeName;
  teamConfig: TeamConfig;
  mode?: string;
  objective?: string;
  resolveFile?: (relativePath: string) => string | undefined;
  templateVars?: Record<string, string>;
  skillsDir?: string;
  extraInstructions?: string;
  toolReference?: ToolReference;
}

export function generatePrimer(options: GeneratePrimerOptions): string {
  const mode = selectMode(options.teamConfig, options.mode);
  const agents = selectAgents(options.teamConfig, mode);
  const skills = collectSkills(options.teamConfig, mode);
  const objective = adaptContentForRuntime(resolveObjective(options, mode), options.runtime);
  const toolReference = adaptContentForRuntime(options.toolReference?.markdown ?? defaultToolReference(options.runtime), options.runtime);
  const extraInstructions = options.extraInstructions ? adaptContentForRuntime(options.extraInstructions, options.runtime) : undefined;

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
    toolReference,
    ``,
    `## Skills`,
    renderSkills(skills, options.skillsDir ?? getSkillsDir(), options.runtime),
    extraInstructions ? `\n## Extra Instructions\n${extraInstructions}` : "",
  ].filter((part) => part !== "").join("\n");
}

function resolveObjective(options: GeneratePrimerOptions, mode: DeployMode | undefined): string {
  const rawObjective = options.objective ?? mode?.objective ?? options.teamConfig.objective;
  if (!mode?.objective || options.objective) return applyTemplateVars(rawObjective, options.templateVars ?? {});

  const resolved = options.resolveFile?.(mode.objective) ?? resolve(getPlatformHomeDir(), mode.objective);
  if (!existsSync(resolved)) return applyTemplateVars(rawObjective, options.templateVars ?? {});
  return applyTemplateVars(readFileSync(resolved, "utf-8"), options.templateVars ?? {});
}

function applyTemplateVars(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
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

function renderSkills(skills: SkillEntry[], skillsDir: string, runtime: RuntimeName): string {
  if (skills.length === 0) return "(none)";
  return skills.map((skill) => {
    const path = resolve(skillsDir, skill.name, "SKILL.md");
    const body = adaptContentForRuntime(existsSync(path) ? readFileSync(path, "utf-8") : `(missing skill: ${path})`, runtime);
    return `<${skill["inject-as"]} name="${skill.name}" path="${path}">\n${body}\n</${skill["inject-as"]}>`;
  }).join("\n\n");
}

const PA_CLI_SUBCOMMANDS = [
  "board",
  "bulletin",
  "daily",
  "deploy",
  "health",
  "idea",
  "registry",
  "remove-timer",
  "report",
  "repos",
  "requirements",
  "schedule",
  "serve",
  "status",
  "teams",
  "ticket",
  "timers",
  "trash",
].join("|");

const PA_CLI_COMMAND_RE = new RegExp(`(^|[\\s\`'"(=:{])pa(?=\\s+(?:${PA_CLI_SUBCOMMANDS})\\b)`, "gm");
const CLAUDECODE_COMMAND_PREFIX_RE = new RegExp(`(^|[\\s\`'"(=:{])(?:unset\\s+CLAUDECODE|CLAUDECODE=(?:"[^"]*"|'[^']*'|\\S+))\\s*(?:&&\\s*)?(?=pa\\s+(?:${PA_CLI_SUBCOMMANDS})\\b)`, "gm");
const CLAUDECODE_PROSE_LINE_RE = /^.*CLAUDECODE.*(?:\n|$)/gm;

function adaptContentForRuntime(content: string, runtime: RuntimeName): string {
  if (runtime !== "opencode") return content;
  return content
    .replace(CLAUDECODE_COMMAND_PREFIX_RE, "$1")
    .replace(PA_CLI_COMMAND_RE, "$1opa")
    .replace(CLAUDECODE_PROSE_LINE_RE, "")
    .replace(/`pa` CLI/g, "`opa` CLI")
    .replace(/\bPA CLI\b/g, "OPA CLI")
    .replace(/\bpa CLI\b/g, "opa CLI")
    .replace(/\bpa commands\b/g, "opa commands")
    .replace(/\bpa command\b/g, "opa command");
}

function defaultToolReference(runtime: RuntimeName): string {
  if (runtime === "opencode") {
    return [
      "Runtime: opencode via `opa`.",
      "Use `opa` for PA platform commands; it invokes the updated pa-core command set and avoids the legacy `pa` binary.",
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
