import type { ProviderName } from "./providers/index.js";
export interface ProviderConfig {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
}
export interface Config {
    apiKey?: string;
    model?: string;
    activeProvider?: ProviderName;
    providers?: Partial<Record<ProviderName, ProviderConfig>>;
}
export declare function loadConfig(): Config;
export declare function saveConfig(config: Config): void;
/** Returns the API key for the given provider, checking env vars first.
 *  Google: accepts GEMINI_API_KEY (AI Studio default) or GOOGLE_AI_API_KEY. */
export declare function getApiKey(provider?: ProviderName): string | undefined;
export declare function getActiveProvider(): ProviderName;
export declare function getModel(provider?: ProviderName): string | undefined;
/** Shortcuts like "opus" → "claude-opus-4-6", "flash" → "gemini-2.5-flash" */
export declare const MODEL_ALIASES: Record<string, string>;
export declare function resolveModel(name: string): string;
/** Human-readable labels for provider names. */
export declare const PROVIDER_LABELS: Record<ProviderName, string>;
