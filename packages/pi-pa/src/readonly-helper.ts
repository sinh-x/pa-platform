import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  ReadOnlyHelperFailure, captureRepositoryGitSnapshot, formatBoundedFiveFieldDiagnostic,
  getDeployPaths, getTicketsDir, isCanonicalTicketId, observeReadonlyRepositoryAuthority,
  observeReadonlyRepositoryTicketSlot, processIsWithinFingerprintLineage, queryReadonlyHelperRegistry,
  readProcessFingerprint, repositoryGitSnapshotsEqual, requireTicketLinkedBranch, resolveRepoExecutionPath,
  validateReviewCheckoutCorrelationEvidence, type DeploymentStatus, type LinkedBranch,
  type ProcessFingerprint, type ReadOnlyHelperCapability, type ReadOnlyHelperRole,
  type RepositoryMutationLease, type ReviewCheckoutCorrelationEvidence, type ReviewCheckoutEvidence, type Ticket,
} from "@pa-platform/pa-core";
import { readPiProcessIdentity } from "./process-identity.js";
import { TreehouseClient } from "./treehouse.js";

/** Public identity only; reservation capabilities never enter plan, env or registry. */
export function piReviewCheckoutCorrelation(checkout: ReviewCheckoutEvidence): ReviewCheckoutCorrelationEvidence {
  const { repositoryGitDir: _git, repositoryGitCommonDir: _common, gitSnapshot: _snapshot, ...identity } = checkout;
  return validateReviewCheckoutCorrelationEvidence(identity);
}

export function readReviewCandidateTicket(ticketId: string): Pick<Ticket, "id" | "project" | "linkedBranches"> {
  try {
    const path = join(getTicketsDir(), `${ticketId}.json`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.size > 1024 * 1024) throw new Error("invalid ticket file");
    const bytes = readFileSync(path);
    if (bytes.length > 1024 * 1024) throw new Error("oversized ticket");
    const row: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid ticket");
    const value = row as Record<string, unknown>;
    if (value["id"] !== ticketId || typeof value["project"] !== "string" || !Array.isArray(value["linkedBranches"])) throw new Error("invalid ticket binding");
    // Do not normalize malformed/legacy state or silently synthesize headSha from sha.
    const linkedBranches = value["linkedBranches"].map((entry: unknown): LinkedBranch => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid link");
      const branch = entry as Record<string, unknown>;
      if (typeof branch["repo"] !== "string" || typeof branch["branch"] !== "string"
        || (branch["state"] !== "planned" && branch["state"] !== "materialized")
        || ["baseSha", "headSha", "sha"].some((key) => branch[key] !== undefined && typeof branch[key] !== "string")) throw new Error("invalid link fields");
      return { repo: branch["repo"], branch: branch["branch"], state: branch["state"],
        ...(typeof branch["baseSha"] === "string" ? { baseSha: branch["baseSha"] } : {}),
        ...(typeof branch["headSha"] === "string" ? { headSha: branch["headSha"] } : {}),
        ...(typeof branch["sha"] === "string" ? { sha: branch["sha"] } : {}), linkedAt: "", linkedBy: "" };
    });
    return { id: ticketId, project: value["project"], linkedBranches };
  } catch { throw reviewCandidateError("bounded durable ticket read", "exact physical ticket file and explicit linked-branch evidence are absent or malformed"); }
}

export function reviewCandidateError(source: string, reason: string): Error {
  return new Error(formatBoundedFiveFieldDiagnostic({
    condition: "review-auto existing candidate selection stopped", source, reason,
    correction: "preserve repository, ticket, and Treehouse lease state; reconcile blocking evidence outside this read-only launch",
    resumeAction: "retry the exact authorized candidate only after fresh matching evidence; perform no repair",
  }));
}

export interface PiReadonlyHelperDependencies {
  /** Trusted test seams only. No request/environment can supply these functions. */
  readonly treehouse?: TreehouseClient;
  readonly queryRegistry?: typeof queryReadonlyHelperRegistry;
  readonly getProcessFingerprint?: typeof readProcessFingerprint;
  readonly isProcessInLineage?: typeof processIsWithinFingerprintLineage;
}

