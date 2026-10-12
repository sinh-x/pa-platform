import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  VALIDATION_HANDOFF_SCHEMA_VERSION,
  VALIDATION_MANIFEST_SCHEMA_VERSION,
  TicketStore,
  assertRepositoryGitIdentity,
  captureRepositoryGitSnapshot,
  claimReviewAuthorization,
  queryReviewAuthorizationClaim,
  getDeploymentEvents,
  getDeployPaths,
  resolveRepoExecutionPath,
  digestValidationManifest,
  formatBoundedFiveFieldDiagnostic,
  getAiUsageDir,
  getTicketsDir,
  withRepositoryReviewReservation,
  validateCanonicalDeploymentId,
  type RepositoryReviewReservation,
  type ReviewCheckoutEvidence,
  type RepositoryAdmissionDependencies,
  type DeployRequest,
  type ExecutionPlan,
  type ValidationAuthorityBinding,
  type ValidationCommandSpec,
  type ValidationHandoff,
  type ValidationManifest,
  type ReviewAuthorizationClaim,
} from "@pa-platform/pa-core";
import {
  PI_PROTECTED_VALIDATION_SCHEMA_VERSION,
  type PiProtectedValidationLaunch,
} from "./validation-supervisor.js";

import { extractMatrixAuthority, parseMatrixCompatibility, type MatrixProfile } from "./matrix-compatibility.js";
import { NixosPrerequisiteSession, NIXOS_TOOLS, NIXOS_APPROVAL_VERSION, nixosTupleDigest, createNixosPrerequisiteDependencies, parseNixosBaseline, parseNixosBaselineReference, parseNixosStrictJson, type NixosBaselineReference, type NixosTool } from "./nixos-prerequisites.js";

const BASELINE_FIELDS = ["Prerequisite Baseline Source", "Prerequisite Baseline SHA-256", "Prerequisite Baseline Approval Evidence"] as const;
const REVIEW_AUTHORIZATION = /^review-auth:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_OBJECTIVE_FIELDS = [
  "Ticket",
  "Branch",
  "Feature SHA",
  "Matrix Source",
  "Matrix Authority SHA-256",
  "Matrix Approval Evidence",
  "Review Authorization ID",
] as const;
const OPTIONAL_OBJECTIVE_FIELDS = new Set(["PR", "Changed Files", "Requested Review Areas"]);
const ALLOWED_OBJECTIVE_FIELDS = new Set<string>([...REQUIRED_OBJECTIVE_FIELDS, ...OPTIONAL_OBJECTIVE_FIELDS, ...BASELINE_FIELDS]);
export const PI_MATRIX_ATTEMPT_STATE_DIRECTORY = "team-manager";
export const PI_MATRIX_ATTEMPT_STATE_FILE = "review-attempt-state.jsonl";
const MATRIX_START_EVENT_SCHEMA_VERSION = "pa-review-attempt-event/v1" as const;
const MAX_MATRIX_START_EVENT_BYTES = 64 * 1024;
const MATRIX_ENVIRONMENT_NAMES = [
  "PA_REPO",
  "PA_TICKET_ID",
  "PA_FEATURE_SHA",
  "PA_MATRIX_SOURCE",
  "PA_MATRIX_AUTHORITY_SHA256",
  "PA_MATRIX_APPROVAL_EVIDENCE",
  "CI",
  "HOME",
  "LANG",
  "TZ",
  "PATH",
] as const;

type ObjectiveField = (typeof REQUIRED_OBJECTIVE_FIELDS)[number];
type ReviewObjective = Record<ObjectiveField, string> & Partial<Record<(typeof BASELINE_FIELDS)[number], string>>;

interface ApprovedMatrix {
  profile: MatrixProfile;
  historicalBaseProvenance: "header" | "materialized-ticket-link";
  authority: string;
  digest: string;
  header: {
    approvedBaseSha: string;
    historicalMaterializationBaseSha: string;
    featureBranch: string;
    matrixApprovalEvidence: string;
    matrixAuthoritySha256: string;
    repositoryKey: string;
    ticketId: string;
  };
  prerequisites: readonly string[];
  environmentSection: string;
  commands: readonly string[];
}

interface PrerequisiteContext {
  approval: { author: string; content: string } | undefined;
  authorizationId: string;
  branch: string;
  environment: Record<string, string>;
  featureSha: string;
  input: PiValidationLaunchInput;
  matrix: ApprovedMatrix;
  matrixApprovalEvidence: string;
  matrixAuthoritySha256: string;
  matrixSource: string;
  linkedBranchMatches: boolean;
  snapshot: ReturnType<typeof captureRepositoryGitSnapshot>;
  ticketId: string;
}

type PiPrerequisiteGateBinding = Omit<PiProtectedValidationLaunch, "admission" | "schemaVersion">;

export interface PiValidationLaunchInput {
  deploymentId: string;
  deploymentDirectory: string;
  request: DeployRequest;
  plan: ExecutionPlan;
  environment: Record<string, string>;
}

export interface PiMatrixStartedEvent {
  schemaVersion: typeof MATRIX_START_EVENT_SCHEMA_VERSION;
  type: "matrix-started";
  timestamp: string;
  deploymentId: string;
  authorizationId: string;
  ticketId: string;
  branch: string;
  featureSha: string;
  candidateHead: string;
  matrixSource: string;
  matrixAuthoritySha256: string;
  matrixApprovalEvidence: string;
  repoKey: string;
  repoRoot: string;
  worktreeRoot: string;
}

export interface PiMatrixStartDependencies {
  now?: () => Date;
  afterWrite?: () => void;
  afterFileFsync?: () => void;
  afterParentFsync?: () => void;
}

export function isPiProtectedReviewRequest(request: DeployRequest, plan: ExecutionPlan): boolean {
  return request.team === "requirements" && plan.mode === "review-auto";
}

/**
 * Candidate-only Phase 2 boundary. Compose around the existing PAP-223 matrix-start
 * journal/executor path, never instead of its authority/environment/ledger checks.
 * The adapter supplies its existing-only selector as rereadCheckout. No public flag.
 */
export function withPiReviewCandidateAtMatrixBoundary<T>(input: {
  launch: PiPrerequisiteGateBinding;
  reservation: RepositoryReviewReservation;
  rereadCheckout: () => ReviewCheckoutEvidence;
  dependencies?: Partial<RepositoryAdmissionDependencies>;
}, start: () => T): T {
  const { launch, reservation } = input;
  if (launch.matrixProfile) {
    const fresh = readApprovedMatrix(launch.review.matrixSource);
    if (fresh.profile !== launch.matrixProfile || fresh.historicalBaseProvenance !== launch.historicalBaseProvenance) throw launchError("matrix profile/base provenance reread", "persisted semantic profile or historical-base provenance drifted");
  }
  const checkout = reservation.checkout;
  const review = launch.review;
  const authority = launch.authority;
  if (review.checkout && (["repoKey", "repoRoot", "worktreeRoot", "ticket", "leaseId", "leaseHolder", "branch", "branchState", "baseSha", "headSha", "featureSha"] as const)
    .some((key) => review.checkout![key] !== checkout[key])
    || review.checkout && JSON.stringify(review.checkout.approvedReference) !== JSON.stringify(checkout.approvedReference)) {
    throw launchError("review candidate metadata", "reviewer identity does not match the exact protected reservation");
  }
  if (launch.deploymentId !== reservation.deploymentId || review.reviewDeploymentId !== reservation.deploymentId
    || review.authorizationId !== reservation.authorizationId || review.ticketId !== checkout.ticket
    || review.branch !== checkout.branch || review.featureSha !== checkout.featureSha
    || review.candidateHead !== checkout.headSha || review.candidateHead !== checkout.gitSnapshot.head
    || authority.ticketId !== checkout.ticket || authority.branch !== checkout.branch || authority.featureSha !== checkout.featureSha
    || authority.repository.repoKey !== checkout.repoKey || authority.repository.canonicalRoot !== checkout.repoRoot
    || authority.repository.worktreeRoot !== checkout.worktreeRoot || authority.protectedEnvironment["PA_REPO"] !== checkout.worktreeRoot) {
    throw launchError("review reservation matrix boundary", "protected launch and exact reserved candidate binding do not agree");
  }
  return withRepositoryReviewReservation(input, start);
}

