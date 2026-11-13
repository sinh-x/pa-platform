import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  advisoryStartFromEvents, assertSupportedGitMetadataRead, captureRepositoryGitSnapshot, formatBoundedFiveFieldDiagnostic,
  getDeployPaths, getTicketsDir, inspectRetainedAdvisoryOperation, inspectRetainedProcess, LOCAL_GIT_CONTROL_FLAGS,
  observeReadonlyRepositoryAuthority, observeRetainedRepositoryTicketSlot, queryReadonlyDeploymentEvents, queryReadonlyHelperRegistry,
  readReviewEvidenceFile, requireTicketLinkedBranch, resolveRepoExecutionPath,
  type RetainedOperationInspection, type Ticket,
} from "@pa-platform/pa-core";
import { TreehouseClient } from "./treehouse.js";

export const TICKET_RECOVERY_USAGE = "ppa pi inspect-recovery --repo KEY --ticket TICKET --deployment-id ID [--json]";
export interface TicketRecoveryInspectionRequest { readonly repo: string; readonly ticket: string; readonly deploymentId: string; readonly json: boolean }
export interface TicketRecoveryInspection {
  readonly schemaVersion: "pa-ticket-recovery-inspection/v1";
  readonly outcome: "blocked" | "unavailable";
  readonly cause: "proof-incomplete" | "live-process" | "identity-conflict" | "unsupported-history" | "evidence-unavailable";
  readonly deploymentId: string;
  readonly ticket: string;
  readonly ownership: "matching" | "absent" | "conflicting" | "unavailable";
  readonly capacity: "matching" | "conflicting" | "unavailable";
  readonly checkout: "matching" | "conflicting" | "unavailable";
  readonly operation?: RetainedOperationInspection;
  readonly observationDigest?: string;
  readonly diagnostic: string;
}
export function parseTicketRecoveryInspectionArgs(args: readonly string[]): TicketRecoveryInspectionRequest {
  if (args.length < 6 || args.length > 7) throw new Error("invalid inspection usage");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!["--repo", "--ticket", "--deployment-id", "--json"].includes(key) || values.has(key)) throw new Error("invalid inspection usage");
    if (key === "--json") values.set(key, "true");
    else { const value = args[++i]; if (!value || value.startsWith("-")) throw new Error("invalid inspection usage"); values.set(key, value); }
  }
  const repo = values.get("--repo") ?? "", ticket = values.get("--ticket") ?? "", deploymentId = values.get("--deployment-id") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(repo) || !/^[A-Z][A-Z0-9]{0,31}-[0-9]{1,12}$/.test(ticket) || !/^d-[0-9a-f]{6}$/.test(deploymentId)) throw new Error("invalid inspection usage");
  return Object.freeze({ repo, ticket, deploymentId, json: values.has("--json") });
}
const reasons: Record<TicketRecoveryInspection["cause"], string> = {
  "proof-incomplete": "The retained native evidence does not establish complete execution quiescence. A terminal deployment or an empty process group cannot clear these claims.",
  "live-process": "A recorded process incarnation is still live. No PA ownership or ticket capacity was settled.",
  "identity-conflict": "The exact repository, checkout, ticket, lease, owner or capacity records disagree. No replacement checkout or evidence repair was attempted.",
  "unsupported-history": "This is not an exact terminal Pi advisory orchestrator history supported by this inspection. Original borrower, prepared and structured owners retain settlement responsibility.",
  "evidence-unavailable": "Required protected evidence could not be authenticated. Its absence, readability, integrity or current identity remains unproven.",
};
/** Pure presentation. No exception prose, paths, commands, process births or tokens. */
export function ticketRecoveryInspectionDiagnostic(cause: TicketRecoveryInspection["cause"]): string {
  return `Ticket recovery was not applied.\n${formatBoundedFiveFieldDiagnostic({
    condition: "Read-only recovery inspection cannot authorize settlement or a new writer", source: "Native retained execution, checkout ownership and ticket-capacity inspection", reason: reasons[cause].replace(/\.$/, ""),
    correction: "Ask the runtime operator to review this exact inspection and retained native operation. Impact: read-only. Actor: operator. New approval: not required for inspection. Prerequisite: preserve the original records; any repair requires its owning authority. No apply operation is provided by this inspection",
    resumeAction: "Continue the same recovery only after its native owner supplies complete cleanup and unchanged-identity proof through supported settlement. Launch admission must then be checked again; do not delete records, force takeover or return the lease",
  })}`;
}
/** Canonical-CWD observation only. Environment and arguments select locators,
 * never paths, tokens, caller authority, process-dead assertions or outcomes.
 * No TicketStore, capacity/ownership mutex, writable registry or evidence store
 * initialization is used. This phase intentionally supplies no apply route. */
