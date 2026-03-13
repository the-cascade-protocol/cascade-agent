import { type Provider } from "./providers/index.js";
/** True when no provider has been configured and no env var is set. */
export declare function needsOnboarding(): boolean;
export declare function runOnboarding(): Promise<Provider>;
