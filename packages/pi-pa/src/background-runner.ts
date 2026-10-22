import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple as streamKeylessCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { PiRequirementsTestAuthority, RequirementsTestNativeService, type RequirementsProductPreflight, type RequirementsTestLaunch, type RequirementsTestNativeExecutor } from "./requirements-test-native.js";
import { RequirementsTestTools, createRequirementsProductTools } from "./native-execution-tools.js";
import { NativeExecutionSession } from "./execution-native.js";
import { recordPiProcessIdentity } from "./process-identity.js";
import { NativeExecutionEvidence } from "./native-execution-evidence.js";
import {
  appendRegistryEvent, workflowDigest, workflowObject, workflowError, parseTestAuthorization, parseSourceVersion, ExecutionCustodyService, parseExecutionBinding,
  withPreparedWorkflowLocks, withPreparedTicketCapacity, withExecutionWorktreeAdmission, validateRequirementsTestCorrelationEvidence,
  type TestResource, type RequirementsTestCorrelationEvidence, type SourceVersion,
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
  queryDeploymentStatus, queryReadonlyDeploymentEvents,
  reconcileTerminalRegistryEvent,
  refreshTicketLinkedBranchHead,
  releaseRepositoryTicketSlot, releaseRepositoryMutationLease, inspectRepositoryMutationLease, resolveRepoExecutionPath,
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
import { finalizePiReviewCandidate, rereadPiReviewCandidate, reconcilePiTerminalChild, terminalSettlementUnavailable, admitPiRequirementsProduct, resolvePiRequirementsProductExecution, createPiReadonlyHelperCapability, type PiReadonlyHelperDependencies } from "./deploy.js";
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
      config.startup,
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

const RESTRICTED_OWNER = "pi-restricted-test-owner/v1";
const restrictedOwnerId = (intent: string) => workflowDigest(JSON.stringify([RESTRICTED_OWNER, intent]));
interface RestrictedOwner {
  readonly schemaVersion: typeof RESTRICTED_OWNER;
  readonly operationId: string;
  readonly intentId: string;
  readonly authorizationSha256: string;
  readonly deploymentId: string;
  readonly directory: string;
  readonly resource: TestResource;
  readonly correlation: RequirementsTestCorrelationEvidence;
}
function restrictedOwner(authority: PiRequirementsTestAuthority, intentId: string): RestrictedOwner {
  const store = authority.native.operations(); if (!store || !/^[0-9a-f]{64}$/.test(intentId)) throw workflowError();
  const row = workflowObject(store.read(`${restrictedOwnerId(intentId)}.intent.json`), ["schemaVersion", "operationId", "intentId", "authorizationSha256", "deploymentId", "directory", "resource", "correlation"]);
  const owner = row as unknown as RestrictedOwner;
  const auth = parseTestAuthorization(authority.readAuthorization(owner.operationId));
  authority.assertRetainedAuthorization(auth, owner.authorizationSha256);
  const correlation = validateRequirementsTestCorrelationEvidence(owner.correlation);
  if (owner.schemaVersion !== RESTRICTED_OWNER || owner.intentId !== intentId || correlation.intentId !== intentId || correlation.operationId !== auth.operationId
    || correlation.authorizationSha256 !== owner.authorizationSha256 || JSON.stringify(owner.resource.repository) !== JSON.stringify(auth.repository)
    || owner.directory !== join(authority.native.aiUsageRoot, "deployments", owner.deploymentId) || !/^d-[0-9a-f]{6}$/.test(owner.deploymentId)
    || correlation.worktreeRoot !== owner.resource.worktreeRoot || correlation.reservationId !== owner.resource.reservationId || correlation.lineageId !== owner.resource.lineageId
    || correlation.repositoryPermit !== owner.resource.repositoryPermit || correlation.leaseId !== owner.resource.leaseId || correlation.leaseHolder !== owner.resource.leaseHolder) throw workflowError();
  return owner;
}
function restrictedRegistry(owner: RestrictedOwner, fingerprint: ProcessFingerprint, terminal = false): SourceVersion {
  const status = queryDeploymentStatus(owner.deploymentId);
  if (!status || status.pid !== fingerprint.pid || status.runtime !== "pi" || status.binary !== "ppa" || status.team !== "requirements" || status.mode !== "test-author"
    || status.repo !== owner.resource.worktreeRoot || status.repo_root !== owner.resource.repository.root || status.worktree_root !== owner.resource.worktreeRoot || status.ticket_id !== owner.resource.repository.ticket
    || status.builder_authority || status.repository_slot || status.parent_deployment_id || status.review_checkout || !isDeepStrictEqual(status.requirements_test, owner.correlation)
    || (terminal ? !["partial", "failed", "success", "crashed"].includes(status.status) : status.status !== "running")) throw workflowError();
  return parseSourceVersion({ ref: `requirements-test-registry:${owner.deploymentId}`, version: "requirements-test-custody/v1", sha256: workflowDigest(JSON.stringify({ deploymentId: owner.deploymentId, process: fingerprint, correlation: owner.correlation })) });
}
function restrictedCustody(authority: PiRequirementsTestAuthority, owner: RestrictedOwner, processIdentity: ProcessFingerprint, released: boolean): void {
  const auth = parseTestAuthorization(authority.readAuthorization(owner.operationId));
  authority.assertAuthorization(auth, owner.authorizationSha256);
  restrictedRegistry(owner, processIdentity);
  if (!isDeepStrictEqual(readProcessFingerprint(processIdentity.pid), processIdentity)) throw workflowError();
  withPreparedTicketCapacity({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root }, (capacity) => withExecutionWorktreeAdmission(auth.repository.root, owner.resource.worktreeRoot, capacity, () => {
    const row = capacity.inventory().find((entry) => entry.ticket === auth.repository.ticket);
    if (!row || !("purpose" in row) || row.purpose !== "requirements-test-workflow/v1" || row.operationId !== auth.operationId
      || row.reservationId !== owner.resource.reservationId || row.repositoryPermit !== owner.resource.repositoryPermit
      || (row.lineageId !== null && row.lineageId !== owner.resource.lineageId)) throw workflowError();
    if (released && (row.occupancy !== "active" || row.custody.state !== "implement-child" || row.custody.inFlightOperation !== null
      || !isDeepStrictEqual(row.custody.holder, { deploymentId: owner.deploymentId, process: processIdentity }))) throw workflowError();
    if (!released && row.occupancy !== "idle-ready" && row.occupancy !== "settled-retained" && !(row.occupancy === "active" && isDeepStrictEqual(row.custody.holder, { deploymentId: owner.deploymentId, process: processIdentity }))) throw workflowError();
  }));
}
/** Real dedicated SDK process owner, separate from builder mutation authority.
 * Immutable process intent and shared reservation are required before spawn;
 * release requires the service's published exact start intent plus registry and
 * physical process/custody agreement. Unknown intent is NEVER respawned. */
export class PiRestrictedTestExecutor implements RequirementsTestNativeExecutor {
  constructor(readonly authority = new PiRequirementsTestAuthority(), readonly fixtures?: {
    /** Isolated source tests only; not a tool/config/environment launch option. */
    spawnRunner(intentId: string, resource: TestResource, role?: "test" | "product"): ReturnType<typeof spawn>;
    treehouse?: import("./treehouse.js").TreehouseClient;
  }) { this.#product = new PiRequirementsProductExecutor(this, authority, fixtures); }
  readonly #product: PiRequirementsProductExecutor;
  prepare(): never { throw workflowError(); } // no synchronous async-owner fallback
  start(): never { throw workflowError(); }
  async prepareAsync(role: "test" | "product", intentId: string, resource: TestResource, signal?: AbortSignal): Promise<RequirementsTestLaunch> {
    if (role === "product") return this.#product.prepareAsync(role, intentId, resource, signal);
    if (role !== "test" || signal?.aborted) throw workflowError();
    const store = this.authority.native.operations(); if (!store) throw workflowError();
    const records = store.records().map((name) => store.read(name) as Record<string, unknown>);
    const request = records.find((row) => row.schemaVersion === "requirements-test-native/v1" && row.step === "test-process" && row.state === "intent"
      && (row.value as { intentId?: string })?.intentId === intentId);
    if (!request || typeof request.operationId !== "string") throw workflowError();
    const auth = parseTestAuthorization(this.authority.readAuthorization(request.operationId)); const digest = workflowDigest(this.authority.readAuthorization(auth.operationId));
    this.authority.assertAuthorization(auth, digest);
    const remaining = Date.parse(auth.bounds.deadlineAt) - Date.now(); if (!(remaining > 0)) throw workflowError();
    const deploymentId = `d-${randomBytes(3).toString("hex")}`, directory = join(this.authority.native.aiUsageRoot, "deployments", deploymentId);
    physicalDirectory(dirname(directory));
    const correlation = validateRequirementsTestCorrelationEvidence({ schemaVersion: "requirements-test-custody/v1", operationId: auth.operationId, authorizationSha256: digest, intentId,
      parentDeploymentId: auth.parent.holder.deploymentId, repoKey: auth.repository.key, repoRoot: auth.repository.root, worktreeRoot: resource.worktreeRoot, ticket: auth.repository.ticket,
      branch: auth.repository.branch, baseSha: auth.repository.baseSha, initialHeadSha: auth.repository.selectedHeadSha, leaseId: resource.leaseId, leaseHolder: resource.leaseHolder,
      reservationId: resource.reservationId, lineageId: resource.lineageId, repositoryPermit: resource.repositoryPermit });
    const owner: RestrictedOwner = { schemaVersion: RESTRICTED_OWNER, operationId: auth.operationId, intentId, authorizationSha256: digest, deploymentId, directory, resource, correlation };
    withPreparedWorkflowLocks({ repository: (run) => withPreparedTicketCapacity({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root }, (capacity) => {
      const row = capacity.inventory().find((entry) => entry.ticket === auth.repository.ticket);
      if (!row || !("operationId" in row) || row.operationId !== auth.operationId || row.reservationId !== resource.reservationId || row.occupancy !== "idle-ready") throw workflowError();
      return run();
    }), worktree: (run) => run() }, (scope) => store.publish(scope, `${restrictedOwnerId(intentId)}.intent.json`, owner));
    // Existing/unknown directory or owner intent cannot trigger a second launch.
    mkdirSync(directory, { mode: 0o700 }); parkedWrite(join(directory, "restricted-intent.json"), owner);
    const child = this.fixtures ? this.fixtures.spawnRunner(intentId, resource) : spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--requirements-test-holder", intentId], {
      cwd: resource.worktreeRoot, env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC" }, detached: true, stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", (error) => { try { parkedWrite(join(directory, "restricted-failure.json"), { name: error.name, message: error.message }); } catch { /* retain unknown */ } });
    const fingerprint = child.pid ? readProcessFingerprint(child.pid) : undefined; if (!fingerprint) throw workflowError();
    parkedWrite(join(directory, "restricted-spawned.json"), { intentId, process: fingerprint });
    appendRegistryEvent({ deployment_id: deploymentId, team: "requirements", mode: "test-author", event: "started", timestamp: new Date().toISOString(), pid: fingerprint.pid, runtime: "pi", binary: "ppa",
      ticket_id: auth.repository.ticket, repo: resource.worktreeRoot, repo_root: auth.repository.root, worktree_root: resource.worktreeRoot, requirements_test: correlation,
      effective_timeout_seconds: Math.ceil(remaining / 1000) });
    child.unref();
    const end = Date.now() + Math.min(10_000, remaining);
    while (Date.now() < end) {
      if (signal?.aborted) throw workflowError();
      if (parkedRead(join(directory, "restricted-parked.json"))) { const launch = this.inspect(role, intentId, resource); this.assertParked(launch, resource, role); return launch; }
      if (!isDeepStrictEqual(readProcessFingerprint(fingerprint.pid), fingerprint)) throw workflowError();
      await new Promise((done) => setTimeout(done, 10));
    }
    throw workflowError();
  }
  inspect(role: "test" | "product", intentId: string, resource: TestResource): RequirementsTestLaunch {
    if (role === "product") return this.#product.inspect(role, intentId, resource);
    if (role !== "test") throw workflowError();
    const owner = restrictedOwner(this.authority, intentId);
    if (!isDeepStrictEqual(owner.resource, resource)) throw workflowError();
    const row = parkedRead(join(owner.directory, "restricted-spawned.json")); const fingerprint = row?.process as ProcessFingerprint | undefined;
    if (!row || row.intentId !== intentId || !fingerprint) throw workflowError();
    return Object.freeze({ holder: Object.freeze({ deploymentId: owner.deploymentId, process: fingerprint }), deploymentDirectory: owner.directory, registry: restrictedRegistry(owner, fingerprint, !readProcessFingerprint(fingerprint.pid)) });
  }
  #owner(launch: RequirementsTestLaunch): RestrictedOwner {
    const row = parkedRead(join(launch.deploymentDirectory, "restricted-intent.json"));
    if (!row || typeof row.intentId !== "string") throw workflowError();
    const owner = restrictedOwner(this.authority, row.intentId);
    if (!isDeepStrictEqual(row, owner) || owner.deploymentId !== launch.holder.deploymentId || owner.directory !== launch.deploymentDirectory
      || !isDeepStrictEqual(restrictedRegistry(owner, launch.holder.process, !readProcessFingerprint(launch.holder.process.pid)), launch.registry)) throw workflowError(); return owner;
  }
  assertParked(launch: RequirementsTestLaunch, resource: TestResource, role: "test" | "product"): void {
    if (role === "product") return this.#product.assertParked(launch, resource, role);
    if (role !== "test") throw workflowError();
    const owner = this.#owner(launch); if (!isDeepStrictEqual(resource, owner.resource)) throw workflowError();
    // Service calls this inside its capacity/worktree transaction. Validate
    // process/registry/SDK facts here without recursively taking that mutex.
    // The service rereads the exact shared reservation under its live owner.
    if (!isDeepStrictEqual(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)) throw workflowError();
    const parked = parkedRead(join(owner.directory, "restricted-parked.json"));
    if (!parked || parked.intentId !== owner.intentId || !isDeepStrictEqual(parked.process, launch.holder.process) || !isDeepStrictEqual(parked.tools, ["write", "edit", "read", "check"])
      || parkedRead(join(owner.directory, "restricted-started.json")) || parkedRead(join(owner.directory, "restricted-stopped.json"))) throw workflowError();
  }
  async startAsync(launch: RequirementsTestLaunch, intentId: string, signal?: AbortSignal): Promise<void> {
    if (launch.registry.version === "requirements-product-registry/v1") return this.#product.startAsync(launch, intentId, signal);
    const owner = this.#owner(launch); if (signal?.aborted) throw workflowError();
    restrictedCustody(this.authority, owner, launch.holder.process, true);
    // Child independently resolves the exact service start publication. Neither
    // this file nor an IPC message by itself is execution authority.
    parkedWrite(join(owner.directory, "restricted-release.json"), { intentId, process: launch.holder.process });
    const auth = parseTestAuthorization(this.authority.readAuthorization(owner.operationId));
    const end = Math.min(Date.now() + 4_000, Date.parse(auth.bounds.deadlineAt));
    while (Date.now() < end) {
      if (signal?.aborted) throw workflowError();
      if (parkedRead(join(owner.directory, "restricted-started.json"))) { this.assertStarted(launch, intentId); return; }
      await new Promise((done) => setTimeout(done, 10));
    }
    throw workflowError();
  }
  assertStarted(launch: RequirementsTestLaunch, intentId: string): void {
    if (launch.registry.version === "requirements-product-registry/v1") return this.#product.assertStarted(launch, intentId);
    const owner = this.#owner(launch); const started = parkedRead(join(owner.directory, "restricted-started.json"));
    if (!started || started.intentId !== intentId || !isDeepStrictEqual(started.process, launch.holder.process)) throw workflowError();
  }
  cancel(launch: RequirementsTestLaunch): void {
    if (launch.registry.version === "requirements-product-registry/v1") return this.#product.cancel(launch);
    const owner = this.#owner(launch); const path = join(owner.directory, "restricted-stop-intent.json");
    if (parkedRead(path)) return;
    parkedWrite(path, { intentId: owner.intentId, process: launch.holder.process });
    if (isDeepStrictEqual(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)) process.kill(launch.holder.process.pid, "SIGTERM");
  }
  finalizeProduct(launch: RequirementsTestLaunch): void {
    if (launch.registry.version !== "requirements-product-registry/v1") throw workflowError();
    this.#product.finalizeProduct(launch);
  }
  assertSettled(launch: RequirementsTestLaunch): void {
    if (launch.registry.version === "requirements-product-registry/v1") return this.#product.assertSettled(launch);
    const owner = this.#owner(launch);
    if (isDeepStrictEqual(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)) throw workflowError();
    restrictedRegistry(owner, launch.holder.process, true);
    const stopped = parkedRead(join(owner.directory, "restricted-stopped.json"));
    if (!stopped || !isDeepStrictEqual(stopped.process, launch.holder.process) || stopped.intentId !== owner.intentId) throw workflowError();
  }
}

