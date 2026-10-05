import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  MAX_VALIDATION_EVENT_CHARACTERS,
  parseRepositoryReviewReservation,
  validateReviewCheckoutCorrelationEvidence,
  type RepositoryReviewReservation,
  type ReviewCheckoutCorrelationEvidence,
  assertValidationAuthority,
  executeValidationHandoff,
  finalizeValidationExecutorCrash,
  parseValidationHandoff,
  validationDiagnostic,
  type ValidationAuthorityBinding,
  type ValidationDiagnostic,
  type ValidationEvent,
  type ValidationExecutionResult,
  type ValidationExecutorOptions,
  type ValidationHandoff,
  type ValidationLedger,
  type ValidationLedgerResult,
} from "@pa-platform/pa-core";

export const PI_PROTECTED_VALIDATION_SCHEMA_VERSION = "pi-protected-validation/v1" as const;
export const PI_VALIDATION_HANDOFF_FILE = "pi-validation-handoff.json";
const MAX_PROTECTED_HANDOFF_BYTES = 64 * 1024 * 1024;
const REVIEW_AUTHORIZATION = /^review-auth:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEPLOYMENT_ID = /^d-[a-z0-9-]+$/;

export interface PiValidationPrerequisiteEvidence {
  sourceOrder: number;
  text: string;
  status: "verified";
}

export interface PiValidationAdmissionEvidence {
  authorization: "consumed";
  matrixDigest: "verified";
  featureSha: "verified";
  approval: "verified";
  activeReview: "admitted";
  prerequisites: readonly PiValidationPrerequisiteEvidence[];
}

export interface PiProtectedReviewMetadata {
  checkout?: ReviewCheckoutCorrelationEvidence;
  reviewDeploymentId: string;
  authorizationId: string;
  ticketId: string;
  branch: string;
  featureSha: string;
  matrixSource: string;
  matrixAuthoritySha256: string;
  matrixApprovalEvidence: string;
}

export interface PiProtectedValidationLaunch {
  schemaVersion: typeof PI_PROTECTED_VALIDATION_SCHEMA_VERSION;
  deploymentId: string;
  admission: PiValidationAdmissionEvidence;
  validationHandoff: unknown;
  authority: ValidationAuthorityBinding;
  review: PiProtectedReviewMetadata;
  reservation?: RepositoryReviewReservation;
}

export interface PiReviewerValidationContext extends PiProtectedReviewMetadata {
  validationResult: ValidationLedgerResult;
  validationLedgerPath: string;
  validationLedgerSha256: string;
  validationEvidenceRoot: string;
}

export interface PiValidationSupervisorOptions<T> {
  evidenceRoot: string;
  ledgerPath: string;
  statePath?: string;
  emit?: (event: ValidationEvent) => void | Promise<void>;
  startReviewer: (context: PiReviewerValidationContext) => T | Promise<T>;
  beforeExecute?: (launch: PiProtectedValidationLaunch) => void;
  execute?: typeof executeValidationHandoff;
  recover?: typeof finalizeValidationExecutorCrash;
  now?: () => Date;
  abortSignal?: AbortSignal;
}

export type PiValidationSupervisorResult<T> =
  | { admitted: false; reviewerStarted: false; diagnostic: ValidationDiagnostic }
  | {
    admitted: true;
    reviewerStarted: true;
    validation: ValidationExecutionResult;
    reviewerContext: PiReviewerValidationContext;
    reviewerResult: T;
  };

