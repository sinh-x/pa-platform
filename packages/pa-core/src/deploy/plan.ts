import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getRegistryDbPath, getSkillsDir } from "../paths.js";
import { getBranchPattern, loadRepoEntry, resolveRepoExecutionPath } from "../repos.js";
import { TicketStore } from "../tickets/store.js";
import type { DeployMode, RuntimeName, SkillEntry, TeamConfig } from "../types.js";
import type { DeployRequest } from "./control.js";
import { resolveRepositoryAdmissionEvidence } from "./repository-admission.js";
import type { RepositoryAdmissionEvidence, RepositoryAdmissionOperation, RepositoryBranchTransitionPolicy, RepositoryGitSnapshot } from "./repository-admission.js";
import type { PaEnvKey } from "../primer/index.js";
import { isRogueOneTeam, ROGUE_ONE_MODE, type DeploymentInvocationChannel } from "./rogue-one.js";

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

export interface TreehouseLaunchEvidence {
  readonly authority: "orchestrator" | "parented-implement" | "standalone-implement";
  readonly parentDeploymentId?: string;
  readonly ticket: string;
  readonly path: string;
  readonly leaseId: string;
  readonly leaseHolder: string;
  readonly branch: string;
  readonly branchState: "materialized";
  readonly baseSha: string;
  readonly headSha: string;
  readonly ticketSlotId: string;
  readonly repositoryPermit: 1 | 2 | 3 | 4;
}

export interface ExecutionPlan {
  readonly runtime: RuntimeName;
  readonly team: string;
  readonly mode: string;
  readonly repoKey: string;
  /** Registered primary repository root and PA_REPO trust anchor. */
  readonly repoRoot: string;
  /** Exact physical root selected for project and runtime operations. */
  readonly worktreeRoot: string;
  readonly repositoryCwd: string;
  readonly repositoryGitDir: string;
  readonly repositoryGitCommonDir: string;
  readonly repositoryKind: "primary" | "linked";
  readonly memoryDocumentRoot: string;
  readonly repositoryAdmission: RepositoryAdmissionEvidence;
  readonly treehouse?: TreehouseLaunchEvidence;
  readonly rogue_one?: true;
  readonly invocation_channel?: DeploymentInvocationChannel;
  readonly ticket?: string;
  readonly ticketRequired: boolean;
  readonly objective: string;
  readonly userObjectiveOverride?: string;
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
  cwd?: string;
  captureRepositoryGitSnapshot?: (canonicalRepoRoot: string) => RepositoryGitSnapshot;
  observeRepositoryAdmissionOperation?: (operation: RepositoryAdmissionOperation) => void;
  /** Runtime-authenticated direct-parent context; not user request authority. */
  allowDirtyInheritedBorrow?: boolean;
  /** Trusted PPA-only evidence established before immutable planning. */
  treehouse?: TreehouseLaunchEvidence;
}

export function withAuthoritativeRepositoryAdmission(
  plan: ExecutionPlan,
  gitSnapshot: RepositoryGitSnapshot,
  approvedMutationPaths?: readonly string[],
): ExecutionPlan {
  const repositoryAdmission = Object.freeze({
    ...plan.repositoryAdmission,
    gitSnapshot: Object.freeze({ ...gitSnapshot }),
    ...(approvedMutationPaths ? { approvedMutationPaths: Object.freeze([...approvedMutationPaths]) } : {}),
  });
  return Object.freeze({ ...plan, repositoryAdmission });
}

