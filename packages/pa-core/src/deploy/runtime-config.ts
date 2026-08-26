import type { DeployRequest } from "./control.js";
import type { DeployMode, ModelName, ProviderName, RuntimeName, RuntimeOverrides, TeamConfig } from "../types.js";

export type RuntimeConfigSource = "cli" | "mode" | "default";

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
}

export function resolveRuntimeConfig(input: RuntimeConfigResolutionInput): EffectiveRuntimeConfig {
  const modeProvider = input.mode?.provider;
  const modeModel = input.mode?.model;
  if ((modeProvider === undefined) !== (modeModel === undefined)) {
    throw new Error("Selected deploy mode provider/model must both be present or both be absent; configure deploy_modes[].provider and deploy_modes[].model together.");
  }

  const cliProvider = input.request.provider;
  const cliModel = input.request.model ?? input.request.teamModel;
  const hasCliOverride = cliProvider !== undefined || cliModel !== undefined;
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
