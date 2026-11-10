import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { TICKET_INTERACTIONS_PROFILE, DocumentPackageError, getDeployPaths, getDeploymentEvents, processIsWithinFingerprintLineage, queryDeploymentStatus, readProcessFingerprint, resolveRepoExecutionPath, workflowDigest } from "@pa-platform/pa-core";
import { MODE_CAPABILITY_SESSION, parseModeCapabilityBinding, type ModeCapabilityBinding } from "@pa-platform/pa-core";
import { readPiProcessIdentity } from "./process-identity.js";
import type { PiPreparationContext } from "./pi-extension/prepared-workflow.js";

export const DOCUMENT_SESSION_VERSION = "requirements-document-capabilities/v1";
export const DOCUMENT_WORKSPACE_SESSION_VERSION = "requirements-document-workspace/v2";
export const DOCUMENT_CONFIRMATION_SESSION_VERSION = "requirements-document-confirmation/v3";
export const DOCUMENT_INTERACTIONS_SESSION_VERSION = TICKET_INTERACTIONS_PROFILE;
export const DOCUMENT_SESSION_VERSIONS = [DOCUMENT_SESSION_VERSION, DOCUMENT_WORKSPACE_SESSION_VERSION, DOCUMENT_CONFIRMATION_SESSION_VERSION, DOCUMENT_INTERACTIONS_SESSION_VERSION, MODE_CAPABILITY_SESSION] as const;
export function documentSessionVersion(profile: string | undefined): typeof DOCUMENT_SESSION_VERSIONS[number] | undefined {
  switch (profile) {
    case "pa-document-package/v1": return DOCUMENT_SESSION_VERSION;
    case "pa-document-workspace/v2": return DOCUMENT_WORKSPACE_SESSION_VERSION;
    case "pa-document-confirmation/v3": return DOCUMENT_CONFIRMATION_SESSION_VERSION;
    case "pa-document-interactions/v4": return DOCUMENT_INTERACTIONS_SESSION_VERSION;
    case "pa-document-policy/v1": return MODE_CAPABILITY_SESSION;
    default: return undefined;
  }
}
export function confirmationDocumentCaller(caller: PiDocumentCaller): boolean { return caller.profile === DOCUMENT_CONFIRMATION_SESSION_VERSION || caller.profile === DOCUMENT_INTERACTIONS_SESSION_VERSION || caller.profile === MODE_CAPABILITY_SESSION; }
export function workspaceDocumentCaller(caller: PiDocumentCaller): boolean { return caller.profile === DOCUMENT_WORKSPACE_SESSION_VERSION || confirmationDocumentCaller(caller); }
export interface PiDocumentCaller { deploymentId: string; repoKey: string; repoRoot: string; ticket: string | null; identitySha256: string; profile?: string; sessionId?: string; capabilities?: ModeCapabilityBinding }
export function selectsDocumentSession(input: { team: string; mode?: string; pinned: boolean; resume: boolean; inherited: boolean; rogue: boolean; background: boolean; ticketWorktree: boolean; supportedConfig: boolean }): boolean {
  return input.supportedConfig && input.team === "requirements" && input.mode === "analyze" && !input.pinned && !input.resume && !input.inherited && !input.rogue && !input.background && !input.ticketWorktree;
}
export interface DocumentSessionDependencies {
  status: typeof queryDeploymentStatus; events: typeof getDeploymentEvents; physical: typeof realpathSync;
  repository: typeof resolveRepoExecutionPath; fingerprint: typeof readProcessFingerprint;
  inLineage: typeof processIsWithinFingerprintLineage; anchor: typeof readPiProcessIdentity; cwd: () => string; pid: number;
}
/** Native launch event, running registry, process incarnation and session, not an env selector. */
export function authenticatePiDocumentCaller(context: PiPreparationContext, env: NodeJS.ProcessEnv = process.env, overrides: Partial<DocumentSessionDependencies> = {}): PiDocumentCaller {
  const d: DocumentSessionDependencies = { status: queryDeploymentStatus, events: getDeploymentEvents, physical: realpathSync, repository: resolveRepoExecutionPath,
    fingerprint: readProcessFingerprint, inLineage: processIsWithinFingerprintLineage, cwd: () => process.cwd(), pid: process.pid, anchor: readPiProcessIdentity, ...overrides };
  const deny = (): never => { throw new DocumentPackageError("DOCUMENT_AUTHORITY"); };
  if (context.mode !== "tui" || env.PA_PI_EXECUTION_MODE !== "foreground" || !/^d-[0-9a-f]{6}$/.test(env.PA_DEPLOYMENT_ID ?? "")) deny();
  const deploymentId = env.PA_DEPLOYMENT_ID!, status = d.status(deploymentId), events = d.events(deploymentId), starts = events.filter(event => event.event === "started"), start = starts[0];
  if (!status || ((start?.note === DOCUMENT_INTERACTIONS_SESSION_VERSION || start?.note === MODE_CAPABILITY_SESSION) && (start.resumed_from_deployment_id || start.parent_deployment_id || start.fallback)) || starts.length !== 1 || !start || !DOCUMENT_SESSION_VERSIONS.some(version => version === start.note) || start.runtime !== "pi" || start.binary !== "ppa"
    || status.status !== "running" || status.runtime !== "pi" || status.team !== "requirements" || status.mode !== "analyze" || status.rogue_one || status.builder_authority
    || status.treehouse_path || status.ticket_slot_id || status.repository_permit || !status.pid) return deny();
  const root = status.repo_root;
  if (!root || env.PA_TEAM !== "requirements" || env.PA_MODE !== "analyze" || env.PA_REPO !== root || env.PA_WORKTREE_ROOT !== root
    || status.repo !== root || status.worktree_root !== root || start.repo_root !== root || start.repo !== root || start.worktree_root !== root
    || start.team !== status.team || start.mode !== status.mode || start.rogue_one || start.builder_authority
    || (env.PA_TICKET_ID || null) !== (start.ticket_id || null) || context.cwd !== root || d.cwd() !== root || d.physical(root) !== root) return deny();
  // The existing operator context owner can associate a ticket without mutating
  // the immutable launch/env. Follow its exact recorded edges, never model JSON.
  let ticket = start.ticket_id || null;
  const associations = events.filter(event => event.event === "ticket-associated");
  if (associations.length > 256) return deny();
  for (const event of associations) {
    if ((event.previous_ticket_id || null) !== ticket || event.actor !== "requirements/analyze" || (event.ticket_id && !/^[A-Z][A-Z0-9]*-\d+$/.test(event.ticket_id))) return deny();
    ticket = event.ticket_id || null;
  }
  if (ticket !== (status.ticket_id || null)) return deny();
  const repo = d.repository(undefined, root), owner = d.fingerprint(status.pid), current = d.fingerprint(d.pid), sessionId = context.sessionManager?.getSessionId();
  if (repo.repoRoot !== root || repo.worktreeRoot !== root || repo.repositoryCwd !== root || !owner || !current || !d.inLineage(d.pid, owner) || !sessionId || !isDeepStrictEqual(owner, d.anchor(deploymentId, getDeployPaths(deploymentId).deployDir))) return deny();
  let capabilities: ModeCapabilityBinding | undefined;
  if (start.note === MODE_CAPABILITY_SESSION) {
    try {
      if (!start.mode_capability_binding || start.mode_capability_binding.length > 65536 || start.mode_capability_binding !== status.mode_capability_binding) return deny();
      capabilities = parseModeCapabilityBinding(JSON.parse(start.mode_capability_binding));
      // Native emitter serializes this canonical shape. Reject duplicate keys,
      // noncanonical/tampered bytes, aliases and non-native reconstruction.
      if (JSON.stringify(capabilities) !== start.mode_capability_binding) return deny();
    } catch { return deny(); }
  } else if (start.mode_capability_binding !== undefined || status.mode_capability_binding !== undefined) return deny();
  return { deploymentId, repoKey: repo.repoKey, repoRoot: root, ticket: status.ticket_id || null,
    ...(capabilities ? { capabilities, profile: MODE_CAPABILITY_SESSION, sessionId } : {}),
    ...(start.note === DOCUMENT_WORKSPACE_SESSION_VERSION ? { profile: DOCUMENT_WORKSPACE_SESSION_VERSION } : start.note === DOCUMENT_CONFIRMATION_SESSION_VERSION || start.note === DOCUMENT_INTERACTIONS_SESSION_VERSION ? { profile: start.note, sessionId } : {}),
    identitySha256: workflowDigest(JSON.stringify({ deploymentId, owner, current, sessionId, root, ticket: status.ticket_id || null, startedAt: status.started_at })) };
}
export function assertSameDocumentCaller(before: PiDocumentCaller, after: PiDocumentCaller): void {
  if (!isDeepStrictEqual(before, after)) throw new DocumentPackageError("DOCUMENT_STALE");
}
