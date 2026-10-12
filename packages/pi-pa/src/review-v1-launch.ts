import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRepositoryGitIdentity, captureRepositoryGitSnapshot, claimReviewAuthorization,
  digestValidationManifest, parseReviewEvidenceJson, readReviewEvidenceFile, readReviewMatrixArtifact,
  getAiUsageDir, getDeploymentEvents, queryReviewAuthorizationClaim, parseReviewObjective,
  getPlatformHomeDir, loadReposYaml, readReviewProducerFixtures,
  VALIDATION_HANDOFF_SCHEMA_VERSION, VALIDATION_MANIFEST_SCHEMA_VERSION, ReviewContractError,
  type ReviewCheckoutEvidence, type ReviewMatrix, type ReviewObjective, type ReviewReadinessBinding,
  type ValidationHandoff, type ValidationAuthorityBinding,
} from "@pa-platform/pa-core";
import { requireReviewPreflight, reviewPreflightDependencies } from "./review-preflight.js";
import { PI_PROTECTED_VALIDATION_SCHEMA_VERSION, type PiProtectedValidationLaunch } from "./validation-supervisor.js";
import { writePiMatrixStartedEvent, type PiValidationLaunchInput } from "./validation-launch.js";

export const REVIEW_RUNTIME_PROVENANCE_VERSION = "pa-review-runtime/v1";
/** Isolated provider fixture seam; never a request/environment/CLI capability or installed-live proof. */
export interface VersionedReviewDependencies {
  verifyReadiness?: typeof authenticateVersionedReadiness;
}
function reject(source: string, reason: string): never { throw new ReviewContractError("REVIEW_BINDING", source, reason); }
export function isVersionedReviewObjective(objective?: string): boolean { return objective?.trimStart().startsWith("{") ?? false; }
export function authorizeVersionedReview(request: PiValidationLaunchInput["request"], repository: { repoKey: string; repoRoot: string }) {
  if (!request.background || request.resume) reject("review.mode", "requires a fresh background deployment");
  const { objective: o, artifact: a } = requireReviewPreflight({ ticket: request.ticket ?? "", objective: request.objective ?? "" });
  if (a.matrix.repository.key !== repository.repoKey || a.matrix.repository.root !== repository.repoRoot) reject("review.repository", "registered canonical selector conflicts with approved repository");
  return { binding: { repoKey: repository.repoKey, repoRoot: repository.repoRoot, ticket: o.ticket, branch: o.branch,
    baseSha: a.matrix.repository.baseSha, featureSha: o.featureSha,
    approvedReference: { sha: a.matrix.repository.baseSha, matrixSource: o.matrixSource,
      matrixAuthoritySha256: o.matrixAuthoritySha256, matrixApprovalEvidence: o.matrixApprovalEvidence } }, authorizationId: o.reviewAuthorizationId };
}
export function assertVersionedReviewReference(binding: Pick<ReviewCheckoutEvidence, "repoKey" | "ticket" | "branch" | "baseSha" | "approvedReference">): void {
  const ref = binding.approvedReference;
  if (!ref) reject("review.reference", "requires approved source/digest/reference authority");
  const a = readReviewMatrixArtifact(getAiUsageDir(), ref.matrixSource);
  const ticket = reviewPreflightDependencies().readTicket(binding.ticket);
  const approvals = ticket.comments.filter((comment) => comment.id === ref.matrixApprovalEvidence);
  const links = ticket.linkedBranches.filter((link) => link.repo === binding.repoKey);
  if (a.matrix.repository.key !== binding.repoKey || a.header.ticket !== binding.ticket || a.matrix.repository.branch !== binding.branch
    || a.header.featureBranch !== binding.branch || a.matrix.repository.baseSha !== binding.baseSha || a.header.approvedBaseSha !== binding.baseSha
    || ref.sha !== binding.baseSha || a.digest !== ref.matrixAuthoritySha256 || a.header.matrixAuthoritySha256 !== a.digest
    || a.header.matrixApprovalEvidence !== ref.matrixApprovalEvidence || links.length !== 1 || links[0]?.state !== "materialized"
    || links[0]?.branch !== binding.branch || links[0]?.baseSha !== binding.baseSha || approvals.length !== 1 || approvals[0]?.author !== "sinh"
    || [ref.matrixSource, a.digest, binding.branch].some((value) => approvals[0]!.content.split(value).length - 1 !== 1)) reject("review.reference", "durable artifact, ticket branch and approval changed or conflict");
}
export function versionedReviewEnvironment(matrix: ReviewMatrix, objective: ReviewObjective, root: string, trustedPath: string): Record<string, string> {
  if (!trustedPath || trustedPath.split(":").some((entry) => !isAbsolute(entry)) || trustedPath.includes("review-auth:")) reject("environment.PATH", "requires an explicit non-authority trusted absolute PATH");
  const bindings = { worktreeRoot: root, featureSha: objective.featureSha, matrixSource: objective.matrixSource,
    matrixAuthoritySha256: objective.matrixAuthoritySha256, matrixApprovalEvidence: objective.matrixApprovalEvidence, trustedPath };
  const environment = Object.fromEntries(Object.entries(matrix.environment).map(([name, value]) => [name, "literal" in value ? value.literal : bindings[value.binding]]));
  if (Object.values(environment).some((value) => value.includes("review-auth:") || value.includes("\0"))) reject("environment", "command environment contains protected authority");
  return environment;
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function evaluateVersionedPrerequisites(matrix: ReviewMatrix, root: string, environment: Record<string, string>): void {
  for (const [index, p] of matrix.prerequisites.entries()) {
    const source = `matrix.prerequisites[${index}]`;
    if (p.kind === "platform" && (p.os !== process.platform || p.arch !== process.arch)) reject(source, "exact declared platform/architecture is unmet");
    if (p.kind === "tool") {
      const binary = p.name === "pnpm" ? "corepack" : p.name;
      const args = p.name === "pnpm" ? ["pnpm", "--version"] : ["--version"];
      let actual: string;
      try {
        // Corepack must only inspect an already available package manager. Its normal
        // auto-download/auto-pin behavior is repair, not a prerequisite observation.
        const probeEnvironment = { ...environment, COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0" };
        actual = execFileSync(binary, args, { cwd: root, env: probeEnvironment, encoding: "utf8", timeout: 30_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0]!;
      }
      catch { return reject(source, "fixed launcher-owned tool probe failed; no install or repair is allowed"); }
      if (actual !== p.version) reject(source, "fixed tool probe first stdout line differs from the declared exact version");
    }
    if (p.kind === "dependency") {
      try {
        const packageRoot = resolve(root, p.root);
        if (realpathSync(packageRoot) !== packageRoot || !contained(root, packageRoot)) throw new Error("root alias");
        const metadata = realpathSync(resolve(packageRoot, "node_modules", p.name, "package.json"));
        if (!contained(root, metadata)) throw new Error("escaped dependency");
        const raw = parseReviewEvidenceJson(readReviewEvidenceFile(metadata, 1_048_576, source), source) as { name?: unknown; version?: unknown };
        if (raw.name !== p.name || raw.version !== p.version) throw new Error("metadata mismatch");
      } catch { reject(source, "contained installed package metadata does not match its declared exact root/name/version"); }
    }
  }
}
/** Runtime source identity and target candidate identity are separate for external projects. */
export function assertVersionedRuntimeProvenance(provenance: Record<string, unknown>, binding: ReviewReadinessBinding,
  checkout: Pick<ReviewCheckoutEvidence, "repoKey" | "featureSha">, candidateConfigSha?: string): void {
  if (provenance.schemaVersion !== REVIEW_RUNTIME_PROVENANCE_VERSION
    || provenance.sourceSha !== binding.installedRuntime.sourceSha || provenance.configSha !== binding.mergedConfigSha
    || provenance.packageName !== binding.installedRuntime.packageName || provenance.packageVersion !== binding.installedRuntime.packageVersion
    || provenance.objectiveSchema !== "pa-review-objective/v1" || provenance.matrixSchema !== "pa-review-matrix/v1"
    || binding.featureSha !== checkout.featureSha) reject("readiness.installedRuntime", "runtime source/package/config provenance or target candidate binding conflicts");
  // PAP-237 self-review requires a package built from that same PA candidate.
  // Other repositories neither own PPA's source revision nor its config-pin file.
  if (checkout.repoKey === "pa-platform" && (provenance.sourceSha !== checkout.featureSha || candidateConfigSha !== binding.mergedConfigSha)) {
    reject("readiness.installedRuntime", "pa-platform self-review requires candidate-built runtime and matching candidate config pin");
  }
}
export function authenticateVersionedReadiness(bindings: ReviewReadinessBinding[], checkout: ReviewCheckoutEvidence): void {
  for (const binding of bindings) {
    const binary = binding.installedRuntime.binary;
    const store = dirname(dirname(binary));
    const module = realpathSync(fileURLToPath(import.meta.url));
    let provenance: Record<string, unknown>;
    try {
      if (realpathSync(binary) !== binary || !module.startsWith(`${store}/share/pa-platform/`)) throw new Error("not running approved runtime");
      const path = resolve(store, "share/pa-platform/review-runtime-provenance.json");
      provenance = parseReviewEvidenceJson(readReviewEvidenceFile(path, 65_536, "runtime.provenance"), "runtime.provenance") as Record<string, unknown>;
      const candidateConfigSha = checkout.repoKey === "pa-platform" ? readFileSync(resolve(checkout.worktreeRoot, ".pa-platform-config.sha"), "utf8").trim() : undefined;
      assertVersionedRuntimeProvenance(provenance, binding, checkout, candidateConfigSha);
      const configRoot = loadReposYaml()["pa-platform-config"]?.path ?? getPlatformHomeDir();
      if (realpathSync(configRoot) !== configRoot) throw new Error("config root alias");
      const configGit = (args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", configRoot, ...args], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC" }, encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (configGit(["rev-parse", "--show-toplevel"]) !== configRoot || configGit(["rev-parse", "HEAD"]) !== binding.mergedConfigSha
        || configGit(["status", "--porcelain", "--untracked-files=all"]) !== "") throw new Error("paired config identity drift");
      configGit(["merge-base", "--is-ancestor", binding.mergedConfigSha, "origin/develop"]);
      if (readReviewProducerFixtures(configRoot) !== 3) throw new Error("paired producer schemas unavailable");
      for (const [ticketId, reference] of [["PAP-232", binding.pap232Evidence], ["PAP-235", binding.pap235Evidence]]) {
        const match = new RegExp(`^${ticketId}/(c-[0-9]{17})$`).exec(reference!);
        if (!match) throw new Error("integration reference grammar");
        const ticket = reviewPreflightDependencies().readTicket(ticketId!);
        const comments = ticket.comments.filter((comment) => comment.id === match[1]);
        if (ticket.status !== "done" || comments.length !== 1 || comments[0]?.author !== "sinh") throw new Error("integration readiness not approved");
      }
    } catch { reject("readiness.installedRuntime", "approved store binary/package/source/config or separately completed PAP-232/PAP-235 integration evidence is unavailable or mismatched"); }
  }
}
/** Reread static approval/profile/environment and live prerequisites immediately at execution boundary. */
export function revalidateVersionedReview(launch: Pick<PiProtectedValidationLaunch, "review" | "deploymentId" | "validationHandoff" | "matrixProfile">, dependencies: VersionedReviewDependencies = {}): void {
  const review = launch.review;
  const checkout = review.checkout;
  if (!checkout) reject("review.checkout", "distinct authenticated candidate evidence is absent");
  const starts = getDeploymentEvents(launch.deploymentId).filter((event) => event.event === "started");
  if (starts.length !== 1 || !starts[0]?.objective) reject("review.start", "one immutable durable start objective is required");
  const original = parseReviewObjective(starts[0].objective);
  if (original.ticket !== review.ticketId || original.branch !== review.branch || original.featureSha !== review.featureSha
    || original.matrixSource !== review.matrixSource || original.matrixAuthoritySha256 !== review.matrixAuthoritySha256
    || original.matrixApprovalEvidence !== review.matrixApprovalEvidence || original.reviewAuthorizationId !== review.authorizationId
    || JSON.stringify(original.prerequisiteEvidence) !== JSON.stringify((launch as PiProtectedValidationLaunch).prerequisiteEvidence)) reject("review.start", "protected transport or selected gates conflict with immutable start authority");
  const { artifact: a, readiness, objective: o } = requireReviewPreflight({ ticket: review.ticketId, objective: starts[0].objective });
  const handoff = launch.validationHandoff as ValidationHandoff;
  if (a.matrix.profile !== launch.matrixProfile || JSON.stringify(versionedReviewEnvironment(a.matrix, o, checkout.worktreeRoot, process.env.PATH ?? "")) !== JSON.stringify(handoff.manifest.environment)) reject("review.environment", "approved profile or concrete environment drifted");
  const commands = a.matrix.commands.map((command) => ({ ...command, cwd: resolve(checkout.worktreeRoot, command.cwd), artifacts: [] }));
  if (JSON.stringify(commands) !== JSON.stringify(handoff.manifest.commands)) reject("review.commands", "ordered commands, roots or executor bounds conflict with approved matrix bytes");
  if (JSON.stringify(a.matrix.prerequisites.map((p, index) => ({ sourceOrder: index + 1, text: JSON.stringify(p), status: "verified" }))) !== JSON.stringify((launch as PiProtectedValidationLaunch).admission?.prerequisites)) reject("review.prerequisites", "protected prerequisite observations conflict with approved typed declarations");
  const receipt = queryReviewAuthorizationClaim(review.authorizationId);
  if (!receipt?.active || receipt.deploymentId !== launch.deploymentId || receipt.ticketId !== review.ticketId || receipt.branch !== review.branch
    || receipt.featureSha !== review.featureSha || receipt.matrixSource !== review.matrixSource || receipt.matrixAuthoritySha256 !== review.matrixAuthoritySha256
    || receipt.matrixApprovalEvidence !== review.matrixApprovalEvidence) reject("review.authorization", "durable active exact one-use receipt drifted");
  (dependencies.verifyReadiness ?? authenticateVersionedReadiness)(readiness, checkout as ReviewCheckoutEvidence);
  evaluateVersionedPrerequisites(a.matrix, checkout.worktreeRoot, handoff.manifest.environment);
}
export async function createVersionedValidationLaunch(input: PiValidationLaunchInput, dependencies: VersionedReviewDependencies = {}): Promise<PiProtectedValidationLaunch> {
  const { plan, request, deploymentId } = input;
  const { objective: o, artifact: a, readiness } = requireReviewPreflight({ ticket: request.ticket ?? "", objective: request.objective ?? "" });
  const checkout = plan.reviewCheckout;
  if (!request.background || request.resume || plan.runtime !== "pi" || plan.team !== "requirements" || plan.mode !== "review-auto" || !checkout?.approvedReference
    || plan.ticket !== o.ticket || plan.repoKey !== a.matrix.repository.key || plan.repoRoot !== a.matrix.repository.root
    || plan.worktreeRoot === plan.repoRoot || plan.repositoryCwd !== plan.worktreeRoot
    || plan.environment.PA_REPO !== plan.worktreeRoot || plan.environment.PA_WORKTREE_ROOT !== plan.worktreeRoot
    || plan.environment.PA_REPO_ROOT !== plan.repoRoot || plan.environment.PA_DEPLOYMENT_DIR !== input.deploymentDirectory
    || checkout.headSha !== o.featureSha || checkout.branch !== o.branch || checkout.baseSha !== a.matrix.repository.baseSha) reject("review.plan", "immutable plan, distinct checkout and approved v1 objective do not agree");
  assertVersionedReviewReference(checkout);
  assertRepositoryGitIdentity(plan.worktreeRoot, checkout.repositoryGitDir, checkout.repositoryGitCommonDir);
  const snapshot = captureRepositoryGitSnapshot(plan.worktreeRoot);
  if (snapshot.dirty || snapshot.branch !== o.branch || snapshot.head !== o.featureSha) reject("review.candidate", "candidate is dirty or branch/HEAD drifted");
  const environment = versionedReviewEnvironment(a.matrix, o, plan.worktreeRoot, input.environment.PATH ?? process.env.PATH ?? "");
  // Actual-launch accounting stays before live prerequisite observations and authorization claim.
  const started = writePiMatrixStartedEvent({ deploymentDirectory: input.deploymentDirectory, event: {
    deploymentId, authorizationId: o.reviewAuthorizationId, ticketId: o.ticket, branch: o.branch, featureSha: o.featureSha,
    candidateHead: snapshot.head!, matrixSource: o.matrixSource, matrixAuthoritySha256: o.matrixAuthoritySha256,
    matrixApprovalEvidence: o.matrixApprovalEvidence, repoKey: plan.repoKey, repoRoot: plan.repoRoot, worktreeRoot: plan.worktreeRoot,
  } });
  (dependencies.verifyReadiness ?? authenticateVersionedReadiness)(readiness, checkout);
  evaluateVersionedPrerequisites(a.matrix, plan.worktreeRoot, environment);
  claimReviewAuthorization({ deploymentId, authorizationId: o.reviewAuthorizationId, ticketId: o.ticket, branch: o.branch,
    featureSha: o.featureSha, matrixSource: o.matrixSource, matrixAuthoritySha256: o.matrixAuthoritySha256,
    matrixApprovalEvidence: o.matrixApprovalEvidence, objective: request.objective! });
  const repository = { repoKey: plan.repoKey, canonicalRoot: plan.repoRoot, worktreeRoot: plan.worktreeRoot };
  const protectedEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) => name.startsWith("PA_")));
  const manifest = { schemaVersion: VALIDATION_MANIFEST_SCHEMA_VERSION, ticketId: o.ticket, branch: o.branch, featureSha: o.featureSha,
    matrix: { source: o.matrixSource, authoritySha256: o.matrixAuthoritySha256, approvalEvidence: o.matrixApprovalEvidence }, repository, environment,
    commands: a.matrix.commands.map((command) => ({ ...command, cwd: resolve(plan.worktreeRoot, command.cwd), artifacts: [] })) };
  const authority: ValidationAuthorityBinding = { ticketId: o.ticket, branch: o.branch, featureSha: o.featureSha, matrixSource: o.matrixSource,
    matrixAuthoritySha256: o.matrixAuthoritySha256, matrixApprovalEvidence: o.matrixApprovalEvidence, repository, protectedEnvironment };
  const { repositoryGitDir: _git, repositoryGitCommonDir: _common, gitSnapshot: _snapshot, ...identity } = checkout;
  return { schemaVersion: PI_PROTECTED_VALIDATION_SCHEMA_VERSION, deploymentId, matrixProfile: a.matrix.profile,
    historicalBaseProvenance: "header", prerequisiteEvidence: o.prerequisiteEvidence,
    admission: { authorization: "consumed", matrixDigest: "verified", featureSha: "verified", approval: "verified", activeReview: "admitted",
      prerequisites: a.matrix.prerequisites.map((p, index) => ({ sourceOrder: index + 1, text: JSON.stringify(p), status: "verified" })) },
    validationHandoff: { schemaVersion: VALIDATION_HANDOFF_SCHEMA_VERSION, manifestSha256: digestValidationManifest(manifest), manifest,
      repositoryEvidence: { ...repository, ticketId: o.ticket, branch: o.branch, featureSha: o.featureSha, authenticated: true }, protectedEnvironment }, authority,
    review: { checkout: identity, reviewDeploymentId: deploymentId, candidateHead: snapshot.head!, prerequisiteStartedAt: started.timestamp,
      authorizationId: o.reviewAuthorizationId, ticketId: o.ticket, branch: o.branch, featureSha: o.featureSha, matrixSource: o.matrixSource,
      matrixAuthoritySha256: o.matrixAuthoritySha256, matrixApprovalEvidence: o.matrixApprovalEvidence } };
}
