/**
 * OpenAI-compatible provider.
 *
 * Handles three backends that all speak the OpenAI Chat Completions API:
 *   • openai  — api.openai.com         (GPT-4o, o3, …)
 *   • google  — generativelanguage.googleapis.com/v1beta/openai/  (Gemini)
 *   • ollama  — localhost:11434/v1      (local models, no key required)
 */
import OpenAI from "openai";
import { tools as builtinTools, executeTool, type ToolInput } from "../tools.js";
import type { CanonicalTool } from "../tools.js";
import { getSystemPrompt } from "../system-prompt.js";
import type {
  Provider,
  SimpleMessage,
  AgentCallbacks,
  ProviderName,
  CompleteOptions,
} from "./types.js";

/**
 * Thrown by `complete()` when an otherwise-successful (HTTP 200) response
 * carries no visible text — an empty or whitespace-only message body.
 *
 * This is the distinct, catchable signal that separates "the model said
 * nothing" from "the model returned empty on purpose." Reasoning tiers
 * (gemini-3-flash-preview; Qwen thinking) can burn the entire `max_tokens`
 * budget on hidden reasoning and hand back `content === ""` with a
 * `finish_reason` of `length` — a failure that previously slipped through as
 * a valid empty string and was then treated as a real (empty) result by a
 * downstream parser. Throwing here forces callers to fail loud.
 */
export class EmptyCompletionError extends Error {
  /** The provider's stated stop reason (e.g. "length", "stop"), if any. */
  readonly finishReason: string | null;
  /** The `max_tokens` cap requested for this call, if one was set. */
  readonly maxTokens?: number;
  /** The model that produced the empty body. */
  readonly model: string;
  /** The backend that served the request. */
  readonly provider: ProviderName;
  /** True when the stop reason indicates the token budget was exhausted. */
  readonly truncated: boolean;

  constructor(details: {
    finishReason: string | null;
    maxTokens?: number;
    model: string;
    provider: ProviderName;
  }) {
    // Treat both the OpenAI (`length`) and generic (`max_tokens`) truncation
    // signals as budget exhaustion.
    const truncated =
      details.finishReason === "length" ||
      details.finishReason === "max_tokens";
    const budget =
      details.maxTokens !== undefined
        ? `max_tokens=${details.maxTokens}`
        : "the configured max_tokens";
    const head =
      `Model ${details.provider}/${details.model} returned an empty completion ` +
      `(finish_reason=${details.finishReason ?? "unknown"}).`;
    const hint = truncated
      ? ` The token budget (${budget}) was likely exhausted by hidden reasoning ` +
        `tokens before any visible content was produced. Raise max_tokens for ` +
        `this call so the model has room to answer after it finishes reasoning.`
      : ` The response body was empty or whitespace-only on an otherwise-successful ` +
        `response, which usually means the model produced no answer. On a reasoning ` +
        `tier this is often silent budget exhaustion; try raising max_tokens ` +
        `(${budget}).`;
    super(head + hint);
    this.name = "EmptyCompletionError";
    this.finishReason = details.finishReason;
    this.maxTokens = details.maxTokens;
    this.model = details.model;
    this.provider = details.provider;
    this.truncated = truncated;
  }
}

// Convert canonical tool definitions to OpenAI function-calling format.
function toOpenAITools(allTools: CanonicalTool[]): OpenAI.ChatCompletionTool[] {
  return allTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as unknown as Record<string, unknown>,
    },
  }));
}

