import type { DeployRequest } from "./control.js";
import { formatBoundedFiveFieldDiagnostic } from "../repos.js";
import type { DeployMode, ModelName, ProviderName, RuntimeName, RuntimeOverrides, TeamConfig } from "../types.js";

/** Validate untyped internal callers as well as public request parsers. Never infer a runtime. */
export function assertSupportedRuntime(runtime: unknown): asserts runtime is RuntimeName {
  if (runtime !== "pi" && runtime !== "opencode") throw new Error(formatBoundedFiveFieldDiagnostic({
    condition: "unsupported runtime selection",
    source: "active runtime admission",
    reason: "runtime must be opencode or pi; historical runtime metadata is read-only",
    correction: "select a supported runtime explicitly; do not convert or rewrite historical sessions",
    resumeAction: "start a new supported deployment, or resume only its matching retained-runtime session",
  }));
}

/** An explicit selection or historical session must never fall back to another adapter. */
export function assertMatchingRuntime(runtime: unknown, expected: RuntimeName): void {
  assertSupportedRuntime(runtime);
  if (runtime !== expected) throw new Error(formatBoundedFiveFieldDiagnostic({
    condition: "runtime mismatch", source: "selected adapter and session admission",
    reason: "the explicit runtime or historical session does not match the selected adapter",
    correction: "use the matching retained runtime; preserve the historical record unchanged",
    resumeAction: "resume through the matching retained adapter or start a new deployment explicitly",
  }));
}

export type RuntimeConfigSource = "cli" | "mode" | "default" | "fallback";

/**
 * The single provider/model result consumed by runtime adapters.
 *
 * `default` means that neither the selected mode nor the CLI supplied a pair;
 * the adapter may fill its documented default at that boundary. The object is
 * frozen so later consumers cannot accidentally drift from the resolved pair.
 */
export interface EffectiveRuntimeConfig extends Readonly<RuntimeOverrides> {
  readonly provider?: ProviderName;
  readonly model?: ModelName;
  readonly source: RuntimeConfigSource;
  /** Redacted diagnostic explaining why the adapter selected its default. */
  readonly warning?: string;
}

/** Alias emphasizing that this is the shared resolution contract. */
export type EffectiveRuntimeResolution = EffectiveRuntimeConfig;

export interface RuntimeConfigResolutionInput {
  runtime: RuntimeName;
  request: Pick<DeployRequest, "provider" | "model" | "teamModel">;
  team: TeamConfig;
  mode?: DeployMode;
  /** Adapter-owned defaults and non-pair runtime settings. */
  local?: RuntimeOverrides;
  /** Reject CLI overrides unless provider and model are both explicit. */
  requireCompleteCliPair?: boolean;
}

export function resolveRuntimeConfig(input: RuntimeConfigResolutionInput): EffectiveRuntimeConfig {
  assertSupportedRuntime(input.runtime);
  const modeProvider = input.mode?.provider;
  const modeModel = input.mode?.model;
  if ((modeProvider === undefined) !== (modeModel === undefined)) {
    throw new Error("Selected deploy mode provider/model must both be present or both be absent; configure deploy_modes[].provider and deploy_modes[].model together.");
  }

  const cliProvider = input.request.provider;
  const cliModel = input.request.model ?? input.request.teamModel;
  const hasCliOverride = cliProvider !== undefined || cliModel !== undefined;
  if (input.requireCompleteCliPair && hasCliOverride && (cliProvider === undefined || cliModel === undefined)) {
    const missing = cliProvider === undefined ? "provider" : "model";
    const supplied = cliProvider === undefined ? "model" : "provider";
    throw new Error(`CLI provider/model override is incomplete: --${missing} is required when --${supplied} is supplied.`);
  }
  const provider = cliProvider ?? modeProvider ?? input.local?.provider;
  const model = cliModel ?? modeModel ?? input.local?.model;
  const source: RuntimeConfigSource = hasCliOverride ? "cli" : modeProvider !== undefined ? "mode" : "default";

  return Object.freeze({
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(input.local?.autonomy !== undefined ? { autonomy: input.local.autonomy } : {}),
    ...(input.local?.timeout !== undefined ? { timeout: input.local.timeout } : {}),
    source,
  });
}

/**
 * Keep adapter fallback diagnostics safe even when a caller bypasses the CLI's
 * identifier validation (for example, an Agent API or direct hook caller).
 */
export function redactDiagnostic(value: string, secrets: string[] = []): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/bearer\s+\S+/gi, "[REDACTED]")
    .replace(/\b(?:sk|fk)-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/gi, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*[^\s]+/gi, "[REDACTED]");
}

export function formatRuntimePair(provider?: string, model?: string): string {
  return `${provider ?? "(unset)"}/${model ?? "(unset)"}`;
}

/** Bare model ids are adapter-local; qualified ids must name an accepted provider namespace. */
export function modelMatchesProvider(model: string | undefined, namespaces: readonly string[]): boolean {
  if (!model?.includes("/")) return true;
  return namespaces.includes(model.slice(0, model.indexOf("/")));
}
