import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, ensureTerminalRegistryMarker, generatePrimer, getAgentTeamsDir, getDailyDir, getDeployPaths, getDeploymentDir, getRegistryDbPath, getSinhInputsDir, loadConfig, loadTeamConfig, nowUtc, queryDeploymentStatus, renderMemoryDocsBlock, renderEnvVarsBlock, resolveDeployTimeoutSeconds, resolveRepo, resolveRuntimeConfig, type CoreExecutionHooks, type DeployDiagnostics, type DeployMode, type DeployRequest, type PaEnvKey, type RuntimeAdapter, type TeamConfig } from "@pa-platform/pa-core";
import { DroidCodeAdapter, resolveDroidAutonomy, resolveDroidRuntimeConfig } from "./adapter.js";

export function createDroidHooks(adapter: RuntimeAdapter = new DroidCodeAdapter()): CoreExecutionHooks {
  return { deploy: (request, diagnostics) => deployWithDroid(request, adapter, diagnostics) };
}

export function createDefaultDroidHooks(): CoreExecutionHooks {
  return createDroidHooks();
}

// MIN-C: droidcode-pa now injects the same `pa_env_vars:` subsection that
// opencode-pa does, so all three adapters present env vars consistently to
// downstream tooling. droid's env surface matches opa's (full model/provider
// fields) since both pass them through to the runtime.
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