export function inspectPiTicketRecovery(request: TicketRecoveryInspectionRequest, dependencies: { treehouse?: TreehouseClient; cwd?: string } = {}): TicketRecoveryInspection {
  let ownership: TicketRecoveryInspection["ownership"] = "unavailable", capacity: TicketRecoveryInspection["capacity"] = "unavailable", checkout: TicketRecoveryInspection["checkout"] = "unavailable";
  let operation: RetainedOperationInspection | undefined;
  const result = (cause: TicketRecoveryInspection["cause"], observationDigest?: string): TicketRecoveryInspection => Object.freeze({
    schemaVersion: "pa-ticket-recovery-inspection/v1", outcome: cause === "evidence-unavailable" ? "unavailable" : "blocked", cause,
    deploymentId: request.deploymentId, ticket: request.ticket, ownership, capacity, checkout, ...(operation ? { operation } : {}),
    ...(observationDigest ? { observationDigest } : {}), diagnostic: ticketRecoveryInspectionDiagnostic(cause),
  });
  try {
    // Revalidate even internal callers; request objects never carry proof.
    parseTicketRecoveryInspectionArgs(["--repo", request.repo, "--ticket", request.ticket, "--deployment-id", request.deploymentId]);
    const canonical = resolveRepoExecutionPath(request.repo, dependencies.cwd ?? process.cwd());
    if (canonical.repoKey !== request.repo || canonical.worktreeKind !== "primary"
      || realpathSync(dependencies.cwd ?? process.cwd()) !== canonical.repoRoot) return result("identity-conflict");
    const events = queryReadonlyDeploymentEvents(request.deploymentId, true);
    const start = advisoryStartFromEvents(events), status = queryReadonlyHelperRegistry(request.deploymentId, undefined, true).status;
    const terminals = events.filter(event => event.event === "completed" || event.event === "crashed");
    if (!start || start.runtime !== "pi" || start.binary !== "ppa" || start.team !== "builder" || start.mode !== "orchestrator" || start.builder_authority !== "orchestrator"
      || !status || !["success", "partial", "failed", "crashed"].includes(status.status) || terminals.length !== 1) return result("unsupported-history");
    if (start.repo_root !== canonical.repoRoot || start.ticket_id !== request.ticket || !start.worktree_root || start.treehouse_path !== start.worktree_root
      || !start.treehouse_lease_id || start.treehouse_lease_holder !== `pa:${canonical.repoKey}:${request.ticket}`
      || start.ticket_slot_id !== start.treehouse_lease_holder || ![1, 2, 3, 4].includes(start.repository_permit ?? 0)
      || status.repo_root !== start.repo_root || status.worktree_root !== start.worktree_root || status.ticket_id !== start.ticket_id
      || status.runtime !== start.runtime || status.team !== start.team || status.mode !== start.mode) return result("identity-conflict");
    const physical = resolveRepoExecutionPath(undefined, start.worktree_root, { allowLinkedWorktreeCwd: true });
    if (physical.repoRoot !== canonical.repoRoot || physical.repoKey !== canonical.repoKey || physical.worktreeKind !== "linked" || physical.gitCommonDir !== canonical.gitCommonDir) { checkout = "conflicting"; return result("identity-conflict"); }
    const ticketBytes = readReviewEvidenceFile(join(getTicketsDir(), `${request.ticket}.json`), 1_048_576, "recovery ticket");
    const ticket = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(ticketBytes)) as Ticket;
    const linked = requireTicketLinkedBranch(ticket, canonical.repoKey);
    const lease = (dependencies.treehouse ?? new TreehouseClient()).selectExisting(canonical.repoRoot, canonical.repoKey, request.ticket);
    if (ticket.id !== request.ticket || linked.state !== "materialized" || !/^[0-9a-f]{40}$/.test(linked.headSha ?? "")
      || !/^[0-9a-f]{40}$/.test(linked.baseSha ?? "") || linked.baseSha !== start.branch_base_sha
      || lease.path !== start.worktree_root || lease.leaseId !== start.treehouse_lease_id || lease.leaseHolder !== start.treehouse_lease_holder) { checkout = "conflicting"; return result("identity-conflict"); }
    const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_DIR: physical.gitDir, GIT_COMMON_DIR: physical.gitCommonDir, GIT_WORK_TREE: physical.worktreeRoot });
    const git = (args: readonly string[], cwd: string) => execFileSync("git", [...LOCAL_GIT_CONTROL_FLAGS, ...args], { cwd, env, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    assertSupportedGitMetadataRead(physical.worktreeRoot, git);
    const snapshot = captureRepositoryGitSnapshot(physical.worktreeRoot, git);
    if (snapshot.branch !== linked.branch || snapshot.head !== linked.headSha) { checkout = "conflicting"; return result("identity-conflict"); }
    checkout = "matching";
    const authority = observeReadonlyRepositoryAuthority(physical.gitDir), owner = authority.owner;
    if (!owner) { ownership = "absent"; return result("proof-incomplete"); }
    if (authority.implement || authority.borrower || authority.review || owner.deploymentId !== request.deploymentId || owner.ticket !== request.ticket
      || owner.runtime !== "pi" || owner.team !== "builder" || owner.mode !== "orchestrator" || owner.canonicalRepoKey !== canonical.repoKey || owner.canonicalRepoRoot !== canonical.repoRoot
      || owner.worktreeRoot !== physical.worktreeRoot || owner.repositoryGitDir !== physical.gitDir || owner.repositoryGitCommonDir !== physical.gitCommonDir
      || owner.deploymentDirectory !== getDeployPaths(request.deploymentId).deployDir || owner.processFingerprint.pid !== status.pid) { ownership = "conflicting"; return result("identity-conflict"); }
    ownership = "matching";
    const slot = observeRetainedRepositoryTicketSlot(canonical.repoRoot, request.ticket);
    if (slot.canonicalRepoKey !== canonical.repoKey || slot.canonicalRepoRoot !== canonical.repoRoot || slot.ticket !== request.ticket
      || slot.deploymentId !== request.deploymentId || slot.deploymentDirectory !== owner.deploymentDirectory || slot.slotId !== start.ticket_slot_id || slot.repositoryPermit !== start.repository_permit
      || JSON.stringify(slot.processFingerprint) !== JSON.stringify(owner.processFingerprint)) { capacity = "conflicting"; return result("identity-conflict"); }
    capacity = "matching";
    operation = inspectRetainedAdvisoryOperation(owner);
    // A digest is an observation coordinate only, not eligibility or an apply capability.
    const observationDigest = createHash("sha256").update(JSON.stringify([events, authority.identity, slot, lease, ticketBytes, snapshot.digestSha256, operation])).digest("hex");
    const currentAuthority = observeReadonlyRepositoryAuthority(physical.gitDir);
    if (currentAuthority.identity !== authority.identity || !Buffer.from(readReviewEvidenceFile(join(getTicketsDir(), `${request.ticket}.json`), 1_048_576, "recovery ticket")).equals(Buffer.from(ticketBytes))) return result("identity-conflict");
    const ownerState = inspectRetainedProcess(owner.processFingerprint);
    if (ownerState === "live" || operation.caller === "live" || operation.leader === "live" || operation.group === "present") return result("live-process", observationDigest);
    if (operation.state === "unavailable") return result("evidence-unavailable", observationDigest);
    // Terminal status, PID death and even historical groupSettled=true are not
    // a complete runtime/descendant cleanup inventory. Never manufacture one.
    return result("proof-incomplete", observationDigest);
  } catch { return result("evidence-unavailable"); }
}
export function runTicketRecoveryInspectionCommand(args: readonly string[], io = { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) }): number {
  if (args.length === 1 && args[0] === "--help") { io.stdout(`${TICKET_RECOVERY_USAGE}\nRead-only diagnosis only; no recovery apply, launch or lease-return rights.\n`); return 0; }
  let request: TicketRecoveryInspectionRequest;
  try { request = parseTicketRecoveryInspectionArgs(args); }
  catch { io.stderr(`${TICKET_RECOVERY_USAGE}\n${ticketRecoveryInspectionDiagnostic("evidence-unavailable")}\n`); return 2; }
  const result = inspectPiTicketRecovery(request);
  io.stdout(`${request.json ? JSON.stringify(result) : result.diagnostic}\n`);
  return result.outcome === "unavailable" ? 2 : 1;
}
