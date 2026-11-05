import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { DocumentPackageError, getDeploymentEvents, processIsWithinFingerprintLineage, queryDeploymentStatus, readProcessFingerprint, resolveRepoExecutionPath, workflowDigest } from "@pa-platform/pa-core";
import type { PiPreparationContext } from "./pi-extension/prepared-workflow.js";

export const DOCUMENT_SESSION_VERSION = "requirements-document-capabilities/v1";
export interface PiDocumentCaller { deploymentId: string; repoKey: string; repoRoot: string; ticket: string | null; identitySha256: string }
export function selectsDocumentSession(input: { team: string; mode?: string; pinned: boolean; resume: boolean; inherited: boolean; rogue: boolean; background: boolean; ticketWorktree: boolean }): boolean {
  return input.team === "requirements" && input.mode === "analyze" && !input.pinned && !input.resume && !input.inherited && !input.rogue && !input.background && !input.ticketWorktree;
}
export interface DocumentSessionDependencies {
  status: typeof queryDeploymentStatus; events: typeof getDeploymentEvents; physical: typeof realpathSync;
  repository: typeof resolveRepoExecutionPath; fingerprint: typeof readProcessFingerprint;
  inLineage: typeof processIsWithinFingerprintLineage; cwd: () => string; pid: number;
}
/** Native launch event, running registry, process incarnation and session, not an env selector. */
export function authenticatePiDocumentCaller(context: PiPreparationContext, env: NodeJS.ProcessEnv = process.env, overrides: Partial<DocumentSessionDependencies> = {}): PiDocumentCaller {
  const d: DocumentSessionDependencies = { status: queryDeploymentStatus, events: getDeploymentEvents, physical: realpathSync, repository: resolveRepoExecutionPath,
    fingerprint: readProcessFingerprint, inLineage: processIsWithinFingerprintLineage, cwd: () => process.cwd(), pid: process.pid, ...overrides };
  const deny = (): never => { throw new DocumentPackageError("DOCUMENT_AUTHORITY"); };
  if (context.mode !== "tui" || env.PA_PI_EXECUTION_MODE !== "foreground" || !/^d-[0-9a-f]{6}$/.test(env.PA_DEPLOYMENT_ID ?? "")) deny();
  const deploymentId = env.PA_DEPLOYMENT_ID!, status = d.status(deploymentId), starts = d.events(deploymentId).filter(event => event.event === "started"), start = starts[0];
  if (!status || starts.length !== 1 || !start || start.note !== DOCUMENT_SESSION_VERSION || start.runtime !== "pi" || start.binary !== "ppa"
    || status.status !== "running" || status.runtime !== "pi" || status.team !== "requirements" || status.mode !== "analyze" || status.rogue_one || status.builder_authority
    || status.treehouse_path || status.ticket_slot_id || status.repository_permit || !status.pid) return deny();
  const root = status.repo_root;
  if (!root || env.PA_TEAM !== "requirements" || env.PA_MODE !== "analyze" || env.PA_REPO !== root || env.PA_WORKTREE_ROOT !== root
    || status.repo !== root || status.worktree_root !== root || start.repo_root !== root || start.repo !== root || start.worktree_root !== root
    || start.team !== status.team || start.mode !== status.mode || start.ticket_id !== status.ticket_id || start.rogue_one || start.builder_authority
    || (env.PA_TICKET_ID || null) !== (status.ticket_id || null) || context.cwd !== root || d.cwd() !== root || d.physical(root) !== root) return deny();
  const repo = d.repository(undefined, root), owner = d.fingerprint(status.pid), current = d.fingerprint(d.pid), sessionId = context.sessionManager?.getSessionId();
  if (repo.repoRoot !== root || repo.worktreeRoot !== root || repo.repositoryCwd !== root || !owner || !current || !d.inLineage(d.pid, owner) || !sessionId) return deny();
  return { deploymentId, repoKey: repo.repoKey, repoRoot: root, ticket: status.ticket_id || null,
    identitySha256: workflowDigest(JSON.stringify({ deploymentId, owner, current, sessionId, root, ticket: status.ticket_id || null, startedAt: status.started_at })) };
}
export function assertSameDocumentCaller(before: PiDocumentCaller, after: PiDocumentCaller): void {
  if (!isDeepStrictEqual(before, after)) throw new DocumentPackageError("DOCUMENT_STALE");
}
