import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  advanceParentAuthoritySnapshot,
  appendActivityEvent,
  assertRepositoryGitIdentity,
  captureRepositoryGitSnapshot,
  createActivityEvent,
  ensureTerminalRegistryMarker,
  finalizeRepositoryMutationBorrower,
  finalizeRepositoryMutationLease,
  formatBoundedFiveFieldDiagnostic,
  getDeployPaths,
  readProcessFingerprint,
  queryDeploymentStatus,
  reconcileTerminalRegistryEvent,
  refreshTicketLinkedBranchHead,
  releaseRepositoryTicketSlot,
  transferRepositoryMutationBorrower,
  transferRepositoryMutationLease,
  transferRepositoryTicketSlot,
  type RegistryEvent,
  type ProcessFingerprint,
  type RepositoryGitSnapshot,
  type RepositoryReviewReservation,
  type ValidationEvent,
} from "@pa-platform/pa-core";
import {
  buildPiBackgroundArgs,
  PI_PARENT_LEASE_CAPABILITY_ENV,
  PI_REPOSITORY_HANDOFF_FILE,
  PI_SUPERVISOR_FILE,
  readPiBackgroundConfig,
  readPiRepositoryHandoff,
  runPiManagedProcess,
  writePiSupervisorOwnership,
  type PiBackgroundConfig,
  type PiCommandResult,
  type PiSupervisionOptions,
  type PiSupervisorOwnership,
} from "./adapter.js";
import { environmentSecrets, PiRedactionAudit } from "./diagnostics.js";
import { piRegistryEnvironment } from "./native-host.js";
import { readPiTerminalStatus, writePiTerminalStatus } from "./terminal-status.js";
import { assertPiMatrixStartedForLaunch, withPiReviewCandidateAtMatrixBoundary, withPiNixosPrerequisites } from "./validation-launch.js";
import { finalizePiReviewCandidate, rereadPiReviewCandidate, reconcilePiTerminalChild, terminalSettlementUnavailable } from "./deploy.js";
import {
  PI_VALIDATION_HANDOFF_FILE,
  readPiProtectedValidationLaunch,
  runPiValidationBeforeReviewer,
  type PiProtectedValidationLaunch,
  type PiReviewerValidationContext,
} from "./validation-supervisor.js";

const FINALIZATION_DEADLINE_MS = 5_000;
const ACTIVITY_DIAGNOSTIC_MAX = 500;
const TERMINAL_DIAGNOSTIC_MAX = 2_000;

export interface PiBackgroundRunnerOptions {
  /** Trusted fixture seam only; never supplied by runner config, environment or requests. */
  reviewBoundary?: typeof withPiReviewCandidateAtMatrixBoundary;
  supervision?: PiSupervisionOptions;
  now?: () => Date;
  shutdownSignal?: AbortSignal;
}

