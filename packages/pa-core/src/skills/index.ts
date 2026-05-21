import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import yaml from "js-yaml";
import { getPlatformHomeDir, getSkillsDir, getTeamsDir } from "../paths.js";
import { loadConfig } from "../config.js";
import { listTeamConfigFiles, validateTeamSkillReferences } from "../teams/index.js";
import { parseTeamYaml } from "../yaml-parser.js";

export type SkillSourceType = "packaged" | "configured";

export interface SkillMetadata {
  name?: string;
  description?: string;
  "pa-tier"?: number;
  "pa-inject-as"?: string;
  platforms?: string[];
  runtimes?: string[];
  [key: string]: unknown;
}

export interface SkillValidationIssue {
  code:
    | "missing-team-skill-reference"
    | "missing-skill-file"
    | "invalid-metadata"
    | "platform-mismatch"
    | "runtime-mismatch"
    | "opencode-incompatible";
  message: string;
  skillName?: string;
  path?: string;
  team?: string;
  context?: string;
}

export interface SkillInventoryRecord {
  name: string;
  sourcePath: string;
  sourceType: SkillSourceType;
  owner?: string;
  injectAs: string[];
  metadata: SkillMetadata;
  validationStatus: "valid" | "invalid";
  lifecycleState: "discovered" | "validated" | "invalid";
  issues: SkillValidationIssue[];
}

export interface HermesDecision {
  structure: string;
  decision: "adopt" | "adapt" | "defer" | "reject";
  rationale: string;
}

export interface SkillRegistryReport {
  scannedRoots: string[];
  generatedAt: string;
  inventory: SkillInventoryRecord[];
  issues: SkillValidationIssue[];
  hermesDecisionMatrix: HermesDecision[];
  openCodeVisibility: {
    skillRegistryEnabled: boolean;
    primerSummaryBudgetChars: number;
    commandAdapter: "opa";
  };
}

const DEFAULT_PRIMER_SUMMARY_BUDGET = 5000;

export function listSkillRoots(skillsDir = getSkillsDir()): string[] {
  const config = loadConfig();
  const roots = [skillsDir];
  const configuredRoots = process.env["PA_PLATFORM_SKILL_ROOTS"]
    ?.split(":")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) ?? [];
  if (config.skillsDir && config.skillsDir !== skillsDir) roots.push(config.skillsDir);
  roots.push(...configuredRoots.map((entry) => resolve(entry)));
  return [...new Set(roots.map((root) => resolve(root)))].filter((root) => existsSync(root));
}

export function buildSkillRegistryReport(options?: { skillsDir?: string; teamsDir?: string; platformHomeDir?: string }): SkillRegistryReport {
  const skillsDir = options?.skillsDir ?? getSkillsDir();
  const teamsDir = options?.teamsDir ?? getTeamsDir();
  const platformHomeDir = options?.platformHomeDir ?? getPlatformHomeDir();
  const roots = listSkillRoots(skillsDir);
  const usageBySkill = collectSkillUsageByTeam(teamsDir);
  const inventory = roots.flatMap((root) => scanSkillRoot(root, resolve(skillsDir), usageBySkill));
  const issues: SkillValidationIssue[] = [];
  for (const missing of validateTeamSkillReferences(teamsDir, platformHomeDir, skillsDir)) {
    if (missing.kind !== "shared_skill") continue;
    issues.push({
      code: "missing-team-skill-reference",
      message: `Missing shared skill reference ${missing.reference} for team ${missing.team}`,
      skillName: missing.reference,
      path: missing.resolvedPath,
      team: missing.team,
      context: missing.context,
    });
  }
  for (const item of inventory) issues.push(...item.issues);
  return {
    scannedRoots: roots,
    generatedAt: new Date().toISOString(),
    inventory: inventory.sort((a, b) => a.name.localeCompare(b.name)),
    issues,
    hermesDecisionMatrix: hermesDecisionMatrix(),
    openCodeVisibility: {
      skillRegistryEnabled: true,
      primerSummaryBudgetChars: DEFAULT_PRIMER_SUMMARY_BUDGET,
      commandAdapter: "opa",
    },
  };
}

function scanSkillRoot(root: string, packagedRoot: string, usageBySkill: Map<string, { teams: Set<string>; injectAs: Set<string> }>): SkillInventoryRecord[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((entry) => statSync(entry).isDirectory())
    .map((dir) => buildSkillRecord(dir, dir.startsWith(packagedRoot) ? "packaged" : "configured", usageBySkill));
}

