/** Artifact interface v1 policy seam. Pure admission only: no I/O or upstream import.
 * Phase 1 admits no runtime capability, even when Lavish is selected. Selection
 * is availability, not confinement or authority. Later lifecycle code must keep
 * the default deny across CLI, HTTP, WebSocket and UI, not just hide controls.
 */
export const ARTIFACT_POLICY_VERSION = "pa-artifact-policy/v1";
export const ARTIFACT_SOURCE_MAX_BYTES = 2_097_152;

export const ARTIFACT_DIAGNOSTICS = {
  ARTIFACT_USAGE_INVALID: { exitCode: 2, message: "Invalid artifact arguments." },
  ARTIFACT_SOURCE_INVALID: { exitCode: 2, message: "Invalid artifact source." },
  ARTIFACT_RUNTIME_REQUIRED: { exitCode: 3, message: "Selected managed review runtime required." },
  ARTIFACT_BROWSER_REQUIRED: { exitCode: 3, message: "Operator-owned test browser required." },
  ARTIFACT_STALE: { exitCode: 4, message: "Artifact identity is stale or tampered." },
  ARTIFACT_POLICY_REJECTED: { exitCode: 5, message: "Artifact policy rejected the operation." },
  ARTIFACT_OWNER_CONFLICT: { exitCode: 6, message: "Artifact ownership conflict." },
  ARTIFACT_RUNTIME_FAILED: { exitCode: 7, message: "Artifact runtime failed." },
  ARTIFACT_OUTPUT_CONFLICT: { exitCode: 8, message: "Artifact output conflict." },
} as const;

export type ArtifactDiagnostic = keyof typeof ARTIFACT_DIAGNOSTICS;
export class ArtifactPolicyError extends Error {
  readonly exitCode: number;
  readonly diagnostic: ArtifactDiagnostic;
  constructor(diagnostic: ArtifactDiagnostic) {
    const record = ARTIFACT_DIAGNOSTICS[diagnostic];
    super(`${diagnostic}: ${record.message}`);
    this.name = "ArtifactPolicyError";
    this.diagnostic = diagnostic;
    this.exitCode = record.exitCode;
  }
}

/** Never echo argv, paths, inherited values or underlying exception messages. */
export function artifactDiagnostic(diagnostic: ArtifactDiagnostic): ArtifactPolicyError {
  return new ArtifactPolicyError(diagnostic);
}

export function assertArtifactEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  const unsafe = new Set(["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "LD_LIBRARY_PATH"]);
  for (const key of Object.keys(env)) {
    if (env[key] !== undefined && (unsafe.has(key) || key.startsWith("LAVISH_AXI_"))) {
      throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
    }
  }
}

/** Lexical rejection only, never a filesystem/ownership authorization. Later
 * source/session modules must also use race-safe non-symlink and owner checks. */
export function assertArtifactAbsolutePath(value: string): void {
  if (!value.startsWith("/") || value === "/" || value.includes("\0") || value.includes("\\")
      || value.split("/").slice(1).some((part) => part === "" || part === "." || part === "..")) {
    throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
  }
}

export function assertArtifactSourceSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > ARTIFACT_SOURCE_MAX_BYTES) {
    throw artifactDiagnostic("ARTIFACT_SOURCE_INVALID");
  }
}

export function parseArtifactFeedbackTimeout(value: string | undefined): number {
  if (value === undefined) return 1000;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout > 30_000) throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
  return timeout;
}

/** Unknown capabilities and transports are also denied. No URL/path allowlist
 * exists until actual lifecycle confinement is implemented and measured. */
export function assertArtifactCapability(_transport: string, _capability: string): never {
  throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
}

export function assertManagedReviewAvailable(selected: boolean, env: Readonly<Record<string, string | undefined>>): never {
  assertArtifactEnvironment(env);
  if (selected !== true) throw artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED");
  return assertArtifactCapability("cli", "review-start");
}
