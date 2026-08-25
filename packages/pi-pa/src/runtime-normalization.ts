export interface PiRuntimeConfig {
  provider?: string;
  model?: string;
}

export function normalizePiRuntimeConfig(provider?: string, model?: string): PiRuntimeConfig {
  const isOpenAiProvider = provider === "openai" || provider === "openai-codex";
  return {
    provider: provider === "openai" ? "openai-codex" : provider,
    model: isOpenAiProvider && model?.startsWith("openai/") ? model.slice("openai/".length) : model,
  };
}
