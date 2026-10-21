import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  PA_PI_EXECUTION_MODE_ENV, formatBoundedFiveFieldDiagnostic, getTicketsDir,
  queryReadonlyHelperRegistry, readProcessFingerprint, readReviewEvidenceFile,
  recoverRepositoryTerminalChild, refreshTicketLinkedBranchHead, repositoryTerminalOperatorIdentity, requireTicketLinkedBranch,
  resolveRepoExecutionPath, withPreparedTicketCapacity,
  type RepositoryChildSettlementResult, type Ticket,
} from "@pa-platform/pa-core";
import type { PiExtensionModule } from "./pi-extension/index.js";

export const CHILD_RECONCILIATION_USAGE = "ppa pi reconcile-child --parent-id ID --child-id ID --ticket TICKET [--apply] [--json]";
export interface ChildReconciliationRequest { parentId: string; childId: string; ticket: string; apply: boolean; json: boolean }
export interface ChildReconciliationResult extends RepositoryChildSettlementResult {
  readonly mode: "inspect" | "apply";
  readonly readFailure?: true;
}
const USAGE_DIAGNOSTIC = formatBoundedFiveFieldDiagnostic({ condition: "reconciliation usage rejected", source: "strict Pi-only grammar",
  reason: "missing, duplicate, unknown or malformed argument", correction: "use only the exact grammar", resumeAction: "retry inspection with canonical IDs" });
const KEYS = new Set(["--parent-id", "--child-id", "--ticket", "--apply", "--json"]);

/** Deliberately not a shell parser: no quoting, substitution, path/actor/token,
 * aliases, duplicate flags or positional arguments can create authority. */
export function parseChildReconciliationArgs(args: readonly string[]): ChildReconciliationRequest {
  if (args.length > 8) throw new Error("invalid reconciliation usage");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!KEYS.has(key) || values.has(key)) throw new Error("invalid reconciliation usage");
    if (key === "--apply" || key === "--json") values.set(key, "true");
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("invalid reconciliation usage");
      values.set(key, value);
    }
  }
  const parentId = values.get("--parent-id") ?? "", childId = values.get("--child-id") ?? "", ticket = values.get("--ticket") ?? "";
  if (!/^d-[0-9a-f]{6}$/.test(parentId) || !/^d-[0-9a-f]{6}$/.test(childId) || parentId === childId || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket) || ticket.length > 80) throw new Error("invalid reconciliation usage");
  return Object.freeze({ parentId, childId, ticket, apply: values.has("--apply"), json: values.has("--json") });
}
export function reconciliationBlocked(request: ChildReconciliationRequest, reason: string): ChildReconciliationResult {
  return { schemaVersion: "pa-child-reconciliation/v1", mode: request.apply ? "apply" : "inspect", outcome: "blocked",
    parentId: request.parentId, childId: request.childId, ticket: request.ticket,
    projection: { lease: false, registry: false, ticket: false }, cleanup: false,
    diagnostic: formatBoundedFiveFieldDiagnostic({ condition: "child reconciliation blocked", source: "Pi runtime reconciliation adapter", reason,
      correction: "preserve checkout, outcomes and retained runtime proof; do not edit protected state or launch another child",
      resumeAction: "type the exact command directly in the matching parent's authenticated foreground Pi session; confirm the fresh tuple; reconciliation grants no execution approval" }) };
}
function identity(request: ChildReconciliationRequest) {
  const parent = queryReadonlyHelperRegistry(request.parentId, undefined, true).status;
  if (!parent || parent.status !== "running" || parent.runtime !== "pi" || parent.binary !== "ppa" || parent.team !== "builder" || parent.mode !== "orchestrator"
    || parent.builder_authority !== "orchestrator" || parent.ticket_id !== request.ticket || !parent.repo_root || !parent.worktree_root || parent.repo !== parent.worktree_root
    || parent.treehouse_path !== parent.worktree_root || !parent.branch_base_sha) throw new Error("parent identity unavailable");
  const physical = resolveRepoExecutionPath(undefined, parent.worktree_root, { allowLinkedWorktreeCwd: true });
  if (physical.repoRoot !== parent.repo_root || physical.worktreeRoot !== parent.worktree_root || physical.worktreeKind !== "linked") throw new Error("physical identity conflicts");
  return { canonicalRepoKey: physical.repoKey, canonicalRepoRoot: physical.repoRoot, worktreeRoot: physical.worktreeRoot,
    repositoryGitDir: physical.gitDir, repositoryGitCommonDir: physical.gitCommonDir,
    parentDeploymentId: request.parentId, childDeploymentId: request.childId, ticket: request.ticket };
}
function readTicket(request: ChildReconciliationRequest, repoKey: string) {
  // No TicketStore constructor: even a missing ticket/state root stays missing.
  const ticket = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readReviewEvidenceFile(join(getTicketsDir(), `${request.ticket}.json`), 1_048_576, "reconciliation ticket"))) as Ticket;
  if (ticket.id !== request.ticket || ticket.project !== repoKey || !Array.isArray(ticket.linkedBranches)) throw new Error("ticket binding conflicts");
  const linked = requireTicketLinkedBranch(ticket, repoKey);
  if (linked.state !== "materialized" || !linked.baseSha || !linked.headSha) throw new Error("legacy ticket proof unavailable");
  return { branch: linked.branch, baseSha: linked.baseSha, headSha: linked.headSha };
}
/** Inspection opens existing-only readers, no mutex, constructors, allocation or
 * registry migration. A retained runtime record is mandatory, never a report. */
