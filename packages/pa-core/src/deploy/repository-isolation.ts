import { hasModeResources, MODE_CAPABILITY_MAX_BYTES, parseModeCapabilityBinding } from "../mode-capabilities.js";
import { queryReadonlyIsolationLineage, queryReadonlyOrdinaryResume } from "../registry/index.js";
import { isPlainInteractiveMode, type DeployRequest } from "./control.js";
import type { DeployMode, TeamConfig } from "../types.js";
import type { ExecutionPlan } from "./plan.js";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { getDeployPaths } from "./paths.js";

/** This release has no qualified transactional protected Analyst executor. In particular,
 * read-only mounts plus a writable shared-root bind are NOT sufficient: hard
 * links, non-atomic shell moves and host delegates remain counterexamples.
 * There is intentionally no environment/config/approval override or grant API.
 * Rejecting launch is a safety measure, not a usable isolation implementation. */
export class RepositoryIsolationUnavailableError extends Error {
  readonly code = "REPOSITORY_ISOLATION_UNAVAILABLE";
  constructor() {
    super("Execution not started: repository-isolation scope is unavailable.\nCondition: The requested new or resumed executor cannot start safely.\nSource: Managed repository-isolation admission (REPOSITORY_ISOLATION_UNAVAILABLE).\nReason: A permitted execution scope is not established. Protected Analyst and read-only document execution have no qualified boundary for all-repository protection, transactional shared-file moves and host delegation. Missing or conflicting native launch, session or ancestry evidence cannot establish a safe resume. Prompts and approval are not confinement.\nCorrection: Ask the runtime owner to inspect the original launch/session evidence and executor support. Impact: read-only. Actor: agent or operator. New approval: not required for inspection; implementation and adoption need their existing authority. Prerequisite: preserve the original deployment, ticket and partial results; do not disable hooks or substitute a writer.\nResume Action: Retry the original launch only with matching native provenance and current custody. Protected Analyst execution requires a qualified transactional executor; instruction-only foreground Pi Analyst instead requires an eligible ordinary route and matching native evidence. Existing sessions are not upgraded, terminated or reconciled by this rejection.");
    this.name = "RepositoryIsolationUnavailableError";
  }
}

export interface RepositoryIsolationSelection { team?: string; mode?: string; documentProfile?: string; instructionOnly?: boolean }

/** Internal route classification from resolved configuration and launcher facts,
 * never from an environment flag. This is ordinary execution, NOT confinement. */
export function repositoryIsolationSelection(team: TeamConfig, mode: DeployMode | undefined, request: DeployRequest, runtime: string): RepositoryIsolationSelection {
  return { team: team.name, mode: mode?.id, documentProfile: mode?.document_profile,
    instructionOnly: team.name === "analyst" && request.team === team.name && mode?.id === "analyze"
      && isPlainInteractiveMode(mode) && runtime === "pi" && (request.runtime === undefined || request.runtime === "pi")
      && !request.background && !request.ticketWorktree && !request.force
      && (request.invocationChannel === undefined || request.invocationChannel === "cli")
      && !team.deploy_modes?.some(entry => entry.document_profile === "pa-readonly-document/v1") };
}

/** Classification uses existing trusted team/mode/profile selection only. No new
 * PAPC field, workflow engine, per-repository exception or caller scope claim. */
export function requiresRepositoryIsolation(selection: RepositoryIsolationSelection): boolean {
  return selection.team?.toLowerCase() === "analyst"
    || selection.team === "requirements" && selection.mode === "analyze"
    || selection.documentProfile === "pa-readonly-document/v1";
}

export function assertRepositoryIsolationAvailable(selection: RepositoryIsolationSelection): void {
  if ([selection.team, selection.mode, selection.documentProfile].some(value => value !== undefined && typeof value !== "string")) throw new RepositoryIsolationUnavailableError();
  if (requiresRepositoryIsolation(selection) && !(selection.instructionOnly === true && selection.team === "analyst"
    && selection.mode === "analyze" && selection.documentProfile === undefined)) throw new RepositoryIsolationUnavailableError();
}

/** Read existing native evidence, never initialize registry state. A changed
 * public selector (including Rogue-one) cannot turn a retained protected resume
 * into an unconfined execution. Missing/invalid evidence stays unavailable. */