/** Observes existing admission/custody only; never calls deployment or mutation admission. */
export function createPiReadonlyHelperCapability(dependencies: PiReadonlyHelperDependencies = {}): ReadOnlyHelperCapability {
  return { authenticate: (cwd) => {
    const read = () => {
      const reject = (reason: string): never => { throw new ReadOnlyHelperFailure("authority-rejected", "unknown", "live protected PPA helper context", reason); };
      try {
        if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].some((key) => process.env[key] !== undefined)) reject("ambient Git overrides are not helper identity evidence");
        const id = process.env["PA_DEPLOYMENT_ID"];
        if (!id || !/^d-[0-9a-f]{6}$/.test(id)) reject("missing or malformed deployment locator");
        const registryObservations: unknown[] = [];
        const query: typeof queryReadonlyHelperRegistry = (...args) => {
          const observed = (dependencies.queryRegistry ?? queryReadonlyHelperRegistry)(...args);
          registryObservations.push(observed);
          return observed;
        };
        const status = query(id!).status;
        if (!status || status.deploy_id !== id || status.status !== "running" || status.runtime !== "pi" || status.binary !== "ppa" || !status.pid) reject("deployment is missing, ended, or not live PPA");
        const live = status!;
        const directory = getDeployPaths(id!).deployDir;
        if (process.env["PA_DEPLOYMENT_DIR"] !== directory || process.env["PA_TEAM"] !== live.team || process.env["PA_MODE"] !== live.mode
          || process.env["PA_TICKET_ID"] !== live.ticket_id || process.env["PA_REPO"] !== cwd || process.env["PA_WORKTREE_ROOT"] !== cwd) reject("inherited locators disagree with protected registry identity");
        if (!live.ticket_id || !isCanonicalTicketId(live.ticket_id)) reject("exact ticket is missing");
        const ticketId = live.ticket_id!;
        const physical = resolveRepoExecutionPath(undefined, cwd, { allowLinkedWorktreeCwd: true });
        if (physical.worktreeKind !== "linked" || physical.worktreeRoot !== cwd || live.repo !== cwd || live.worktree_root !== cwd || live.repo_root !== physical.repoRoot) reject("crossed canonical/runtime domains or wrong physical worktree");
        const getFingerprint = dependencies.getProcessFingerprint ?? readProcessFingerprint;
        const fingerprintEqual = (left: ProcessFingerprint, right: ProcessFingerprint | undefined) => Boolean(right && left.pid === right.pid && left.startTimeTicks === right.startTimeTicks && left.bootId === right.bootId);
        const inLineage = dependencies.isProcessInLineage ?? processIsWithinFingerprintLineage;
        const processObservations: ProcessFingerprint[] = [];
        const readLaunchProcess = (registry: DeploymentStatus): ProcessFingerprint => {
          const anchor = readPiProcessIdentity(registry.deploy_id, getDeployPaths(registry.deploy_id).deployDir);
          if (anchor.pid !== registry.pid || !fingerprintEqual(anchor, getFingerprint(anchor.pid))) return reject("recorded Pi-child process incarnation disagrees with live registry evidence");
          processObservations.push(anchor);
          return anchor;
        };
        let role: ReadOnlyHelperRole;
        if (live.team === "builder" && live.mode === "orchestrator" && live.builder_authority === "orchestrator") role = "orchestrator";
        else if (live.team === "builder" && live.mode === "implement" && live.builder_authority === "parented-implement") role = "parented-implement";
        else if (live.team === "builder" && live.mode === "implement" && live.builder_authority === "standalone-implement") role = "standalone-implement";
        else if (live.team === "builder" && live.mode === "worker" && !live.builder_authority && !live.parent_deployment_id) role = "worker-consistency-only";
        else if (live.team === "requirements" && live.mode === "review-auto" && !live.builder_authority && !live.parent_deployment_id) role = "review-auto";
        else return reject("mode has no authenticated-worktree read-only helper role");
        // Registry PID names the Pi child, not the launcher/supervisor recorded
        // in owner/borrower custody. Require its historical incarnation for every
        // role, then independently bind builder custody to that child's ancestry.
        const fingerprint = readLaunchProcess(live);
        if (!inLineage(process.pid, fingerprint)) reject("helper is not within the recorded live deployment process incarnation/lineage (stale/replayed locator)");
        const authority = (() => {
          try { return observeReadonlyRepositoryAuthority(physical.gitDir); }
          catch { return reject("protected-authority-evidence: owner/borrower/review evidence or complete snapshot is malformed or unavailable"); }
        })();
        const lease = (dependencies.treehouse ?? new TreehouseClient()).authenticatePrepared(physical.repoRoot, physical.repoKey, ticketId, cwd);
        const ticket = readReviewCandidateTicket(ticketId);
        const linked = requireTicketLinkedBranch(ticket, physical.repoKey);
        if (ticket.project !== physical.repoKey || linked.state !== "materialized" || !/^[0-9a-f]{40}$/.test(linked.baseSha ?? "") || !/^[0-9a-f]{40}$/.test(linked.headSha ?? "")) reject("durable materialized ticket branch evidence is incomplete or wrong-project");
        const validateOwner = (owner: RepositoryMutationLease, slot: "orchestrator" | "implement") => {
          const registry = query(owner.deploymentId).status;
          if (!registry || registry.status !== "running" || registry.team !== "builder" || registry.mode !== owner.mode || registry.runtime !== "pi" || registry.binary !== "ppa") return reject("owner-registry-role: owner registry is missing, ended, or has a mismatched runtime/team/mode");
          if (registry.ticket_id !== ticketId || registry.repo !== cwd || registry.worktree_root !== cwd || registry.repo_root !== physical.repoRoot
            || registry.builder_authority !== (slot === "orchestrator" ? "orchestrator" : "standalone-implement")) return reject("owner-registry-binding: owner ticket, repository, or authority role disagrees");
          if (registry.treehouse_path !== cwd || registry.treehouse_lease_id !== lease.leaseId || registry.treehouse_lease_holder !== lease.leaseHolder
            || registry.branch_state !== "materialized" || registry.branch_base_sha !== linked.baseSha) return reject("owner-checkout-binding: owner lease or materialized branch/base disagrees");
          if (owner.canonicalRepoKey !== physical.repoKey || owner.canonicalRepoRoot !== physical.repoRoot || owner.worktreeRoot !== cwd
            || owner.repositoryGitDir !== physical.gitDir || owner.repositoryGitCommonDir !== physical.gitCommonDir || owner.slot !== slot || owner.ticket !== ticketId
            || owner.runtime !== "pi" || owner.team !== "builder" || owner.mode !== slot || owner.deploymentDirectory !== getDeployPaths(owner.deploymentId).deployDir) return reject("owner-physical-role: protected owner physical identity, ticket, directory, or role disagrees");
          // The read-only protected parser has already validated both snapshots.
          // Current projection follows finalized authority, not immutable launch
          // history. A present invalid snapshot rejects there; never accept either HEAD.
          const currentAuthority = owner.authorityGitSnapshot ?? owner.preLaunchGitSnapshot;
          if (registry.branch_head_sha !== currentAuthority.head) return reject("owner-current-head: registry projection differs from protected current authority snapshot");
          if (!fingerprintEqual(owner.processFingerprint, getFingerprint(owner.processFingerprint.pid))) return reject("owner-process-incarnation: owner launcher/supervisor fingerprint is stale");
          const ownerPi = readLaunchProcess(registry);
          if (!inLineage(ownerPi.pid, owner.processFingerprint)) return reject("owner-process-lineage: recorded owner Pi child is outside its live launcher/supervisor custody");
          return registry;
        };
        let capacityIdentity: string | undefined;
        let claimIdentity: string | undefined;
        if (role === "review-auto") {
          const reservation = authority.review;
          if (!reservation || authority.implement || authority.borrower || reservation.deploymentId !== id || !live.review_checkout) return reject("review requires its exact protected reservation and idle custody, not builder authority");
          const review = reservation!;
          const checkout = review.checkout;
          if (checkout.repoKey !== physical.repoKey || checkout.repoRoot !== physical.repoRoot || checkout.worktreeRoot !== cwd || checkout.repositoryGitDir !== physical.gitDir
            || checkout.repositoryGitCommonDir !== physical.gitCommonDir || checkout.ticket !== ticketId || checkout.leaseId !== lease.leaseId || checkout.leaseHolder !== lease.leaseHolder
            || checkout.branch !== linked.branch || checkout.baseSha !== linked.baseSha || checkout.featureSha !== linked.headSha
            || JSON.stringify(piReviewCheckoutCorrelation(checkout)) !== JSON.stringify(validateReviewCheckoutCorrelationEvidence({ ...live.review_checkout }))) reject("review candidate/registry/lease/ticket correlation mismatch");
          const claim = query(id!, review.authorizationId).claim;
          if (!claim || !claim.active || claim.deploymentId !== id || claim.ticketId !== ticketId || claim.branch !== checkout.branch || claim.featureSha !== checkout.featureSha
            || claim.authorizationId !== review.authorizationId || !checkout.approvedReference
            || claim.matrixSource !== checkout.approvedReference.matrixSource || claim.matrixAuthoritySha256 !== checkout.approvedReference.matrixAuthoritySha256
            || claim.matrixApprovalEvidence !== checkout.approvedReference.matrixApprovalEvidence) return reject("review authorization is absent, consumed by another deployment, or drifted");
          claimIdentity = JSON.stringify(claim);
          if (authority.owner) {
            validateOwner(authority.owner, "orchestrator");
            if (!repositoryGitSnapshotsEqual(authority.owner.authorityGitSnapshot ?? authority.owner.preLaunchGitSnapshot, checkout.gitSnapshot)) reject("review custody snapshot differs from candidate");
          }
        } else if (role === "worker-consistency-only") {
          if (authority.implement || authority.borrower || authority.review) reject("worker consistency reads cannot borrow implement or reviewer authority");
          if (live.branch_state !== "materialized" || live.branch_base_sha !== linked.baseSha || live.branch_head_sha !== linked.headSha) reject("worker selected branch result does not match durable ticket evidence");
          if (authority.owner) validateOwner(authority.owner, "orchestrator");
        } else {
          if (authority.review || (authority.owner && authority.implement)) reject("ambiguous builder/review authority");
          const parented = role === "parented-implement";
          const owner = role === "standalone-implement" ? authority.implement : authority.owner;
          if (!owner || (role === "standalone-implement" && (authority.owner || authority.borrower))) reject("required sole observational owner is missing or borrower conflicts");
          const ownerRegistry = validateOwner(owner!, role === "standalone-implement" ? "implement" : "orchestrator");
          const borrower = authority.borrower;
          if (parented && !borrower) reject("direct borrower evidence is missing");
          if (borrower) {
            const child = query(borrower.deploymentId).status;
            if (!child || child.status !== "running" || child.team !== "builder" || child.mode !== "implement" || child.runtime !== "pi" || child.binary !== "ppa"
              || child.builder_authority !== "parented-implement" || child.parent_deployment_id !== owner!.deploymentId
              || child.repo !== cwd || child.worktree_root !== cwd || child.repo_root !== physical.repoRoot || child.ticket_id !== ticketId
              || child.treehouse_path !== cwd || child.treehouse_lease_id !== lease.leaseId || child.treehouse_lease_holder !== lease.leaseHolder
              || child.branch_state !== "materialized" || child.branch_base_sha !== linked.baseSha
              || child.ticket_slot_id !== live.ticket_slot_id || child.repository_permit !== live.repository_permit
              || authority.implement || borrower.finalizationState || borrower.finalizedAt || borrower.finalGitSnapshot || borrower.deploymentId === borrower.parentDeploymentId
              || borrower.parentDeploymentId !== owner!.deploymentId || borrower.deploymentDirectory !== getDeployPaths(borrower.deploymentId).deployDir
              || borrower.canonicalRepoKey !== physical.repoKey || borrower.canonicalRepoRoot !== physical.repoRoot || borrower.worktreeRoot !== cwd
              || borrower.ticket !== ticketId || borrower.branch !== linked.branch || borrower.launchGitSnapshot.branch !== linked.branch || borrower.launchGitSnapshot.head !== child.branch_head_sha
              || !fingerprintEqual(borrower.processFingerprint, getFingerprint(borrower.processFingerprint.pid)) || !fingerprintEqual(borrower.parentProcessFingerprint, owner!.processFingerprint)
              || (parented && (borrower.deploymentId !== id || borrower.parentDeploymentId !== live.parent_deployment_id))) return reject("direct borrower evidence is replayed, finalized, or mismatched");
            const borrowerPi = readLaunchProcess(child);
            if (!inLineage(borrowerPi.pid, borrower.processFingerprint)
              || (parented && !fingerprintEqual(borrowerPi, fingerprint))) reject("recorded borrower Pi child is outside its live launcher/supervisor custody");
          }
          if (!parented && (owner!.deploymentId !== id || live.parent_deployment_id || ownerRegistry.pid !== fingerprint.pid)) reject("sole owner does not match executing deployment");
          const observed = observeReadonlyRepositoryTicketSlot(physical.repoRoot, ticketId, getFingerprint);
          const slot = observed.slot;
          if (slot.canonicalRepoKey !== physical.repoKey || slot.canonicalRepoRoot !== physical.repoRoot || slot.ticket !== ticketId || slot.deploymentId !== owner!.deploymentId
            || slot.deploymentDirectory !== owner!.deploymentDirectory || !fingerprintEqual(slot.processFingerprint, owner!.processFingerprint)
            || slot.slotId !== live.ticket_slot_id || slot.repositoryPermit !== live.repository_permit || slot.slotId !== ownerRegistry.ticket_slot_id || slot.repositoryPermit !== ownerRegistry.repository_permit) reject("durable capacity/lineage correlation mismatch");
          capacityIdentity = observed.identity;
          for (const registry of [live, ownerRegistry]) {
            if (registry.treehouse_path !== cwd || registry.treehouse_lease_id !== lease.leaseId || registry.treehouse_lease_holder !== lease.leaseHolder
              || registry.branch_state !== "materialized" || registry.branch_base_sha !== linked.baseSha) reject("protected checkout/lease/branch result mismatch");
          }
          if ((owner!.authorityGitSnapshot ?? owner!.preLaunchGitSnapshot).branch !== linked.branch) reject("persisted materialized owner branch result is missing");
        }
        // After role authentication, capture only read-only Git state and bind it to the immediate reread.
        const snapshot = captureRepositoryGitSnapshot(cwd, (args, gitCwd) => {
          try { return execFileSync("git", ["--no-optional-locks", ...args], {
            cwd: gitCwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
          }); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReadOnlyHelperFailure("command-unavailable", "unknown", "bounded helper Git command", "required Git executable is unavailable; this does not prove implementation launch failure");
            throw error;
          }
        });
        if (snapshot.branch !== linked.branch || ((role === "review-auto" || role === "worker-consistency-only") && snapshot.head !== linked.headSha)
          || (role === "orchestrator" && !authority.borrower && snapshot.head !== (authority.owner!.authorityGitSnapshot ?? authority.owner!.preLaunchGitSnapshot).head)) reject("current branch/Feature SHA differs from authenticated role binding");
        if (role === "review-auto" && !repositoryGitSnapshotsEqual(snapshot, authority.review!.checkout.gitSnapshot)) reject("review candidate HEAD or complete clean status drifted");
        const context = Object.freeze({ ...physical, access: "read-only" as const, role, deploymentId: id!, ticket: ticketId });
        const identity = createHash("sha256").update(JSON.stringify({ context, registryObservations, processObservations, fingerprint, lease, linked, authority: authority.identity, capacityIdentity, claimIdentity, snapshot })).digest("hex");
        return { context, identity };
      } catch (error) {
        if (error instanceof ReadOnlyHelperFailure) throw error;
        if (error instanceof Error && ["ENOENT", "COMMAND_UNAVAILABLE"].includes((error.cause as NodeJS.ErrnoException | undefined)?.code ?? "")) {
          throw new ReadOnlyHelperFailure("command-unavailable", "unknown", "bounded helper evidence command", "required evidence executable is unavailable; do not infer implementation launch state or cancel feature work");
        }
        // Never echo raw protected parser/subprocess errors or tokens.
        return reject("bounded physical, registry, process, ticket, lease, or role evidence is unavailable/malformed");
      }
    };
    const initial = read();
    return Object.freeze({ context: initial.context, reread: () => {
      if (read().identity !== initial.identity) throw new ReadOnlyHelperFailure("authority-rejected", "unknown", "immediate helper reread", "authenticated context, evidence or complete Git snapshot drifted; perform no substantive helper access");
    } });
  } };
}
