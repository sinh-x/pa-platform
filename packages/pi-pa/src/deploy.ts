import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PA_PI_EXECUTION_MODE_ENV, appendActivityEvent, createActivityEvent, emitCompletedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, ensureTerminalRegistryMarker, generatePrimer, getDeployPaths, loadTeamConfig, reconcileTerminalRegistryEvent, renderEnvVarsBlock, resolveDeployTimeoutSeconds, resolveExecutionPlan, resolveRuntimeConfig, type CoreExecutionHooks, type DeployDiagnostics, type DeployRequest, type PaEnvKey, type Rating, type RegistryEvent, type RuntimeAdapter, type SessionCommandBuilder, type TeamConfig } from "@pa-platform/pa-core";
import { PiAdapter, normalizePiEvent, type PiSupervisionHandle } from "./adapter.js";
import { environmentSecrets, redactDiagnostic } from "./diagnostics.js";
import { normalizePiRuntimeConfig, PI_DEFAULT_MODEL, PI_DEFAULT_PROVIDER, resolvePiRuntimeConfig } from "./runtime-normalization.js";
import { clearPiForegroundCompletion, ensurePiTerminalStatus, readPiForegroundCompletion, writePiTerminalStatus, type PiForegroundCompletion } from "./terminal-status.js";

export const piSessionCommand: SessionCommandBuilder = ({ model, prompt, sessionId, env, session }) => {
  const normalized = normalizePiRuntimeConfig(env?.["PA_PROVIDER"] ?? PI_DEFAULT_PROVIDER, model ?? env?.["PA_MODEL"] ?? PI_DEFAULT_MODEL);
  const args = ["--print", "--mode", "json", "--session-id", sessionId ?? session.id];
  if (normalized.model) args.push("--model", normalized.model);
  if (normalized.provider) args.push("--provider", normalized.provider);
  args.push(prompt);
  return { binary: "pi", args };
};

