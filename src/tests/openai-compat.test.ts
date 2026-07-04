/**
 * Unit tests for the OpenAI-compatible provider's empty-response detection.
 *
 * ZERO network, ZERO credentials, ZERO model launches. The provider's private
 * `client` is swapped for a fake whose `chat.completions.create` returns a
 * canned OpenAI-shaped response, so we exercise exactly the branch in
 * `complete()` that decides between "usable text" and "the model said nothing."
 *
 * Regression target: a reasoning tier (gemini-3-flash-preview; Qwen thinking)
 * can spend its whole `max_tokens` budget on hidden reasoning and return
 * `message.content === ""` with `finish_reason === "length"`. That empty string
 * used to flow back to a parser as a valid empty result (three separate silent
 * Workbench failures). `complete()` must now throw EmptyCompletionError.
 *
 * Run with: npx tsx src/tests/openai-compat.test.ts
 */
import assert from "assert";
import {
  OpenAICompatProvider,
  EmptyCompletionError,
} from "../providers/openai-compat.js";

// ── Test harness (mirrors gateway.test.ts) ────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

// ── Fake OpenAI client ────────────────────────────────────────────────────────

interface FakeChoice {
  message: { content: string | null };
  finish_reason: string | null;
}

/** Build a provider whose HTTP layer returns a fixed OpenAI-shaped response. */
function providerReturning(choice: FakeChoice | undefined): {
  provider: OpenAICompatProvider;
  lastArgs: () => Record<string, unknown> | undefined;
} {
  const provider = new OpenAICompatProvider("openai", "test-key", "reasoning-tier-model");
  let captured: Record<string, unknown> | undefined;
  // Overwrite the private OpenAI client with a fake — no network is dialed.
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (args: Record<string, unknown>) => {
          captured = args;
          return { choices: choice ? [choice] : [] };
        },
      },
    },
  };
  return { provider, lastArgs: () => captured };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nopenai-compat.test.ts — empty-response detection (no network, no model)\n");

  await test("empty content + finish_reason 'length' throws EmptyCompletionError with a budget hint", async () => {
    const { provider } = providerReturning({ message: { content: "" }, finish_reason: "length" });
    await assert.rejects(
      provider.complete("grade this claim", { maxTokens: 200 }),
      (err: unknown) => {
        assert.ok(err instanceof EmptyCompletionError, "expected EmptyCompletionError");
        assert.strictEqual(err.finishReason, "length");
        assert.strictEqual(err.maxTokens, 200);
        assert.strictEqual(err.truncated, true);
        // Message must be legible enough to diagnose reasoning-budget starvation.
        assert.match(err.message, /max_tokens=200/);
        assert.match(err.message, /reasoning/i);
        assert.match(err.message, /empty completion/i);
        return true;
      }
    );
  });

  await test("empty content + normal 'stop' still throws (model produced no answer)", async () => {
    const { provider } = providerReturning({ message: { content: "" }, finish_reason: "stop" });
    await assert.rejects(
      provider.complete("summarize", { maxTokens: 512 }),
      (err: unknown) => {
        assert.ok(err instanceof EmptyCompletionError);
        assert.strictEqual(err.finishReason, "stop");
        assert.strictEqual(err.truncated, false);
        assert.match(err.message, /empty completion/i);
        return true;
      }
    );
  });

  await test("whitespace-only content throws (not treated as a real answer)", async () => {
    const { provider } = providerReturning({ message: { content: "  \n\t " }, finish_reason: "stop" });
    await assert.rejects(
      provider.complete("extract"),
      (err: unknown) => err instanceof EmptyCompletionError
    );
  });

  await test("null content (finish_reason 'length', no max_tokens set) throws with generic budget wording", async () => {
    const { provider } = providerReturning({ message: { content: null }, finish_reason: "length" });
    await assert.rejects(
      provider.complete("synthesize"),
      (err: unknown) => {
        assert.ok(err instanceof EmptyCompletionError);
        assert.strictEqual(err.maxTokens, undefined);
        assert.strictEqual(err.truncated, true);
        assert.match(err.message, /the configured max_tokens/);
        return true;
      }
    );
  });

  await test("non-empty content returns unchanged (no throw)", async () => {
    const { provider, lastArgs } = providerReturning({
      message: { content: "Contradicted: potassium 4.1 is within range." },
      finish_reason: "stop",
    });
    const text = await provider.complete("grade this claim", { maxTokens: 800, system: "You are a skeptic." });
    assert.strictEqual(text, "Contradicted: potassium 4.1 is within range.");
    // Sanity: the request carried the caller's cap through unchanged.
    assert.strictEqual(lastArgs()?.max_tokens, 800);
  });

  await test("content with surrounding whitespace is preserved, not trimmed", async () => {
    const { provider } = providerReturning({
      message: { content: "  real answer  " },
      finish_reason: "stop",
    });
    const text = await provider.complete("q");
    assert.strictEqual(text, "  real answer  ");
  });

  await test("missing choice (empty choices array) throws rather than returning ''", async () => {
    const { provider } = providerReturning(undefined);
    await assert.rejects(
      provider.complete("q"),
      (err: unknown) => {
        assert.ok(err instanceof EmptyCompletionError);
        assert.strictEqual(err.finishReason, null);
        return true;
      }
    );
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
