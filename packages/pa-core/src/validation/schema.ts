import { createHash } from "node:crypto";

export const VALIDATION_MANIFEST_SCHEMA_VERSION = "pa-validation-manifest/v1" as const;
export const VALIDATION_HANDOFF_SCHEMA_VERSION = "pa-validation-handoff/v1" as const;
export const VALIDATION_LEDGER_SCHEMA_VERSION = "pa-validation-ledger/v1" as const;

export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 1_800;
export const MIN_OUTPUT_BYTES = 1_048_576;
export const MAX_OUTPUT_BYTES = 1_073_741_824;
export const MAX_RETAINED_STREAM_BYTES = 65_536;
export const MAX_VALIDATION_EVENT_CHARACTERS = 2_000;

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ValidationRepositoryBinding {
  repoKey: string;
  canonicalRoot: string;
  worktreeRoot: string;
}

export interface ValidationMatrixBinding {
  source: string;
  authoritySha256: string;
  approvalEvidence: string;
}

export interface ValidationArtifactSpec {
  path: string;
  expectedSha256?: string;
}

export interface ValidationCommandSpec {
  id: string;
  command: string;
  cwd: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  artifacts: ValidationArtifactSpec[];
}

export interface ValidationManifest {
  schemaVersion: typeof VALIDATION_MANIFEST_SCHEMA_VERSION;
  ticketId: string;
  branch: string;
  featureSha: string;
  matrix: ValidationMatrixBinding;
  repository: ValidationRepositoryBinding;
  environment: Record<string, string>;
  commands: ValidationCommandSpec[];
}

export interface AuthenticatedRepositoryEvidence extends ValidationRepositoryBinding {
  ticketId: string;
  branch: string;
  featureSha: string;
  authenticated: true;
}

export interface ValidationHandoff {
  schemaVersion: typeof VALIDATION_HANDOFF_SCHEMA_VERSION;
  manifestSha256: string;
  manifest: ValidationManifest;
  repositoryEvidence: AuthenticatedRepositoryEvidence;
  protectedEnvironment: Record<string, string>;
}

/** Trusted values supplied out-of-band by the launcher, never by the manifest author. */
export interface ValidationAuthorityBinding {
  ticketId: string;
  branch: string;
  featureSha: string;
  matrixSource: string;
  matrixAuthoritySha256: string;
  matrixApprovalEvidence: string;
  repository: ValidationRepositoryBinding;
  protectedEnvironment: Record<string, string>;
}

export interface ValidationDiagnostic {
  condition: string;
  source: string;
  reason: string;
  correction: string;
  resumeAction: string;
}

export class ValidationPreflightError extends Error {
  readonly diagnostic: ValidationDiagnostic;

  constructor(diagnostic: ValidationDiagnostic) {
    super(diagnostic.reason);
    this.name = "ValidationPreflightError";
    this.diagnostic = diagnostic;
  }
}

export function validationDiagnostic(source: string, reason: string): ValidationDiagnostic {
  return {
    condition: "validation preflight rejected",
    source,
    reason,
    correction: "Provide a strict handoff whose complete bindings, paths, limits, environment, and safety decisions agree with trusted authority.",
    resumeAction: "Create a new authorized run; do not retry or resume this handoff.",
  };
}

export function parseValidationHandoff(input: unknown): ValidationHandoff {
  const handoff = objectAt(input, "handoff", [
    "schemaVersion", "manifestSha256", "manifest", "repositoryEvidence", "protectedEnvironment",
  ]);
  literalAt(handoff.schemaVersion, VALIDATION_HANDOFF_SCHEMA_VERSION, "handoff.schemaVersion");
  sha256At(handoff.manifestSha256, "handoff.manifestSha256");
  const manifest = parseManifest(handoff.manifest);
  const repositoryEvidence = parseRepositoryEvidence(handoff.repositoryEvidence);
  const protectedEnvironment = stringMapAt(handoff.protectedEnvironment, "handoff.protectedEnvironment");
  if (Object.keys(protectedEnvironment).length === 0) fail("handoff.protectedEnvironment", "must not be empty");

  return {
    schemaVersion: VALIDATION_HANDOFF_SCHEMA_VERSION,
    manifestSha256: handoff.manifestSha256 as string,
    manifest,
    repositoryEvidence,
    protectedEnvironment,
  };
}

export function digestValidationManifest(manifest: ValidationManifest): string {
  return createHash("sha256").update(Buffer.from(canonicalJson(manifest), "utf8")).digest("hex");
}