export function createPiHooks(adapter: RuntimeAdapter = new PiAdapter()): CoreExecutionHooks { return { deploy: (request, diagnostics) => deployWithPi(request, adapter, diagnostics), sessionNormalizer: normalizePiEvent, sessionCommand: piSessionCommand, sessionPreflight: () => adapterPreflight(adapter) }; }
export function createDefaultPiHooks(): CoreExecutionHooks { return createPiHooks(); }
export async function deployWithPi(request: DeployRequest, adapter: RuntimeAdapter = new PiAdapter(), diagnostics?: DeployDiagnostics): Promise<{ status: "pending" | "success" | "failed"; team: string; mode: string | null; deploymentId?: string; reason?: string }> {
  const timeout = resolveDeployTimeoutSeconds({ timeout: request.timeout });
  if ("error" in timeout) return { status: "failed", team: request.team, mode: request.mode ?? null, reason: timeout.error };
  const deploymentId = `d-${randomBytes(3).toString("hex")}`;
  const deployDir = ensureDeployDir(deploymentId); const paths = getDeployPaths(deploymentId); const team = loadTeamConfig(request.team); const mode = selectMode(team, request.mode);
  let runtimeConfig: ReturnType<typeof resolvePiRuntimeConfig>;
  try {
    runtimeConfig = resolvePiRuntimeConfig(resolveRuntimeConfig({ runtime: "pi", request, team, mode, local: { provider: PI_DEFAULT_PROVIDER, model: PI_DEFAULT_MODEL }, requireCompleteCliPair: true }));
  } catch (error) {
    const reason = boundedDiagnostic(error instanceof Error ? error.message : String(error), process.env, 2000);
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(reason, process.env, 500) }), paths.activityLogPath);
    const summary = boundedDiagnostic(`ppa deploy validation failed: ${reason}`, process.env, 2000);
    emitCompletedEvent({ deploymentId, team: team.name, status: "failed", summary, exitCode: 1 });
    ensurePiTerminalStatus(deployDir, terminalStatus("failed", summary));
    ensureTerminalRegistryMarker({ deploymentId, team: team.name });
    return { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason };
  }
  const provider = runtimeConfig.provider;
  const model = runtimeConfig.model;
  const env = paEnv(deploymentId, deployDir, paths.activityLogPath, team, request, provider, model);
  let plan;
  try {
    plan = resolveExecutionPlan({
      request: { ...request, ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
      teamConfig: team,
      mode,
      runtime: "pi",
      deploymentId,
      deploymentDir: deployDir,
      activityLogPath: paths.activityLogPath,
      environment: env,
      timeoutSeconds: timeout.timeout,
      trustedExtensionPath: resolve(dirname(fileURLToPath(import.meta.url)), "pi-extension/index.js"),
    });
  } catch (error) {
    const reason = boundedDiagnostic(error instanceof Error ? error.message : String(error), env, 2000);
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(reason, env, 500) }), paths.activityLogPath);
    const summary = boundedDiagnostic(`ppa deploy validation failed: ${reason}`, env, 2000);
    emitCompletedEvent({ deploymentId, team: team.name, status: "failed", summary, exitCode: 1 });
    ensurePiTerminalStatus(deployDir, terminalStatus("failed", summary));
    ensureTerminalRegistryMarker({ deploymentId, team: team.name });
    return { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason };
  }
  const primer = generatePrimer({ runtime: "pi", teamConfig: team, mode: plan.mode, objective: plan.objective, toolReference: adapter.describeTools(), templateVars: { DEPLOY_ID: deploymentId, TEAM_NAME: team.name, TODAY: new Date().toISOString().slice(0, 10), ...(plan.ticket ? { TICKET_ID: plan.ticket } : {}) }, extraInstructions: `<deployment-context>\ndeployment_id: ${deploymentId}\nteam_name: ${team.name}\nmode: ${plan.mode}\nticket_id: ${plan.ticket ?? "none"}\nrepo: ${plan.repositoryCwd}\nobjective: ${plan.objective}\ntimeout_seconds: ${plan.timeoutSeconds}\n${renderEnvVarsBlock(env)}\n</deployment-context>` });
  const primerPath = resolve(deployDir, "primer.md"); writeFileSync(primerPath, primer, "utf8"); process.stdout.write(`Deployment: ${deploymentId}\n`);
  emitResolutionWarning(runtimeConfig, deploymentId, paths.activityLogPath, diagnostics);
  appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "pi", body: `Resolved Pi runtime ${provider}/${model}`, metadata: { provider, model, resolution: runtimeConfig.source } }), paths.activityLogPath);
  if (request.dryRun) { appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "pi", body: `Dry-run primer generated for ${team.name} using ${provider}/${model}`, metadata: { provider, model } }), paths.activityLogPath); return { status: "pending", team: request.team, mode: request.mode ?? null, deploymentId }; }
  emitStartedEvent({ deploymentId, team: team.name, mode: plan.mode, primer: `deployments/${deploymentId}/primer.md`, agents: team.agents.map((agent) => agent.name), models: model ? { team: model } : {}, ticketId: plan.ticket, objective: plan.objective, provider, repo: plan.repositoryCwd, runtime: "pi", binary: "ppa", resumedFromDeploymentId: request.resume, effectiveTimeoutSeconds: plan.timeoutSeconds });
  const writeTerminal = (kind: "completed" | "crashed", status: "success" | "partial" | "failed", reason: string, exitCode: number, logFile?: string, staged?: { rating?: Rating; fallback?: boolean }): { status: "success" | "failed"; reason: string } => {
    const safeReason = boundedDiagnostic(reason, env, 2000);
    const consistentExitCode = status === "failed" ? exitCode || 1 : exitCode;
    const timestamp = new Date().toISOString();
    const requested: RegistryEvent = kind === "completed"
      ? { deployment_id: deploymentId, team: team.name, event: "completed", timestamp, status, summary: safeReason, ...(logFile ? { log_file: logFile } : {}), ...(staged?.rating ? { rating: staged.rating } : {}), ...(staged?.fallback ? { fallback: true } : {}), exit_code: consistentExitCode }
      : { deployment_id: deploymentId, team: team.name, event: "crashed", timestamp, error: safeReason, exit_code: consistentExitCode };
    // Reconcile every terminal observation so a later causal failure can replace
    // success/partial while an existing failure remains sticky and exactly once.
    const authoritative = reconcileTerminalRegistryEvent(requested).event;
    const outcome = registryTerminalOutcome(authoritative, env);
    writePiTerminalStatus(deployDir, terminalStatus(outcome.status, outcome.reason, authoritative.timestamp));
    if (!request.background) clearPiForegroundCompletion(deployDir);
    return outcome;
  };
  const completeFailure = (reason: string, exitCode = 1) => {
    const safeReason = boundedDiagnostic(reason, env, 2000);
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(safeReason, env, 500) }), paths.activityLogPath);
    writeTerminal("completed", "failed", `ppa deploy failed: ${safeReason}`, exitCode);
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: safeReason };
  };
  const crashFailure = (reason: string) => {
    const safeReason = boundedDiagnostic(reason, env, 2000);
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(safeReason, env, 500) }), paths.activityLogPath);
    writeTerminal("crashed", "failed", safeReason, 1);
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: safeReason };
  };
  try { await adapterPreflight(adapter); } catch (error) { return completeFailure(error instanceof Error ? error.message : String(error)); }
  let prior: string | undefined;
  if (request.resume) { try { prior = readSession(request.resume, adapter.sessionFileName); } catch (error) { return completeFailure(error instanceof Error ? error.message : String(error)); } }
  const sessionId = prior ?? ("allocateSessionId" in adapter && typeof adapter.allocateSessionId === "function" ? adapter.allocateSessionId() : randomBytes(16).toString("hex"));
  const sessionPath = resolve(deployDir, adapter.sessionFileName);
  try {
    writeFileSync(`${sessionPath}.tmp`, `${sessionId}\n`, "utf8");
    renameSync(`${sessionPath}.tmp`, sessionPath);
    if (readFileSync(sessionPath, "utf8").trim() !== sessionId) throw new Error("persisted Pi session id does not match the authoritative session id");
  } catch (error) {
    const reason = `could not persist Pi session id: ${error instanceof Error ? error.message : String(error)}`;
    return crashFailure(reason);
  }
  try {
    if (!request.background) clearPiForegroundCompletion(deployDir);
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env });
    const spawnOptions = { primerPath, deployId: deploymentId, mode: request.background ? "background" : "foreground", model, ...(request.background ? { timeoutMs: timeout.timeout * 1000 } : {}), logFile: resolve(deployDir, "pi.log"), env, sessionId, executionPlan: plan } as const;
    const result = prior ? await adapter.resume(spawnOptions) : await adapter.spawn(spawnOptions);
    if (result.exitCode !== 0) return completeFailure(result.errorMessage ?? `pi exited with code ${result.exitCode}`, result.exitCode);
    const terminalError = typeof result.metadata?.["terminalError"] === "string" ? result.metadata["terminalError"] : undefined;
    if (terminalError) return completeFailure(terminalError);
    if (result.sessionId !== sessionId || result.metadata?.["sessionId"] !== sessionId) throw new Error("Pi adapter returned a session id different from the persisted session id");
    const pid = result.metadata?.["pid"]; if (typeof pid === "number") emitPidEvent({ deploymentId, team: team.name, pid });
    const monitor = result.metadata?.["monitor"] as PiSupervisionHandle | undefined;
    if (request.background && result.metadata?.["pending"] === true && monitor?.completion) {
      // Backward-compatible injected-adapter seam. Production Pi background runs
      // return supervisorPid and are finalized exclusively by background-runner.ts.
      void monitor.completion.then((final) => {
        const terminalError = typeof final.metadata?.["terminalError"] === "string" ? final.metadata["terminalError"] : undefined;
        const ok = final.status === 0 && !terminalError;
        const failure = final.status !== 0 ? final.spawnError?.message ?? (final.stderr || `exit ${final.status}`) : terminalError;
        const reason = ok ? "ppa deploy completed" : `ppa deploy failed: ${failure}`;
        if (!ok) appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(reason, env, 500) }), paths.activityLogPath);
        writeTerminal("completed", ok ? "success" : "failed", reason, final.status ?? 1, resolve(deployDir, "pi.log"));
      }).catch((error) => {
        crashFailure(error instanceof Error ? error.message : String(error));
      });
      return { status: "pending", team: request.team, mode: request.mode ?? null, deploymentId };
    }
    if (request.background && result.metadata?.["pending"] === true) {
      if (typeof result.metadata?.["supervisorPid"] !== "number") throw new Error("runner-readiness: Pi background supervisor returned without ownership evidence");
      return { status: "pending", team: request.team, mode: request.mode ?? null, deploymentId };
    }
    const staged = request.background ? undefined : readStagedForegroundCompletion(deployDir, deploymentId, env, paths.activityLogPath);
    const outcome = request.background
      ? writeTerminal("completed", "success", "ppa deploy completed", 0, result.logFile)
      : staged
        ? writeTerminal("completed", staged.status, staged.summary ?? stagedCompletionSummary(staged.status), staged.status === "failed" ? 1 : 0, staged.logFile ?? result.logFile, { rating: staged.rating, fallback: staged.fallback })
        : writeTerminal("completed", "partial", "ppa foreground session exited without a staged completion payload", 0, result.logFile);
    return outcome.status === "success"
      ? { status: "success", team: request.team, mode: request.mode ?? null, deploymentId }
      : { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason: outcome.reason };
  } catch (error) { return crashFailure(error instanceof Error ? error.message : String(error)); }
}

