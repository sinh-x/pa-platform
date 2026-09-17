import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendActivityEvent,
  assertRepositoryGitIdentity,
  captureRepositoryGitSnapshot,
  createActivityEvent,
  ensureTerminalRegistryMarker,
  finalizeRepositoryMutationBorrower,
  finalizeRepositoryMutationLease,
  getDeployPaths,
  readProcessFingerprint,
  reconcileTerminalRegistryEvent,
  refreshTicketLinkedBranchHead,
  releaseRepositoryTicketSlot,
  transferRepositoryMutationBorrower,
  transferRepositoryMutationLease,
  transferRepositoryTicketSlot,
  type RegistryEvent,
  type RepositoryGitSnapshot,
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
import { environmentSecrets, redactDiagnostic } from "./diagnostics.js";
import { piRegistryEnvironment } from "./native-host.js";
import { readPiTerminalStatus, writePiTerminalStatus } from "./terminal-status.js";

const FINALIZATION_DEADLINE_MS = 5_000;
const ACTIVITY_DIAGNOSTIC_MAX = 500;
const TERMINAL_DIAGNOSTIC_MAX = 2_000;

export interface PiBackgroundRunnerOptions {
  supervision?: PiSupervisionOptions;
  now?: () => Date;
  shutdownSignal?: AbortSignal;
}