export function inspectPiChildReconciliation(request: ChildReconciliationRequest): ChildReconciliationResult {
  try {
    const binding = identity(request);
    const result = recoverRepositoryTerminalChild({ ...binding, host: {
      readTicket: () => readTicket(request, binding.canonicalRepoKey),
      publishTicket: () => { throw new Error("inspection cannot publish"); },
    } });
    return { ...result, parentId: request.parentId, childId: request.childId, ticket: request.ticket, mode: "inspect" };
  } catch (error) {
    // Known infrastructure/decoding failures get the contract's read-failure exit;
    // missing historical authority is still a normal blocked inspection. Never
    // expose the underlying driver, filesystem or JSON error message.
    const code = (error as NodeJS.ErrnoException)?.code ?? "";
    const readFailure = error instanceof SyntaxError || /^(SQLITE_(?:NOTADB|CORRUPT|IOERR|CANTOPEN)|EACCES|EPERM|EIO|EMFILE|ENFILE)/.test(code);
    return { ...reconciliationBlocked(request, "existing parent, physical checkout, registry or ticket proof unavailable"), mode: "inspect", ...(readFailure ? { readFailure: true } : {}) };
  }
}
/** Not exported: only the native interactive event closure below can enter apply.
 * The shared core service checks the confirmed observation under its mutex. */
function applyPiChildReconciliation(request: ChildReconciliationRequest, expectedObservationDigest: string): ChildReconciliationResult {
  try {
    const binding = identity(request);
    return withPreparedTicketCapacity({ canonicalRepoKey: binding.canonicalRepoKey, canonicalRepoRoot: binding.canonicalRepoRoot }, (owner) => ({
      ...recoverRepositoryTerminalChild({ ...binding, expectedObservationDigest, host: {
        readTicket: () => readTicket(request, binding.canonicalRepoKey),
        publishTicket: (next) => { refreshTicketLinkedBranchHead({ canonicalRepoKey: binding.canonicalRepoKey, canonicalRepoRoot: binding.canonicalRepoRoot,
          worktreeRoot: binding.worktreeRoot, ticketId: request.ticket, preparedCapacityOwner: owner,
          settlement: { branch: next.branch, baseSha: next.baseSha, expectedHeadSha: next.expectedHeadSha, headSha: next.headSha } }); },
      } }), parentId: request.parentId, childId: request.childId, ticket: request.ticket, mode: "apply" as const,
    }));
  } catch { return reconciliationBlocked(request, "matching confirmed authority or publication evidence conflicts"); }
}
export function childReconciliationExitCode(result: ChildReconciliationResult): number { return result.readFailure ? 2 : result.outcome === "blocked" ? 1 : 0; }
export function formatChildReconciliationResult(result: ChildReconciliationResult, json: boolean): string {
  if (json) return JSON.stringify(result);
  return [ `${result.mode}: ${result.outcome} (factual publication only; not acceptance or execution custody)`,
    `parent=${result.parentId ?? "unavailable"} child=${result.childId ?? "unavailable"} ticket=${result.ticket ?? "unavailable"} branch=${result.branch ?? "unavailable"}`,
    `HEAD=${result.head ?? "unavailable"} predecessor=${result.predecessorHead ?? "unavailable"}`,
    `snapshot=${result.snapshotDigest ?? "unavailable"} settlement=${result.settlementDigest ?? "unavailable"}`,
    `lease=${result.projection.lease} registry=${result.projection.registry} ticket=${result.projection.ticket} cleanup=${result.cleanup} exit=${childReconciliationExitCode(result)}`,
    ...(result.diagnostic ? [result.diagnostic] : []),
  ].join("\n");
}
export function runChildReconciliationCommand(args: readonly string[], io = { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) }): number {
  if (args.length === 1 && args[0] === "--help") { io.stdout(`${CHILD_RECONCILIATION_USAGE}\nInspection is read-only. Apply requires native interactive in-session dispatch, not a shell/model prompt.\n`); return 0; }
  let request: ChildReconciliationRequest;
  try { request = parseChildReconciliationArgs(args); }
  catch { io.stderr(`${CHILD_RECONCILIATION_USAGE}\n${USAGE_DIAGNOSTIC}\n`); return 2; }
  const result = request.apply ? reconciliationBlocked(request, "shell, agent and noninteractive apply have no authenticated native foreground decision") : inspectPiChildReconciliation(request);
  io.stdout(`${formatChildReconciliationResult(result, request.json)}\n`);
  return childReconciliationExitCode(result);
}

