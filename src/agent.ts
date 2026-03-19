import type { Provider, SimpleMessage, AgentCallbacks } from "./providers/types.js";
import type { CanonicalTool } from "./tools.js";

export type { SimpleMessage, AgentCallbacks };

/**
 * Run one conversational exchange:
 *   1. Appends the last user message (already in `messages`) to the history.
 *   2. Delegates to the provider, which streams the response and handles any
 *      tool-use loops internally.
 *   3. Appends the assistant reply and returns the updated history.
 *
 * @param tools  Appeal-specific or custom tools to pass to the model alongside
 *               built-in tools. Use an empty array for default (shell + read_file) only.
 */
export async function runAgent(
  provider: Provider,
  messages: SimpleMessage[],
  tools: CanonicalTool[],
  callbacks: AgentCallbacks
): Promise<SimpleMessage[]> {
  const text = await provider.runTurn(messages, tools, callbacks);
  return [...messages, { role: "assistant" as const, content: text }];
}
