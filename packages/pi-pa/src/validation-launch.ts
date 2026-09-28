import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  VALIDATION_HANDOFF_SCHEMA_VERSION,
  VALIDATION_MANIFEST_SCHEMA_VERSION,
  TicketStore,
  captureRepositoryGitSnapshot,
  digestValidationManifest,
  formatBoundedFiveFieldDiagnostic,
  getAiUsageDir,
  queryDeploymentStatus,
  queryDeploymentStatuses,
  type DeployRequest,
  type DeploymentStatus,
  type ExecutionPlan,
  type ValidationAuthorityBinding,
  type ValidationCommandSpec,
  type ValidationHandoff,
  type ValidationManifest,
} from "@pa-platform/pa-core";
import {
  PI_PROTECTED_VALIDATION_SCHEMA_VERSION,
  type PiProtectedValidationLaunch,
} from "./validation-supervisor.js";

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
const ALLOWED_OBJECTIVE_FIELDS = new Set<string>([...REQUIRED_OBJECTIVE_FIELDS, ...OPTIONAL_OBJECTIVE_FIELDS]);
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
type ReviewObjective = Record<ObjectiveField, string>;

export interface PiValidationLaunchInput {
  deploymentId: string;
  request: DeployRequest;
  plan: ExecutionPlan;
  environment: Record<string, string>;
}

export function isPiProtectedReviewRequest(request: DeployRequest, plan: ExecutionPlan): boolean {
  return request.team === "requirements" && plan.mode === "review-auto";
}

export function createPiProtectedValidationLaunch(input: PiValidationLaunchInput): PiProtectedValidationLaunch {
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
    || plan.environment.PA_REPO_ROOT !== plan.repoRoot) {
    throw launchError("review repository identity", "immutable Pi canonical and authenticated worktree identity domains do not agree");
  }

  const snapshot = captureRepositoryGitSnapshot(plan.worktreeRoot);
  if (snapshot.branch !== branch || snapshot.head !== featureSha) {
    throw launchError("review candidate snapshot", "objective branch or Feature SHA is stale or mismatched with the authenticated worktree");
  }

  const ticket = new TicketStore().get(ticketId);
  if (!ticket) throw launchError("durable ticket", "the review ticket is absent");
  const linked = ticket.linkedBranches.filter((value) => value.repo === plan.repoKey && value.branch === branch);
  if (linked.length !== 1 || linked[0]?.state !== "materialized" || (linked[0].headSha ?? linked[0].sha) !== featureSha) {
    throw launchError("durable ticket branch", "the ticket does not carry one exact materialized branch and Feature SHA binding");
  }
  const approvalCommentId = approvalCommentReference(matrixApprovalEvidence);
  const approval = ticket.comments.find((comment) => comment.id === approvalCommentId);
  if (!approval || approval.author.toLowerCase() !== "sinh"
    || !approval.content.includes(matrixSource) || !approval.content.includes(matrixAuthoritySha256)) {
    throw launchError("durable ticket approval", "the named Sinh approval comment does not bind the exact matrix source and digest");
  }

  const current = queryDeploymentStatus(deploymentId);
  assertCurrentLaunchIntent(current, input, objective);
  const statuses = queryDeploymentStatuses();
  const authorizationMatches = statuses.filter((status) => objectiveValue(status.objective, "Review Authorization ID") === authorizationId);
  if (authorizationMatches.length !== 1 || authorizationMatches[0]?.deploy_id !== deploymentId) {
    throw launchError("one-use review authorization", "authorization is absent, reused, or bound to more than the current deployment");
  }
  const activeReviews = statuses.filter((status) => status.status === "running"
    && status.team === "requirements" && status.mode === "review-auto"
    && status.ticket_id === ticketId && objectiveValue(status.objective, "Branch") === branch);
  if (activeReviews.length !== 1 || activeReviews[0]?.deploy_id !== deploymentId) {
    throw launchError("active review exclusion", "another active review or duplicate authority exists for the ticket and branch");
  }

  const matrix = readApprovedMatrix(matrixSource, matrixAuthoritySha256);
  const manifestEnvironment = matrixEnvironment(environment, {
    ticketId,
    featureSha,
    matrixSource,
    matrixAuthoritySha256,
    matrixApprovalEvidence,
    worktreeRoot: plan.worktreeRoot,
  });
  const repository = {
    repoKey: plan.repoKey,
    canonicalRoot: plan.repoRoot,
    worktreeRoot: plan.worktreeRoot,
  };
  const manifest: ValidationManifest = {
    schemaVersion: VALIDATION_MANIFEST_SCHEMA_VERSION,
    ticketId,
    branch,
    featureSha,
    matrix: {
      source: matrixSource,
      authoritySha256: matrixAuthoritySha256,
      approvalEvidence: matrixApprovalEvidence,
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
    MATRIX_ENVIRONMENT_NAMES.filter((name) => name.startsWith("PA_")).map((name) => [name, manifestEnvironment[name]]),
  ) as Record<string, string>;
  const authority: ValidationAuthorityBinding = {
    ticketId,
    branch,
    featureSha,
    matrixSource,
    matrixAuthoritySha256,
    matrixApprovalEvidence,
    repository,
    protectedEnvironment,
  };
  const validationHandoff: ValidationHandoff = {
    schemaVersion: VALIDATION_HANDOFF_SCHEMA_VERSION,
    manifestSha256: digestValidationManifest(manifest),
    manifest,
    repositoryEvidence: {
      ...repository,
      ticketId,
      branch,
      featureSha,
      authenticated: true,
    },
    protectedEnvironment,
  };
  return Object.freeze({
    schemaVersion: PI_PROTECTED_VALIDATION_SCHEMA_VERSION,
    deploymentId,
    admission: {
      authorization: "consumed" as const,
      matrixDigest: "verified" as const,
      featureSha: "verified" as const,
      approval: "verified" as const,
      activeReview: "admitted" as const,
    },
    validationHandoff,
    authority,
    review: {
      reviewDeploymentId: deploymentId,
      authorizationId,
      ticketId,
      branch,
      featureSha,
      matrixSource,
      matrixAuthoritySha256,
      matrixApprovalEvidence,
    },
  });
}