export function assertValidationAuthority(handoff: ValidationHandoff, expected: ValidationAuthorityBinding): void {
  const manifest = handoff.manifest;
  equal(manifest.ticketId, expected.ticketId, "authority.ticketId");
  equal(manifest.branch, expected.branch, "authority.branch");
  equal(manifest.featureSha, expected.featureSha, "authority.featureSha");
  equal(manifest.matrix.source, expected.matrixSource, "authority.matrixSource");
  equal(manifest.matrix.authoritySha256, expected.matrixAuthoritySha256, "authority.matrixAuthoritySha256");
  equal(manifest.matrix.approvalEvidence, expected.matrixApprovalEvidence, "authority.matrixApprovalEvidence");
  equalRepository(manifest.repository, expected.repository, "authority.repository");

  const evidence = handoff.repositoryEvidence;
  equalRepository(evidence, expected.repository, "repositoryEvidence");
  equal(evidence.ticketId, expected.ticketId, "repositoryEvidence.ticketId");
  equal(evidence.branch, expected.branch, "repositoryEvidence.branch");
  equal(evidence.featureSha, expected.featureSha, "repositoryEvidence.featureSha");

  if (digestValidationManifest(manifest) !== handoff.manifestSha256) {
    fail("handoff.manifestSha256", "does not bind the complete canonical manifest");
  }
  if (!mapsEqual(handoff.protectedEnvironment, expected.protectedEnvironment)) {
    fail("handoff.protectedEnvironment", "does not exactly match trusted protected identity");
  }
  for (const [name, value] of Object.entries(expected.protectedEnvironment)) {
    if (manifest.environment[name] !== value) {
      fail(`manifest.environment.${name}`, "cannot omit or override protected identity");
    }
  }
}

function parseManifest(input: unknown): ValidationManifest {
  const manifest = objectAt(input, "manifest", [
    "schemaVersion", "ticketId", "branch", "featureSha", "matrix", "repository", "environment", "commands",
  ]);
  literalAt(manifest.schemaVersion, VALIDATION_MANIFEST_SCHEMA_VERSION, "manifest.schemaVersion");
  const ticketId = boundedStringAt(manifest.ticketId, "manifest.ticketId", 1, 128);
  const branch = boundedStringAt(manifest.branch, "manifest.branch", 1, 512);
  const featureSha = stringAt(manifest.featureSha, "manifest.featureSha");
  if (!GIT_SHA.test(featureSha)) fail("manifest.featureSha", "must be 40 lowercase hexadecimal characters");
  const matrix = parseMatrix(manifest.matrix);
  const repository = parseRepository(manifest.repository, "manifest.repository");
  const environment = stringMapAt(manifest.environment, "manifest.environment");
  if (Object.keys(environment).length === 0) fail("manifest.environment", "must be a complete non-empty environment map");
  const rawCommands = arrayAt(manifest.commands, "manifest.commands");
  if (rawCommands.length === 0) fail("manifest.commands", "must contain at least one command");
  if (rawCommands.length > 1_000) fail("manifest.commands", "must contain at most 1000 commands");
  const commands = rawCommands.map((command, index) => parseCommand(command, index));
  if (new Set(commands.map((command) => command.id)).size !== commands.length) {
    fail("manifest.commands", "command ids must be unique");
  }
  return {
    schemaVersion: VALIDATION_MANIFEST_SCHEMA_VERSION,
    ticketId,
    branch,
    featureSha,
    matrix,
    repository,
    environment,
    commands,
  };
}

function parseMatrix(input: unknown): ValidationMatrixBinding {
  const matrix = objectAt(input, "manifest.matrix", ["source", "authoritySha256", "approvalEvidence"]);
  const source = boundedStringAt(matrix.source, "manifest.matrix.source", 1, 2_048);
  const authoritySha256 = sha256At(matrix.authoritySha256, "manifest.matrix.authoritySha256");
  const approvalEvidence = boundedStringAt(matrix.approvalEvidence, "manifest.matrix.approvalEvidence", 1, 2_048);
  return { source, authoritySha256, approvalEvidence };
}

function parseRepository(input: unknown, path: string): ValidationRepositoryBinding {
  const repository = objectAt(input, path, ["repoKey", "canonicalRoot", "worktreeRoot"]);
  return {
    repoKey: boundedStringAt(repository.repoKey, `${path}.repoKey`, 1, 256),
    canonicalRoot: absolutePathAt(repository.canonicalRoot, `${path}.canonicalRoot`),
    worktreeRoot: absolutePathAt(repository.worktreeRoot, `${path}.worktreeRoot`),
  };
}

function parseRepositoryEvidence(input: unknown): AuthenticatedRepositoryEvidence {
  const path = "handoff.repositoryEvidence";
  const evidence = objectAt(input, path, [
    "repoKey", "canonicalRoot", "worktreeRoot", "ticketId", "branch", "featureSha", "authenticated",
  ]);
  if (evidence.authenticated !== true) fail(`${path}.authenticated`, "must be true");
  const featureSha = stringAt(evidence.featureSha, `${path}.featureSha`);
  if (!GIT_SHA.test(featureSha)) fail(`${path}.featureSha`, "must be 40 lowercase hexadecimal characters");
  return {
    ...parseRepository({
      repoKey: evidence.repoKey,
      canonicalRoot: evidence.canonicalRoot,
      worktreeRoot: evidence.worktreeRoot,
    }, path),
    ticketId: boundedStringAt(evidence.ticketId, `${path}.ticketId`, 1, 128),
    branch: boundedStringAt(evidence.branch, `${path}.branch`, 1, 512),
    featureSha,
    authenticated: true,
  };
}

