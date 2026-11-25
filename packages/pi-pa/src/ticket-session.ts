import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { getDeployPaths, queryReadonlyDeploymentStatus, queryReadonlyDeploymentEvents, readProcessFingerprint, processIsWithinFingerprintLineage,
  resolveRepoExecutionPath, isCanonicalTicketId, parseModeCapabilityBinding, modeCapabilitySessionMatches, modeCapabilityRouteMatches,
  hasModeResources, modeCapabilityActor, creationDigest, ticketAdminFail, type TicketAdminCaller } from "@pa-platform/pa-core";
import { readPiProcessIdentity } from "./process-identity.js";

export interface PiTicketContext { cwd: string; mode?: string; sessionManager?: { getSessionId(): string; getCwd?(): string } }
export interface PiTicketSessionDependencies {
  status: typeof queryReadonlyDeploymentStatus; events: typeof queryReadonlyDeploymentEvents;
  fingerprint: typeof readProcessFingerprint; inLineage: typeof processIsWithinFingerprintLineage; anchor: typeof readPiProcessIdentity;
  physical: typeof realpathSync; repository: typeof resolveRepoExecutionPath; cwd(): string; pid: number;
}
/** Generic native identity: no document-profile role gate or capability grant.
 * Registry PID, immutable launch, private incarnation anchor and real lineage
 * must agree. Environment strings alone (even copied from a live launch) fail.
 * This authenticates administration only, never source/workflow execution. */
export function authenticatePiTicketCaller(context: PiTicketContext, env: NodeJS.ProcessEnv = process.env, overrides: Partial<PiTicketSessionDependencies> = {}): TicketAdminCaller {
  const deny = (): never => ticketAdminFail("TICKET_ADMIN_SESSION");
  try {
    const d: PiTicketSessionDependencies = { status: queryReadonlyDeploymentStatus, events: queryReadonlyDeploymentEvents, fingerprint: readProcessFingerprint,
      inLineage: processIsWithinFingerprintLineage, anchor: readPiProcessIdentity, physical: realpathSync, repository: resolveRepoExecutionPath,
      cwd: () => process.cwd(), pid: process.pid, ...overrides };
    if (!context || !["tui", "rpc", "json", "print"].includes(context.mode ?? "")
      || !["foreground", "background"].includes(env.PA_PI_EXECUTION_MODE ?? "") || !/^d-[a-f0-9]{6}$/.test(env.PA_DEPLOYMENT_ID ?? "")) return deny();
    const deploymentId = env.PA_DEPLOYMENT_ID!, status = d.status(deploymentId, true), events = d.events(deploymentId, true);
    const starts = events.filter(e => e.event === "started"), start = starts[0];
    if (starts.length !== 1 || !start || !status || status.status !== "running" || status.runtime !== "pi" || start.runtime !== "pi" || start.binary !== "ppa"
      || !status.pid || !status.repo_root || !status.worktree_root || !status.repo || !status.mode
      || start.team !== status.team || start.mode !== status.mode || start.repo_root !== status.repo_root
      || start.worktree_root !== status.worktree_root || start.repo !== status.repo || start.mode_capability_binding !== status.mode_capability_binding
      || env.PA_TEAM !== status.team || env.PA_MODE !== status.mode || env.PA_REPO !== status.repo || env.PA_WORKTREE_ROOT !== status.worktree_root
      || env.PA_REPO_ROOT !== undefined && env.PA_REPO_ROOT !== status.repo_root || (env.PA_TICKET_ID || null) !== (start.ticket_id || null)) return deny();
    const directory = getDeployPaths(deploymentId).deployDir;
    if (env.PA_DEPLOYMENT_DIR !== directory || d.physical(directory) !== directory || context.cwd !== status.repo || d.cwd() !== status.repo
      || context.sessionManager?.getCwd && context.sessionManager.getCwd() !== context.cwd
      || d.physical(status.repo) !== status.repo || d.physical(status.repo_root) !== status.repo_root || d.physical(status.worktree_root) !== status.worktree_root) return deny();
    const repo = d.repository(undefined, context.cwd, { allowLinkedWorktreeCwd: true }), sessionId = context.sessionManager?.getSessionId();
    if (repo.repoRoot !== status.repo_root || repo.worktreeRoot !== status.worktree_root || repo.repositoryCwd !== status.repo
      || !sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId) || env.PI_SESSION_ID !== undefined && env.PI_SESSION_ID !== sessionId) return deny();
    let associationActor = `${status.team}/${status.mode}`;
    if (start.mode_capability_binding !== undefined) {
      if (Buffer.byteLength(start.mode_capability_binding) > 65536) return deny();
      const selected = parseModeCapabilityBinding(JSON.parse(start.mode_capability_binding));
      if (JSON.stringify(selected) !== start.mode_capability_binding || !modeCapabilitySessionMatches(selected, start.note)
        || !modeCapabilityRouteMatches(selected, status.team, status.mode) || hasModeResources(selected) && selected.repoKey !== repo.repoKey) return deny();
      associationActor = modeCapabilityActor(selected);
    }
    // Launch/env association is immutable. Only genuine registry association
    // edges explain a different CURRENT ticket; the requested target is unrelated.
    let ticket = start.ticket_id || null;
    if (ticket !== null && !isCanonicalTicketId(ticket)) return deny();
    const edges = events.filter(e => e.event === "ticket-associated");
    if (edges.length > 256) return deny();
    for (const edge of edges) {
      if ((edge.previous_ticket_id || null) !== ticket || edge.actor !== associationActor || edge.ticket_id && !isCanonicalTicketId(edge.ticket_id)) return deny();
      ticket = edge.ticket_id || null;
    }
    if (ticket !== (status.ticket_id || null)) return deny();
    const owner = d.fingerprint(status.pid), current = d.fingerprint(d.pid);
    if (!owner || !current || !isDeepStrictEqual(owner, d.anchor(deploymentId, directory)) || !d.inLineage(d.pid, owner)) return deny();
    return { deploymentId, repoKey: repo.repoKey, team: status.team, mode: status.mode,
      identitySha256: creationDigest({ start, owner, current, sessionId, ticket, repo, startedAt: status.started_at }) };
  } catch { return deny(); }
}
