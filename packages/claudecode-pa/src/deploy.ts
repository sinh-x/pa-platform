import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, generatePrimer, getAgentTeamsDir, getDailyDir, getDeployPaths, getDeploymentDir, getRegistryDbPath, getSinhInputsDir, loadTeamConfig, nowUtc, resolveDeployTimeoutSeconds, resolveRepo, writeActivityEvents, type CoreExecutionHooks, type DeployMode, type DeployRequest, type RuntimeAdapter, type TeamConfig } from "@pa-platform/pa-core";
import { ClaudeCodeAdapter, resolveClaudeModel } from "./adapter.js";

export function createClaudeHooks(adapter: RuntimeAdapter = new ClaudeCodeAdapter()): CoreExecutionHooks {
  return { deploy: (request) => deployWithClaude(request, adapter) };
}

export function createDefaultClaudeHooks(): CoreExecutionHooks {
  return createClaudeHooks();
}

export async function deployWithClaude(request: DeployRequest, adapter: RuntimeAdapter = new ClaudeCodeAdapter()) {
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
  const primer = generatePrimer({ runtime: "claude", teamConfig, mode: request.mode, objective: request.objective, toolReference: adapter.describeTools(), templateVars: { ...computePlannerVars(teamConfig.name, request.mode, today), DEPLOY_ID: deploymentId, TEAM_NAME: teamConfig.name, TODAY: today, ...(ticketId ? { TICKET_ID: ticketId } : {}) }, extraInstructions });
  const primerPath = resolve(deployDir, "primer.md");
  writeFileSync(primerPath, primer, "utf-8");

  // cpa is anthropic-only. Ignore team-mode YAML `provider:` when it isn't anthropic
  // so the runtime adapter (cpa) drives provider selection — the team mode setting is
  // for opa/other adapters. An explicit `--provider <other>` from the user is still
  // rejected by `normalizeProvider` below.
  const teamModeProviderIsAnthropic = !selectedMode?.provider || selectedMode.provider === "anthropic";
  const provider = request.provider ?? "anthropic";
  const teamModeModel = teamModeProviderIsAnthropic ? selectedMode?.model : undefined;
  let model: string;
  try {
    model = resolveClaudeModel(provider, request.model ?? request.teamModel ?? teamModeModel);
  } catch (error) {
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }
  const mode = request.dryRun ? "dry-run" : request.background ? "background" : "foreground";
  const paths = getDeployPaths(deploymentId);
  const env = { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: deployDir, PA_ACTIVITY_LOG: paths.activityLogPath, PA_TEAM: teamConfig.name };
  process.stdout.write(`Deployment: ${deploymentId}\n`);

  if (request.dryRun) {
    writeActivityEvents([createActivityEvent({ deployId: deploymentId, kind: "text", source: "claude", body: `Dry-run primer generated for ${request.team} using ${model}` })], paths.activityLogPath);
    return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
  }

  let priorSession: string | undefined;
  try {
    priorSession = request.resume ? readPriorSession(request.resume, adapter.sessionFileName) : undefined;
  } catch (error) {
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }

  emitStartedEvent({ deploymentId, team: teamConfig.name, primer: `deployments/${deploymentId}/primer.md`, agents: teamConfig.agents.map((agent) => agent.name), models: { team: model, ...(request.agentModel ? { agents: request.agentModel } : {}) }, ticketId: request.ticket, objective: request.objective, provider, repo: request.repo, runtime: "claude", binary: "cpa", resumedFromDeploymentId: request.resume, effectiveTimeoutSeconds });

  try {
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env });
    const result = priorSession
      ? await adapter.resume({ primerPath, deployId: deploymentId, mode, model, timeoutMs: effectiveTimeoutSeconds * 1000, logFile: resolve(deployDir, "claude.log"), env, sessionId: priorSession })
      : await adapter.spawn({ primerPath, deployId: deploymentId, mode, model, timeoutMs: effectiveTimeoutSeconds * 1000, logFile: resolve(deployDir, "claude.log"), env });
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

const MEMORY_DOC_CANDIDATES = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"];
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
    "The following instruction files were explicitly included so cpa deployments inherit Claude Code memory regardless of how the spawned process resolves CLAUDE.md. Follow them unless they conflict with this deployment primer.",
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
