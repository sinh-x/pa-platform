import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getAiUsageDir } from "../paths.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { withPreparedRepositoryTicketOwner, withRepositoryTicketTransaction, type PreparedTicketCapacityTransaction, type RepositoryTicketSlotHandoff, type RepositoryTicketTransaction } from "../deploy/ticket-concurrency.js";
import { observeReadonlyRepositoryAuthority } from "../deploy/repository-admission.js";
import { loadRepoEntry, MAX_REPOSITORY_DIAGNOSTIC_CHARS, resolveRepoExecutionPath } from "../repos.js";
import { requireTicketLinkedBranch } from "./git-validation.js";
import { TicketStore } from "./store.js";
import type { LinkedBranch } from "./types.js";

export interface MaterializeTicketBranchOptions {
  canonicalRepoKey: string;
  canonicalRepoRoot: string;
  worktreeRoot: string;
  ticketId: string;
  actor?: string;
  ticketStore?: TicketStore;
  runGit?: (args: readonly string[], cwd: string) => string | Buffer;
  /** Trusted preparation service only: an authenticated exact base, never a CLI/agent override. */
  approvedPreparationBaseSha?: string;
  /** Native ordinary launcher only. Reauthenticated against durable task/sign-off
   * evidence inside the transaction; never an agent/environment SHA override. */
  intendedTaskBaseline?: OrdinaryTaskBaseline;
  /** Existing live launcher capacity owner, never supplied by tool/CLI JSON. */
  ordinaryOwner?: RepositoryTicketSlotHandoff & { deploymentId: string };
  /** Live existing repository owner; avoids recursive mutex acquisition during preparation. */
  preparedCapacityOwner?: PreparedTicketCapacityTransaction;
  /** Durable operation identity, required for exact post-crash branch/ticket reconciliation. */
  preparationOperationId?: string;
  /** Trusted terminal owner: exact materialized predecessor, never CLI inputs. */
  settlement?: { branch: string; baseSha: string; expectedHeadSha: string; headSha: string };
}

/** Observation of the existing task owner, not a second approval or ownership
 * ledger. The full source/comment digests detect changes between selection and
 * materialization. A source plan or this object alone cannot authorize a base. */
export interface OrdinaryTaskBaseline {
  readonly schemaVersion: "ordinary-task-baseline/v1";
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly ticket: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly requirements: { readonly ref: string; readonly sha256: string };
  readonly approval: { readonly commentId: string; readonly sha256: string };
}
export type OrdinaryTaskBaselineOptions = Pick<MaterializeTicketBranchOptions, "canonicalRepoKey" | "canonicalRepoRoot" | "ticketId" | "ticketStore" | "runGit">;

/** Resolve only the single primary approved task source and its own-ticket
 * operator sign-off. No review matrix, optional policy activation, new prompt,
 * CLI SHA argument or environment baseline is consulted. */
