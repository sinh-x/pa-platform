import { parseRepositoryTicketSlot, type RepositoryTicketSlot } from "./ticket-concurrency.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { formatBoundedFiveFieldDiagnostic } from "../repos.js";
import { parseRepositoryGitStatus } from "./repository-admission.js";
import { assertReservationInventory, assertUnresetExecutionBounds, executionBoundStop, parseExecutionBounds, parseExecutionCustody, type ExecutionBounds, type ExecutionHolder, type IdlePreparationReservation } from "./execution-custody.js";
import { parseSourceVersion, workflowDigest, workflowObject, workflowPath, workflowSha, workflowText, type SourceVersion } from "./prepared-workflow.js";

/** Phase-1 pure contract model. NO admission, authority resolver, store, effect or activation. */
export const REQUIREMENTS_TEST_WORKFLOW_VERSION = "requirements-test-workflow/v1";
export const REQUIREMENTS_TEST_LIMITS = Object.freeze({ recordBytes: 65_536, events: 256, paths: 64, checks: 64, commits: 128, outputBytes: 16_777_216, retries: 3 });
export function requirementsTestCapability(_untrusted?: unknown): Readonly<{ enabled: false; legacyUnchanged: true; reason: "unqualified-inactive" }> {
  return Object.freeze({ enabled: false, legacyUnchanged: true, reason: "unqualified-inactive" });
}
function stop(): Error {
  return new Error(formatBoundedFiveFieldDiagnostic({ condition: "requirements test workflow stopped", source: "requirements-test-workflow/v1 pure contract", reason: "unsupported, missing, conflicting, exhausted or uncertain evidence", correction: "preserve history and resources; owning runtime/operator must reconcile exact evidence", resumeAction: "resume first unproven action only after independent authentication; route remains inactive" }));
}
/** Parsing is deliberately not authentication; all diagnostics exclude input and raw streams. */
function guarded<T>(action: () => T): T { try { return action(); } catch { throw stop(); } }
function bytes(input: string | Uint8Array): Uint8Array {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) throw stop();
  if (typeof input === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) throw stop();
  const result = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (result.byteLength === 0 || result.byteLength > REQUIREMENTS_TEST_LIMITS.recordBytes) throw stop();
  return result;
}
function json(input: string | Uint8Array): unknown { return parseReviewEvidenceJson(bytes(input), "requirements-test-workflow/v1"); }
function obj(input: unknown, keys: string): Record<string, unknown> { return workflowObject(input, keys.split(" ")); }
function int(input: unknown, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max) throw stop();
  return input;
}
function list<T>(input: unknown, parse: (value: unknown) => T, min = 1, max = 64): readonly T[] {
  if (!Array.isArray(input) || input.length < min || input.length > max) throw stop();
  return Object.freeze(input.map(parse));
}
function unique<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  if (new Set(values.map(key)).size !== values.length) throw stop();
  return values;
}
function choice<const T extends readonly string[]>(input: unknown, choices: T): T[number] {
  if (typeof input !== "string" || !choices.includes(input)) throw stop();
  return input as T[number];
}
function literal<T>(input: unknown, expected: T): T { if (input !== expected) throw stop(); return expected; }
function id(input: unknown): string {
  const value = workflowText(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw stop();
  return value;
}
function relative(input: unknown, cwd = false): string {
  const value = workflowText(input);
  if (cwd && value === ".") return value;
  if (value.length > 512 || !/^[A-Za-z0-9_./-]+$/.test(value) || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) throw stop();
  return value;
}
function nullableDigest(input: unknown): string | null { return input === null ? null : workflowSha(input); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function holder(input: unknown): ExecutionHolder {
  const custody = parseExecutionCustody({ state: "implement-child", holder: input, inFlightOperation: null });
  if (!custody.holder) throw stop();
  return custody.holder;
}
function strings(input: unknown, min = 1): readonly string[] { return unique(list(input, id, min), (value) => value); }

export interface TestPath {
  readonly path: string; readonly role: "test" | "harness"; readonly existence: "existing" | "new";
  readonly beforeSha256: string | null; readonly actions: readonly ("write" | "edit")[]; readonly rationale: string;
}
function testPath(input: unknown): TestPath {
  const row = obj(input, "path role existence beforeSha256 actions rationale");
  const existence = choice(row.existence, ["existing", "new"]);
  const beforeSha256 = nullableDigest(row.beforeSha256);
  if ((existence === "new") !== (beforeSha256 === null)) throw stop();
  const actions = unique(list(row.actions, (value) => choice(value, ["write", "edit"]), 1, 2), (value) => value);
  if (existence === "new" && !actions.includes("write")) throw stop();
  return Object.freeze({ path: relative(row.path), role: choice(row.role, ["test", "harness"]), existence, beforeSha256, actions, rationale: workflowText(row.rationale) });
}
export interface TestEnvironment { readonly name: "CI" | "LANG" | "TZ" | "PATH"; readonly source: SourceVersion }
function environment(input: unknown): readonly TestEnvironment[] {
  return unique(list(input, (value) => {
    const row = obj(value, "name source");
    return Object.freeze({ name: choice(row.name, ["CI", "LANG", "TZ", "PATH"]), source: parseSourceVersion(row.source) });
  }, 0, 4), (value) => value.name);
}
export interface TestCheck {
  readonly id: string; readonly kind: "baseline" | "feature" | "control"; readonly assertion: string;
  readonly reason: string; readonly controlFor: string | null; readonly input: SourceVersion;
  readonly command: string; readonly cwd: string; readonly environment: readonly TestEnvironment[];
  readonly timeoutSeconds: number; readonly maxOutputBytes: number;
}
function check(input: unknown): TestCheck {
  const row = obj(input, "id kind assertion reason controlFor input command cwd environment timeoutSeconds maxOutputBytes");
  return Object.freeze({ id: id(row.id), kind: choice(row.kind, ["baseline", "feature", "control"]), assertion: id(row.assertion), reason: workflowText(row.reason), controlFor: row.controlFor === null ? null : id(row.controlFor), input: parseSourceVersion(row.input), command: workflowText(row.command), cwd: relative(row.cwd, true), environment: environment(row.environment), timeoutSeconds: int(row.timeoutSeconds, 1, 14_400), maxOutputBytes: int(row.maxOutputBytes, 1, REQUIREMENTS_TEST_LIMITS.outputBytes) });
}
export interface TestRepository { readonly key: string; readonly root: string; readonly ticket: string; readonly baseSha: string; readonly branch: string; readonly selectedHeadSha: string }
function repository(input: unknown): TestRepository {
  const row = obj(input, "key root ticket baseSha branch selectedHeadSha");
  const ticket = workflowText(row.ticket); const branch = workflowText(row.branch);
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket) || !branch.startsWith(`feature/${ticket}-`) || !/^[A-Za-z0-9/_-]+$/.test(branch) || branch.endsWith("/") || branch.includes("//")) throw stop();
  return Object.freeze({ key: id(row.key), root: workflowPath(row.root), ticket, baseSha: workflowSha(row.baseSha, 40), branch, selectedHeadSha: workflowSha(row.selectedHeadSha, 40) });
}
export interface TestAmendment {
  readonly previousAuthorizationSha256: string; readonly contract: SourceVersion; readonly assertions: SourceVersion;
  readonly repository: TestRepository; readonly testHeadSha: string; readonly tests: readonly { readonly path: string; readonly sha256: string }[];
  readonly changedPaths: readonly string[]; readonly approval: SourceVersion;
}
function file(input: unknown): { readonly path: string; readonly sha256: string } {
  const row = obj(input, "path sha256"); return Object.freeze({ path: relative(row.path), sha256: workflowSha(row.sha256) });
}
function amendment(input: unknown): TestAmendment | null {
  if (input === null) return null;
  const row = obj(input, "previousAuthorizationSha256 contract assertions repository testHeadSha tests changedPaths approval");
  return Object.freeze({ previousAuthorizationSha256: workflowSha(row.previousAuthorizationSha256), contract: parseSourceVersion(row.contract), assertions: parseSourceVersion(row.assertions), repository: repository(row.repository), testHeadSha: workflowSha(row.testHeadSha, 40), tests: unique(list(row.tests, file), (value) => value.path), changedPaths: unique(list(row.changedPaths, (value) => relative(value)), (value) => value), approval: parseSourceVersion(row.approval) });
}
export interface TestAuthorization {
  readonly schemaVersion: typeof REQUIREMENTS_TEST_WORKFLOW_VERSION; readonly kind: "authorization"; readonly operationId: string;
  readonly repository: TestRepository; readonly parent: { readonly holder: ExecutionHolder; readonly runtime: "pi"; readonly team: "requirements"; readonly mode: "analyze"; readonly channel: "foreground"; readonly root: string };
  readonly contract: SourceVersion; readonly assertions: SourceVersion;
  readonly pair: { readonly runtimeSha: string; readonly configSha: string; readonly qualification: SourceVersion; readonly toolsAuditDecision: SourceVersion };
  readonly approvalOwner: "sinh"; readonly scope: "test-only"; readonly productBehavior: "forbidden";
  readonly paths: readonly TestPath[]; readonly checks: readonly TestCheck[]; readonly humanOnly: readonly string[];
  readonly bounds: ExecutionBounds; readonly retryLimit: number; readonly retriesUsed: number; readonly elapsedMs: number; readonly cancellation: "retain"; readonly resume: "first-unproven"; readonly amendment: TestAmendment | null;
}
function authorization(input: unknown): TestAuthorization {
  const row = obj(input, "schemaVersion kind operationId repository parent contract assertions pair approvalOwner scope productBehavior paths checks humanOnly bounds retryLimit retriesUsed elapsedMs cancellation resume amendment");
  const repo = repository(row.repository); const parent = obj(row.parent, "holder runtime team mode channel root");
  const pair = obj(row.pair, "runtimeSha configSha qualification toolsAuditDecision");
  const bounds = parseExecutionBounds(row.bounds);
  const retryLimit = int(row.retryLimit, 1, REQUIREMENTS_TEST_LIMITS.retries);
  const retriesUsed = int(row.retriesUsed, 0, retryLimit);
  const elapsedMs = int(row.elapsedMs, 0, 86_400_000);
  // Fresh packets start at zero; amendments carry prior accounting, checked against replay below.
  if (row.amendment === null && (bounds.consecutiveNoProgress || bounds.replacementsUsed || bounds.reviewsUsed || bounds.unresolvedFailureRef !== null || retriesUsed || elapsedMs)) throw stop();
  const paths = unique(list(row.paths, testPath), (value) => value.path);
  const checks = unique(list(row.checks, check), (value) => value.id);
  if (!checks.some((value) => value.kind === "baseline") || !checks.some((value) => value.kind === "feature")) throw stop();
  for (const value of checks) {
    if (value.timeoutSeconds > bounds.runtimeMinutes * 60) throw stop();
    if (value.kind !== "control" && value.controlFor !== null) throw stop();
    if (value.kind === "feature" && !checks.some((control) => control.kind === "control" && control.controlFor === value.id)) throw stop();
    if (value.kind === "control") {
      const feature = checks.find((feature) => feature.id === value.controlFor && feature.kind === "feature");
      if (!feature || value.assertion !== feature.assertion || value.reason !== feature.reason || value.input.sha256 === feature.input.sha256) throw stop();
    }
  }
  const amend = amendment(row.amendment);
  if (parent.root !== repo.root || (!amend && repo.selectedHeadSha !== repo.baseSha)) throw stop();
  if (amend && (amend.repository.key !== repo.key || amend.repository.root !== repo.root || amend.repository.ticket !== repo.ticket || amend.repository.branch !== repo.branch || amend.repository.baseSha !== repo.baseSha || amend.testHeadSha !== repo.selectedHeadSha || amend.changedPaths.some((path) => !paths.some((entry) => entry.path === path)) || paths.some((path) => path.beforeSha256 !== (amend.tests.find((old) => old.path === path.path)?.sha256 ?? null)))) throw stop();
  return Object.freeze({ schemaVersion: literal(row.schemaVersion, REQUIREMENTS_TEST_WORKFLOW_VERSION), kind: literal(row.kind, "authorization"), operationId: workflowSha(row.operationId), repository: repo,
    parent: Object.freeze({ holder: holder(parent.holder), runtime: literal(parent.runtime, "pi"), team: literal(parent.team, "requirements"), mode: literal(parent.mode, "analyze"), channel: literal(parent.channel, "foreground"), root: workflowPath(parent.root) }), contract: parseSourceVersion(row.contract), assertions: parseSourceVersion(row.assertions),
    pair: Object.freeze({ runtimeSha: workflowSha(pair.runtimeSha, 40), configSha: workflowSha(pair.configSha, 40), qualification: parseSourceVersion(pair.qualification), toolsAuditDecision: parseSourceVersion(pair.toolsAuditDecision) }),
    approvalOwner: literal(row.approvalOwner, "sinh"), scope: literal(row.scope, "test-only"), productBehavior: literal(row.productBehavior, "forbidden"), paths, checks, humanOnly: strings(row.humanOnly, 0), bounds, retryLimit, retriesUsed, elapsedMs, cancellation: literal(row.cancellation, "retain"), resume: literal(row.resume, "first-unproven"), amendment: amend });
}
export function parseTestAuthorization(input: string | Uint8Array): TestAuthorization { return guarded(() => authorization(json(input))); }

