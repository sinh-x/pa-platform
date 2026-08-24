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

  const body = [
    `# PA Deployment Primer`,
    ``,
    `Runtime: ${options.runtime}`,
    `Team: ${options.teamConfig.name}`,
    `Mode: ${mode?.id ?? "default"}`,
    ``,
    `> **Ticket:** ${options.templateVars?.TICKET_ID || "none"}`,
    ``,
    userObjective ? `## User Objective\n${userObjective}` : "",
    `## Objective`,
    objective,
    ``,
    `## Runtime Tools`,
    toolReference,
    ``,
    renderActiveBulletins(options.runtime),
    ``,
    `## Team`,
    options.teamConfig.description,
    ``,
    `## Agents`,
    renderAgents(agents, options, options.runtime),
    ``,
    renderAvailableProcedures(skills, options.skillsDir ?? getSkillsDir(), options.runtime),
    ``,
    renderProjectAgentGuides(globalDocs, options.resolveFile, options.runtime),
    ``,
    renderDeploymentInstructions(options.teamConfig, mode, options.runtime),
    ``,
    `## Skills`,
    renderSkills(skills, options.skillsDir ?? getSkillsDir(), options.runtime),
    extraInstructions ? `\n## Extra Instructions\n${extraInstructions}` : "",
  ].filter((part) => part !== "").join("\n");
  return `${body}\n${renderSizeSignal(body, mode?.id)}`;
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
      lines.push("", `<instruction-file name="${agent.name}">`, demoteHeadings(adaptContentForRuntime(content, runtime)), `</instruction-file>`);
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
  const inlined = skills.filter((skill) => skill["inject-as"] !== "reference");
  if (inlined.length === 0) return "(none)";
  return inlined.map((skill) => {
    const path = resolve(skillsDir, skill.name, "SKILL.md");
    const body = demoteHeadings(adaptContentForRuntime(existsSync(path) ? readFileSync(path, "utf-8") : `(missing skill: ${path})`, runtime));
    return `<${skill["inject-as"]} name="${skill.name}" path="${path}">\n${body}\n</${skill["inject-as"]}>`;
  }).join("\n\n");
}

function renderActiveBulletins(runtime: RuntimeName): string {
  switch (runtime) {
    case "opencode":
      return [
        "## Active Bulletins",
        "Before starting work, run `opa bulletin list`.",
        "If any active bulletin blocks this team or all teams, stop immediately and report the blocking bulletin. Do not continue until it is resolved.",
        "If there are no blocking bulletins, proceed with the startup priority and ticket-alignment checks.",
      ].join("\n");
    case "claude":
      return [
        "## Active Bulletins",
        "Before starting work, run `cpa bulletin list`.",
        "If any active bulletin blocks this team or all teams, stop immediately and report the blocking bulletin. Do not continue until it is resolved.",
        "If there are no blocking bulletins, proceed with the startup priority and ticket-alignment checks.",
      ].join("\n");
    case "droid":
      return [
        "## Active Bulletins",
        "Before starting work, run `dpa bulletin list`.",
        "If any active bulletin blocks this team or all teams, stop immediately and report the blocking bulletin. Do not continue until it is resolved.",
        "If there are no blocking bulletins, proceed with the startup priority and ticket-alignment checks.",
      ].join("\n");
    case "pi":
      return [
        "## Active Bulletins",
        "Before starting work, run `ppa bulletin list`.",
        "If any active bulletin blocks this team or all teams, stop immediately and report the blocking bulletin. Do not continue until it is resolved.",
        "If there are no blocking bulletins, proceed with the startup priority and ticket-alignment checks.",
      ].join("\n");
    default:
      return "";
  }
}

const PROCEDURE_CATALOG: ReadonlyArray<readonly [string, string]> = [
  ["pa-startup", "startup order, bulletin checks, ticket/objective alignment, and additional-instructions priority"],
  ["pa-ticket-workflow", "ticket claim/update/handoff, doc-ref handling, and one-ticket-per-work-item rules"],
  ["pa-session-log", "session logs, artifact finalization, shutdown, and registry completion"],
  ["pa-self-improvement", "required self-reflection content for session logs"],
  ["pa-registry", "deployment completion markers and post-completion updates"],
  ["pa-communication", "cross-team and Sinh communication conventions"],
  ["pa-bulletin", "blocking bulletin protocol and resolution workflow"],
];