const PRODUCT_OWNER = "pi-restricted-product-owner/v1";
const productOwnerId = (intent: string) => workflowDigest(JSON.stringify([PRODUCT_OWNER, intent]));
interface ProductOwner {
  readonly schemaVersion: typeof PRODUCT_OWNER;
  readonly binding: RequirementsProductPreflight;
  readonly deploymentId: string;
  readonly directory: string;
}
function productOwner(authority: PiRequirementsTestAuthority, intent: string): ProductOwner {
  const store = authority.native.operations(); if (!store || !/^[0-9a-f]{64}$/.test(intent)) throw workflowError();
  const row = workflowObject(store.read(`${productOwnerId(intent)}.intent.json`), ["schemaVersion", "binding", "deploymentId", "directory"]);
  const value = row as unknown as ProductOwner;
  if (value.schemaVersion !== PRODUCT_OWNER || value.binding.intentId !== intent || !/^d-[0-9a-f]{6}$/.test(value.deploymentId)
    || value.directory !== join(authority.native.aiUsageRoot, "deployments", value.deploymentId)
    || !isDeepStrictEqual(value.binding, authority.retainedProductPreflight(value.binding.operationId))) throw workflowError();
  return value;
}
function productRegistry(owner: ProductOwner, fingerprint: ProcessFingerprint, terminal = false): SourceVersion {
  const status = queryDeploymentStatus(owner.deploymentId), resource = owner.binding.resource;
  const starts = queryReadonlyDeploymentEvents(owner.deploymentId).filter((row) => row.event === "started");
  if (!status || starts.length !== 1 || starts[0]!.note !== `requirements-product-launch/v1:${workflowDigest(JSON.stringify(owner.binding))}`
    || status.pid !== fingerprint.pid || status.team !== "builder" || status.mode !== "orchestrator" || status.runtime !== "pi" || status.binary !== "ppa"
    || status.builder_authority !== "orchestrator" || status.parent_deployment_id || status.requirements_test || status.review_checkout
    || status.repo !== resource.worktreeRoot || status.repo_root !== resource.repository.root || status.worktree_root !== resource.worktreeRoot || status.ticket_id !== resource.repository.ticket
    || status.treehouse_path !== resource.worktreeRoot || status.treehouse_lease_id !== resource.leaseId || status.treehouse_lease_holder !== resource.leaseHolder
    || status.ticket_slot_id !== `pa:${resource.repository.key}:${resource.repository.ticket}` || status.repository_permit !== resource.repositoryPermit
    || status.branch_state !== "materialized" || status.branch_base_sha !== resource.repository.baseSha
    || (terminal ? !["success", "partial", "failed", "crashed"].includes(status.status) : status.status !== "running")) throw workflowError();
  return { ref: `requirements-product-registry:${owner.deploymentId}`, version: "requirements-product-registry/v1", sha256: workflowDigest(JSON.stringify({ owner, process: fingerprint })) };
}
/** Dedicated product holder through EXISTING native admission/execution owners.
 * It cannot mint a legacy preparation grant, second reservation or generic spawn. */