export async function deployWithDroid(request: DeployRequest, adapter: RuntimeAdapter = new DroidCodeAdapter(), diagnostics?: DeployDiagnostics) {
  const resolvedTimeout = resolveDeployTimeoutSeconds({ timeout: request.timeout });
  if ("error" in resolvedTimeout) return { status: "failed" as const, team: request.team, mode: request.mode ?? null, reason: resolvedTimeout.error };
  const effectiveTimeoutSeconds = resolvedTimeout.timeout;
  const deploymentId = `d-${randomBytes(3).toString("hex")}`;
  const deployDir = ensureDeployDir(deploymentId);
  const teamConfig = loadTeamConfig(request.team);
  const selectedMode = selectDeployMode(teamConfig, request.mode);
  const platformConfig = loadConfig();
  const runtimeConfig = resolveDroidRuntimeConfig(resolveRuntimeConfig({ runtime: "droid", request, team: teamConfig, mode: selectedMode }), {
    platformDefaults: platformConfig.defaults?.droidcode,
  });
  const provider = runtimeConfig.provider!;
  const model = runtimeConfig.model!;
  const today = nowUtc().slice(0, 10);
  const ticketId = request.ticket || process.env["PA_TICKET_ID"] || undefined;
  const paths = getDeployPaths(deploymentId);
  const paEnv = buildPaEnvVars({ deploymentId, deployDir, activityLogPath: paths.activityLogPath, teamConfig, request, provider, model });
  const extraInstructions = buildExtraInstructions({ deploymentId, teamConfig, ticketId, repo: request.repo, cwd: process.cwd(), mode: request.mode ?? teamConfig.default_mode, envVars: paEnv });
  const evaluatorObjective = buildEvaluatorObjective(request.evaluateDeployment, deploymentId, request.team);
  const objective = [request.objective, evaluatorObjective].filter(Boolean).join("\n\n");
  const primer = generatePrimer({ runtime: "droid", teamConfig, mode: selectedMode?.id, objective: objective || undefined, toolReference: adapter.describeTools(), templateVars: { ...computePlannerVars(teamConfig.name, selectedMode?.id, today), DEPLOY_ID: deploymentId, TEAM_NAME: teamConfig.name, TODAY: today, ...(ticketId ? { TICKET_ID: ticketId } : {}) }, extraInstructions });
  const primerPath = resolve(deployDir, "primer.md");
  writeFileSync(primerPath, primer, "utf-8");


  const autonomy = resolveDroidAutonomy({
    cliFlag: request.autonomy,
    platformDefaults: platformConfig.defaults?.droidcode,
  });
  const mode = request.dryRun ? "dry-run" : request.background ? "background" : "foreground";
  const env = { ...paEnv };
  // Resolve FACTORY_API_KEY: env var takes precedence, platform config as fallback.
  const factoryApiKey = process.env["FACTORY_API_KEY"]
    ?? platformConfig.provider_defaults?.providers?.factory?.api_key;
  if (factoryApiKey) {
    (env as Record<string, string>)["FACTORY_API_KEY"] = factoryApiKey;
  } else {
    process.stdout.write("Warning: FACTORY_API_KEY not set. Set it in your environment or in ~/.config/sinh-x/pa-platform/config.yaml under provider_defaults.providers.factory.api_key. The deploy will fail unless the key is otherwise available.\n");
  }
  process.stdout.write(`Deployment: ${deploymentId}\n`);

  emitResolutionWarning(runtimeConfig, deploymentId, paths.activityLogPath, diagnostics);
  if (request.dryRun) {
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "droid", body: `Dry-run primer generated for ${request.team} using ${provider ? `${provider}/` : ""}${model}`, metadata: { provider, model } }), paths.activityLogPath);
    return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
  }

  let priorSession: string | undefined;
  try {
    priorSession = request.resume ? readPriorSession(request.resume, adapter.sessionFileName) : undefined;
  } catch (error) {
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }

  emitStartedEvent({ deploymentId, team: teamConfig.name, mode: request.mode ?? teamConfig.default_mode, primer: `deployments/${deploymentId}/primer.md`, agents: teamConfig.agents.map((agent) => agent.name), models: { team: model, ...(request.agentModel ? { agents: request.agentModel } : {}) }, ticketId: request.ticket, objective: request.objective, provider, repo: request.repo, runtime: "droid", binary: "dpa", resumedFromDeploymentId: request.resume, effectiveTimeoutSeconds });

  try {
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env });
    const result = priorSession
      ? await adapter.resume({ primerPath, deployId: deploymentId, mode, model, autonomy, timeoutMs: effectiveTimeoutSeconds * 1000, logFile: resolve(deployDir, "droid.log"), env, sessionId: priorSession })
      : await adapter.spawn({ primerPath, deployId: deploymentId, mode, model, autonomy, timeoutMs: effectiveTimeoutSeconds * 1000, logFile: resolve(deployDir, "droid.log"), env });
    // dpa captures session ids from all modes (foreground included) via the SDK.
    if (result.sessionId) {
      writeFileSync(resolve(deployDir, adapter.sessionFileName), result.sessionId, "utf-8");
    }
    const pid = typeof result.metadata?.["pid"] === "number" ? result.metadata["pid"] : undefined;
    if (pid !== undefined) emitPidEvent({ deploymentId, team: teamConfig.name, pid });
    if (mode === "background") {
      appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "droid", body: `dpa background deploy started${pid ? ` with pid ${pid}` : ""}` }), paths.activityLogPath);
      return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
    }
    const errorMessage = result.errorMessage;
    const terminalKind = result.exitCode === 0 ? "text" : "error";
    const terminalBody = result.exitCode === 0
      ? `droid exited with code ${result.exitCode}`
      : errorMessage
        ? `droid exited with code ${result.exitCode}: ${errorMessage}`
        : `droid exited with code ${result.exitCode}`;
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: terminalKind, source: "droid", body: terminalBody }), paths.activityLogPath);
    const summary = result.exitCode === 0
      ? "dpa deploy completed"
      : `dpa deploy failed (exit ${result.exitCode})${errorMessage ? `: ${firstLine(errorMessage)}` : ""}`;
    emitCompletedEvent({ deploymentId, team: teamConfig.name, status: result.exitCode === 0 ? "success" : "failed", summary, logFile: result.logFile, exitCode: result.exitCode });
    ensureTerminalRegistryMarker({ deploymentId, team: teamConfig.name });
    return result.exitCode === 0
      ? { status: "success" as const, team: request.team, mode: request.mode ?? null, deploymentId }
      : { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: errorMessage ?? `droid exited with code ${result.exitCode}` };
  } catch (error) {
    emitCrashedEvent({ deploymentId, team: teamConfig.name, error: error instanceof Error ? error.message : String(error), exitCode: 1 });
    ensureTerminalRegistryMarker({ deploymentId, team: teamConfig.name });
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }
}