/** Execute a tool: prefer custom tool's run() method; fall back to built-in executeTool(). */
async function runTool(
  name: string,
  input: ToolInput,
  customTools: CanonicalTool[]
): Promise<string> {
  const custom = customTools.find((t) => t.name === name);
  if (custom?.run) {
    const result = await custom.run(input);
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  return executeTool(name, input);
}

export class OpenAICompatProvider implements Provider {
  readonly providerName: ProviderName;
  readonly model: string;
  private client: OpenAI;
  private apiKey: string;

  constructor(
    providerName: ProviderName,
    apiKey: string,
    model: string,
    baseURL?: string,
    defaultHeaders?: Record<string, string>
  ) {
    this.providerName = providerName;
    this.model = model;
    this.apiKey = apiKey;
    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(defaultHeaders ? { defaultHeaders } : {}),
    });
  }

  /**
   * Single-shot, non-streaming completion (the gateway's `complete` mode).
   * Deliberately does NOT inject the agent system prompt or any tools: the
   * caller's `system` is the whole instruction. Workflows (grounding, report)
   * call this; the conversational agent keeps using `runTurn`.
   */
  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...(opts.system
        ? [{ role: "system" as const, content: opts.system }]
        : []),
      { role: "user" as const, content: prompt },
    ];
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        stream: false,
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.maxTokens !== undefined
          ? { max_tokens: opts.maxTokens }
          : {}),
      },
      opts.signal ? { signal: opts.signal } : undefined
    );
    const choice = res.choices[0];
    const content = choice?.message?.content ?? "";

    // Detect a successful (200) response whose assembled text is empty or
    // whitespace-only. Returning "" here would let a downstream parser treat
    // "the model said nothing" as a valid empty result — the exact silent
    // failure that has bitten the Workbench (skeptic starvation, Ledger
    // extraction truncation, literature synthesis/stance starvation). Fail
    // loud with a typed, catchable error instead. See EmptyCompletionError.
    if (content.trim() === "") {
      throw new EmptyCompletionError({
        finishReason: choice?.finish_reason ?? null,
        maxTokens: opts.maxTokens,
        model: this.model,
        provider: this.providerName,
      });
    }

    return content;
  }

  async listModels(): Promise<string[]> {
    if (this.providerName === "ollama") {
      // Ollama uses a different endpoint: GET /api/tags
      // The client's baseURL is http://localhost:11434/v1, so strip /v1
      const baseURL = (this.client as unknown as { baseURL: string }).baseURL ?? "http://localhost:11434/v1";
      const tagsURL = baseURL.replace(/\/v1\/?$/, "") + "/api/tags";
      try {
        const res = await fetch(tagsURL);
        const json = await res.json() as { models?: Array<{ name: string }> };
        return (json.models ?? []).map((m) => m.name).sort();
      } catch {
        return [];
      }
    }

    if (this.providerName === "google") {
      // Use Google's native REST endpoint — the OpenAI-compat /models doesn't return a usable list.
      // Returns models with names like "models/gemini-2.5-flash"; strip the prefix and
      // filter to generative (chat-capable) models only.
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}&pageSize=100`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Google models API error: ${res.status} ${res.statusText}`);
      const json = await res.json() as {
        models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
      };
      return (json.models ?? [])
        .filter((m) =>
          m.supportedGenerationMethods?.includes("generateContent") &&
          m.name.includes("gemini")
        )
        .map((m) => m.name.replace(/^models\//, ""))
        .sort();
    }

    // OpenAI — filter to GPT/o-series chat models
    const page = await this.client.models.list();
    const ids: string[] = [];
    for await (const m of page) {
      const id = m.id;
      if (
        id.startsWith("gpt-") ||
        id.startsWith("o1") ||
        id.startsWith("o3") ||
        id.startsWith("o4")
      ) {
        ids.push(id);
      }
    }
    return ids.sort();
  }

  async runTurn(
    messages: SimpleMessage[],
    customTools: CanonicalTool[],
    callbacks: AgentCallbacks
  ): Promise<string> {
    // Merge custom tools with built-in tools; custom tools take precedence on name collision.
    const customNames = new Set(customTools.map((t) => t.name));
    const allTools: CanonicalTool[] = [
      ...customTools,
      ...builtinTools.filter((t) => !customNames.has(t.name)),
    ];

    // Build the initial OpenAI message list for this turn
    const history: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: getSystemPrompt() },
      ...messages.map(
        (m): OpenAI.ChatCompletionMessageParam => ({
          role: m.role,
          content: m.content,
        })
      ),
    ];

    const openAITools = toOpenAITools(allTools);
    let finalText = "";
    const MAX_TOOL_ITERATIONS = 20;
    let iterations = 0;

    while (true) {
      if (++iterations > MAX_TOOL_ITERATIONS) {
        finalText += "\n\n[Agent halted: exceeded maximum tool-call iterations. Please rephrase your request or break it into smaller steps.]";
        break;
      }
      // Accumulator for streamed tool-call chunks
      const pending: Record<
        number,
        { id: string; name: string; arguments: string }
      > = {};
      let textChunk = "";
      let finishReason: string | null = null;

      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: history,
        tools: openAITools,
        tool_choice: "auto",
        stream: true,
      });

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;

        if (delta.content) {
          callbacks.onText(delta.content);
          textChunk += delta.content;
          finalText += delta.content;
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // Skip Google's extended-thinking entries: they appear as tool_calls
            // deltas that have only extra_content (thought_signature) but no
            // index or function field. Processing them pollutes `pending` with
            // a phantom entry at pending[undefined] and masks the real response.
            if (tc.index === undefined || !tc.function) continue;
            const i = tc.index;
            if (!pending[i]) pending[i] = { id: "", name: "", arguments: "" };
            if (tc.id) pending[i].id = tc.id;
            if (tc.function.name) pending[i].name += tc.function.name;
            if (tc.function.arguments) pending[i].arguments += tc.function.arguments;
          }
        }
      }

      const calls = Object.values(pending);

      // Gemini thinking-model fallback: when the model sends only thinking tokens
      // (as phantom tool_calls with extra_content but no function field) and no text
      // content, the streaming response is empty even though the model has a real
      // answer. Fall back to non-streaming for this turn.
      if (finishReason === "stop" && textChunk === "" && calls.length === 0) {
        const fallback = await this.client.chat.completions.create({
          model: this.model,
          messages: history,
          tools: openAITools,
          tool_choice: "auto",
          stream: false,
        });
        const msg = fallback.choices[0]?.message;
        if (msg?.content) {
          callbacks.onText(msg.content);
          finalText += msg.content;
        }
        // If the fallback produced real tool calls (with an actual function field),
        // add them to calls so the tool-execution path below handles them.
        if (fallback.choices[0]?.finish_reason === "tool_calls" && msg?.tool_calls) {
          for (const tc of msg.tool_calls) {
            const typed = tc as unknown as { id: string; function?: { name: string; arguments: string } };
            if (typed.function?.name) {
              calls.push({ id: typed.id, name: typed.function.name, arguments: typed.function.arguments ?? "" });
            }
          }
        }
        // Whether or not there were real tool calls, break if no content was produced
        // (the model/API is not providing a useful response for this turn).
        if (calls.length === 0) break;
      }

      if (finishReason !== "tool_calls" || calls.length === 0) break;

      // Append assistant message that contains the tool_calls
      history.push({
        role: "assistant",
        content: textChunk || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      // Execute each tool call and append a tool-role message
      for (const c of calls) {
        let input: ToolInput;
        try {
          input = JSON.parse(c.arguments) as ToolInput;
        } catch {
          input = {};
        }
        callbacks.onToolStart(c.name, input);
        const result = await runTool(c.name, input, customTools);
        callbacks.onToolEnd(c.name, result);

        history.push({
          role: "tool",
          tool_call_id: c.id,
          content: result,
        });
      }
    }

    return finalText;
  }
}