export async function runPiValidationBeforeReviewer<T>(
  input: unknown,
  options: PiValidationSupervisorOptions<T>,
): Promise<PiValidationSupervisorResult<T>> {
  let launch: PiProtectedValidationLaunch;
  let handoff: ValidationHandoff;
  try {
    launch = parsePiProtectedValidationLaunch(input);
    handoff = parseValidationHandoff(launch.validationHandoff);
    assertValidationAuthority(handoff, launch.authority);
    assertReviewBinding(launch, handoff);
    options.beforeExecute?.(launch);
  } catch (error) {
    return {
      admitted: false,
      reviewerStarted: false,
      diagnostic: validationDiagnostic("pi.validation.admission", safeAdmissionReason(error)),
    };
  }

  const executorOptions: ValidationExecutorOptions = {
    authority: launch.authority,
    evidenceRoot: options.evidenceRoot,
    ledgerPath: options.ledgerPath,
    ...(options.statePath ? { statePath: options.statePath } : {}),
    ...(options.emit ? { emit: options.emit } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  };
  const execute = options.execute ?? executeValidationHandoff;
  const recover = options.recover ?? finalizeValidationExecutorCrash;
  let validation: ValidationExecutionResult;
  try {
    validation = await execute(launch.validationHandoff, executorOptions);
  } catch {
    const recovered = await recover(launch.validationHandoff, executorOptions);
    const crashEvent: ValidationEvent = {
      schemaVersion: "pa-validation-event/v1",
      type: "manifest_finish",
      timestamp: (options.now ?? (() => new Date()))().toISOString(),
      manifestSha256: handoff.manifestSha256,
      status: "executor_crash",
    };
    if (JSON.stringify(crashEvent).length > MAX_VALIDATION_EVENT_CHARACTERS) {
      throw new Error("Pi validation crash event exceeds 2000 JavaScript characters");
    }
    await options.emit?.(crashEvent);
    validation = {
      admitted: true,
      ledger: recovered.ledger,
      ledgerPath: recovered.ledgerPath,
      events: [crashEvent],
    };
  }

  if (!validation.admitted) {
    return {
      admitted: false,
      reviewerStarted: false,
      diagnostic: validation.diagnostic ?? validationDiagnostic("pi.validation.preflight", "validation authority was rejected"),
    };
  }
  const ledger = (await recover(launch.validationHandoff, executorOptions)).ledger;
  const reviewerContext = reviewerContextFor(launch.review, ledger, options.evidenceRoot, options.ledgerPath);
  const reviewerResult = await options.startReviewer(reviewerContext);
  return { admitted: true, reviewerStarted: true, validation: { ...validation, ledger, ledgerPath: options.ledgerPath }, reviewerContext, reviewerResult };
}

export function piReviewerValidationPrompt(context: PiReviewerValidationContext): string {
  const prompt = [
    "<protected-review-metadata>",
    `review_deployment_id: ${context.reviewDeploymentId}`,
    `review_authorization_id: ${context.authorizationId}`,
    `ticket_id: ${context.ticketId}`,
    `branch: ${context.branch}`,
    `feature_sha: ${context.featureSha}`,
    ...(context.checkout ? [`repo_root: ${context.checkout.repoRoot}`, `worktree_root: ${context.checkout.worktreeRoot}`,
      `treehouse_lease_id: ${context.checkout.leaseId}`, `treehouse_lease_holder: ${context.checkout.leaseHolder}`] : []),
    `matrix_source: ${context.matrixSource}`,
    `matrix_authority_sha256: ${context.matrixAuthoritySha256}`,
    `matrix_approval_evidence: ${context.matrixApprovalEvidence}`,
    `validation_result: ${context.validationResult}`,
    `validation_ledger_path: ${context.validationLedgerPath}`,
    `validation_ledger_sha256: ${context.validationLedgerSha256}`,
    `validation_evidence_root: ${context.validationEvidenceRoot}`,
    "Raw validation output is intentionally excluded. Inspect only the bounded ledger and evidence references.",
    "</protected-review-metadata>",
  ].join("\n");
  if (prompt.length > MAX_VALIDATION_EVENT_CHARACTERS) throw new Error("protected reviewer metadata exceeds 2000 JavaScript characters");
  return prompt;
}

export function writePiProtectedValidationLaunch(path: string, launch: PiProtectedValidationLaunch): void {
  parsePiProtectedValidationLaunch(launch);
  const body = Buffer.from(`${JSON.stringify(launch)}\n`, "utf8");
  if (body.length > MAX_PROTECTED_HANDOFF_BYTES) throw new Error("Pi validation handoff is oversized");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Pi validation handoff parent must be a real directory");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    linkSync(temporary, path);
  } finally {
    safeUnlink(temporary);
  }
}