export function piMatrixAttemptStatePath(deploymentDirectory: string): string {
  return resolve(deploymentDirectory, PI_MATRIX_ATTEMPT_STATE_DIRECTORY, PI_MATRIX_ATTEMPT_STATE_FILE);
}

export function writePiMatrixStartedEvent(
  input: { deploymentDirectory: string; event: Omit<PiMatrixStartedEvent, "schemaVersion" | "type" | "timestamp"> },
  dependencies: PiMatrixStartDependencies = {},
): PiMatrixStartedEvent {
  const parent = resolve(input.deploymentDirectory, PI_MATRIX_ATTEMPT_STATE_DIRECTORY);
  const path = piMatrixAttemptStatePath(input.deploymentDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertSecureMatrixStartParent(parent);
  fsyncDirectory(dirname(parent));

  const existing = readPiMatrixStartedEventIfPresent(path);
  if (existing) return reconcilePiMatrixStartedEvent(path, parent, existing, input.event, dependencies);

  const event: PiMatrixStartedEvent = {
    schemaVersion: MATRIX_START_EVENT_SCHEMA_VERSION,
    type: "matrix-started",
    timestamp: (dependencies.now ?? (() => new Date()))().toISOString(),
    ...input.event,
  };
  validatePiMatrixStartedEvent(event);
  const body = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  if (body.length > MAX_MATRIX_START_EVENT_BYTES) throw new Error("matrix-started event exceeds its durable size limit");

  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, flags, 0o600);
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < body.length) {
      const written = writeSync(descriptor, body, offset, body.length - offset);
      if (written <= 0) throw new Error("matrix-started journal write made no progress");
      offset += written;
    }
    dependencies.afterWrite?.();
    fsyncSync(descriptor);
    dependencies.afterFileFsync?.();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readPiMatrixStartedEvent(path);
      return reconcilePiMatrixStartedEvent(path, parent, raced, input.event, dependencies);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncDirectory(parent);
  dependencies.afterParentFsync?.();
  const persisted = readPiMatrixStartedEvent(path);
  if (!matrixStartedIdentityEqual(persisted, event) || persisted.timestamp !== event.timestamp) throw new Error("matrix-started durable readback does not match the launch identity");
  return Object.freeze(persisted);
}

export function assertPiMatrixStartedForLaunch(deploymentDirectory: string, launch: PiProtectedValidationLaunch): PiMatrixStartedEvent {
  const event = readPiMatrixStartedEvent(piMatrixAttemptStatePath(deploymentDirectory));
  if (event.deploymentId !== launch.deploymentId || event.deploymentId !== launch.review.reviewDeploymentId
    || event.authorizationId !== launch.review.authorizationId || event.ticketId !== launch.review.ticketId
    || event.branch !== launch.review.branch || event.featureSha !== launch.review.featureSha
    || event.candidateHead !== launch.review.candidateHead || event.candidateHead !== launch.authority.featureSha
    || event.timestamp !== launch.review.prerequisiteStartedAt
    || (launch.review.checkout && (event.candidateHead !== launch.review.checkout.headSha
      || event.candidateHead !== launch.review.checkout.featureSha))
    || event.matrixSource !== launch.review.matrixSource || event.matrixAuthoritySha256 !== launch.review.matrixAuthoritySha256
    || event.matrixApprovalEvidence !== launch.review.matrixApprovalEvidence
    || event.repoKey !== launch.authority.repository.repoKey || event.repoRoot !== launch.authority.repository.canonicalRoot
    || event.worktreeRoot !== launch.authority.repository.worktreeRoot) {
    throw new Error("matrix-started event does not match the protected validation launch identity");
  }
  return event;
}

export function readPiMatrixStartedEvent(path: string): PiMatrixStartedEvent {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600
    || file.size === 0 || file.size > MAX_MATRIX_START_EVENT_BYTES) {
    throw new Error("matrix-started journal is insecure, empty, or oversized");
  }
  const body = readFileSync(path, "utf8");
  if (!body.endsWith("\n") || body.slice(0, -1).includes("\n")) {
    throw new Error("matrix-started journal must contain exactly one complete event");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body.slice(0, -1)); }
  catch { throw new Error("matrix-started journal contains malformed JSON"); }
  return validatePiMatrixStartedEvent(parsed);
}

function readPiMatrixStartedEventIfPresent(path: string): PiMatrixStartedEvent | undefined {
  try { return readPiMatrixStartedEvent(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function reconcilePiMatrixStartedEvent(
  path: string,
  parent: string,
  persisted: PiMatrixStartedEvent,
  expected: Omit<PiMatrixStartedEvent, "schemaVersion" | "type" | "timestamp">,
  dependencies: PiMatrixStartDependencies,
): PiMatrixStartedEvent {
  validatePiMatrixStartedEvent({ schemaVersion: MATRIX_START_EVENT_SCHEMA_VERSION, type: "matrix-started", timestamp: persisted.timestamp, ...expected });
  if (!matrixStartedIdentityEqual(persisted, expected)) {
    throw new Error("matrix-started recovery identity does not match the current protected launch");
  }
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  fsyncDirectory(parent);
  dependencies.afterParentFsync?.();
  const reread = readPiMatrixStartedEvent(path);
  if (!matrixStartedIdentityEqual(reread, expected) || reread.timestamp !== persisted.timestamp) {
    throw new Error("matrix-started recovery readback does not match the current protected launch");
  }
  return Object.freeze(reread);
}

function validatePiMatrixStartedEvent(input: unknown): PiMatrixStartedEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("matrix-started event must be an object");
  const row = input as Record<string, unknown>;
  const keys = ["schemaVersion", "type", "timestamp", "deploymentId", "authorizationId", "ticketId", "branch", "featureSha", "candidateHead", "matrixSource", "matrixAuthoritySha256", "matrixApprovalEvidence", "repoKey", "repoRoot", "worktreeRoot"].sort();
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(keys)
    || row["schemaVersion"] !== MATRIX_START_EVENT_SCHEMA_VERSION || row["type"] !== "matrix-started") {
    throw new Error("matrix-started event schema is invalid");
  }
  for (const field of keys.filter((key) => key !== "schemaVersion" && key !== "type")) {
    if (typeof row[field] !== "string" || row[field].length === 0) throw new Error(`matrix-started event ${field} is invalid`);
  }
  const timestamp = String(row["timestamp"]);
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== timestamp
    || !REVIEW_AUTHORIZATION.test(String(row["authorizationId"]))
    || !GIT_SHA.test(String(row["featureSha"])) || !GIT_SHA.test(String(row["candidateHead"]))
    || row["candidateHead"] !== row["featureSha"] || !SHA256.test(String(row["matrixAuthoritySha256"]))) {
    throw new Error("matrix-started event authority format is invalid");
  }
  return row as unknown as PiMatrixStartedEvent;
}

function matrixStartedIdentityEqual(
  persisted: PiMatrixStartedEvent,
  expected: Omit<PiMatrixStartedEvent, "schemaVersion" | "type" | "timestamp"> | PiMatrixStartedEvent,
): boolean {
  return persisted.deploymentId === expected.deploymentId && persisted.authorizationId === expected.authorizationId
    && persisted.ticketId === expected.ticketId && persisted.branch === expected.branch
    && persisted.featureSha === expected.featureSha && persisted.candidateHead === expected.candidateHead
    && persisted.matrixSource === expected.matrixSource
    && persisted.matrixAuthoritySha256 === expected.matrixAuthoritySha256
    && persisted.matrixApprovalEvidence === expected.matrixApprovalEvidence && persisted.repoKey === expected.repoKey
    && persisted.repoRoot === expected.repoRoot && persisted.worktreeRoot === expected.worktreeRoot;
}

