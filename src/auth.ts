/**
 * Shared key-validation logic used by both onboarding and the login command.
 */
import type { ProviderName } from "./providers/index.js";

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export async function validateKey(
  provider: ProviderName,
  key: string
): Promise<boolean> {
  const result = await validateKeyDetailed(provider, key);
  return result.ok;
}

export async function validateKeyDetailed(
  provider: ProviderName,
  key: string
): Promise<ValidationResult> {
  try {
    if (provider === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: key });
      await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      });
      return { ok: true };
    }

    if (provider === "openai" || provider === "google") {
      const { default: OpenAI } = await import("openai");
      const baseURL =
        provider === "google"
          ? "https://generativelanguage.googleapis.com/v1beta/openai/"
          : undefined;
      // Use stable latest aliases so validation doesn't break when specific versions deprecate
      const model = provider === "google" ? "gemini-flash-latest" : "gpt-4o-mini";
      const client = new OpenAI({ apiKey: key, ...(baseURL ? { baseURL } : {}) });
      await client.chat.completions.create({
        model,
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      });
      return { ok: true };
    }

    return { ok: true }; // ollama — no key to validate
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