export interface TestProcessResult {
  readonly checkId: string; readonly command: string; readonly cwd: string; readonly environment: readonly TestEnvironment[];
  readonly candidateSha: string; readonly input: SourceVersion; readonly process: ExecutionHolder;
  readonly stdout: SourceVersion; readonly stderr: SourceVersion; readonly assertionEvidence: SourceVersion;
  readonly exitCode: number | null; readonly signal: string | null; readonly disposition: "exited" | "timeout" | "cancelled" | "unknown" | "not-run";
  readonly startedElapsedMs: number; readonly finishedElapsedMs: number; readonly durationMs: number; readonly outputBytes: number; readonly truncated: boolean;
  readonly observations: readonly { readonly assertion: string; readonly outcome: "satisfied" | "violated" | "runner-error" | "import-error" | "prerequisite-error" | "unknown"; readonly reason: string }[];
}
function result(input: unknown): TestProcessResult {
  const row = obj(input, "checkId command cwd environment candidateSha input process stdout stderr assertionEvidence exitCode signal disposition startedElapsedMs finishedElapsedMs durationMs outputBytes truncated observations");
  if (typeof row.truncated !== "boolean") throw stop();
  return Object.freeze({ checkId: id(row.checkId), command: workflowText(row.command), cwd: relative(row.cwd, true), environment: environment(row.environment), candidateSha: workflowSha(row.candidateSha, 40), input: parseSourceVersion(row.input), process: holder(row.process), stdout: parseSourceVersion(row.stdout), stderr: parseSourceVersion(row.stderr), assertionEvidence: parseSourceVersion(row.assertionEvidence), exitCode: row.exitCode === null ? null : int(row.exitCode, 0, 255), signal: row.signal === null ? null : id(row.signal), disposition: choice(row.disposition, ["exited", "timeout", "cancelled", "unknown", "not-run"]), startedElapsedMs: int(row.startedElapsedMs, 0, 86_400_000), finishedElapsedMs: int(row.finishedElapsedMs, 0, 86_400_000), durationMs: int(row.durationMs, 0, 86_400_000), outputBytes: int(row.outputBytes, 0, REQUIREMENTS_TEST_LIMITS.outputBytes), truncated: row.truncated,
    observations: unique(list(row.observations, (input) => { const observation = obj(input, "assertion outcome reason"); return Object.freeze({ assertion: id(observation.assertion), outcome: choice(observation.outcome, ["satisfied", "violated", "runner-error", "import-error", "prerequisite-error", "unknown"]), reason: workflowText(observation.reason) }); }), (value) => value.assertion) });
}
export type TestResultClass = "baseline-pass" | "intended-assertion-red" | "wrong-output-rejected" | "blocked";
/** Structured assertion facts are native collector evidence, NOT a caller-provided passed flag. */
export function classifyTestResult(checkInput: TestCheck, resultInput: TestProcessResult): TestResultClass {
  return guarded(() => {
    const expected = check(checkInput); const actual = result(resultInput);
    if (actual.checkId !== expected.id || actual.command !== expected.command || actual.cwd !== expected.cwd || !same(actual.environment, expected.environment) || !same(actual.input, expected.input) || actual.disposition !== "exited" || actual.exitCode === null || actual.signal !== null || actual.truncated || actual.durationMs > expected.timeoutSeconds * 1000 || actual.finishedElapsedMs - actual.startedElapsedMs !== actual.durationMs || actual.outputBytes > expected.maxOutputBytes || actual.observations.length !== 1) return "blocked";
    const observation = actual.observations[0]!;
    if (observation.assertion !== expected.assertion || observation.reason !== expected.reason) return "blocked";
    if (expected.kind === "baseline") return actual.exitCode === 0 && observation.outcome === "satisfied" ? "baseline-pass" : "blocked";
    if (actual.exitCode === 0 || observation.outcome !== "violated") return "blocked";
    return expected.kind === "feature" ? "intended-assertion-red" : "wrong-output-rejected";
  });
}