export async function runPiBackgroundRunner(config: PiBackgroundConfig, options: PiBackgroundRunnerOptions = {}): Promise<void> {
  const deployDir = dirname(config.primerPath);
  const ownershipPath = resolve(deployDir, PI_SUPERVISOR_FILE);
  const now = options.now ?? (() => new Date());
  const secrets = environmentSecrets(process.env);
  const audit = new PiRedactionAudit(config.deploymentId, deployDir);
  let childPid: number | undefined;
  let childFingerprint: ProcessFingerprint | undefined;
  let normalExecutionExit: number | undefined;
  let ready = false;
  let repositoryLease = config.repositoryLease;
  let repositoryBorrower = config.repositoryBorrower;
  let repositoryLeaseTransferred = false;
  let repositoryBorrowerTransferred = false;
  let repositoryTicketSlotTransferred = false;
  let terminalGitSnapshot: RepositoryGitSnapshot | undefined;
  let advanceBorrowedParentAuthority = false;
  let terminalRegistryEvidence = config.registryEvidence;
  let finalState: PiSupervisorOwnership["state"] = "failed";
  let reviewReservation: RepositoryReviewReservation | undefined;
  let reviewExecutionTerminated = true;
  let matrixExecutionTerminated = true;

  const ownership = (state: PiSupervisorOwnership["state"], extra: Partial<PiSupervisorOwnership> = {}): PiSupervisorOwnership => ({
    schemaVersion: 1,
    deploymentId: config.deploymentId,
    ownershipToken: config.ownershipToken,
    state,
    ready: ready || state === "active" || state === "finalizing" || state === "finalized",
    supervisorPid: process.pid,
    ...(childPid ? { childPid } : {}),
    updatedAt: now().toISOString(),
    finalizationDeadlineMs: FINALIZATION_DEADLINE_MS,
    ...extra,
  });

  const terminateChild = (): void => {
    if (!childPid) return;
    try { process.kill(-childPid, "SIGTERM"); } catch { try { process.kill(childPid, "SIGTERM"); } catch { /* already gone */ } }
  };
  const shutdown = new AbortController();
  const abortFor = (signal: string): void => { if (!shutdown.signal.aborted) shutdown.abort(signal); };
  const onSigterm = (): void => abortFor("SIGTERM");
  const onSigint = (): void => abortFor("SIGINT");
  const onExternalShutdown = (): void => abortFor(typeof options.shutdownSignal?.reason === "string" ? options.shutdownSignal.reason : "signal");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  options.shutdownSignal?.addEventListener("abort", onExternalShutdown, { once: true });
  if (options.shutdownSignal?.aborted) onExternalShutdown();

  try {
    writePiSupervisorOwnership(ownershipPath, ownership("starting"));
    assertTreehouseRuntimeEnvironment(config, process.env);
    if (config.repositoryHandoffPath) {
      try {
        if (config.repositoryHandoffPath !== resolve(deployDir, PI_REPOSITORY_HANDOFF_FILE)) throw new Error("runner-readiness: repository handoff path mismatch");
        const handoff = readPiRepositoryHandoff(config.repositoryHandoffPath);
        if (handoff.deploymentId !== config.deploymentId) throw new Error("runner-readiness: repository handoff deployment identity mismatch");
        const authority = handoff.repositoryLease ?? handoff.repositoryBorrower;
        const authorityWorktreeRoot = authority?.worktreeRoot ?? authority?.canonicalRepoRoot;
        if (config.managed && (!authority
          || authority.canonicalRepoRoot !== config.repoRoot
          || authorityWorktreeRoot !== config.worktreeRoot
          || (handoff.repositoryLease?.slot !== undefined && handoff.repositoryLease.slot !== config.repositorySlot))) {
          throw new Error("runner-readiness: repository handoff roots or slot do not match the managed background configuration");
        }
        if (authority && authorityWorktreeRoot) {
          try { assertRepositoryGitIdentity(authorityWorktreeRoot, authority.repositoryGitDir, authority.repositoryGitCommonDir); }
          catch { throw new Error("runner-readiness: protected repository handoff identity does not match the managed execution worktree"); }
        }
        repositoryLease = handoff.repositoryLease;
        repositoryBorrower = handoff.repositoryBorrower;
        for (const value of [repositoryLease?.ownershipToken, repositoryBorrower?.borrowerToken]) {
          if (value && !secrets.includes(value)) secrets.push(value);
        }
      } finally {
        try { unlinkSync(config.repositoryHandoffPath); } catch { /* missing or consumed protected handoff remains a causal failure */ }
      }
    }
    if (repositoryLease || repositoryBorrower) {
      const fingerprint = readProcessFingerprint(process.pid);
      if (!fingerprint) throw new Error(`runner-readiness: cannot verify repository supervisor PID ${process.pid}`);
      if (repositoryLease) {
        const transfer = transferRepositoryMutationLease({
          canonicalRepoRoot: repositoryLease.canonicalRepoRoot,
          worktreeRoot: repositoryLease.worktreeRoot,
          repositoryGitDir: repositoryLease.repositoryGitDir,
          repositoryGitCommonDir: repositoryLease.repositoryGitCommonDir,
          slot: repositoryLease.slot,
          ownershipToken: repositoryLease.ownershipToken,
          nextProcessFingerprint: fingerprint,
        });
        if (transfer.status !== "transferred") throw new Error(`runner-readiness: repository ownership transfer failed (${transfer.status})`);
        repositoryLeaseTransferred = true;
        if (repositoryLease.ticketSlot) {
          const slotTransfer = transferRepositoryTicketSlot({ ...repositoryLease.ticketSlot, nextProcessFingerprint: fingerprint });
          if (slotTransfer.status !== "transferred") throw new Error(`runner-readiness: repository ticket-slot transfer failed (${slotTransfer.status})`);
          repositoryTicketSlotTransferred = true;
        }
      } else if (repositoryBorrower) {
        if (repositoryBorrower.deploymentId !== config.deploymentId) throw new Error("runner-readiness: repository borrower deployment identity mismatch");
        const transfer = transferRepositoryMutationBorrower({
          canonicalRepoRoot: repositoryBorrower.canonicalRepoRoot,
          worktreeRoot: repositoryBorrower.worktreeRoot,
          repositoryGitDir: repositoryBorrower.repositoryGitDir,
          repositoryGitCommonDir: repositoryBorrower.repositoryGitCommonDir,
          borrowerToken: repositoryBorrower.borrowerToken,
          nextProcessFingerprint: fingerprint,
        });
        if (transfer.status !== "transferred") throw new Error(`runner-readiness: repository borrower transfer failed (${transfer.status})`);
        repositoryBorrowerTransferred = true;
      }
    }
    const runtimeEnvironment = { ...process.env };
    if (repositoryBorrower) delete runtimeEnvironment[PI_PARENT_LEASE_CAPABILITY_ENV];
    const childEnv = piRegistryEnvironment(runtimeEnvironment);
    const startReviewer = (reviewerContext?: PiReviewerValidationContext): Promise<PiCommandResult> => runPiManagedProcess(
      buildPiBackgroundArgs(config, reviewerContext),
      config.cwd,
      childEnv,
      {
        primerPath: config.primerPath,
        deployId: config.deploymentId,
        mode: "dry-run",
        logFile: config.logFile,
        sessionId: config.sessionId,
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
      },
      config.sessionId,
      secrets,
      {
        ...(options.supervision ?? {}),
        shutdownSignal: shutdown.signal,
        onSpawn: (pid) => {
          reviewExecutionTerminated = false;
          childPid = pid;
          childFingerprint = readProcessFingerprint(pid);
          ready = true;
          writePiSupervisorOwnership(ownershipPath, ownership("active"));
          options.supervision?.onSpawn?.(pid);
        },
      },
    );
    let result: PiCommandResult;
    if (config.validationHandoffPath) {
      let validationLaunch: PiProtectedValidationLaunch;
      try {
        if (config.validationHandoffPath !== resolve(deployDir, PI_VALIDATION_HANDOFF_FILE)) throw new Error("runner-readiness: validation handoff path mismatch");
        validationLaunch = readPiProtectedValidationLaunch(config.validationHandoffPath);
        if (validationLaunch.deploymentId !== config.deploymentId) throw new Error("runner-readiness: validation handoff deployment identity mismatch");
        reviewReservation = validationLaunch.reservation;
        if (!reviewReservation || !validationLaunch.review.checkout?.approvedReference || !reviewReservation.checkout.approvedReference
          || config.cwd !== reviewReservation.checkout.worktreeRoot
          || config.repoRoot !== reviewReservation.checkout.repoRoot || config.worktreeRoot !== config.cwd
          || process.env["PA_REPO"] !== config.cwd || process.env["PA_WORKTREE_ROOT"] !== config.cwd) {
          throw new Error("Condition: protected review runner identity. Source: protected handoff and runtime environment. Reason: exact reserved candidate roots are absent or mismatched. Correction: preserve the checkout and reservation. Resume Action: launch only with matching protected evidence.");
        }
        secrets.push(reviewReservation.reservationToken);
        assertPiMatrixStartedForLaunch(deployDir, validationLaunch);
        if (!secrets.includes(validationLaunch.review.authorizationId)) secrets.push(validationLaunch.review.authorizationId);
      } finally {
        try { unlinkSync(config.validationHandoffPath); } catch { /* missing or consumed protected handoff remains a causal failure */ }
      }
      const validationRoot = resolve(deployDir, "validation-evidence");
      const ledgerPath = resolve(validationRoot, "ledger.json");
      const supervised = await runPiValidationBeforeReviewer(validationLaunch, {
        evidenceRoot: validationRoot,
        ledgerPath,
        now,
        abortSignal: shutdown.signal,
        emit: (event) => appendValidationActivity(config.deploymentId, event, secrets),
        beforeExecute: (launch) => {
          assertPiMatrixStartedForLaunch(deployDir, launch);
          (options.reviewBoundary ?? withPiReviewCandidateAtMatrixBoundary)({ launch, reservation: reviewReservation!,
            rereadCheckout: () => rereadPiReviewCandidate(reviewReservation!.checkout) }, () => {
            assertPiMatrixStartedForLaunch(deployDir, launch);
            // Readiness acknowledges protected matrix admission, not just handoff consumption.
            // Publish only after the serialized candidate reread so rejection cannot race a pending response.
            matrixExecutionTerminated = false;
            ready = true;
            writePiSupervisorOwnership(ownershipPath, ownership("active"));
          });
        },
        onMatrixTerminationVerified: () => { matrixExecutionTerminated = true; },
        revalidateNixosPrerequisites: (launch, execute) => withPiNixosPrerequisites(launch, execute,
          () => rereadPiReviewCandidate(reviewReservation!.checkout)),
        beforeReviewer: (launch) => {
          assertPiMatrixStartedForLaunch(deployDir, launch);
          if (launch.review.matrixSource.startsWith("requirements:")) {
            // A successful command exit cannot certify that the candidate stayed
            // immutable. Reauthenticate after the matrix before exposing it to Pi.
            (options.reviewBoundary ?? withPiReviewCandidateAtMatrixBoundary)({ launch, reservation: reviewReservation!,
              rereadCheckout: () => rereadPiReviewCandidate(reviewReservation!.checkout) }, () => undefined);
          }
        },
        startReviewer,
      });
      if (!supervised.admitted) {
        matrixExecutionTerminated = true; // explicit admission rejection starts no matrix
        reviewExecutionTerminated = true; // no reviewer was started
        throw new Error(`runner-readiness: ${formatBoundedFiveFieldDiagnostic(supervised.diagnostic)}`);
      }
      result = supervised.reviewerResult;
      reviewExecutionTerminated = result.metadata?.["cleanupVerified"] !== false;
    } else {
      result = await startReviewer();
    }

    if (!ready || !childPid) throw new Error("runner-spawn: Pi child did not expose a process id");
    if (result.metadata?.["normalExit"] === true && typeof result.metadata["rawExitCode"] === "number"
      && result.metadata["cleanupVerified"] !== false && !shutdown.signal.aborted) normalExecutionExit = result.metadata["rawExitCode"];
    writePiSupervisorOwnership(ownershipPath, ownership("finalizing"));
    const authority = repositoryLease ?? repositoryBorrower;
    if (authority) {
      const worktreeRoot = authority.worktreeRoot ?? authority.canonicalRepoRoot;
      try {
        assertRepositoryGitIdentity(worktreeRoot, authority.repositoryGitDir, authority.repositoryGitCommonDir);
      } catch {
        if (repositoryBorrower) {
          terminalGitSnapshot = captureRepositoryGitSnapshot(worktreeRoot, undefined, {
            repositoryGitDir: authority.repositoryGitDir,
            repositoryGitCommonDir: authority.repositoryGitCommonDir,
          });
        }
        throw new Error("runner-terminal: Condition: repository metadata identity drift. Source: post-runtime physical Git-dir/common-dir re-authentication. Reason: the execution worktree no longer resolves to its admitted identity. Correction: preserve replacement metadata and repository state for diagnosis. Resume Action: repair metadata only under operator control, then launch a fresh deployment.");
      }
      terminalGitSnapshot = captureRepositoryGitSnapshot(worktreeRoot, undefined, {
        repositoryGitDir: authority.repositoryGitDir,
        repositoryGitCommonDir: authority.repositoryGitCommonDir,
      });
      if (config.registryEvidence?.builder_authority === "parented-implement") {
        terminalRegistryEvidence = { ...config.registryEvidence, branch_head_sha: terminalGitSnapshot.head };
        config.registryEvidence = terminalRegistryEvidence;
      }
      if (repositoryLease?.ticketSlot) {
        const refreshed = refreshTicketLinkedBranchHead({
          canonicalRepoKey: repositoryLease.ticketSlot.canonicalRepoKey,
          canonicalRepoRoot: repositoryLease.canonicalRepoRoot,
          worktreeRoot,
          ticketId: repositoryLease.ticketSlot.ticket,
        });
        if (terminalRegistryEvidence) {
          terminalRegistryEvidence = {
            ...terminalRegistryEvidence,
            branch_state: "materialized",
            branch_base_sha: refreshed.baseSha,
            branch_head_sha: refreshed.headSha!,
          };
          config.registryEvidence = terminalRegistryEvidence;
        }
      }
      if (!repositoryLease?.ticketSlot && config.registryEvidence && config.registryEvidence.builder_authority !== "parented-implement" && config.repoKey && config.ticketId) {
        const refreshed = refreshTicketLinkedBranchHead({
          canonicalRepoKey: config.repoKey,
          canonicalRepoRoot: authority.canonicalRepoRoot,
          worktreeRoot,
          ticketId: config.ticketId,
        });
        terminalRegistryEvidence = {
          ...config.registryEvidence,
          branch_state: "materialized",
          branch_base_sha: refreshed.baseSha,
          branch_head_sha: refreshed.headSha!,
        };
        config.registryEvidence = terminalRegistryEvidence;
      }
    }
    const terminal = finalizeRunnerResult(config, deployDir, result, secrets, now());
    advanceBorrowedParentAuthority = terminal.status === "success";
    finalState = "finalized";
    writePiSupervisorOwnership(ownershipPath, ownership("finalized", { terminalEvent: terminal.event, terminalStatus: terminal.status }));
    audit.observe("background-diagnostic", terminal.diagnostic, secrets);
  } catch (error) {
    terminateChild();
    const reason = bounded(categoryForRunnerError(error), secrets, TERMINAL_DIAGNOSTIC_MAX);
    try {
      const terminal = finalizeRunnerFailure(config, deployDir, reason, secrets, now());
      writePiSupervisorOwnership(ownershipPath, ownership(finalState, { error: reason, terminalEvent: terminal.event, terminalStatus: terminal.status }));
      audit.observe("background-diagnostic", terminal.diagnostic, secrets);
    } catch (finalizationError) {
      const combined = bounded(`runner-persistence: ${reason}; ${categoryForRunnerError(finalizationError)}`, secrets, TERMINAL_DIAGNOSTIC_MAX);
      try {
        writePiSupervisorOwnership(ownershipPath, ownership("failed", { error: combined }));
        audit.observe("background-diagnostic", combined, secrets);
      } catch { /* launcher/status retains the causal readiness failure */ }
    }
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    options.shutdownSignal?.removeEventListener("abort", onExternalShutdown);
    try {
      let authorityFailure: string | undefined;
      if (reviewReservation && matrixExecutionTerminated && reviewExecutionTerminated) {
        try { finalizePiReviewCandidate(reviewReservation, deployDir, true); }
        catch { authorityFailure = "Condition: review terminal finalization stopped. Source: trusted supervisor. Reason: durable matching final evidence could not be published; reservation retained. Correction: preserve checkout and lease custody. Resume Action: reconcile terminal evidence before another review."; }
      }
      const exactTerminalChild = repositoryBorrowerTransferred && repositoryBorrower && config.registryEvidence?.builder_authority === "parented-implement";
      if (exactTerminalChild && repositoryBorrower) {
        if (normalExecutionExit === undefined || !childFingerprint || !config.repoKey || !config.ticketId) authorityFailure = terminalSettlementUnavailable();
        else {
          const settlement = reconcilePiTerminalChild({ ...repositoryBorrower, canonicalRepoKey: config.repoKey,
            worktreeRoot: repositoryBorrower.worktreeRoot ?? repositoryBorrower.canonicalRepoRoot,
            childDeploymentId: config.deploymentId, ticket: config.ticketId,
            execution: { source: "background-supervisor", exitCode: normalExecutionExit, processes: [childFingerprint] } });
          if (settlement.outcome === "blocked") authorityFailure = settlement.diagnostic ?? terminalSettlementUnavailable();
        }
      } else if (repositoryBorrowerTransferred && repositoryBorrower) {
        const finalization = finalizeRepositoryMutationBorrower({
          canonicalRepoRoot: repositoryBorrower.canonicalRepoRoot,
          worktreeRoot: repositoryBorrower.worktreeRoot,
          repositoryGitDir: repositoryBorrower.repositoryGitDir,
          repositoryGitCommonDir: repositoryBorrower.repositoryGitCommonDir,
          borrowerToken: repositoryBorrower.borrowerToken,
          deploymentId: config.deploymentId,
          advanceParentAuthority: advanceBorrowedParentAuthority,
          ...(terminalGitSnapshot ? { finalGitSnapshot: terminalGitSnapshot } : {}),
          ...(config.registryEvidence?.builder_authority === "parented-implement" ? { dependencies: { publishParentAuthoritySnapshot: advanceParentAuthoritySnapshot } } : {}),
        });
        switch (finalization.status) {
          case "finalized":
            break;
          case "scope-noncompliant":
            authorityFailure = "Condition: inherited repository admission approved-path-containment. Source: complete final Git snapshot. Reason: final state contains a path or branch outside Sinh's exact approved scope. Correction: preserve state and obtain a fresh parent decision. Resume Action: do not replay the consumed receipt; launch only after new approval.";
            break;
          case "uncertain-live":
            authorityFailure = "Condition: inherited repository admission uncertain-live. Source: matching borrower finalization. Reason: runner death remains unverifiable and blocking finalizing evidence was retained. Correction: preserve the evidence and verify runner termination. Resume Action: finalize only after verified death; dispatch no sibling or unrelated builder.";
            break;
          case "absent":
          case "invalid-evidence":
          case "token-mismatch":
            authorityFailure = `Condition: inherited repository admission finalization-${finalization.status}. Source: matching borrower finalization. Reason: authority cleanup did not complete (${finalization.status}). Correction: preserve repository state and reconcile matching evidence. Resume Action: do not report the original outcome or dispatch another builder until authority is finalized.`;
            break;
        }
      }
      if (repositoryLeaseTransferred && repositoryLease) {
        const finalization = await finalizeRepositoryMutationLease({
          canonicalRepoRoot: repositoryLease.canonicalRepoRoot,
          worktreeRoot: repositoryLease.worktreeRoot,
          repositoryGitDir: repositoryLease.repositoryGitDir,
          repositoryGitCommonDir: repositoryLease.repositoryGitCommonDir,
          slot: repositoryLease.slot,
          ownershipToken: repositoryLease.ownershipToken,
        });
        switch (finalization.status) {
          case "released":
            break;
          case "absent":
          case "invalid-evidence":
          case "token-mismatch":
          case "borrower-live":
          case "borrower-invalid":
          case "transferred":
          case "updated":
            authorityFailure ??= `Condition: repository owner finalization-${finalization.status}. Source: matching lease finalization. Reason: authority cleanup did not complete (${finalization.status}). Correction: preserve repository state and reconcile matching evidence. Resume Action: dispatch no builder until authority is finalized.`;
            break;
        }
      }
      if (repositoryTicketSlotTransferred && repositoryLease?.ticketSlot) {
        const release = releaseRepositoryTicketSlot(repositoryLease.ticketSlot);
        if (release.status !== "released" && release.status !== "absent") {
          authorityFailure ??= `Condition: repository ticket concurrency finalization. Source: matching PA ticket slot. Reason: cleanup did not complete (${release.status}). Correction: preserve Treehouse lease and branch. Resume Action: reconcile only the matching slot token before another launch.`;
        }
      }
      if (authorityFailure) {
        finalState = "failed";
        const reason = bounded(authorityFailure, secrets, TERMINAL_DIAGNOSTIC_MAX);
        if (exactTerminalChild) {
          // Settlement failure is not permission to rewrite software partial or
          // failed outcomes. Retain it separately and leave matching proof intact.
          writePiSupervisorOwnership(ownershipPath, ownership("failed", { error: reason, terminalStatus: "failed" }));
          writePiTerminalStatus(deployDir, { type: "agent_end", stopReason: "error", error: reason, timestamp: now().toISOString() });
          audit.observe("background-diagnostic", reason, secrets);
        } else {
          const terminal = finalizeRunnerFailure(config, deployDir, reason, secrets, now());
          writePiSupervisorOwnership(ownershipPath, ownership("failed", { error: reason, terminalEvent: terminal.event, terminalStatus: terminal.status }));
          audit.observe("background-diagnostic", terminal.diagnostic, secrets);
        }
      }
    } finally {
      ensureTerminalRegistryMarker({ deploymentId: config.deploymentId, team: config.team });
    }
  }
}

