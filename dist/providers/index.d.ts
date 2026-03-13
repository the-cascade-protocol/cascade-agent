import type { Provider, ProviderName } from "./types.js";
import type { Config } from "../config.js";
/** Default models per provider. */
export declare const DEFAULT_MODELS: Record<ProviderName, string>;
/** Build a Provider from the persisted config. */
export declare function createProvider(config: Config, overrideProvider?: ProviderName, overrideModel?: string): Provider;
export type { Provider, ProviderName };