export async function runPiBackgroundRunner(config: PiBackgroundConfig, options: PiBackgroundRunnerOptions = {}): Promise<void> {
  const deployDir = dirname(config.primerPath);
  const ownershipPath = resolve(deployDir, PI_SUPERVISOR_FILE);
  const now = options.now ?? (() => new Date());
  const secrets = environmentSecrets(process.env);
  let childPid: number | undefined;
  let ready = false;
  let repositoryLease = config.repositoryLease;
  let repositoryBorrower = config.repositoryBorrower;
  let repositoryLeaseTransferred = false;
  let repositoryBorrowerTransferred = false;
  let repositoryTicketSlotTransferred = false;
  let terminalGitSnapshot: RepositoryGitSnapshot | undefined;
  let finalState: PiSupervisorOwnership["state"] = "failed";

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
    const args = buildPiBackgroundArgs(config);
    const runtimeEnvironment = { ...process.env };
    if (repositoryBorrower) delete runtimeEnvironment[PI_PARENT_LEASE_CAPABILITY_ENV];
    const childEnv = piRegistryEnvironment(runtimeEnvironment);
    const result = await runPiManagedProcess(
      args,
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
          childPid = pid;
          ready = true;
          writePiSupervisorOwnership(ownershipPath, ownership("active"));
          options.supervision?.onSpawn?.(pid);
        },
      },
    );

    if (!ready) throw new Error("runner-spawn: Pi child did not expose a process id");
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
      if (repositoryLease?.ticketSlot) {
        refreshTicketLinkedBranchHead({
          canonicalRepoKey: repositoryLease.ticketSlot.canonicalRepoKey,
          canonicalRepoRoot: repositoryLease.canonicalRepoRoot,
          worktreeRoot,
          ticketId: repositoryLease.ticketSlot.ticket,
        });
      }
    }
    const terminal = finalizeRunnerResult(config, deployDir, result, secrets, now());
    finalState = "finalized";
    writePiSupervisorOwnership(ownershipPath, ownership("finalized", { terminalEvent: terminal.event, terminalStatus: terminal.status }));
  } catch (error) {
    terminateChild();
    const reason = bounded(categoryForRunnerError(error), secrets, TERMINAL_DIAGNOSTIC_MAX);
    try {
      const terminal = finalizeRunnerFailure(config, deployDir, reason, secrets, now());
      writePiSupervisorOwnership(ownershipPath, ownership(finalState, { error: reason, terminalEvent: terminal.event, terminalStatus: terminal.status }));
    } catch (finalizationError) {
      const combined = bounded(`runner-persistence: ${reason}; ${categoryForRunnerError(finalizationError)}`, secrets, TERMINAL_DIAGNOSTIC_MAX);
      try { writePiSupervisorOwnership(ownershipPath, ownership("failed", { error: combined })); } catch { /* launcher/status retains the causal readiness failure */ }
    }
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    options.shutdownSignal?.removeEventListener("abort", onExternalShutdown);
    try {
      let authorityFailure: string | undefined;
      if (repositoryBorrowerTransferred && repositoryBorrower) {
        const finalization = finalizeRepositoryMutationBorrower({
          canonicalRepoRoot: repositoryBorrower.canonicalRepoRoot,
          worktreeRoot: repositoryBorrower.worktreeRoot,
          repositoryGitDir: repositoryBorrower.repositoryGitDir,
          repositoryGitCommonDir: repositoryBorrower.repositoryGitCommonDir,
          borrowerToken: repositoryBorrower.borrowerToken,
          deploymentId: config.deploymentId,
          ...(terminalGitSnapshot ? { finalGitSnapshot: terminalGitSnapshot } : {}),
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
        const terminal = finalizeRunnerFailure(config, deployDir, reason, secrets, now());
        writePiSupervisorOwnership(ownershipPath, ownership("failed", { error: reason, terminalEvent: terminal.event, terminalStatus: terminal.status }));
      }
    } finally {
      ensureTerminalRegistryMarker({ deploymentId: config.deploymentId, team: config.team });
    }
  }
}

function finalizeRunnerResult(config: PiBackgroundConfig, deployDir: string, result: PiCommandResult, secrets: string[], at: Date): { event: "completed" | "crashed"; status: "success" | "failed" } {
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
          : `runner-process: ${result.spawnError?.message ?? (result.stderr || `Pi exited with code ${result.status}`)}`;
  const reason = bounded(ok ? "ppa deploy completed" : `ppa deploy failed: ${failure}`, secrets, TERMINAL_DIAGNOSTIC_MAX);
  if (!ok) appendRunnerError(config.deploymentId, reason, secrets);
  return reconcileRunnerTerminal(config, deployDir, {
    deployment_id: config.deploymentId,
    team: config.team,
    event: "completed",
    timestamp: terminalTimestamp(deployDir, ok, at),
    status: ok ? "success" : "failed",
    summary: reason,
    log_file: config.logFile,
    exit_code: ok ? 0 : result.status && result.status !== 0 ? result.status : 1,
  }, secrets);
}

function finalizeRunnerFailure(config: PiBackgroundConfig, deployDir: string, reason: string, secrets: string[], at: Date): { event: "completed" | "crashed"; status: "success" | "failed" } {
  appendRunnerError(config.deploymentId, reason, secrets);
  return reconcileRunnerTerminal(config, deployDir, {
    deployment_id: config.deploymentId,
    team: config.team,
    event: "crashed",
    timestamp: at.toISOString(),
    error: reason,
    summary: reason,
    exit_code: 1,
  }, secrets);
}

function reconcileRunnerTerminal(config: PiBackgroundConfig, deployDir: string, requested: RegistryEvent, secrets: string[]): { event: "completed" | "crashed"; status: "success" | "failed" } {
  const authoritative = reconcileTerminalRegistryEvent(requested).event;
  const success = authoritative.event === "completed" && authoritative.status === "success";
  const reason = bounded(authoritative.event === "crashed" ? authoritative.error ?? "ppa agent crashed" : authoritative.summary ?? `ppa agent completed with status ${authoritative.status ?? "unknown"}`, secrets, TERMINAL_DIAGNOSTIC_MAX);
  writePiTerminalStatus(deployDir, {
    type: "agent_end",
    stopReason: success ? "stop" : "error",
    ...(success ? {} : { error: reason }),
    timestamp: authoritative.timestamp,
  });
  return { event: authoritative.event === "crashed" ? "crashed" : "completed", status: success ? "success" : "failed" };
}

function appendRunnerError(deploymentId: string, reason: string, secrets: string[]): void {
  appendActivityEvent(createActivityEvent({
    deployId: deploymentId,
    kind: "error",
    source: "pi",
    body: bounded(reason, secrets, ACTIVITY_DIAGNOSTIC_MAX),
  }), getDeployPaths(deploymentId).activityLogPath);
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

function bounded(value: string, secrets: string[], max: number): string {
  const safe = redactDiagnostic(value, secrets);
  return safe.length > max ? `${safe.slice(0, Math.max(0, max - 3))}...` : safe;
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
