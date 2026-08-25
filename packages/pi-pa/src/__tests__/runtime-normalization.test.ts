import assert from "node:assert/strict";
import test from "node:test";
import { normalizePiRuntimeConfig } from "../runtime-normalization.js";

test("normalizes only the approved Pi provider/model pairs", () => {
  const cases: Array<[string | undefined, string | undefined, string | undefined, string | undefined]> = [
    ["openai", "openai/gpt-5.6-luna", "openai-codex", "gpt-5.6-luna"],
    ["openai", "openai/openai/gpt-5.6-luna", "openai-codex", "openai/gpt-5.6-luna"],
    ["openai-codex", "openai/gpt-5.6-luna", "openai-codex", "gpt-5.6-luna"],
    ["openai-codex", "gpt-5.6-luna", "openai-codex", "gpt-5.6-luna"],
    ["anthropic", "openai/claude", "anthropic", "openai/claude"],
    ["ollama", "llama3", "ollama", "llama3"],
    ["openai-codex", undefined, "openai-codex", undefined],
    [undefined, "openai/gpt-5.6-luna", undefined, "openai/gpt-5.6-luna"],
    [undefined, undefined, undefined, undefined],
  ];
  for (const [provider, model, expectedProvider, expectedModel] of cases) {
    assert.deepEqual(normalizePiRuntimeConfig(provider, model), { provider: expectedProvider, model: expectedModel });
  }
});
