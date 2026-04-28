import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, generatePrimer, getDeployPaths, loadTeamConfig, nowUtc, resolveRepo, writeActivityEvents, type CoreExecutionHooks, type DeployRequest, type RuntimeAdapter } from "@pa-platform/pa-core";
import { OpencodeAdapter, resolveOpencodeModel } from "./adapter.js";

export function createOpencodeHooks(adapter: RuntimeAdapter = new OpencodeAdapter()): CoreExecutionHooks {
  return { deploy: (request) => deployWithOpencode(request, adapter) };
}

export async function deployWithOpencode(request: DeployRequest, adapter: RuntimeAdapter = new OpencodeAdapter()) {
  const deploymentId = `d-${randomBytes(3).toString("hex")}`;
  const deployDir = ensureDeployDir(deploymentId);
  const teamConfig = loadTeamConfig(request.team);
  const today = nowUtc().slice(0, 10);
  const ticketId = request.ticket;
  const extraInstructions = buildExtraInstructions({ deploymentId, teamConfig, ticketId, repo: request.repo, cwd: process.cwd(), mode: request.mode ?? teamConfig.default_mode });
  const primer = generatePrimer({ runtime: "opencode", teamConfig, mode: request.mode, objective: request.objective, toolReference: adapter.describeTools(), templateVars: { ...computePlannerVars(teamConfig.name, request.mode, today), DEPLOY_ID: deploymentId, TEAM_NAME: teamConfig.name, TODAY: today, ...(ticketId ? { TICKET_ID: ticketId } : {}) }, extraInstructions });
  const primerPath = resolve(deployDir, "primer.md");
  writeFileSync(primerPath, primer, "utf-8");

  const provider = request.provider ?? "openai";
  const model = resolveOpencodeModel(provider, request.model ?? request.teamModel);
  const mode = request.dryRun ? "dry-run" : request.background ? "background" : "foreground";
  const paths = getDeployPaths(deploymentId);
  const env = { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: deployDir, PA_ACTIVITY_LOG: paths.activityLogPath, PA_TEAM: teamConfig.name };
  process.stdout.write(`Deployment: ${deploymentId}\n`);

  if (request.dryRun) {
    writeActivityEvents([createActivityEvent({ deployId: deploymentId, kind: "text", source: "opencode", body: `Dry-run primer generated for ${request.team} using ${model}` })], paths.activityLogPath);
    return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
  }

  emitStartedEvent({ deploymentId, team: teamConfig.name, primer: `deployments/${deploymentId}/primer.md`, agents: teamConfig.agents.map((agent) => agent.name), models: { team: model, ...(request.agentModel ? { agents: request.agentModel } : {}) }, ticketId: request.ticket, objective: request.objective, provider, repo: request.repo, runtime: "opencode", binary: "opa", resumedFromDeploymentId: request.resume });

  try {
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env });
    const priorSession = request.resume ? readPriorSession(request.resume, adapter.sessionFileName) : undefined;
    const result = priorSession
      ? await adapter.resume({ primerPath, deployId: deploymentId, mode, model, timeoutMs: request.timeout ? request.timeout * 1000 : undefined, logFile: resolve(deployDir, "opencode.log"), env, sessionId: priorSession })
      : await adapter.spawn({ primerPath, deployId: deploymentId, mode, model, timeoutMs: request.timeout ? request.timeout * 1000 : undefined, logFile: resolve(deployDir, "opencode.log"), env });
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
    return result.exitCode === 0
      ? { status: "success" as const, team: request.team, mode: request.mode ?? null, deploymentId }
      : { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: errorMessage ?? `opencode exited with code ${result.exitCode}` };
  } catch (error) {
    emitCrashedEvent({ deploymentId, team: teamConfig.name, error: error instanceof Error ? error.message : String(error), exitCode: 1 });
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

function readPriorSession(deploymentId: string, sessionFileName: string): string {
  const sessionPath = resolve(getDeployPaths(deploymentId).deployDir, sessionFileName);
  if (!existsSync(sessionPath)) {
    throw new Error(`no opencode session id recorded for ${deploymentId} — cannot resume (foreground TUI runs are not resumable)`);
  }
  const value = readFileSync(sessionPath, "utf-8").trim();
  if (!value) {
    throw new Error(`empty opencode session id recorded for ${deploymentId} — cannot resume`);
  }
  return value;
}

function computePlannerVars(team: string, mode: string | undefined, today: string): Record<string, string> {
  if (team !== "planner" || !mode || !new Set(["plan", "plan-review", "progress", "end", "end-review"]).has(mode)) return {};
  const home = homedir();
  const year = today.slice(0, 4);
  const month = today.slice(5, 7);
  const outputDir = resolve(home, "Documents/ai-usage/daily", year, month);
  const dailyInbox = resolve(home, "Documents/ai-usage/agent-teams/planner/inbox");
  return {
    TODAY: today,
    YEAR: year,
    MONTH: month,
    OUTPUT_DIR: outputDir,
    HOME: home,
    INPUT_NOTES: resolve(home, "Documents/ai-usage/sinh-inputs/daily-plan", today),
    RPM_BLOCKS: resolve(home, "Documents/ai-usage/agent-teams/rpm/rpm-blocks.yaml"),
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
  const sections = [buildMemoryDocsBlock(opts), opts.ticketId ? buildDeploymentContextBlock(opts) : undefined].filter(Boolean);
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
  const roots = [resolve(homedir(), ".claude/CLAUDE.md"), ...MEMORY_DOC_CANDIDATES.map((candidate) => resolveRepoRoot(opts.repo, opts.cwd, candidate))];
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

function resolveRepoRoot(repo: string | undefined, cwd: string, relativePath: string): string {
  if (!repo) return resolve(cwd, relativePath);
  try {
    return resolve(resolveRepo(repo).path, relativePath);
  } catch {
    return resolve(cwd, relativePath);
  }
}

function buildDeploymentContextBlock(opts: DeploymentContextOpts): string {
  const home = homedir();
  const now = nowUtc();
  const registryDb = process.env["PA_REGISTRY_DB"] ?? resolve(home, "Documents/ai-usage/deployments/registry.db");
  const workspaceBase = resolve(home, "Documents/ai-usage/deployments", opts.deploymentId);
  const teamWorkspace = resolve(home, "Documents/ai-usage/agent-teams", opts.teamConfig.name);
  return `<deployment-context>
deployment_id: ${opts.deploymentId}
team_name: ${opts.teamConfig.name}
team_display_name: ${opts.teamConfig.name}
deployed_at: ${now}
registry_db: ${registryDb}
workspace_base: ${workspaceBase}
team_workspace: ${teamWorkspace}
cwd: ${opts.cwd}
repo_root: ${opts.repo ? resolve(opts.cwd, opts.repo) : opts.cwd}
ticket_id: ${opts.ticketId ?? "none"}
agents:
${opts.teamConfig.agents.map((a) => `  - ${a.name}`).join("\n")}
mode: ${opts.mode ?? "default"}
</deployment-context>`;
}
