import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, ensureTerminalRegistryMarker, generatePrimer, getAgentTeamsDir, getDailyDir, getDeployPaths, getDeploymentDir, getRegistryDbPath, getSinhInputsDir, loadTeamConfig, nowUtc, queryDeploymentStatus, renderMemoryDocsBlock, resolveDeployTimeoutSeconds, resolveRepo, TicketStore, writeActivityEvents, renderEnvVarsBlock, type CoreExecutionHooks, type DeployMode, type DeployRequest, type PaEnvKey, type RuntimeAdapter, type TeamConfig } from "@pa-platform/pa-core";
import { OpencodeAdapter, resolveOpencodeModel } from "./adapter.js";

function buildPaEnvVars(args: {
  deploymentId: string;
  deployDir: string;
  activityLogPath: string;
  teamConfig: TeamConfig;
  request: DeployRequest;
}): Record<PaEnvKey, string> {
  return {
    PA_DEPLOYMENT_ID: args.deploymentId,
    PA_DEPLOYMENT_DIR: args.deployDir,
    PA_ACTIVITY_LOG: args.activityLogPath,
    PA_TEAM: args.teamConfig.name,
    PA_MODE: args.request.mode ?? args.teamConfig.default_mode ?? "",
    PA_TICKET_ID: args.request.ticket || process.env["PA_TICKET_ID"] || "",
    PA_REPO: args.request.repo ?? "",
    PA_PROVIDER: args.request.provider ?? "",
    PA_MODEL: args.request.model ?? "",
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

export function createOpencodeHooks(adapter: RuntimeAdapter = new OpencodeAdapter()): CoreExecutionHooks {
  return { deploy: (request) => deployWithOpencode(request, adapter) };
}

export function createDefaultOpencodeHooks(): CoreExecutionHooks {
  return createOpencodeHooks();
}

export async function deployWithOpencode(request: DeployRequest, adapter: RuntimeAdapter = new OpencodeAdapter()) {
  const resolvedTimeout = resolveDeployTimeoutSeconds({ timeout: request.timeout });
  if ("error" in resolvedTimeout) return { status: "failed" as const, team: request.team, mode: request.mode ?? null, reason: resolvedTimeout.error };
  const effectiveTimeoutSeconds = resolvedTimeout.timeout;
  const deploymentId = `d-${randomBytes(3).toString("hex")}`;
  const deployDir = ensureDeployDir(deploymentId);
  const teamConfig = loadTeamConfig(request.team);
  const selectedMode = selectDeployMode(teamConfig, request.mode);
  const today = nowUtc().slice(0, 10);
  const ticketId = request.ticket || process.env["PA_TICKET_ID"] || undefined;
  if (!ticketId) {
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
  const env = buildPaEnvVars({ deploymentId, deployDir, activityLogPath: paths.activityLogPath, teamConfig, request });
  const extraInstructions = buildExtraInstructions({ deploymentId, teamConfig, ticketId, repo: request.repo, cwd: process.cwd(), mode: request.mode ?? teamConfig.default_mode, envVars: env });
  const evaluatorObjective = buildEvaluatorObjective(request.evaluateDeployment, deploymentId, request.team);
  const objective = [request.objective, evaluatorObjective].filter(Boolean).join("\n\n");
  const primer = generatePrimer({ runtime: "opencode", teamConfig, mode: request.mode, objective: objective || undefined, toolReference: adapter.describeTools(), templateVars: { ...computePlannerVars(teamConfig.name, request.mode, today), DEPLOY_ID: deploymentId, TEAM_NAME: teamConfig.name, TODAY: today, ...(ticketId ? { TICKET_ID: ticketId } : {}) }, extraInstructions });
  const primerPath = resolve(deployDir, "primer.md");
  writeFileSync(primerPath, primer, "utf-8");

  const provider = request.provider
    ?? selectedMode?.runtimes?.opencode?.provider
    ?? teamConfig.runtimes?.opencode?.provider
    ?? selectedMode?.provider
    ?? "ollama-cloud";
  const model = resolveOpencodeModel(provider, request.model
    ?? request.teamModel
    ?? selectedMode?.runtimes?.opencode?.model
    ?? teamConfig.runtimes?.opencode?.model
    ?? selectedMode?.model);
  const mode = request.dryRun ? "dry-run" : request.background ? "background" : "foreground";
  process.stdout.write(`Deployment: ${deploymentId}\n`);

  if (request.dryRun) {
    writeActivityEvents([createActivityEvent({ deployId: deploymentId, kind: "text", source: "opencode", body: `Dry-run primer generated for ${request.team} using ${model}` })], paths.activityLogPath);
    return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
  }

  let priorSession: string | undefined;
  try {
    priorSession = request.resume ? readPriorSession(request.resume, adapter.sessionFileName) : undefined;
  } catch (error) {
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }

  emitStartedEvent({ deploymentId, team: teamConfig.name, primer: `deployments/${deploymentId}/primer.md`, agents: teamConfig.agents.map((agent) => agent.name), models: { team: model, ...(request.agentModel ? { agents: request.agentModel } : {}) }, ticketId: request.ticket, objective: request.objective, provider, repo: request.repo, runtime: "opencode", binary: "opa", resumedFromDeploymentId: request.resume, effectiveTimeoutSeconds });

  if (request.sanitizedCharsRemoved && request.sanitizedCharsRemoved > 0) {
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "opencode", body: `sanitized objective: removed ${request.sanitizedCharsRemoved} invalid character(s)` }), paths.activityLogPath);
  }

  try {
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env });
    const result = priorSession
      ? await adapter.resume({ primerPath, deployId: deploymentId, mode, model, timeoutMs: effectiveTimeoutSeconds * 1000, logFile: resolve(deployDir, "opencode.log"), env, sessionId: priorSession })
      : await adapter.spawn({ primerPath, deployId: deploymentId, mode, model, timeoutMs: effectiveTimeoutSeconds * 1000, logFile: resolve(deployDir, "opencode.log"), env, sessionName });
    // Only persist a session file when a real opencode session token was captured.
    // Foreground TUI runs cannot observe one (inherited stdio) and earlier code wrote
    // the deploy id as a placeholder, which silently broke `opa deploy --resume`.
    if (result.sessionId) {
      writeFileSync(resolve(deployDir, adapter.sessionFileName), result.sessionId, "utf-8");
    }
    const pid = typeof result.metadata?.["pid"] === "number" ? result.metadata["pid"] : undefined;
    if (pid !== undefined) emitPidEvent({ deploymentId, team: teamConfig.name, pid });
    if (mode === "background") {
      appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "opencode", body: `opencode background deploy started${pid ? ` with pid ${pid}` : ""}` }), paths.activityLogPath);
      return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
    }
    // Finalization appends to activity.jsonl instead of overwriting — live events from
    // the opencode plugin (~/.config/opencode/plugins/pa-safety-activity.js) and any
    // streaming writer are preserved alongside our terminal event.
    const errorMessage = result.errorMessage;
    const terminalKind = result.exitCode === 0 ? "text" : "error";
    const terminalBody = result.exitCode === 0
      ? `opencode exited with code ${result.exitCode}`
      : errorMessage
        ? `opencode exited with code ${result.exitCode}: ${errorMessage}`
        : `opencode exited with code ${result.exitCode}`;
    appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: terminalKind, source: "opencode", body: terminalBody }), paths.activityLogPath);
    const summary = result.exitCode === 0
      ? "opa deploy completed"
      : `opa deploy failed (exit ${result.exitCode})${errorMessage ? `: ${firstLine(errorMessage)}` : ""}`;
    emitCompletedEvent({ deploymentId, team: teamConfig.name, status: result.exitCode === 0 ? "success" : "failed", summary, logFile: result.logFile, exitCode: result.exitCode });
    ensureTerminalRegistryMarker({ deploymentId, team: teamConfig.name });
    return result.exitCode === 0
      ? { status: "success" as const, team: request.team, mode: request.mode ?? null, deploymentId }
      : { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: errorMessage ?? `opencode exited with code ${result.exitCode}` };
  } catch (error) {
    emitCrashedEvent({ deploymentId, team: teamConfig.name, error: error instanceof Error ? error.message : String(error), exitCode: 1 });
    ensureTerminalRegistryMarker({ deploymentId, team: teamConfig.name });
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
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
// opencode loads AGENTS.md/CLAUDE.md natively, so the full bodies are not re-injected here.
// A path pointer keeps the files discoverable (and preserves the <memory-doc path="..."> tag
// the dashboard parses for memory-doc sources) without duplicating natively-loaded content.
const MEMORY_DOC_POINTER_MODE = true;

function buildExtraInstructions(opts: DeploymentContextOpts): string | undefined {
  const sections = [buildMemoryDocsBlock(opts), buildDeploymentContextBlock(opts)].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function buildMemoryDocsBlock(opts: DeploymentContextOpts): string | undefined {
  const docs = collectMemoryDocs(opts);
  return renderMemoryDocsBlock(docs, { runtimeLabel: "opencode", pointerMode: MEMORY_DOC_POINTER_MODE });
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
