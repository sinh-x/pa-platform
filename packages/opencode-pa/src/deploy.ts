import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, ensureTerminalRegistryMarker, generatePrimer, getAgentTeamsDir, getDailyDir, getDeployPaths, getSinhInputsDir, loadTeamConfig, nowUtc, queryDeploymentStatus, redactDiagnostic, renderMemoryDocsBlock, resolveDeployTimeoutSeconds, resolveExecutionPlan, resolveRuntimeConfig, DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT, readServePidFile, TicketStore, renderEnvVarsBlock, type CoreExecutionHooks, type DeployDiagnostics, type DeployMode, type DeployRequest, type ExecutionPlan, type PaEnvKey, type RuntimeAdapter, type TeamConfig, type SessionCommandBuilder } from "@pa-platform/pa-core";
import { OpencodeAdapter, opencodeJsonToActivityEvent, resolveOpencodeRuntimeConfig } from "./adapter.js";

function buildPaEnvVars(args: {
  deploymentId: string;
  deployDir: string;
  activityLogPath: string;
  teamConfig: TeamConfig;
  request: DeployRequest;
  provider?: string;
  model?: string;
}): Record<PaEnvKey, string> {
  return {
    PA_DEPLOYMENT_ID: args.deploymentId,
    PA_DEPLOYMENT_DIR: args.deployDir,
    PA_ACTIVITY_LOG: args.activityLogPath,
    PA_TEAM: args.teamConfig.name,
    PA_MODE: args.request.mode ?? args.teamConfig.default_mode ?? "",
    PA_TICKET_ID: args.request.ticket || process.env["PA_TICKET_ID"] || "",
    PA_REPO: args.request.repo ?? "",
    PA_PROVIDER: args.provider ?? "",
    PA_MODEL: args.model ?? "",
    PA_TEAM_MODEL: args.request.teamModel ?? "",
    PA_AGENT_MODEL: args.request.agentModel ?? "",
  };
}

