import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, generatePrimer, getAgentTeamsDir, getDailyDir, getDeployPaths, getSinhInputsDir, loadTeamConfig, nowUtc, redactDiagnostic, renderMemoryDocsBlock, renderEnvVarsBlock, resolveDeployTimeoutSeconds, resolveExecutionPlan, resolveRuntimeConfig, type CoreExecutionHooks, type DeployDiagnostics, type DeployMode, type DeployRequest, type ExecutionPlan, type PaEnvKey, type RuntimeAdapter, type TeamConfig } from "@pa-platform/pa-core";
import { ClaudeCodeAdapter, resolveClaudeRuntimeConfig } from "./adapter.js";

export function createClaudeHooks(adapter: RuntimeAdapter = new ClaudeCodeAdapter()): CoreExecutionHooks {
  return { deploy: (request, diagnostics) => deployWithClaude(request, adapter, diagnostics) };
}

export function createDefaultClaudeHooks(): CoreExecutionHooks {
  return createClaudeHooks();
}

// MIN-C: claudecode-pa now injects the same `pa_env_vars:` subsection that
// opencode-pa does, so all three adapters present env vars consistently to
// downstream tooling. claude's effective env surface is narrower than opa/dpa
// (it is anthropic-only and ignores team-mode `provider:` for non-anthropic),
// so the model/provider fields reflect what claude actually resolved.
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

export async function deployWithClaude(request: DeployRequest, adapter: RuntimeAdapter = new ClaudeCodeAdapter(), diagnostics?: DeployDiagnostics) {
  const resolvedTimeout = resolveDeployTimeoutSeconds({ timeout: request.timeout });
  if ("error" in resolvedTimeout) return { status: "failed" as const, team: request.team, mode: request.mode ?? null, reason: resolvedTimeout.error };
  const effectiveTimeoutSeconds = resolvedTimeout.timeout;
  const deploymentId = `d-${randomBytes(3).toString("hex")}`;
  const deployDir = ensureDeployDir(deploymentId);
  const teamConfig = loadTeamConfig(request.team);
  const selectedMode = selectDeployMode(teamConfig, request.mode);
  const runtimeConfig = resolveClaudeRuntimeConfig(resolveRuntimeConfig({ runtime: "claude", request, team: teamConfig, mode: selectedMode, local: { provider: "anthropic" } }));
  const provider = runtimeConfig.provider!;
  const model = runtimeConfig.model!;
  const today = nowUtc().slice(0, 10);
  const ticketId = request.ticket || process.env["PA_TICKET_ID"] || undefined;
  const paths = getDeployPaths(deploymentId);
  const requestedEnvironment = buildPaEnvVars({ deploymentId, deployDir, activityLogPath: paths.activityLogPath, teamConfig, request, provider, model });
  let plan: ExecutionPlan;
  try {
    plan = resolveExecutionPlan({
      request: { ...request, ...(ticketId ? { ticket: ticketId } : {}), provider, model },
      teamConfig,
      mode: selectedMode,
      runtime: "claude",
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
  const extraInstructions = buildExtraInstructions(plan, teamConfig);
  const primer = generatePrimer({ runtime: "claude", teamConfig, mode: plan.mode, objective: plan.objective, repository: { repoKey: plan.repoKey, repoRoot: plan.repoRoot }, toolReference: adapter.describeTools(), templateVars: { ...computePlannerVars(teamConfig.name, selectedMode?.id, today), DEPLOY_ID: deploymentId, TEAM_NAME: teamConfig.name, TODAY: today, ...(plan.ticket ? { TICKET_ID: plan.ticket } : {}) }, extraInstructions });
  const primerPath = resolve(deployDir, "primer.md");
  writeFileSync(primerPath, primer, "utf-8");

  const mode = request.dryRun ? "dry-run" : request.background ? "background" : "foreground";
  process.stdout.write(`Deployment: ${deploymentId}\n`);

  emitResolutionWarning(runtimeConfig, deploymentId, paths.activityLogPath, diagnostics);
  if (request.dryRun) {
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "claude", body: `Dry-run primer generated for ${request.team} using ${model} (${provider})`, metadata: { provider, model } }), paths.activityLogPath);
    return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
  }

  let priorSession: string | undefined;
  try {
    priorSession = request.resume ? readPriorSession(request.resume, adapter.sessionFileName) : undefined;
  } catch (error) {
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }

  emitStartedEvent({ deploymentId, team: teamConfig.name, mode: plan.mode, primer: `deployments/${deploymentId}/primer.md`, agents: teamConfig.agents.map((agent) => agent.name), models: { team: model, ...(request.agentModel ? { agents: request.agentModel } : {}) }, ticketId: plan.ticket, objective: plan.objective, provider, repo: plan.repoRoot, runtime: "claude", binary: "cpa", resumedFromDeploymentId: request.resume, effectiveTimeoutSeconds: plan.timeoutSeconds });

  try {
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env });
    const result = priorSession
      ? await adapter.resume({ primerPath, deployId: deploymentId, mode, model, timeoutMs: plan.timeoutSeconds * 1000, logFile: resolve(deployDir, "claude.log"), env, sessionId: priorSession, executionPlan: plan })
      : await adapter.spawn({ primerPath, deployId: deploymentId, mode, model, timeoutMs: plan.timeoutSeconds * 1000, logFile: resolve(deployDir, "claude.log"), env, executionPlan: plan });
    // Only persist a session file when a real claude session id was captured.
    // Foreground TUI runs cannot observe one (inherited stdio); writing the deploy id
    // as a placeholder would silently break `cpa deploy --resume`.
    if (result.sessionId) {
      writeFileSync(resolve(deployDir, adapter.sessionFileName), result.sessionId, "utf-8");
    }
    const pid = typeof result.metadata?.["pid"] === "number" ? result.metadata["pid"] : undefined;
    if (pid !== undefined) emitPidEvent({ deploymentId, team: teamConfig.name, pid });
    if (mode === "background") {
      appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "claude", body: `claude background deploy started${pid ? ` with pid ${pid}` : ""}` }), paths.activityLogPath);
      return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
    }
    // Finalization appends to activity.jsonl instead of overwriting — events from any
    // streaming writer are preserved alongside our terminal event.
    const errorMessage = result.errorMessage;
    const terminalKind = result.exitCode === 0 ? "text" : "error";
    const terminalBody = result.exitCode === 0
      ? `claude exited with code ${result.exitCode}`
      : errorMessage
        ? `claude exited with code ${result.exitCode}: ${errorMessage}`
        : `claude exited with code ${result.exitCode}`;
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: terminalKind, source: "claude", body: terminalBody }), paths.activityLogPath);
    const summary = result.exitCode === 0
      ? "cpa deploy completed"
      : `cpa deploy failed (exit ${result.exitCode})${errorMessage ? `: ${firstLine(errorMessage)}` : ""}`;
    emitCompletedEvent({ deploymentId, team: teamConfig.name, status: result.exitCode === 0 ? "success" : "failed", summary, logFile: result.logFile, exitCode: result.exitCode });
    return result.exitCode === 0
      ? { status: "success" as const, team: request.team, mode: request.mode ?? null, deploymentId }
      : { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: errorMessage ?? `claude exited with code ${result.exitCode}` };
  } catch (error) {
    emitCrashedEvent({ deploymentId, team: teamConfig.name, error: error instanceof Error ? error.message : String(error), exitCode: 1 });
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }
}