export function readPiProtectedValidationLaunch(path: string): PiProtectedValidationLaunch {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || file.size > MAX_PROTECTED_HANDOFF_BYTES) {
    throw new Error("Pi validation handoff is insecure or oversized");
  }
  return parsePiProtectedValidationLaunch(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function parsePiProtectedValidationLaunch(input: unknown): PiProtectedValidationLaunch {
  const row = strictRecord(input, "Pi validation handoff", ["schemaVersion", "deploymentId", "admission", "validationHandoff", "authority", "review"], ["reservation"]);
  if (row["schemaVersion"] !== PI_PROTECTED_VALIDATION_SCHEMA_VERSION) throw new Error("Pi validation handoff schema is invalid");
  const deploymentId = requiredString(row["deploymentId"], "deploymentId");
  if (!DEPLOYMENT_ID.test(deploymentId)) throw new Error("Pi validation deployment identity is invalid");
  const admission = strictRecord(row["admission"], "Pi validation admission", ["authorization", "matrixDigest", "featureSha", "approval", "activeReview", "prerequisites"]);
  if (admission["authorization"] !== "consumed" || admission["matrixDigest"] !== "verified"
    || admission["featureSha"] !== "verified" || admission["approval"] !== "verified"
    || admission["activeReview"] !== "admitted") {
    throw new Error("Pi validation admission evidence is incomplete");
  }
  const prerequisites = parsePrerequisites(admission["prerequisites"]);
  const authority = parseAuthority(row["authority"]);
  const review = parseReview(row["review"]);
  return {
    schemaVersion: PI_PROTECTED_VALIDATION_SCHEMA_VERSION,
    deploymentId,
    admission: {
      authorization: "consumed",
      matrixDigest: "verified",
      featureSha: "verified",
      approval: "verified",
      activeReview: "admitted",
      prerequisites,
    },
    ...(row["reservation"] === undefined ? {} : { reservation: parseRepositoryReviewReservation(row["reservation"]) }),
    validationHandoff: row["validationHandoff"],
    authority,
    review,
  };
}

function parsePrerequisites(input: unknown): readonly PiValidationPrerequisiteEvidence[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Pi validation prerequisite evidence is incomplete");
  return input.map((value, index) => {
    const row = strictRecord(value, "Pi validation prerequisite evidence", ["sourceOrder", "text", "status"]);
    if (row["sourceOrder"] !== index + 1 || row["status"] !== "verified") {
      throw new Error("Pi validation prerequisite evidence is incomplete or out of source order");
    }
    return {
      sourceOrder: index + 1,
      text: requiredString(row["text"], `admission.prerequisites[${index}].text`),
      status: "verified" as const,
    };
  });
}

function parseAuthority(input: unknown): ValidationAuthorityBinding {
  const row = strictRecord(input, "Pi validation authority", [
    "ticketId", "branch", "featureSha", "matrixSource", "matrixAuthoritySha256", "matrixApprovalEvidence", "repository", "protectedEnvironment",
  ]);
  const repository = strictRecord(row["repository"], "Pi validation authority repository", ["repoKey", "canonicalRoot", "worktreeRoot"]);
  const protectedEnvironment = stringMap(row["protectedEnvironment"], "protectedEnvironment");
  return {
    ticketId: requiredString(row["ticketId"], "ticketId"),
    branch: requiredString(row["branch"], "branch"),
    featureSha: requiredString(row["featureSha"], "featureSha"),
    matrixSource: requiredString(row["matrixSource"], "matrixSource"),
    matrixAuthoritySha256: requiredString(row["matrixAuthoritySha256"], "matrixAuthoritySha256"),
    matrixApprovalEvidence: requiredString(row["matrixApprovalEvidence"], "matrixApprovalEvidence"),
    repository: {
      repoKey: requiredString(repository["repoKey"], "repository.repoKey"),
      canonicalRoot: requiredString(repository["canonicalRoot"], "repository.canonicalRoot"),
      worktreeRoot: requiredString(repository["worktreeRoot"], "repository.worktreeRoot"),
    },
    protectedEnvironment,
  };
}

function parseReview(input: unknown): PiProtectedReviewMetadata {
  const row = strictRecord(input, "Pi protected review metadata", [
    "reviewDeploymentId", "authorizationId", "ticketId", "branch", "featureSha", "matrixSource", "matrixAuthoritySha256", "matrixApprovalEvidence",
  ], ["checkout"]);
  const authorizationId = requiredString(row["authorizationId"], "review.authorizationId");
  if (!REVIEW_AUTHORIZATION.test(authorizationId)) throw new Error("Pi review authorization is not a canonical one-use identifier");
  return {
    ...(row["checkout"] === undefined ? {} : { checkout: validateReviewCheckoutCorrelationEvidence(row["checkout"] as Record<string, unknown>) }),
    reviewDeploymentId: requiredString(row["reviewDeploymentId"], "review.reviewDeploymentId"),
    authorizationId,
    ticketId: requiredString(row["ticketId"], "review.ticketId"),
    branch: requiredString(row["branch"], "review.branch"),
    featureSha: requiredString(row["featureSha"], "review.featureSha"),
    matrixSource: requiredString(row["matrixSource"], "review.matrixSource"),
    matrixAuthoritySha256: requiredString(row["matrixAuthoritySha256"], "review.matrixAuthoritySha256"),
    matrixApprovalEvidence: requiredString(row["matrixApprovalEvidence"], "review.matrixApprovalEvidence"),
  };
}

function assertReviewBinding(launch: PiProtectedValidationLaunch, handoff: ValidationHandoff): void {
  const review = launch.review;
  const authority = launch.authority;
  if (review.checkout && (review.checkout.ticket !== review.ticketId || review.checkout.branch !== review.branch
    || review.checkout.featureSha !== review.featureSha || review.checkout.worktreeRoot !== authority.repository.worktreeRoot
    || review.checkout.repoRoot !== authority.repository.canonicalRoot || review.checkout.repoKey !== authority.repository.repoKey)) {
    throw new Error("Pi protected candidate metadata does not match validation authority");
  }
  if (review.reviewDeploymentId !== launch.deploymentId || review.ticketId !== authority.ticketId
    || review.branch !== authority.branch || review.featureSha !== authority.featureSha
    || review.matrixSource !== authority.matrixSource || review.matrixAuthoritySha256 !== authority.matrixAuthoritySha256
    || review.matrixApprovalEvidence !== authority.matrixApprovalEvidence
    || handoff.manifestSha256.length !== 64) {
    throw new Error("Pi protected review metadata does not match validation authority");
  }
}

function reviewerContextFor(
  review: PiProtectedReviewMetadata,
  ledger: ValidationLedger,
  evidenceRoot: string,
  ledgerPath: string,
): PiReviewerValidationContext {
  const bytes = readFileSync(ledgerPath);
  const context: PiReviewerValidationContext = {
    ...review,
    validationResult: ledger.result,
    validationLedgerPath: ledgerPath,
    validationLedgerSha256: createHash("sha256").update(bytes).digest("hex"),
    validationEvidenceRoot: evidenceRoot,
  };
  piReviewerValidationPrompt(context);
  return context;
}

function strictRecord(input: unknown, label: string, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} is malformed`);
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key) && !optional.includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(row, key))) {
    throw new Error(`${label} is malformed`);
  }
  return row;
}

function requiredString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 4_096 || input.includes("\0")) throw new Error(`${label} is invalid`);
  return input;
}

function stringMap(input: unknown, label: string): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} is invalid`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid`);
    result[key] = value;
  }
  return result;
}

function safeAdmissionReason(error: unknown): string {
  if (error instanceof Error && error.name === "ValidationPreflightError") return error.message;
  return "launcher-protected review admission or validation authority evidence is invalid";
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