function assertSecureMatrixStartParent(parent: string): void {
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
    throw new Error("matrix-started parent must be a private real directory");
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** A separately approved baseline pins the prospective consumer; it never grants reuse of existing history. */
export function approvedPiNixosDeploymentId(request: DeployRequest): string | undefined {
  if (!request.objective?.includes("Prerequisite Baseline")) return undefined;
  const objective = parseReviewObjective(request.objective);
  const matrix = readApprovedMatrix(objective["Matrix Source"]);
  const reference = objectiveBaseline(objective, matrix.profile);
  if (!reference) return undefined;
  const location = resolve(getAiUsageDir(), reference.source);
  const info = lstatSync(location);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 1_048_576 || realpathSync(location) !== location) throw launchError("baseline deployment identity", "baseline source is not one bounded canonical regular artifact");
  const bytes = readFileSync(location);
  if (createHash("sha256").update(bytes).digest("hex") !== reference.digest) throw launchError("baseline deployment identity", "approved raw baseline digest drifted");
  const baseline = parseNixosBaseline(bytes);
  const tuple = baseline.tuple;
  // Baseline schema parsing alone is broader than the existing reservation identity domain.
  // Reject before allocating a workspace; never substitute a different consumer for approval.
  try { validateCanonicalDeploymentId(tuple.reviewDeploymentId); }
  catch { throw launchError("baseline deployment identity", "approved prospective consumer must match the reservation identity d- followed by six lowercase hexadecimal characters"); }
  const canonical = resolveRepoExecutionPath(request.repo, process.cwd(), { allowLinkedWorktreeCwd: request.repo === undefined });
  if (canonical.repoKey !== tuple.repoKey || canonical.repoRoot !== tuple.canonicalRoot) throw launchError("baseline canonical identity", "separately approved baseline and registered repository identity conflict");
  const approvals = new TicketStore().get(objective["Ticket"])?.comments.filter((comment) => comment.id === reference.approvalEvidence) ?? [];
  if (approvals.length !== 1 || approvals[0]!.author.toLowerCase() !== "sinh" || reference.approvalEvidence === approvalCommentReference(objective["Matrix Approval Evidence"])) throw launchError("baseline deployment identity", "unique separate durable Sinh approval is required");
  const approval = parseNixosStrictJson(Buffer.from(approvals[0]!.content)) as Record<string, unknown>;
  if (Object.keys(approval).sort().join(",") !== "digest,schemaVersion,source,tupleDigest" || approval["schemaVersion"] !== NIXOS_APPROVAL_VERSION
    || approval["source"] !== reference.source || approval["digest"] !== reference.digest || approval["tupleDigest"] !== nixosTupleDigest(tuple)
    || tuple.ticket !== objective["Ticket"] || tuple.branch !== objective["Branch"] || tuple.featureSha !== objective["Feature SHA"]
    || tuple.matrixSource !== objective["Matrix Source"] || tuple.matrixDigest !== objective["Matrix Authority SHA-256"]
    || tuple.matrixApprovalEvidence !== approvalCommentReference(objective["Matrix Approval Evidence"]) || tuple.authorizationId !== objective["Review Authorization ID"]
    || tuple.repoKey !== matrix.header.repositoryKey || getDeploymentEvents(tuple.reviewDeploymentId).length !== 0
    || queryReviewAuthorizationClaim(tuple.authorizationId) !== null) throw launchError("baseline deployment identity", "approved prospective tuple is conflicting or its deployment/authorization already has durable history");
  const workspace = getDeployPaths(tuple.reviewDeploymentId).deployDir;
  mkdirSync(dirname(workspace), { recursive: true, mode: 0o700 });
  try { mkdirSync(workspace, { mode: 0o700 }); }
  catch { throw launchError("baseline deployment identity", "the separately approved prospective deployment workspace is unavailable or already exists; preserve it"); }
  return tuple.reviewDeploymentId;
}

/** Runtime-owned authority parsing before candidate selection; no caller-supplied checkout path. */
export function authorizePiReviewSelection(request: DeployRequest, repository: { repoKey: string; repoRoot: string }): {
  binding: { repoKey: string; repoRoot: string; ticket: string; branch: string; baseSha: string; featureSha: string;
    approvedReference: NonNullable<ReviewCheckoutEvidence["approvedReference"]> };
  authorizationId: string;
} {
  if (request.background !== true || request.resume) throw launchError("review launch mode", "review requires one fresh background deployment");
  const objective = parseReviewObjective(request.objective);
  const matrix = readApprovedMatrix(objective["Matrix Source"]);
  const ticket = new TicketStore().get(objective["Ticket"]);
  const approval = ticket?.comments.find((comment) => comment.id === approvalCommentReference(objective["Matrix Approval Evidence"]));
  if (request.ticket !== objective["Ticket"] || !GIT_SHA.test(objective["Feature SHA"])
    || !REVIEW_AUTHORIZATION.test(objective["Review Authorization ID"]) || !GIT_SHA.test(matrix.header.approvedBaseSha)
    || matrix.header.repositoryKey !== repository.repoKey || matrix.header.ticketId !== request.ticket
    || matrix.header.featureBranch !== objective["Branch"] || matrix.digest !== objective["Matrix Authority SHA-256"]
    || matrix.header.matrixAuthoritySha256 !== matrix.digest || matrix.header.matrixApprovalEvidence !== objective["Matrix Approval Evidence"]
    || !approval || approval.author.toLowerCase() !== "sinh"
    || occurrences(approval.content, objective["Matrix Source"]) !== 1 || occurrences(approval.content, matrix.digest) !== 1) {
    throw launchError("pre-plan protected review authority", "objective, approved matrix header/digest and durable approval do not agree");
  }
  objectiveBaseline(objective, matrix.profile);
  assertApprovedMatrixEnvironment(matrix.environmentSection, matrix.profile, { PA_TICKET_ID: objective["Ticket"], PA_FEATURE_SHA: objective["Feature SHA"],
    PA_MATRIX_SOURCE: objective["Matrix Source"], PA_MATRIX_AUTHORITY_SHA256: matrix.digest, PA_MATRIX_APPROVAL_EVIDENCE: objective["Matrix Approval Evidence"],
    PA_APPROVED_BASE_SHA: matrix.header.approvedBaseSha, PA_EXPECTED_BRANCH: objective["Branch"], CI: matrix.profile === "current" ? "1" : "true", HOME: "/home/sinh", LANG: "C.UTF-8", TZ: "UTC" });
  const approvedReference = Object.freeze({ sha: matrix.header.approvedBaseSha, matrixSource: objective["Matrix Source"],
    matrixAuthoritySha256: matrix.digest, matrixApprovalEvidence: objective["Matrix Approval Evidence"] });
  const binding = { repoKey: repository.repoKey, repoRoot: repository.repoRoot, ticket: objective["Ticket"], branch: objective["Branch"],
    baseSha: matrix.header.historicalMaterializationBaseSha, featureSha: objective["Feature SHA"], approvedReference };
  assertPiApprovedReviewReference(binding);
  return { binding, authorizationId: objective["Review Authorization ID"] };
}

/** Reauthenticate the pinned reference from durable artifact bytes and Sinh's matrix approval on every protected reread. */
export function assertPiApprovedReviewReference(binding: Pick<ReviewCheckoutEvidence, "repoKey" | "ticket" | "branch" | "baseSha" | "approvedReference">): void {
  const reference = binding.approvedReference;
  if (!reference || !GIT_SHA.test(reference.sha) || !GIT_SHA.test(binding.baseSha)) {
    throw launchError("approved review reference", "explicit full historical base and independently approved reference are required");
  }
  const matrix = readApprovedMatrix(reference.matrixSource);
  const approval = new TicketStore().get(binding.ticket)?.comments.find((comment) =>
    comment.id === approvalCommentReference(reference.matrixApprovalEvidence));
  if (matrix.header.repositoryKey !== binding.repoKey || matrix.header.ticketId !== binding.ticket
    || matrix.header.featureBranch !== binding.branch || matrix.header.historicalMaterializationBaseSha !== binding.baseSha
    || matrix.header.approvedBaseSha !== reference.sha || reference.sha !== repositoryPrerequisiteBase(matrix.prerequisites[0]!)
    || matrix.digest !== reference.matrixAuthoritySha256 || matrix.header.matrixAuthoritySha256 !== matrix.digest
    || matrix.header.matrixApprovalEvidence !== reference.matrixApprovalEvidence
    || !approval || approval.author.toLowerCase() !== "sinh"
    || occurrences(approval.content, reference.matrixSource) !== 1 || occurrences(approval.content, matrix.digest) !== 1) {
    throw launchError("approved review reference", "historical provenance, approved current reference and durable matrix approval conflict or drifted");
  }
}

