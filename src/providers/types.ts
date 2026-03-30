import type { CanonicalTool, ToolInput } from "../tools.js";

export type ProviderName = "anthropic" | "openai" | "google" | "ollama" | "local";

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

  /** Fetch currently available model IDs from the provider's API. */
  listModels(): Promise<string[]>;
}