export interface TestResource {
  readonly repository: TestRepository; readonly worktreeRoot: string; readonly leaseId: string; readonly leaseHolder: string;
  readonly reservationId: string; readonly repositoryPermit: number; readonly lineageId: string;
}
function resource(input: unknown): TestResource {
  const row = obj(input, "repository worktreeRoot leaseId leaseHolder reservationId repositoryPermit lineageId");
  const repo = repository(row.repository); const worktreeRoot = workflowPath(row.worktreeRoot);
  if (worktreeRoot === repo.root) throw stop();
  return Object.freeze({ repository: repo, worktreeRoot, leaseId: id(row.leaseId), leaseHolder: literal(row.leaseHolder, `pa:${repo.key}:${repo.ticket}`), reservationId: workflowSha(row.reservationId), repositoryPermit: int(row.repositoryPermit, 1, 4), lineageId: id(row.lineageId) });
}
interface TestChange { readonly path: string; readonly previousPath: string | null; readonly beforeSha256: string | null; readonly afterSha256: string | null }
interface TestCommit { readonly sha: string; readonly parentSha: string; readonly changes: readonly TestChange[] }
export interface TestGitEvidence {
  readonly baseSha: string; readonly initialHeadSha: string; readonly testHeadSha: string; readonly ancestry: readonly string[];
  readonly commits: readonly TestCommit[]; readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly porcelainV2Base64: string; readonly inventory: SourceVersion;
}
function git(input: unknown): TestGitEvidence {
  const row = obj(input, "baseSha initialHeadSha testHeadSha ancestry commits files porcelainV2Base64 inventory");
  const raw = typeof row.porcelainV2Base64 === "string" ? row.porcelainV2Base64 : (() => { throw stop(); })();
  if (Buffer.from(raw, "base64").toString("base64") !== raw) throw stop();
  // Parse losslessly through the owning Git parser, never split on whitespace/newlines.
  parseRepositoryGitStatus(Buffer.from(raw, "base64"));
  return Object.freeze({ baseSha: workflowSha(row.baseSha, 40), initialHeadSha: workflowSha(row.initialHeadSha, 40), testHeadSha: workflowSha(row.testHeadSha, 40), ancestry: unique(list(row.ancestry, (value) => workflowSha(value, 40), 1, 128), (value) => value),
    commits: unique(list(row.commits, (input) => { const commit = obj(input, "sha parentSha changes"); return Object.freeze({ sha: workflowSha(commit.sha, 40), parentSha: workflowSha(commit.parentSha, 40), changes: unique(list(commit.changes, (input) => { const change = obj(input, "path previousPath beforeSha256 afterSha256"); return Object.freeze({ path: relative(change.path), previousPath: change.previousPath === null ? null : relative(change.previousPath), beforeSha256: nullableDigest(change.beforeSha256), afterSha256: nullableDigest(change.afterSha256) }); }), (value) => value.path) }); }, 1, REQUIREMENTS_TEST_LIMITS.commits), (value) => value.sha), files: unique(list(row.files, file), (value) => value.path), porcelainV2Base64: raw, inventory: parseSourceVersion(row.inventory) });
}
function assertGit(auth: TestAuthorization, evidence: TestGitEvidence): void {
  if (evidence.baseSha !== auth.repository.baseSha || evidence.initialHeadSha !== auth.repository.selectedHeadSha || evidence.ancestry[0] !== evidence.baseSha || evidence.ancestry.at(-1) !== evidence.initialHeadSha || evidence.porcelainV2Base64 !== "") throw stop();
  const contents = new Map(auth.paths.map((path) => [path.path, path.beforeSha256]));
  let head = evidence.initialHeadSha;
  const seen = new Set(evidence.ancestry);
  for (const commit of evidence.commits) {
    if (commit.parentSha !== head || seen.has(commit.sha)) throw stop();
    seen.add(commit.sha);
    for (const change of commit.changes) {
      const from = change.previousPath ?? change.path;
      if (!contents.has(from) || !contents.has(change.path) || contents.get(from) !== change.beforeSha256 || (from === change.path && change.beforeSha256 === change.afterSha256)) throw stop();
      if (from !== change.path) contents.set(from, null);
      contents.set(change.path, change.afterSha256);
    }
    head = commit.sha;
  }
  if (head !== evidence.testHeadSha || evidence.files.length !== auth.paths.length || evidence.files.some((file) => contents.get(file.path) !== file.sha256)) throw stop();
}

