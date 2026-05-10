import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { appendActivityEvent, appendRegistryEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, ensureTerminalRegistryMarker, generatePrimer, getAgentTeamsDir, getDailyDir, getDeployPaths, getDeploymentEvents, getDeploymentDir, getRegistryDbPath, getSinhInputsDir, loadTeamConfig, nowUtc, queryDeploymentStatus, resolveDeployTimeoutSeconds, resolveRepo, runCoreCommand, writeActivityEvents, type CoreExecutionHooks, type DeployMode, type DeployRequest, type RuntimeAdapter, type TeamConfig } from "@pa-platform/pa-core";
import { OpencodeAdapter, resolveOpencodeModel } from "./adapter.js";

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
  const ticketId = request.ticket;
  const extraInstructions = buildExtraInstructions({ deploymentId, teamConfig, ticketId, repo: request.repo, cwd: process.cwd(), mode: request.mode ?? teamConfig.default_mode });
  const evaluatorObjective = buildEvaluatorObjective(request.evaluateDeployment, deploymentId, request.team);
  const objective = [request.objective, evaluatorObjective].filter(Boolean).join("\n\n");
  const primer = generatePrimer({ runtime: "opencode", teamConfig, mode: request.mode, objective: objective || undefined, toolReference: adapter.describeTools(), templateVars: { ...computePlannerVars(teamConfig.name, request.mode, today), DEPLOY_ID: deploymentId, TEAM_NAME: teamConfig.name, TODAY: today, ...(ticketId ? { TICKET_ID: ticketId } : {}) }, extraInstructions });
  const primerPath = resolve(deployDir, "primer.md");
  writeFileSync(primerPath, primer, "utf-8");

  const provider = request.provider ?? selectedMode?.provider ?? "openai";
  const model = resolveOpencodeModel(provider, request.model ?? request.teamModel ?? selectedMode?.model);
  const mode = request.dryRun ? "dry-run" : request.background ? "background" : "foreground";
  const paths = getDeployPaths(deploymentId);
  const env = {
    PA_DEPLOYMENT_ID: deploymentId,
    PA_DEPLOYMENT_DIR: deployDir,
    PA_ACTIVITY_LOG: paths.activityLogPath,
    PA_TEAM: teamConfig.name,
    PA_MODE: request.mode ?? teamConfig.default_mode ?? "",
    PA_TICKET_ID: request.ticket ?? "",
    PA_REPO: request.repo ?? "",
    PA_PROVIDER: request.provider ?? "",
    PA_MODEL: request.model ?? "",
    PA_TEAM_MODEL: request.teamModel ?? "",
    PA_AGENT_MODEL: request.agentModel ?? "",
  };
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

  try {
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env });
    const result = priorSession
      ? await adapter.resume({ primerPath, deployId: deploymentId, mode, model, timeoutMs: effectiveTimeoutSeconds * 1000, logFile: resolve(deployDir, "opencode.log"), env, sessionId: priorSession })
      : await adapter.spawn({ primerPath, deployId: deploymentId, mode, model, timeoutMs: effectiveTimeoutSeconds * 1000, logFile: resolve(deployDir, "opencode.log"), env });
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
    await maybeLaunchPostDeployEvaluation({
      deploymentId,
      team: teamConfig.name,
      mode: request.mode ?? teamConfig.default_mode,
      ticket: request.ticket,
      repo: request.repo,
      provider: request.provider,
      model: request.model,
      teamModel: request.teamModel,
      agentModel: request.agentModel,
      hooks: { deploy: (nextRequest) => deployWithOpencode(nextRequest, adapter) },
    });
    return result.exitCode === 0
      ? { status: "success" as const, team: request.team, mode: request.mode ?? null, deploymentId }
      : { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: errorMessage ?? `opencode exited with code ${result.exitCode}` };
  } catch (error) {
    emitCrashedEvent({ deploymentId, team: teamConfig.name, error: error instanceof Error ? error.message : String(error), exitCode: 1 });
    ensureTerminalRegistryMarker({ deploymentId, team: teamConfig.name });
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }
}