function renderAvailableProcedures(skills: SkillEntry[], skillsDir: string, runtime: RuntimeName): string {
  if (runtime !== "opencode" && runtime !== "claude" && runtime !== "droid" && runtime !== "pi") return "";
  const intro = runtime === "claude"
    ? "Use the injected pa-platform skills below as the canonical operational procedures for this run. They are rendered from packaged `skills/` content and take precedence over any Claude Code skills loaded from `~/.claude/skills`."
    : "Use the injected pa-platform skills below as the canonical operational procedures for this run. They are rendered from packaged `skills/` content, not external skill folders.";
  const lines = ["## Available Procedures", intro];
  const inlined = skills.filter((skill) => skill["inject-as"] !== "reference");
  const referenceSkills = skills.filter((skill) => skill["inject-as"] === "reference");
  if (inlined.length > 0) {
    for (const skill of inlined) {
      const description = PROCEDURE_CATALOG.find(([name]) => name === skill.name)?.[1];
      lines.push(description ? `- ${skill.name}: ${description}.` : `- ${skill.name}: injected below.`);
    }
  }
  if (referenceSkills.length > 0) {
    if (inlined.length > 0) lines.push("");
    const paCliHint = referenceSkills.some((skill) => skill.name === "pa-cli")
      ? " Start by reading pa-cli for CLI reference."
      : "";
    lines.push(`Reference skills (use the Read tool to load any skill below when you need it)${paCliHint}:`);
    for (const skill of referenceSkills) {
      const path = resolve(skillsDir, skill.name, "SKILL.md");
      const description = PROCEDURE_CATALOG.find(([name]) => name === skill.name)?.[1];
      lines.push(description ? `- ${skill.name}: ${description}. Path: \`${path}\`` : `- ${skill.name}: Path: \`${path}\``);
    }
  }
  if (inlined.length === 0 && referenceSkills.length === 0) {
    lines.push("- No PA operational skills are injected for this mode. Follow the objective and runtime tool guidance.");
  }
  return lines.join("\n");
}

function renderProjectAgentGuides(globalDocs: string[], resolveFile: ((relativePath: string) => string | undefined) | undefined, runtime: RuntimeName): string {
  if (runtime !== "opencode" && runtime !== "claude" && runtime !== "droid" && runtime !== "pi") return "";
  if (globalDocs.length === 0) return "";
  const lines = ["## Project Agent Guides"];
  for (const doc of globalDocs) {
    const resolved = resolveFile?.(doc) ?? resolve(getPlatformHomeDir(), doc);
    if (!existsSync(resolved)) {
      lines.push(`- ${doc} (missing: ${resolved})`);
      continue;
    }
    const raw = readFileSync(resolved, "utf-8");
    if (isPlaceholderTemplate(raw)) {
      lines.push(`- ${doc} (skipped: placeholder-only template)`);
      continue;
    }
    const body = adaptContentForRuntime(raw, runtime);
    lines.push(body);
  }
  return lines.join("\n");
}