function emitResolutionWarning(config: { warning?: string }, deploymentId: string, activityLogPath: string, diagnostics?: DeployDiagnostics): void {
  if (!config.warning) return;
  if (diagnostics) diagnostics.stderr(config.warning);
  else process.stderr.write(`${config.warning}\n`);
  appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "error", source: "droid", body: config.warning }), activityLogPath);
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
    throw new Error(`no droid session id recorded for ${deploymentId} — cannot resume`);
  }
  const value = readFileSync(sessionPath, "utf-8").trim();
  if (!value) {
    throw new Error(`empty droid session id recorded for ${deploymentId} — cannot resume`);
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

interface DeploymentContextOpts {
  deploymentId: string;
  teamConfig: { name: string; agents: Array<{ name: string }> };
  ticketId?: string;
  repo?: string;
  cwd: string;
  mode?: string;
  envVars?: Partial<Record<PaEnvKey, string>>;
}

const MEMORY_DOC_CANDIDATES = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "OPENCODE.md", ".opencode/OPENCODE.md"];
const MAX_MEMORY_DOC_CHARS = 20000;
// OQ-1 (per plan): droid runtime's native memory-doc loading is UNCONFIRMED. To avoid dropping
// real context, droid defaults to FULL injection (not pointer mode). A dead pointer here would
// remove context the runtime may not load on its own. Only switch droid to pointer mode if
// native loading is confirmed.
const MEMORY_DOC_POINTER_MODE = false;

function buildExtraInstructions(opts: DeploymentContextOpts): string | undefined {
  const sections = [buildMemoryDocsBlock(opts), buildDeploymentContextBlock(opts)].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function buildMemoryDocsBlock(opts: DeploymentContextOpts): string | undefined {
  const docs = collectMemoryDocs(opts);
  return renderMemoryDocsBlock(docs, { runtimeLabel: "droid", pointerMode: MEMORY_DOC_POINTER_MODE });
}

function collectMemoryDocs(opts: DeploymentContextOpts): Array<{ path: string; content: string }> {
  const roots = [resolve(homedir(), ".claude/CLAUDE.md"), ...MEMORY_DOC_CANDIDATES.map((candidate) => resolve(resolveRepoRoot(opts.repo, opts.cwd), candidate))];
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

function resolveRepoRoot(repo: string | undefined, cwd: string): string {
  if (!repo) return cwd;
  const repoPath = repo.startsWith("~/") ? resolve(homedir(), repo.slice(2)) : repo;
  if (isAbsolute(repoPath)) return repoPath;
  try {
    return resolveRepo(repoPath).path;
  } catch {
    return resolve(cwd, repoPath);
  }
}

function buildDeploymentContextBlock(opts: DeploymentContextOpts): string {
  const registryDb = getRegistryDbPath();
  const workspaceBase = getDeploymentDir(opts.deploymentId);
  const teamWorkspace = resolve(getAgentTeamsDir(), opts.teamConfig.name);
  const now = nowUtc();
  const envVarLines = renderEnvVarsBlock(opts.envVars);
  return `<deployment-context>
deployment_id: ${opts.deploymentId}
team_name: ${opts.teamConfig.name}
team_display_name: ${opts.teamConfig.name}
deployed_at: ${now}
registry_db: ${registryDb}
workspace_base: ${workspaceBase}
team_workspace: ${teamWorkspace}
cwd: ${opts.cwd}
repo_root: ${resolveRepoRoot(opts.repo, opts.cwd)}
ticket_id: ${opts.ticketId ?? "none"}
agents:
${opts.teamConfig.agents.map((a) => `  - ${a.name}`).join("\n")}
mode: ${opts.mode ?? "default"}
${envVarLines}</deployment-context>`;
}
