import { formatRuntimePair, modelMatchesProvider, type EffectiveRuntimeConfig } from "@pa-platform/pa-core";

export const PI_DEFAULT_PROVIDER = "openai";
export const PI_DEFAULT_MODEL = "openai/gpt-5.6-sol";

export interface PiRuntimeConfig {
  provider?: string;
  model?: string;
}

export function normalizePiRuntimeConfig(provider?: string, model?: string): PiRuntimeConfig {
  const isOpenAiProvider = provider === "openai" || provider === "openai-codex";
  return {
    provider: provider === "openai" ? "openai-codex" : provider,
    model: isOpenAiProvider && modelMatchesProvider(model, ["openai", "openai-codex"]) && model?.includes("/") ? model.slice(model.indexOf("/") + 1) : model,
  };
}

/** Map the shared config result to the provider/model identifiers Pi accepts. */
export function resolvePiRuntimeConfig(config: EffectiveRuntimeConfig): EffectiveRuntimeConfig {
  const provider = config.provider ?? PI_DEFAULT_PROVIDER;
  const model = config.model ?? PI_DEFAULT_MODEL;
  if (provider !== "openai" && provider !== "openai-codex") throw new Error(`PPA provider field is unsupported in provider/model pair ${formatRuntimePair(provider, model)}.`);
  if (!modelMatchesProvider(model, ["openai", "openai-codex"])) throw new Error(`PPA provider and model fields do not match in provider/model pair ${formatRuntimePair(provider, model)}.`);
  return Object.freeze({ ...normalizePiRuntimeConfig(provider, model), source: config.source });
}
