import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createActivityEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, generatePrimer, getDeployPaths, loadTeamConfig, writeActivityEvents, type CoreExecutionHooks, type DeployRequest, type RuntimeAdapter } from "@pa-platform/pa-core";
import { OpencodeAdapter, resolveOpencodeModel } from "./adapter.js";

export function createOpencodeHooks(adapter: RuntimeAdapter = new OpencodeAdapter()): CoreExecutionHooks {
  return { deploy: (request) => deployWithOpencode(request, adapter) };
}

export async function deployWithOpencode(request: DeployRequest, adapter: RuntimeAdapter = new OpencodeAdapter()) {
  const deploymentId = `d-${randomBytes(3).toString("hex")}`;
  const deployDir = ensureDeployDir(deploymentId);
  const teamConfig = loadTeamConfig(request.team);
  const primer = generatePrimer({ runtime: "opencode", teamConfig, mode: request.mode, objective: request.objective, toolReference: adapter.describeTools(), templateVars: { DEPLOY_ID: deploymentId, TEAM_NAME: teamConfig.name, TODAY: new Date().toISOString().slice(0, 10) } });
  const primerPath = resolve(deployDir, "primer.md");
  writeFileSync(primerPath, primer, "utf-8");

  const provider = request.provider ?? "minimax";
  const model = resolveOpencodeModel(provider, request.model ?? request.teamModel);
  const mode = request.dryRun ? "dry-run" : request.background ? "background" : request.interactive ? "interactive" : request.direct ? "direct" : "foreground";
  const paths = getDeployPaths(deploymentId);
  const env = { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: deployDir, PA_ACTIVITY_LOG: paths.activityLogPath, PA_TEAM: teamConfig.name };

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
    writeFileSync(resolve(deployDir, adapter.sessionFileName), result.sessionId, "utf-8");
    const pid = typeof result.metadata?.["pid"] === "number" ? result.metadata["pid"] : undefined;
    if (pid !== undefined) emitPidEvent({ deploymentId, team: teamConfig.name, pid });
    if (mode === "background") {
      writeActivityEvents([createActivityEvent({ deployId: deploymentId, kind: "text", source: "opencode", body: `opencode background deploy started${pid ? ` with pid ${pid}` : ""}` })], paths.activityLogPath);
      return { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId };
    }
    const activity = await adapter.extractActivity(deployDir);
    writeActivityEvents(activity.length > 0 ? activity : [createActivityEvent({ deployId: deploymentId, kind: "text", source: "opencode", body: `opencode exited with code ${result.exitCode}` })], paths.activityLogPath);
    emitCompletedEvent({ deploymentId, team: teamConfig.name, status: result.exitCode === 0 ? "success" : "failed", summary: result.exitCode === 0 ? "opa deploy completed" : `opa deploy failed with exit code ${result.exitCode}`, logFile: result.logFile, exitCode: result.exitCode });
    return result.exitCode === 0 ? { status: "pending" as const, team: request.team, mode: request.mode ?? null, deploymentId } : { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: `opencode exited with code ${result.exitCode}` };
  } catch (error) {
    emitCrashedEvent({ deploymentId, team: teamConfig.name, error: error instanceof Error ? error.message : String(error), exitCode: 1 });
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) };
  }
}

function readPriorSession(deploymentId: string, sessionFileName: string): string {
  const sessionPath = resolve(getDeployPaths(deploymentId).deployDir, sessionFileName);
  return readFileSync(sessionPath, "utf-8").trim();
}
