import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, ensureTerminalRegistryMarker, generatePrimer, getDeployPaths, loadTeamConfig, resolveDeployTimeoutSeconds, type CoreExecutionHooks, type DeployRequest, type PaEnvKey, type RuntimeAdapter, type SessionCommandBuilder, type TeamConfig } from "@pa-platform/pa-core";
import { PiAdapter, normalizePiEvent } from "./adapter.js";

export const piSessionCommand: SessionCommandBuilder = ({ model, prompt, sessionId, env, session }) => {
  const args = ["--print", "--json", "--session-id", sessionId ?? session.id];
  if (model) args.push("--model", model);
  if (env?.["PA_PROVIDER"]) args.push("--provider", env["PA_PROVIDER"]);
  args.push(prompt);
  return { binary: "pi", args };
};

export function createPiHooks(adapter: RuntimeAdapter = new PiAdapter()): CoreExecutionHooks { return { deploy: (request) => deployWithPi(request, adapter), sessionNormalizer: normalizePiEvent, sessionCommand: piSessionCommand }; }
export function createDefaultPiHooks(): CoreExecutionHooks { return createPiHooks(); }

export async function deployWithPi(request: DeployRequest, adapter: RuntimeAdapter = new PiAdapter()): Promise<{ status: "pending" | "success" | "failed"; team: string; mode: string | null; deploymentId?: string; reason?: string }> {
  const timeout = resolveDeployTimeoutSeconds({ timeout: request.timeout });
  if ("error" in timeout) return { status: "failed", team: request.team, mode: request.mode ?? null, reason: timeout.error };
  const deploymentId = `d-${randomBytes(3).toString("hex")}`;
  const deployDir = ensureDeployDir(deploymentId); const paths = getDeployPaths(deploymentId); const team = loadTeamConfig(request.team); const mode = selectMode(team, request.mode);
  const provider = request.provider ?? mode?.runtimes?.pi?.provider ?? team.runtimes?.pi?.provider;
  const model = request.model ?? mode?.runtimes?.pi?.model ?? team.runtimes?.pi?.model;
  const env = paEnv(deploymentId, deployDir, paths.activityLogPath, team, request, provider, model);
  const primer = generatePrimer({ runtime: "pi", teamConfig: team, mode: mode?.id, objective: request.objective, toolReference: adapter.describeTools(), templateVars: { DEPLOY_ID: deploymentId, TEAM_NAME: team.name, TODAY: new Date().toISOString().slice(0, 10) }, extraInstructions: `<deployment-context>\ndeployment_id: ${deploymentId}\nteam_name: ${team.name}\nmode: ${request.mode ?? team.default_mode ?? "default"}\nticket_id: ${request.ticket ?? "none"}\n</deployment-context>` });
  const primerPath = resolve(deployDir, "primer.md"); writeFileSync(primerPath, primer, "utf8"); process.stdout.write(`Deployment: ${deploymentId}\n`);
  if (request.dryRun) { appendActivityEvent(createActivityEvent({ deployId: deploymentId, kind: "text", source: "pi", body: `Dry-run primer generated for ${team.name}` }), paths.activityLogPath); return { status: "pending", team: request.team, mode: request.mode ?? null, deploymentId }; }
  let prior: string | undefined;
  if (request.resume) { try { prior = readSession(request.resume, adapter.sessionFileName); } catch (error) { return { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) }; } }
  emitStartedEvent({ deploymentId, team: team.name, mode: request.mode ?? team.default_mode, primer: `deployments/${deploymentId}/primer.md`, agents: team.agents.map((agent) => agent.name), models: model ? { team: model } : {}, ticketId: request.ticket, objective: request.objective, provider, repo: request.repo, runtime: "pi", binary: "ppa", resumedFromDeploymentId: request.resume, effectiveTimeoutSeconds: timeout.timeout });
  try {
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env });
    const result = prior ? await adapter.resume({ primerPath, deployId: deploymentId, mode: request.background ? "background" : "foreground", model, timeoutMs: timeout.timeout * 1000, logFile: resolve(deployDir, "pi.log"), env, sessionId: prior }) : await adapter.spawn({ primerPath, deployId: deploymentId, mode: request.background ? "background" : "foreground", model, timeoutMs: timeout.timeout * 1000, logFile: resolve(deployDir, "pi.log"), env });
    if (result.sessionId) writeFileSync(resolve(deployDir, adapter.sessionFileName), result.sessionId, "utf8");
    const pid = result.metadata?.["pid"]; if (typeof pid === "number") emitPidEvent({ deploymentId, team: team.name, pid });
    if (request.background) return { status: "pending", team: request.team, mode: request.mode ?? null, deploymentId };
    const ok = result.exitCode === 0; emitCompletedEvent({ deploymentId, team: team.name, status: ok ? "success" : "failed", summary: ok ? "ppa deploy completed" : `ppa deploy failed: ${result.errorMessage ?? `exit ${result.exitCode}`}`, logFile: result.logFile, exitCode: result.exitCode }); ensureTerminalRegistryMarker({ deploymentId, team: team.name });
    return { status: ok ? "success" : "failed", team: request.team, mode: request.mode ?? null, deploymentId, ...(ok ? {} : { reason: result.errorMessage ?? `pi exited with code ${result.exitCode}` }) };
  } catch (error) { emitCrashedEvent({ deploymentId, team: team.name, error: error instanceof Error ? error.message : String(error), exitCode: 1 }); ensureTerminalRegistryMarker({ deploymentId, team: team.name }); return { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason: error instanceof Error ? error.message : String(error) }; }
}

function selectMode(team: TeamConfig, id?: string) { return (id ?? team.default_mode) ? team.deploy_modes?.find((item) => item.id === (id ?? team.default_mode)) : undefined; }
function paEnv(id: string, dir: string, activity: string, team: TeamConfig, request: DeployRequest, provider?: string, model?: string): Record<PaEnvKey, string> { return { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: dir, PA_ACTIVITY_LOG: activity, PA_TEAM: team.name, PA_MODE: request.mode ?? team.default_mode ?? "", PA_TICKET_ID: request.ticket ?? "", PA_REPO: request.repo ?? "", PA_PROVIDER: provider ?? "", PA_MODEL: model ?? "", PA_TEAM_MODEL: request.teamModel ?? "", PA_AGENT_MODEL: request.agentModel ?? "" }; }
function readSession(id: string, expected: string): string { const dir = getDeployPaths(id).deployDir; const path = resolve(dir, expected); if (!existsSync(path)) { for (const [file, binary] of [["session-id-opencode.txt", "opa"], ["session-id-claude.txt", "cpa"], ["session-id-droid.txt", "dpa"], ["session-id-pi.txt", "ppa"]] as const) if (file !== expected && existsSync(resolve(dir, file))) throw new Error(`cannot resume: deploy ${id} was launched by another runtime; use '${binary} deploy --resume ${id}'`); throw new Error(`no Pi session id recorded for ${id} — cannot resume`); } const value = readFileSync(path, "utf8").trim(); if (!value) throw new Error(`empty Pi session id recorded for ${id} — cannot resume`); return value; }
