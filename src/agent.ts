import type { Provider, SimpleMessage, AgentCallbacks } from "./providers/types.js";

export type { SimpleMessage, AgentCallbacks };

/**
 * Run one conversational exchange:
 *   1. Appends the last user message (already in `messages`) to the history.
 *   2. Delegates to the provider, which streams the response and handles any
 *      tool-use loops internally.
 *   3. Appends the assistant reply and returns the updated history.
 */
export async function runAgent(
  provider: Provider,
  messages: SimpleMessage[],
  callbacks: AgentCallbacks
): Promise<SimpleMessage[]> {
  const text = await provider.runTurn(messages, callbacks);
  return [...messages, { role: "assistant" as const, content: text }];
}
