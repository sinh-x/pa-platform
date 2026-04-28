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
  const globalDocs = collectGlobalDocs(options.teamConfig, mode);
  const objective = adaptContentForRuntime(resolveConfiguredObjective(options, mode), options.runtime);
  const userObjective = options.objective ? adaptContentForRuntime(applyTemplateVars(options.objective, options.templateVars ?? {}), options.runtime) : undefined;
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
    userObjective ? `
## User Objective
${userObjective}` : "",
    ``,
    `## Team`,
    options.teamConfig.description,
    ``,
    `## Agents`,
    renderAgents(agents, options, options.runtime),
    ``,
    `## Runtime Tools`,
    toolReference,
    ``,
    renderActiveBulletins(options.runtime),
    ``,
    renderAvailableProcedures(skills, globalDocs, options.runtime),
    ``,
    renderDeploymentInstructions(options.teamConfig, mode, options.runtime),
    ``,
    `## Skills`,
    renderSkills(skills, options.skillsDir ?? getSkillsDir(), options.runtime),
    extraInstructions ? `\n## Extra Instructions\n${extraInstructions}` : "",
  ].filter((part) => part !== "").join("\n");
}

function resolveConfiguredObjective(options: GeneratePrimerOptions, mode: DeployMode | undefined): string {
  const rawObjective = mode?.objective ?? options.teamConfig.objective;
  if (!mode?.objective) return applyTemplateVars(rawObjective, options.templateVars ?? {});

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
  // pa-platform does not currently package a terse-mode skill. Do not render a
  // missing operational skill; re-enable only when a canonical source exists.
  skills.push(...(mode?.skills ?? []));
  return skills;
}

function collectGlobalDocs(teamConfig: TeamConfig, mode: DeployMode | undefined): string[] {
  return [...(teamConfig.global_docs ?? []), ...(mode?.global_docs ?? [])];
}