const PLACEHOLDER_TOKEN_RE = /<[A-Za-z][A-Za-z0-9 _./-]*>/g;
// MIN-B: also match headings with an EMBEDDED placeholder token (e.g.
// `### C1: <Convention Title>`), not just headings that start with one. This
// narrows the future risk window where a template heading slips past detection
// because the placeholder is not the first token. Headings only — generic
// `<T>` inside prose/code is handled separately by PLACEHOLDER_TOKEN_RE.
// MIN-C3-3 (accepted limitation): PLACEHOLDER_TOKEN_RE also matches legit
// generic/HTML angle tokens (`Array<string>`, `<div>`), so a heading-less prose
// doc with >=3 such tokens is skipped as a placeholder. Narrowing to exclude
// code-fence content would break the existing test where all placeholder tokens
// are inside a ``` fence. The `pa: keep-content` opt-out is the documented escape
// hatch for docs that are falsely classified as placeholder templates.
const PLACEHOLDER_HEADING_RE = /^#{1,6}\s+.*<[A-Za-z][A-Za-z0-9 _./-]*>/m;
// Self-ID requires an explicit `# Template:` front-matter marker (colon required).
// A bare `# Template Engine Conventions` prose title (space, no colon) must NOT
// self-identify as a placeholder, so a legit doc with such a title and ≥3 generics
// is still injected (MAJ-1 fix). The `> **Template:**` blockquote form is retained.
const TEMPLATE_SELF_ID_RE = /(?:^#\s*Template:|^>\s+\*\*Template:\*\*)/m;
const PLACEHOLDER_OPT_OUT_RE = /<!--\s*pa:\s*skip-placeholder-template\s*-->/;
const PLACEHOLDER_FORCE_INCLUDE_RE = /<!--\s*pa:\s*keep-content\s*-->/;

function isPlaceholderTemplate(body: string): boolean {
  if (PLACEHOLDER_FORCE_INCLUDE_RE.test(body)) return false;
  if (PLACEHOLDER_OPT_OUT_RE.test(body)) return true;
  const tokens = body.match(PLACEHOLDER_TOKEN_RE);
  if (!tokens || tokens.length < 3) return false;
  if (TEMPLATE_SELF_ID_RE.test(body)) return true;
  const headingLines = body.split("\n").filter((line) => /^#{1,6}\s+/.test(line));
  if (headingLines.length === 0) return true;
  const filledHeadings = headingLines.filter((line) => !PLACEHOLDER_HEADING_RE.test(line));
  return filledHeadings.length === 0;
}

function renderDeploymentInstructions(teamConfig: TeamConfig, mode: DeployMode | undefined, runtime: RuntimeName): string {
  if (runtime !== "opencode" && runtime !== "claude" && runtime !== "droid" && runtime !== "pi") return "";
  const executionStyle = mode?.solo === true ? "solo"
    : mode?.solo === false ? "team"
    : (mode?.agents?.length ?? teamConfig.agents.length) <= 1 ? "solo" : "team";
  const implementReportOnly = teamConfig.name === "builder" && mode?.id === "implement";
  const lifecycleInstruction = implementReportOnly
    ? "For builder/implement ticket work, status updates are prohibited. Report completion through the ticket comment and persistent artifact output; status transitions belong to the parent flow or orchestrator."
    : "For ticket work, keep lifecycle updates on the ticket: claim when starting, comment on meaningful progress, attach persistent doc_refs before handoff, and advance status only after required artifacts exist.";
  if (runtime === "claude") {
    const lines = [
      "## Deployment Instructions",
      "Use `cpa` for PA platform workflow commands. Use `pa-core serve` for Agent API server lifecycle. Use the Claude Code tools and skills exposed in the active session — including Skill (slash commands), AskUserQuestion, Agent, TeamCreate, SendMessage, and ScheduleWakeup — when they are needed.",
      "Start by checking active bulletins, then verify ticket/objective alignment before changing files or producing artifacts.",
      lifecycleInstruction,
      "Save session logs under `sessions/YYYY/MM/agent-team/` and finalize registry state with `cpa registry complete` or `cpa registry update` when the run finishes.",
      "On verification failure or abort, stop, keep the ticket in its current work state, add failure tags/comments, and report the exact command or condition that failed.",
    ];
    if (executionStyle === "team") {
      lines.push("This is a team-mode deployment: spawn sub-agents via the Agent tool when the team plan calls for it, and keep ticket comments as the durable handoff channel.");
    }
    return lines.join("\n");
  }
  if (runtime === "droid") {
    const lines = [
      "## Deployment Instructions",
      "Use `dpa` for PA platform workflow commands. Use `pa-core serve` for Agent API server lifecycle. Use Droid tools exposed in the active session: Read, Edit, Create, Execute, Grep, Glob, LS, Task (sub-agent spawning), AskUser, Skill, WebSearch, FetchUrl, and TodoWrite.",
      "Start by checking active bulletins, then verify ticket/objective alignment before changing files or producing artifacts.",
      lifecycleInstruction,
      "Save session logs under `sessions/YYYY/MM/agent-team/` and finalize registry state with `dpa registry complete` or `dpa registry update` when the run finishes.",
      "On verification failure or abort, stop, keep the ticket in its current work state, add failure tags/comments, and report the exact command or condition that failed.",
    ];
    if (executionStyle === "team") {
      lines.push("This is a team-mode deployment: spawn sub-agents via the Task tool when the team plan calls for it, and keep ticket comments as the durable handoff channel.");
    }
    return lines.join("\n");
  }
  if (runtime === "pi") {
    return [
      "## Deployment Instructions",
      "Use `ppa` for PA platform workflow commands. Use `pa-core serve` for Agent API server lifecycle. Use only tools exposed in the current Pi session.",
      lifecycleInstruction,
      "Save session logs under `sessions/YYYY/MM/agent-team/` and finalize registry state with `ppa registry complete` or `ppa registry update` when the run finishes.",
      "On verification failure or abort, stop, keep the ticket in its current work state, add failure tags/comments, and report the exact command or condition that failed.",
    ].join("\n");
  }
  const lines = [
    "## Deployment Instructions",
    "Use `opa` for PA platform workflow commands. Use `pa-core serve` for Agent API server lifecycle. Use only tools exposed in the current opencode session.",
    "Start by checking active bulletins, then verify ticket/objective alignment before changing files or producing artifacts.",
    lifecycleInstruction,
    "Save session logs under `sessions/YYYY/MM/agent-team/` and finalize registry state with `opa registry complete` or `opa registry update` when the run finishes.",
    "On verification failure or abort, stop, keep the ticket in its current work state, add failure tags/comments, and report the exact command or condition that failed.",
  ];
  lines.push("For semantic briefing-style requests (for example: startup context refresh or get up to date), render `opa semantic briefing <query>` output with evidence links, then ask exactly one confirmation question before deeper analysis or mutation.");
  if (teamConfig.name === "requirements") {
    lines.push("For requirements workflows, treat structured ticket and deployment records as authoritative over semantic similarity.");
  }
  if (executionStyle === "team") {
    lines.push("This is a team-mode deployment: coordinate through opencode-exposed tools only, and keep ticket comments as the durable handoff channel.");
  }
  return lines.join("\n");
}

const PA_CLI_SUBCOMMANDS = [
  "board",
  "bulletin",
  "daily",
  "deploy",
  "evaluate",
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
const CLAUDECODE_PROSE_LINE_RE = /^\s*(?:unset\s+CLAUDECODE|CLAUDECODE=(?:"[^"]*"|'[^']*'|\S+))\s*(?:&&\s*)?(?:pa|opa|cpa|dpa|ppa)\s+(?:deploy|status|registry|ticket|board|bulletin)\b.*(?:\n|$)/gm;
const EXTERNAL_CLAUDE_SKILLS_PATH_RE = /(?:~|\/home\/[^\s"`<>]+)\/\.claude\/skills/g;

function adaptContentForRuntime(content: string, runtime: RuntimeName): string {
  if (runtime === "opencode") {
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
      .replace(/\bTeamCreate\b/g, "team coordination capability")
      .replace(/\bSendMessage\b/g, "durable ticket-comment handoff")
      .replace(/\bScheduleWakeup\b/g, "scheduled deployment capability");
  }
  if (runtime === "claude") {
    return content
      .replace(PA_CLI_COMMAND_RE, "$1cpa")
      .replace(/`pa` CLI/g, "`cpa` CLI")
      .replace(/\bPA CLI\b/g, "CPA CLI")
      .replace(/\bpa CLI\b/g, "cpa CLI")
      .replace(/\bpa commands\b/g, "cpa commands")
      .replace(/\bpa command\b/g, "cpa command")
      .replace(EXTERNAL_CLAUDE_SKILLS_PATH_RE, "packaged pa-platform skills");
  }
  if (runtime === "droid") {
    return content
      .replace(CLAUDECODE_COMMAND_PREFIX_RE, "$1")
      .replace(PA_CLI_COMMAND_RE, "$1dpa")
      .replace(CLAUDECODE_PROSE_LINE_RE, "")
      .replace(/`pa` CLI/g, "`dpa` CLI")
      .replace(/\bPA CLI\b/g, "DPA CLI")
      .replace(/\bpa CLI\b/g, "dpa CLI")
      .replace(/\bpa commands\b/g, "dpa commands")
      .replace(/\bpa command\b/g, "dpa command")
      .replace(EXTERNAL_CLAUDE_SKILLS_PATH_RE, "packaged pa-platform skills")
      .replace(/\bAskUserQuestion\b/g, "AskUser tool")
      .replace(/\bTeamCreate\b/g, "Task sub-agent creation")
      .replace(/\bSendMessage\b/g, "durable ticket-comment handoff")
      .replace(/\bScheduleWakeup\b/g, "scheduled deployment capability");
  }
  if (runtime === "pi") {
    return content
      .replace(CLAUDECODE_COMMAND_PREFIX_RE, "$1")
      .replace(PA_CLI_COMMAND_RE, "$1ppa")
      .replace(CLAUDECODE_PROSE_LINE_RE, "")
      .replace(/`pa` CLI/g, "`ppa` CLI")
      .replace(/\bPA CLI\b/g, "PPA CLI")
      .replace(/\bpa CLI\b/g, "ppa CLI")
      .replace(/\bpa commands\b/g, "ppa commands")
      .replace(/\bpa command\b/g, "ppa command")
      .replace(EXTERNAL_CLAUDE_SKILLS_PATH_RE, "packaged pa-platform skills")
      .replace(/\bAskUserQuestion\b/g, "a direct user question")
      .replace(/\bTeamCreate\b/g, "team coordination capability")
      .replace(/\bSendMessage\b/g, "durable ticket-comment handoff")
      .replace(/\bScheduleWakeup\b/g, "scheduled deployment capability");
  }
  return content;
}

const ATX_HEADING_LINE_RE = /^(#{1,6})(?=\s)(.*)$/;
// Hoisted fence-close regexes (MIN-5): avoid compiling a new RegExp per in-fence line.
// Capture group provides the close-run string so we can verify its length >= opening count (MIN-C3-2).
const BACKTICK_FENCE_CLOSE_RE = /^\s*(`{3,})\s*$/;
const TILDE_FENCE_CLOSE_RE = /^\s*(~{3,})\s*$/;
// Known primer top-level section headers (h2). An injected heading whose demoted
// form exactly matches one of these is demoted one extra level to avoid collision (MIN-1).
const PRIMER_SECTION_HEADERS: ReadonlySet<string> = new Set([
  "## User Objective",
  "## Objective",
  "## Runtime Tools",
  "## Active Bulletins",
  "## Team",
  "## Agents",
  "## Available Procedures",
  "## Project Agent Guides",
  "## Deployment Instructions",
  "## Skills",
  "## Extra Instructions",
  "## Memory Docs",
]);

function demoteHeadings(content: string): string {
  const lines = content.split("\n");
  let inFence: { char: string; count: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const openMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (openMatch && !inFence) {
      inFence = { char: openMatch[1]!.charAt(0), count: openMatch[1]!.length };
      continue;
    }
    if (inFence) {
      const closeMatch = line.match(inFence.char === "`" ? BACKTICK_FENCE_CLOSE_RE : TILDE_FENCE_CLOSE_RE);
      if (closeMatch && closeMatch[1]!.length >= inFence.count) inFence = null;
      continue;
    }
    const m = line.match(ATX_HEADING_LINE_RE);
    if (!m) continue;
    const level = m[1]!.length;
    if (level >= 6) continue;
    const demotedLevel = level + 1;
    const demotedText = `${"#".repeat(demotedLevel)}${m[2]}`;
    // Collision guard (MIN-1): if the demoted form matches a known primer section header,
    // demote one extra level (h1→h3 instead of h1→h2) so AC4 holds for h1 titles whose
    // text coincides with a primer section name. Cap at h6.
    if (demotedLevel < 6 && PRIMER_SECTION_HEADERS.has(demotedText.trim())) {
      const extraLevel = Math.min(demotedLevel + 1, 6);
      lines[i] = `${"#".repeat(extraLevel)}${m[2]}`;
    } else {
      lines[i] = demotedText;
    }
  }
  return lines.join("\n");
}

const PRIMER_LINE_BUDGET: Readonly<Record<string, number>> = {
  orchestrator: 1200,
  analyze: 1200,
  review: 1000,
  "review-auto": 1000,
  implement: 800,
  default: 1200,
};

function renderSizeSignal(primerBody: string, modeId: string | undefined): string {
  // The final primer is `${body}\n${sizeLine}` — one extra line beyond the body.
  // Report the real line count (body lines + 1 for the size line) so downstream
  // tooling comparing `lines=N` to the file's real line count is not off by one (MIN-2).
  const bodyLines = primerBody.split("\n").length;
  const lines = bodyLines + 1;
  const budget = PRIMER_LINE_BUDGET[modeId ?? "default"] ?? PRIMER_LINE_BUDGET["default"]!;
  const over = lines > budget;
  // MIN-A: compute chars from the FINAL size line length, not the placeholder.
  // The final size line embeds `chars=${chars}` whose digit count depends on chars
  // itself; building the line from a `chars=0` placeholder under-counts by
  // (digitCount - 1). Construct the final line first, then derive chars so it
  // equals the primer's real character count (body + "\n" + final size line).
  const template = (charsValue: string) => `<!--pa:primer-size lines=${lines} chars=${charsValue} mode=${modeId ?? "default"} budget=${budget} over=${over}-->`;
  // Solve for the stable char count: the size line length grows with the digit
  // count of `chars`. Iterate to a fixed point — at most a few passes since each
  // extra digit only adds one char.
  let chars = primerBody.length + 1 + template("0").length;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = primerBody.length + 1 + template(String(chars)).length;
    if (next === chars) break;
    chars = next;
  }
  return template(String(chars));
}

function defaultToolReference(runtime: RuntimeName): string {
  if (runtime === "opencode") {
    return [
      "Runtime: opencode via `opa`.",
      "Use `opa` for PA platform deployment and workflow commands; it invokes the updated pa-core command set and avoids the legacy `pa` binary.",
      "Use `pa-core serve` for Agent API server lifecycle; `opa` is the default deployment adapter, not the server owner.",
      "Use opencode tools exposed in the current session.",
      "Task-style delegation is only available when exposed by the current opencode session.",
      "Do not assume Claude-only operational tools exist.",
    ].join("\n");
  }
  if (runtime === "claude") {
    return [
      "Runtime: Claude Code via `cpa`.",
      "Use `cpa` for PA platform deployment and workflow commands; it invokes the same pa-core command set `opa` uses, with anthropic-only provider resolution and Claude Code session integration.",
      "Use `pa-core serve` for Agent API server lifecycle; `cpa` is a deployment adapter, not the server owner.",
      "Claude Code team deployments may use Skill (slash commands), AskUserQuestion, Agent (sub-agent spawning), TeamCreate, SendMessage, and ScheduleWakeup when they are exposed by the active session.",
      "Use tool availability from the active session as the source of truth.",
    ].join("\n");
  }
  if (runtime === "droid") {
    return [
      "Runtime: Droid via `dpa`.",
      "Use `dpa` for PA platform deployment and workflow commands; it invokes the same pa-core command set that `opa` and `cpa` use, with Droid session integration via the Factory SDK.",
      "Use `pa-core serve` for Agent API server lifecycle; `dpa` is a deployment adapter, not the server owner.",
      "Droid deployments may use all Droid-native tools: Read, Edit, Create, Execute, Grep, Glob, LS, Task (sub-agent spawning), AskUser, Skill, WebSearch, FetchUrl, and TodoWrite.",
      "Droid deploys via the Factory SDK with session streaming; all runs (foreground and background) capture a session id and are resumable.",
      "Default model: `deepseek-v4-pro` (override via `--model`, team-mode YAML, or `PA_DPA_DEFAULT_MODEL`).",
    ].join("\n");
  }
  if (runtime === "pi") {
    return [
      "Runtime: Pi via `ppa`.",
      "Use `ppa` for PA platform deployment and workflow commands; it invokes the shared pa-core command set with the canonical `pi` runtime.",
      "Use `pa-core serve` for Agent API server lifecycle; `ppa` is a deployment adapter, not the server owner.",
      "Pi deployments use the Pi CLI and retain OpenCode as the default API runtime when no runtime is selected.",
    ].join("\n");
  }

  return [
    "Claude Code team deployments may use TeamCreate, SendMessage, Agent, AskUserQuestion, and ScheduleWakeup when provided by the adapter.",
    "Use tool availability from the active session as the source of truth.",
  ].join("\n");
}

// --- Shared memory-doc block helper (MIN-4 DRY extraction) ---
// The three runtime adapters (opencode/claude/droid) previously copy-pasted the
// pointer-vs-full `buildMemoryDocsBlock` logic. This shared helper centralizes it;
// each adapter keeps its local `MEMORY_DOC_POINTER_MODE` flag and calls this helper.

export interface MemoryDocEntry {
  path: string;
  content: string;
}

export interface RenderMemoryDocsBlockOptions {
  /** Human-readable runtime label used in the pointer/full-injection prose (e.g. "opencode", "Claude Code", "droid"). */
  runtimeLabel: string;
  /** When true, emit path pointers instead of full bodies (runtime loads memory docs natively). */
  pointerMode: boolean;
}

export function renderMemoryDocsBlock(docs: MemoryDocEntry[], opts: RenderMemoryDocsBlockOptions): string | undefined {
  if (docs.length === 0) return undefined;
  if (opts.pointerMode) {
    return [
      "## Memory Docs",
      `The following instruction files are loaded natively by ${opts.runtimeLabel}; the full bodies are not re-injected here. They are listed as path pointers for discoverability. Follow them unless they conflict with this deployment primer.`,
      ...docs.map((doc) => `<memory-doc path="${doc.path}">\n[pointer: loaded natively by ${opts.runtimeLabel} — see file at this path]\n</memory-doc>`),
    ].join("\n\n");
  }
  return [
    "## Memory Docs",
    `The following instruction files were explicitly included to emulate memory for ${opts.runtimeLabel} deployments. Follow them unless they conflict with this deployment primer.`,
    ...docs.map((doc) => `<memory-doc path="${doc.path}">\n${doc.content}\n</memory-doc>`),
  ].join("\n\n");
}

// --- Shared deployment-context env-vars helper (MIN-C DRY extraction) ---
// All three runtime adapters (opencode/claude/droid) inject a `pa_env_vars:`
// subsection into the `<deployment-context>` block. Centralizing the key list
// and the rendering keeps the three adapters consistent and avoids drift.

export const PA_ENV_KEYS = [
  "PA_DEPLOYMENT_ID",
  "PA_DEPLOYMENT_DIR",
  "PA_ACTIVITY_LOG",
  "PA_TEAM",
  "PA_MODE",
  "PA_TICKET_ID",
  "PA_REPO",
  "PA_PROVIDER",
  "PA_MODEL",
  "PA_TEAM_MODEL",
  "PA_AGENT_MODEL",
] as const;

export type PaEnvKey = (typeof PA_ENV_KEYS)[number];

/**
 * Renders the `pa_env_vars:` subsection for the `<deployment-context>` block.
 * Returns the empty string when no env vars are supplied so the block stays
 * unchanged for adapters that opt out (kept for back-compat). Each key line is
 * `  KEY: value` (empty string when the key is absent), matching the existing
 * opencode-pa format byte-for-byte.
 */
export function renderEnvVarsBlock(envVars: Partial<Record<PaEnvKey, string>> | undefined): string {
  if (!envVars) return "";
  return [
    "pa_env_vars:",
    ...PA_ENV_KEYS.map((key) => `  ${key}: ${envVars[key] ?? ""}`),
  ].join("\n");
}