function assertTreehouseRuntimeEnvironment(config: PiBackgroundConfig, env: NodeJS.ProcessEnv): void {
  if (!config.registryEvidence) return;
  const worktreeRoot = config.worktreeRoot;
  const exact = typeof config.repoRoot === "string"
    && typeof worktreeRoot === "string"
    && config.cwd === worktreeRoot
    && config.registryEvidence.treehouse_path === worktreeRoot
    && env["PA_REPO"] === worktreeRoot
    && env["PA_WORKTREE_ROOT"] === worktreeRoot;
  if (!exact) {
    throw new Error("runner-readiness: Condition: Treehouse runtime repository identity. Source: protected background configuration, registry correlation, and inherited process environment. Reason: PA_REPO, PA_WORKTREE_ROOT, CWD, and authenticated Treehouse path do not agree exactly. Correction: preserve the checkout, lease, branch, slot, and permit; reconcile protected evidence without starting Pi. Resume Action: launch a fresh PPA builder only after the exact worktree identity agrees.");
  }
}

function finalizeRunnerResult(config: PiBackgroundConfig, deployDir: string, result: PiCommandResult, secrets: string[], at: Date): { event: "completed" | "crashed"; status: "success" | "failed"; diagnostic: string } {
  const terminalError = typeof result.metadata?.["terminalError"] === "string" ? result.metadata["terminalError"] : undefined;
  const ok = result.status === 0 && !terminalError;
  const failure = terminalError
    ? `runner-terminal: ${terminalError}`
    : result.status === 124
      ? `runner-timeout: ${result.spawnError?.message ?? "Pi deployment timed out"}`
      : result.status === null
        ? `runner-spawn: ${result.spawnError?.message ?? (result.stderr || "Pi could not be spawned")}`
        : result.spawnError && /^runner-(?:shutdown|timeout|process|persistence|terminal|spawn):/.test(result.spawnError.message)
          ? result.spawnError.message
        : result.spawnError && /persist|write|rename|registry|database|sqlite/i.test(result.spawnError.message)
          ? `runner-persistence: ${result.spawnError.message}`
          : `runner-process: ${result.stderr || result.spawnError?.message || `Pi exited with code ${result.status}`}`;
  const reason = bounded(ok ? "ppa deploy completed" : `ppa deploy failed: ${failure}`, secrets, TERMINAL_DIAGNOSTIC_MAX);
  if (!ok) appendRunnerError(config.deploymentId, deployDir, reason, secrets);
  return { ...reconcileRunnerTerminal(config, deployDir, {
    deployment_id: config.deploymentId,
    team: config.team,
    event: "completed",
    timestamp: terminalTimestamp(deployDir, ok, at),
    status: ok ? "success" : "failed",
    summary: reason,
    log_file: config.logFile,
    exit_code: ok ? 0 : result.status && result.status !== 0 ? result.status : 1,
    ...(config.registryEvidence ?? {}),
  }, secrets), diagnostic: reason };
}

