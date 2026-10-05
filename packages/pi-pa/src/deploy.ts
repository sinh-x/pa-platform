import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PA_PI_EXECUTION_MODE_ENV, acquireRepositoryMutationLease, acquireRepositoryTicketSlot, advanceParentAuthoritySnapshot, appendActivityEvent, assertRepositoryGitIdentity, authenticateRepositoryMutationLease, authenticateRepositoryTicketSlot, captureRepositoryGitSnapshot, classifyRepositoryAccess, createActivityEvent, emitCompletedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir, ensureTerminalRegistryMarker, finalizeRepositoryMutationBorrower, finalizeRepositoryMutationLease, formatBoundedFiveFieldDiagnostic, formatDirtyBackgroundBuilderDiagnostic, formatRepositoryBorrowerDiagnostic, generatePrimer, getDeployPaths, getTicketsDir, inspectRepositoryMutationBorrower, inspectRepositoryMutationLease, isRogueOneTeam, loadTeamConfig, materializeTicketBranch, normalizeRogueOneDeployRequest, readProcessFingerprint, requireTicketLinkedBranch, queryDeploymentStatus, getDeploymentEvents, repositoryMutationLeasePath, repositoryMutationBorrowerPath, reconcileTerminalRegistryEvent, refreshTicketLinkedBranchHead, registerRepositoryMutationBorrower, releaseRepositoryTicketSlot, renderEnvVarsBlock, repositoryDirtyBorrowApprovalPath, repositoryGitSnapshotsEqual, resolveDeployTimeoutSeconds, resolveExecutionPlan, resolveRepoExecutionPath, resolveRuntimeConfig, rogueOneAuditNotice, rogueOneModeWarning, updateRepositoryMutationLeaseGitSnapshot, withAuthoritativeRepositoryAdmission, type CoreExecutionHooks, type DeployDiagnostics, type DeployRequest, type ExecutionPlan, type PaEnvKey, type ProcessFingerprint, type Rating, type RegistryEvent, TicketStore, type RepositoryTicketSlotHandoff, type RuntimeAdapter, type SessionCommandBuilder, type TeamConfig, type TicketWorktreeSelectionEvidence, type TreehouseLaunchEvidence } from "@pa-platform/pa-core";
import { PI_PARENT_LEASE_CAPABILITY_ENV, PiAdapter, assertPiExecutionRootAgreement, normalizePiEvent, redactPiProtectedReviewPrimer, type PiSupervisionHandle } from "./adapter.js";
import { environmentSecrets, PiRedactionAudit } from "./diagnostics.js";
import { normalizePiRuntimeConfig, PI_DEFAULT_MODEL, PI_DEFAULT_PROVIDER, resolvePiRuntimeConfig } from "./runtime-normalization.js";
import { clearPiForegroundCompletion, ensurePiTerminalStatus, readPiForegroundCompletion, writePiTerminalStatus, type PiForegroundCompletion } from "./terminal-status.js";
import { TreehouseClient } from "./treehouse.js";
import { createPiProtectedValidationLaunch, isPiProtectedReviewRequest } from "./validation-launch.js";
import type { PiProtectedValidationLaunch } from "./validation-supervisor.js";

export const piSessionCommand: SessionCommandBuilder = ({ model, prompt, sessionId, env, session }) => {
  const normalized = normalizePiRuntimeConfig(env?.["PA_PROVIDER"] ?? PI_DEFAULT_PROVIDER, model ?? env?.["PA_MODEL"] ?? PI_DEFAULT_MODEL);
  const args = ["--print", "--mode", "json", "--session-id", sessionId ?? session.id];
  if (normalized.model) args.push("--model", normalized.model);
  if (normalized.provider) args.push("--provider", normalized.provider);
  args.push(prompt);
  return { binary: "pi", args };
};

export interface PiDeployDependencies {
  readonly treehouse?: TreehouseClient;
  readonly getProcessFingerprint?: (pid: number) => ProcessFingerprint | undefined;
  readonly queryParentDeploymentStatus?: typeof queryDeploymentStatus;
  readonly observeOperation?: (operation: "checkout" | "branch" | "slot" | "permit" | "lineage" | "runtime-spawn") => void;
}

export type { TicketWorktreeSelectionEvidence } from "@pa-platform/pa-core";
const TICKET_WORKTREE_SELECTION_FILE = "ticket-worktree-selection.json";

/** Read-only selection and a closure that re-reads all authoritative sources.
 * No ticket refresh, force recovery, capacity claim, or builder borrowing occurs.
 */
export function authenticateTicketWorktreeSelection(
  request: DeployRequest,
  mode: string,
  cwd = process.cwd(),
  dependencies: PiDeployDependencies = {},
  expectedTeam?: string,
): { readonly evidence: TicketWorktreeSelectionEvidence; readonly reread: () => void } {
  const treehouse = dependencies.treehouse ?? new TreehouseClient();
  const read = (): { team: string; evidence: TicketWorktreeSelectionEvidence; holders: readonly (string | undefined)[] } => {
    try {
      const resolvedTeam = loadTeamConfig(request.team).name;
      // Bind admission to the immutable plan's resolved identity, not its filename
      // selector. The closure also detects same-access identity drift on rereads.
      if (expectedTeam !== undefined && resolvedTeam !== expectedTeam) {
        throw new Error("resolved team identity changed from the immutable planning config");
      }
      if (!request.ticket || !/^[A-Z]+-\d+$/.test(request.ticket)
        || resolvedTeam === "builder" || classifyRepositoryAccess(resolvedTeam, mode) === "exclusive-builder"
        || (request.invocationChannel !== undefined && request.invocationChannel !== "cli")) {
        throw new Error("selection requires an exact ticket and a non-builder CLI request");
      }
      const canonical = resolveRepoExecutionPath(request.repo, cwd);
      const ticket = new TicketStore().get(request.ticket);
      if (!ticket || ticket.id !== request.ticket) throw new Error("the exact durable ticket is missing or mismatched");
      // TicketStore intentionally normalizes legacy sha/state for builder flows.
      // Selection must not mistake that compatibility view for an explicit full
      // materialized record, or conceal a conflicting legacy sha.
      const raw: unknown = JSON.parse(readFileSync(resolve(getTicketsDir(), `${request.ticket}.json`), "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ticket record is malformed");
      const branches = (raw as Record<string, unknown>)["linkedBranches"];
      const matches = Array.isArray(branches) ? branches.filter((value: unknown): value is Record<string, unknown> =>
        Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>)["repo"] === canonical.repoKey)) : [];
      const record = matches[0];
      if (matches.length !== 1 || !record || record["state"] !== "materialized"
        || typeof record["baseSha"] !== "string" || !/^[0-9a-f]{40}$/.test(record["baseSha"])
        || typeof record["headSha"] !== "string" || !/^[0-9a-f]{40}$/.test(record["headSha"])
        || (record["sha"] !== undefined && record["sha"] !== record["headSha"])) {
        throw new Error("selection requires exactly one explicit materialized ticket link with full lowercase baseSha/headSha and no conflicting legacy sha");
      }
      const linked = requireTicketLinkedBranch(ticket, canonical.repoKey);
      if ((raw as Record<string, unknown>)["id"] !== ticket.id || (raw as Record<string, unknown>)["project"] !== ticket.project
        || record["branch"] !== linked.branch || record["baseSha"] !== linked.baseSha || record["headSha"] !== linked.headSha) {
        throw new Error("durable ticket identity or branch tuple changed during selection");
      }
      if (linked.state !== "materialized" || !/^[0-9a-f]{40}$/.test(linked.baseSha ?? "") || !/^[0-9a-f]{40}$/.test(linked.headSha ?? "")) {
        throw new Error("selection requires one materialized ticket link with full lowercase baseSha and headSha; planned or legacy-incomplete evidence is ineligible");
      }
      const lease = treehouse.selectExisting(canonical.repoRoot, canonical.repoKey, request.ticket);
      // Reuse the resolver's forward/reverse .git, commondir and membership checks.
      const selected = resolveRepoExecutionPath(undefined, lease.path, { allowLinkedWorktreeCwd: true });
      if (selected.repoKey !== canonical.repoKey || selected.repoRoot !== canonical.repoRoot
        || selected.worktreeKind !== "linked" || selected.worktreeRoot !== lease.path
        || selected.repositoryCwd !== lease.path || selected.gitCommonDir !== canonical.gitCommonDir
        || dirname(selected.gitDir) !== resolve(canonical.gitCommonDir, "worktrees")) {
        throw new Error("selected lease path is not the exact physical registered linked worktree of the canonical repository");
      }
      for (const field of ["gitdir", "commondir"]) {
        const metadata = lstatSync(resolve(selected.gitDir, field));
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("linked Git registration metadata is not an exact physical file");
      }
      const registered = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
        cwd: canonical.repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_DIR: canonical.gitDir, GIT_COMMON_DIR: canonical.gitCommonDir, GIT_WORK_TREE: canonical.repoRoot },
      }).split("\0").filter((field) => field === `worktree ${lease.path}`);
      if (registered.length !== 1) throw new Error("selected checkout does not have exactly one canonical Git worktree registration");
      const snapshot = captureRepositoryGitSnapshot(lease.path, (args, gitCwd) => execFileSync("git", [...args], {
        cwd: gitCwd, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_DIR: selected.gitDir, GIT_COMMON_DIR: selected.gitCommonDir, GIT_WORK_TREE: lease.path },
      }), { repositoryGitDir: selected.gitDir, repositoryGitCommonDir: selected.gitCommonDir });
      if (snapshot.branch !== linked.branch || snapshot.head !== linked.headSha) {
        throw new Error("selected Git branch/HEAD does not equal the materialized ticket record; selection never refreshes ticket evidence");
      }
      const evidence = Object.freeze({
        repoKey: canonical.repoKey, repoRoot: canonical.repoRoot, ticket: request.ticket,
        worktreeRoot: lease.path, gitDir: selected.gitDir, gitCommonDir: selected.gitCommonDir,
        leaseId: lease.leaseId, leaseHolder: lease.leaseHolder,
        branch: linked.branch, baseSha: linked.baseSha!, headSha: linked.headSha!,
      });
      if (request.resume) authenticateTicketWorktreeResume(request.resume, evidence);
      return { team: resolvedTeam, evidence, holders: inspectTicketWorktreeBuilders(evidence, resolvedTeam, mode, dependencies) };
    } catch (error) {
      throw new Error(ticketWorktreeDiagnostic(error));
    }
  };
  const initial = read();
  return Object.freeze({ evidence: initial.evidence, reread: () => {
    const current = read();
    if (JSON.stringify(current) !== JSON.stringify(initial)) {
      throw new Error(ticketWorktreeDiagnostic("canonical repository, ticket, lease, physical Git identity or builder evidence changed after selection"));
    }
  } });
}