class PiRequirementsProductExecutor implements RequirementsTestNativeExecutor {
  constructor(readonly executor: RequirementsTestNativeExecutor, readonly authority: PiRequirementsTestAuthority,
    readonly fixtures?: { spawnRunner(intentId: string, resource: TestResource, role?: "test" | "product"): ReturnType<typeof spawn>; treehouse?: import("./treehouse.js").TreehouseClient }) {}
  prepare(): never { throw workflowError(); }
  start(): never { throw workflowError(); }
  #service(): RequirementsTestNativeService {
    const store = this.authority.native.operations(); if (!store) throw workflowError();
    return new RequirementsTestNativeService({ store, authority: this.authority, executor: this.executor, tickets: this.authority.native.tickets(), treehouse: this.fixtures?.treehouse });
  }
  async prepareAsync(role: "test" | "product", intent: string, resource: TestResource, signal?: AbortSignal): Promise<RequirementsTestLaunch> {
    if (role !== "product" || signal?.aborted) throw workflowError();
    const store = this.authority.native.operations(); if (!store) throw workflowError();
    const requests = store.records().map((name) => store.read(name) as { schemaVersion?: string; operationId?: string; step?: string; state?: string; value?: { intentId?: string } })
      .filter((row) => row.schemaVersion === "requirements-test-native/v1" && row.step === "product-process" && row.state === "intent" && row.value?.intentId === intent);
    if (requests.length !== 1 || !requests[0]!.operationId) throw workflowError();
    const binding = this.#service().productPreflight(requests[0]!.operationId);
    if (binding.intentId !== intent || !isDeepStrictEqual(binding.resource, resource)) throw workflowError();
    const remaining = Date.parse(binding.bounds.deadlineAt) - Date.now(); if (!(remaining > 0)) throw workflowError();
    const deploymentId = `d-${randomBytes(3).toString("hex")}`, directory = join(this.authority.native.aiUsageRoot, "deployments", deploymentId);
    if (queryDeploymentStatus(deploymentId)) throw workflowError(); // no registry-ID reuse/retry
    physicalDirectory(dirname(directory));
    const owner: ProductOwner = { schemaVersion: PRODUCT_OWNER, binding, deploymentId, directory };
    withPreparedWorkflowLocks({ repository: (run) => withPreparedTicketCapacity({ canonicalRepoKey: resource.repository.key, canonicalRepoRoot: resource.repository.root }, (capacity) => {
      const row = capacity.inventory().find((entry) => entry.ticket === resource.repository.ticket);
      if (!row || !("operationId" in row) || row.operationId !== binding.operationId || row.reservationId !== resource.reservationId || row.occupancy !== "settled-retained" || row.custody.state !== "idle") throw workflowError();
      return run();
    }), worktree: (run) => run() }, (scope) => store.publish(scope, `${productOwnerId(intent)}.intent.json`, owner));
    mkdirSync(directory, { mode: 0o700 }); parkedWrite(join(directory, "product-intent.json"), owner);
    const child = this.fixtures ? this.fixtures.spawnRunner(intent, resource, "product") : spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--requirements-product-holder", intent], {
      cwd: resource.worktreeRoot, env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC" }, detached: true, stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", (error) => { try { parkedWrite(join(directory, "product-failure.json"), { name: error.name, message: error.message }); } catch { /* unknown intent retained */ } });
    const fingerprint = child.pid ? readProcessFingerprint(child.pid) : undefined; if (!fingerprint || !recordPiProcessIdentity(deploymentId, directory, fingerprint.pid)) throw workflowError();
    parkedWrite(join(directory, "product-spawned.json"), { intentId: intent, process: fingerprint });
    appendRegistryEvent({ deployment_id: deploymentId, event: "started", timestamp: new Date().toISOString(), pid: fingerprint.pid, team: "builder", mode: "orchestrator", runtime: "pi", binary: "ppa",
      builder_authority: "orchestrator", repository_slot: "orchestrator", repo: resource.worktreeRoot, repo_root: resource.repository.root, worktree_root: resource.worktreeRoot, ticket_id: resource.repository.ticket,
      treehouse_path: resource.worktreeRoot, treehouse_lease_id: resource.leaseId, treehouse_lease_holder: resource.leaseHolder, ticket_slot_id: `pa:${resource.repository.key}:${resource.repository.ticket}`,
      repository_permit: resource.repositoryPermit as 1 | 2 | 3 | 4, branch_state: "materialized", branch_base_sha: resource.repository.baseSha, branch_head_sha: binding.oracle.testHeadSha,
      note: `requirements-product-launch/v1:${workflowDigest(JSON.stringify(binding))}`, effective_timeout_seconds: Math.ceil(remaining / 1000) });
    child.unref(); const end = Date.now() + Math.min(10_000, remaining);
    while (Date.now() < end) {
      if (signal?.aborted || !isDeepStrictEqual(readProcessFingerprint(fingerprint.pid), fingerprint)) throw workflowError();
      if (parkedRead(join(directory, "product-parked.json"))) { const launch = this.inspect(role, intent, resource); this.assertParked(launch, resource, role); return launch; }
      await new Promise((done) => setTimeout(done, 10));
    }
    throw workflowError();
  }
  inspect(role: "test" | "product", intent: string, resource: TestResource): RequirementsTestLaunch {
    const owner = productOwner(this.authority, intent), spawned = parkedRead(join(owner.directory, "product-spawned.json"));
    const fingerprint = spawned?.process as ProcessFingerprint;
    if (role !== "product" || !isDeepStrictEqual(owner.binding.resource, resource) || spawned?.intentId !== intent || !fingerprint) throw workflowError();
    return { holder: { deploymentId: owner.deploymentId, process: fingerprint }, deploymentDirectory: owner.directory,
      registry: productRegistry(owner, fingerprint, !readProcessFingerprint(fingerprint.pid)) };
  }
  #owner(launch: RequirementsTestLaunch): ProductOwner {
    const row = parkedRead(join(launch.deploymentDirectory, "product-intent.json"));
    const intent = (row?.binding as RequirementsProductPreflight | undefined)?.intentId; if (!intent) throw workflowError();
    const owner = productOwner(this.authority, intent);
    if (!isDeepStrictEqual(row, owner) || !isDeepStrictEqual(this.inspect("product", intent, owner.binding.resource), launch)) throw workflowError(); return owner;
  }
  assertParked(launch: RequirementsTestLaunch, resource: TestResource, role: "test" | "product"): void {
    const owner = this.#owner(launch), parked = parkedRead(join(owner.directory, "product-parked.json"));
    if (role !== "product" || !isDeepStrictEqual(resource, owner.binding.resource) || !isDeepStrictEqual(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)
      || parked?.intentId !== owner.binding.intentId || !isDeepStrictEqual(parked.process, launch.holder.process)
      || !isDeepStrictEqual(parked.tools, ["write", "edit", "bash", "pa_execution", "read"]) || parkedRead(join(owner.directory, "product-started.json")) || parkedRead(join(owner.directory, "product-stopped.json"))) throw workflowError();
  }
  async startAsync(launch: RequirementsTestLaunch, intent: string, signal?: AbortSignal): Promise<void> {
    const owner = this.#owner(launch); if (signal?.aborted || intent !== workflowDigest(JSON.stringify([owner.binding.operationId, "product-start"]))) throw workflowError();
    if (!isDeepStrictEqual(this.#service().productPreflight(owner.binding.operationId), owner.binding)) throw workflowError();
    const reference = admitPiRequirementsProduct(this.authority, owner.binding.operationId, { treehouse: this.fixtures?.treehouse });
    parkedWrite(join(owner.directory, "product-release.json"), { intentId: intent, process: launch.holder.process, reference });
    const end = Math.min(Date.now() + 10_000, Date.parse(owner.binding.bounds.deadlineAt));
    while (Date.now() < end) {
      if (signal?.aborted) throw workflowError();
      if (parkedRead(join(owner.directory, "product-started.json"))) { this.assertStarted(launch, intent); return; }
      await new Promise((done) => setTimeout(done, 10));
    }
    throw workflowError();
  }
  assertStarted(launch: RequirementsTestLaunch, intent: string): void {
    const owner = this.#owner(launch), started = parkedRead(join(owner.directory, "product-started.json"));
    if (started?.intentId !== intent || !isDeepStrictEqual(started.process, launch.holder.process)) throw workflowError();
    const value = this.authority.productConsumption(parseSourceVersion(started.reference));
    if (!isDeepStrictEqual(value.launch, launch) || !isDeepStrictEqual(value.binding, owner.binding)) throw workflowError();
  }
  cancel(launch: RequirementsTestLaunch): void {
    const owner = this.#owner(launch), path = join(owner.directory, "product-stop-intent.json"); if (parkedRead(path)) return;
    parkedWrite(path, { intentId: owner.binding.intentId, process: launch.holder.process });
    if (isDeepStrictEqual(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)) process.kill(launch.holder.process.pid, "SIGTERM");
  }
  assertSettled(launch: RequirementsTestLaunch): void {
    const owner = this.#owner(launch), stopped = parkedRead(join(owner.directory, "product-stopped.json"));
    if (isDeepStrictEqual(readProcessFingerprint(launch.holder.process.pid), launch.holder.process) || stopped?.intentId !== owner.binding.intentId || !isDeepStrictEqual(stopped.process, launch.holder.process)) throw workflowError();
    productRegistry(owner, launch.holder.process, true);
    // Parent death/terminal text alone cannot settle an unproven tool/process
    // group. Reuse the native execution journal's existing replay, without
    // pretending that a dead holder passes the service's live admission gate.
    const resource = owner.binding.resource, store = this.authority.native.execution(); if (!store) throw workflowError();
    const binding = parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: owner.binding.operationId, lineageId: resource.lineageId,
      repoKey: resource.repository.key, repoRoot: resource.repository.root, worktreeRoot: resource.worktreeRoot, ticket: resource.repository.ticket,
      branch: resource.repository.branch, initialHeadSha: owner.binding.oracle.testHeadSha, owner: launch.holder, bounds: owner.binding.bounds });
    const unsupported = (): never => { throw workflowError(); };
    const native = new ExecutionCustodyService(store, binding, { locks: { repository: unsupported, worktree: unsupported }, authorize: unsupported, assertLive: unsupported,
      verifyEvidence: unsupported, assertHandover: unsupported, now: unsupported });
    const state = native.inspectRetained();
    if (state.operation || state.custody.inFlightOperation !== null) throw workflowError();
  }
  finalizeProduct(launch: RequirementsTestLaunch): void {
    this.assertSettled(launch);
    const owner = this.#owner(launch), resource = owner.binding.resource;
    const physical = resolveRepoExecutionPath(undefined, resource.worktreeRoot, { allowLinkedWorktreeCwd: true });
    const inspection = inspectRepositoryMutationLease(resource.repository.root, { worktreeRoot: resource.worktreeRoot, getProcessFingerprint: readProcessFingerprint });
    if (inspection.state !== "absent") {
      const lease = inspection.lease;
      if (!lease || lease.deploymentId !== launch.holder.deploymentId || !isDeepStrictEqual(lease.processFingerprint, launch.holder.process)
        || lease.canonicalRepoKey !== resource.repository.key || lease.canonicalRepoRoot !== resource.repository.root || lease.worktreeRoot !== resource.worktreeRoot
        || lease.repositoryGitDir !== physical.gitDir || lease.repositoryGitCommonDir !== physical.gitCommonDir || lease.ticket !== resource.repository.ticket
        || lease.runtime !== "pi" || lease.team !== "builder" || lease.mode !== "orchestrator" || lease.preLaunchGitSnapshot.head !== owner.binding.oracle.testHeadSha
        || lease.preLaunchGitSnapshot.branch !== resource.repository.branch) throw workflowError();
      const result = releaseRepositoryMutationLease({ canonicalRepoRoot: resource.repository.root, worktreeRoot: resource.worktreeRoot,
        repositoryGitDir: physical.gitDir, slot: "orchestrator", ownershipToken: lease.ownershipToken });
      if (result.status !== "released" && result.status !== "absent") throw workflowError();
    }
    if (inspectRepositoryMutationLease(resource.repository.root, { worktreeRoot: resource.worktreeRoot, getProcessFingerprint: readProcessFingerprint }).state !== "absent") throw workflowError();
    const value = { holder: launch.holder, authority: "absent", resourceRetained: true };
    const prior = parkedRead(join(owner.directory, "product-finalized.json"));
    if (prior) { if (!isDeepStrictEqual(prior, value)) throw workflowError(); }
    else parkedWrite(join(owner.directory, "product-finalized.json"), value);
  }
}