function emitResolutionWarning(config: { warning?: string }, deploymentId: string, activityLogPath: string, diagnostics?: DeployDiagnostics): void {
  if (!config.warning) return;
  if (diagnostics) diagnostics.stderr(config.warning); else process.stderr.write(`${config.warning}\n`);
  appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "claude", body: config.warning, metadata: { resolution: "fallback" } }), activityLogPath);
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
    throw new Error(`no claude session id recorded for ${deploymentId} — cannot resume (foreground TUI runs are not resumable)`);
  }
  const value = readFileSync(sessionPath, "utf-8").trim();
  if (!value) {
    throw new Error(`empty claude session id recorded for ${deploymentId} — cannot resume`);
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

const MEMORY_DOC_CANDIDATES = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"];
const MAX_MEMORY_DOC_CHARS = 20000;
// claude (Claude Code) loads CLAUDE.md natively, so the full bodies are not re-injected here.
// A path pointer keeps the files discoverable (and preserves the <memory-doc path="..."> tag
// the dashboard parses for memory-doc sources) without duplicating natively-loaded content.
const MEMORY_DOC_POINTER_MODE = true;

function buildExtraInstructions(plan: ExecutionPlan, teamConfig: DeploymentContextTeam): string | undefined {
  const sections = [buildMemoryDocsBlock(plan), buildDeploymentContextBlock(plan, teamConfig)].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function buildMemoryDocsBlock(plan: ExecutionPlan): string | undefined {
  const docs = collectMemoryDocs(plan);
  return renderMemoryDocsBlock(docs, { runtimeLabel: "Claude Code", pointerMode: MEMORY_DOC_POINTER_MODE });
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
repository_access: ${plan.repositoryAccess}
${envVarLines}</deployment-context>`;
}

function boundedDiagnostic(error: unknown): string {
  const diagnostic = redactDiagnostic(error instanceof Error ? error.message : String(error));
  return diagnostic.length > 2000 ? `${diagnostic.slice(0, 1997)}...` : diagnostic;
}