function finalizeRunnerFailure(config: PiBackgroundConfig, deployDir: string, reason: string, secrets: string[], at: Date): { event: "completed" | "crashed"; status: "success" | "failed"; diagnostic: string } {
  appendRunnerError(config.deploymentId, deployDir, reason, secrets);
  return { ...reconcileRunnerTerminal(config, deployDir, {
    deployment_id: config.deploymentId,
    team: config.team,
    event: "crashed",
    timestamp: at.toISOString(),
    error: reason,
    summary: reason,
    exit_code: 1,
    ...(config.registryEvidence ?? {}),
  }, secrets), diagnostic: reason };
}

function reconcileRunnerTerminal(config: PiBackgroundConfig, deployDir: string, requested: RegistryEvent, secrets: string[]): { event: "completed" | "crashed"; status: "success" | "failed" } {
  const authoritative = reconcileTerminalRegistryEvent(requested).event;
  const success = authoritative.event === "completed" && authoritative.status === "success";
  const reason = bounded(authoritative.event === "crashed" ? authoritative.error ?? "ppa agent crashed" : authoritative.summary ?? `ppa agent completed with status ${authoritative.status ?? "unknown"}`, secrets, TERMINAL_DIAGNOSTIC_MAX);
  const status = {
    type: "agent_end" as const,
    stopReason: success ? "stop" : "error",
    ...(success ? {} : { error: reason }),
    timestamp: authoritative.timestamp,
  };
  writePiTerminalStatus(deployDir, status);
  const audit = new PiRedactionAudit(config.deploymentId, deployDir);
  audit.observe("registry-diagnostic", authoritative, secrets);
  audit.observe("terminal-status", status, secrets);
  return { event: authoritative.event === "crashed" ? "crashed" : "completed", status: success ? "success" : "failed" };
}