export function resolveOrdinaryTaskBaseline(options: OrdinaryTaskBaselineOptions): OrdinaryTaskBaseline {
  const fail = (code: string): never => { throw ordinaryBaselineError(code); };
  const root = exactPhysicalPath(options.canonicalRepoRoot, "canonical repository root");
  const repo = loadRepoEntry(options.canonicalRepoKey);
  if (!repo || repo.path !== root) fail("IDENTITY");
  const ticket = (options.ticketStore ?? new TicketStore()).get(options.ticketId);
  if (!ticket || ticket.id !== options.ticketId) return fail("MISSING");
  const linked = requireTicketLinkedBranch(ticket, options.canonicalRepoKey);
  const sources = ticket.doc_refs.filter((ref) => ref.type === "requirements" && ref.primary === true);
  if (sources.length !== 1) fail("MISSING_OR_AMBIGUOUS");
  const path = sources[0]!.path;
  if (!/^agent-teams\/requirements\/artifacts\/[A-Za-z0-9_./-]+\.md$/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")) fail("SOURCE_REJECTED");
  let bytes: Uint8Array;
  try { bytes = readReviewEvidenceFile(join(getAiUsageDir(), path), 1_048_576, "ordinary task baseline"); }
  catch { return fail("SOURCE_REJECTED"); }
  let markdown: string;
  try { markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("SOURCE_REJECTED"); }
  // Canonical metadata is confined to the document preamble; body examples and
  // fenced duplicate fields cannot supply or shadow the actual task identity.
  const preamble = markdown.split(/^##[ \t]/m)[0]!;
  const header = (label: string, from = preamble): string => {
    const matches = from.split(/\r?\n/).filter((line) => new RegExp(`^>[ \\t]+(?:\\*\\*)?${label}:`).test(line));
    const prefix = `> ${label}: `;
    if (matches.length !== 1 || !matches[0]!.startsWith(prefix) || !matches[0]!.slice(prefix.length)) return fail("CONTRACT_INVALID");
    return matches[0]!.slice(prefix.length);
  };
  if (!/^Approved(?:$|[ —])/.test(header("Status")) || header("Ticket") !== options.ticketId
    || header("Repository Key") !== options.canonicalRepoKey || header("Repository Root") !== root
    || header("Feature Branch") !== linked.branch) fail("CONTRACT_INVALID");
  const handoff = header("Handoff Type");
  if (handoff !== "fresh" && handoff !== "amendment") fail("CONTRACT_INVALID");
  const baseLabel = handoff === "fresh" ? "Approved Base SHA" : "Retained Base SHA";
  if (new RegExp(`^>[ \\t]+(?:\\*\\*)?${handoff === "fresh" ? "Retained" : "Approved"} Base SHA:`, "m").test(preamble)) fail("CONTRACT_INVALID");
  const baseSha = header(baseLabel);
  if (!/^[0-9a-f]{40}$/.test(baseSha)) fail("CONTRACT_INVALID");
  const approval = header("Review Approval Evidence");
  const ids = approval.match(/c-\d{17}/g) ?? [];
  if (ids.length !== 1 || ![`${options.ticketId}#${ids[0]}`, `${options.ticketId} comment ${ids[0]} by sinh`, ids[0]].includes(approval)) fail("APPROVAL_REJECTED");
  const comments = ticket.comments.filter((comment) => comment.id === ids[0]);
  const ref = `requirements:${path}`;
  // A finite producer clause, not keyword/substring inference from a human
  // discussion (which might reject the very same tuple). No body suffix or
  // negation can be interpreted as permission. This initial task decision is
  // independent of routine phase/check/commit authorization.
  const decision = `Approve ${options.ticketId} ${options.canonicalRepoKey} ${root} ${linked.branch}`;
  const approved = ["", "from "].some((prefix) => comments[0]?.content === `${decision} ${prefix}exact base ${baseSha}; source ${ref}.`);
  // Existing requirements producers have already recorded a richer whole-pair
  // decision. Authenticate its exact reviewed preview hash and task tuple instead
  // of demanding a new unchanged-facts baseline-only approval. This is a finite
  // producer format, not keyword approval inferred from arbitrary discussion.
  const reviewedPairApproved = (): boolean => {
    if (comments.length !== 1 || comments[0]!.author !== "sinh") return false;
    const content = comments[0]!.content;
    const revision = header("Review Revision");
    if (!/^r\d{3,}$/.test(revision) || /\b(?:revoke|revoked|reject|rejected|withdraw|withdrawn|cancel|cancelled)\b/i.test(content)) return false;
    const prefix = new RegExp(`^Explicit(?: standalone)? foreground PA sign-off in d-[0-9a-f]{6}: I selected (?:"Approve this exact pair" for owner-directed|Approve exact pair and matrix for) ${options.ticketId} ${revision}\\.`);
    const matches = [...content.matchAll(/Reviewed requirements(?: source)?: ([A-Za-z0-9_./-]+)[;,] raw SHA-256 ([0-9a-f]{64})(?=[;.,\s])/g)];
    if (!prefix.test(content) || matches.length !== 1 || !content.includes(`Matrix Source: ${ref}.`)) return false;
    const previewPath = `agent-teams/requirements/artifacts/reviews/${options.ticketId}/${revision}/requirements.md`;
    if (matches[0]![1] !== previewPath) return false;
    let preview: Uint8Array;
    try { preview = readReviewEvidenceFile(join(getAiUsageDir(), previewPath), 1_048_576, "ordinary reviewed task preview"); } catch { return false; }
    if (createHash("sha256").update(preview).digest("hex") !== matches[0]![2]) return false;
    let previewText: string;
    try { previewText = new TextDecoder("utf-8", { fatal: true }).decode(preview).split(/^##[ \t]/m)[0]!; } catch { return false; }
    return ["Ticket", "Repository Key", "Repository Root", "Handoff Type", "Feature Branch", baseLabel].every((label) => header(label, previewText) === header(label));
  };
  if (comments.length !== 1 || comments[0]!.author !== "sinh" || (!approved && !reviewedPairApproved())) fail("APPROVAL_REJECTED");
  const git = options.runGit ?? defaultGit;
  if (fullCommit(git, root, `${baseSha}^{commit}`, "intended task base") !== baseSha) fail("CONTRACT_INVALID");
  if (linked.state === "materialized") {
    if (linked.baseSha !== baseSha) fail("RETAINED_CONFLICT");
  } else if (fullCommit(git, root, `refs/heads/${repo!.developBranch ?? "develop"}^{commit}`, "configured integration branch") !== baseSha) fail("CONFIG_MISMATCH");
  const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  return Object.freeze({ schemaVersion: "ordinary-task-baseline/v1", repoKey: options.canonicalRepoKey, repoRoot: root, ticket: options.ticketId,
    branch: linked.branch, baseSha, requirements: Object.freeze({ ref, sha256: digest(bytes) }),
    approval: Object.freeze({ commentId: ids[0]!, sha256: digest(JSON.stringify({ id: comments[0]!.id, author: comments[0]!.author, content: comments[0]!.content })) }) });
}
function ordinaryBaselineError(code: string): Error {
  return new Error(`Condition: ORDINARY_BASELINE_${code}; ordinary branch materialization blocked. Source: primary approved task source and own-ticket operator sign-off. Reason: intended baseline is missing, changed, insecure or incompatible with current repository evidence. Correction: requirements/configuration owner must reconcile the exact repository, ticket, branch, full base and source-bound sign-off; preserve all existing work. Resume Action: retry ordinary launch after the owning evidence agrees; do not approve a substituted base, reset work or supply a SHA override.`);
}

export interface MaterializedTicketBranch {
  readonly branch: string;
  /** Absent only for admitted legacy materialized records whose historical base is unknown. */
  readonly baseSha?: string;
  readonly headSha: string;
  readonly created: boolean;
  readonly linkedBranch: LinkedBranch;
}

export function refreshTicketLinkedBranchHead(options: MaterializeTicketBranchOptions): LinkedBranch {
  const runGit = options.runGit ?? defaultGit;
  const canonicalRoot = exactPhysicalPath(options.canonicalRepoRoot, "canonical repository root");
  const worktreeRoot = exactPhysicalPath(options.worktreeRoot, "Treehouse worktree root");
  authenticateLinkedWorktree(options.canonicalRepoKey, canonicalRoot, worktreeRoot);
  const store = options.ticketStore ?? new TicketStore();
  const transaction = <T>(action: () => T): T => options.preparedCapacityOwner
    ? withPreparedRepositoryTicketOwner(options.preparedCapacityOwner, canonicalRoot, action)
    : withRepositoryTicketTransaction(canonicalRoot, action);
  return transaction(() => {
    authenticateLinkedWorktree(options.canonicalRepoKey, canonicalRoot, worktreeRoot);
    const ticket = store.get(options.ticketId);
    if (!ticket) throw diagnostic(`ticket ${options.ticketId} does not exist`, "restore the durable ticket before retrying");
    const linked = requireTicketLinkedBranch(ticket, options.canonicalRepoKey);
    if (linked.state !== "materialized" || !linked.headSha) throw diagnostic("ticket branch is not materialized", "materialize the planned branch through the authenticated checkout flow");
    if (symbolicBranch(runGit, worktreeRoot) !== linked.branch) throw diagnostic("selected checkout is not on the exact ticket branch", "switch only through authenticated ticket materialization");
    const headSha = fullCommit(runGit, worktreeRoot, "HEAD^{commit}", "selected ticket HEAD");
    const settlement = options.settlement;
    if (settlement && (linked.branch !== settlement.branch || linked.baseSha !== settlement.baseSha
      || (linked.headSha !== settlement.expectedHeadSha && linked.headSha !== settlement.headSha) || headSha !== settlement.headSha)) {
      throw diagnostic("terminal settlement ticket predecessor conflicts", "resume only the matching retained settlement without replacing newer ticket evidence");
    }
    const branchHead = fullCommit(runGit, canonicalRoot, `refs/heads/${linked.branch}^{commit}`, "ticket branch");
    if (headSha !== branchHead || (linked.baseSha && !isAncestor(runGit, canonicalRoot, linked.baseSha, headSha)) || !isAncestor(runGit, canonicalRoot, linked.headSha, headSha)) {
      throw diagnostic("ticket branch identity, ancestry, or authenticated head evidence is incompatible", "preserve the branch and reconcile replacement or drift under operator control");
    }
    const updated = store.update(options.ticketId, { add_linked_branch: { repo: options.canonicalRepoKey, branch: linked.branch, linkedBy: options.actor ?? "ppa" } }, options.actor ?? "ppa");
    const refreshed = requireTicketLinkedBranch(updated, options.canonicalRepoKey);
    if (refreshed.baseSha !== linked.baseSha || refreshed.headSha !== headSha) throw diagnostic("ticket head refresh changed immutable base evidence or missed current HEAD", "repair only the matching ticket record before retrying");
    return Object.freeze({ ...refreshed });
  });
}

/**
 * Materialize or select the ticket branch only inside an authenticated linked
 * worktree. The canonical checkout's branch, HEAD, and raw porcelain-v2 bytes
 * are compared before and after the complete transaction.
 */
export function materializeTicketBranch(options: MaterializeTicketBranchOptions): MaterializedTicketBranch {
  const runGit = options.runGit ?? defaultGit;
  const canonicalRoot = exactPhysicalPath(options.canonicalRepoRoot, "canonical repository root");
  const worktreeRoot = exactPhysicalPath(options.worktreeRoot, "Treehouse worktree root");
  const repo = loadRepoEntry(options.canonicalRepoKey);
  if (!repo || repo.path !== canonicalRoot) throw diagnostic("registered repository identity does not match the requested canonical root", "use the exact registered repository key/root pair");
  if (worktreeRoot === canonicalRoot) throw diagnostic("ticket materialization requires a linked Treehouse checkout, not the canonical checkout", "acquire or enter the matching leased Treehouse checkout and retry from its physical root");
  authenticateLinkedWorktree(options.canonicalRepoKey, canonicalRoot, worktreeRoot);
  const store = options.ticketStore ?? new TicketStore();
  const ticket = store.get(options.ticketId);
  if (!ticket) throw diagnostic(`ticket ${options.ticketId} does not exist`, "restore the durable ticket before acquiring a checkout");
  const linked = requireTicketLinkedBranch(ticket, options.canonicalRepoKey);
  const canonicalBefore = canonicalSnapshot(canonicalRoot, runGit);
  const ordinary = options.intendedTaskBaseline;
  if (ordinary && options.approvedPreparationBaseSha !== undefined) throw ordinaryBaselineError("CONTRACT_INVALID");
  const approvedBase = ordinary?.baseSha ?? options.approvedPreparationBaseSha;
  if (approvedBase !== undefined && !/^[0-9a-f]{40}$/.test(approvedBase)) throw diagnostic("preparation base is not one exact full commit SHA", "resolve the immutable approved base before resource actions");
  const transaction = <T>(action: (capacity?: RepositoryTicketTransaction) => T): T => options.preparedCapacityOwner
    ? withPreparedRepositoryTicketOwner(options.preparedCapacityOwner, canonicalRoot, () => action())
    : withRepositoryTicketTransaction(canonicalRoot, action);

  return transaction((capacity) => {
    authenticateLinkedWorktree(options.canonicalRepoKey, canonicalRoot, worktreeRoot);
    const currentTicket = store.get(options.ticketId);
    if (!currentTicket) throw diagnostic(`ticket ${options.ticketId} disappeared during materialization`, "restore the same ticket evidence and retry");
    const currentLinked = requireTicketLinkedBranch(currentTicket, options.canonicalRepoKey);
    if (currentLinked.branch !== linked.branch || currentLinked.baseSha !== linked.baseSha || currentLinked.headSha !== linked.headSha || currentLinked.state !== linked.state) {
      throw diagnostic("linked-branch evidence changed after checkout selection", "preserve the checkout and retry from fresh ticket evidence");
    }

    if (ordinary) {
      const current = resolveOrdinaryTaskBaseline(options);
      if (JSON.stringify(current) !== JSON.stringify(ordinary)) throw ordinaryBaselineError("CHANGED");
      if (gitBytes(runGit(["status", "--porcelain=v2", "--untracked-files=all", "-z"], worktreeRoot)).length) throw ordinaryBaselineError("CHECKOUT_DIRTY");
      const gitDir = gitText(runGit(["rev-parse", "--absolute-git-dir"], worktreeRoot)).trim();
      let authority;
      try { authority = observeReadonlyRepositoryAuthority(gitDir); } catch { throw ordinaryBaselineError("HOLDER_UNCERTAIN"); }
      if (authority.owner || authority.borrower || authority.implement || authority.review) throw ordinaryBaselineError("HOLDER_CONFLICT");
    }
    const developBranch = repo.developBranch ?? "develop";
    const developSha = fullCommit(runGit, canonicalRoot, `refs/heads/${developBranch}^{commit}`, `configured local ${developBranch}`);
    const selectedBase = approvedBase === undefined ? developSha : fullCommit(runGit, canonicalRoot, `${approvedBase}^{commit}`, ordinary ? "intended task base" : "approved preparation base");
    if (approvedBase !== undefined && selectedBase !== approvedBase) throw diagnostic("approved preparation base did not resolve exactly", "preserve the checkout and reconcile the immutable approval source");
    if (approvedBase !== undefined && linked.state === "materialized" && linked.baseSha !== approvedBase) throw diagnostic("retained materialization base does not match the current exact approved preparation base", "preserve historical provenance and obtain the owning changed-base or migration decision");
    const existingHead = optionalCommit(runGit, canonicalRoot, `refs/heads/${linked.branch}`);
    const occupiedAt = branchWorktree(runGit, canonicalRoot, linked.branch);
    if (occupiedAt && occupiedAt !== worktreeRoot) {
      throw diagnostic(`ticket branch ${linked.branch} is already checked out at ${occupiedAt}`, "stop the other checkout or reconcile it under operator control; do not replace the branch");
    }

    let intent;
    if (ordinary && options.ordinaryOwner && linked.state === "planned") {
      if (!capacity) throw ordinaryBaselineError("HOLDER_CONFLICT");
      try { intent = capacity.ordinaryIntent(options.ordinaryOwner, { baselineSha256: createHash("sha256").update(JSON.stringify(ordinary)).digest("hex"), worktreeRoot, branch: linked.branch, baseSha: selectedBase }, existingHead !== undefined); }
      catch { throw ordinaryBaselineError("OWNER_INTENT_REJECTED"); }
    }
    const marker = intent ? `pa-ordinary-materialization:${intent.operationId}` : null;
    let created = false;
    if (linked.state === "planned") {
      if (existingHead) {
        const reservation = options.preparedCapacityOwner?.inventory().find((row) => row.ticket === options.ticketId);
        const ownedExactPreparation = !ordinary && approvedBase !== undefined && options.preparationOperationId !== undefined
          && reservation && "operationId" in reservation && reservation.operationId === options.preparationOperationId && reservation.occupancy === "preparing"
          && existingHead === selectedBase && occupiedAt === worktreeRoot && symbolicBranch(runGit, worktreeRoot) === linked.branch;
        const ownedExactOrdinary = marker !== null && existingHead === selectedBase && (!occupiedAt || occupiedAt === worktreeRoot)
          && gitText(runGit(["reflog", "show", "--format=%H%x00%gs", "-n", "1", `refs/heads/${linked.branch}`], canonicalRoot)).trim() === `${selectedBase}\0${marker}`;
        if (!ownedExactPreparation && !ownedExactOrdinary) throw diagnostic("planned branch evidence raced with an independently created local branch", "refresh and reconcile the ticket branch evidence before retrying");
        if (ownedExactOrdinary && !occupiedAt) gitText(runGit(["checkout", "--no-guess", linked.branch], worktreeRoot));
        // The optional service has prior durable operation intent, exact capacity
        // custody and this same vacant checkout/base. Finish ticket publication;
        // never recreate/reset/checkout an independently observed branch.
      } else {
        if (marker) {
          // Compare-and-create plus a native operation marker supplies durable
          // result proof even if interrupted before checkout/ticket publication.
          // The existing capacity owner stores intent; no parallel ledger/reset.
          try {
            gitText(runGit(["update-ref", "--create-reflog", "-m", marker, `refs/heads/${linked.branch}`, selectedBase, "0".repeat(40)], canonicalRoot));
            gitText(runGit(["checkout", "--no-guess", linked.branch], worktreeRoot));
          } catch { throw ordinaryBaselineError("BRANCH_RESULT_UNCERTAIN"); }
        } else gitText(runGit(["checkout", "--no-guess", "-b", linked.branch, selectedBase], worktreeRoot));
        created = true;
      }
    } else {
      if (!existingHead) throw diagnostic("a materialized ticket branch no longer exists locally", "restore or explicitly reconcile the recorded branch; automatic recreation is forbidden");
      const currentBranch = symbolicBranch(runGit, worktreeRoot);
      if (currentBranch !== linked.branch) gitText(runGit(["checkout", "--no-guess", linked.branch], worktreeRoot));
    }

    const headSha = fullCommit(runGit, worktreeRoot, "HEAD^{commit}", "selected ticket HEAD");
    const branchHead = fullCommit(runGit, canonicalRoot, `refs/heads/${linked.branch}^{commit}`, "ticket branch");
    if (headSha !== branchHead) throw diagnostic("selected worktree HEAD does not equal the ticket branch ref", "preserve the checkout and reconcile branch replacement or drift before retrying");
    const baseSha = linked.state === "planned" ? selectedBase : linked.baseSha;
    if (linked.state === "planned" && headSha !== selectedBase) throw diagnostic("new ticket branch did not materialize at the exact selected base SHA", "preserve the branch for diagnosis; do not reset or recreate it automatically");
    if (baseSha && !isAncestor(runGit, canonicalRoot, baseSha, headSha)) throw diagnostic("ticket head is not descended from immutable baseSha", "reconcile branch replacement under operator control");
    if (linked.headSha && !isAncestor(runGit, canonicalRoot, linked.headSha, headSha)) throw diagnostic("ticket branch head was replaced instead of advanced", "restore or explicitly reconcile the recorded branch; do not overwrite evidence");

    const promoted = store.update(options.ticketId, { add_linked_branch: { repo: options.canonicalRepoKey, branch: linked.branch, linkedBy: options.actor ?? "ppa" } }, options.actor ?? "ppa");
    const refreshed = requireTicketLinkedBranch(promoted, options.canonicalRepoKey);
    if (refreshed.state !== "materialized" || refreshed.headSha !== headSha || refreshed.baseSha !== baseSha) {
      throw diagnostic("ticket promotion did not preserve authenticated base/head evidence, including an unknown legacy base", "preserve the Treehouse branch and repair only the matching ticket record");
    }
    if (linked.baseSha && refreshed.baseSha !== linked.baseSha) throw diagnostic("immutable ticket baseSha changed during refresh", "restore the original baseSha and inspect the branch for replacement");

    const canonicalAfter = canonicalSnapshot(canonicalRoot, runGit);
    if (!canonicalBefore.equals(canonicalAfter)) throw diagnostic("canonical checkout branch, HEAD, or porcelain-v2 bytes changed during ticket materialization", "preserve both checkouts and diagnose the unexpected canonical mutation");
    return Object.freeze({ branch: linked.branch, ...(refreshed.baseSha ? { baseSha: refreshed.baseSha } : {}), headSha, created, linkedBranch: Object.freeze({ ...refreshed }) });
  });
}

function authenticateLinkedWorktree(repoKey: string, canonicalRoot: string, worktreeRoot: string): void {
  let resolvedRepo;
  try { resolvedRepo = resolveRepoExecutionPath(undefined, worktreeRoot, { allowLinkedWorktreeCwd: true }); }
  catch (error) { throw diagnostic(`Treehouse path failed linked-worktree authentication: ${error instanceof Error ? error.message : String(error)}`, "use the exact physical registered linked worktree path"); }
  if (resolvedRepo.repoKey !== repoKey || resolvedRepo.repoRoot !== canonicalRoot || resolvedRepo.worktreeRoot !== worktreeRoot || resolvedRepo.repositoryCwd !== worktreeRoot || resolvedRepo.worktreeKind !== "linked") {
    throw diagnostic("Treehouse path does not match the registered repository top-level/common-dir/worktree membership", "use the sole matching physical leased checkout");
  }
}

function canonicalSnapshot(root: string, runGit: (args: readonly string[], cwd: string) => string | Buffer): Buffer {
  const branch = Buffer.from(symbolicBranch(runGit, root), "utf8");
  const head = Buffer.from(fullCommit(runGit, root, "HEAD^{commit}", "canonical HEAD"), "utf8");
  const status = gitBytes(runGit(["status", "--porcelain=v2", "--untracked-files=all", "-z"], root));
  return Buffer.concat([lengthPrefix(branch), branch, lengthPrefix(head), head, lengthPrefix(status), status]);
}

function branchWorktree(runGit: (args: readonly string[], cwd: string) => string | Buffer, root: string, branch: string): string | undefined {
  const fields = gitBytes(runGit(["worktree", "list", "--porcelain", "-z"], root)).toString("utf8").split("\0");
  let worktree: string | undefined;
  for (const field of fields) {
    if (field.startsWith("worktree ")) worktree = field.slice("worktree ".length);
    if (field === `branch refs/heads/${branch}` && worktree) return exactPhysicalPath(worktree, "registered branch worktree");
  }
  return undefined;
}

function symbolicBranch(runGit: (args: readonly string[], cwd: string) => string | Buffer, root: string): string {
  const branch = gitText(runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], root)).trim();
  if (!branch) throw diagnostic("selected checkout has detached HEAD", "switch it to the exact ticket branch through the authenticated materialization flow");
  return branch;
}

function fullCommit(runGit: (args: readonly string[], cwd: string) => string | Buffer, root: string, ref: string, label: string): string {
  const sha = gitText(runGit(["rev-parse", "--verify", ref], root)).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw diagnostic(`${label} did not resolve to one full commit SHA`, "restore the exact local ref and retry");
  return sha;
}

function optionalCommit(runGit: (args: readonly string[], cwd: string) => string | Buffer, root: string, ref: string): string | undefined {
  // --exists distinguishes an absent exact ref (2) from lookup failure (1).
  // A present ref must still resolve to a commit: dangling/noncommit refs are errors.
  try { runGit(["show-ref", "--exists", ref], root); }
  catch (error) {
    const result = error as { status?: number; stdout?: Buffer } | null;
    if (result?.status === 2 && !result.stdout?.length) return undefined;
    throw error;
  }
  return fullCommit(runGit, root, `${ref}^{commit}`, ref);
}

function isAncestor(runGit: (args: readonly string[], cwd: string) => string | Buffer, root: string, base: string, head: string): boolean {
  try { runGit(["merge-base", "--is-ancestor", base, head], root); return true; } catch { return false; }
}

function exactPhysicalPath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) throw diagnostic(`${label} is not an exact absolute path`, "use the physical absolute path without aliases");
  let physical: string;
  try { physical = realpathSync(value); } catch { throw diagnostic(`${label} does not exist`, "restore the selected checkout before retrying"); }
  if (physical !== value) throw diagnostic(`${label} uses a symlink alias`, "use the physical path returned by Git and Treehouse");
  return physical;
}