export function resolveExecutionPlan(options: ResolveExecutionPlanOptions): ExecutionPlan {
  const rogueOne = isRogueOneTeam(options.request.team) && isRogueOneTeam(options.teamConfig.name);
  const modeName = rogueOne ? ROGUE_ONE_MODE : options.mode?.id ?? options.teamConfig.default_mode ?? "default";
  const invocationChannel: DeploymentInvocationChannel = options.request.invocationChannel ?? "cli";
  const repository = resolveRepoExecutionPath(options.request.repo, options.cwd ?? process.cwd(), {
    allowLinkedWorktreeCwd: options.runtime === "pi" && options.request.repo === undefined,
  });
  const skillsDir = options.skillsDir ?? getSkillsDir();
  const skills = (rogueOne ? [] : options.mode?.skills ?? []).map((skill) => {
    const path = resolve(skillsDir, skill.name, "SKILL.md");
    if (!existsSync(path)) {
      throw new Error(`Missing selected PA skill: team '${options.teamConfig.name}', mode '${modeName}', skill '${skill.name}', attempted path '${path}'.`);
    }
    return Object.freeze({ name: skill.name, injectAs: skill["inject-as"], path });
  });
  const ticketRequired = !rogueOne && options.mode?.require_ticket === true;
  if (ticketRequired && !options.request.ticket) {
    throw new Error(`Ticket is required for team '${options.teamConfig.name}', mode '${modeName}'.`);
  }
  const branchTransitionPolicy = options.runtime === "pi" && options.request.ticket
    ? resolveBranchTransitionPolicy(repository.repo, options.request.ticket)
    : undefined;
  const repositoryAdmission = resolveRepositoryAdmissionEvidence({
    team: options.teamConfig.name,
    mode: modeName,
    canonicalRepoKey: repository.repoKey,
    canonicalRepoRoot: repository.repoRoot,
    worktreeRoot: repository.worktreeRoot,
    runtime: options.runtime,
    background: options.request.background,
    dryRun: options.request.dryRun,
    force: options.request.force,
    ...(options.request.ticket ? { ticket: options.request.ticket } : {}),
    ...(options.captureRepositoryGitSnapshot ? { captureGitSnapshot: options.captureRepositoryGitSnapshot } : {}),
    ...(options.observeRepositoryAdmissionOperation ? { observeOperation: options.observeRepositoryAdmissionOperation } : {}),
    ...(options.allowDirtyInheritedBorrow ? { allowDirtyInheritedBorrow: true } : {}),
    ...(branchTransitionPolicy ? { branchTransitionPolicy } : {}),
  });
  if (options.treehouse) {
    const evidence = options.treehouse;
    const snapshot = repositoryAdmission.gitSnapshot;
    if (repository.worktreeKind !== "linked"
      || evidence.path !== repository.worktreeRoot
      || options.request.ticket === undefined
      || evidence.ticket !== options.request.ticket
      || evidence.leaseHolder !== `pa:${repository.repoKey}:${options.request.ticket}`
      || evidence.ticketSlotId !== `pa:${repository.repoKey}:${options.request.ticket}`
      || evidence.branchState !== "materialized"
      || (evidence.authority === "parented-implement") !== Boolean(evidence.parentDeploymentId)
      || !snapshot
      || snapshot.branch !== evidence.branch
      || snapshot.head !== evidence.headSha
      || !/^[0-9a-f]{40}$/.test(evidence.baseSha)
      || !/^[0-9a-f]{40}$/.test(evidence.headSha)
      || ![1, 2, 3, 4].includes(evidence.repositoryPermit)) {
      throw new Error("execution-plan: trusted Treehouse lease, branch, slot, permit, and authenticated Git snapshot must agree exactly");
    }
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
    repoKey: repository.repoKey,
    repoRoot: repository.repoRoot,
    worktreeRoot: repository.worktreeRoot,
    repositoryCwd: repository.repositoryCwd,
    repositoryGitDir: repository.gitDir,
    repositoryGitCommonDir: repository.gitCommonDir,
    repositoryKind: repository.worktreeKind,
    memoryDocumentRoot: repository.worktreeRoot,
    repositoryAdmission,
    ...(options.treehouse ? { treehouse: Object.freeze({ ...options.treehouse }) } : {}),
    ...(rogueOne ? { rogue_one: true as const, invocation_channel: invocationChannel } : {}),
    ...(options.request.ticket ? { ticket: options.request.ticket } : {}),
    ticketRequired,
    objective: rogueOne
      ? options.request.objective ?? "No user objective was provided."
      : options.request.objective ?? options.mode?.objective ?? options.teamConfig.objective,
    ...(options.request.objective ? { userObjectiveOverride: options.request.objective } : {}),
    skills: Object.freeze(skills),
    memoryDocuments: Object.freeze(rogueOne ? [] : [
      ...(options.teamConfig.global_docs ?? []),
      ...(options.mode?.global_docs ?? []),
      ...(options.mode?.project_guides?.[repository.repoKey] ?? []),
    ]),
    environment: Object.freeze({
      ...options.environment,
      PA_REPO: repository.repoRoot,
      PA_WORKTREE_ROOT: repository.worktreeRoot,
      ...(options.treehouse ? {
        PA_TREEHOUSE_LEASE_ID: options.treehouse.leaseId,
        PA_TREEHOUSE_LEASE_HOLDER: options.treehouse.leaseHolder,
        PA_TICKET_SLOT: options.treehouse.ticketSlotId,
        PA_REPOSITORY_PERMIT: String(options.treehouse.repositoryPermit),
      } : {}),
      ...(rogueOne ? { PA_TEAM: options.teamConfig.name, PA_MODE: modeName, PA_ROGUE_ONE: "1" } : {}),
    }),
    timeoutSeconds: options.timeoutSeconds,
    ...(options.request.provider ? { provider: options.request.provider } : {}),
    ...(options.request.model ? { model: options.request.model } : {}),
    ...(options.trustedExtensionPath ? { trustedExtension: options.trustedExtensionPath } : {}),
    lifecycle,
  });
}

function resolveBranchTransitionPolicy(executionRepo: ReturnType<typeof resolveRepoExecutionPath>["repo"], ticketId: string): RepositoryBranchTransitionPolicy | undefined {
  const ticket = new TicketStore().get(ticketId);
  if (!ticket) return undefined;
  const ticketRepo = loadRepoEntry(ticket.project);
  if (!ticketRepo) return undefined;
  return Object.freeze({
    developBranch: executionRepo.developBranch ?? "develop",
    executionFeatureBranchPattern: getBranchPattern(executionRepo),
    ticketProject: ticket.project,
    ticketFeatureBranchPattern: getBranchPattern(ticketRepo),
  });
}