export async function createPiProtectedValidationLaunch(input: PiValidationLaunchInput): Promise<PiProtectedValidationLaunch> {
  const { deploymentId, request, plan, environment } = input;
  if (!isPiProtectedReviewRequest(request, plan)) {
    throw launchError("production launch route", "protected validation launch construction was requested for a non-review deployment");
  }
  if (request.background !== true || request.resume) {
    throw launchError("review launch mode", "requirements/review-auto must be one fresh background deployment");
  }

  const objective = parseReviewObjective(request.objective);
  const ticketId = objective["Ticket"];
  const branch = objective["Branch"];
  const featureSha = objective["Feature SHA"];
  const matrixSource = objective["Matrix Source"];
  const matrixAuthoritySha256 = objective["Matrix Authority SHA-256"];
  const matrixApprovalEvidence = objective["Matrix Approval Evidence"];
  const authorizationId = objective["Review Authorization ID"];
  if (!GIT_SHA.test(featureSha) || !SHA256.test(matrixAuthoritySha256) || !REVIEW_AUTHORIZATION.test(authorizationId)) {
    throw launchError("review objective authority", "feature, matrix, or one-use authorization format is invalid");
  }
  if (request.ticket !== ticketId || plan.ticket !== ticketId) {
    throw launchError("review ticket binding", "request, immutable plan, and objective ticket do not match");
  }
  if (plan.runtime !== "pi" || plan.team !== "requirements" || plan.repositoryCwd !== plan.worktreeRoot
    || plan.environment.PA_REPO !== plan.worktreeRoot || plan.environment.PA_WORKTREE_ROOT !== plan.worktreeRoot
    || plan.environment.PA_REPO_ROOT !== plan.repoRoot
    || plan.environment.PA_DEPLOYMENT_DIR !== input.deploymentDirectory) {
    throw launchError("review repository identity", "immutable Pi canonical, authenticated worktree, and deployment workspace identity domains do not agree");
  }

  const matrix = readApprovedMatrix(matrixSource);
  const baseline = objectiveBaseline(objective, matrix.profile);
  if (!plan.reviewCheckout?.approvedReference) throw launchError("approved review reference", "fresh production review requires independent durable reference authority");
  assertPiApprovedReviewReference(plan.reviewCheckout);
  if (plan.reviewCheckout.approvedReference.matrixSource !== matrixSource
    || plan.reviewCheckout.approvedReference.matrixAuthoritySha256 !== matrixAuthoritySha256
    || plan.reviewCheckout.approvedReference.matrixApprovalEvidence !== matrixApprovalEvidence) {
    throw launchError("approved review reference", "selected reference and protected objective authority conflict");
  }
  const manifestEnvironment = matrixEnvironment(environment, {
    ticketId,
    featureSha,
    matrixSource,
    matrixAuthoritySha256,
    matrixApprovalEvidence,
    worktreeRoot: plan.worktreeRoot,
    approvedBaseSha: matrix.header.approvedBaseSha,
    branch,
  }, matrix.profile);
  assertApprovedMatrixEnvironment(matrix.environmentSection, matrix.profile, manifestEnvironment);
  assertRepositoryGitIdentity(plan.worktreeRoot, plan.reviewCheckout.repositoryGitDir, plan.reviewCheckout.repositoryGitCommonDir);
  const snapshot = captureRepositoryGitSnapshot(plan.worktreeRoot);
  // The immutable PA plan is not a complete subprocess environment. Resolve the
  // branch tip with the same explicit PATH/HOME used by every matrix prerequisite.
  const selectedTip = probe("git", ["rev-parse", "--verify", `refs/heads/${branch}`], manifestEnvironment, plan.worktreeRoot);
  if (snapshot.branch !== branch || snapshot.head !== featureSha || snapshot.head !== selectedTip
    || snapshot.head !== plan.reviewCheckout.headSha || snapshot.dirty) {
    throw launchError("candidate HEAD at prerequisite start", "authenticated HEAD, exact branch ref, selected tip and Feature SHA must agree without inference");
  }
  const ticket = new TicketStore().get(ticketId);
  if (!ticket) throw launchError("durable ticket", "the review ticket is absent");
  const linked = ticket.linkedBranches.filter((value) => value.repo === plan.repoKey && value.branch === branch);
  const linkedBranchMatches = linked.length === 1 && linked[0]?.state === "materialized"
    && linked[0].headSha === featureSha && linked[0].baseSha === matrix.header.historicalMaterializationBaseSha
    && linked[0].baseSha === plan.reviewCheckout.baseSha;
  const approvalCommentId = approvalCommentReference(matrixApprovalEvidence);
  const approval = ticket.comments.find((comment) => comment.id === approvalCommentId);
  const prerequisiteBudgetStartedMs = baseline ? writePiNixosBudget(input.deploymentDirectory, deploymentId) : undefined;
  let matrixStart: PiMatrixStartedEvent;
  try {
    matrixStart = writePiMatrixStartedEvent({
      deploymentDirectory: input.deploymentDirectory,
      event: {
        deploymentId,
        authorizationId,
        ticketId,
        branch,
        featureSha,
        candidateHead: snapshot.head!,
        matrixSource,
        matrixAuthoritySha256,
        matrixApprovalEvidence,
        repoKey: plan.repoKey,
        repoRoot: plan.repoRoot,
        worktreeRoot: plan.worktreeRoot,
      },
    });
  } catch (error) {
    throw launchError("durable matrix-start boundary", error instanceof Error ? error.message : String(error));
  }
  const context: PrerequisiteContext = {
    approval,
    authorizationId,
    branch,
    environment: manifestEnvironment,
    featureSha,
    input,
    linkedBranchMatches,
    matrix,
    matrixApprovalEvidence,
    matrixAuthoritySha256,
    matrixSource,
    snapshot,
    ticketId,
  };
  const claim = matrix.profile === "current" ? evaluatePrerequisites(context) : evaluateNixosLaunchAuthority(context);
  const repository = {
    repoKey: plan.repoKey,
    canonicalRoot: plan.repoRoot,
    worktreeRoot: plan.worktreeRoot,
  };
  const manifest: ValidationManifest = {
    schemaVersion: VALIDATION_MANIFEST_SCHEMA_VERSION,
    ticketId: claim.ticketId,
    branch: claim.branch,
    featureSha: claim.featureSha,
    matrix: {
      source: claim.matrixSource,
      authoritySha256: claim.matrixAuthoritySha256,
      approvalEvidence: claim.matrixApprovalEvidence,
    },
    repository,
    environment: manifestEnvironment,
    commands: matrix.commands.map((command, index): ValidationCommandSpec => ({
      id: `command-${String(index + 1).padStart(2, "0")}`,
      command,
      cwd: plan.worktreeRoot,
      timeoutSeconds: 1_800,
      maxOutputBytes: 1_073_741_824,
      artifacts: [],
    })),
  };
  const protectedEnvironment = Object.fromEntries(
    Object.keys(manifestEnvironment).filter((name) => name.startsWith("PA_")).map((name) => [name, manifestEnvironment[name]]),
  ) as Record<string, string>;
  const authority: ValidationAuthorityBinding = {
    ticketId: claim.ticketId,
    branch: claim.branch,
    featureSha: claim.featureSha,
    matrixSource: claim.matrixSource,
    matrixAuthoritySha256: claim.matrixAuthoritySha256,
    matrixApprovalEvidence: claim.matrixApprovalEvidence,
    repository,
    protectedEnvironment,
  };
  const validationHandoff: ValidationHandoff = {
    schemaVersion: VALIDATION_HANDOFF_SCHEMA_VERSION,
    manifestSha256: digestValidationManifest(manifest),
    manifest,
    repositoryEvidence: {
      ...repository,
      ticketId: claim.ticketId,
      branch: claim.branch,
      featureSha: claim.featureSha,
      authenticated: true,
    },
    protectedEnvironment,
  };
  const launch: PiPrerequisiteGateBinding = {
    deploymentId,
    matrixProfile: matrix.profile,
    historicalBaseProvenance: matrix.historicalBaseProvenance,
    ...(baseline ? { nixosBaseline: baseline, prerequisiteBudgetStartedMs } : {}),
    validationHandoff,
    authority,
    review: {
      ...(plan.reviewCheckout ? { checkout: (() => {
        const { repositoryGitDir: _git, repositoryGitCommonDir: _common, gitSnapshot: _snapshot, ...identity } = plan.reviewCheckout;
        return identity;
      })() } : {}),
      reviewDeploymentId: claim.deploymentId,
      candidateHead: matrixStart.candidateHead,
      prerequisiteStartedAt: matrixStart.timestamp,
      authorizationId: claim.authorizationId,
      ticketId: claim.ticketId,
      branch: claim.branch,
      featureSha: claim.featureSha,
      matrixSource: claim.matrixSource,
      matrixAuthoritySha256: claim.matrixAuthoritySha256,
      matrixApprovalEvidence: claim.matrixApprovalEvidence,
    },
  };
  if (baseline) await withPiNixosPrerequisites(launch, () => undefined);
  // Copied clauses become verified only after every actual prerequisite observation succeeds.
  return Object.freeze({ ...launch, schemaVersion: PI_PROTECTED_VALIDATION_SCHEMA_VERSION,
    admission: { authorization: "consumed" as const, matrixDigest: "verified" as const, featureSha: "verified" as const,
      approval: "verified" as const, activeReview: "admitted" as const,
      prerequisites: matrix.prerequisites.map((text, index) => Object.freeze({ sourceOrder: index + 1, text, status: "verified" as const })) } });
}