export interface OracleBinding {
  readonly authorizationSha256: string; readonly contract: SourceVersion; readonly assertions: SourceVersion;
  readonly testHeadSha: string; readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly resultsSha256: string; readonly gitSha256: string;
}
function oracle(input: unknown): OracleBinding {
  const row = obj(input, "authorizationSha256 contract assertions testHeadSha files resultsSha256 gitSha256");
  return Object.freeze({ authorizationSha256: workflowSha(row.authorizationSha256), contract: parseSourceVersion(row.contract), assertions: parseSourceVersion(row.assertions), testHeadSha: workflowSha(row.testHeadSha, 40), files: unique(list(row.files, file), (value) => value.path), resultsSha256: workflowSha(row.resultsSha256), gitSha256: workflowSha(row.gitSha256) });
}
interface FinalPair { readonly requirements: SourceVersion; readonly uat: SourceVersion; readonly matrix: SourceVersion; readonly matrixApproval: SourceVersion; readonly finalChecks: SourceVersion; readonly finalCheckCount: 13 }
function finalPair(input: unknown): FinalPair {
  const row = obj(input, "requirements uat matrix matrixApproval finalChecks finalCheckCount");
  const requirements = parseSourceVersion(row.requirements); const uat = parseSourceVersion(row.uat); const matrix = parseSourceVersion(row.matrix);
  if (requirements.ref === uat.ref || requirements.ref !== matrix.ref) throw stop();
  return Object.freeze({ requirements, uat, matrix, matrixApproval: parseSourceVersion(row.matrixApproval), finalChecks: parseSourceVersion(row.finalChecks), finalCheckCount: literal(row.finalCheckCount, 13) });
}
export type TestCapacityInventory = readonly (IdlePreparationReservation | RepositoryTicketSlot)[];
function testInventory(input: unknown): TestCapacityInventory {
  const values = list(input, (value) => value, 1, 4);
  const prepared = assertReservationInventory(values.filter((value) => !(value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 1)));
  const legacy = values.filter((value) => value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 1).map(parseRepositoryTicketSlot);
  let p = 0; let l = 0;
  const rows = values.map((value) => value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 1 ? legacy[l++]! : prepared[p++]!);
  if (rows.some((row) => !row) || new Set(rows.map((row) => row.ticket)).size !== rows.length || new Set(rows.map((row) => row.repositoryPermit)).size !== rows.length) throw stop();
  return Object.freeze(rows);
}
export type TestEventData =
  | { readonly action: "authorized"; readonly owner: "sinh"; readonly decision: SourceVersion }
  | { readonly action: "intent-recorded"; readonly intentId: string }
  | { readonly action: "test-holder-active"; readonly intentId: string; readonly resource: TestResource; readonly holder: ExecutionHolder; readonly inventory: TestCapacityInventory; readonly registry: SourceVersion; readonly launchSnapshot: SourceVersion }
  | { readonly action: "test-settled"; readonly holder: ExecutionHolder; readonly settlement: SourceVersion; readonly git: TestGitEvidence; readonly results: readonly TestProcessResult[] }
  | { readonly action: "oracle-reviewed"; readonly oracle: OracleBinding; readonly reviewer: string; readonly delegation: SourceVersion | null; readonly decision: SourceVersion; readonly outcomeRationale: string; readonly wrongOutputRationale: string }
  | { readonly action: "final-approved"; readonly owner: "sinh"; readonly oracle: OracleBinding; readonly reviewSha256: string; readonly pair: FinalPair; readonly decision: SourceVersion }
  | { readonly action: "product-intent"; readonly resource: TestResource; readonly initialHeadSha: string; readonly finalApprovalSha256: string; readonly intentId: string }
  | { readonly action: "product-consumed"; readonly resource: TestResource; readonly initialHeadSha: string; readonly intentId: string; readonly holder: ExecutionHolder; readonly previousHolder: ExecutionHolder; readonly inventory: TestCapacityInventory; readonly launchSnapshot: SourceVersion; readonly registry: SourceVersion }
  | { readonly action: "interrupted"; readonly disposition: "known-absent" | "unknown" | "cancelled" | "failed"; readonly evidence: SourceVersion }
  | { readonly action: "retry"; readonly interruptionSha256: string; readonly owner: "sinh"; readonly decision: SourceVersion };