/** Keyless qualified loopback transport. SDK/provider retry, ambient credentials,
 * proxy/model discovery, remote URLs and redirect following are not fallbacks.
 * A source fixture server is a protocol test, never model/installed qualification. */
export async function createRequirementsTestModelRuntime(authority: PiRequirementsTestAuthority, auth: ReturnType<typeof parseTestAuthorization>, directory: string) {
  const transport = authority.modelTransport(auth);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(directory, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
  const provider = "pa-requirements-test-keyless";
  let requestsUsed = 0, outputBytes = 0;
  const request: typeof fetch = async (input, init) => {
    if (++requestsUsed > 128) throw workflowError();
    if (!isDeepStrictEqual(authority.modelTransport(auth), transport)) throw workflowError();
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${transport.endpoint}/chat/completions` || init?.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body) > 16_777_216
      || JSON.parse(init.body).model !== transport.modelId) throw workflowError();
    const remaining = Date.parse(auth.bounds.deadlineAt) - Date.now(); if (remaining <= 0) throw workflowError();
    const response = await fetch(url, { method: "POST", body: init.body, headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      redirect: "error", credentials: "omit", signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(remaining)]) });
    if (!response.body) return response;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      outputBytes += chunk.byteLength; if (outputBytes > 16_777_216) throw workflowError(); controller.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  modelRuntime.registerProvider(provider, { api: "openai-completions", baseUrl: transport.endpoint, apiKey: "pa-keyless-not-a-secret", authHeader: false,
    models: [{ id: transport.modelId, name: transport.modelId, reasoning: false, input: ["text"], contextWindow: transport.contextWindow, maxTokens: transport.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options) => {
      if (model.api !== "openai-completions" || model.provider !== provider || model.id !== transport.modelId || model.baseUrl !== transport.endpoint) throw workflowError();
      return streamKeylessCompletions({ ...model, api: "openai-completions" }, context, { ...options, env: {}, apiKey: "pa-keyless-not-a-secret", headers: {}, fetch: request, maxRetries: 0, maxTokens: transport.maxTokens });
    },
  });
  const model = modelRuntime.getModel(provider, transport.modelId); if (!model) throw workflowError();
  return { modelRuntime, model, transport };
}

/** Actual parked SDK holder. Its five definitions cannot execute until the
 * parent publishes exact consumption + existing-owner admission and releases
 * this process incarnation. Product implementation never borrows test-only tools. */
export async function runRequirementsProductHolder(intent: string, authority = new PiRequirementsTestAuthority(), dependencies: PiReadonlyHelperDependencies = {}): Promise<void> {
  const owner = productOwner(authority, intent), { binding } = owner, resource = binding.resource;
  const raw = authority.readAuthorization(binding.operationId), auth = parseTestAuthorization(raw);
  const fingerprint = readProcessFingerprint(process.pid); if (!fingerprint || process.cwd() !== resource.worktreeRoot) throw workflowError();
  const deadline = Date.parse(binding.bounds.deadlineAt), wait = Math.min(Date.now() + 10_000, deadline);
  while (Date.now() < wait && !parkedRead(join(owner.directory, "product-spawned.json"))) await new Promise((done) => setTimeout(done, 10));
  if (!isDeepStrictEqual(parkedRead(join(owner.directory, "product-spawned.json"))?.process, fingerprint)) throw workflowError();
  productRegistry(owner, fingerprint);
  // Locators come only from the protected native owner, never inherited parent
  // principals. Actual source authority independently rechecks every locator.
  Object.assign(process.env, { PA_DEPLOYMENT_ID: owner.deploymentId, PA_DEPLOYMENT_DIR: owner.directory, PA_TEAM: "builder", PA_MODE: "orchestrator",
    PA_TICKET_ID: resource.repository.ticket, PA_REPO: resource.worktreeRoot, PA_WORKTREE_ROOT: resource.worktreeRoot, PA_PI_EXECUTION_MODE: "background" });
  let native: NativeExecutionSession | undefined;
  const tools = createRequirementsProductTools(resource.worktreeRoot, binding.oracle.files.map((file) => file.path), () => { if (!native) throw workflowError(); return native; });
  const resources: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "Implement only the exact final-approved product contract. First record a bounded pa_execution plan and select this native direct holder. Preserve the reviewed oracle. No delegation, credentials, production, push/merge or resource return. Native tools/audit are NOT an OS sandbox.",
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const { modelRuntime, model, transport } = await createRequirementsTestModelRuntime(authority, auth, owner.directory);
  const { session } = await createAgentSession({ cwd: resource.worktreeRoot, agentDir: owner.directory, resourceLoader: resources, modelRuntime, model, thinkingLevel: "off",
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } }), sessionManager: SessionManager.inMemory(resource.worktreeRoot),
    tools: tools.map((tool) => tool.name), customTools: tools, noTools: "builtin" });
  const shutdown = new AbortController(), abort = () => { shutdown.abort(); void session.abort(); };
  process.once("SIGTERM", abort); process.once("SIGINT", abort); const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
  let started = false, failure: unknown;
  try {
    if (!isDeepStrictEqual(session.getActiveToolNames(), ["write", "edit", "bash", "pa_execution", "read"])) throw workflowError();
    parkedWrite(join(owner.directory, "product-parked.json"), { intentId: intent, process: fingerprint, tools: session.getActiveToolNames(), arbitraryCodeConfinement: false });
    while (!shutdown.signal.aborted && Date.now() < deadline) {
      const release = parkedRead(join(owner.directory, "product-release.json"));
      if (!release) { await new Promise((done) => setTimeout(done, 10)); continue; }
      const startIntent = workflowDigest(JSON.stringify([binding.operationId, "product-start"])), reference = parseSourceVersion(release.reference);
      if (release.intentId !== startIntent || !isDeepStrictEqual(release.process, fingerprint)) throw workflowError();
      const product = resolvePiRequirementsProductExecution(authority, owner.deploymentId, dependencies);
      if (!product || !isDeepStrictEqual(product.reference, reference) || !isDeepStrictEqual(product.value.binding, binding)
        || !isDeepStrictEqual(product.value.launch.holder, { deploymentId: owner.deploymentId, process: fingerprint })) throw workflowError();
      const authentication = createPiReadonlyHelperCapability(dependencies).authenticate(resource.worktreeRoot); authentication.reread();
      native = new NativeExecutionSession(authority.native, dependencies, product.consumed, authentication.context, product);
      parkedWrite(join(owner.directory, "product-started.json"), { intentId: startIntent, process: fingerprint, reference }); started = true;
      await session.prompt(authority.productPrompt(product.value), { expandPromptTemplates: false }); await session.agent.waitForIdle();
      const state = native.service.status(native.actor);
      if (state.operation || state.custody.state !== "idle" || state.originalFailure) throw workflowError();
      product.assertOracle(); break;
    }
    if (!started || shutdown.signal.aborted || session.messages.some((message) => message.role === "assistant" && ["error", "aborted"].includes(message.stopReason))) throw workflowError();
  } catch (error) { failure = error; }
  finally { clearTimeout(timer); process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); await session.abort(); session.dispose(); }
  const store = authority.native.operations(); if (!store) throw workflowError();
  const evidence = new NativeExecutionEvidence(store, join(authority.native.root, "operations"), { repository: (run) => withPreparedTicketCapacity({ canonicalRepoKey: resource.repository.key, canonicalRepoRoot: resource.repository.root }, () => run()), worktree: (run) => run() });
  const sink = evidence.sink(workflowDigest(JSON.stringify([intent, "requirements-product-model-terminal/v1"])), "stdout");
  const complete = sink.write(Buffer.from(JSON.stringify({ transport, messages: session.messages, failure: failure instanceof Error ? { name: failure.name, message: failure.message, stack: failure.stack ?? null } : failure ? "unknown" : null })));
  const detail = sink.close(); if (!complete) failure = workflowError();
  const original = evidence.publish("requirements-product-runtime-terminal", { intent, process: fingerprint, started, detail, truncated: !complete, failed: Boolean(failure), cancelled: shutdown.signal.aborted });
  parkedWrite(join(owner.directory, "product-stopped.json"), { intentId: intent, process: fingerprint, original, started });
  appendRegistryEvent({ deployment_id: owner.deploymentId, team: "builder", event: "completed", timestamp: new Date().toISOString(), status: failure || shutdown.signal.aborted ? "failed" : "partial",
    summary: "Dedicated product holder ended; independent review, CI, UAT and activation remain separate." });
}

/** No resource/extension/settings/auth discovery. Creates a genuine Pi SDK
 * session with only the four bounded definitions and an explicit qualified
 * keyless model. Transport/SDK failure is retained, never oracle readiness. */
export async function runRequirementsTestHolder(intentId: string, authority = new PiRequirementsTestAuthority()): Promise<void> {
  const owner = restrictedOwner(authority, intentId); const raw = authority.readAuthorization(owner.operationId); const auth = parseTestAuthorization(raw);
  const fingerprint = readProcessFingerprint(process.pid); if (!fingerprint || process.cwd() !== owner.resource.worktreeRoot) throw workflowError();
  const originalDeadline = Date.parse(auth.bounds.deadlineAt);
  const until = Math.min(Date.now() + 10_000, originalDeadline);
  while (Date.now() < until && !parkedRead(join(owner.directory, "restricted-spawned.json"))) await new Promise((done) => setTimeout(done, 10));
  const spawned = parkedRead(join(owner.directory, "restricted-spawned.json"));
  if (!spawned || !isDeepStrictEqual(spawned.process, fingerprint)) throw workflowError();
  restrictedCustody(authority, owner, fingerprint, false);
  const store = authority.native.operations(); if (!store) throw workflowError();
  const locks = { repository: <T>(run: () => T): T => withPreparedTicketCapacity({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root }, () => run()), worktree: <T>(run: () => T): T => run() };
  const evidence = new NativeExecutionEvidence(store, join(authority.native.root, "operations"), locks);
  const tools = new RequirementsTestTools(raw, owner.resource, evidence, () => restrictedCustody(authority, owner, fingerprint, true), (checkId) => authority.checkEnvironment(auth, checkId));
  const resources: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "Author only the exact authorized tests/harness. Use approved check IDs. No product work, delegation, credentials or production. Tools/audit are NOT an OS sandbox.",
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  // Independently selected model and transport; no default-model fallback or
  // parent deployment/task/activity/registry environment/credential discovery.
  const { modelRuntime, model, transport } = await createRequirementsTestModelRuntime(authority, auth, owner.directory);
  const { session } = await createAgentSession({ cwd: owner.resource.worktreeRoot, agentDir: owner.directory, resourceLoader: resources, modelRuntime, model, thinkingLevel: "off",
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } }), sessionManager: SessionManager.inMemory(owner.resource.worktreeRoot),
    tools: tools.tools.map((tool) => tool.name), customTools: tools.tools, noTools: "builtin" });
  const shutdown = new AbortController(); const abort = () => { shutdown.abort(); void session.abort(); };
  process.once("SIGTERM", abort); process.once("SIGINT", abort);
  const timer = setTimeout(abort, Math.max(1, originalDeadline - Date.now()));
  let started = false; let settlement: SourceVersion | null = null; let failure: unknown;
  try {
    if (!isDeepStrictEqual(session.getActiveToolNames(), ["write", "edit", "read", "check"])) throw workflowError();
    parkedWrite(join(owner.directory, "restricted-parked.json"), { intentId, process: fingerprint, tools: session.getActiveToolNames(), arbitraryCodeConfinement: false });
    while (!shutdown.signal.aborted && Date.now() < originalDeadline) {
      const release = parkedRead(join(owner.directory, "restricted-release.json"));
      if (!release) { await new Promise((done) => setTimeout(done, 10)); continue; }
      const startIntent = workflowDigest(JSON.stringify([auth.operationId, "test-start"]));
      if (release.intentId !== startIntent || !isDeepStrictEqual(release.process, fingerprint)) throw workflowError();
      restrictedCustody(authority, owner, fingerprint, true);
      const rows = store.records().map((name) => store.read(name) as Record<string, unknown>);
      const publications = rows.filter((row) => row.schemaVersion === "requirements-test-native/v1" && row.operationId === auth.operationId && row.step === "test-start" && row.state === "intent");
      if (publications.length !== 1) throw workflowError();
      const publication = publications[0]!.value as { launch: RequirementsTestLaunch; resource: TestResource; launchSnapshot: RepositoryGitSnapshot };
      if (!isDeepStrictEqual(publication.launch.holder, { deploymentId: owner.deploymentId, process: fingerprint }) || !isDeepStrictEqual(publication.resource, owner.resource)
        || publication.launchSnapshot.head !== auth.repository.selectedHeadSha || publication.launchSnapshot.statusPorcelainV2Base64 !== "") throw workflowError();
      parkedWrite(join(owner.directory, "restricted-started.json"), { intentId: startIntent, process: fingerprint, publicationSha256: workflowDigest(JSON.stringify(publications[0])) }); started = true;
      await session.prompt(`Exact approved test-only packet: ${raw}`, { expandPromptTemplates: false });
      await session.agent.waitForIdle(); settlement = tools.settled(); break;
    }
    if (!started || shutdown.signal.aborted || !settlement || session.messages.some((message) => message.role === "assistant" && ["error", "aborted"].includes(message.stopReason))) throw workflowError();
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer); process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort);
    await session.abort(); session.dispose();
  }
  // Protected journal records are bounded to 64 KiB. Keep the complete private
  // transcript/error in the existing native stream owner, not inside a journal
  // envelope that would strand an otherwise settled long model conversation.
  const detail = evidence.sink(workflowDigest(JSON.stringify([intentId, "requirements-test-model-terminal/v1"])), "stdout");
  const complete = detail.write(Buffer.from(JSON.stringify({
    failure: failure instanceof Error ? { name: failure.name, message: failure.message, stack: failure.stack ?? null } : failure ? "unknown" : null,
    transport, messages: session.messages,
  })));
  const nativeDetail = detail.close();
  if (!complete) failure = workflowError();
  const original = evidence.publish("requirements-test-runtime-terminal", { intentId, process: fingerprint, started, settlement, nativeDetail,
    truncated: !complete, failed: Boolean(failure), cancelled: shutdown.signal.aborted });
  parkedWrite(join(owner.directory, "restricted-stopped.json"), { intentId, process: fingerprint, original, started });
  appendRegistryEvent({ deployment_id: owner.deploymentId, team: "requirements", event: "completed", timestamp: new Date().toISOString(), status: failure || shutdown.signal.aborted ? "failed" : "partial",
    summary: "Dedicated test process ended; oracle/product approval is separate.", requirements_test: owner.correlation });
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isEntrypoint()) {
  if (process.argv[2] === "--requirements-product-holder") {
    try { await runRequirementsProductHolder(process.argv[3] ?? ""); }
    catch (error) {
      try { const owner = productOwner(new PiRequirementsTestAuthority(), process.argv[3] ?? ""); parkedWrite(join(owner.directory, "product-failure.json"), { name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "unknown" }); } catch { /* unknown native intent retained */ }
      process.exitCode = 1;
    }
  } else if (process.argv[2] === "--requirements-test-holder") {
    try { await runRequirementsTestHolder(process.argv[3] ?? ""); }
    catch (error) {
      // Startup failure is retained privately; it is NOT proof that an unknown
      // SDK/process tree settled and cannot free its reservation.
      try {
        const owner = restrictedOwner(new PiRequirementsTestAuthority(), process.argv[3] ?? "");
        parkedWrite(join(owner.directory, "restricted-failure.json"), { name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "unknown", stack: error instanceof Error ? error.stack ?? null : null });
      } catch { /* unknown intent remains retained */ }
      process.exitCode = 1;
    }
  } else {
    const configPath = process.argv[2];
    if (!configPath) throw new Error("runner-readiness: Missing Pi background configuration path");
    const config = readPiBackgroundConfig(configPath);
    try { if (existsSync(configPath)) unlinkSync(configPath); } catch { /* the bounded non-secret config may remain for diagnosis */ }
    await runPiBackgroundRunner(config);
  }
}