function parseReviewObjective(input: string | undefined): ReviewObjective {
  if (!input) throw launchError("review objective", "protected review authority fields are absent");
  if (input.includes("\r")) throw launchError("review objective", "authority contains forbidden carriage-return drift");
  const lines = input.split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw launchError("review objective", "authority contains blank, leading, or trailing line drift");
  }
  const values = new Map<string, string>();
  for (const line of lines) {
    const delimiter = line.indexOf(": ");
    const label = delimiter > 0 ? line.slice(0, delimiter) : "";
    const value = delimiter > 0 ? line.slice(delimiter + 2) : "";
    if (!ALLOWED_OBJECTIVE_FIELDS.has(label) || !isExactAuthorityValue(value) || values.has(label)) {
      throw launchError("review objective", "authority is malformed, duplicated, whitespace-drifted, or contains an unsupported clause");
    }
    values.set(label, value);
  }
  for (const field of REQUIRED_OBJECTIVE_FIELDS) {
    if (!values.has(field)) throw launchError("review objective", "one or more protected review authority fields are absent");
  }
  const baselineCount = BASELINE_FIELDS.filter((field) => values.has(field)).length;
  if (baselineCount !== 0 && baselineCount !== BASELINE_FIELDS.length) throw launchError("baseline transport", "baseline source/digest/approval must be all present or all absent");
  return Object.fromEntries(values) as ReviewObjective;
}

function isExactAuthorityValue(value: string): boolean {
  if (!value || value.startsWith(" ") || value.endsWith(" ")) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if ((/\s/u.test(character) && character !== " ") || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function approvalCommentReference(evidence: string): string {
  const matches = evidence.match(/\bc-[0-9]{8,}\b/g) ?? [];
  if (matches.length !== 1) throw launchError("matrix approval evidence", "approval must name exactly one durable ticket comment");
  return matches[0]!;
}

function readApprovedMatrix(source: string): ApprovedMatrix {
  if (isAbsolute(source) || source.split(/[\\/]/).includes("..")) {
    throw launchError("matrix source", "matrix source must be one normalized AI-usage-relative path");
  }
  const root = resolve(getAiUsageDir());
  const path = resolve(root, source);
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw launchError("matrix source", "matrix source escapes the durable AI-usage root");
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 1_048_576 || realpathSync(path) !== path) {
    throw launchError("matrix source", "matrix source is not one exact canonical regular file");
  }
  const bytes = readFileSync(path);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw launchError("matrix source", "matrix source is not valid raw UTF-8"); }
  const parsed = parseMatrixCompatibility(extractMatrixAuthority(bytes));
  if (parsed.matrixSource !== source) throw launchError("matrix source", "parsed source and durable artifact path conflict");
  const approvedBaseSha = exactHeaderValue(text, "Approved Base SHA");
  const repositoryKey = exactHeaderValue(text, "Repository Key");
  const ticketId = exactHeaderValue(text, "Ticket");
  const featureBranch = exactHeaderValue(text, "Feature Branch");
  const historicalHeaders = text.split("\n").filter((line) => /^\s*>\s*Historical\s+Materialization\s+Base\s+SHA\s*:/.test(line));
  const historicalBaseProvenance = historicalHeaders.length === 0 ? "materialized-ticket-link" : "header";
  const historicalMaterializationBaseSha = historicalHeaders.length === 0
    ? historicalBaseFromTicket(repositoryKey, ticketId, featureBranch, approvedBaseSha)
    : exactHeaderValue(text, "Historical Materialization Base SHA");
  assertApprovedMatrixEnvironment(parsed.environmentSection, parsed.profile);
  return {
    profile: parsed.profile,
    historicalBaseProvenance,
    authority: parsed.authority,
    digest: parsed.digest,
    header: {
      approvedBaseSha,
      historicalMaterializationBaseSha,
      featureBranch,
      matrixApprovalEvidence: exactHeaderValue(text, "Matrix Approval Evidence"),
      matrixAuthoritySha256: exactHeaderValue(text, "Matrix Authority SHA-256"),
      repositoryKey,
      ticketId,
    },
    prerequisites: parsed.prerequisites,
    environmentSection: parsed.environmentSection,
    commands: parsed.commands,
  };
}

function assertApprovedMatrixEnvironment(environmentSection: string, profile: MatrixProfile, expected?: Record<string, string>): void {
  const spans = [...environmentSection.matchAll(/`([^`\r\n]*)`/g)];
  if (occurrences(environmentSection, "`") !== spans.length * 2) {
    throw launchError("matrix environment", "the approved matrix command environment contains malformed backtick code spans");
  }

  const required: readonly string[] = profile === "current" ? MATRIX_ENVIRONMENT_NAMES : ["PA_APPROVED_BASE_SHA", "PA_EXPECTED_BRANCH", "PA_WORKTREE_ROOT", "CI"];
  const approved = new Set<string>([...MATRIX_ENVIRONMENT_NAMES, ...(profile === "nixos" ? required : [])]);
  const counts = new Map<string, number>([...approved].map((name) => [name, 0]));
  for (const span of spans) {
    const representation = span[1]!;
    const delimiter = representation.indexOf("=");
    if (delimiter === -1) {
      if (approved.has(representation)) {
        if (["CI", "HOME", "LANG", "TZ", "PA_APPROVED_BASE_SHA", "PA_EXPECTED_BRANCH", "PA_TICKET_ID", "PA_MATRIX_SOURCE"].includes(representation)) throw launchError("matrix environment", "static approved environment values require exact assignments, not mere variable presence");
        counts.set(representation, counts.get(representation)! + 1);
      }
      else if (representation !== "HEAD") {
        throw launchError("matrix environment", "the approved matrix command environment contains a malformed or empty assignment representation or unknown variable");
      }
      continue;
    }

    const name = representation.slice(0, delimiter);
    const value = representation.slice(delimiter + 1);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !isExactAuthorityValue(value)) {
      throw launchError("matrix environment", "the approved matrix command environment contains a malformed or empty assignment representation");
    }
    if (!approved.has(name)) {
      throw launchError("matrix environment", "the approved matrix contains a non-approved extra command environment");
    }
    counts.set(name, counts.get(name)! + 1);
    const fixed = { CI: profile === "current" ? "1" : "true", HOME: "/home/sinh", LANG: "C.UTF-8", TZ: "UTC" } as Record<string, string>;
    const valueExpected = expected?.[name] ?? fixed[name];
    if (valueExpected !== undefined && value !== valueExpected) throw launchError("matrix environment", "approved environment assignment value conflicts with the exact launch binding");
  }
  if (required.some((name) => counts.get(name) !== 1) || [...counts.values()].some((count) => count > 1)) {
    throw launchError("matrix environment", "the approved matrix does not name each required environment value exactly once");
  }
}