function parseCommand(input: unknown, index: number): ValidationCommandSpec {
  const path = `manifest.commands[${index}]`;
  const command = objectAt(input, path, ["id", "command", "cwd", "timeoutSeconds", "maxOutputBytes", "artifacts"]);
  const id = stringAt(command.id, `${path}.id`);
  if (!COMMAND_ID.test(id)) fail(`${path}.id`, "has invalid characters or length");
  const commandText = boundedStringAt(command.command, `${path}.command`, 1, 1_000_000);
  if (commandText.includes("\0")) fail(`${path}.command`, "must not contain NUL");
  const timeoutSeconds = integerAt(command.timeoutSeconds, `${path}.timeoutSeconds`, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  const maxOutputBytes = integerAt(command.maxOutputBytes, `${path}.maxOutputBytes`, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  const artifacts = arrayAt(command.artifacts, `${path}.artifacts`).map((artifact, artifactIndex) => {
    const artifactPath = `${path}.artifacts[${artifactIndex}]`;
    const value = objectAt(artifact, artifactPath, ["path", "expectedSha256"], ["expectedSha256"]);
    const expectedSha256 = value.expectedSha256 === undefined
      ? undefined
      : sha256At(value.expectedSha256, `${artifactPath}.expectedSha256`);
    return {
      path: absolutePathAt(value.path, `${artifactPath}.path`),
      ...(expectedSha256 ? { expectedSha256 } : {}),
    };
  });
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    fail(`${path}.artifacts`, "artifact paths must be unique");
  }
  return { id, command: commandText, cwd: absolutePathAt(command.cwd, `${path}.cwd`), timeoutSeconds, maxOutputBytes, artifacts };
}

function objectAt(input: unknown, path: string, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(path, "must be an object");
  const value = input as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(path, `contains unknown field ${unknown[0]}`);
  const optionalSet = new Set(optional);
  const missing = keys.filter((key) => !optionalSet.has(key) && !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) fail(path, `is missing field ${missing[0]}`);
  return value;
}

function arrayAt(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) fail(path, "must be an array");
  return input;
}

function stringAt(input: unknown, path: string): string {
  if (typeof input !== "string") fail(path, "must be a string");
  return input;
}

function boundedStringAt(input: unknown, path: string, minimum: number, maximum: number): string {
  const value = stringAt(input, path);
  if (value.length < minimum || value.length > maximum) fail(path, `length must be in [${minimum},${maximum}]`);
  if (value.includes("\0")) fail(path, "must not contain NUL");
  return value;
}

function absolutePathAt(input: unknown, path: string): string {
  const value = boundedStringAt(input, path, 1, 4_096);
  if (!value.startsWith("/")) fail(path, "must be an absolute path");
  if (value.includes("\0")) fail(path, "must not contain NUL");
  return value;
}

function sha256At(input: unknown, path: string): string {
  const value = stringAt(input, path);
  if (!SHA256.test(value)) fail(path, "must be 64 lowercase hexadecimal characters");
  return value;
}

function integerAt(input: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(input) || (input as number) < minimum || (input as number) > maximum) {
    fail(path, `must be an integer in [${minimum},${maximum}]`);
  }
  return input as number;
}

function stringMapAt(input: unknown, path: string): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(path, "must be an object");
  const result: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (!ENVIRONMENT_NAME.test(name)) fail(`${path}.${name}`, "has an invalid environment variable name");
    const value = stringAt(rawValue, `${path}.${name}`);
    if (value.includes("\0")) fail(`${path}.${name}`, "must not contain NUL");
    result[name] = value;
  }
  return result;
}

function literalAt(input: unknown, expected: string, path: string): void {
  if (input !== expected) fail(path, `must equal ${expected}`);
}

function equal(actual: string, expected: string, path: string): void {
  if (actual !== expected) fail(path, "does not match trusted authority");
}

function equalRepository(actual: ValidationRepositoryBinding, expected: ValidationRepositoryBinding, path: string): void {
  equal(actual.repoKey, expected.repoKey, `${path}.repoKey`);
  equal(actual.canonicalRoot, expected.canonicalRoot, `${path}.canonicalRoot`);
  equal(actual.worktreeRoot, expected.worktreeRoot, `${path}.worktreeRoot`);
}

function mapsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(",")}}`;
}

function fail(source: string, reason: string): never {
  throw new ValidationPreflightError(validationDiagnostic(source, reason));
}
