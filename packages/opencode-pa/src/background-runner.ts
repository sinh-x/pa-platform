import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, ensureTerminalRegistryMarker, getDeployPaths, nowUtc, publishBackgroundOwnership, queryDeploymentStatus, readProcessFingerprint, releaseRepositoryMutationLease, transferRepositoryMutationLease } from "@pa-platform/pa-core";
import { createOpencodeActivityWriter, createOpencodeSessionIdParser } from "./adapter.js";

interface BackgroundConfig {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logFile: string;
  deploymentId: string;
  team: string;
  sessionFileName: string;
  ownershipToken: string;
  ownershipPath: string;
  repositoryLease?: {
    canonicalRepoRoot: string;
    ownershipToken: string;
  };
}

const STDERR_TAIL_BYTES = 2000;
const DEFAULT_PERMISSION_WAIT_THRESHOLD_MS = 120_000;
const DEFAULT_WATCHDOG_POLL_MS = 1000;

interface PermissionWaitEvidence {
  askedAtMs: number;
  idleAtMs: number;
  ageMs: number;
  permission: string;
}

export async function runBackgroundEntry(configPath: string): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as BackgroundConfig;
  try { unlinkSync(configPath); } catch { /* preserve launch behavior if already consumed */ }
  let fatalError: unknown;
  let ready = false;
  let repositoryLeaseTransferred = false;
  const shutdown = new AbortController();
  const abortFor = (signal: string): void => { if (!shutdown.signal.aborted) shutdown.abort(signal); };
  const onSigterm = (): void => abortFor("SIGTERM");
  const onSigint = (): void => abortFor("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  const acknowledge = (childPid?: number): void => {
    ready = true;
    publishBackgroundOwnership(config.ownershipPath, { schemaVersion: 1, deploymentId: config.deploymentId, ownershipToken: config.ownershipToken, supervisorPid: process.pid, state: "active", ready: true, updatedAt: nowUtc(), ...(childPid ? { childPid } : {}) });
  };

  try {
    if (config.repositoryLease) {
      const fingerprint = readProcessFingerprint(process.pid);
      if (!fingerprint) throw new Error(`runner-readiness: cannot verify repository supervisor PID ${process.pid}`);
      const transfer = transferRepositoryMutationLease({
        canonicalRepoRoot: config.repositoryLease.canonicalRepoRoot,
        ownershipToken: config.repositoryLease.ownershipToken,
        nextProcessFingerprint: fingerprint,
      });
      if (transfer.status !== "transferred") throw new Error(`runner-readiness: repository ownership transfer failed (${transfer.status})`);
      repositoryLeaseTransferred = true;
    }
    const result = await runOpencode(config, acknowledge, shutdown.signal);
    if (!ready) throw new Error("runner-readiness: OpenCode runtime did not start");

    // Only persist a session file when the runner observed a real session token.
    // Falling back to deployment id silently broke `opa deploy --resume`.
    if (result.sessionId) {
      writeFileSync(resolve(dirname(config.logFile), config.sessionFileName), result.sessionId, "utf-8");
    }
    const activityLogPath = getDeployPaths(config.deploymentId).activityLogPath;
    const currentStatus = queryDeploymentStatus(config.deploymentId);
    if (currentStatus?.status !== "running") {
      appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "opencode", body: `opa background deploy exited after terminal status (${currentStatus?.status ?? "unknown"})` }), activityLogPath);
    } else if (result.exitCode === 0) {
      appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "opencode", body: "opa background deploy completed" }), activityLogPath);
      emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: "success", summary: "opa background deploy completed", logFile: config.logFile, exitCode: 0 });
    } else {
      const errorBody = result.stderrTail || (result.spawnError ? result.spawnError.message : `opencode exited with code ${result.exitCode}`);
      appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "error", source: "opencode", body: errorBody }), activityLogPath);
      appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "opencode", body: `opa background deploy failed with exit code ${result.exitCode}` }), activityLogPath);
      const summaryError = firstLine(result.spawnError?.message ?? result.stderrTail);
      const summary = summaryError
        ? `opa background deploy failed (exit ${result.exitCode}): ${summaryError}`
        : `opa background deploy failed (exit ${result.exitCode})`;
      emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: "failed", summary, logFile: config.logFile, exitCode: result.exitCode });
    }
  } catch (error) {
    const finalError = boundedDiagnostic(error instanceof Error ? error.message : String(error));
    try { publishBackgroundOwnership(config.ownershipPath, { schemaVersion: 1, deploymentId: config.deploymentId, ownershipToken: config.ownershipToken, supervisorPid: process.pid, state: "failed", ready: false, updatedAt: nowUtc(), error: finalError }); } catch { /* launcher reports timeout/bootstrap failure */ }
    emitCrashedEvent({ deploymentId: config.deploymentId, team: config.team, error: finalError, exitCode: 1 });
    fatalError = new Error(finalError);
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    try {
      ensureTerminalRegistryMarker({ deploymentId: config.deploymentId, team: config.team });
    } finally {
      if (repositoryLeaseTransferred && config.repositoryLease) {
        releaseRepositoryMutationLease({
          canonicalRepoRoot: config.repositoryLease.canonicalRepoRoot,
          ownershipToken: config.repositoryLease.ownershipToken,
        });
      }
    }
  }

  if (fatalError) throw fatalError;
}

if (isEntrypoint()) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Missing background config path");
  await runBackgroundEntry(configPath);
}

interface BackgroundRunResult {
  exitCode: number;
  sessionId?: string;
  stderrTail: string;
  spawnError?: Error;
}