function data(input: unknown): TestEventData {
  if (input === null || typeof input !== "object" || !("action" in input)) throw stop();
  switch (input.action) {
    case "authorized": { const row = obj(input, "action owner decision"); return { action: "authorized", owner: literal(row.owner, "sinh"), decision: parseSourceVersion(row.decision) }; }
    case "intent-recorded": { const row = obj(input, "action intentId"); return { action: "intent-recorded", intentId: workflowSha(row.intentId) }; }
    case "test-holder-active": { const row = obj(input, "action intentId resource holder inventory registry launchSnapshot"); return { action: "test-holder-active", intentId: workflowSha(row.intentId), resource: resource(row.resource), holder: holder(row.holder), inventory: testInventory(row.inventory), registry: parseSourceVersion(row.registry), launchSnapshot: parseSourceVersion(row.launchSnapshot) }; }
    case "test-settled": { const row = obj(input, "action holder settlement git results"); return { action: "test-settled", holder: holder(row.holder), settlement: parseSourceVersion(row.settlement), git: git(row.git), results: unique(list(row.results, result), (value) => value.checkId) }; }
    case "oracle-reviewed": { const row = obj(input, "action oracle reviewer delegation decision outcomeRationale wrongOutputRationale"); return { action: "oracle-reviewed", oracle: oracle(row.oracle), reviewer: id(row.reviewer), delegation: row.delegation === null ? null : parseSourceVersion(row.delegation), decision: parseSourceVersion(row.decision), outcomeRationale: workflowText(row.outcomeRationale), wrongOutputRationale: workflowText(row.wrongOutputRationale) }; }
    case "final-approved": { const row = obj(input, "action owner oracle reviewSha256 pair decision"); return { action: "final-approved", owner: literal(row.owner, "sinh"), oracle: oracle(row.oracle), reviewSha256: workflowSha(row.reviewSha256), pair: finalPair(row.pair), decision: parseSourceVersion(row.decision) }; }
    case "product-intent": { const row = obj(input, "action resource initialHeadSha finalApprovalSha256 intentId"); return { action: "product-intent", resource: resource(row.resource), initialHeadSha: workflowSha(row.initialHeadSha, 40), finalApprovalSha256: workflowSha(row.finalApprovalSha256), intentId: workflowSha(row.intentId) }; }
    case "product-consumed": { const row = obj(input, "action resource initialHeadSha intentId holder previousHolder inventory launchSnapshot registry"); return { action: "product-consumed", resource: resource(row.resource), initialHeadSha: workflowSha(row.initialHeadSha, 40), intentId: workflowSha(row.intentId), holder: holder(row.holder), previousHolder: holder(row.previousHolder), inventory: testInventory(row.inventory), launchSnapshot: parseSourceVersion(row.launchSnapshot), registry: parseSourceVersion(row.registry) }; }
    case "interrupted": { const row = obj(input, "action disposition evidence"); return { action: "interrupted", disposition: choice(row.disposition, ["known-absent", "unknown", "cancelled", "failed"]), evidence: parseSourceVersion(row.evidence) }; }
    case "retry": { const row = obj(input, "action interruptionSha256 owner decision"); return { action: "retry", interruptionSha256: workflowSha(row.interruptionSha256), owner: literal(row.owner, "sinh"), decision: parseSourceVersion(row.decision) }; }
    default: throw stop();
  }
}
export interface TestWorkflowEvent {
  readonly schemaVersion: typeof REQUIREMENTS_TEST_WORKFLOW_VERSION; readonly kind: "event"; readonly operationId: string;
  readonly authorizationSha256: string; readonly sequence: number; readonly previousSha256: string;
  readonly bounds: ExecutionBounds; readonly retriesUsed: number; readonly elapsedMs: number; readonly evidence: SourceVersion; readonly data: TestEventData;
}
function event(input: unknown): TestWorkflowEvent {
  const row = obj(input, "schemaVersion kind operationId authorizationSha256 sequence previousSha256 bounds retriesUsed elapsedMs evidence data");
  return Object.freeze({ schemaVersion: literal(row.schemaVersion, REQUIREMENTS_TEST_WORKFLOW_VERSION), kind: literal(row.kind, "event"), operationId: workflowSha(row.operationId), authorizationSha256: workflowSha(row.authorizationSha256), sequence: int(row.sequence, 1, REQUIREMENTS_TEST_LIMITS.events), previousSha256: workflowSha(row.previousSha256), bounds: parseExecutionBounds(row.bounds), retriesUsed: int(row.retriesUsed, 0, REQUIREMENTS_TEST_LIMITS.retries), elapsedMs: int(row.elapsedMs, 0, 86_400_000), evidence: parseSourceVersion(row.evidence), data: Object.freeze(data(row.data)) });
}
export function parseTestWorkflowEvent(input: string | Uint8Array): TestWorkflowEvent { return guarded(() => event(json(input))); }
const stages = ["authorized", "intent-recorded", "test-holder-active", "test-settled", "oracle-reviewed", "final-approved", "product-intent", "product-consumed"] as const;
export interface TestWorkflowAssessment {
  readonly evidenceClass: "source-model"; readonly runtimeAuthorized: false; readonly productPass: false;
  readonly state: "unrequested" | typeof stages[number] | "blocked"; readonly firstUnprovenAction: typeof stages[number] | "none";
  readonly authorizationSha256: string; readonly historySha256: readonly string[]; readonly retriesUsed: number; readonly elapsedMs: number;
  readonly bounds: ExecutionBounds; readonly resource: TestResource | null; readonly oracle: OracleBinding | null;
}
function capacity(auth: TestAuthorization, retained: TestResource, owner: ExecutionHolder, inventory: TestCapacityInventory, custody: "implement-child" | "orchestrator-direct"): void {
  const row = inventory.find((entry) => entry.ticket === auth.repository.ticket);
  if (!same(retained.repository, auth.repository) || inventory.some((entry) => ("repoKey" in entry ? entry.repoKey : entry.canonicalRepoKey) !== auth.repository.key || ("repoRoot" in entry ? entry.repoRoot : entry.canonicalRepoRoot) !== auth.repository.root) || !row || !("operationId" in row) || row.operationId !== auth.operationId || row.reservationId !== retained.reservationId || row.repositoryPermit !== retained.repositoryPermit || row.lineageId !== retained.lineageId || row.occupancy !== "active" || row.custody.state !== custody || row.custody.inFlightOperation !== null || !same(row.custody.holder, owner)) throw stop();
}
/**
 * Replay ONLY a source model. A copied/rehashed journal is NOT native chronology.
 * Future consumers must independently resolve protected journal, process, Git and
 * approval evidence through EXISTING owners; this function cannot admit effects.
 */
