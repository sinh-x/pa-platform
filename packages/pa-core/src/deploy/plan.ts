import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getRegistryDbPath, getSkillsDir } from "../paths.js";
import { resolveRepo } from "../repos.js";
import type { DeployMode, RuntimeName, SkillEntry, TeamConfig } from "../types.js";
import type { DeployRequest } from "./control.js";
import type { PaEnvKey } from "../primer/index.js";

export interface ExecutionPlanSkill {
  name: string;
  injectAs: SkillEntry["inject-as"];
  path: string;
}

export interface ExecutionPlanLifecycle {
  deploymentId: string;
  deploymentDir: string;
  activityLogPath: string;
  registryDbPath: string;
  terminalMarker: string;
}

export interface ExecutionPlan {
  readonly runtime: RuntimeName;
  readonly team: string;
  readonly mode: string;
  readonly repositoryCwd: string;
  readonly ticket?: string;
  readonly ticketRequired: boolean;
  readonly objective: string;
  readonly skills: readonly ExecutionPlanSkill[];
  readonly memoryDocuments: readonly string[];
  readonly environment: Readonly<Partial<Record<PaEnvKey, string>>>;
  readonly timeoutSeconds: number;
  readonly provider?: string;
  readonly model?: string;
  readonly trustedExtension?: string;
  readonly lifecycle: Readonly<ExecutionPlanLifecycle>;
}

export interface ResolveExecutionPlanOptions {
  request: DeployRequest;
  teamConfig: TeamConfig;
  mode?: DeployMode;
  runtime: RuntimeName;
  deploymentId: string;
  deploymentDir: string;
  activityLogPath: string;
  environment: Partial<Record<PaEnvKey, string>>;
  timeoutSeconds: number;
  skillsDir?: string;
  registryDbPath?: string;
  trustedExtensionPath?: string;
}

export function resolveExecutionPlan(options: ResolveExecutionPlanOptions): ExecutionPlan {
  const modeName = options.mode?.id ?? options.teamConfig.default_mode ?? "default";
  const skillsDir = options.skillsDir ?? getSkillsDir();
  const skills = (options.mode?.skills ?? []).map((skill) => {
    const path = resolve(skillsDir, skill.name, "SKILL.md");
    if (!existsSync(path)) {
      throw new Error(`Missing selected PA skill: team '${options.teamConfig.name}', mode '${modeName}', skill '${skill.name}', attempted path '${path}'.`);
    }
    return Object.freeze({ name: skill.name, injectAs: skill["inject-as"], path });
  });
  const repositoryCwd = options.request.repo ? resolveRepo(options.request.repo).path : process.cwd();
  const ticketRequired = options.mode?.require_ticket === true;
  if (ticketRequired && !options.request.ticket) {
    throw new Error(`Ticket is required for team '${options.teamConfig.name}', mode '${modeName}'.`);
  }
  const lifecycle = Object.freeze({
    deploymentId: options.deploymentId,
    deploymentDir: options.deploymentDir,
    activityLogPath: options.activityLogPath,
    registryDbPath: options.registryDbPath ?? getRegistryDbPath(),
    terminalMarker: resolve(options.deploymentDir, "terminal.json"),
  });
  return Object.freeze({
    runtime: options.runtime,
    team: options.teamConfig.name,
    mode: modeName,
    repositoryCwd,
    ...(options.request.ticket ? { ticket: options.request.ticket } : {}),
    ticketRequired,
    objective: options.request.objective ?? options.mode?.objective ?? options.teamConfig.objective,
    skills: Object.freeze(skills),
    memoryDocuments: Object.freeze([...(options.teamConfig.global_docs ?? []), ...(options.mode?.global_docs ?? [])]),
    environment: Object.freeze({ ...options.environment }),
    timeoutSeconds: options.timeoutSeconds,
    ...(options.request.provider ? { provider: options.request.provider } : {}),
    ...(options.request.model ? { model: options.request.model } : {}),
    ...(options.trustedExtensionPath ? { trustedExtension: options.trustedExtensionPath } : {}),
    lifecycle,
  });
}