function appendValidationActivity(deploymentId: string, validation: ValidationEvent, secrets: string[]): void {
  const body = JSON.stringify(validation);
  if (body.length > TERMINAL_DIAGNOSTIC_MAX) throw new Error("runner-persistence: validation lifecycle event exceeds 2000 JavaScript characters");
  const event = createActivityEvent({
    deployId: deploymentId,
    kind: validation.status === "rejected" ? "error" : "text",
    source: "pi",
    body,
    partType: `validation_${validation.type}`,
  });
  appendActivityEvent(event, getDeployPaths(deploymentId).activityLogPath);
  new PiRedactionAudit(deploymentId, dirname(getDeployPaths(deploymentId).activityLogPath)).observe("validation-activity", event, secrets);
}

function appendRunnerError(deploymentId: string, deployDir: string, reason: string, secrets: string[]): void {
  const event = createActivityEvent({
    deployId: deploymentId,
    kind: "error",
    source: "pi",
    body: bounded(reason, secrets, ACTIVITY_DIAGNOSTIC_MAX),
  });
  appendActivityEvent(event, getDeployPaths(deploymentId).activityLogPath);
  const audit = new PiRedactionAudit(deploymentId, deployDir);
  audit.observe("activity", event, secrets);
}

function terminalTimestamp(deployDir: string, success: boolean, fallback: Date): string {
  const marker = readPiTerminalStatus(deployDir);
  if (marker?.stopReason === (success ? "stop" : "error")) return marker.timestamp;
  return fallback.toISOString();
}

function categoryForRunnerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^runner-(?:readiness|spawn|timeout|shutdown|process|persistence|terminal|launcher):/.test(message)) return message;
  if (/persist|write|rename|registry|database|sqlite/i.test(message)) return `runner-persistence: ${message}`;
  return `runner-process: ${message}`;
}

function bounded(value: string, _secrets: string[], max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

/** Internal inert transport only. This binding is correlation, NOT authority.
 * It carries no prompt, command, environment, trust root or builder/review token.
 * Existing capacity/reservation owners must authorize and publish custody before
 * any future restricted runner can be attached. No such attachment exists here. */
export interface PiParkedTestBinding {
  readonly schemaVersion: "pi-parked-test/v1";
  readonly intentId: string;
  readonly authorizationSha256: string;
  readonly deploymentId: string;
  readonly parentDeploymentId: string;
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly ticket: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly leaseId: string;
  readonly leaseHolder: string;
  readonly reservationId: string;
  readonly lineageId: string;
  readonly repositoryPermit: 1 | 2 | 3 | 4;
  readonly deadline: string;
}
export interface PiParkedTestObservation {
  readonly bindingSha256: string;
  readonly process?: ProcessFingerprint;
  readonly state: "intent" | "spawned" | "parked" | "stopped" | "settled" | "unknown";
  readonly registryCorrelated: boolean;
  /** PID/parked/registry are not qualified restricted-tool admission. */
  readonly restrictedHolderReady: false;
}
const PARKED_VERSION = "pi-parked-test/v1";
const PARKED_MAX_BYTES = 16_384;
const PARKED_WAIT_MS = 4_000;
const parkedDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function parkedStop(): Error {
  return new Error("Condition: parked Pi lifecycle blocked. Source: native supervisor transport and retained evidence. Reason: exact correlation, process settlement or qualified restricted runner is unproven. Correction: preserve the same intent, process, reservation and original records; reconcile through their owners. Resume Action: inspect the first unproven action, never replay spawn/release or fall back to generic Pi.");
}
function physicalDirectory(path: string): void {
  const stat = lstatSync(path);
  if (resolve(path) !== path || realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()) throw parkedStop();
}
function parkedBinding(input: PiParkedTestBinding): PiParkedTestBinding {
  const keys = ["schemaVersion", "intentId", "authorizationSha256", "deploymentId", "parentDeploymentId", "repoKey", "repoRoot", "worktreeRoot", "ticket", "branch", "baseSha", "headSha", "leaseId", "leaseHolder", "reservationId", "lineageId", "repositoryPermit", "deadline"];
  if (!input || typeof input !== "object" || Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))
    || input.schemaVersion !== PARKED_VERSION || !/^[0-9a-f]{64}$/.test(input.intentId) || !/^[0-9a-f]{64}$/.test(input.authorizationSha256)
    || !/^[0-9a-f]{64}$/.test(input.reservationId) || !/^[0-9a-f]{40}$/.test(input.baseSha) || !/^[0-9a-f]{40}$/.test(input.headSha)
    || !/^d-[0-9a-f]{6}$/.test(input.deploymentId) || !/^d-[0-9a-f]{6}$/.test(input.parentDeploymentId) || input.deploymentId === input.parentDeploymentId
    || !/^[a-z][a-z0-9-]{0,63}$/.test(input.repoKey) || input.leaseHolder !== `pa:${input.repoKey}:${input.ticket}`
    || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(input.ticket) || typeof input.branch !== "string" || !input.branch.startsWith(`feature/${input.ticket}-`)
    || ![1, 2, 3, 4].includes(input.repositoryPermit) || input.repoRoot === input.worktreeRoot
    || !Number.isFinite(Date.parse(input.deadline)) || new Date(input.deadline).toISOString() !== input.deadline
    || [input.branch, input.leaseId, input.leaseHolder, input.lineageId].some((value) => typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value))) throw parkedStop();
  physicalDirectory(input.repoRoot); physicalDirectory(input.worktreeRoot);
  // Copy prevents caller mutation while async prepare/settle is in progress.
  return Object.freeze(structuredClone(input));
}
function parkedWrite(path: string, value: unknown): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > PARKED_MAX_BYTES) throw parkedStop();
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function parkedRead(path: string): Record<string, unknown> | undefined {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw parkedStop(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > PARKED_MAX_BYTES) throw parkedStop();
  const row: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!row || typeof row !== "object" || Array.isArray(row)) throw parkedStop();
  return row as Record<string, unknown>;
}
// Fixed owner program, not repository code, Pi prompt, shell or generic runner.
// Only IPC initialization is accepted; no CLI/JSON activation switch. It never
// imports Pi or exposes tools, even if a caller sends a forged release message.
const PARKED_PROGRAM = String.raw`
const fs = require('node:fs');
let initialized = false, directory, digest, fingerprint, deadlineTimer;
function write(name, value) {
  const path = directory + '/' + name + '.json', temporary = path + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.linkSync(temporary, path); fs.unlinkSync(temporary);
  const dir = fs.openSync(directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function stop(reason) {
  if (initialized) { try { write('stopped', { bindingSha256: digest, process: fingerprint, reason }); } catch { process.exit(2); } }
  process.exit(0);
}
const initial = setTimeout(() => stop('initialization-unknown'), 4000);
process.on('SIGTERM', () => stop('cancelled'));
process.on('SIGINT', () => stop('cancelled'));
process.on('disconnect', () => { /* retain parked state until original deadline */ });
process.on('message', message => {
  if (initialized || !message || message.type !== 'initialize') return;
  directory = message.directory; digest = message.bindingSha256;
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  fingerprint = { pid: process.pid, startTimeTicks: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19], bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  if (JSON.stringify(fingerprint) !== JSON.stringify(message.process)) process.exit(2);
  const remaining = Date.parse(message.deadline) - Date.now();
  if (!(remaining > 0 && remaining <= 7200000)) process.exit(2);
  initialized = true; clearTimeout(initial);
  deadlineTimer = setTimeout(() => stop('deadline'), remaining);
  write('parked', { bindingSha256: digest, process: fingerprint, restrictedHolderReady: false });
  if (process.connected) process.send({ type: 'parked', bindingSha256: digest });
});
`;

