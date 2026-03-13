import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import type { ProviderName } from "./providers/index.js";

export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string; // ollama only
}

export interface Config {
  // Legacy fields (kept for backwards compat — treated as anthropic)
  apiKey?: string;
  model?: string;
  // Multi-provider fields
  activeProvider?: ProviderName;
  providers?: Partial<Record<ProviderName, ProviderConfig>>;
}

const CONFIG_DIR = join(homedir(), ".config", "cascade-agent");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Config;
  } catch {
    process.stderr.write(`Warning: config file at ${CONFIG_FILE} is malformed and will be ignored. Delete it to reset.\n`);
    return {};
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/** Returns the API key for the given provider, checking env vars first.
 *  Google: accepts GEMINI_API_KEY (AI Studio default) or GOOGLE_AI_API_KEY. */
export function getApiKey(provider: ProviderName = "anthropic"): string | undefined {
  if (provider === "google") {
    const envKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
    if (envKey) return envKey;
  } else {
    const envMap: Record<ProviderName, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "", // handled above
      ollama: "",
    };
    const envKey = process.env[envMap[provider]];
    if (envKey) return envKey;
  }

  const config = loadConfig();
  if (provider === "anthropic") return config.providers?.anthropic?.apiKey ?? config.apiKey;
  return config.providers?.[provider]?.apiKey;
}

export function getActiveProvider(): ProviderName {
  return loadConfig().activeProvider ?? "anthropic";
}

export function getModel(provider?: ProviderName): string | undefined {
  const config = loadConfig();
  const p = provider ?? config.activeProvider ?? "anthropic";
  return config.providers?.[p]?.model ?? (p === "anthropic" ? config.model : undefined);
}

/** Shortcuts like "opus" → "claude-opus-4-6", "flash" → "gemini-2.5-flash" */
export const MODEL_ALIASES: Record<string, string> = {
  // Anthropic
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  // OpenAI (as of Aug 2025 — check platform.openai.com/docs/models for latest)
  "gpt41": "gpt-4.1",
  "gpt4o": "gpt-4o",
  "o3": "o3",
  "o4mini": "o4-mini",
  // Google — use *-latest aliases where possible so they track new versions automatically
  "flash": "gemini-flash-latest",
  "pro": "gemini-pro-latest",
  "flash25": "gemini-2.5-flash",
  "flash20": "gemini-2.0-flash",
  "pro25": "gemini-2.5-pro",
  // Ollama shortcuts are just model names — pass through as-is
};

export function resolveModel(name: string): string {
  return MODEL_ALIASES[name.toLowerCase()] ?? name;
}

/** Human-readable labels for provider names. */
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  google: "Google (Gemini) — free tier available",
  ollama: "Ollama (local, no API key needed)",
};
