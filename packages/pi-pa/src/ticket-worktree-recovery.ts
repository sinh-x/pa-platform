import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  assertSupportedGitMetadataRead, captureRepositoryGitSnapshot,
  getTicketsDir, LOCAL_GIT_CONTROL_FLAGS, observeReadonlyRepositoryAuthority,
  observeRetainedRepositoryTicketSlot, readReviewEvidenceFile, refreshTicketLinkedBranchHead,
  REPOSITORY_TICKET_SLOT_DIRECTORY, requireTicketLinkedBranch, resolveRepoExecutionPath,
  type Ticket,
} from "@pa-platform/pa-core";
import { inspectPiTicketRecovery, type TicketRecoveryInspection } from "./ticket-recovery.js";
import { TreehouseClient } from "./treehouse.js";

export const TICKET_WORKTREE_RECOVERY_USAGE = "ppa pi ticket-worktree inspect --repo KEY --ticket TICKET [--json]\nppa pi ticket-worktree refresh-head --repo KEY --ticket TICKET --expected-observation SHA256 [--json]";
export interface TicketWorktreeRecoveryRequest {
  readonly action: "inspect" | "refresh-head";
  readonly repo: string;
  readonly ticket: string;
  readonly expectedObservation?: string;
  readonly json: boolean;
}
export interface TicketWorktreeRecoveryView {
  readonly schemaVersion: "pa-ticket-worktree-recovery/v1";
  readonly outcome: "observed" | "blocked" | "unavailable" | "head-refreshed" | "refresh-uncertain";
  readonly repo: string;
  readonly ticket: string;
  readonly head: "matching" | "refreshable" | "conflicting" | "unavailable";
  readonly execution: "absent" | "retained" | "conflicting" | "unavailable";
  readonly capacity: "absent" | "retained" | "unsupported" | "unavailable";
  readonly branch?: string;
  readonly baseSha?: string;
  readonly recordedHeadSha?: string;
  readonly currentHeadSha?: string;
  readonly deploymentId?: string;
  readonly recoveryCause?: TicketRecoveryInspection["cause"];
  /** Binds HEAD metadata refresh only, never an execution settlement grant. */
  readonly observationDigest?: string;
  readonly refreshCommand?: string;
  readonly inspectionCommand?: string;
  readonly diagnostic: string;
}
type Dependencies = { readonly treehouse?: TreehouseClient; readonly cwd?: string };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function parseTicketWorktreeRecoveryArgs(args: readonly string[]): TicketWorktreeRecoveryRequest {
  const action = args[0];
  if (action !== "inspect" && action !== "refresh-head") throw new Error("invalid workflow usage");
  if (args.length > 8) throw new Error("invalid workflow usage");
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (!["--repo", "--ticket", "--expected-observation", "--json"].includes(key) || values.has(key)) throw new Error("invalid workflow usage");
    if (key === "--json") values.set(key, "true");
    else { const value = args[++i]; if (!value || value.startsWith("-")) throw new Error("invalid workflow usage"); values.set(key, value); }
  }
  const repo = values.get("--repo") ?? "", ticket = values.get("--ticket") ?? "", expectedObservation = values.get("--expected-observation");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(repo) || !/^[A-Z]{1,32}-[0-9]{1,12}$/.test(ticket)
    || (action === "inspect" ? expectedObservation !== undefined : !/^[0-9a-f]{64}$/.test(expectedObservation ?? ""))) throw new Error("invalid workflow usage");
  return Object.freeze({ action, repo, ticket, ...(expectedObservation ? { expectedObservation } : {}), json: values.has("--json") });
}
/** Pure output from validated native observations; never exception text or protected bodies. */
export function ticketWorktreeRecoveryDiagnostic(view: Omit<TicketWorktreeRecoveryView, "diagnostic">, stale = false): string {
  if (view.outcome === "head-refreshed") return "The ticket's linked HEAD was refreshed. No execution claims were released and no deployment was launched.\nNext: inspect the same ticket worktree again; selection and builder admission remain separate checks.";
  if (view.outcome === "observed") return "Ticket-worktree inspection finished: linked HEAD matches; no claim for this checkout or capacity record for this ticket was found.\nLaunch admission was not checked. Next: run the intended canonical-CWD ticket-worktree dry-run; a dry-run is not builder-capacity admission proof.";
  const reason = stale ? "The preview no longer matches the current evidence. No linked-HEAD update was requested from the ticket owner."
    : view.outcome === "refresh-uncertain" ? "The native HEAD refresh was requested, but its complete result could not be verified. Ticket metadata may have changed; execution claims were not released."
    : view.outcome === "unavailable" ? "Required ticket, checkout or protected evidence could not be authenticated. No recovery was applied."
    : [view.head === "refreshable" ? "The checkout advanced beyond its recorded linked HEAD." : view.head === "conflicting" ? "The branch, base or HEAD conflicts with the ticket link." : "The linked HEAD matches.",
      view.execution !== "absent" || view.capacity !== "absent" ? "Retained or conflicting execution/capacity evidence still blocks recovery; HEAD refresh cannot clear it." : "No retained execution claim was found; launch admission is not established."].join(" ");
  const safeCoordinates = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(view.repo) && /^[A-Z]{1,32}-[0-9]{1,12}$/.test(view.ticket);
  const refreshCommand = safeCoordinates && /^[0-9a-f]{64}$/.test(view.observationDigest ?? "")
    ? `ppa pi ticket-worktree refresh-head --repo ${view.repo} --ticket ${view.ticket} --expected-observation ${view.observationDigest}` : undefined;
  const inspectionCommand = safeCoordinates && /^d-[0-9a-f]{6}$/.test(view.deploymentId ?? "")
    ? `ppa pi inspect-recovery --repo ${view.repo} --ticket ${view.ticket} --deployment-id ${view.deploymentId}` : undefined;
  const correction = refreshCommand && view.refreshCommand === refreshCommand && !stale && view.outcome !== "refresh-uncertain" && view.outcome !== "unavailable"
    ? `Operator may request metadata-only refresh with ${refreshCommand}. Impact: state-changing (ticket HEAD only). Actor: operator. New approval: explicit authorization for this change. Prerequisite: unchanged preview and descendant HEAD. Execution recovery is separate`
    : inspectionCommand
      ? `Inspect the retained predecessor with ${inspectionCommand}. Impact: read-only. Actor: operator or agent. New approval: not required for inspection. Prerequisite: preserve original native evidence; inspection does not settle claims`
      : "Inspect this same ticket worktree again from its registered canonical CWD. Impact: read-only. Actor: operator or agent. New approval: not required. Prerequisite: restore readable exact evidence through its owner; do not replace the checkout";
  // All prose is finite; the only variable text is a re-derived strict command.
  // The shared weighted truncator can cut command digests/action metadata, so it
  // cannot render this particular envelope safely. The full grammar maximum is
  // tested below 2,000 UTF-16 units, including the headline, without truncation.
  return `Ticket worktree is not ready for a new writer.\nCondition: ${view.outcome === "refresh-uncertain" ? "Linked-HEAD refresh outcome is uncertain; no launch was requested" : "Recovery has not released execution claims or admitted a writer"}.\nSource: Registered checkout, ticket linked-HEAD and protected PA claim inspection.\nReason: ${reason}\nCorrection: ${correction}.\nResume Action: Reinspect the same records after the stated correction. Retained cleanup needs complete native proof and supported owner settlement before launch admission is retried. Do not force takeover, delete evidence or return the lease.`;
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Internal coordinates never appear in public output. No TicketStore, lock,
 * evidence directory initialization, Git refresh, allocation or claim release. */
function observe(request: TicketWorktreeRecoveryRequest, dependencies: Dependencies) {
  let head: TicketWorktreeRecoveryView["head"] = "unavailable", execution: TicketWorktreeRecoveryView["execution"] = "unavailable", capacity: TicketWorktreeRecoveryView["capacity"] = "unavailable";
  const view = (fields: Partial<TicketWorktreeRecoveryView> = {}): TicketWorktreeRecoveryView => {
    const row = { schemaVersion: "pa-ticket-worktree-recovery/v1" as const, outcome: "unavailable" as TicketWorktreeRecoveryView["outcome"], repo: request.repo, ticket: request.ticket, head, execution, capacity, ...fields };
    return Object.freeze({ ...row, diagnostic: ticketWorktreeRecoveryDiagnostic(row) });
  };
  try {
    parseTicketWorktreeRecoveryArgs([request.action, "--repo", request.repo, "--ticket", request.ticket, ...(request.expectedObservation ? ["--expected-observation", request.expectedObservation] : [])]);
    const canonical = resolveRepoExecutionPath(request.repo, dependencies.cwd ?? process.cwd());
    if (canonical.repoKey !== request.repo || canonical.worktreeKind !== "primary" || realpathSync(dependencies.cwd ?? process.cwd()) !== canonical.repoRoot) return { view: view() };
    const ticketPath = join(getTicketsDir(), `${request.ticket}.json`), ticketBytes = Buffer.from(readReviewEvidenceFile(ticketPath, 1_048_576, "ticket worktree recovery"));
    const ticket = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(ticketBytes)) as Ticket;
    const linked = requireTicketLinkedBranch(ticket, canonical.repoKey);
    if (ticket.id !== request.ticket || linked.state !== "materialized" || !/^[0-9a-f]{40}$/.test(linked.baseSha ?? "") || !/^[0-9a-f]{40}$/.test(linked.headSha ?? "")
      || (linked.sha !== undefined && linked.sha !== linked.headSha)) return { view: view() };
    const lease = (dependencies.treehouse ?? new TreehouseClient()).selectExisting(canonical.repoRoot, canonical.repoKey, request.ticket);
    const physical = resolveRepoExecutionPath(undefined, lease.path, { allowLinkedWorktreeCwd: true });
    if (physical.repoKey !== canonical.repoKey || physical.repoRoot !== canonical.repoRoot || physical.gitCommonDir !== canonical.gitCommonDir || physical.worktreeKind !== "linked" || physical.worktreeRoot !== lease.path) return { view: view() };
    const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const git = (args: readonly string[], cwd: string) => execFileSync("git", [...LOCAL_GIT_CONTROL_FLAGS, ...args], { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_DIR: cwd === canonical.repoRoot ? canonical.gitDir : physical.gitDir,
      GIT_COMMON_DIR: physical.gitCommonDir, GIT_WORK_TREE: cwd }, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    assertSupportedGitMetadataRead(physical.worktreeRoot, git);
    const snapshot = captureRepositoryGitSnapshot(physical.worktreeRoot, git);
    const branchHead = git(["rev-parse", "--verify", `refs/heads/${linked.branch}^{commit}`], canonical.repoRoot).toString("utf8").trim();
    const ancestor = (sha: string) => { try { git(["merge-base", "--is-ancestor", sha, snapshot.head], canonical.repoRoot); return true; } catch (error) { if ((error as { status?: unknown }).status === 1) return false; throw error; } };
    head = snapshot.branch === linked.branch && snapshot.head === branchHead && ancestor(linked.baseSha!) && ancestor(linked.headSha!)
      ? snapshot.head === linked.headSha ? "matching" : "refreshable" : "conflicting";
    const authority = observeReadonlyRepositoryAuthority(physical.gitDir);
    const owner = authority.owner;
    execution = authority.implement || authority.borrower || authority.review ? "conflicting" : owner ? "retained" : "absent";
    if (owner && (owner.canonicalRepoKey !== canonical.repoKey || owner.canonicalRepoRoot !== canonical.repoRoot || owner.worktreeRoot !== physical.worktreeRoot || owner.ticket !== request.ticket)) execution = "conflicting";
    const slotDir = join(physical.gitCommonDir, REPOSITORY_TICKET_SLOT_DIRECTORY), slotName = digest(request.ticket);
    let capacityIdentity = "absent", capacityDeployment: string | undefined;
    if (!present(slotDir)) capacity = "absent";
    else {
      const stat = lstatSync(slotDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(slotDir) !== slotDir || (stat.mode & 0o7777) !== 0o700 || stat.uid !== process.getuid?.()) throw new Error("invalid capacity directory");
      const ordinary = join(slotDir, `${slotName}.json`), prepared = join(slotDir, `${slotName}.prepared.json`);
      if (present(prepared)) { capacity = "unsupported"; capacityIdentity = digest(Buffer.from(readReviewEvidenceFile(prepared, 65_536, "prepared capacity"))); }
      else if (present(ordinary)) {
        const slot = observeRetainedRepositoryTicketSlot(canonical.repoRoot, request.ticket);
        if (slot.canonicalRepoKey !== canonical.repoKey || slot.canonicalRepoRoot !== canonical.repoRoot || slot.ticket !== request.ticket) throw new Error("capacity identity conflict");
        capacity = "retained"; capacityDeployment = slot.deploymentId;
        const stat = lstatSync(ordinary);
        capacityIdentity = digest(Buffer.concat([Buffer.from(`${stat.dev}:${stat.ino}:${stat.ctimeMs}:`), Buffer.from(readReviewEvidenceFile(ordinary, 65_536, "retained capacity"))]));
      } else capacity = "absent";
    }
    const deploymentId = owner?.deploymentId ?? capacityDeployment;
    const safeDeployment = deploymentId && /^d-[0-9a-f]{6}$/.test(deploymentId) ? deploymentId : undefined;
    const recovery = safeDeployment && execution !== "conflicting" ? inspectPiTicketRecovery({ repo: request.repo, ticket: request.ticket, deploymentId: safeDeployment, json: true }, dependencies) : undefined;
    // Directory births plus registration bytes detect physical replacement. This
    // is a HEAD-refresh observation, NOT a complete dirty-byte recovery inventory.
    const identities = [canonical.repoRoot, physical.worktreeRoot, physical.gitDir, physical.gitCommonDir].map(path => {
      const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error("physical identity conflict");
      return [path, stat.dev, stat.ino, stat.mode, stat.uid];
    });
    const metadata = [join(physical.worktreeRoot, ".git"), join(physical.gitDir, "gitdir"), join(physical.gitDir, "commondir"), join(physical.gitDir, "HEAD")].map(path => {
      const stat = lstatSync(path); return [stat.dev, stat.ino, stat.ctimeMs, digest(Buffer.from(readReviewEvidenceFile(path, 65_536, "worktree registration")))];
    });
    const observationDigest = digest(JSON.stringify([ticketBytes.toString("base64"), lease, identities, metadata, snapshot.digestSha256, authority.identity, capacityIdentity]));
    const outcome = head === "matching" && execution === "absent" && capacity === "absent" ? "observed" : "blocked";
    const refreshCommand = head === "refreshable" && execution !== "conflicting" && capacity !== "unsupported"
      ? `ppa pi ticket-worktree refresh-head --repo ${request.repo} --ticket ${request.ticket} --expected-observation ${observationDigest}` : undefined;
    const inspectionCommand = safeDeployment ? `ppa pi inspect-recovery --repo ${request.repo} --ticket ${request.ticket} --deployment-id ${safeDeployment}` : undefined;
    return { view: view({ outcome, branch: linked.branch, baseSha: linked.baseSha, recordedHeadSha: linked.headSha, currentHeadSha: snapshot.head,
      ...(safeDeployment ? { deploymentId: safeDeployment } : {}), ...(recovery ? { recoveryCause: recovery.cause } : {}), observationDigest,
      ...(refreshCommand ? { refreshCommand } : {}), ...(inspectionCommand ? { inspectionCommand } : {}) }), canonical, physical, git };
  } catch { return { view: view() }; }
}
export function inspectTicketWorktreeRecovery(request: TicketWorktreeRecoveryRequest, dependencies: Dependencies = {}): TicketWorktreeRecoveryView {
  return observe({ ...request, action: "inspect", expectedObservation: undefined }, dependencies).view;
}
export function refreshTicketWorktreeHead(request: TicketWorktreeRecoveryRequest, dependencies: Dependencies = {}): TicketWorktreeRecoveryView {
  const initial = observe(request, dependencies);
  const stale = () => Object.freeze({ ...initial.view, outcome: "blocked" as const, refreshCommand: undefined, observationDigest: undefined,
    diagnostic: ticketWorktreeRecoveryDiagnostic({ ...initial.view, outcome: "blocked" }, true) });
  // The existing TicketStore Git validator uses the host environment. Do not let
  // a redirected Git context select different refs during its metadata write.
  if (Object.keys(process.env).some(key => key.startsWith("GIT_"))) return stale();
  if (request.action !== "refresh-head" || !initial.view.refreshCommand || initial.view.observationDigest !== request.expectedObservation || !initial.canonical || !initial.physical || !initial.git) return stale();
  let effectRequested = false;
  try {
    refreshTicketLinkedBranchHead({ canonicalRepoKey: request.repo, canonicalRepoRoot: initial.canonical.repoRoot, worktreeRoot: initial.physical.worktreeRoot,
      ticketId: request.ticket, actor: "ppa-ticket-worktree", runGit: initial.git,
      authenticateHeadRefresh: () => {
        const current = observe(request, dependencies).view;
        if (!current.refreshCommand || current.observationDigest !== request.expectedObservation) throw new Error("stale HEAD refresh preview");
        effectRequested = true;
      },
    });
    const row = { ...initial.view, outcome: "head-refreshed" as const, head: "matching" as const, recordedHeadSha: initial.view.currentHeadSha,
      observationDigest: undefined, refreshCommand: undefined };
    return Object.freeze({ ...row, diagnostic: ticketWorktreeRecoveryDiagnostic(row) });
  } catch {
    if (!effectRequested) return stale();
    const row = { ...initial.view, outcome: "refresh-uncertain" as const, refreshCommand: undefined, observationDigest: undefined };
    return Object.freeze({ ...row, diagnostic: ticketWorktreeRecoveryDiagnostic(row) });
  }
}
export function runTicketWorktreeRecoveryCommand(args: readonly string[], io = { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) }): number {
  if (args.length === 1 && args[0] === "--help") { io.stdout(`${TICKET_WORKTREE_RECOVERY_USAGE}\nInspect is read-only. Refresh-head changes only the existing ticket link through its native owner.\nNeither route releases execution claims, returns a lease, allocates a checkout or launches work.\n`); return 0; }
  let request: TicketWorktreeRecoveryRequest;
  try { request = parseTicketWorktreeRecoveryArgs(args); } catch { io.stderr(`${TICKET_WORKTREE_RECOVERY_USAGE}\nInvalid workflow arguments; no action started. Use --help.\n`); return 2; }
  const result = request.action === "inspect" ? inspectTicketWorktreeRecovery(request) : refreshTicketWorktreeHead(request);
  io.stdout(`${request.json ? JSON.stringify(result) : result.diagnostic}\n`);
  return result.outcome === "observed" || result.outcome === "head-refreshed" ? 0 : result.outcome === "blocked" ? 1 : 2;
}
