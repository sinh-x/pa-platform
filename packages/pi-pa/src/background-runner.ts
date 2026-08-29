import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendActivityEvent,
  createActivityEvent,
  ensureTerminalRegistryMarker,
  getDeployPaths,
  reconcileTerminalRegistryEvent,
  type RegistryEvent,
} from "@pa-platform/pa-core";
import {
  buildPiBackgroundArgs,
  PI_SUPERVISOR_FILE,
  readPiBackgroundConfig,
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
    const args = buildPiBackgroundArgs(config);
    const childEnv = piRegistryEnvironment({ ...process.env });
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
    ensureTerminalRegistryMarker({ deploymentId: config.deploymentId, team: config.team });
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