export function assertRepositoryIsolationResumeAvailable(deploymentId?: string, runtime?: string, selection?: RepositoryIsolationSelection): void {
  if (deploymentId === undefined) return;
  try {
    if (selection?.instructionOnly) {
      const prior = queryReadonlyOrdinaryResume(deploymentId);
      if (prior.team !== "analyst" || prior.mode !== "analyze" || prior.runtime !== "pi" || prior.binary !== "ppa"
        || (runtime !== undefined && runtime !== "pi")) throw new RepositoryIsolationUnavailableError();
    }
    for (const prior of queryReadonlyIsolationLineage(deploymentId, runtime)) {
      // Terminal events need not repeat mode; the complete ordinary reader above
      // has already proved every start/projection and ancestry identity.
      assertRepositoryIsolationAvailable({ team: prior.team, mode: prior.mode ?? (selection?.instructionOnly ? "analyze" : undefined), instructionOnly: selection?.instructionOnly });
      // Retained protocol evidence cannot be erased by missing bindings or a
      // writer-labelled projection. These existing document protocols require
      // protected execution; an unrecognized revision is not a safe downgrade.
      if (prior.note?.startsWith("requirements-document-") || prior.note?.startsWith("readonly-document-policy/")) throw new RepositoryIsolationUnavailableError();
      if (prior.binding !== undefined) {
        if (Buffer.byteLength(prior.binding) > MODE_CAPABILITY_MAX_BYTES) throw new RepositoryIsolationUnavailableError();
        assertRepositoryIsolationBindingAvailable(JSON.parse(prior.binding));
      }
    }
  } catch { throw new RepositoryIsolationUnavailableError(); }
}

/** Immutable binding identities are restrictive even under a writer selector. */
export function assertRepositoryIsolationBindingAvailable(value: unknown): void {
  try {
    const binding = parseModeCapabilityBinding(value);
    assertRepositoryIsolationAvailable({ documentProfile: binding.profile });
    if (hasModeResources(binding)) {
      assertRepositoryIsolationAvailable({ team: binding.identity.publicTeam, mode: binding.identity.publicMode });
      assertRepositoryIsolationAvailable({ team: binding.identity.effectiveTeam, mode: binding.identity.effectiveMode });
    } else assertRepositoryIsolationAvailable({ team: "requirements", mode: "analyze" });
  } catch { throw new RepositoryIsolationUnavailableError(); }
}

/** Check originals AND their effective overlay; no source may erase another. */
export function assertRepositoryIsolationIngressAvailable(sources: readonly (NodeJS.ProcessEnv | undefined)[], plan?: ExecutionPlan, foregroundPi = false): RepositoryIsolationSelection {
  try {
    const selection: RepositoryIsolationSelection = { team: plan?.team, mode: plan?.mode,
      instructionOnly: foregroundPi && plan?.runtime === "pi" && plan.team === "analyst" && plan.mode === "analyze"
        && plan.invocation_channel === "cli" && plan.repositoryAdmission?.plainInteractive === true
        && plan.repositoryAdmission.launchMode === "foreground" && !plan.repositoryAdmission.force
        && plan.repositoryAdmission.access === "non-locking" && plan.repositoryAdmission.ownershipIntent === "none"
        && !plan.modeCapabilityBinding && !plan.treehouse && !plan.reviewCheckout && !plan.ticketWorktreeSelection && !plan.rogue_one };
    const environments = [...sources, plan?.environment];
    for (const env of environments) if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env))) throw new RepositoryIsolationUnavailableError();
    const merged = Object.assign({}, ...sources);
    const planned = Object.assign({}, merged, plan?.environment);
    for (const env of [...environments, merged, planned]) {
      if (selection.instructionOnly && (env?.["PA_TEAM"] !== undefined && env["PA_TEAM"] !== plan!.team
        || env?.["PA_MODE"] !== undefined && env["PA_MODE"] !== plan!.mode)) throw new RepositoryIsolationUnavailableError();
      assertRepositoryIsolationAvailable({ team: env?.["PA_TEAM"], mode: env?.["PA_MODE"], instructionOnly: selection.instructionOnly });
    }
    if (plan) {
      assertRepositoryIsolationAvailable(selection);
      if (plan.environment?.["PA_TEAM"] !== undefined && plan.environment["PA_TEAM"] !== plan.team
        || plan.environment?.["PA_MODE"] !== undefined && plan.environment["PA_MODE"] !== plan.mode) throw new RepositoryIsolationUnavailableError();
      if (plan.modeCapabilityBinding !== undefined) assertRepositoryIsolationBindingAvailable(plan.modeCapabilityBinding);
    }
    return selection;
  } catch { throw new RepositoryIsolationUnavailableError(); }
}

/** Shared safe I/O for the runtime-specific session reader owners. No following
 * links (including parent aliases), special files or multiply linked evidence. */
export function readRecordedRuntimeSession(deploymentId: string, fileName: string): string {
  if (!/^d-[a-f0-9]{6}$/.test(deploymentId) || !/^session-id-(pi|opencode)\.txt$/.test(fileName)) throw new RepositoryIsolationUnavailableError();
  const dir = getDeployPaths(deploymentId).deployDir, path = resolve(dir, fileName);
  const directory = lstatSync(dir);
  if (realpathSync(dir) !== resolve(dir) || !directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) throw new RepositoryIsolationUnavailableError();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new RepositoryIsolationUnavailableError();
    const value = readFileSync(fd, "utf8").trim();
    const after = fstatSync(fd), named = lstatSync(path), currentDirectory = lstatSync(dir);
    if (after.nlink !== 1 || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino
      || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino || realpathSync(dir) !== resolve(dir)) throw new RepositoryIsolationUnavailableError();
    if (value && !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new RepositoryIsolationUnavailableError();
    return value;
  } finally { closeSync(fd); }
}
