import type { Provider, ProviderName } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { Config } from "../config.js";

/** Default models per provider. */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-4.1",           // latest as of Aug 2025 — check platform.openai.com/docs/models
  google: "gemini-flash-latest",  // free tier available via AI Studio — tracks latest flash automatically
  ollama: "llama3.2",
};

/** Base URLs for OpenAI-compatible backends that aren't api.openai.com. */
const BASE_URLS: Partial<Record<ProviderName, string>> = {
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
  ollama: "http://localhost:11434/v1",
};

/** Build a Provider from the persisted config. */
export function createProvider(
  config: Config,
  overrideProvider?: ProviderName,
  overrideModel?: string
): Provider {
  const providerName = overrideProvider ?? config.activeProvider ?? "anthropic";
  const pc = config.providers?.[providerName] ?? {};

  const model =
    overrideModel ??
    pc.model ??
    DEFAULT_MODELS[providerName];

  switch (providerName) {
    case "anthropic": {
      const apiKey =
        process.env.ANTHROPIC_API_KEY ?? pc.apiKey ?? config.apiKey ?? "";
      return new AnthropicProvider(apiKey, model);
    }

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY ?? pc.apiKey ?? "";
      return new OpenAICompatProvider("openai", apiKey, model);
    }

    case "google": {
      const apiKey = process.env.GOOGLE_AI_API_KEY ?? pc.apiKey ?? "";
      return new OpenAICompatProvider(
        "google",
        apiKey,
        model,
        BASE_URLS.google
      );
    }

    case "ollama": {
      const baseURL = pc.baseUrl ?? BASE_URLS.ollama!;
      return new OpenAICompatProvider("ollama", "ollama", model, baseURL);
    }
  }
}

export type { Provider, ProviderName };