function inspectTicketWorktreeBuilders(
  evidence: TicketWorktreeSelectionEvidence,
  team: string,
  mode: string,
  dependencies: PiDeployDependencies,
): readonly (string | undefined)[] {
  const inspectionDependencies = {
    getProcessFingerprint: dependencies.getProcessFingerprint ?? readProcessFingerprint,
    worktreeRoot: evidence.worktreeRoot, repositoryGitDir: evidence.gitDir,
  };
  // lstat distinguishes true absence from dangling/aliased authority entries.
  // This selection-only check never repairs evidence or changes builder recovery.
  const evidencePresent = (path: string): boolean => {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("builder evidence metadata is unreadable");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o444) === 0 || stat.size > 16_384) {
      throw new Error("builder evidence entry is not a readable bounded physical file");
    }
    // Prove readability before the compatibility inspectors (which can mask IO failure).
    readFileSync(path);
    return true;
  };
  const ownerPresence = (["orchestrator", "implement"] as const).map((slot) => evidencePresent(repositoryMutationLeasePath(evidence.worktreeRoot, slot)));
  const borrowerPresence = evidencePresent(repositoryMutationBorrowerPath(evidence.worktreeRoot));
  const owners = (["orchestrator", "implement"] as const).map((slot) =>
    inspectRepositoryMutationLease(evidence.repoRoot, { ...inspectionDependencies, slot }));
  const borrower = inspectRepositoryMutationBorrower(evidence.repoRoot, inspectionDependencies);
  const query = dependencies.queryParentDeploymentStatus ?? queryDeploymentStatus;
  const matchesRegistry = (id: string, holderMode: string, runtime: string): boolean => {
    const status = query(id);
    return status?.deploy_id === id && status.status === "running" && status.team === "builder" && status.mode === holderMode && status.runtime === runtime
      && status.repo_root === evidence.repoRoot && status.worktree_root === evidence.worktreeRoot
      && status.repo === evidence.worktreeRoot && status.ticket_id === evidence.ticket;
  };
  for (const [index, owner] of owners.entries()) {
    if (owner.state === "absent") {
      if (ownerPresence[index]) throw new Error("builder owner evidence disappeared or became unreadable during inspection");
      continue;
    }
    const lease = owner.lease;
    if (owner.state !== "live" || !lease || lease.team !== "builder"
      || lease.canonicalRepoKey !== evidence.repoKey || lease.canonicalRepoRoot !== evidence.repoRoot
      || lease.worktreeRoot !== evidence.worktreeRoot || lease.slot !== (["orchestrator", "implement"] as const)[index]
      || (lease.repositoryGitDir !== undefined && lease.repositoryGitDir !== evidence.gitDir)
      || (lease.repositoryGitCommonDir !== undefined && lease.repositoryGitCommonDir !== evidence.gitCommonDir)
      || lease.ticket !== evidence.ticket || !matchesRegistry(lease.deploymentId, lease.mode, lease.runtime)) {
      throw new Error("builder owner evidence is stale, malformed, context-conflicting or not registry-running");
    }
  }
  const liveOwners = owners.filter((owner) => owner.state === "live");
  if (liveOwners.length > 1) throw new Error("ambiguous builder owners occupy the selected checkout");
  if (borrower.state === "absent" && borrowerPresence) throw new Error("builder borrower evidence disappeared or became unreadable during inspection");
  if (borrower.state !== "absent") {
    const child = borrower.borrower;
    const parent = owners[0]!.lease;
    if (borrower.state !== "live" || !child || child.finalizationState || child.finalizedAt
      || child.canonicalRepoKey !== evidence.repoKey || child.canonicalRepoRoot !== evidence.repoRoot
      || child.worktreeRoot !== evidence.worktreeRoot || child.ticket !== evidence.ticket || child.branch !== evidence.branch
      || child.deploymentId === child.parentDeploymentId
      || !matchesRegistry(child.deploymentId, "implement", child.runtime) || owners[1]!.state !== "absent"
      || (parent && (child.parentDeploymentId !== parent.deploymentId
        || child.parentProcessFingerprint.pid !== parent.processFingerprint.pid
        || child.parentProcessFingerprint.startTimeTicks !== parent.processFingerprint.startTimeTicks
        || child.parentProcessFingerprint.bootId !== parent.processFingerprint.bootId))) {
      throw new Error("builder borrower evidence is stale, malformed, context-conflicting or ambiguous");
    }
  }
  if ((liveOwners.length > 0 || borrower.state === "live") && classifyRepositoryAccess(team, mode) !== "read-only") {
    throw new Error("non-locking access cannot coexist with a process-verified live builder owner or borrower on the selected checkout");
  }
  // Identities stay inside the reread closure; no protected tokens are projected.
  return Object.freeze([...owners.map((owner) => owner.evidenceIdentity), borrower.evidenceIdentity]);
}

function ticketWorktreeDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  // Preserve one five-field envelope when lower admission layers already format
  // their failure; nesting consumes the bounded reason budget and hides cause.
  const reason = /^Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s.test(detail)
    ? detail.match(/Reason:\s*(.*?)\s*Correction:/s)?.[1] ?? detail
    : detail;
  return formatBoundedFiveFieldDiagnostic({
    condition: "ticket-worktree selection admission stopped",
    source: "registered canonical repository, durable ticket, bounded Treehouse status, physical Git and process-verified builder evidence",
    reason,
    correction: "preserve the checkout, ticket and all authority evidence; selection grants no mutation or return rights",
    resumeAction: "reconcile the exact existing materialized checkout and retry with fresh matching evidence; no allocation or force bypass",
  });
}

export function createPiHooks(adapter: RuntimeAdapter = new PiAdapter(), dependencies: PiDeployDependencies = {}): CoreExecutionHooks { return { deploy: (request, diagnostics) => deployWithPi(request, adapter, diagnostics, dependencies), sessionNormalizer: normalizePiEvent, sessionCommand: piSessionCommand, sessionPreflight: () => adapterPreflight(adapter) }; }
export function createDefaultPiHooks(): CoreExecutionHooks { return createPiHooks(); }