function evaluatePrerequisites(context: PrerequisiteContext): ReviewAuthorizationClaim {
  evaluateRepositoryPrerequisite(context, context.matrix.prerequisites[0]!);
  evaluateToolPrerequisite(context, context.matrix.prerequisites[1]!);
  evaluateArtifactPrerequisite(context, context.matrix.prerequisites[2]!);
  return evaluateAuthorizationPrerequisite(context, context.matrix.prerequisites[3]!);
}

function evaluateRepositoryPrerequisite(context: PrerequisiteContext, prerequisite: string): void {
  const match = /^Linux `([^`]+)`; canonical repository `([^`]+)`; authenticated ticket checkout on `([^`]+)`; clean tracked and untracked state; `HEAD` equals the launch-intent Feature SHA and descends from `([0-9a-f]{40})`\.$/.exec(prerequisite);
  if (!match) throw launchError("matrix prerequisite 1", "the repository/platform prerequisite is not the complete approved contract");
  const [, architecture, repoKey, branch, baseSha] = match;
  const { input, snapshot } = context;
  if (process.platform !== "linux" || architecture !== "x86_64" || process.arch !== "x64") {
    throw launchError("matrix prerequisite 1", "the exact Linux architecture prerequisite is unmet");
  }
  if (repoKey !== input.plan.repoKey || branch !== context.branch || snapshot.branch !== context.branch
    || snapshot.head !== context.featureSha || snapshot.dirty || !context.linkedBranchMatches) {
    throw launchError("matrix prerequisite 1", "canonical repository, authenticated clean checkout, branch, HEAD, or durable ticket binding is unmet");
  }
  if ([baseSha!, context.matrix.header.historicalMaterializationBaseSha].some((base) =>
    !gitSucceeds(input.plan.worktreeRoot, context.environment, ["cat-file", "-e", `${base}^{commit}`])
    || !gitSucceeds(input.plan.worktreeRoot, context.environment, ["merge-base", "--is-ancestor", base, context.featureSha]))) {
    throw launchError("matrix prerequisite 1", "the approved base commit is absent or is not an ancestor of the Feature SHA");
  }
}

function evaluateToolPrerequisite(context: PrerequisiteContext, prerequisite: string): void {
  const match = /^Node\.js `([^`]+)`, pnpm `([^`]+)` through Corepack, Pi `([^`]+)`, Git, Bash, Nix, and the repository's existing installed dependencies including (.+)\.$/.exec(prerequisite);
  if (!match) throw launchError("matrix prerequisite 2", "the tool/dependency prerequisite is not the complete approved contract");
  const [, nodeVersion, pnpmVersion, piVersion, dependencyText] = match;
  if (probe("node", ["--version"], context.environment) !== nodeVersion
    || probe("corepack", ["pnpm", "--version"], context.environment) !== pnpmVersion
    || probe("pi", ["--version"], context.environment) !== piVersion
    || probe("git", ["--version"], context.environment) === undefined
    || probe("bash", ["--version"], context.environment) === undefined
    || probe("nix", ["--version"], context.environment) === undefined) {
    throw launchError("matrix prerequisite 2", "one or more exact platform tool versions or executables are unavailable");
  }
  const dependencySpecs = [...dependencyText.matchAll(/`([^`]+)`/g)].map((value) => value[1]!);
  if (dependencySpecs.length === 0 || dependencyText !== dependencySpecs.map((value) => `\`${value}\``).join(", ")) {
    throw launchError("matrix prerequisite 2", "the exact installed dependency list is malformed");
  }
  for (const specification of dependencySpecs) assertInstalledDependency(context.input.plan.worktreeRoot, specification);
}