export function assessTestWorkflow(authorizationInput: string | Uint8Array, history: readonly (string | Uint8Array)[]): TestWorkflowAssessment {
  return guarded(() => {
    const auth = parseTestAuthorization(authorizationInput); const authorizationSha256 = workflowDigest(bytes(authorizationInput));
    if (!Array.isArray(history) || history.length > REQUIREMENTS_TEST_LIMITS.events) throw stop();
    let previous = authorizationSha256; let bounds = auth.bounds; let retriesUsed = auth.retriesUsed; let elapsedMs = auth.elapsedMs; let stage = 0;
    let retained: TestResource | null = null; let author: ExecutionHolder | null = null; let intentId: string | null = null; let launchElapsedMs = 0;
    let productIntent: string | null = null; let exactOracle: OracleBinding | null = null; let reviewSha: string | null = null; let finalSha: string | null = null;
    let interruption: { sha256: string; disposition: string } | null = null;
    const hashes: string[] = [];
    for (const input of history) {
      const entry = parseTestWorkflowEvent(input); const hash = workflowDigest(bytes(input)); const value = entry.data;
      if (entry.sequence !== hashes.length + 1 || entry.previousSha256 !== previous || entry.authorizationSha256 !== authorizationSha256 || entry.operationId !== auth.operationId || entry.retriesUsed > auth.retryLimit || entry.retriesUsed < retriesUsed || entry.elapsedMs < elapsedMs) throw stop();
      // The existing comparison primitive preserves an established failure ref.
      // Only an actual failed-interruption record can introduce its first ref.
      const firstFailure = bounds.unresolvedFailureRef === null && entry.bounds.unresolvedFailureRef !== null;
      if (firstFailure && (value.action !== "interrupted" || value.disposition !== "failed" || entry.bounds.unresolvedFailureRef !== value.evidence.ref || entry.bounds.consecutiveNoProgress <= bounds.consecutiveNoProgress)) throw stop();
      assertUnresetExecutionBounds(firstFailure ? { ...bounds, unresolvedFailureRef: entry.bounds.unresolvedFailureRef } : bounds, entry.bounds);
      const serviceNow = new Date(Date.parse(bounds.startedAt) + entry.elapsedMs).toISOString();
      if (value.action === "interrupted") {
        if (interruption || stage === stages.length || entry.retriesUsed !== retriesUsed) throw stop();
        interruption = { sha256: hash, disposition: value.disposition };
      } else if (value.action === "retry") {
        if (!interruption || interruption.disposition !== "known-absent" || value.interruptionSha256 !== interruption.sha256 || entry.retriesUsed !== retriesUsed + 1 || executionBoundStop(entry.bounds, serviceNow)) throw stop();
        interruption = null;
      } else {
        if (interruption || value.action !== stages[stage] || entry.retriesUsed !== retriesUsed || executionBoundStop(entry.bounds, serviceNow)) throw stop();
        switch (value.action) {
          case "authorized": break;
          case "intent-recorded": intentId = value.intentId; break;
          case "test-holder-active": {
            if (value.intentId !== intentId || value.holder.deploymentId === auth.parent.holder.deploymentId) throw stop();
            capacity(auth, value.resource, value.holder, value.inventory, "implement-child"); retained = value.resource; author = value.holder; launchElapsedMs = entry.elapsedMs; break;
          }
          case "test-settled": {
            if (!same(value.holder, author) || value.results.length !== auth.checks.length) throw stop();
            assertGit(auth, value.git);
            let finished = launchElapsedMs;
            for (const [index, expected] of auth.checks.entries()) {
              const actual = value.results[index];
              if (!actual || actual.checkId !== expected.id || actual.candidateSha !== value.git.testHeadSha || actual.process.deploymentId !== author?.deploymentId || actual.startedElapsedMs < finished || actual.finishedElapsedMs > entry.elapsedMs || classifyTestResult(expected, actual) === "blocked") throw stop();
              finished = actual.finishedElapsedMs;
            }
            exactOracle = Object.freeze({ authorizationSha256, contract: auth.contract, assertions: auth.assertions, testHeadSha: value.git.testHeadSha, files: value.git.files, resultsSha256: workflowDigest(JSON.stringify(value.results)), gitSha256: workflowDigest(JSON.stringify(value.git)) }); break;
          }
          case "oracle-reviewed":
            if (!same(value.oracle, exactOracle) || value.reviewer === author?.deploymentId || value.reviewer === auth.parent.holder.deploymentId || (value.reviewer !== "sinh" && value.delegation === null)) throw stop();
            reviewSha = hash; break;
          case "final-approved":
            if (!same(value.oracle, exactOracle) || value.reviewSha256 !== reviewSha) throw stop();
            finalSha = hash; break;
          case "product-intent":
            if (!same(value.resource, retained) || value.initialHeadSha !== exactOracle?.testHeadSha || value.finalApprovalSha256 !== finalSha || value.intentId === intentId) throw stop();
            productIntent = value.intentId; break;
          case "product-consumed":
            if (!same(value.resource, retained) || value.initialHeadSha !== exactOracle?.testHeadSha || value.intentId !== productIntent || !same(value.previousHolder, author) || value.holder.deploymentId === author?.deploymentId || value.holder.deploymentId === auth.parent.holder.deploymentId) throw stop();
            capacity(auth, value.resource, value.holder, value.inventory, "orchestrator-direct"); break;
        }
        stage++;
      }
      previous = hash; hashes.push(hash); bounds = entry.bounds; retriesUsed = entry.retriesUsed; elapsedMs = entry.elapsedMs;
    }
    return Object.freeze({ evidenceClass: "source-model", runtimeAuthorized: false, productPass: false, state: interruption ? "blocked" : stage === 0 ? "unrequested" : stages[stage - 1]!, firstUnprovenAction: stages[stage] ?? "none", authorizationSha256, historySha256: Object.freeze(hashes), retriesUsed, elapsedMs, bounds, resource: retained, oracle: exactOracle });
  });
}
/** Conservative raw/source drift invalidation; never translates historical legacy tuples. */
export function testWorkflowInvalidation(previous: string | Uint8Array, next: string | Uint8Array, previousHistory: readonly (string | Uint8Array)[] = []): readonly string[] {
  return guarded(() => {
    const before = parseTestAuthorization(previous); const after = parseTestAuthorization(next); const digest = workflowDigest(bytes(previous));
    if (workflowDigest(bytes(next)) === digest) return Object.freeze([]);
    const retained = assessTestWorkflow(previous, previousHistory);
    if (!after.amendment || !retained.oracle || !["test-settled", "oracle-reviewed", "final-approved"].includes(retained.state) || after.amendment.previousAuthorizationSha256 !== digest || !same(after.amendment.contract, before.contract) || !same(after.amendment.assertions, before.assertions) || !same(after.amendment.repository, before.repository) || after.amendment.testHeadSha !== retained.oracle.testHeadSha || !same(after.amendment.tests, retained.oracle.files) || !same(after.bounds, retained.bounds) || after.retriesUsed !== retained.retriesUsed || after.elapsedMs !== retained.elapsedMs || after.retryLimit !== before.retryLimit || after.operationId === before.operationId) throw stop();
    return Object.freeze(["authorization", "results", "oracle-review", "final-approval", "continuation"]);
  });
}