export function sanitizeSessionTitle(title: string): string {
  let sanitized = title
    .replace(/:/g, "-")
    .replace(/[^\w .\-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length > 60) sanitized = sanitized.slice(0, 60).trim();
  return sanitized;
}

export function deriveSessionName(args: {
  ticketId: string;
  ticketTitle?: string;
  mode?: string;
  deploymentId: string;
}): string | undefined {
  if (!args.ticketTitle) return undefined;
  const sanitized = sanitizeSessionTitle(args.ticketTitle);
  const modeLabel = args.mode ?? "default";
  const raw = `${args.ticketId}: ${sanitized} (${modeLabel}, ${args.deploymentId})`;
  return raw.length > 128 ? raw.slice(0, 128) : raw;
}

/**
 * PAP-131 FR8 / AC8: best-effort registration of a CLI `opa deploy` session
 * with the running `pa-core serve` Agent API. Resolves the server port from
 * the serve PID file (falling back to {@link DEFAULT_SERVE_PORT}) and POSTs
 * `{ deploymentId, model }` to `POST /api/sessions`. Any failure (server not
 * running, network error, non-2xx response) is swallowed and logged to stderr
 * so the deploy itself never fails due to registration.
 *
 * CQ-2: when registration fails, a lightweight text activity event is
 * appended to the deployment activity log (when `activityLogPath` is
 * provided) for post-hoc observability. The best-effort contract is
 * unchanged — deploy still succeeds.
 */
export async function registerDeploySessionBestEffort(args: { deploymentId: string; model: string; activityLogPath?: string }): Promise<void> {
  const pidInfo = readServePidFile();
  const port = pidInfo?.port ?? DEFAULT_SERVE_PORT;
  const url = `http://${DEFAULT_SERVE_HOST}:${port}/api/sessions`;
  const logRegistrationFailure = (reason: string): void => {
    process.stderr.write(`opa deploy: session registration failed (${reason}) — deploy continues\n`);
    if (args.activityLogPath) {
      try {
        appendActivityEvent(
          createActivityEvent({ deployId: args.deploymentId, kind: "text", source: "opencode", body: `session registration failed: ${reason}` }),
          args.activityLogPath,
        );
      } catch {
        // Activity log is best-effort; never let it block the deploy.
      }
    }
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: args.deploymentId, model: args.model }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      logRegistrationFailure(`HTTP ${response.status} ${response.statusText} from ${url}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logRegistrationFailure(reason);
  }
}

export function createOpencodeHooks(adapter: RuntimeAdapter = new OpencodeAdapter()): CoreExecutionHooks {
  return {
    deploy: (request, diagnostics) => deployWithOpencode(request, adapter, diagnostics),
    // Phase 2: inject the opencode activity normalizer so the Agent API
    // session hub streams structured ActivityEvents instead of raw JSONL.
    sessionNormalizer: opencodeJsonToActivityEvent,
    sessionCommand: opencodeSessionCommand,
  };
}

export const opencodeSessionCommand: SessionCommandBuilder = ({ model, prompt, sessionId, session }) => {
  const args = ["run", "-m", model ?? session.model, "--dangerously-skip-permissions"];
  if (sessionId) args.push("--session", sessionId);
  args.push("--format", "json", prompt);
  return { binary: "opencode", args };
};

export function createDefaultOpencodeHooks(): CoreExecutionHooks {
  return createOpencodeHooks();
}

export async function deployWithOpencode(request: DeployRequest, adapter: RuntimeAdapter = new OpencodeAdapter(), diagnostics?: DeployDiagnostics) {
  const resolvedTimeout = resolveDeployTimeoutSeconds({ timeout: request.timeout });
  if ("error" in resolvedTimeout) return { status: "failed" as const, team: request.team, mode: request.mode ?? null, reason: resolvedTimeout.error };
  const effectiveTimeoutSeconds = resolvedTimeout.timeout;
  const deploymentId = `d-${randomBytes(3).toString("hex")}`;
  const deployDir = ensureDeployDir(deploymentId);
  const teamConfig = loadTeamConfig(request.team);
  const selectedMode = selectDeployMode(teamConfig, request.mode);
  const runtimeConfig = resolveOpencodeRuntimeConfig(resolveRuntimeConfig({ runtime: "opencode", request, team: teamConfig, mode: selectedMode, local: { provider: "ollama-cloud" } }));
  const provider = runtimeConfig.provider!;
  const model = runtimeConfig.model!;
  const today = nowUtc().slice(0, 10);
  const ticketId = request.ticket || process.env["PA_TICKET_ID"] || undefined;
  if (!ticketId && selectedMode?.require_ticket === true) {
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, reason: "Hard block: no resolvable ticket id. Provide --ticket <id> or set PA_TICKET_ID before deploying. The opencode adapter refuses to launch without a ticket for traceability." };
  }
  let sessionName: string | undefined;
  if (ticketId) {
    try {
      const ticket = new TicketStore().get(ticketId);
      sessionName = deriveSessionName({ ticketId, ticketTitle: ticket?.title, mode: request.mode ?? teamConfig.default_mode, deploymentId });
    } catch {
      console.warn(`Failed to derive session name from ticket ${ticketId}: ticket file may be corrupt, continuing without session name`);
    }
  }
  const paths = getDeployPaths(deploymentId);
  const requestedEnvironment = buildPaEnvVars({ deploymentId, deployDir, activityLogPath: paths.activityLogPath, teamConfig, request, provider, model });
  const evaluatorObjective = buildEvaluatorObjective(request.evaluateDeployment, deploymentId, request.team);
  const objective = [request.objective, evaluatorObjective].filter(Boolean).join("\n\n");
  let plan: ExecutionPlan;
  try {
    plan = resolveExecutionPlan({
      request: { ...request, ...(ticketId ? { ticket: ticketId } : {}), ...(objective ? { objective } : {}), provider, model },
      teamConfig,
      mode: selectedMode,
      runtime: "opencode",
      deploymentId,
      deploymentDir: deployDir,
      activityLogPath: paths.activityLogPath,
      environment: requestedEnvironment,
      timeoutSeconds: effectiveTimeoutSeconds,
    });
  } catch (error) {
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: boundedDiagnostic(error) };
  }
  const env = { ...plan.environment } as Record<PaEnvKey, string>;
  const primerPath = resolve(deployDir, "primer.md");
  try {
    const extraInstructions = buildExtraInstructions(plan, teamConfig);
    const primer = generatePrimer({ runtime: "opencode", teamConfig, mode: plan.mode, objective: plan.userObjectiveOverride, repository: { repoKey: plan.repoKey, repoRoot: plan.repoRoot }, toolReference: adapter.describeTools(), templateVars: { ...computePlannerVars(teamConfig.name, selectedMode?.id, today), DEPLOY_ID: deploymentId, TEAM_NAME: teamConfig.name, TODAY: today, ...(plan.ticket ? { TICKET_ID: plan.ticket } : {}) }, extraInstructions });
    writeFileSync(primerPath, primer, "utf-8");
  } catch (error) {
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: boundedDiagnostic(error) };
  }

  const mode = request.dryRun ? "dry-run" : request.background ? "background" : "foreground";
  process.stdout.write(`Deployment: ${deploymentId}\n`);

  emitResolutionWarning(runtimeConfig, deploymentId, paths.activityLogPath, diagnostics);
  if (request.dryRun) {
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "opencode", body: `Dry-run primer generated for ${request.team} using ${model}`, metadata: { provider, model } }), paths.activityLogPath);
    await registerDeploySessionBestEffort({ deploymentId, model, activityLogPath: paths.activityLogPath });
    return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
  }

  let priorSession: string | undefined;
  try {
    priorSession = request.resume ? readPriorSession(request.resume, adapter.sessionFileName) : undefined;
  } catch (error) {
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: boundedDiagnostic(error) };
  }

  if (request.sanitizedCharsRemoved && request.sanitizedCharsRemoved > 0) {
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "opencode", body: `sanitized objective: removed ${request.sanitizedCharsRemoved} invalid character(s)` }), paths.activityLogPath);
  }

  try {
    emitStartedEvent({ deploymentId, team: teamConfig.name, mode: plan.mode, primer: `deployments/${deploymentId}/primer.md`, agents: teamConfig.agents.map((agent) => agent.name), models: { team: model, ...(request.agentModel ? { agents: request.agentModel } : {}) }, ticketId: plan.ticket, objective: plan.objective, provider, repo: plan.repoRoot, runtime: "opencode", binary: "opa", resumedFromDeploymentId: request.resume, effectiveTimeoutSeconds: plan.timeoutSeconds });
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env, executionPlan: plan });
    const result = priorSession
      ? await adapter.resume({ primerPath, deployId: deploymentId, mode, model, timeoutMs: plan.timeoutSeconds * 1000, logFile: resolve(deployDir, "opencode.log"), env, sessionId: priorSession, executionPlan: plan })
      : await adapter.spawn({ primerPath, deployId: deploymentId, mode, model, timeoutMs: plan.timeoutSeconds * 1000, logFile: resolve(deployDir, "opencode.log"), env, sessionName, executionPlan: plan });
    // Only persist a session file when a real opencode session token was captured.
    // Foreground TUI runs cannot observe one (inherited stdio) and earlier code wrote
    // the deploy id as a placeholder, which silently broke `opa deploy --resume`.
    if (result.sessionId) {
      writeFileSync(resolve(deployDir, adapter.sessionFileName), result.sessionId, "utf-8");
    }
    const rawPid = result.metadata?.["pid"];
    const pid = typeof rawPid === "number" && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
    if (pid !== undefined) emitPidEvent({ deploymentId, team: teamConfig.name, pid });
    if (mode === "background") {
      appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "opencode", body: `opencode background deploy started${pid ? ` with pid ${pid}` : ""}` }), paths.activityLogPath);
      await registerDeploySessionBestEffort({ deploymentId, model, activityLogPath: paths.activityLogPath });
      return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
    }
    // Terminal handling appends to activity.jsonl instead of overwriting — live
    // plugin and streaming events are preserved alongside the terminal event.
    const effectiveExitCode = result.exitCode;
    const errorMessage = result.errorMessage;
    const terminalKind = effectiveExitCode === 0 ? "text" : "error";
    const terminalBody = effectiveExitCode === 0
      ? `opencode exited with code ${effectiveExitCode}`
      : errorMessage
        ? `opencode exited with code ${effectiveExitCode}: ${errorMessage}`
        : `opencode exited with code ${effectiveExitCode}`;
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: terminalKind, source: "opencode", body: terminalBody }), paths.activityLogPath);
    const summary = effectiveExitCode === 0
      ? "opa deploy completed"
      : `opa deploy failed (exit ${effectiveExitCode})${errorMessage ? `: ${firstLine(errorMessage)}` : ""}`;
    emitCompletedEvent({ deploymentId, team: teamConfig.name, status: effectiveExitCode === 0 ? "success" : "failed", summary, logFile: result.logFile, exitCode: effectiveExitCode });
    ensureTerminalRegistryMarker({ deploymentId, team: teamConfig.name });
    if (effectiveExitCode === 0) {
      await registerDeploySessionBestEffort({ deploymentId, model, activityLogPath: paths.activityLogPath });
      return { status: "success" as const, team: request.team, mode: request.mode ?? null, deploymentId };
    }
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: errorMessage ?? `opencode exited with code ${effectiveExitCode}` };
  } catch (error) {
    const finalError = boundedDiagnostic(error);
    emitCrashedEvent({ deploymentId, team: teamConfig.name, error: finalError, exitCode: 1 });
    ensureTerminalRegistryMarker({ deploymentId, team: teamConfig.name });
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: finalError };
  }
}

function buildEvaluatorObjective(targetDeploymentId: string | undefined, evaluatorDeploymentId: string, evaluatorTeam: string): string | undefined {
  if (!targetDeploymentId) return undefined;
  const target = queryDeploymentStatus(targetDeploymentId);
  const status = target?.status ?? "unknown";
  const team = target?.team ?? "unknown";
  const ticket = target?.ticket_id ?? "none";
  const outputPath = `agent-teams/${evaluatorTeam}/artifacts/${nowUtc().slice(0, 10)}-${targetDeploymentId}-evaluator-report.md`;
  return [
    "## Independent Evaluator Pass",
    `Target deployment: ${targetDeploymentId}`,
    `Evaluator deployment: ${evaluatorDeploymentId}`,
    `Target team: ${team}`,
    `Target status: ${status}`,
    `Target ticket: ${ticket}`,
    "Evidence sources (read-only): objective, primer, activity, ticket state, doc refs, artifacts, session log, registry self-rating, registry status.",
    "Read-only constraints: do not mutate tickets, docs, statuses, branches, or doc refs.",
    `Output destination: ${outputPath}`,
  ].join("\n");
}

function emitResolutionWarning(config: { warning?: string }, deploymentId: string, activityLogPath: string, diagnostics?: DeployDiagnostics): void {
  if (!config.warning) return;
  const warning = redactDiagnostic(config.warning);
  if (diagnostics) diagnostics.stderr(warning); else process.stderr.write(`${warning}\n`);
  appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "opencode", body: warning, metadata: { resolution: "fallback" } }), activityLogPath);
}

function selectDeployMode(teamConfig: TeamConfig, requestedMode?: string): DeployMode | undefined {
  const modeId = requestedMode ?? teamConfig.default_mode;
  return modeId ? teamConfig.deploy_modes?.find((mode) => mode.id === modeId) : undefined;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

function readPriorSession(deploymentId: string, sessionFileName: string): string {
  const deployDir = getDeployPaths(deploymentId).deployDir;
  const sessionPath = resolve(deployDir, sessionFileName);
  if (!existsSync(sessionPath)) {
    const otherRuntime = detectOtherRuntimeSession(deployDir, sessionFileName);
    if (otherRuntime) {
      throw new Error(`cannot resume: deploy ${deploymentId} was launched by ${otherRuntime.runtime}; use '${otherRuntime.binary} deploy --resume ${deploymentId}'`);
    }
    throw new Error(`no opencode session id recorded for ${deploymentId} — cannot resume (foreground TUI runs are not resumable)`);
  }
  const value = readFileSync(sessionPath, "utf-8").trim();
  if (!value) {
    throw new Error(`empty opencode session id recorded for ${deploymentId} — cannot resume`);
  }
  return value;
}

function detectOtherRuntimeSession(deployDir: string, expectedSessionFileName: string): { runtime: string; binary: string } | undefined {
  const knownSessions: Record<string, { runtime: string; binary: string }> = {
    "session-id-claude.txt": { runtime: "claude", binary: "cpa" },
    "session-id-opencode.txt": { runtime: "opencode", binary: "opa" },
    "session-id-droid.txt": { runtime: "droid", binary: "dpa" },
    "session-id-pi.txt": { runtime: "pi", binary: "ppa" },
  };
  for (const [fileName, runtime] of Object.entries(knownSessions)) {
    if (fileName !== expectedSessionFileName && existsSync(resolve(deployDir, fileName))) return runtime;
  }
  return undefined;
}

function computePlannerVars(team: string, mode: string | undefined, today: string): Record<string, string> {
  if (team !== "planner" || !mode || !new Set(["plan", "plan-review", "progress", "end", "end-review"]).has(mode)) return {};
  const home = homedir();
  const year = today.slice(0, 4);
  const month = today.slice(5, 7);
  const outputDir = resolve(getDailyDir(), year, month);
  const dailyInbox = resolve(getAgentTeamsDir(), "planner", "inbox");
  return {
    TODAY: today,
    YEAR: year,
    MONTH: month,
    OUTPUT_DIR: outputDir,
    HOME: home,
    INPUT_NOTES: resolve(getSinhInputsDir(), "daily-plan", today),
    RPM_BLOCKS: resolve(getAgentTeamsDir(), "rpm", "rpm-blocks.yaml"),
    DAILY_INBOX: dailyInbox,
    GATHER_REPORT: resolve(dailyInbox, `${today}-end-gather.md`),
    READY_MARKER: resolve(dailyInbox, `${today}-end-ready.md`),
    DRAFT_PATH: resolve(outputDir, `${today}-plan-draft.md`),
  };
}

type DeploymentContextTeam = { name: string; agents: Array<{ name: string }> };

const MEMORY_DOC_CANDIDATES = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "OPENCODE.md", ".opencode/OPENCODE.md"];
const MAX_MEMORY_DOC_CHARS = 20000;
// opencode loads AGENTS.md/CLAUDE.md natively, so the full bodies are not re-injected here.
// A path pointer keeps the files discoverable (and preserves the <memory-doc path="..."> tag
// the dashboard parses for memory-doc sources) without duplicating natively-loaded content.
const MEMORY_DOC_POINTER_MODE = true;

function buildExtraInstructions(plan: ExecutionPlan, teamConfig: DeploymentContextTeam): string | undefined {
  const sections = [buildMemoryDocsBlock(plan), buildDeploymentContextBlock(plan, teamConfig)].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function buildMemoryDocsBlock(plan: ExecutionPlan): string | undefined {
  const docs = collectMemoryDocs(plan);
  return renderMemoryDocsBlock(docs, { runtimeLabel: "opencode", pointerMode: MEMORY_DOC_POINTER_MODE });
}

function collectMemoryDocs(plan: ExecutionPlan): Array<{ path: string; content: string }> {
  const roots = [resolve(homedir(), ".claude/CLAUDE.md"), ...MEMORY_DOC_CANDIDATES.map((candidate) => resolve(plan.memoryDocumentRoot, candidate))];
  const seen = new Set<string>();
  const docs: Array<{ path: string; content: string }> = [];
  for (const path of roots) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    const raw = readFileSync(path, "utf-8");
    docs.push({ path, content: raw.length > MAX_MEMORY_DOC_CHARS ? `${raw.slice(0, MAX_MEMORY_DOC_CHARS)}\n\n[truncated: ${raw.length - MAX_MEMORY_DOC_CHARS} chars omitted]` : raw });
  }
  return docs;
}

function buildDeploymentContextBlock(plan: ExecutionPlan, teamConfig: DeploymentContextTeam): string {
  const teamWorkspace = resolve(getAgentTeamsDir(), teamConfig.name);
  const envVarLines = renderEnvVarsBlock(plan.environment);
  return `<deployment-context>
deployment_id: ${plan.lifecycle.deploymentId}
team_name: ${teamConfig.name}
team_display_name: ${teamConfig.name}
deployed_at: ${nowUtc()}
registry_db: ${plan.lifecycle.registryDbPath}
workspace_base: ${plan.lifecycle.deploymentDir}
team_workspace: ${teamWorkspace}
cwd: ${plan.repositoryCwd}
repo_root: ${plan.repoRoot}
ticket_id: ${plan.ticket ?? "none"}
agents:
${teamConfig.agents.map((a) => `  - ${a.name}`).join("\n")}
mode: ${plan.mode}
${envVarLines}</deployment-context>`;
}

function boundedDiagnostic(error: unknown): string {
  const diagnostic = redactDiagnostic(error instanceof Error ? error.message : String(error));
  return diagnostic.length > 2000 ? `${diagnostic.slice(0, 1997)}...` : diagnostic;
}
