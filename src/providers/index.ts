import type { Provider, ProviderName } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { LocalProvider, MODELS_DIR, DEFAULT_LOCAL_MODEL_FILENAME, LOCAL_MODELS } from "./local.js";
import { VertexProvider, DEFAULT_VERTEX_MODEL } from "./vertex.js";
import { join } from "path";
import type { Config } from "../config.js";

/** All supported provider names, in display order. */
export const ALL_PROVIDERS: ProviderName[] = ["anthropic", "openai", "google", "vertex", "ollama", "local"];

/** Default models per provider. */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-4.1",           // latest as of Aug 2025 — check platform.openai.com/docs/models
  google: "gemini-flash-latest",  // free tier available via AI Studio — tracks latest flash automatically
  vertex: DEFAULT_VERTEX_MODEL,   // BAA-covered Vertex AI; cost-efficient Gemini Flash, current gen
  ollama: "llama3.2",
  local: DEFAULT_LOCAL_MODEL_FILENAME,
};

/** Cheapest/most-stable models used only for API key validation. */
export const VALIDATION_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-flash-latest",
  vertex: DEFAULT_VERTEX_MODEL,   // validated via ADC pre-flight, not an API key (see VertexProvider.validate)
  ollama: "",
  local: "",
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

    case "vertex": {
      // BAA-covered Vertex AI. Auth is via GCP ADC, NOT an API key, so there is
      // deliberately no apiKey here. The project comes from GOOGLE_CLOUD_PROJECT
      // (resolved inside VertexProvider); `baseUrl` is repurposed — as it is for
      // ollama/local — to carry an explicit region override when set. The
      // constructor does no network I/O; validate()/runTurn() guard on config.
      return new VertexProvider(model, {
        location: pc.baseUrl ?? undefined,
      });
    }

    case "ollama": {
      const baseURL = pc.baseUrl ?? BASE_URLS.ollama!;
      return new OpenAICompatProvider("ollama", "ollama", model, baseURL);
    }

    case "local": {
      // modelPath: stored in config as baseUrl field (repurposed for local),
      // or constructed from MODELS_DIR + model filename.
      const modelPath = pc.baseUrl ?? join(MODELS_DIR, model);
      return new LocalProvider(modelPath, model);
    }
  }
}

export { downloadDefaultModel, downloadLocalModel, LOCAL_MODELS } from "./local.js";
export type { LocalModelVariant } from "./local.js";

// Vertex AI (BAA-covered cloud) provider.
export {
  VertexProvider,
  DEFAULT_VERTEX_MODEL,
  DEFAULT_VERTEX_LOCATION,
  vertexHost,
  qualifyVertexModel,
} from "./vertex.js";
export type { VertexProviderOptions, VertexValidation } from "./vertex.js";

// Trusted-endpoint wrapper + cloud-egress log (plan §4.4).
export {
  TrustedEndpointProvider,
  designateTrustedEndpoint,
  isLocalProvider,
  writeEgressLog,
  writeEgressLogStrict,
  readEgressLog,
  summarizeEgress,
  DEFAULT_EGRESS_LOG_PATH,
} from "./trusted-endpoint.js";
export type {
  EgressLogEntry,
  EgressSummary,
  TrustedEndpointOptions,
  DescribesEndpoint,
} from "./trusted-endpoint.js";

export type { Provider, ProviderName };