function parseReviewObjective(input: string | undefined): ReviewObjective {
  if (!input) throw launchError("review objective", "protected review authority fields are absent");
  const values = new Map<string, string>();
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([^:]+):\s*(.+)$/.exec(line);
    const label = match?.[1]?.trim() ?? "";
    const value = match?.[2]?.trim() ?? "";
    if (!ALLOWED_OBJECTIVE_FIELDS.has(label) || !value || values.has(label)) {
      throw launchError("review objective", "authority is malformed, duplicated, or contains an unsupported clause");
    }
    values.set(label, value);
  }
  for (const field of REQUIRED_OBJECTIVE_FIELDS) {
    if (!values.has(field)) throw launchError("review objective", "one or more protected review authority fields are absent");
  }
  return Object.fromEntries(REQUIRED_OBJECTIVE_FIELDS.map((field) => [field, values.get(field)!])) as ReviewObjective;
}

function objectiveValue(input: string | undefined, label: ObjectiveField): string | undefined {
  if (!input) return undefined;
  const matches = input.split(/\r?\n/).map((line) => {
    const match = /^([^:]+):\s*(.+)$/.exec(line);
    return match?.[1]?.trim() === label ? match[2]!.trim() : undefined;
  }).filter((value): value is string => value !== undefined);
  return matches.length === 1 ? matches[0] : undefined;
}

function assertCurrentLaunchIntent(current: DeploymentStatus | null, input: PiValidationLaunchInput, objective: ReviewObjective): void {
  const { deploymentId, request, plan } = input;
  if (!current || current.deploy_id !== deploymentId || current.status !== "running"
    || current.team !== "requirements" || current.mode !== "review-auto" || current.runtime !== "pi" || current.binary !== "ppa"
    || current.ticket_id !== objective["Ticket"] || current.objective !== request.objective
    || current.repo !== plan.worktreeRoot || current.repo_root !== plan.repoRoot || current.worktree_root !== plan.worktreeRoot) {
    throw launchError("durable review launch intent", "the current registry start evidence is absent, stale, or mismatched");
  }
}