type BuilderCompletionPath = "builder-implement" | "builder-orchestrator";

interface PostDeployEvaluationOpts {
  deploymentId: string;
  team: string;
  mode?: string;
  ticket?: string;
  repo?: string;
  provider?: string;
  model?: string;
  teamModel?: string;
  agentModel?: string;
  hooks: CoreExecutionHooks;
}

async function maybeLaunchPostDeployEvaluation(opts: PostDeployEvaluationOpts): Promise<void> {
  const completionPath = resolveBuilderCompletionPath(opts.team, opts.mode);
  if (!completionPath) return;
  const status = queryDeploymentStatus(opts.deploymentId);
  if (!status || status.status !== "success") return;
  if (isEvaluationAlreadyRecorded(opts.deploymentId, completionPath)) return;
  const command = ["evaluate", "--evaluate-deployment", opts.deploymentId, "--background"];
  if (opts.ticket) command.push("--ticket", opts.ticket);
  if (opts.repo) command.push("--repo", opts.repo);
  if (opts.provider) command.push("--provider", opts.provider);
  if (opts.model) command.push("--model", opts.model);
  if (opts.teamModel) command.push("--team-model", opts.teamModel);
  if (opts.agentModel) command.push("--agent-model", opts.agentModel);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCoreCommand(command, { hooks: opts.hooks, io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, binaryName: "opa" });
  const evaluatorDeploymentId = extractEvaluatorDeploymentId(stdout.join("\n"));

  appendRegistryEvent({
    deployment_id: opts.deploymentId,
    team: opts.team,
    event: "updated",
    timestamp: nowUtc(),
    note: code === 0
      ? `[evaluator-launch path=${completionPath}] target=${opts.deploymentId} status=launched evaluator_deployment_id=${evaluatorDeploymentId ?? "unknown"}`
      : `[evaluator-launch path=${completionPath}] target=${opts.deploymentId} status=failed reason=${compactReason(stderr.join("\n") || stdout.join("\n") || `evaluate exited ${code}`)}`,
  });
}

function resolveBuilderCompletionPath(team: string, mode?: string): BuilderCompletionPath | null {
  if (team !== "builder") return null;
  if (mode === "implement") return "builder-implement";
  if (mode === "orchestrator") return "builder-orchestrator";
  return null;
}

function isEvaluationAlreadyRecorded(deploymentId: string, completionPath: BuilderCompletionPath): boolean {
  return getDeploymentEvents(deploymentId).some((event) => event.event === "updated" && event.note?.includes(`[evaluator-launch path=${completionPath}]`));
}

function extractEvaluatorDeploymentId(output: string): string | undefined {
  const match = output.match(/Evaluation\s+(?:pending|completed):\s+(d-[a-z0-9]{6})/);
  return match?.[1];
}

function compactReason(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "unknown";
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 239)}...`;
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
}

const MEMORY_DOC_CANDIDATES = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "OPENCODE.md", ".opencode/OPENCODE.md"];
const MAX_MEMORY_DOC_CHARS = 20000;

function buildExtraInstructions(opts: DeploymentContextOpts): string | undefined {
  const sections = [buildMemoryDocsBlock(opts), buildDeploymentContextBlock(opts)].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function buildMemoryDocsBlock(opts: DeploymentContextOpts): string | undefined {
  const docs = collectMemoryDocs(opts);
  if (docs.length === 0) return undefined;
  return [
    "## Memory Docs",
    "The following instruction files were explicitly included to emulate Claude Code memory for opencode deployments. Follow them unless they conflict with this deployment primer.",
    ...docs.map((doc) => `<memory-doc path="${doc.path}">\n${doc.content}\n</memory-doc>`),
  ].join("\n\n");
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
</deployment-context>`;
}
