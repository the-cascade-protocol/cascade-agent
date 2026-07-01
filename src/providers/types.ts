import type { CanonicalTool, ToolInput } from "../tools.js";

// "vertex" = Google Vertex AI (regional aiplatform.googleapis.com, ADC auth,
// BAA-covered / PHI-safe). DISTINCT from "google" (public AI Studio endpoint,
// API-key auth, NOT BAA-covered). See providers/vertex.ts for the full rationale.
export type ProviderName = "anthropic" | "openai" | "google" | "vertex" | "ollama" | "local";

export interface SimpleMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentCallbacks {
  onText: (delta: string) => void;
  /** Called when the model invokes a tool. */
  onToolStart: (name: string, input: ToolInput) => void;
  /** Called with the tool name and its result after execution. */
  onToolEnd: (name: string, result: string) => void;
}

/**
 * Options for one single-shot completion (the inference gateway's `complete`
 * mode). Unlike `runTurn`, a completion carries the CALLER's system
 * instruction verbatim, exposes no tools, and injects no agent system prompt —
 * it is the primitive workflows (grounding, report) build on.
 */
export interface CompleteOptions {
  /** A system instruction, kept separate so providers can route it. */
  system?: string;
  /** Lower is more deterministic. Default is left to the provider. */
  temperature?: number;
  /** Hard cap to prevent runaway generation. */
  maxTokens?: number;
  /** Cancels the in-flight request. */
  signal?: AbortSignal;
}

/** A Provider handles one conversational turn, including any tool-use loops. */
export interface Provider {
  readonly providerName: ProviderName;
  readonly model: string;
  /**
   * Send the current conversation history to the model and stream the
   * response. Executes tool calls internally until the model stops.
   * Returns the final assistant text for the turn.
   *
   * @param tools  Custom tools to expose to the model in addition to (or instead of)
   *               the built-in shell/read_file tools. Pass an empty array to use only
   *               built-in tools.
   */
  runTurn(
    messages: SimpleMessage[],
    tools: CanonicalTool[],
    callbacks: AgentCallbacks
  ): Promise<string>;

  /**
   * Single-shot, non-streaming completion: text in, text out, no tools, no
   * injected agent system prompt. Optional — the inference gateway
   * feature-checks it; providers that only serve the conversational agent may
   * omit it.
   */
  complete?(prompt: string, opts?: CompleteOptions): Promise<string>;

  /** Fetch currently available model IDs from the provider's API. */
  listModels(): Promise<string[]>;
}