export async function deployWithPi(request: DeployRequest, adapter: RuntimeAdapter = new PiAdapter(), diagnostics?: DeployDiagnostics, dependencies: PiDeployDependencies = {}): Promise<{ status: "pending" | "success" | "failed"; team: string; mode: string | null; deploymentId?: string; reason?: string }> {
  const inheritedAttempt = request.team === "builder" ? inheritedParentContext() : undefined;
  const timeout = resolveDeployTimeoutSeconds({ timeout: request.timeout });
  if ("error" in timeout) {
    const reason = request.ticketWorktree ? ticketWorktreeDiagnostic(timeout.error) : inheritedAttempt ? inheritedAdmissionFailure(timeout.error, request.repo ?? "unknown", process.cwd()) : timeout.error;
    return { status: "failed", team: request.team, mode: request.mode ?? null, reason };
  }
  const deploymentId = `d-${randomBytes(3).toString("hex")}`;
  const rogueModeDiagnostic = rogueOneModeWarning(request.team, request.mode);
  request = normalizeRogueOneDeployRequest(request);
  let team: TeamConfig;
  let mode: ReturnType<typeof selectMode>;
  try {
    team = loadTeamConfig(request.team);
    if (request.ticketWorktree && team.name === "builder") throw new Error("resolved builder team cannot request selection-only intent");
    mode = selectMode(team, isRogueOneTeam(team.name) ? undefined : request.mode);
  } catch (error) {
    if (!request.ticketWorktree) throw error;
    return { status: "failed", team: request.team, mode: request.mode ?? null, reason: ticketWorktreeDiagnostic(error) };
  }
  const deployDir = ensureDeployDir(deploymentId); const paths = getDeployPaths(deploymentId);
  const audit = new PiRedactionAudit(deploymentId, deployDir);
  const observe = (surfaceId: string, value: unknown, configuredEnv: NodeJS.ProcessEnv = process.env): void => { audit.observe(surfaceId, value, environmentSecrets({ ...process.env, ...configuredEnv })); };
  const appendActivity = (event: ReturnType<typeof createActivityEvent>, configuredEnv: NodeJS.ProcessEnv = process.env): void => {
    appendActivityEvent(event, paths.activityLogPath);
    observe("activity", event, configuredEnv);
  };
  let runtimeConfig: ReturnType<typeof resolvePiRuntimeConfig>;
  try {
    runtimeConfig = resolvePiRuntimeConfig(resolveRuntimeConfig({ runtime: "pi", request, team, mode, local: { provider: PI_DEFAULT_PROVIDER, model: PI_DEFAULT_MODEL }, requireCompleteCliPair: true }));
  } catch (error) {
    const rawReason = boundedDiagnostic(error instanceof Error ? error.message : String(error), process.env, 2000);
    const reason = request.ticketWorktree ? ticketWorktreeDiagnostic(rawReason) : inheritedAttempt ? inheritedAdmissionFailure(rawReason, request.repo ?? "unknown", process.cwd()) : rawReason;
    appendActivity(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(reason, process.env, 500) }));
    const summary = boundedDiagnostic(`ppa deploy validation failed: ${reason}`, process.env, 2000);
    emitCompletedEvent({ deploymentId, team: team.name, status: "failed", summary, exitCode: 1 });
    observe("registry-diagnostic", summary);
    const status = terminalStatus("failed", summary);
    ensurePiTerminalStatus(deployDir, status);
    observe("terminal-status", status);
    ensureTerminalRegistryMarker({ deploymentId, team: team.name });
    observe("deploy-diagnostic", reason);
    return { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason };
  }
  const provider = runtimeConfig.provider;
  const model = runtimeConfig.model;
  const requestedEnvironment = paEnv(deploymentId, deployDir, paths.activityLogPath, team, request, provider, model);
  let activeTicketSlot: RepositoryTicketSlotHandoff | undefined;
  let treehouseEvidence: TreehouseLaunchEvidence | undefined;
  let reauthenticateParentBeforeSpawn: (() => void) | undefined;
  let selectedTicketWorktree: ReturnType<typeof authenticateTicketWorktreeSelection> | undefined;
  let parentDurableAuthentication: ParentDurableAuthentication | undefined;
  let planningCwd = process.cwd();
  let planningRequest = request;
  let plan: ExecutionPlan;
  try {
    if (request.resume) {
      const prior = queryDeploymentStatus(request.resume);
      const starts = getDeploymentEvents(request.resume).filter((event) => event.event === "started");
      const selectionPath = resolve(getDeployPaths(request.resume).deployDir, TICKET_WORKTREE_SELECTION_FILE);
      let artifactPresent = false;
      try { lstatSync(selectionPath); artifactPresent = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(ticketWorktreeDiagnostic("prior selection artifact metadata is unreadable"));
      }
      // Legacy branch-only selected records cannot be silently upgraded or used
      // to substitute canonical execution. Ordinary inferred worktrees have no
      // selection branch correlation and remain on their existing resume path.
      const selectedBefore = artifactPresent || prior?.ticket_worktree_selection !== undefined
        || starts.some((event) => event.ticket_worktree_selection !== undefined)
        || (prior?.branch_state !== undefined && !prior.builder_authority && prior.repo_root !== prior.worktree_root);
      if (!prior || starts.length !== 1) throw new Error(ticketWorktreeDiagnostic("prior immutable registry start evidence is missing or ambiguous"));
      if (selectedBefore && !request.ticketWorktree) {
        throw new Error(ticketWorktreeDiagnostic("resuming a ticket-worktree selection requires the same flag and exact ticket"));
      }
    }
    if (request.ticketWorktree) {
      selectedTicketWorktree = authenticateTicketWorktreeSelection(request, mode?.id ?? "default", planningCwd, dependencies, team.name);
      planningCwd = selectedTicketWorktree.evidence.worktreeRoot;
      const { repo: _selector, ...selectionRequest } = request;
      planningRequest = selectionRequest;
    }
    const builderMode = !request.dryRun && team.name === "builder" && mode?.require_ticket === true && Boolean(request.ticket)
      ? mode.id
      : undefined;
    if (builderMode === "orchestrator" || builderMode === "implement") {
      const ticketId = request.ticket!;
      const parent = builderMode === "implement" ? inheritedAttempt : undefined;
      if (parent && request.background !== true) throw new Error(parentAdmissionDiagnostic("a parented implement launch must be direct background mode", "child launch mode"));
      let parentInvocationRepository: ReturnType<typeof resolveRepoExecutionPath> | undefined;
      if (parent) {
        try {
          parentInvocationRepository = resolveRepoExecutionPath(undefined, planningCwd, { allowLinkedWorktreeCwd: true });
        } catch {
          throw new Error(parentAdmissionDiagnostic("the invocation CWD did not authenticate as one registered physical linked worktree", "authenticated invocation CWD", {
            canonicalRoot: "unresolved", parentWorktree: "unresolved", invocationCwd: planningCwd, gitTopLevel: "unresolved", selectorRoot: "unresolved",
          }));
        }
      }
      let selectorRepository: ReturnType<typeof resolveRepoExecutionPath>;
      try {
        selectorRepository = resolveRepoExecutionPath(request.repo, process.cwd(), { allowLinkedWorktreeCwd: request.repo === undefined });
      } catch (error) {
        if (!parent || !parentInvocationRepository) throw error;
        throw new Error(parentAdmissionDiagnostic("the selector did not identify exactly one registered key or exact canonical repository root", "explicit --repo canonical selector", {
          canonicalRoot: parentInvocationRepository.repoRoot, parentWorktree: parentInvocationRepository.worktreeRoot, invocationCwd: planningCwd, gitTopLevel: parentInvocationRepository.worktreeRoot, selectorRoot: "unresolved",
        }));
      }
      const invocationRepository = parentInvocationRepository ?? selectorRepository;
      if (builderMode === "implement") {
        const exactLinkedInvocation = invocationRepository.worktreeKind === "linked" && invocationRepository.worktreeRoot === planningCwd;
        if (!parent && (request.repo !== undefined || !exactLinkedInvocation)) {
          throw new Error(standaloneAdmissionDiagnostic("standalone implement must be launched from the authenticated linked Treehouse CWD; canonical root and explicit --repo inputs are forbidden"));
        }
        if (parent && (!exactLinkedInvocation || selectorRepository.repoKey !== invocationRepository.repoKey || selectorRepository.repoRoot !== invocationRepository.repoRoot)) {
          throw new Error(parentAdmissionDiagnostic(
            "the canonical selector and invocation CWD did not identify the parent's exact registered linked worktree",
            request.repo === undefined ? "authenticated invocation CWD" : "explicit --repo canonical selector",
            { canonicalRoot: invocationRepository.repoRoot, parentWorktree: invocationRepository.worktreeRoot, invocationCwd: planningCwd, gitTopLevel: invocationRepository.worktreeRoot, selectorRoot: selectorRepository.repoRoot },
          ));
        }
      }
      const initialRepository = parent ? invocationRepository : selectorRepository;
      const ticket = new TicketStore().get(ticketId);
      if (!ticket) throw new Error(`Condition: Treehouse ticket checkout admission. Source: durable ticket store. Reason: ticket ${ticketId} does not exist. Correction: restore the exact ticket and linked-branch evidence. Resume Action: retry before Treehouse acquisition.`);
      requireTicketLinkedBranch(ticket, initialRepository.repoKey);
      const ownsTicketSlot = builderMode === "orchestrator" || !parent;
      if (ownsTicketSlot) {
        dependencies.observeOperation?.("slot");
        dependencies.observeOperation?.("permit");
        dependencies.observeOperation?.("lineage");
        const slotAcquisition = acquireRepositoryTicketSlot({
          canonicalRepoKey: initialRepository.repoKey,
          canonicalRepoRoot: initialRepository.repoRoot,
          ticket: ticketId,
          deploymentId,
          deploymentDirectory: deployDir,
          force: request.force,
        });
        if (slotAcquisition.status === "rejected") throw new Error(slotAcquisition.diagnostic);
        activeTicketSlot = {
          canonicalRepoKey: initialRepository.repoKey,
          canonicalRepoRoot: initialRepository.repoRoot,
          ticket: ticketId,
          slotToken: slotAcquisition.slot.slotToken,
          slotId: slotAcquisition.slot.slotId,
          repositoryPermit: slotAcquisition.slot.repositoryPermit,
        };
      }
      const treehouse = dependencies.treehouse ?? new TreehouseClient();
      let lease: ReturnType<TreehouseClient["authenticatePrepared"]>;
      if (builderMode === "orchestrator" && initialRepository.worktreeKind !== "linked") {
        dependencies.observeOperation?.("checkout");
        lease = treehouse.acquireOrReuse(initialRepository.repoRoot, initialRepository.repoKey, ticketId);
      } else if (parent) {
        lease = authenticateParentPreparedTreehouse(treehouse, initialRepository.repoRoot, initialRepository.repoKey, ticketId, planningCwd, "initial Treehouse checkout authentication");
      } else {
        lease = treehouse.authenticatePrepared(initialRepository.repoRoot, initialRepository.repoKey, ticketId, planningCwd);
      }
      const selectedRepository = resolveRepoExecutionPath(undefined, lease.path, { allowLinkedWorktreeCwd: true });
      if (selectedRepository.repoKey !== initialRepository.repoKey || selectedRepository.repoRoot !== initialRepository.repoRoot || selectedRepository.worktreeRoot !== lease.path || selectedRepository.worktreeKind !== "linked") {
        throw new Error("Condition: Treehouse ticket checkout admission. Source: registered physical Git identity. Reason: selected lease path does not authenticate as the exact linked worktree for the canonical repository. Correction: preserve the lease and reconcile path/top-level/Git-dir/common-dir/worktree membership. Resume Action: retry only with the sole matching physical checkout.");
      }
      if (builderMode === "orchestrator") dependencies.observeOperation?.("branch");
      const branchEvidence = builderMode === "orchestrator"
        ? materializeTicketBranch({ canonicalRepoKey: initialRepository.repoKey, canonicalRepoRoot: initialRepository.repoRoot, worktreeRoot: selectedRepository.worktreeRoot, ticketId })
        : parent
          ? authenticateParentTicketBranch(initialRepository.repoKey, selectedRepository.worktreeRoot, ticketId)
          : refreshTicketLinkedBranchHead({ canonicalRepoKey: initialRepository.repoKey, canonicalRepoRoot: initialRepository.repoRoot, worktreeRoot: selectedRepository.worktreeRoot, ticketId });
      const expectedParent = parent ? {
        ticketId, repoKey: initialRepository.repoKey, repoRoot: initialRepository.repoRoot, worktreeRoot: selectedRepository.worktreeRoot,
        leaseId: lease.leaseId, leaseHolder: lease.leaseHolder, branch: branchEvidence.branch,
        baseSha: branchEvidence.baseSha, headSha: branchEvidence.headSha!,
      } : undefined;
      const parentSlot = parent && expectedParent
        ? authenticateParentTreehouse(parent, expectedParent, dependencies.queryParentDeploymentStatus)
        : undefined;
      if (parent && expectedParent && parentSlot) {
        parentDurableAuthentication = authenticateParentDurableAuthority(parent, expectedParent, parentSlot, undefined, dependencies);
        reauthenticateParentBeforeSpawn = () => {
          const rereadLease = authenticateParentPreparedTreehouse(treehouse, expectedParent.repoRoot, expectedParent.repoKey, expectedParent.ticketId, expectedParent.worktreeRoot, "final Treehouse checkout authentication");
          if (rereadLease.path !== expectedParent.worktreeRoot || rereadLease.leaseId !== expectedParent.leaseId || rereadLease.leaseHolder !== expectedParent.leaseHolder) {
            throw new Error(parentAdmissionDiagnostic("Treehouse lease identity changed during the protected reread", "Treehouse status", {
              canonicalRoot: expectedParent.repoRoot, parentWorktree: expectedParent.worktreeRoot, invocationCwd: process.cwd(), gitTopLevel: "unresolved", selectorRoot: initialRepository.repoRoot,
            }));
          }
          const rereadRepository = resolveRepoExecutionPath(undefined, process.cwd(), { allowLinkedWorktreeCwd: true });
          const rereadTicket = new TicketStore().get(expectedParent.ticketId);
          const rereadBranch = rereadTicket ? requireTicketLinkedBranch(rereadTicket, expectedParent.repoKey) : undefined;
          const rereadSnapshot = captureRepositoryGitSnapshot(expectedParent.worktreeRoot);
          if (rereadRepository.repoKey !== expectedParent.repoKey || rereadRepository.repoRoot !== expectedParent.repoRoot
            || rereadRepository.worktreeRoot !== expectedParent.worktreeRoot || rereadRepository.worktreeKind !== "linked"
            || rereadBranch?.state !== "materialized" || rereadBranch.branch !== expectedParent.branch
            || rereadBranch.baseSha !== expectedParent.baseSha || rereadBranch.headSha !== expectedParent.headSha
            || rereadSnapshot.branch !== expectedParent.branch || rereadSnapshot.head !== expectedParent.headSha) {
            throw new Error(parentAdmissionDiagnostic("registered Git, ticket branch, or launch snapshot identity changed during the protected reread", "registered physical Git and durable ticket evidence", {
              canonicalRoot: expectedParent.repoRoot, parentWorktree: expectedParent.worktreeRoot, invocationCwd: process.cwd(), gitTopLevel: rereadRepository.worktreeRoot, selectorRoot: initialRepository.repoRoot,
            }));
          }
          const rereadSlot = authenticateParentTreehouse(parent, expectedParent, dependencies.queryParentDeploymentStatus);
          parentDurableAuthentication = authenticateParentDurableAuthority(parent, expectedParent, rereadSlot, parentDurableAuthentication, dependencies);
        };
      }
      const slotId = activeTicketSlot?.slotId ?? parentSlot!.slotId;
      const repositoryPermit = activeTicketSlot?.repositoryPermit ?? parentSlot!.repositoryPermit;
      treehouseEvidence = Object.freeze({
        authority: builderMode === "orchestrator" ? "orchestrator" : parent ? "parented-implement" : "standalone-implement",
        ...(parent ? { parentDeploymentId: parent.parentDeploymentId } : {}),
        ticket: ticketId,
        path: lease.path,
        leaseId: lease.leaseId,
        leaseHolder: lease.leaseHolder,
        branch: branchEvidence.branch,
        branchState: "materialized",
        ...(branchEvidence.baseSha ? { baseSha: branchEvidence.baseSha } : {}),
        headSha: branchEvidence.headSha!,
        ticketSlotId: slotId,
        repositoryPermit,
      });
      planningCwd = lease.path;
      const { repo: _explicitRepo, ...requestWithoutRepo } = request;
      planningRequest = requestWithoutRepo;
    }
    plan = resolveExecutionPlan({
      request: { ...planningRequest, ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
      teamConfig: team,
      mode,
      runtime: "pi",
      deploymentId,
      deploymentDir: deployDir,
      activityLogPath: paths.activityLogPath,
      environment: requestedEnvironment,
      timeoutSeconds: timeout.timeout,
      trustedExtensionPath: resolve(dirname(fileURLToPath(import.meta.url)), "pi-extension/index.js"),
      cwd: planningCwd,
      allowDirtyInheritedBorrow: Boolean(inheritedAttempt),
      ...(treehouseEvidence ? { treehouse: treehouseEvidence } : {}),
      ...(selectedTicketWorktree ? { ticketWorktreeSelection: selectedTicketWorktree.evidence } : {}),
    });
    assertPiExecutionRootAgreement(plan, plan.environment as Record<string, string>);
  } catch (error) {
    let cleanupFailure: string | undefined;
    if (activeTicketSlot) {
      const cleanup = releaseRepositoryTicketSlot(activeTicketSlot);
      if (cleanup.status === "released" || cleanup.status === "absent") activeTicketSlot = undefined;
      else cleanupFailure = `matching ticket-slot cleanup failed (${cleanup.status})`;
    }
    const raw = `${error instanceof Error ? error.message : String(error)}${cleanupFailure ? `; ${cleanupFailure}` : ""}`;
    const rawReason = boundedDiagnostic(raw, requestedEnvironment, 2000);
    const reason = request.ticketWorktree ? ticketWorktreeDiagnostic(rawReason) : inheritedAttempt ? inheritedAdmissionFailure(rawReason, request.repo ?? "unknown", process.cwd()) : rawReason;
    appendActivity(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(reason, requestedEnvironment, 500) }), requestedEnvironment);
    const summary = boundedDiagnostic(`ppa deploy validation failed: ${reason}`, requestedEnvironment, 2000);
    emitCompletedEvent({ deploymentId, team: team.name, status: "failed", summary, exitCode: 1 });
    observe("registry-diagnostic", summary, requestedEnvironment);
    const status = terminalStatus("failed", summary);
    ensurePiTerminalStatus(deployDir, status);
    observe("terminal-status", status, requestedEnvironment);
    ensureTerminalRegistryMarker({ deploymentId, team: team.name });
    observe("deploy-diagnostic", reason, requestedEnvironment);
    return { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason };
  }
  const env = { ...plan.environment, PA_REPO_KEY: plan.repoKey, [PA_PI_EXECUTION_MODE_ENV]: requestedEnvironment[PA_PI_EXECUTION_MODE_ENV] } as Record<string, string>;
  // A legacy parent shell may still contain this key. Never carry it into the
  // model/tool environment; direct borrowing is authenticated by live process lineage.
  delete env[PI_PARENT_LEASE_CAPABILITY_ENV];
  const primerPath = resolve(deployDir, "primer.md");
  let toolReference: ReturnType<RuntimeAdapter["describeTools"]>;
  try {
    toolReference = adapter.describeTools();
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    if (activeTicketSlot) {
      const cleanup = releaseRepositoryTicketSlot(activeTicketSlot);
      if (cleanup.status === "released" || cleanup.status === "absent") activeTicketSlot = undefined;
      else detail += `; matching ticket-slot cleanup failed (${cleanup.status})`;
    }
    const reason = request.ticketWorktree ? ticketWorktreeDiagnostic(detail) : boundedDiagnostic(detail, env, 2000);
    observe("deploy-diagnostic", reason, env);
    return { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason };
  }
  const writePrimer = (currentPlan: ExecutionPlan, protectedAuthorizationId?: string): void => {
    const primer = generatePrimer({ runtime: "pi", teamConfig: team, mode: currentPlan.mode, objective: currentPlan.userObjectiveOverride, repository: { repoKey: currentPlan.repoKey, repoRoot: currentPlan.repoRoot, worktreeRoot: currentPlan.worktreeRoot }, repositoryAdmission: currentPlan.repositoryAdmission, treehouse: currentPlan.treehouse, ticketWorktreeSelection: currentPlan.ticketWorktreeSelection, toolReference, rogueOne: currentPlan.rogue_one, invocationChannel: currentPlan.invocation_channel, templateVars: { DEPLOY_ID: deploymentId, TEAM_NAME: team.name, TODAY: new Date().toISOString().slice(0, 10), ...(currentPlan.ticket ? { TICKET_ID: currentPlan.ticket } : {}) }, extraInstructions: `<deployment-context>\ndeployment_id: ${deploymentId}\nteam_name: ${team.name}\nmode: ${currentPlan.mode}\nticket_id: ${currentPlan.ticket ?? "none"}\ncwd: ${currentPlan.repositoryCwd}\nrepo: ${currentPlan.repositoryCwd}\nobjective: ${currentPlan.objective}\ntimeout_seconds: ${currentPlan.timeoutSeconds}\n${renderEnvVarsBlock(currentPlan.environment)}\n</deployment-context>` });
    const persistedPrimer = protectedAuthorizationId
      ? redactPiProtectedReviewPrimer(primer, protectedAuthorizationId)
      : primer;
    writeFileSync(primerPath, persistedPrimer, "utf8");
    if (currentPlan.ticketWorktreeSelection) {
      writeFileSync(resolve(deployDir, TICKET_WORKTREE_SELECTION_FILE), JSON.stringify(currentPlan.ticketWorktreeSelection), { flag: "wx" });
    }
    if (protectedAuthorizationId && readFileSync(primerPath, "utf8").includes(protectedAuthorizationId)) {
      throw new Error("protected reviewer persisted primer authorization redaction could not be proven exact");
    }
  };
  process.stdout.write(`Deployment: ${deploymentId}\n`);
  emitResolutionWarning(runtimeConfig, deploymentId, paths.activityLogPath, diagnostics, audit, env);
  emitResolutionWarning({ warning: rogueModeDiagnostic }, deploymentId, paths.activityLogPath, diagnostics, audit, env);
  appendActivity(createActivityEvent({ deployId: deploymentId, kind: "text", source: "pi", body: `Resolved Pi runtime ${provider}/${model}`, metadata: { provider, model, resolution: runtimeConfig.source } }), env);
  if (plan.rogue_one) appendActivity(createActivityEvent({ deployId: deploymentId, kind: "text", source: "pi", body: rogueOneAuditNotice(plan.invocation_channel!), metadata: { rogue_one: true, invocation_channel: plan.invocation_channel, team: plan.team, mode: plan.mode } }), env);
  if (request.dryRun) {
    try { selectedTicketWorktree?.reread(); writePrimer(plan); }
    catch (error) {
      const detail = boundedDiagnostic(error instanceof Error ? error.message : String(error), env, 2000);
      const reason = request.ticketWorktree ? ticketWorktreeDiagnostic(detail) : detail;
      observe("deploy-diagnostic", reason, env);
      return { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason };
    }
    appendActivity(createActivityEvent({ deployId: deploymentId, kind: "text", source: "pi", body: `Dry-run primer generated for ${team.name} using ${provider}/${model}`, metadata: { provider, model } }), env);
    return { status: "pending", team: request.team, mode: request.mode ?? null, deploymentId };
  }
  let activeRepositoryLease: { canonicalRepoRoot: string; worktreeRoot?: string; repositoryGitDir: string; repositoryGitCommonDir: string; slot?: "orchestrator" | "implement"; ownershipToken: string; ticketSlot?: RepositoryTicketSlotHandoff } | undefined;
  let terminalBranchEvidence: { branchState: "materialized"; branchBaseSha?: string; branchHeadSha: string } | undefined;
  let activeRepositoryBorrower: { canonicalRepoRoot: string; worktreeRoot?: string; repositoryGitDir: string; repositoryGitCommonDir: string; borrowerToken: string; parentDeploymentId: string; deploymentId: string; approvedMutationPaths?: string[] } | undefined;
  const finalizeActiveRepositoryAuthority = async (advanceParentAuthority: boolean): Promise<string | undefined> => {
    const failures: string[] = [];
    if (plan.treehouse && plan.ticket) {
      try {
        const refreshed = refreshTicketLinkedBranchHead({ canonicalRepoKey: plan.repoKey, canonicalRepoRoot: plan.repoRoot, worktreeRoot: plan.worktreeRoot, ticketId: plan.ticket });
        terminalBranchEvidence = { branchState: "materialized", ...(refreshed.baseSha ? { branchBaseSha: refreshed.baseSha } : {}), branchHeadSha: refreshed.headSha! };
      } catch (error) {
        failures.push(`ticket head refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const borrowed = activeRepositoryBorrower;
    if (borrowed) {
      const finalization = finalizeRepositoryMutationBorrower({
        canonicalRepoRoot: borrowed.canonicalRepoRoot,
        worktreeRoot: borrowed.worktreeRoot,
        repositoryGitDir: borrowed.repositoryGitDir,
        repositoryGitCommonDir: borrowed.repositoryGitCommonDir,
        borrowerToken: borrowed.borrowerToken,
        deploymentId: borrowed.deploymentId,
        advanceParentAuthority,
        ...(plan.treehouse?.authority === "parented-implement" ? { dependencies: { publishParentAuthoritySnapshot: advanceParentAuthoritySnapshot } } : {}),
      });
      switch (finalization.status) {
        case "finalized": activeRepositoryBorrower = undefined; break;
        case "scope-noncompliant":
          activeRepositoryBorrower = undefined;
          failures.push(formatRepositoryBorrowerDiagnostic({ category: "approved-path-containment", reason: "the complete final Git state contains a path or branch outside Sinh's exact approved scope", canonicalRepoKey: plan.repoKey, canonicalRepoRoot: plan.repoRoot }));
          break;
        case "uncertain-live":
          failures.push(formatRepositoryBorrowerDiagnostic({ category: "uncertain-live", reason: "borrower finalization was withheld because the transferred runner remains live or its death is unverifiable", canonicalRepoKey: plan.repoKey, canonicalRepoRoot: plan.repoRoot }));
          break;
        case "absent":
        case "invalid-evidence":
        case "token-mismatch":
          failures.push(formatRepositoryBorrowerDiagnostic({ category: `finalization-${finalization.status}`, reason: `matching borrower finalization did not complete (${finalization.status})`, canonicalRepoKey: plan.repoKey, canonicalRepoRoot: plan.repoRoot }));
          break;
      }
    }
    const owned = activeRepositoryLease;
    if (owned) {
      const finalization = await finalizeRepositoryMutationLease(owned);
      switch (finalization.status) {
        case "released": activeRepositoryLease = undefined; break;
        case "absent":
        case "invalid-evidence":
        case "token-mismatch":
        case "borrower-live":
        case "borrower-invalid":
        case "transferred":
        case "updated":
          failures.push(formatRepositoryBorrowerDiagnostic({ category: `owner-finalization-${finalization.status}`, reason: finalization.diagnostic ?? `matching parent lease finalization did not release authority (${finalization.status})`, canonicalRepoKey: plan.repoKey, canonicalRepoRoot: plan.repoRoot }));
          break;
      }
    }
    if (activeTicketSlot) {
      const result = releaseRepositoryTicketSlot(activeTicketSlot);
      if (result.status === "released" || result.status === "absent") activeTicketSlot = undefined;
      else failures.push(`Condition: repository ticket concurrency finalization. Source: matching PA ticket slot. Reason: cleanup did not complete (${result.status}). Correction: preserve Treehouse lease and branch. Resume Action: reconcile only the matching slot token before another launch.`);
    }
    return failures.length > 0 ? boundedDiagnostic(failures.join("; "), env, 2000) : undefined;
  };
  const acceptRepositoryAuthorityHandoff = (metadata: Record<string, unknown> | undefined): void => {
    if (activeRepositoryBorrower) {
      if (metadata?.["repositoryBorrowerTransferred"] !== true) throw new Error("runner-readiness: background supervisor did not authenticate repository borrower transfer");
      activeRepositoryBorrower = undefined;
    }
    if (activeRepositoryLease) {
      if (metadata?.["repositoryLeaseTransferred"] !== true) throw new Error("runner-readiness: background supervisor did not authenticate repository ownership transfer");
      if (activeRepositoryLease.ticketSlot) activeTicketSlot = undefined;
      activeRepositoryLease = undefined;
    }
  };
  emitStartedEvent({ deploymentId, team: team.name, mode: plan.mode, ticketWorktreeSelection: plan.ticketWorktreeSelection ? JSON.stringify(plan.ticketWorktreeSelection) : undefined, ...deploymentCorrelation(plan), primer: `deployments/${deploymentId}/primer.md`, agents: plan.rogue_one ? [] : team.agents.map((agent) => agent.name), models: model ? { team: model } : {}, ticketId: plan.ticket, objective: plan.objective, provider, repo: plan.repositoryCwd, repoRoot: plan.repoRoot, worktreeRoot: plan.worktreeRoot, repositorySlot: plan.repositoryAdmission.slot, runtime: "pi", binary: "ppa", resumedFromDeploymentId: request.resume, effectiveTimeoutSeconds: plan.timeoutSeconds, rogueOne: plan.rogue_one, invocationChannel: plan.invocation_channel });
  const writeTerminal = async (kind: "completed" | "crashed", status: "success" | "partial" | "failed", reason: string, exitCode: number, logFile?: string, staged?: { rating?: Rating; fallback?: boolean }): Promise<{ status: "success" | "failed"; reason: string; authorityFailure: boolean }> => {
    const containmentFailure = await finalizeActiveRepositoryAuthority(kind === "completed" && status === "success");
    const safeReason = boundedDiagnostic(containmentFailure ?? reason, env, 2000);
    const resolvedTerminalStatus = containmentFailure ? "failed" : status;
    const consistentExitCode = resolvedTerminalStatus === "failed" ? exitCode || 1 : exitCode;
    const timestamp = new Date().toISOString();
    const requested: RegistryEvent = kind === "completed"
      ? { deployment_id: deploymentId, team: team.name, event: "completed", timestamp, status: resolvedTerminalStatus, summary: safeReason, ...(logFile ? { log_file: logFile } : {}), ...(staged?.rating ? { rating: staged.rating } : {}), ...(staged?.fallback ? { fallback: true } : {}), exit_code: consistentExitCode, ...registryCorrelation(plan, terminalBranchEvidence) }
      : { deployment_id: deploymentId, team: team.name, event: "crashed", timestamp, error: safeReason, exit_code: consistentExitCode, ...registryCorrelation(plan, terminalBranchEvidence) };
    // Reconcile every terminal observation so a later causal failure can replace
    // success/partial while an existing failure remains sticky and exactly once.
    const authoritative = reconcileTerminalRegistryEvent(requested).event;
    observe("registry-diagnostic", authoritative, env);
    const outcome = registryTerminalOutcome(authoritative, env);
    const statusRecord = terminalStatus(outcome.status, outcome.reason, authoritative.timestamp);
    writePiTerminalStatus(deployDir, statusRecord);
    observe("terminal-status", statusRecord, env);
    if (!request.background) clearPiForegroundCompletion(deployDir);
    return { ...outcome, authorityFailure: containmentFailure !== undefined };
  };
  const completeFailure = async (reason: string, exitCode = 1) => {
    const boundedReason = boundedDiagnostic(reason, env, 2000);
    const safeReason = request.ticketWorktree ? ticketWorktreeDiagnostic(boundedReason) : inheritedAttempt ? inheritedAdmissionFailure(boundedReason, plan.repoKey, plan.repoRoot) : boundedReason;
    appendActivity(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(safeReason, env, 500) }), env);
    const outcome = await writeTerminal("completed", "failed", `ppa deploy failed: ${safeReason}`, exitCode);
    const resultReason = outcome.authorityFailure ? outcome.reason : safeReason;
    observe("deploy-diagnostic", resultReason, env);
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: resultReason };
  };
  const crashFailure = async (reason: string) => {
    const boundedReason = boundedDiagnostic(reason, env, 2000);
    const safeReason = request.ticketWorktree ? ticketWorktreeDiagnostic(boundedReason) : inheritedAttempt ? inheritedAdmissionFailure(boundedReason, plan.repoKey, plan.repoRoot) : boundedReason;
    appendActivity(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(safeReason, env, 500) }), env);
    const outcome = await writeTerminal("crashed", "failed", safeReason, 1);
    const resultReason = outcome.authorityFailure ? outcome.reason : safeReason;
    observe("deploy-diagnostic", resultReason, env);
    return { status: "failed" as const, team: request.team, mode: request.mode ?? null, deploymentId, reason: resultReason };
  };
  let protectedValidationLaunch: PiProtectedValidationLaunch | undefined;
  if (isPiProtectedReviewRequest(request, plan)) {
    if (!(adapter instanceof PiAdapter)) {
      return completeFailure("protected Pi review launch requires the production PiAdapter");
    }
    try {
      protectedValidationLaunch = createPiProtectedValidationLaunch({ deploymentId, deploymentDirectory: deployDir, request, plan, environment: env });
    } catch (error) {
      return completeFailure(error instanceof Error ? error.message : String(error));
    }
  }
  let prior: string | undefined;
  if (request.resume) { try { prior = readSession(request.resume, adapter.sessionFileName); } catch (error) { return completeFailure(error instanceof Error ? error.message : String(error)); } }
  const sessionId = prior ?? ("allocateSessionId" in adapter && typeof adapter.allocateSessionId === "function" ? adapter.allocateSessionId() : randomBytes(16).toString("hex"));
  const sessionPath = resolve(deployDir, adapter.sessionFileName);
  try {
    if (!request.background) clearPiForegroundCompletion(deployDir);
    await adapter.installHooks(deployDir, { deploymentId, deploymentDir: deployDir, activityLogPath: paths.activityLogPath, env, executionPlan: plan });
    selectedTicketWorktree?.reread();
    const inheritedParent = inheritedAttempt;
    if (inheritedParent) {
      reauthenticateParentBeforeSpawn?.();
      const plannedSnapshot = plan.repositoryAdmission.gitSnapshot;
      const immediateSnapshot = captureRepositoryGitSnapshot(plan.worktreeRoot);
      if (plannedSnapshot && !repositoryGitSnapshotsEqual(plannedSnapshot, immediateSnapshot)) {
        return completeFailure(formatRepositoryBorrowerDiagnostic({ category: "immediate-reread", reason: "branch, full HEAD, or complete porcelain-v2 status changed after execution planning", canonicalRepoKey: plan.repoKey, canonicalRepoRoot: plan.repoRoot }));
      }
      const branch = immediateSnapshot.branch;
      const registration = registerRepositoryMutationBorrower({
        canonicalRepoKey: plan.repoKey,
        canonicalRepoRoot: plan.repoRoot,
        worktreeRoot: plan.worktreeRoot,
        expectedGitDir: plan.repositoryGitDir,
        expectedGitCommonDir: plan.repositoryGitCommonDir,
        parentDeploymentId: inheritedParent.parentDeploymentId,
        deploymentId,
        deploymentDirectory: deployDir,
        runtime: "pi",
        team: team.name,
        mode: plan.mode,
        launchMode: plan.repositoryAdmission.launchMode,
        ticket: plan.ticket ?? "",
        branch,
        timeoutSeconds: plan.timeoutSeconds,
        expectedGitSnapshot: immediateSnapshot,
        dirtyApprovalPath: repositoryDirtyBorrowApprovalPath(inheritedParent.parentDeploymentDirectory),
        ...(plan.repositoryAdmission.branchTransitionPolicy ? { branchTransitionPolicy: plan.repositoryAdmission.branchTransitionPolicy } : {}),
        force: plan.repositoryAdmission.force,
        dependencies: {
          ...(dependencies.getProcessFingerprint ? { getProcessFingerprint: dependencies.getProcessFingerprint } : {}),
          ...(dependencies.queryParentDeploymentStatus ? { isDeploymentRunning: (id: string) => dependencies.queryParentDeploymentStatus!(id)?.status === "running" } : {}),
        },
      });
      if (registration.status === "rejected") return completeFailure(registration.diagnostic);
      plan = withAuthoritativeRepositoryAdmission(plan, registration.borrower.launchGitSnapshot, registration.borrower.approvedMutationPaths);
      activeRepositoryBorrower = {
        canonicalRepoRoot: plan.repoRoot,
        ...(plan.worktreeRoot !== plan.repoRoot ? { worktreeRoot: plan.worktreeRoot } : {}),
        repositoryGitDir: plan.repositoryGitDir,
        repositoryGitCommonDir: plan.repositoryGitCommonDir,
        borrowerToken: registration.borrower.borrowerToken,
        parentDeploymentId: registration.borrower.parentDeploymentId,
        deploymentId: registration.borrower.deploymentId,
        ...(registration.borrower.approvedMutationPaths ? { approvedMutationPaths: [...registration.borrower.approvedMutationPaths] } : {}),
      };
    } else if (plan.repositoryAdmission.ownershipIntent === "acquire-before-spawn") {
      const acquisition = acquireRepositoryMutationLease({
        canonicalRepoKey: plan.repoKey,
        canonicalRepoRoot: plan.repoRoot,
        worktreeRoot: plan.worktreeRoot,
        expectedGitDir: plan.repositoryGitDir,
        expectedGitCommonDir: plan.repositoryGitCommonDir,
        deploymentId,
        deploymentDirectory: deployDir,
        runtime: "pi",
        mode: plan.mode,
        launchMode: plan.repositoryAdmission.launchMode,
        team: team.name,
        ...(plan.ticket ? { ticket: plan.ticket } : {}),
        ...(plan.repositoryAdmission.branchTransitionPolicy ? { branchTransitionPolicy: plan.repositoryAdmission.branchTransitionPolicy } : {}),
        force: plan.repositoryAdmission.force,
      });
      if (acquisition.status === "rejected") return completeFailure(acquisition.diagnostic);
      plan = withAuthoritativeRepositoryAdmission(plan, acquisition.lease.preLaunchGitSnapshot);
      activeRepositoryLease = { canonicalRepoRoot: plan.repoRoot, ...(plan.worktreeRoot !== plan.repoRoot ? { worktreeRoot: plan.worktreeRoot, slot: plan.repositoryAdmission.slot } : {}), repositoryGitDir: plan.repositoryGitDir, repositoryGitCommonDir: plan.repositoryGitCommonDir, ownershipToken: acquisition.lease.ownershipToken, ...(activeTicketSlot ? { ticketSlot: activeTicketSlot } : {}) };
      // Keep the ownership capability in this trusted launcher closure only.
      // The Pi model and every tool/child environment authenticate nested direct
      // borrowing through the process-verified launcher lineage instead.
    }
    // Slot and physical Git identity admission must reject before Pi preflight,
    // because preflight may launch runtime/native-host probe processes.
    try { await adapterPreflight(adapter); }
    catch (error) { return completeFailure(error instanceof Error ? error.message : String(error)); }
    try {
      writeFileSync(`${sessionPath}.tmp`, `${sessionId}\n`, "utf8");
      renameSync(`${sessionPath}.tmp`, sessionPath);
      if (readFileSync(sessionPath, "utf8").trim() !== sessionId) throw new Error("persisted Pi session id does not match the authoritative session id");
    } catch (error) {
      const reason = `could not persist Pi session id: ${error instanceof Error ? error.message : String(error)}`;
      return crashFailure(reason);
    }

    // Pi/native-host preflight can yield while another admitted worktree slot
    // changes Git state or worktree metadata. Re-authenticate the immutable
    // physical identity first, then reconcile the snapshot immediately before spawn.
    if (activeRepositoryBorrower || activeRepositoryLease) {
      try {
        assertRepositoryGitIdentity(plan.worktreeRoot, plan.repositoryGitDir, plan.repositoryGitCommonDir);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (activeRepositoryBorrower) {
          throw new Error(formatRepositoryBorrowerDiagnostic({
            category: "repository-identity",
            reason,
            canonicalRepoKey: plan.repoKey,
            canonicalRepoRoot: plan.repoRoot,
            worktreeRoot: plan.worktreeRoot,
            slot: "implement",
          }));
        }
        throw error;
      }
    }
    if (activeRepositoryBorrower) {
      writePrimer(plan, protectedValidationLaunch?.review.authorizationId);
      const expected = plan.repositoryAdmission.gitSnapshot;
      const observed = captureRepositoryGitSnapshot(plan.worktreeRoot);
      if (!expected || !repositoryGitSnapshotsEqual(expected, observed)) {
        throw new Error(formatRepositoryBorrowerDiagnostic({
          category: "pre-spawn-reread",
          reason: "branch, full HEAD, or complete porcelain-v2 status changed after authenticated borrower admission and Pi preflight",
          canonicalRepoKey: plan.repoKey,
          canonicalRepoRoot: plan.repoRoot,
          worktreeRoot: plan.worktreeRoot,
          slot: "implement",
        }));
      }
    } else if (activeRepositoryLease) {
      if (plan.treehouse && plan.ticket) {
        const refreshed = refreshTicketLinkedBranchHead({ canonicalRepoKey: plan.repoKey, canonicalRepoRoot: plan.repoRoot, worktreeRoot: plan.worktreeRoot, ticketId: plan.ticket });
        if (refreshed.baseSha !== plan.treehouse.baseSha || refreshed.headSha !== plan.treehouse.headSha) {
          throw new Error("Treehouse launch evidence drifted after immutable planning; PA ownership was finalized and no runtime was started");
        }
      }
      let stable = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        writePrimer(plan, protectedValidationLaunch?.review.authorizationId);
        const expected = plan.repositoryAdmission.gitSnapshot!;
        const observed = captureRepositoryGitSnapshot(plan.worktreeRoot);
        if (repositoryGitSnapshotsEqual(expected, observed)) {
          stable = true;
          break;
        }
        if (plan.treehouse) {
          throw new Error("Treehouse checkout branch, HEAD, or porcelain-v2 bytes changed after immutable planning; PA ownership was finalized and no runtime was started");
        }
        if (plan.repositoryAdmission.launchMode === "background" && observed.dirty && plan.repositoryKind === "primary") {
          throw new Error(formatDirtyBackgroundBuilderDiagnostic({ canonicalRepoKey: plan.repoKey, canonicalRepoRoot: plan.repoRoot, worktreeRoot: plan.worktreeRoot, team: team.name, mode: plan.mode, runtime: "pi", snapshot: observed, ...(plan.ticket ? { ticket: plan.ticket } : {}) }));
        }
        const update = updateRepositoryMutationLeaseGitSnapshot({ canonicalRepoRoot: plan.repoRoot, worktreeRoot: plan.worktreeRoot, repositoryGitDir: activeRepositoryLease.repositoryGitDir, slot: activeRepositoryLease.slot, ownershipToken: activeRepositoryLease.ownershipToken, gitSnapshot: observed });
        if (update.status !== "updated") throw new Error(`repository-admission: could not persist authoritative Git snapshot (${update.status})`);
        plan = withAuthoritativeRepositoryAdmission(plan, update.lease!.preLaunchGitSnapshot);
      }
      if (!stable) throw new Error("repository-admission: Git state did not stabilize after Pi preflight; ownership was released and no runtime was started");
    } else {
      writePrimer(plan, protectedValidationLaunch?.review.authorizationId);
    }

    if (activeRepositoryBorrower) reauthenticateParentBeforeSpawn?.();
    selectedTicketWorktree?.reread();

    let publishedPid: number | undefined;
    const publishPid = (pid: number): void => {
      if (!Number.isInteger(pid) || pid <= 0 || publishedPid !== undefined) return;
      emitPidEvent({ deploymentId, team: team.name, pid });
      publishedPid = pid;
    };
    const spawnOptions = { primerPath, deployId: deploymentId, mode: request.background ? "background" : "foreground", model, ...(request.background ? { timeoutMs: plan.timeoutSeconds * 1000 } : {}), logFile: resolve(deployDir, "pi.log"), env, sessionId, onPid: publishPid, ...(activeRepositoryLease ? { repositoryLease: activeRepositoryLease } : {}), ...(activeRepositoryBorrower ? { repositoryBorrower: activeRepositoryBorrower } : {}), executionPlan: plan } as const;
    if (protectedValidationLaunch) {
      (adapter as PiAdapter).registerProtectedValidationLaunch(protectedValidationLaunch);
    }
    dependencies.observeOperation?.("runtime-spawn");
    const result = prior ? await adapter.resume(spawnOptions) : await adapter.spawn(spawnOptions);
    if (result.exitCode !== 0) return completeFailure(result.errorMessage ?? `pi exited with code ${result.exitCode}`, result.exitCode);
    const terminalError = typeof result.metadata?.["terminalError"] === "string" ? result.metadata["terminalError"] : undefined;
    if (terminalError) return completeFailure(terminalError);
    if (result.sessionId !== sessionId || result.metadata?.["sessionId"] !== sessionId) throw new Error("Pi adapter returned a session id different from the persisted session id");
    const pid = result.metadata?.["pid"]; if (typeof pid === "number") publishPid(pid);
    const monitor = result.metadata?.["monitor"] as PiSupervisionHandle | undefined;
    if (request.background && result.metadata?.["pending"] === true && monitor?.completion) {
      // Backward-compatible injected-adapter seam. Production Pi background runs
      // return supervisorPid and are finalized exclusively by background-runner.ts.
      void monitor.completion.then(async (final) => {
        const terminalError = typeof final.metadata?.["terminalError"] === "string" ? final.metadata["terminalError"] : undefined;
        const ok = final.status === 0 && !terminalError;
        const failure = final.status !== 0 ? final.spawnError?.message ?? (final.stderr || `exit ${final.status}`) : terminalError;
        const reason = ok ? "ppa deploy completed" : `ppa deploy failed: ${failure}`;
        if (!ok) appendActivity(createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(reason, env, 500) }), env);
        await writeTerminal("completed", ok ? "success" : "failed", reason, ok ? 0 : final.status || 1, resolve(deployDir, "pi.log"));
      }).catch((error) => {
        void crashFailure(error instanceof Error ? error.message : String(error));
      });
      return { status: "pending", team: request.team, mode: request.mode ?? null, deploymentId };
    }
    if (request.background && result.metadata?.["pending"] === true) {
      const supervisorPid = result.metadata?.["supervisorPid"];
      if (typeof supervisorPid !== "number") throw new Error("runner-readiness: Pi background supervisor returned without ownership evidence");
      acceptRepositoryAuthorityHandoff(result.metadata);
      return { status: "pending", team: request.team, mode: request.mode ?? null, deploymentId };
    }
    const staged = request.background ? undefined : readStagedForegroundCompletion(deployDir, deploymentId, env, paths.activityLogPath, audit);
    const outcome = request.background
      ? await writeTerminal("completed", "success", "ppa deploy completed", 0, result.logFile)
      : staged
        ? await writeTerminal("completed", staged.status, staged.summary ?? stagedCompletionSummary(staged.status), staged.status === "failed" ? 1 : 0, staged.logFile ?? result.logFile, { rating: staged.rating, fallback: staged.fallback })
        : await writeTerminal("completed", "partial", "ppa foreground session exited without a staged completion payload", 0, result.logFile);
    return outcome.status === "success"
      ? { status: "success", team: request.team, mode: request.mode ?? null, deploymentId }
      : { status: "failed", team: request.team, mode: request.mode ?? null, deploymentId, reason: outcome.reason };
  } catch (error) { return crashFailure(error instanceof Error ? error.message : String(error)); }
}

async function adapterPreflight(adapter: RuntimeAdapter): Promise<void> {
  const pi = adapter as RuntimeAdapter & { preflight?: () => void | Promise<void> };
  await pi.preflight?.();
}

function emitResolutionWarning(config: { warning?: string }, deploymentId: string, activityLogPath: string, diagnostics: DeployDiagnostics | undefined, audit: PiRedactionAudit, env: NodeJS.ProcessEnv): void {
  if (!config.warning) return;
  if (diagnostics) diagnostics.stderr(config.warning); else process.stderr.write(`${config.warning}\n`);
  const secrets = environmentSecrets({ ...process.env, ...env });
  audit.observe("deploy-diagnostic", config.warning, secrets);
  const event = createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: config.warning, metadata: { resolution: "fallback" } });
  appendActivityEvent(event, activityLogPath);
  audit.observe("activity", event, secrets);
}

function boundedDiagnostic(value: string, _env: NodeJS.ProcessEnv, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function terminalStatus(status: "success" | "failed", reason: string, timestamp = new Date().toISOString()) {
  return { type: "agent_end" as const, stopReason: status === "success" ? "stop" : "error", ...(status === "failed" ? { error: reason } : {}), timestamp };
}

function readStagedForegroundCompletion(deployDir: string, deploymentId: string, env: NodeJS.ProcessEnv, activityLogPath: string, audit: PiRedactionAudit): PiForegroundCompletion | undefined {
  try {
    const completion = readPiForegroundCompletion(deployDir);
    if (completion && completion.deploymentId !== deploymentId) throw new Error("Pi foreground completion sidecar deployment does not match");
    return completion;
  } catch (error) {
    const diagnostic = boundedDiagnostic(error instanceof Error ? error.message : String(error), env, 2000);
    const event = createActivityEvent({ deployId: deploymentId, kind: "error", source: "pi", body: boundedDiagnostic(diagnostic, env, 500) });
    appendActivityEvent(event, activityLogPath);
    const secrets = environmentSecrets({ ...process.env, ...env });
    audit.observe("activity", event, secrets);
    audit.observe("deploy-diagnostic", diagnostic, secrets);
    return undefined;
  }
}

function stagedCompletionSummary(status: PiForegroundCompletion["status"]): string {
  if (status === "success") return "ppa foreground work completed";
  if (status === "partial") return "ppa foreground work completed partially";
  return "ppa foreground work reported failure";
}

function registryTerminalOutcome(event: RegistryEvent, env: NodeJS.ProcessEnv): { status: "success" | "failed"; reason: string } {
  if (event.event === "completed" && (event.status === "success" || event.status === "partial")) {
    return { status: "success", reason: boundedDiagnostic(event.summary ?? `ppa agent completed with status ${event.status}`, env, 2000) };
  }
  const reason = event.event === "crashed" ? event.error ?? "ppa agent crashed" : event.summary ?? `ppa agent completed with status ${event.status ?? "unknown"}`;
  return { status: "failed", reason: boundedDiagnostic(reason, env, 2000) };
}

function inheritedAdmissionFailure(reason: string, canonicalRepoKey: string, canonicalRepoRoot: string): string {
  if (/Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s.test(reason)) return reason;
  return formatRepositoryBorrowerDiagnostic({
    category: "child-lifecycle",
    reason,
    canonicalRepoKey,
    canonicalRepoRoot,
  });
}

function deploymentCorrelation(plan: ExecutionPlan): {
  parentDeploymentId?: string; builderAuthority?: "orchestrator" | "parented-implement" | "standalone-implement";
  treehousePath?: string; treehouseLeaseId?: string; treehouseLeaseHolder?: string; branchState?: "materialized";
  branchBaseSha?: string; branchHeadSha?: string; ticketSlotId?: string; repositoryPermit?: 1 | 2 | 3 | 4;
} {
  const evidence = plan.treehouse;
  return evidence ? {
    ...(evidence.parentDeploymentId ? { parentDeploymentId: evidence.parentDeploymentId } : {}),
    builderAuthority: evidence.authority, treehousePath: evidence.path, treehouseLeaseId: evidence.leaseId,
    treehouseLeaseHolder: evidence.leaseHolder, branchState: evidence.branchState, branchBaseSha: evidence.baseSha,
    branchHeadSha: evidence.headSha, ticketSlotId: evidence.ticketSlotId, repositoryPermit: evidence.repositoryPermit,
  } : plan.ticketWorktreeSelection ? {
    branchState: "materialized", branchBaseSha: plan.ticketWorktreeSelection.baseSha, branchHeadSha: plan.ticketWorktreeSelection.headSha,
  } : {};
}

function registryCorrelation(plan: ExecutionPlan, terminal?: { branchState: "materialized"; branchBaseSha?: string; branchHeadSha: string }): Pick<RegistryEvent,
  "parent_deployment_id" | "builder_authority" | "treehouse_path" | "treehouse_lease_id" | "treehouse_lease_holder" |
  "branch_state" | "branch_base_sha" | "branch_head_sha" | "ticket_slot_id" | "repository_permit"
> {
  const evidence = plan.treehouse;
  return evidence ? {
    parent_deployment_id: evidence.parentDeploymentId, builder_authority: evidence.authority,
    treehouse_path: evidence.path, treehouse_lease_id: evidence.leaseId, treehouse_lease_holder: evidence.leaseHolder,
    branch_state: terminal?.branchState ?? evidence.branchState, branch_base_sha: terminal?.branchBaseSha ?? evidence.baseSha,
    branch_head_sha: terminal?.branchHeadSha ?? evidence.headSha, ticket_slot_id: evidence.ticketSlotId,
    repository_permit: evidence.repositoryPermit,
  } : plan.ticketWorktreeSelection ? {
    branch_state: "materialized", branch_base_sha: plan.ticketWorktreeSelection.baseSha, branch_head_sha: plan.ticketWorktreeSelection.headSha,
  } : {};
}

function authenticateTicketWorktreeResume(id: string, evidence: TicketWorktreeSelectionEvidence): void {
  if (!/^d-[0-9a-f]{6}$/.test(id)) throw new Error("selection resume requires an exact deployment ID");
  const status = queryDeploymentStatus(id);
  const path = resolve(getDeployPaths(id).deployDir, TICKET_WORKTREE_SELECTION_FILE);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 16_384) {
    throw new Error("prior immutable ticket-worktree selection evidence is missing or malformed");
  }
  const prior: unknown = JSON.parse(readFileSync(path, "utf8"));
  const starts = getDeploymentEvents(id).filter((event) => event.event === "started");
  if (!status?.ticket_worktree_selection || starts.length !== 1
    || starts[0]?.ticket_worktree_selection !== status.ticket_worktree_selection
    || status.ticket_worktree_selection.length > 16_384) throw new Error("prior immutable selection registry context is missing, malformed or inconsistent");
  const registryPrior: unknown = JSON.parse(status.ticket_worktree_selection);
  if (!registryPrior || typeof registryPrior !== "object" || Array.isArray(registryPrior)
    || (Object.keys(evidence) as (keyof TicketWorktreeSelectionEvidence)[]).some((field) => typeof (registryPrior as Record<string, unknown>)[field] !== "string" || !(registryPrior as Record<string, unknown>)[field])
    || !/^[0-9a-f]{40}$/.test(String((registryPrior as Record<string, unknown>)["baseSha"]))
    || !/^[0-9a-f]{40}$/.test(String((registryPrior as Record<string, unknown>)["headSha"]))) throw new Error("prior immutable selection registry context is malformed");
  if (JSON.stringify(registryPrior) !== JSON.stringify(prior)) throw new Error("prior selection artifact and immutable registry context disagree");
  if (!prior || typeof prior !== "object" || Array.isArray(prior)
    || !status || status.runtime !== "pi" || status.binary !== "ppa" || status.builder_authority
    || status.ticket_id !== evidence.ticket || status.repo_root !== evidence.repoRoot
    || status.repo !== evidence.worktreeRoot || status.worktree_root !== evidence.worktreeRoot
    || (["repoKey", "repoRoot", "ticket", "worktreeRoot", "gitDir", "gitCommonDir"] as const)
      .some((field) => (prior as Record<string, unknown>)[field] !== evidence[field])) {
    throw new Error("resume requires the prior exact canonical repository, ticket and physical selected checkout");
  }
}

function authenticateParentTicketBranch(repoKey: string, worktreeRoot: string, ticketId: string): { branch: string; baseSha?: string; headSha: string } {
  const ticket = new TicketStore().get(ticketId);
  const linked = ticket ? requireTicketLinkedBranch(ticket, repoKey) : undefined;
  const snapshot = captureRepositoryGitSnapshot(worktreeRoot);
  if (linked?.state !== "materialized" || !linked.headSha || linked.branch !== snapshot.branch || linked.headSha !== snapshot.head) {
    throw new Error(parentAdmissionDiagnostic("the durable materialized ticket branch and current full Git snapshot do not match exactly", "durable ticket branch and Git snapshot", {
      canonicalRoot: "authenticated above", parentWorktree: worktreeRoot, invocationCwd: process.cwd(), gitTopLevel: worktreeRoot, selectorRoot: "authenticated above",
    }));
  }
  return Object.freeze({ branch: linked.branch, ...(linked.baseSha ? { baseSha: linked.baseSha } : {}), headSha: linked.headSha });
}

type ExpectedParentEvidence = { ticketId: string; repoKey: string; repoRoot: string; worktreeRoot: string; leaseId: string; leaseHolder: string; branch: string; baseSha?: string; headSha: string };
type ParentDurableAuthentication = { processFingerprint: ProcessFingerprint; leaseEvidenceIdentity: string; slotEvidenceIdentity: string };

function authenticateParentPreparedTreehouse(
  treehouse: TreehouseClient,
  repoRoot: string,
  repoKey: string,
  ticketId: string,
  worktreeRoot: string,
  source: string,
): ReturnType<TreehouseClient["authenticatePrepared"]> {
  try {
    return treehouse.authenticatePrepared(repoRoot, repoKey, ticketId, worktreeRoot);
  } catch {
    throw new Error(parentAdmissionDiagnostic("Treehouse checkout authentication failed; protected command evidence is redacted", source, {
      canonicalRoot: repoRoot, parentWorktree: worktreeRoot, invocationCwd: process.cwd(), gitTopLevel: "unresolved", selectorRoot: repoRoot,
    }));
  }
}

function authenticateParentTreehouse(
  parent: { parentDeploymentId: string; parentDeploymentDirectory: string },
  expected: ExpectedParentEvidence,
  queryStatus: typeof queryDeploymentStatus = queryDeploymentStatus,
): { slotId: string; repositoryPermit: 1 | 2 | 3 | 4 } {
  const status = queryStatus(parent.parentDeploymentId);
  const permitText = process.env["PA_REPOSITORY_PERMIT"] ?? "";
  const permit = Number(permitText);
  const slotId = process.env["PA_TICKET_SLOT"] ?? "";
  const details = { canonicalRoot: expected.repoRoot, parentWorktree: expected.worktreeRoot, invocationCwd: process.cwd(), gitTopLevel: expected.worktreeRoot, selectorRoot: expected.repoRoot };
  const reject = (source: string, reason: string): never => { throw new Error(parentAdmissionDiagnostic(reason, source, details)); };
  if (!status) throw new Error(parentAdmissionDiagnostic("the protected parent is absent from the deployment registry", "parent deployment registry status", details));
  if (status.status !== "running") reject("parent deployment registry status", "the protected parent is terminal or not registry-running");
  if (status.team !== "builder" || status.mode !== "orchestrator" || status.runtime !== "pi" || status.binary !== "ppa" || status.builder_authority !== "orchestrator") {
    reject("parent deployment registry identity", "the protected parent team, mode, runtime, binary, or authority is not the exact PPA builder/orchestrator identity");
  }
  if (status.ticket_id !== expected.ticketId || process.env["PA_TICKET_ID"] !== expected.ticketId) {
    reject("parent ticket evidence", "the parent registry and inherited ticket do not equal the requested child ticket");
  }
  if (status.repo !== expected.worktreeRoot || status.repo_root !== expected.repoRoot || status.worktree_root !== expected.worktreeRoot || status.treehouse_path !== expected.worktreeRoot) {
    reject("parent registry repository paths", `expected canonical_root=${safeParentField(expected.repoRoot)} and worktree=${safeParentField(expected.worktreeRoot)}; observed repo=${safeParentField(status.repo ?? "missing")} repo_root=${safeParentField(status.repo_root ?? "missing")} worktree_root=${safeParentField(status.worktree_root ?? "missing")}`);
  }
  if (process.env["PA_REPO"] !== expected.worktreeRoot || process.env["PA_WORKTREE_ROOT"] !== expected.worktreeRoot) {
    reject("inherited parent repository environment", `expected PA_REPO and PA_WORKTREE_ROOT=${safeParentField(expected.worktreeRoot)}; observed PA_REPO=${safeParentField(process.env["PA_REPO"] ?? "missing")} PA_WORKTREE_ROOT=${safeParentField(process.env["PA_WORKTREE_ROOT"] ?? "missing")}`);
  }
  if (status.treehouse_lease_id !== expected.leaseId || status.treehouse_lease_holder !== expected.leaseHolder
    || process.env["PA_TREEHOUSE_LEASE_ID"] !== expected.leaseId || process.env["PA_TREEHOUSE_LEASE_HOLDER"] !== expected.leaseHolder) {
    reject("protected Treehouse lease evidence", "the registry and inherited lease ID or holder differ from the freshly authenticated Treehouse row; protected values are redacted");
  }
  if (status.branch_state !== "materialized" || status.branch_base_sha !== expected.baseSha || status.branch_head_sha !== expected.headSha) {
    reject("parent branch and Git HEAD evidence", "the materialized branch base or full HEAD differs from the authenticated ticket checkout; commit values are redacted");
  }
  if (status.ticket_slot_id !== slotId || status.repository_permit !== permit
    || slotId !== `pa:${expected.repoKey}:${expected.ticketId}` || ![1, 2, 3, 4].includes(permit)) {
    reject("protected ticket slot and repository permit", "the registry and inherited capacity evidence do not match exactly; protected values are redacted");
  }
  if (process.env["PA_DEPLOYMENT_ID"] !== parent.parentDeploymentId || process.env["PA_DEPLOYMENT_DIR"] !== parent.parentDeploymentDirectory
    || getDeployPaths(parent.parentDeploymentId).deployDir !== parent.parentDeploymentDirectory
    || process.env["PA_TEAM"] !== "builder" || process.env["PA_MODE"] !== "orchestrator") {
    reject("inherited parent process context", "the parent deployment ID, directory, team, or mode differs from protected process lineage");
  }
  return { slotId, repositoryPermit: permit as 1 | 2 | 3 | 4 };
}

function authenticateParentDurableAuthority(
  parent: { parentDeploymentId: string; parentDeploymentDirectory: string },
  expected: ExpectedParentEvidence,
  capacity: { slotId: string; repositoryPermit: 1 | 2 | 3 | 4 },
  prior: ParentDurableAuthentication | undefined,
  dependencies: PiDeployDependencies,
): ParentDurableAuthentication {
  const details = { canonicalRoot: expected.repoRoot, parentWorktree: expected.worktreeRoot, invocationCwd: process.cwd(), gitTopLevel: expected.worktreeRoot, selectorRoot: expected.repoRoot };
  const getProcessFingerprint = dependencies.getProcessFingerprint ?? readProcessFingerprint;
  const queryStatus = dependencies.queryParentDeploymentStatus ?? queryDeploymentStatus;
  const lease = authenticateRepositoryMutationLease({
    canonicalRepoKey: expected.repoKey,
    canonicalRepoRoot: expected.repoRoot,
    worktreeRoot: expected.worktreeRoot,
    deploymentId: parent.parentDeploymentId,
    deploymentDirectory: parent.parentDeploymentDirectory,
    runtime: "pi",
    team: "builder",
    mode: "orchestrator",
    ticket: expected.ticketId,
    // Authenticate durable parent identity against its protected lease bytes here.
    // The current worktree snapshot is authenticated separately by borrower
    // registration, including exact one-use approval for an intentional dirty
    // continuation; comparing it to the parent's prior clean authority snapshot
    // here would reject that approved transition as an identity mismatch.
    ...(prior ? { processFingerprint: prior.processFingerprint, expectedEvidenceIdentity: prior.leaseEvidenceIdentity } : {}),
    dependencies: { getProcessFingerprint, isDeploymentRunning: (id) => queryStatus(id)?.status === "running" },
  });
  if (lease.status !== "authenticated") {
    throw new Error(parentAdmissionDiagnostic(`the durable parent mutation lease failed exact live authentication (${lease.reason})`, "mutex-protected parent mutation lease", details));
  }
  const slot = authenticateRepositoryTicketSlot({
    canonicalRepoKey: expected.repoKey,
    canonicalRepoRoot: expected.repoRoot,
    ticket: expected.ticketId,
    deploymentId: parent.parentDeploymentId,
    deploymentDirectory: parent.parentDeploymentDirectory,
    slotId: capacity.slotId,
    repositoryPermit: capacity.repositoryPermit,
    processFingerprint: prior?.processFingerprint ?? lease.processFingerprint,
    ...(prior ? { expectedEvidenceIdentity: prior.slotEvidenceIdentity } : {}),
    dependencies: { getProcessFingerprint },
  });
  if (slot.status !== "authenticated") {
    throw new Error(parentAdmissionDiagnostic(`the durable ticket slot and repository permit failed exact live authentication (${slot.reason})`, "mutex-protected durable ticket-slot/permit evidence", details));
  }
  return Object.freeze({
    processFingerprint: prior?.processFingerprint ?? lease.processFingerprint,
    leaseEvidenceIdentity: lease.evidenceIdentity,
    slotEvidenceIdentity: slot.evidenceIdentity,
  });
}

function parentAdmissionDiagnostic(
  reason: string,
  source = "process-verified parent lease plus registry, Treehouse, ticket, branch, Git, slot, and permit evidence",
  details?: { canonicalRoot: string; parentWorktree: string; invocationCwd: string; gitTopLevel: string; selectorRoot: string },
): string {
  const paths = details
    ? ` Expected: canonical_root=${details.canonicalRoot} parent_worktree=${details.parentWorktree}. Observed: selector_root=${details.selectorRoot} invocation_cwd=${details.invocationCwd} git_top_level=${details.gitTopLevel}.`
    : "";
  return formatBoundedFiveFieldDiagnostic({
    condition: "parented implement admission",
    source,
    reason: `${reason}.${paths}`,
    correction: "preserve the parent checkout and reconcile the parent-addressed evidence without spawning Pi",
    resumeAction: "the live orchestrator must retry one direct background implement after exact evidence agrees",
  });
}

function safeParentField(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}

function standaloneAdmissionDiagnostic(reason: string): string {
  return `Condition: standalone implement admission. Source: authenticated free Treehouse checkout and atomic repository permit. Reason: ${reason}. Correction: preserve the lease and enter the exact matching physical ticket checkout. Resume Action: retry only when no live ticket/worktree owner exists and a permit is available.`;
}

function inheritedParentContext(): { parentDeploymentId: string; parentDeploymentDirectory: string } | undefined {
  const parentDeploymentId = process.env["PA_DEPLOYMENT_ID"] ?? "";
  const parentDeploymentDirectory = process.env["PA_DEPLOYMENT_DIR"] ?? "";
  const parentIdentity = process.env["PA_TEAM"] === "builder" && process.env["PA_MODE"] === "orchestrator" && Boolean(parentDeploymentId) && Boolean(parentDeploymentDirectory);
  return parentIdentity ? { parentDeploymentId, parentDeploymentDirectory } : undefined;
}
function selectMode(team: TeamConfig, id?: string) { return (id ?? team.default_mode) ? team.deploy_modes?.find((item) => item.id === (id ?? team.default_mode)) : undefined; }
function paEnv(id: string, dir: string, activity: string, team: TeamConfig, request: DeployRequest, provider?: string, model?: string): Partial<Record<PaEnvKey | typeof PA_PI_EXECUTION_MODE_ENV, string>> { return { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: dir, PA_ACTIVITY_LOG: activity, PA_TEAM: team.name, PA_MODE: request.mode ?? team.default_mode ?? "", PA_TICKET_ID: request.ticket ?? "", PA_REPO: request.repo ?? "", PA_PROVIDER: provider ?? "", PA_MODEL: model ?? "", PA_TEAM_MODEL: request.teamModel ?? "", PA_AGENT_MODEL: request.agentModel ?? "", ...(isRogueOneTeam(team.name) ? { PA_ROGUE_ONE: "1" } : {}), [PA_PI_EXECUTION_MODE_ENV]: request.background ? "background" : "foreground" }; }
function readSession(id: string, expected: string): string { const dir = getDeployPaths(id).deployDir; const path = resolve(dir, expected); if (!existsSync(path)) { for (const [file, binary] of [["session-id-opencode.txt", "opa"], ["session-id-claude.txt", "cpa"], ["session-id-droid.txt", "dpa"], ["session-id-pi.txt", "ppa"]] as const) if (file !== expected && existsSync(resolve(dir, file))) throw new Error(`cannot resume: deploy ${id} was launched by another runtime; use '${binary} deploy --resume ${id}'`); throw new Error(`no Pi session id recorded for ${id} — cannot resume`); } const value = readFileSync(path, "utf8").trim(); if (!value) throw new Error(`empty Pi session id recorded for ${id} — cannot resume`); return value; }