function lengthPrefix(value: Buffer): Buffer { const result = Buffer.alloc(8); result.writeBigUInt64BE(BigInt(value.length)); return result; }
function gitText(value: string | Buffer): string { return typeof value === "string" ? value : value.toString("utf8"); }
function gitBytes(value: string | Buffer): Buffer { return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value); }
function defaultGit(args: readonly string[], cwd: string): Buffer {
  // Capture only the optional existence operation. Other Git diagnostics keep
  // their existing presentation; no checkout/required-ref stderr is discarded.
  const optionalProbe = args[0] === "show-ref" && args[1] === "--exists";
  return execFileSync("git", [...args], { cwd, ...(optionalProbe ? { stdio: ["ignore", "pipe", "pipe"] as const } : {}), maxBuffer: 16 * 1024 * 1024 });
}
function diagnostic(reason: string, resume: string): Error {
  const message = `Condition: ticket branch materialization. Source: authenticated registered Treehouse checkout and ticket linked-branch evidence. Reason: ${reason}. Correction: preserve canonical and Treehouse checkouts without reset, cleanup, or branch replacement. Resume Action: ${resume}.`;
  return new Error(message.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS ? message : `${message.slice(0, MAX_REPOSITORY_DIAGNOSTIC_CHARS - 3)}...`);
}