async function adapterPreflight(adapter: RuntimeAdapter): Promise<void> {
  const pi = adapter as RuntimeAdapter & { preflight?: () => void | Promise<void> };
  await pi.preflight?.();
}

function emitResolutionWarning(config: { warning?: string }, deploymentId: string, activityLogPath: string, diagnostics?: DeployDiagnostics): void {
  if (!config.warning) return;
  if (diagnostics) diagnostics.stderr(config.warning); else process.stderr.write(`${config.warning}\n`);
  appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: config.warning, metadata: { resolution: "fallback" } }), activityLogPath);
}

function boundedDiagnostic(value: string, env: NodeJS.ProcessEnv, max: number): string {
  const safe = redactDiagnostic(value, environmentSecrets({ ...process.env, ...env }));
  return safe.length > max ? `${safe.slice(0, Math.max(0, max - 3))}...` : safe;
}

function terminalStatus(status: "success" | "failed", reason: string, timestamp = new Date().toISOString()) {
  return { type: "agent_end" as const, stopReason: status === "success" ? "stop" : "error", ...(status === "failed" ? { error: reason } : {}), timestamp };
}

function readStagedForegroundCompletion(deployDir: string, deploymentId: string, env: NodeJS.ProcessEnv, activityLogPath: string): PiForegroundCompletion | undefined {
  try {
    const completion = readPiForegroundCompletion(deployDir);
    if (completion && completion.deploymentId !== deploymentId) throw new Error("Pi foreground completion sidecar deployment does not match");
    return completion;
  } catch (error) {
    const diagnostic = boundedDiagnostic(error instanceof Error ? error.message : String(error), env, 2000);
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(diagnostic, env, 500) }), activityLogPath);
    return undefined;
  }
}