/** Existing supervisor owner's dedicated prepare/inspect/release/settle transport.
 * Source-level internal embedding only; constructing it grants no admission.
 * It starts a real inert supervisor, NOT a restricted Pi executor. Release is
 * intentionally unreachable until actual native restrictions are composed.
 * Records are immutable retained evidence, not a capacity/approval database. */
export class PiParkedTestTransport {
  constructor(readonly deploymentDirectory: string) {
    try {
      physicalDirectory(deploymentDirectory);
      const stat = lstatSync(deploymentDirectory);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw parkedStop();
    } catch { throw parkedStop(); }
  }
  #directory(binding: PiParkedTestBinding): string { return resolve(this.deploymentDirectory, `pi-parked-${binding.intentId}`); }
  #records(input: PiParkedTestBinding): { binding: PiParkedTestBinding; directory: string; bindingSha256: string } {
    const binding = parkedBinding(input), directory = this.#directory(binding), bindingSha256 = parkedDigest(binding);
    physicalDirectory(directory);
    const stat = lstatSync(directory);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw parkedStop();
    const intent = parkedRead(resolve(directory, "intent.json"));
    if (!intent || intent.bindingSha256 !== bindingSha256 || !isDeepStrictEqual(intent.binding, binding)) throw parkedStop();
    return { binding, directory, bindingSha256 };
  }
  async prepare(input: PiParkedTestBinding, signal?: AbortSignal): Promise<PiParkedTestObservation> {
    try { return await this.#prepare(input, signal); } catch { throw parkedStop(); }
  }
  async #prepare(input: PiParkedTestBinding, signal?: AbortSignal): Promise<PiParkedTestObservation> {
    const binding = parkedBinding(input), remaining = Date.parse(binding.deadline) - Date.now();
    if (signal?.aborted || !(remaining > 0 && remaining <= 7_200_000)) throw parkedStop();
    const directory = this.#directory(binding), bindingSha256 = parkedDigest(binding);
    // Exclusive directory is the native spawn-intent barrier across controllers.
    // Existing/partial/unknown intent is INSPECT ONLY, even if no PID was saved.
    mkdirSync(directory, { mode: 0o700 });
    parkedWrite(resolve(directory, "intent.json"), { bindingSha256, binding });
    const child = spawn(process.execPath, ["--eval", PARKED_PROGRAM], {
      cwd: this.deploymentDirectory, env: {}, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    // Preserve original native failure privately; public stops remain fixed.
    // Errors never remove/retry the intent or manufacture process absence.
    child.on("error", (error) => {
      try { parkedWrite(resolve(directory, "failure.json"), { bindingSha256, name: error.name, message: error.message, stack: error.stack ?? null }); } catch { /* original event remains unproven */ }
    });
    const processIdentity = child.pid ? readProcessFingerprint(child.pid) : undefined;
    if (!processIdentity) throw parkedStop();
    parkedWrite(resolve(directory, "spawned.json"), { bindingSha256, process: processIdentity });
    child.send({ type: "initialize", directory, bindingSha256, process: processIdentity, deadline: binding.deadline }, () => {});
    child.unref(); child.channel?.unref();
    const stop = (): void => { void this.settle(binding).catch(() => { /* retain stop intent and unknown registry barrier */ }); };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const end = Date.now() + Math.min(PARKED_WAIT_MS, remaining);
      while (Date.now() < end) {
        if (signal?.aborted) { stop(); throw parkedStop(); }
        const observed = this.inspect(binding);
        if (observed.state === "parked") return observed;
        if (observed.state === "unknown" || observed.state === "stopped" || observed.state === "settled") throw parkedStop();
        await new Promise((done) => setTimeout(done, 10));
      }
      throw parkedStop();
    } finally { signal?.removeEventListener("abort", stop); }
  }
  inspect(input: PiParkedTestBinding): PiParkedTestObservation {
    try { return this.#inspect(input); } catch { throw parkedStop(); }
  }
  #inspect(input: PiParkedTestBinding): PiParkedTestObservation {
    const { binding, directory, bindingSha256 } = this.#records(input);
    const spawned = parkedRead(resolve(directory, "spawned.json"));
    const parked = parkedRead(resolve(directory, "parked.json"));
    const stopped = parkedRead(resolve(directory, "stopped.json"));
    const stopIntent = parkedRead(resolve(directory, "stop-intent.json"));
    const processIdentity = spawned?.process as ProcessFingerprint | undefined;
    if (parkedRead(resolve(directory, "failure.json"))) throw parkedStop();
    if ((spawned && (spawned.bindingSha256 !== bindingSha256 || !processIdentity || !Number.isSafeInteger(processIdentity.pid) || processIdentity.pid <= 0 || typeof processIdentity.startTimeTicks !== "string" || typeof processIdentity.bootId !== "string"))
      || [parked, stopped, stopIntent].some((row) => row && (row.bindingSha256 !== bindingSha256 || !isDeepStrictEqual(row.process, processIdentity)))) throw parkedStop();
    if (parked && parked.restrictedHolderReady !== false) throw parkedStop();
    const status = queryDeploymentStatus(binding.deploymentId);
    const correlated = Boolean(status && processIdentity && status.pid === processIdentity.pid
      && status.runtime === "pi" && status.binary === "ppa" && status.team === "requirements" && status.mode === "test-author"
      && status.builder_authority === undefined && status.repository_slot === undefined
      && status.parent_deployment_id === undefined && status.ticket_id === binding.ticket
      && status.repo_root === binding.repoRoot && status.repo === binding.worktreeRoot && status.worktree_root === binding.worktreeRoot
      // Existing Treehouse fields require BUILDER authority. Do not borrow it or
      // relax that schema: ordinary lifecycle objective is only a digest pointer
      // to the complete immutable transport binding, NEVER custody/approval.
      && status.treehouse_path === undefined && status.treehouse_lease_id === undefined && status.treehouse_lease_holder === undefined
      && status.ticket_slot_id === undefined && status.repository_permit === undefined
      && status.objective === `${PARKED_VERSION}:${bindingSha256}`);
    const live = Boolean(processIdentity && isDeepStrictEqual(readProcessFingerprint(processIdentity.pid), processIdentity));
    const terminal = status && ["success", "partial", "failed", "crashed"].includes(status.status);
    const state: PiParkedTestObservation["state"] = !spawned ? "intent" : live
      ? stopped || stopIntent ? "unknown" : parked ? "parked" : "spawned"
      : stopped ? correlated && terminal ? "settled" : "stopped" : "unknown";
    return Object.freeze({ bindingSha256, ...(processIdentity ? { process: Object.freeze({ ...processIdentity }) } : {}), state, registryCorrelated: correlated, restrictedHolderReady: false });
  }
  release(input: PiParkedTestBinding): never {
    // Even perfect transport/process/registry facts cannot forge restricted-tool
    // readiness or final product authority. There is NO generic prompt fallback.
    this.inspect(input);
    throw parkedStop();
  }
  async settle(input: PiParkedTestBinding): Promise<PiParkedTestObservation> {
    try { return await this.#settle(input); } catch { throw parkedStop(); }
  }
  async #settle(input: PiParkedTestBinding): Promise<PiParkedTestObservation> {
    const { directory, bindingSha256 } = this.#records(input);
    let observed = this.inspect(input);
    if (observed.state === "settled") return observed;
    if (!observed.process) throw parkedStop();
    const intentPath = resolve(directory, "stop-intent.json");
    if (!parkedRead(intentPath)) {
      parkedWrite(intentPath, { bindingSha256, process: observed.process });
      if (isDeepStrictEqual(readProcessFingerprint(observed.process.pid), observed.process)) {
        try { process.kill(observed.process.pid, "SIGTERM"); } catch { throw parkedStop(); }
      }
    }
    // Lost stop response is inspection only. Do not send again, release capacity,
    // write a success registry marker, remove records, return or alter a checkout.
    const end = Date.now() + PARKED_WAIT_MS;
    while (Date.now() < end) {
      observed = this.inspect(input);
      if (observed.state === "settled") return observed;
      if (observed.state === "stopped" || (observed.state === "unknown" && !isDeepStrictEqual(readProcessFingerprint(observed.process!.pid), observed.process))) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw parkedStop();
  }
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isEntrypoint()) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("runner-readiness: Missing Pi background configuration path");
  const config = readPiBackgroundConfig(configPath);
  try { if (existsSync(configPath)) unlinkSync(configPath); } catch { /* the bounded non-secret config may remain for diagnosis */ }
  await runPiBackgroundRunner(config);
}