function renderAgents(agents: TeamConfig["agents"], options: GeneratePrimerOptions, runtime: RuntimeName): string {
  return agents.map((agent) => {
    const lines = [`### Agent: ${agent.name}`, `Role: ${agent.role}`];
    if (agent.model) lines.push(`Model: ${agent.model}`);
    if (agent.instruction) {
      const content = resolveInstruction(options, agent.instruction);
      lines.push("", `<instruction-file name="${agent.name}">`, adaptContentForRuntime(content, runtime), `</instruction-file>`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

function resolveInstruction(options: GeneratePrimerOptions, instruction: string): string {
  const resolved = options.resolveFile?.(instruction) ?? resolve(getPlatformHomeDir(), instruction);
  if (!existsSync(resolved)) return `(missing instruction: ${instruction})`;
  return applyTemplateVars(readFileSync(resolved, "utf-8"), options.templateVars ?? {});
}

function renderSkills(skills: SkillEntry[], skillsDir: string, runtime: RuntimeName): string {
  if (skills.length === 0) return "(none)";
  return skills.map((skill) => {
    const path = resolve(skillsDir, skill.name, "SKILL.md");
    const body = adaptContentForRuntime(existsSync(path) ? readFileSync(path, "utf-8") : `(missing skill: ${path})`, runtime);
    return `<${skill["inject-as"]} name="${skill.name}" path="${path}">\n${body}\n</${skill["inject-as"]}>`;
  }).join("\n\n");
}

function renderActiveBulletins(runtime: RuntimeName): string {
  if (runtime !== "opencode") return "";
  return [
    "## Active Bulletins",
    "Before starting work, run `opa bulletin list`.",
    "If any active bulletin blocks this team or all teams, stop immediately and report the blocking bulletin. Do not continue until it is resolved.",
    "If there are no blocking bulletins, proceed with the startup priority and ticket-alignment checks.",
  ].join("\n");
}

function renderAvailableProcedures(skills: SkillEntry[], globalDocs: string[], runtime: RuntimeName): string {
  if (runtime !== "opencode") return "";
  const skillNames = new Set(skills.map((skill) => skill.name));
  const procedures = [
    ["pa-startup", "startup order, bulletin checks, ticket/objective alignment, and additional-instructions priority"],
    ["pa-ticket-workflow", "ticket claim/update/handoff, doc-ref handling, and one-ticket-per-work-item rules"],
    ["pa-session-log", "session logs, artifact finalization, shutdown, and registry completion"],
    ["pa-self-improvement", "required self-reflection content for session logs"],
    ["pa-registry", "deployment completion markers and post-completion updates"],
    ["pa-communication", "cross-team and Sinh communication conventions"],
    ["pa-bulletin", "blocking bulletin protocol and resolution workflow"],
  ].filter(([name]) => skillNames.has(name));
  const lines = [
    "## Available Procedures",
    "Use the injected pa-platform skills below as the canonical operational procedures for this run. They are rendered from packaged `skills/` content, not external Claude Code skill folders.",
  ];
  if (procedures.length > 0) {
    for (const [name, description] of procedures) lines.push(`- ${name}: ${description}.`);
  } else {
    lines.push("- No PA operational skills are injected for this mode. Follow the objective and runtime tool guidance.");
  }
  if (globalDocs.length > 0) {
    lines.push("Reference documents discoverable for this mode:");
    for (const doc of globalDocs) lines.push(`- ${doc}`);
  }
  return lines.join("\n");
}

function renderDeploymentInstructions(teamConfig: TeamConfig, mode: DeployMode | undefined, runtime: RuntimeName): string {
  if (runtime !== "opencode") return "";
  const executionStyle = mode?.solo || (mode?.agents?.length ?? teamConfig.agents.length) <= 1 ? "solo" : "team";
  const lines = [
    "## Deployment Instructions",
    "Use `opa` for all PA platform commands. Use only tools exposed in the current opencode session.",
    "Start by checking active bulletins, then verify ticket/objective alignment before changing files or producing artifacts.",
    "For ticket work, keep lifecycle updates on the ticket: claim when starting, comment on meaningful progress, attach persistent doc_refs before handoff, and advance status only after required artifacts exist.",
    "Save session logs under `sessions/YYYY/MM/agent-team/` and finalize registry state with `opa registry complete` or `opa registry update` when the run finishes.",
    "On verification failure or abort, stop, keep the ticket in its current work state, add failure tags/comments, and report the exact command or condition that failed.",
  ];
  if (executionStyle === "solo") {
    lines.push("This is a solo deployment: do the work directly unless the objective explicitly says otherwise.");
  } else {
    lines.push("This is a team-mode deployment: coordinate through opencode-exposed tools only, and keep ticket comments as the durable handoff channel.");
  }
  return lines.join("\n");
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
const EXTERNAL_CLAUDE_SKILLS_PATH_RE = /(?:~|\/home\/[^\s"`<>]+)\/\.claude\/skills/g;

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
    .replace(/\bpa command\b/g, "opa command")
    .replace(EXTERNAL_CLAUDE_SKILLS_PATH_RE, "packaged pa-platform skills")
    .replace(/\bAskUserQuestion\b/g, "direct user question")
    .replace(/\bTeamCreate\b|\bSendMessage\b|\bScheduleWakeup\b/g, "opencode-exposed tools");
}

function defaultToolReference(runtime: RuntimeName): string {
  if (runtime === "opencode") {
    return [
      "Runtime: opencode via `opa`.",
      "Use `opa` for PA platform commands; it invokes the updated pa-core command set and avoids the legacy `pa` binary.",
      "Use opencode tools exposed in the current session.",
      "Task-style delegation is only available when exposed by the current opencode session.",
      "Do not assume Claude-only operational tools exist.",
    ].join("\n");
  }

  return [
    "Claude Code team deployments may use TeamCreate, SendMessage, Agent, AskUserQuestion, and ScheduleWakeup when provided by the adapter.",
    "Use tool availability from the active session as the source of truth.",
  ].join("\n");
}