function runOpencode(config: BackgroundConfig, onReady: (childPid?: number) => void, shutdownSignal?: AbortSignal): Promise<BackgroundRunResult> {
  mkdirSync(dirname(config.logFile), { recursive: true });
  const log = createWriteStream(config.logFile, { flags: "a" });
  const jsonl = createWriteStream(resolve(dirname(config.logFile), "opencode-output.jsonl"), { flags: "a" });
  // Both this writer and the opencode plugin (~/.config/opencode/plugins/pa-safety-activity.js)
  // append to activity.jsonl concurrently. Intentional per requirements §6 — appendFileSync({flag:"a"})
  // line-flushed writes are atomic for sub-PIPE_BUF (4096-byte) lines; STDERR_TAIL_BYTES = 2000 guarantees that.
  // Out-of-order timestamps are acceptable per §9 R2 — consumers sort by timestamp.
  const activity = createOpencodeActivityWriter(config.deploymentId, getDeployPaths(config.deploymentId).activityLogPath);
  const sessionParser = createOpencodeSessionIdParser();
  const child = spawn("opencode", config.args, { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: ["ignore", "pipe", "pipe"] });
  child.once("spawn", () => onReady(child.pid));
  let stderrTail = "";
  const permissionWaitThresholdMs = resolvePermissionWaitThresholdMs(config.env);
  const activityLogPath = getDeployPaths(config.deploymentId).activityLogPath;
  let remediationTriggered = false;

  const collectStdout = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    // Line-buffered parsing — a JSON line containing sessionID may straddle two
    // chunks, so per-chunk parseSessionId(text) was unsafe (review d-f412e8 Sec-3).
    sessionParser.write(text);
    log.write(text);
    jsonl.write(text);
    activity.write(text);
  };
  const collectStderr = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    stderrTail = tailString(stderrTail + text, STDERR_TAIL_BYTES);
    log.write(text);
    jsonl.write(text);
    activity.write(text);
  };

  child.stdout.on("data", collectStdout);
  child.stderr.on("data", collectStderr);
  const onShutdown = (): void => terminateProcessTree(child.pid);
  shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  if (shutdownSignal?.aborted) onShutdown();

  const watchdog = setInterval(() => {
    if (remediationTriggered) return;
    let activityLog = "";
    try {
      activityLog = readFileSync(activityLogPath, "utf-8");
    } catch {
      return;
    }
    const evidence = detectPermissionWaitEvidence(activityLog, Date.now(), permissionWaitThresholdMs);
    if (!evidence) return;
    remediationTriggered = true;
    const summary = `background permission wait exceeded ${Math.floor(permissionWaitThresholdMs / 1000)}s threshold`;
    appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "error", source: "opencode", body: `${summary}: permission=${evidence.permission} age=${Math.floor(evidence.ageMs / 1000)}s` }), activityLogPath);
    emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: "failed", summary, logFile: config.logFile, exitCode: 124 });
    terminateProcessTree(child.pid);
  }, DEFAULT_WATCHDOG_POLL_MS);

  return new Promise((resolvePromise) => {
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
      stderrTail = tailString(stderrTail + error.message, STDERR_TAIL_BYTES);
    });
    child.on("close", (code) => {
      shutdownSignal?.removeEventListener("abort", onShutdown);
      clearInterval(watchdog);
      activity.flush();
      const sessionId = sessionParser.flush();
      log.end();
      jsonl.end();
      resolvePromise({ exitCode: code ?? 1, ...(sessionId ? { sessionId } : {}), stderrTail, ...(spawnError ? { spawnError } : {}) });
    });
  });
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

export function resolvePermissionWaitThresholdMs(env: Record<string, string | undefined>): number {
  const raw = env["PA_PERMISSION_WAIT_TIMEOUT_SECONDS"];
  if (!raw) return DEFAULT_PERMISSION_WAIT_THRESHOLD_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_PERMISSION_WAIT_THRESHOLD_MS;
  return Math.floor(seconds * 1000);
}

export function detectPermissionWaitEvidence(activityLog: string, nowMs: number, thresholdMs: number): PermissionWaitEvidence | null {
  const lines = activityLog.split("\n").filter((line) => line.trim().length > 0);
  let latestAsked: { atMs: number; permission: string } | null = null;
  let latestRepliedMs = -1;
  let latestIdleMs = -1;

  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = String(row["event"] ?? "");
    const ts = Number(row["ts"] ?? 0);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (event === "permission.asked") {
      const data = row["data"] as { permission?: unknown } | undefined;
      latestAsked = { atMs: ts, permission: typeof data?.permission === "string" ? data.permission : "unknown" };
      continue;
    }
    if (event === "permission.replied") {
      latestRepliedMs = Math.max(latestRepliedMs, ts);
      continue;
    }
    if (event === "session.idle") latestIdleMs = Math.max(latestIdleMs, ts);
  }

  if (!latestAsked) return null;
  if (latestRepliedMs >= latestAsked.atMs) return null;
  if (latestIdleMs < latestAsked.atMs) return null;
  const ageMs = nowMs - latestAsked.atMs;
  if (ageMs < thresholdMs) return null;
  return { askedAtMs: latestAsked.atMs, idleAtMs: latestIdleMs, ageMs, permission: latestAsked.permission };
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }, 1500).unref();
}


// Truncates from the end by UTF-16 code units, not Unicode codepoints.
// For typical opencode stderr (ASCII + UTF-8) this is exact; multi-byte
// characters near the 2000-char boundary may be approximated. Acceptable
// for diagnostic logs — see review d-6be10b finding Sec-2.
function tailString(text: string, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(text.length - max);
}

function boundedDiagnostic(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 1_997)}...`;
}

function firstLine(text: string): string {
  if (!text) return "";
  return text.split("\n", 1)[0] ?? "";
}
