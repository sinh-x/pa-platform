import { formatRuntimePair, modelMatchesProvider, redactDiagnostic, type EffectiveRuntimeConfig } from "@pa-platform/pa-core";

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
  if ((provider !== "openai" && provider !== "openai-codex") || !modelMatchesProvider(model, ["openai", "openai-codex"])) {
    const fallback = normalizePiRuntimeConfig(PI_DEFAULT_PROVIDER, PI_DEFAULT_MODEL);
    const warning = redactDiagnostic(
      `ppa: incompatible provider/model ${formatRuntimePair(config.provider, config.model)}; falling back to ${formatRuntimePair(fallback.provider, fallback.model)}.`,
    );
    return Object.freeze({ ...fallback, source: "fallback", warning });
  }
  return Object.freeze({ ...normalizePiRuntimeConfig(provider, model), source: config.source });
}
