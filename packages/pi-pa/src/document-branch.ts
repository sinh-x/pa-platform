import { execFileSync, spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import {
  captureRepositoryGitSnapshot, LOCAL_GIT_CONTROL_FLAGS, observeReadonlyRepositoryAuthority,
  inspectReadonlyRepositoryMutationLease, requireTicketLinkedBranch, resolveRepoExecutionPath,
  getTicketsDir, readArtifactFile, parseReviewEvidenceJson, workflowDigest, type TicketStore,
} from "@pa-platform/pa-core";
import { deriveTreehouseLeaseHolder, TreehouseClient } from "./treehouse.js";
import type { PiDocumentCaller } from "./document-session.js";

type BranchCode = "MISSING_LINK" | "FOREIGN_LINK" | "CONFLICTING_LINKS" | "INVALID_LINK" | "REPOSITORY_MISMATCH" | "PREPARATION_NEEDED" | "BASE_EVIDENCE_INVALID" | "BRANCH_EVIDENCE_UNAVAILABLE" | "BRANCH_MISMATCH" | "RECORDED_HEAD_ADVANCED" | "HEAD_MISMATCH" | "TREEHOUSE_UNAVAILABLE" | "LEASE_CONFLICT" | "WORKTREE_MISMATCH" | "OWNER_CONFLICT" | "OWNER_EVIDENCE_UNPROVEN" | "OBSERVATION_CHANGED" | "BRANCH_VERIFIED";
const reasons: Record<BranchCode, string> = {
  MISSING_LINK: "No applicable ticket branch intent is recorded.", FOREIGN_LINK: "Only foreign-repository branch links are recorded.", CONFLICTING_LINKS: "Multiple applicable ticket links are ambiguous.", INVALID_LINK: "The existing ticket-link owner rejected the branch tuple.",
  REPOSITORY_MISMATCH: "The registered physical repository differs from the authenticated caller.", PREPARATION_NEEDED: "The recorded planned intent or absent leased checkout needs the existing preparation owner; inspection allocates nothing.",
  BASE_EVIDENCE_INVALID: "The recorded base is unavailable or is not an ancestor of current branch HEAD.", BRANCH_EVIDENCE_UNAVAILABLE: "Current branch/HEAD metadata could not be established.", BRANCH_MISMATCH: "The existing leased worktree is on a different branch.",
  RECORDED_HEAD_ADVANCED: "Current HEAD descends from the recorded HEAD; the existing ticket/launcher owner must reconcile readback, not demand a replacement branch approval by inference.", HEAD_MISMATCH: "Current HEAD does not match the recorded materialized link.",
  TREEHOUSE_UNAVAILABLE: "The existing Treehouse status owner could not provide supported bounded lease evidence.", LEASE_CONFLICT: "Multiple leases claim this ticket's deterministic holder.", WORKTREE_MISMATCH: "The leased path is not the registered physical linked worktree of this repository.",
  OWNER_CONFLICT: "An existing builder/borrower/review owner occupies the checkout; inspection cannot release or override it.", OWNER_EVIDENCE_UNPROVEN: "Protected checkout ownership/settlement evidence could not be proven.", OBSERVATION_CHANGED: "Ticket, Git, lease or ownership facts changed during inspection; preserve intent and reobserve.", BRANCH_VERIFIED: "Current branch/base/HEAD and leased worktree agree; this is observation, not launch or custody admission.",
};
function branchGuidance(code: BranchCode): string {
  return `Branch inspection did not establish selection readiness.\nCondition: The document handoff has finding ${code}.\nSource: Existing ticket/repository/worktree owners.\nReason: ${reasons[code]}\nCorrection: Ask the ticket/launcher or resource owner to inspect and reconcile this exact existing intent. Impact: read-only for inspection. Actor: agent or operator. New approval: not required for unchanged-intent inspection; changed intent or preparation effects need their owning authorization. Prerequisite: preserve current links, repository and lease evidence.\nResume Action: Reobserve after the proven cause changes. Actual preparation/selection/launch remains separate and rechecks current ownership, capacity and execution boundaries.`;
}
/** Thin read-only composition of the same owners used at selection/launch.
 * No mutation mutex, branch operation, ticket refresh, lease acquisition or builder spawn. */
export function inspectPiDocumentBranch(caller: PiDocumentCaller, ticketId: string, tickets: TicketStore, treehouse = new TreehouseClient()): Record<string, unknown> {
  const result = (code: BranchCode, facts: Record<string, unknown> = {}) => ({ schemaVersion: "pa-document-branch-observation/v1", ticket: ticketId, code,
    state: code === "BRANCH_VERIFIED" ? "branch-verified" : code === "PREPARATION_NEEDED" ? "preparation-needed" : "not-verified",
    ...facts, observedAt: new Date().toISOString(), observationOnly: true, launchReady: false, executionPrerequisites: "deferred-to-execution-owner", capacity: "not-acquired-launch-owner-rechecks", authorityGranted: false,
    ...(code === "BRANCH_VERIFIED" ? { explanation: reasons[code] } : { guidance: branchGuidance(code) }) });
  const ticket = tickets.get(ticketId);
  if (!ticket || ticket.project !== caller.repoKey || caller.ticket !== null && caller.ticket !== ticketId) return result("REPOSITORY_MISMATCH");
  const applicable = ticket.linkedBranches.filter(link => link.repo === caller.repoKey);
  if (!applicable.length) return result(ticket.linkedBranches.length ? "FOREIGN_LINK" : "MISSING_LINK");
  if (applicable.length !== 1) return result("CONFLICTING_LINKS");
  let canonical: ReturnType<typeof resolveRepoExecutionPath>, linked: ReturnType<typeof requireTicketLinkedBranch>;
  try {
    canonical = resolveRepoExecutionPath(undefined, caller.repoRoot);
    if (canonical.repoKey !== caller.repoKey || canonical.repoRoot !== caller.repoRoot || canonical.worktreeRoot !== caller.repoRoot) return result("REPOSITORY_MISMATCH");
  } catch { return result("REPOSITORY_MISMATCH"); }
  try { linked = requireTicketLinkedBranch(ticket, caller.repoKey); } catch { return result("INVALID_LINK"); }
  // Do not let TicketStore's legacy compatibility normalization conceal absent
  // explicit state/head or a conflicting legacy sha. Match the selection owner.
  const ticketPath = join(getTicketsDir(), `${ticketId}.json`);
  let ticketBytesSha256: string;
  try {
    const bytes = readArtifactFile(ticketPath, 1024 * 1024, "ARTIFACT_STALE"), raw = parseReviewEvidenceJson(bytes, "document branch intent") as Record<string, unknown>;
    const rawLinks = Array.isArray(raw.linkedBranches) ? raw.linkedBranches.filter((r: unknown): r is Record<string, unknown> => Boolean(r && typeof r === "object" && !Array.isArray(r) && (r as Record<string, unknown>).repo === caller.repoKey)) : [];
    const exact = rawLinks[0];
    if (raw.id !== ticketId || raw.project !== caller.repoKey || rawLinks.length !== 1 || !exact || exact.branch !== linked.branch || exact.state !== linked.state
      || (linked.state === "planned" ? exact.baseSha !== undefined || exact.headSha !== undefined || exact.sha !== undefined
        : exact.baseSha !== linked.baseSha || exact.headSha !== linked.headSha || exact.sha !== undefined && exact.sha !== exact.headSha)) return result("INVALID_LINK");
    ticketBytesSha256 = workflowDigest(bytes);
  } catch { return result("INVALID_LINK"); }
  const queue = ticket.status === "pending-implementation" && ticket.assignee === "builder/team-manager" ? "queued" : "not-queued";
  const facts = { branch: linked.branch, linkedState: linked.state, queue };
  if (linked.state === "planned") return result("PREPARATION_NEEDED", facts);
  if (!/^[0-9a-f]{40}$/.test(linked.baseSha ?? "") || !/^[0-9a-f]{40}$/.test(linked.headSha ?? "") || linked.sha && linked.sha !== linked.headSha) return result("INVALID_LINK", facts);
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_DIR: canonical.gitDir, GIT_COMMON_DIR: canonical.gitCommonDir, GIT_WORK_TREE: canonical.repoRoot };
  const git = (args: string[]) => execFileSync("git", [...LOCAL_GIT_CONTROL_FLAGS, ...args], { cwd: canonical.repoRoot, env, stdio: ["ignore", "pipe", "pipe"], timeout: 15000, maxBuffer: 1024 * 1024 }).toString("utf8").trim();
  const ancestor = (a: string, b: string) => spawnSync("git", [...LOCAL_GIT_CONTROL_FLAGS, "merge-base", "--is-ancestor", a, b], { cwd: canonical.repoRoot, env, stdio: ["ignore", "pipe", "pipe"], timeout: 15000, maxBuffer: 4096 }).status === 0;
  let head: string;
  try { head = git(["rev-parse", "--verify", `refs/heads/${linked.branch}^{commit}`]); if (!/^[0-9a-f]{40}$/.test(head)) throw Error(); }
  catch { return result("BRANCH_EVIDENCE_UNAVAILABLE", facts); }
  if (!ancestor(linked.baseSha!, head)) return result("BASE_EVIDENCE_INVALID", facts);
  if (head !== linked.headSha) return result(ancestor(linked.headSha!, head) ? "RECORDED_HEAD_ADVANCED" : "HEAD_MISMATCH", { ...facts, recordedHead: linked.headSha, currentHead: head });
  const holder = deriveTreehouseLeaseHolder(caller.repoKey, ticketId);
  let leases: ReturnType<TreehouseClient["status"]>;
  try { leases = treehouse.status(caller.repoRoot).filter(row => row.leased && row.leaseHolder === holder); } catch { return result("TREEHOUSE_UNAVAILABLE", facts); }
  if (!leases.length) return result("PREPARATION_NEEDED", facts);
  if (leases.length !== 1) return result("LEASE_CONFLICT", facts);
  const lease = leases[0]!;
  let selected: ReturnType<typeof resolveRepoExecutionPath>;
  try {
    selected = resolveRepoExecutionPath(undefined, lease.path, { allowLinkedWorktreeCwd: true });
    if (selected.repoKey !== caller.repoKey || selected.repoRoot !== caller.repoRoot || selected.worktreeKind !== "linked" || selected.worktreeRoot !== lease.path || selected.gitCommonDir !== canonical.gitCommonDir) return result("WORKTREE_MISMATCH", facts);
  } catch { return result("WORKTREE_MISMATCH", facts); }
  const snapshot = () => captureRepositoryGitSnapshot(lease.path, undefined, { repositoryGitDir: selected.gitDir, repositoryGitCommonDir: selected.gitCommonDir });
  let first: ReturnType<typeof snapshot>, authority: ReturnType<typeof observeReadonlyRepositoryAuthority>;
  try { first = snapshot(); } catch { return result("BRANCH_EVIDENCE_UNAVAILABLE", facts); }
  if (first.branch !== linked.branch) return result("BRANCH_MISMATCH", facts);
  if (first.head !== head) return result("HEAD_MISMATCH", facts);
  try {
    authority = observeReadonlyRepositoryAuthority(selected.gitDir);
    for (const slot of ["orchestrator", "implement"] as const) {
      const owner = inspectReadonlyRepositoryMutationLease(caller.repoRoot, lease.path, selected.gitDir, slot);
      if (owner.state === "live") return result("OWNER_CONFLICT", facts);
      if (owner.state !== "absent") return result("OWNER_EVIDENCE_UNPROVEN", facts);
    }
    if (authority.borrower) return result("OWNER_EVIDENCE_UNPROVEN", facts);
    if (authority.review) return result("OWNER_CONFLICT", facts);
  } catch { return result("OWNER_EVIDENCE_UNPROVEN", facts); }
  try {
    const currentLease = treehouse.selectExisting(caller.repoRoot, caller.repoKey, ticketId);
    const currentSelected = resolveRepoExecutionPath(undefined, currentLease.path, { allowLinkedWorktreeCwd: true });
    if (currentSelected.repoKey !== caller.repoKey || currentSelected.repoRoot !== caller.repoRoot || currentSelected.worktreeRoot !== lease.path || currentSelected.gitDir !== selected.gitDir || currentSelected.gitCommonDir !== selected.gitCommonDir || currentLease.path !== lease.path || currentLease.leaseId !== lease.leaseId || currentLease.leaseHolder !== holder
      || snapshot().digestSha256 !== first.digestSha256 || observeReadonlyRepositoryAuthority(selected.gitDir).identity !== authority.identity
      || git(["rev-parse", "--verify", `refs/heads/${linked.branch}^{commit}`]) !== head
      || workflowDigest(readArtifactFile(ticketPath, 1024 * 1024, "ARTIFACT_STALE")) !== ticketBytesSha256
      || !isDeepStrictEqual(tickets.get(ticketId)?.linkedBranches, ticket.linkedBranches) || tickets.get(ticketId)?.status !== ticket.status || tickets.get(ticketId)?.assignee !== ticket.assignee) return result("OBSERVATION_CHANGED", facts);
  } catch { return result("OBSERVATION_CHANGED", facts); }
  return result("BRANCH_VERIFIED", { ...facts, baseSha: linked.baseSha, currentHead: head, worktreeRoot: lease.path, dirty: first.dirty, ownership: "observed-unoccupied", requiresRecheckAtSelectionAndLaunch: true });
}