function buildSkillRecord(skillDir: string, sourceType: SkillSourceType, usageBySkill: Map<string, { teams: Set<string>; injectAs: Set<string> }>): SkillInventoryRecord {
  const name = basename(skillDir);
  const skillPath = join(skillDir, "SKILL.md");
  const usage = usageBySkill.get(name);
  const issues: SkillValidationIssue[] = [];
  let metadata: SkillMetadata = {};
  let validationStatus: "valid" | "invalid" = "valid";

  if (!existsSync(skillPath)) {
    issues.push({ code: "missing-skill-file", message: `Missing SKILL.md for ${name}`, skillName: name, path: skillPath });
    validationStatus = "invalid";
  } else {
    const content = readFileSync(skillPath, "utf-8");
    metadata = parseFrontmatter(content);
    issues.push(...validateSkillMetadata(name, skillPath, metadata, content));
    if (issues.length > 0) validationStatus = "invalid";
  }

  return {
    name,
    sourcePath: skillPath,
    sourceType,
    owner: usage ? [...usage.teams].sort().join(",") : undefined,
    injectAs: usage ? [...usage.injectAs].sort() : [],
    metadata,
    validationStatus,
    lifecycleState: validationStatus === "valid" ? "validated" : "invalid",
    issues,
  };
}

function parseFrontmatter(content: string): SkillMetadata {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const raw = yaml.load(content.slice(4, end)) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return {};
  const metadata: SkillMetadata = {};
  for (const [key, value] of Object.entries(raw)) metadata[key] = value;
  return metadata;
}

function validateSkillMetadata(name: string, skillPath: string, metadata: SkillMetadata, content: string): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  if (!metadata.name || !metadata.description) {
    issues.push({ code: "invalid-metadata", message: `Skill ${name} must include frontmatter name and description`, skillName: name, path: skillPath });
  }
  if (Array.isArray(metadata.platforms) && metadata.platforms.length > 0 && !metadata.platforms.includes("pa-platform")) {
    issues.push({ code: "platform-mismatch", message: `Skill ${name} does not target pa-platform`, skillName: name, path: skillPath });
  }
  if (Array.isArray(metadata.runtimes) && metadata.runtimes.length > 0 && !metadata.runtimes.includes("opencode")) {
    issues.push({ code: "runtime-mismatch", message: `Skill ${name} does not include opencode runtime`, skillName: name, path: skillPath });
  }
  if (/\bopencode\s+run\b/.test(content) || /\bcpa\s+deploy\b/.test(content)) {
    issues.push({ code: "opencode-incompatible", message: `Skill ${name} includes opencode-incompatible command guidance`, skillName: name, path: skillPath });
  }
  return issues;
}

function collectSkillUsageByTeam(teamsDir: string): Map<string, { teams: Set<string>; injectAs: Set<string> }> {
  const usage = new Map<string, { teams: Set<string>; injectAs: Set<string> }>();
  for (const teamPath of listTeamConfigFiles(teamsDir)) {
    let config;
    try {
      config = parseTeamYaml(teamPath);
    } catch {
      continue;
    }
    for (const mode of config.deploy_modes ?? []) {
      for (const skill of mode.skills ?? []) {
        const entry = usage.get(skill.name) ?? { teams: new Set<string>(), injectAs: new Set<string>() };
        entry.teams.add(config.name);
        entry.injectAs.add(skill["inject-as"]);
        usage.set(skill.name, entry);
      }
    }
  }
  return usage;
}

function hermesDecisionMatrix(): HermesDecision[] {
  return [
    { structure: "Progressive skill disclosure", decision: "adapt", rationale: "Use registry/index visibility and explicit full-body injection only when needed." },
    { structure: "Skill frontmatter metadata profile", decision: "adapt", rationale: "Keep SKILL.md and validate PA-focused metadata without adopting every Hermes field." },
    { structure: "External skill roots precedence", decision: "adapt", rationale: "Expose configured roots and packaged roots through a unified registry scan." },
    { structure: "Agent-managed skill patch and delete", decision: "defer", rationale: "Phase 1 remains read-only with no mutation endpoints." },
    { structure: "Local dashboard over read APIs", decision: "adopt", rationale: "Expose read model via pa-core Hono APIs for local inspection." },
    { structure: "Hermes raw opencode lifecycle delegation", decision: "reject", rationale: "OPA remains the lifecycle authority for deployments and ticket-linked work." },
  ];
}
