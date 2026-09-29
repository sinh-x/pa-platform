import { execFileSync } from "node:child_process";
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

interface ApprovedMatrix {
  authority: string;
  digest: string;
  header: {
    approvedBaseSha: string;
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
  current: DeploymentStatus | null;
  environment: Record<string, string>;
  featureSha: string;
  input: PiValidationLaunchInput;
  matrix: ApprovedMatrix;
  matrixApprovalEvidence: string;
  matrixAuthoritySha256: string;
  matrixSource: string;
  linkedBranchMatches: boolean;
  snapshot: ReturnType<typeof captureRepositoryGitSnapshot>;
  statuses: readonly DeploymentStatus[];
  ticketId: string;
}

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

  const matrix = readApprovedMatrix(matrixSource);
  const snapshot = captureRepositoryGitSnapshot(plan.worktreeRoot);
  const ticket = new TicketStore().get(ticketId);
  if (!ticket) throw launchError("durable ticket", "the review ticket is absent");
  const linked = ticket.linkedBranches.filter((value) => value.repo === plan.repoKey && value.branch === branch);
  const linkedBranchMatches = linked.length === 1 && linked[0]?.state === "materialized"
    && (linked[0].headSha ?? linked[0].sha) === featureSha;
  const approvalCommentId = approvalCommentReference(matrixApprovalEvidence);
  const approval = ticket.comments.find((comment) => comment.id === approvalCommentId);
  const current = queryDeploymentStatus(deploymentId);
  const statuses = queryDeploymentStatuses();
  const manifestEnvironment = matrixEnvironment(environment, {
    ticketId,
    featureSha,
    matrixSource,
    matrixAuthoritySha256,
    matrixApprovalEvidence,
    worktreeRoot: plan.worktreeRoot,
  });
  evaluatePrerequisites({
    approval,
    authorizationId,
    branch,
    current,
    environment: manifestEnvironment,
    featureSha,
    input,
    linkedBranchMatches,
    matrix,
    matrixApprovalEvidence,
    matrixAuthoritySha256,
    matrixSource,
    snapshot,
    statuses,
    ticketId,
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
      prerequisites: matrix.prerequisites.map((text, index) => Object.freeze({
        sourceOrder: index + 1,
        text,
        status: "verified" as const,
      })),
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
  const prerequisiteSection = authority.match(/\*\*Prerequisites:\*\*\n([\s\S]*?)(?=\n\*\*Environment:\*\*)/)?.[1];
  if (!prerequisiteSection) throw launchError("matrix prerequisites", "the authoritative prerequisite section is absent");
  const prerequisiteLines = prerequisiteSection.split("\n").filter((line) => line.length > 0);
  if (prerequisiteLines.length !== 4 || prerequisiteLines.some((line) => !line.startsWith("- "))) {
    throw launchError("matrix prerequisites", "the complete four-clause prerequisite contract is malformed or reordered");
  }
  const prerequisites = prerequisiteLines.map((line) => line.slice(2));
  const environmentSection = authority.match(/\*\*Environment:\*\*\n([\s\S]*?)(?=\n\*\*Commands \(run in this exact order\):\*\*)/)?.[1];
  if (!environmentSection) throw launchError("matrix environment", "the complete exact command environment section is absent");
  for (const name of MATRIX_ENVIRONMENT_NAMES) {
    const matches = environmentSection.match(new RegExp(`\\\`${escapeRegExp(name)}\\\``, "g")) ?? [];
    if (matches.length !== 1) throw launchError("matrix environment", "the approved matrix does not name each required environment value exactly once");
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
  return {
    authority,
    digest,
    header: {
      approvedBaseSha: exactHeaderValue(text, "Approved Base SHA"),
      featureBranch: exactHeaderValue(text, "Feature Branch"),
      matrixApprovalEvidence: exactHeaderValue(text, "Matrix Approval Evidence"),
      matrixAuthoritySha256: exactHeaderValue(text, "Matrix Authority SHA-256"),
      repositoryKey: exactHeaderValue(text, "Repository Key"),
      ticketId: exactHeaderValue(text, "Ticket"),
    },
    prerequisites,
    environmentSection,
    commands,
  };
}

function evaluatePrerequisites(context: PrerequisiteContext): void {
  evaluateRepositoryPrerequisite(context, context.matrix.prerequisites[0]!);
  evaluateToolPrerequisite(context, context.matrix.prerequisites[1]!);
  evaluateArtifactPrerequisite(context, context.matrix.prerequisites[2]!);
  evaluateAuthorizationPrerequisite(context, context.matrix.prerequisites[3]!);
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
  if (!gitSucceeds(input.plan.worktreeRoot, context.environment, ["cat-file", "-e", `${baseSha}^{commit}`])
    || !gitSucceeds(input.plan.worktreeRoot, context.environment, ["merge-base", "--is-ancestor", baseSha, context.featureSha])) {
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
  const sourceLines = [...context.matrix.authority.matchAll(/^\*\*Matrix Source:\*\* `([^`]+)`$/gm)];
  if (sourceLines.length !== 1 || sourceLines[0]?.[1] !== context.matrixSource
    || context.matrix.digest !== context.matrixAuthoritySha256) {
    throw launchError("matrix prerequisite 3", "matrix source or recomputed raw authority digest does not agree exactly");
  }
  if (!context.approval || context.approval.author.toLowerCase() !== "sinh"
    || occurrences(context.approval.content, context.matrixSource) !== 1
    || occurrences(context.approval.content, context.matrixAuthoritySha256) !== 1) {
    throw launchError("matrix prerequisite 3", "the named durable Sinh approval comment does not bind the exact matrix source and digest");
  }
  assertCurrentLaunchIntent(context.current, context.input, parseReviewObjective(context.input.request.objective));
}

function evaluateAuthorizationPrerequisite(context: PrerequisiteContext, prerequisite: string): void {
  const expected = "The trusted launcher has atomically consumed the one-use review authorization, rejected duplicate active review lineage, and supplied the complete explicit command environment. The authorization ID is excluded from command child environments, logs, activity progress, and ledger artifacts; it is supplied separately to the reviewer for exact objective, report, and registry agreement. No project command starts before these checks pass.";
  if (prerequisite !== expected) throw launchError("matrix prerequisite 4", "the authorization/environment prerequisite is not the complete approved contract");
  assertExactCommandEnvironment(context);
  const authorizationMatches = context.statuses.filter((status) => objectiveValue(status.objective, "Review Authorization ID") === context.authorizationId);
  if (authorizationMatches.length !== 1 || authorizationMatches[0]?.deploy_id !== context.input.deploymentId) {
    throw launchError("matrix prerequisite 4", "authorization is absent, reused, or not atomically consumed by the current deployment");
  }
  const activeReviews = context.statuses.filter((status) => status.status === "running"
    && status.team === "requirements" && status.mode === "review-auto"
    && status.ticket_id === context.ticketId && objectiveValue(status.objective, "Branch") === context.branch);
  if (activeReviews.length !== 1 || activeReviews[0]?.deploy_id !== context.input.deploymentId) {
    throw launchError("matrix prerequisite 4", "another active review or duplicate authority exists for the ticket and branch");
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
  const candidates = text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
    .filter((line) => line.startsWith(prefix));
  const match = candidates.length === 1 ? new RegExp(`^${escapeRegExp(prefix)} (.+)$`).exec(candidates[0]!) : null;
  if (!match?.[1]) throw launchError("requirements header", `exactly one approved ${label} header line is required`);
  return match[1];
}

function repositoryPrerequisiteBase(prerequisite: string): string {
  const match = / descends from `([0-9a-f]{40})`\.$/.exec(prerequisite);
  if (!match?.[1]) throw launchError("matrix prerequisite 1", "the approved base SHA is absent");
  return match[1];
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
  },
): Record<string, string> {
  const path = environment["PATH"] ?? process.env["PATH"];
  const home = environment["HOME"] ?? process.env["HOME"];
  if (!path || !home) throw launchError("trusted command environment", "the trusted launcher has no complete explicit PATH and HOME");
  return {
    PA_REPO: binding.worktreeRoot,
    PA_TICKET_ID: binding.ticketId,
    PA_FEATURE_SHA: binding.featureSha,
    PA_MATRIX_SOURCE: binding.matrixSource,
    PA_MATRIX_AUTHORITY_SHA256: binding.matrixAuthoritySha256,
    PA_MATRIX_APPROVAL_EVIDENCE: binding.matrixApprovalEvidence,
    CI: "1",
    HOME: home,
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
