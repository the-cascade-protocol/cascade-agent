/**
 * Shared key-validation logic used by both onboarding and the login command.
 */
import type { ProviderName } from "./providers/index.js";
export interface ValidationResult {
    ok: boolean;
    error?: string;
}
export declare function validateKey(provider: ProviderName, key: string): Promise<boolean>;
export declare function validateKeyDetailed(provider: ProviderName, key: string): Promise<ValidationResult>;