function evaluateArtifactPrerequisite(context: PrerequisiteContext, prerequisite: string): void {
  const match = /^The approved requirements artifact exists at `([^`]+)` and its header, durable ([A-Z]+-[0-9]+) approval comment, launch intent, and recomputed raw matrix digest agree exactly\.$/.exec(prerequisite);
  if (!match) throw launchError("matrix prerequisite 3", "the artifact/approval prerequisite is not the complete approved contract");
  const [, artifactPath, approvalTicket] = match;
  const expectedPath = resolve(getAiUsageDir(), context.matrixSource);
  const header = context.matrix.header;
  if (artifactPath !== expectedPath || approvalTicket !== context.ticketId
    || header.repositoryKey !== context.input.plan.repoKey || header.ticketId !== context.ticketId
    || header.featureBranch !== context.branch || header.matrixAuthoritySha256 !== context.matrixAuthoritySha256
    || header.matrixApprovalEvidence !== context.matrixApprovalEvidence
    || header.approvedBaseSha !== repositoryPrerequisiteBase(context.matrix.prerequisites[0]!)) {
    throw launchError("matrix prerequisite 3", "requirements artifact header, objective, or launch binding does not agree byte-for-byte");
  }
  // The lossless parser has already required exactly one source equal to the durable read path in either layout.
  if (context.matrix.digest !== context.matrixAuthoritySha256) {
    throw launchError("matrix prerequisite 3", "matrix source or recomputed raw authority digest does not agree exactly");
  }
  if (!context.approval || context.approval.author.toLowerCase() !== "sinh"
    || occurrences(context.approval.content, context.matrixSource) !== 1
    || occurrences(context.approval.content, context.matrixAuthoritySha256) !== 1) {
    throw launchError("matrix prerequisite 3", "the named durable Sinh approval comment does not bind the exact matrix source and digest");
  }
}

function evaluateAuthorizationPrerequisite(context: PrerequisiteContext, prerequisite: string): ReviewAuthorizationClaim {
  const expected = "The trusted launcher has atomically consumed the one-use review authorization, rejected duplicate active review lineage, and supplied the complete explicit command environment. The authorization ID is excluded from command child environments, logs, activity progress, and ledger artifacts; it is supplied separately to the reviewer for exact objective, report, and registry agreement. No project command starts before these checks pass.";
  if (prerequisite !== expected) throw launchError("matrix prerequisite 4", "the authorization/environment prerequisite is not the complete approved contract");
  assertExactCommandEnvironment(context);
  try {
    return claimReviewAuthorization({
      deploymentId: context.input.deploymentId,
      authorizationId: context.authorizationId,
      ticketId: context.ticketId,
      branch: context.branch,
      featureSha: context.featureSha,
      matrixSource: context.matrixSource,
      matrixAuthoritySha256: context.matrixAuthoritySha256,
      matrixApprovalEvidence: context.matrixApprovalEvidence,
      objective: context.input.request.objective!,
    });
  } catch (error) {
    throw launchError("matrix prerequisite 4", error instanceof Error ? error.message : String(error));
  }
}

function assertExactCommandEnvironment(context: PrerequisiteContext): void {
  const expected = [...MATRIX_ENVIRONMENT_NAMES].sort();
  if (JSON.stringify(Object.keys(context.environment).sort()) !== JSON.stringify(expected)
    || context.environment["PA_REPO"] !== context.input.plan.worktreeRoot
    || context.environment["PA_TICKET_ID"] !== context.ticketId
    || context.environment["PA_FEATURE_SHA"] !== context.featureSha
    || context.environment["PA_MATRIX_SOURCE"] !== context.matrixSource
    || context.environment["PA_MATRIX_AUTHORITY_SHA256"] !== context.matrixAuthoritySha256
    || context.environment["PA_MATRIX_APPROVAL_EVIDENCE"] !== context.matrixApprovalEvidence
    || context.environment["CI"] !== "1" || context.environment["HOME"] !== "/home/sinh"
    || context.environment["LANG"] !== "C.UTF-8" || context.environment["TZ"] !== "UTC"
    || !context.environment["PATH"] || context.environment["PATH"] !== process.env["PATH"]
    || Object.hasOwn(context.environment, "PA_REVIEW_AUTHORIZATION_ID")
    || Object.values(context.environment).includes(context.authorizationId)) {
    throw launchError("matrix prerequisite 4", "the complete explicit command environment is absent, ambient, or mismatched");
  }
}

function exactHeaderValue(text: string, label: string): string {
  const prefix = `> ${label}:`;
  const candidates = text.split("\n").filter((line) => line.startsWith(prefix));
  const match = candidates.length === 1 ? new RegExp(`^${escapeRegExp(prefix)} (.+)$`).exec(candidates[0]!) : null;
  if (!match?.[1] || !isExactAuthorityValue(match[1])) {
    throw launchError("requirements header", `exactly one byte-exact approved ${label} header line is required`);
  }
  return match[1];
}

function repositoryPrerequisiteBase(prerequisite: string): string {
  const match = /(?: descends from `([0-9a-f]{40})`\.$| from approved base `([0-9a-f]{40})`,)/.exec(prerequisite);
  const base = match?.[1] ?? match?.[2];
  if (!base) throw launchError("matrix prerequisite 1", "the approved base SHA is absent");
  return base;
}

function gitSucceeds(cwd: string, environment: Record<string, string>, args: string[]): boolean {
  return probe("git", args, environment, cwd) !== undefined;
}

function probe(command: string, args: string[], environment: Record<string, string>, cwd?: string): string | undefined {
  try {
    return execFileSync(command, args, {
      ...(cwd ? { cwd } : {}),
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function assertInstalledDependency(worktreeRoot: string, specification: string): void {
  const separator = specification.lastIndexOf("@");
  if (separator <= 0) throw launchError("matrix prerequisite 2", "an installed dependency version is malformed");
  const name = specification.slice(0, separator);
  const version = specification.slice(separator + 1);
  try {
    const packageJson = JSON.parse(readFileSync(resolve(worktreeRoot, "node_modules", name, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (packageJson.name !== name || packageJson.version !== version) throw new Error("dependency mismatch");
  } catch {
    throw launchError("matrix prerequisite 2", `installed dependency ${name} does not match the approved exact version`);
  }
}

function occurrences(input: string, value: string): number {
  return input.split(value).length - 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matrixEnvironment(
  environment: Record<string, string>,
  binding: {
    ticketId: string;
    featureSha: string;
    matrixSource: string;
    matrixAuthoritySha256: string;
    matrixApprovalEvidence: string;
    worktreeRoot: string;
    approvedBaseSha: string;
    branch: string;
  },
  profile: MatrixProfile,
): Record<string, string> {
  const path = environment["PATH"] ?? process.env["PATH"];
  const home = environment["HOME"] ?? process.env["HOME"];
  if (!path || !home || [path, home].some((value) => /review-auth:|\0/.test(value))
    || path.split(":").some((entry) => !entry || !isAbsolute(entry))) throw launchError("trusted command environment", "the trusted launcher has no complete non-authority explicit PATH and HOME");
  return {
    PA_REPO: binding.worktreeRoot,
    PA_TICKET_ID: binding.ticketId,
    PA_FEATURE_SHA: binding.featureSha,
    PA_MATRIX_SOURCE: binding.matrixSource,
    PA_MATRIX_AUTHORITY_SHA256: binding.matrixAuthoritySha256,
    PA_MATRIX_APPROVAL_EVIDENCE: binding.matrixApprovalEvidence,
    ...(profile === "nixos" ? { PA_APPROVED_BASE_SHA: binding.approvedBaseSha, PA_EXPECTED_BRANCH: binding.branch, PA_WORKTREE_ROOT: binding.worktreeRoot } : {}),
    CI: profile === "nixos" ? "true" : "1",
    HOME: home,
    LANG: "C.UTF-8",
    TZ: "UTC",
    PATH: path,
  };
}

function historicalBaseFromTicket(repoKey: string, ticketId: string, branch: string, approvedBase: string): string {
  if (!/^[A-Z]+-[0-9]+$/.test(ticketId)) throw launchError("historical base provenance", "canonical ticket identity is malformed");
  const raw = parseNixosStrictJson(readFileSync(resolve(getTicketsDir(), `${ticketId}.json`))) as { id?: unknown; linkedBranches?: Array<{ repo?: unknown; branch?: unknown; state?: unknown; baseSha?: unknown }> };
  const links = raw.id === ticketId && Array.isArray(raw.linkedBranches) ? raw.linkedBranches.filter((link) => link.repo === repoKey) : [];
  if (links.length !== 1 || links[0]!.state !== "materialized" || links[0]!.branch !== branch
    || links[0]!.baseSha !== approvedBase || !GIT_SHA.test(approvedBase)) {
    throw launchError("historical base provenance", "missing historical header requires exactly one canonical-repository materialized ticket link matching branch and approved base");
  }
  return approvedBase;
}

function objectiveBaseline(objective: ReviewObjective, profile: MatrixProfile): NixosBaselineReference | undefined {
  const present = BASELINE_FIELDS.some((field) => objective[field] !== undefined);
  if (present !== (profile === "nixos")) throw launchError("baseline transport", "all baseline source/digest/approval fields are required for exactly the NixOS profile");
  if (!present) return undefined;
  return parseNixosBaselineReference({ source: objective[BASELINE_FIELDS[0]], digest: objective[BASELINE_FIELDS[1]], approvalEvidence: objective[BASELINE_FIELDS[2]] });
}

function evaluateNixosLaunchAuthority(context: PrerequisiteContext): ReviewAuthorizationClaim {
  const clause = /^The trusted PPA builder launcher has authenticated the ([A-Z]+-[0-9]+) ticket checkout, created `([^`]+)` from approved base `([0-9a-f]{40})`, persisted launch evidence, and produced a committed candidate with a clean worktree\.$/.exec(context.matrix.prerequisites[0]!);
  if (!clause || clause[1] !== context.ticketId || clause[2] !== context.branch || clause[3] !== context.matrix.header.approvedBaseSha
    || !context.linkedBranchMatches || context.snapshot.dirty) throw launchError("NixOS candidate authority", "prerequisite ticket, branch, approved base and authenticated clean candidate do not agree");
  for (const base of [context.matrix.header.approvedBaseSha, context.matrix.header.historicalMaterializationBaseSha]) {
    if (!gitSucceeds(context.input.plan.worktreeRoot, context.environment, ["cat-file", "-e", `${base}^{commit}`])
      || !gitSucceeds(context.input.plan.worktreeRoot, context.environment, ["merge-base", "--is-ancestor", base, context.featureSha])) throw launchError("NixOS base ancestry", "independent historical and approved references must be commit ancestors");
  }
  if (context.matrix.digest !== context.matrixAuthoritySha256 || context.matrix.header.matrixAuthoritySha256 !== context.matrixAuthoritySha256
    || context.matrix.header.repositoryKey !== context.input.plan.repoKey || context.matrix.header.ticketId !== context.ticketId
    || context.matrix.header.featureBranch !== context.branch || context.matrix.header.matrixApprovalEvidence !== context.matrixApprovalEvidence
    || !context.approval || context.approval.author.toLowerCase() !== "sinh"
    || occurrences(context.approval.content, context.matrixSource) !== 1 || occurrences(context.approval.content, context.matrixAuthoritySha256) !== 1) throw launchError("NixOS matrix approval", "header, raw matrix authority and durable separate matrix approval conflict");
  try {
    return claimReviewAuthorization({ deploymentId: context.input.deploymentId, authorizationId: context.authorizationId,
      ticketId: context.ticketId, branch: context.branch, featureSha: context.featureSha, matrixSource: context.matrixSource,
      matrixAuthoritySha256: context.matrixAuthoritySha256, matrixApprovalEvidence: context.matrixApprovalEvidence, objective: context.input.request.objective! });
  } catch (error) { throw launchError("NixOS one-use authority", error instanceof Error ? error.message : "authorization unavailable"); }
}

/** Actual initial and supervisor execution gates share the kernel-monotonic anchor in protected transport. */
export async function withPiNixosPrerequisites<T>(launch: PiPrerequisiteGateBinding, start: () => T,
  rereadCheckout?: () => ReviewCheckoutEvidence): Promise<Awaited<T>> {
  if (!launch.nixosBaseline || launch.prerequisiteBudgetStartedMs === undefined || launch.matrixProfile !== "nixos") throw launchError("NixOS transport", "complete protected baseline and original probe budget are required");
  const handoff = launch.validationHandoff as ValidationHandoff;
  const env = handoff.manifest.environment;
  const probeEnvironment = Object.fromEntries(["PATH", "HOME", "LANG", "TZ"].map((key) => [key, env[key]!])) as Record<string, string>;
  const tools = Object.fromEntries(NIXOS_TOOLS.map((tool) => {
    const matches = env["PATH"]!.split(":").map((entry) => resolve(entry, tool)).filter((entry) => {
      try { return statSync(entry).isFile() && (statSync(entry).mode & 0o111) !== 0; } catch { return false; }
    });
    if (!matches[0]) throw launchError("NixOS trusted tools", "a fixed prerequisite executable is unavailable on the explicit launcher PATH");
    return [tool, realpathSync(matches[0])];
  })) as Record<NixosTool, string>;
  const dependencies = createNixosPrerequisiteDependencies({
    tools, probeEnvironment, budgetStartedMs: launch.prerequisiteBudgetStartedMs,
    rereadAuthority: async () => {
      assertPiNixosBudget(launch);
      const review = launch.review;
      const checkout = review.checkout;
      if (!checkout?.approvedReference) throw launchError("NixOS candidate reread", "authenticated historical/approved candidate provenance is absent");
      assertPiApprovedReviewReference(checkout);
      const matrix = readApprovedMatrix(review.matrixSource);
      if (matrix.profile !== "nixos" || matrix.digest !== review.matrixAuthoritySha256 || matrix.historicalBaseProvenance !== launch.historicalBaseProvenance) throw launchError("NixOS profile reread", "approved source, profile or persisted base provenance drifted");
      assertApprovedMatrixEnvironment(matrix.environmentSection, "nixos", env);
      const canonical = resolveRepoExecutionPath(undefined, checkout.worktreeRoot, { allowLinkedWorktreeCwd: true });
      const receipt = queryReviewAuthorizationClaim(review.authorizationId);
      if (!receipt?.active || receipt.deploymentId !== launch.deploymentId || receipt.ticketId !== review.ticketId || receipt.branch !== review.branch
        || receipt.featureSha !== review.featureSha || receipt.matrixSource !== review.matrixSource || receipt.matrixAuthoritySha256 !== review.matrixAuthoritySha256
        || receipt.matrixApprovalEvidence !== review.matrixApprovalEvidence || canonical.repoKey !== checkout.repoKey || canonical.repoRoot !== checkout.repoRoot) throw launchError("NixOS consumed receipt reread", "durable active consumer or canonical repository binding drifted");
      if (rereadCheckout) {
        if (!launch.reservation) throw launchError("NixOS reservation reread", "protected candidate reservation is absent");
        withPiReviewCandidateAtMatrixBoundary({ launch, reservation: launch.reservation, rereadCheckout }, () => undefined);
      }
      return { tuple: { repoKey: checkout.repoKey, canonicalRoot: checkout.repoRoot, worktreeRoot: checkout.worktreeRoot,
        ticket: review.ticketId, branch: review.branch, featureSha: review.featureSha, matrixSource: review.matrixSource,
        matrixDigest: review.matrixAuthoritySha256, matrixApprovalEvidence: approvalCommentReference(review.matrixApprovalEvidence),
        authorizationId: review.authorizationId, reviewDeploymentId: review.reviewDeploymentId }, environment: env,
        canonicalRepository: { repoKey: canonical.repoKey, repoRoot: canonical.repoRoot },
        authorizationReceipt: { authorizationId: receipt.authorizationId, reviewDeploymentId: receipt.deploymentId },
        prerequisiteStartedMs: launch.prerequisiteBudgetStartedMs! };
    },
  });
  const readSource = dependencies.readSource;
  dependencies.readSource = async (source, signal) => {
    if (source === launch.nixosBaseline!.source) {
      const file = lstatSync(resolve(getAiUsageDir(), source));
      if ((file.mode & 0o777) !== 0o600) throw launchError("protected baseline source", "authorization-bearing raw baseline must remain mode 0600");
    }
    return readSource(source, signal);
  };
  const session = new NixosPrerequisiteSession(launch.nixosBaseline, dependencies);
  const evidenceDirectory = inputSafeDeploymentDirectory(launch);
  const persistObservations = (): void => {
    mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    const evidencePath = resolve(evidenceDirectory, "nixos-prerequisite-observations.jsonl");
    const descriptor = openSync(evidencePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fchmodSync(descriptor, 0o600);
      const observations = Buffer.from(`${JSON.stringify({ observations: session.observations })}\n`);
      let offset = 0;
      while (offset < observations.length) {
        const written = writeSync(descriptor, observations, offset, observations.length - offset);
        if (written <= 0) throw launchError("probe evidence", "durable observation write made no progress");
        offset += written;
      }
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    fsyncDirectory(evidenceDirectory);
  };
  try {
    await session.verify();
    persistObservations();
    const result = await session.executeImmediately(start);
    persistObservations();
    return result;
  } catch (error) { persistObservations(); throw error; }
}

const NIXOS_BUDGET_FILE = "nixos-prerequisite-budget.json";
function writePiNixosBudget(directory: string, deploymentId: string): number {
  const startedMs = Number(process.hrtime.bigint() / 1_000_000n);
  const descriptor = openSync(resolve(directory, NIXOS_BUDGET_FILE), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    const bytes = Buffer.from(JSON.stringify({ deploymentId, startedMs }));
    let offset = 0;
    while (offset < bytes.length) { const written = writeSync(descriptor, bytes, offset, bytes.length - offset); if (written <= 0) throw launchError("probe budget", "protected anchor persistence failed"); offset += written; }
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  fsyncDirectory(directory);
  return startedMs;
}
function assertPiNixosBudget(launch: PiPrerequisiteGateBinding): void {
  const path = resolve(inputSafeDeploymentDirectory(launch), NIXOS_BUDGET_FILE);
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || file.size > 4096) throw launchError("probe budget", "original protected monotonic anchor is unavailable or insecure");
  const anchor = parseNixosStrictJson(readFileSync(path)) as Record<string, unknown>;
  if (Object.keys(anchor).sort().join(",") !== "deploymentId,startedMs" || anchor["deploymentId"] !== launch.deploymentId || anchor["startedMs"] !== launch.prerequisiteBudgetStartedMs) throw launchError("probe budget", "transport cannot reset the original aggregate monotonic anchor");
}

function inputSafeDeploymentDirectory(launch: PiPrerequisiteGateBinding): string {
  if (!/^d-[a-z0-9-]+$/.test(launch.deploymentId)) throw launchError("probe evidence identity", "protected deployment identity is malformed");
  return resolve(getAiUsageDir(), "deployments", launch.deploymentId);
}

function launchError(source: string, reason: string): Error {
  return new Error(formatBoundedFiveFieldDiagnostic({
    condition: "protected Pi review launch admission",
    source,
    reason,
    correction: "persist one fresh exact objective, approved matrix/ticket binding, authenticated candidate snapshot, and sole one-use review authority",
    resumeAction: "launch a fresh requirements/review-auto deployment only after every durable binding agrees; start no matrix command or reviewer",
  }));
}