function stagedCompletionSummary(status: PiForegroundCompletion["status"]): string {
  if (status === "success") return "ppa foreground work completed";
  if (status === "partial") return "ppa foreground work completed partially";
  return "ppa foreground work reported failure";
}

function registryTerminalOutcome(event: RegistryEvent, env: NodeJS.ProcessEnv): { status: "success" | "failed"; reason: string } {
  if (event.event === "completed" && (event.status === "success" || event.status === "partial")) {
    return { status: "success", reason: boundedDiagnostic(event.summary ?? `ppa agent completed with status ${event.status}`, env, 2000) };
  }
  const reason = event.event === "crashed" ? event.error ?? "ppa agent crashed" : event.summary ?? `ppa agent completed with status ${event.status ?? "unknown"}`;
  return { status: "failed", reason: boundedDiagnostic(reason, env, 2000) };
}

function selectMode(team: TeamConfig, id?: string) { return (id ?? team.default_mode) ? team.deploy_modes?.find((item) => item.id === (id ?? team.default_mode)) : undefined; }
function paEnv(id: string, dir: string, activity: string, team: TeamConfig, request: DeployRequest, provider?: string, model?: string): Record<PaEnvKey | typeof PA_PI_EXECUTION_MODE_ENV, string> { return { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: dir, PA_ACTIVITY_LOG: activity, PA_TEAM: team.name, PA_MODE: request.mode ?? team.default_mode ?? "", PA_TICKET_ID: request.ticket ?? "", PA_REPO: request.repo ?? "", PA_PROVIDER: provider ?? "", PA_MODEL: model ?? "", PA_TEAM_MODEL: request.teamModel ?? "", PA_AGENT_MODEL: request.agentModel ?? "", [PA_PI_EXECUTION_MODE_ENV]: request.background ? "background" : "foreground" }; }
function readSession(id: string, expected: string): string { const dir = getDeployPaths(id).deployDir; const path = resolve(dir, expected); if (!existsSync(path)) { for (const [file, binary] of [["session-id-opencode.txt", "opa"], ["session-id-claude.txt", "cpa"], ["session-id-droid.txt", "dpa"], ["session-id-pi.txt", "ppa"]] as const) if (file !== expected && existsSync(resolve(dir, file))) throw new Error(`cannot resume: deploy ${id} was launched by another runtime; use '${binary} deploy --resume ${id}'`); throw new Error(`no Pi session id recorded for ${id} — cannot resume`); } const value = readFileSync(path, "utf8").trim(); if (!value) throw new Error(`empty Pi session id recorded for ${id} — cannot resume`); return value; }
