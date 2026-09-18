import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { withRepositoryTicketTransaction } from "../deploy/ticket-concurrency.js";
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
  return withRepositoryTicketTransaction(canonicalRoot, () => {
    authenticateLinkedWorktree(options.canonicalRepoKey, canonicalRoot, worktreeRoot);
    const ticket = store.get(options.ticketId);
    if (!ticket) throw diagnostic(`ticket ${options.ticketId} does not exist`, "restore the durable ticket before retrying");
    const linked = requireTicketLinkedBranch(ticket, options.canonicalRepoKey);
    if (linked.state !== "materialized" || !linked.headSha) throw diagnostic("ticket branch is not materialized", "materialize the planned branch through the authenticated checkout flow");
    if (symbolicBranch(runGit, worktreeRoot) !== linked.branch) throw diagnostic("selected checkout is not on the exact ticket branch", "switch only through authenticated ticket materialization");
    const headSha = fullCommit(runGit, worktreeRoot, "HEAD^{commit}", "selected ticket HEAD");
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

  return withRepositoryTicketTransaction(canonicalRoot, () => {
    authenticateLinkedWorktree(options.canonicalRepoKey, canonicalRoot, worktreeRoot);
    const currentTicket = store.get(options.ticketId);
    if (!currentTicket) throw diagnostic(`ticket ${options.ticketId} disappeared during materialization`, "restore the same ticket evidence and retry");
    const currentLinked = requireTicketLinkedBranch(currentTicket, options.canonicalRepoKey);
    if (currentLinked.branch !== linked.branch || currentLinked.baseSha !== linked.baseSha || currentLinked.headSha !== linked.headSha || currentLinked.state !== linked.state) {
      throw diagnostic("linked-branch evidence changed after checkout selection", "preserve the checkout and retry from fresh ticket evidence");
    }

    const developBranch = repo.developBranch ?? "develop";
    const developSha = fullCommit(runGit, canonicalRoot, `refs/heads/${developBranch}^{commit}`, `configured local ${developBranch}`);
    const existingHead = optionalCommit(runGit, canonicalRoot, `refs/heads/${linked.branch}^{commit}`);
    const occupiedAt = branchWorktree(runGit, canonicalRoot, linked.branch);
    if (occupiedAt && occupiedAt !== worktreeRoot) {
      throw diagnostic(`ticket branch ${linked.branch} is already checked out at ${occupiedAt}`, "stop the other checkout or reconcile it under operator control; do not replace the branch");
    }

    let created = false;
    if (linked.state === "planned") {
      if (existingHead) throw diagnostic("planned branch evidence raced with an independently created local branch", "refresh and reconcile the ticket branch evidence before retrying");
      gitText(runGit(["checkout", "--no-guess", "-b", linked.branch, developSha], worktreeRoot));
      created = true;
    } else {
      if (!existingHead) throw diagnostic("a materialized ticket branch no longer exists locally", "restore or explicitly reconcile the recorded branch; automatic recreation is forbidden");
      const currentBranch = symbolicBranch(runGit, worktreeRoot);
      if (currentBranch !== linked.branch) gitText(runGit(["checkout", "--no-guess", linked.branch], worktreeRoot));
    }

    const headSha = fullCommit(runGit, worktreeRoot, "HEAD^{commit}", "selected ticket HEAD");
    const branchHead = fullCommit(runGit, canonicalRoot, `refs/heads/${linked.branch}^{commit}`, "ticket branch");
    if (headSha !== branchHead) throw diagnostic("selected worktree HEAD does not equal the ticket branch ref", "preserve the checkout and reconcile branch replacement or drift before retrying");
    const baseSha = linked.state === "planned" ? developSha : linked.baseSha;
    if (linked.state === "planned" && headSha !== developSha) throw diagnostic("new ticket branch did not materialize at the exact configured local develop SHA", "preserve the branch for diagnosis; do not reset or recreate it automatically");
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
  try { return fullCommit(runGit, root, ref, ref); } catch { return undefined; }
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
function defaultGit(args: readonly string[], cwd: string): Buffer { return execFileSync("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }); }
function diagnostic(reason: string, resume: string): Error {
  const message = `Condition: ticket branch materialization. Source: authenticated registered Treehouse checkout and ticket linked-branch evidence. Reason: ${reason}. Correction: preserve canonical and Treehouse checkouts without reset, cleanup, or branch replacement. Resume Action: ${resume}.`;
  return new Error(message.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS ? message : `${message.slice(0, MAX_REPOSITORY_DIAGNOSTIC_CHARS - 3)}...`);
}