function approvalCommentReference(evidence: string): string {
  const matches = evidence.match(/\bc-[0-9]{8,}\b/g) ?? [];
  if (matches.length !== 1) throw launchError("matrix approval evidence", "approval must name exactly one durable ticket comment");
  return matches[0]!;
}

function readApprovedMatrix(source: string, expectedDigest: string): { commands: string[] } {
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
  if (!file.isFile() || file.isSymbolicLink() || realpathSync(path) !== path) {
    throw launchError("matrix source", "matrix source is not one exact canonical regular file");
  }
  const bytes = readFileSync(path);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw launchError("matrix source", "matrix source is not valid raw UTF-8"); }
  const starts = [...text.matchAll(/^### Full Validation Matrix$/gm)];
  if (starts.length !== 1 || starts[0]?.index === undefined) {
    throw launchError("matrix authority", "matrix heading is absent or duplicated");
  }
  const start = starts[0].index;
  const afterStart = start + starts[0][0].length;
  const boundary = /^#{1,3} /gm.exec(text.slice(afterStart));
  if (!boundary) throw launchError("matrix authority", "matrix terminal heading boundary is absent");
  const authority = text.slice(start, afterStart + boundary.index);
  const digest = createHash("sha256").update(Buffer.from(authority, "utf8")).digest("hex");
  if (digest !== expectedDigest) throw launchError("matrix authority", "raw matrix digest does not match the durable launch intent");
  const headerMatches = [...text.matchAll(/^> Matrix Authority SHA-256:\s*([0-9a-f]{64})$/gm)];
  if (headerMatches.length !== 1 || headerMatches[0]?.[1] !== expectedDigest) {
    throw launchError("matrix authority", "requirements header does not bind the exact matrix digest");
  }
  for (const name of MATRIX_ENVIRONMENT_NAMES) {
    if (!authority.includes(`\`${name}\``)) throw launchError("matrix environment", "the approved matrix does not name one complete required environment");
  }
  const commandSection = authority.match(/\*\*Commands \(run in this exact order\):\*\*([\s\S]*?)(?=\n\*\*Required Outputs and Artifacts:\*\*)/)?.[1];
  if (!commandSection) throw launchError("matrix commands", "the exact ordered command section is absent");
  const commands: string[] = [];
  const commandPattern = /(?:^|\n)(\d+)\. [^\n]+\n```bash\n([\s\S]*?)\n```(?=\n|$)/g;
  for (const match of commandSection.matchAll(commandPattern)) {
    if (Number(match[1]) !== commands.length + 1 || !match[2]) {
      throw launchError("matrix commands", "matrix command numbering is incomplete or out of order");
    }
    commands.push(match[2]);
  }
  if (commands.length === 0 || !authority.includes("**Pass Criteria:**")) {
    throw launchError("matrix commands", "matrix commands or pass criteria are absent");
  }
  return { commands };
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
  },
): Record<string, string> {
  const path = environment["PATH"] ?? process.env["PATH"];
  if (!path) throw launchError("trusted command environment", "the trusted launcher has no resolved PATH");
  return {
    PA_REPO: binding.worktreeRoot,
    PA_TICKET_ID: binding.ticketId,
    PA_FEATURE_SHA: binding.featureSha,
    PA_MATRIX_SOURCE: binding.matrixSource,
    PA_MATRIX_AUTHORITY_SHA256: binding.matrixAuthoritySha256,
    PA_MATRIX_APPROVAL_EVIDENCE: binding.matrixApprovalEvidence,
    CI: "1",
    HOME: environment["HOME"] ?? process.env["HOME"] ?? "",
    LANG: "C.UTF-8",
    TZ: "UTC",
    PATH: path,
  };
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