interface NativeContext {
  mode?: string; cwd?: string; isIdle?(): boolean;
  sessionManager?: { getSessionId(): string };
  ui?: { select(title: string, choices: string[], options?: { signal?: AbortSignal }): Promise<string | undefined>; notify(text: string, type: "info" | "error"): void };
}
/** Independent process/registry/session binding, in addition to native event
 * origin. An agent subprocess inheriting PA_* cannot pass the exact PID check. */
function authenticateNativeCaller(request: ChildReconciliationRequest, context: NativeContext, env: NodeJS.ProcessEnv): string {
  const status = queryReadonlyHelperRegistry(request.parentId, undefined, true).status;
  const current = readProcessFingerprint(process.pid);
  const session = context.sessionManager?.getSessionId();
  if (context.mode !== "tui" || context.isIdle?.() !== true || !context.ui?.select || !context.ui.notify || !session || session.length > 4096
    || env[PA_PI_EXECUTION_MODE_ENV] !== "foreground" || env.PA_DEPLOYMENT_ID !== request.parentId || env.PA_TICKET_ID !== request.ticket
    || env.PA_TEAM !== "builder" || env.PA_MODE !== "orchestrator" || !current || !status || status.pid !== process.pid
    || status.status !== "running" || status.runtime !== "pi" || status.binary !== "ppa" || status.team !== "builder" || status.mode !== "orchestrator"
    || status.builder_authority !== "orchestrator" || status.ticket_id !== request.ticket || !status.worktree_root
    || status.repo !== status.worktree_root || env.PA_REPO !== status.worktree_root || env.PA_WORKTREE_ROOT !== status.worktree_root
    || context.cwd !== status.worktree_root || process.cwd() !== status.worktree_root || realpathSync(status.worktree_root) !== status.worktree_root) throw new Error("native caller unavailable");
  const lineage = repositoryTerminalOperatorIdentity(identity(request));
  return JSON.stringify({ current, lineage, session, parent: request.parentId, started: status.started_at, cwd: context.cwd });
}
/** Exact PPA text is consumed BEFORE model processing. No slash alias, tool,
 * shell prompt, socket, environment approval or child process is introduced.
 * Runtime InputEvent.source is the origin boundary; RPC/extension inputs deny. */
export function createChildReconciliationModule(options: { env?: NodeJS.ProcessEnv } = {}): PiExtensionModule {
  return (pi, lifecycle) => {
    const env = { ...(options.env ?? process.env) }; let closing = false; let pending = false;
    const shutdown = new AbortController();
    lifecycle?.addShutdownStep(() => { closing = true; shutdown.abort(); });
    pi.on?.("input", async (raw, rawContext) => {
      const event = raw as { text?: string; source?: string; streamingBehavior?: string; images?: unknown[] };
      if (typeof event.text !== "string" || !/^ppa[ \t]+pi[ \t]+reconcile-child(?:\s|$)/.test(event.text)) return;
      const context = rawContext as NativeContext;
      const run = async () => {
        let request: ChildReconciliationRequest;
        try {
          if (event.text!.length > 1024 || /[^\x20-\x7e\t]/.test(event.text!)) throw new Error("usage");
          request = parseChildReconciliationArgs(event.text!.split(/[ \t]+/).slice(3));
        } catch { context.ui?.notify(`${CHILD_RECONCILIATION_USAGE}\n${USAGE_DIAGNOSTIC}`, "error"); return; }
        let result = reconciliationBlocked(request, "native interactive origin, idle session and exact parent process are required");
        if (closing || pending || event.source !== "interactive" || event.streamingBehavior || event.images?.length) {
          context.ui?.notify(formatChildReconciliationResult(result, request.json), "error"); return;
        }
        pending = true;
        try {
          const caller = authenticateNativeCaller(request, context, env);
          result = { ...inspectPiChildReconciliation(request), mode: request.apply ? "apply" : "inspect" };
          if (request.apply && result.outcome === "eligible" && result.observationDigest) {
            const accept = "Reconcile only these exact terminal facts";
            const choice = await context.ui!.select(`Native operator confirmation: ${JSON.stringify(result)}. Effects: matching parent lease/registry/ticket publication and transient cleanup only. No source/commit/child/approval/acceptance/return effects.`, [accept, "Cancel"], { signal: shutdown.signal });
            if (closing || choice !== accept) result = reconciliationBlocked(request, "native confirmation declined or session closed; no authority effects");
            else if (authenticateNativeCaller(request, context, env) !== caller) result = reconciliationBlocked(request, "native process/session binding drift; confirm again from a fresh inspection");
            else result = applyPiChildReconciliation(request, result.observationDigest);
          }
        } catch { result = reconciliationBlocked(request, "native caller, session or confirmation binding unavailable; no substituted approval"); }
        finally { pending = false; }
        context.ui?.notify(formatChildReconciliationResult(result, request.json), result.outcome === "blocked" ? "error" : "info");
      };
      if (lifecycle) await lifecycle.trackRegistryAccess(run); else await run();
      return { action: "handled" };
    });
  };
}
export const registerChildReconciliationModule = createChildReconciliationModule();
