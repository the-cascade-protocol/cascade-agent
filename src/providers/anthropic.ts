import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool, type ToolInput } from "../tools.js";
import { getSystemPrompt } from "../system-prompt.js";
import type { Provider, SimpleMessage, AgentCallbacks } from "./types.js";

export class AnthropicProvider implements Provider {
  readonly providerName = "anthropic" as const;
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async listModels(): Promise<string[]> {
    const page = await this.client.models.list({ limit: 100 });
    return page.data.map((m) => m.id).sort();
  }

  async runTurn(
    messages: SimpleMessage[],
    callbacks: AgentCallbacks
  ): Promise<string> {
    // Convert simple messages to Anthropic format
    let history: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Cast tools — CanonicalTool is structurally identical to Anthropic.Tool
    const anthropicTools = tools as unknown as Anthropic.Tool[];
    let finalText = "";

    while (true) {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 4096,
        system: getSystemPrompt(),
        tools: anthropicTools,
        messages: history,
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          callbacks.onText(event.delta.text);
          finalText += event.delta.text;
        }
      }

      const response = await stream.finalMessage();
      history = [...history, { role: "assistant", content: response.content }];

      if (response.stop_reason !== "tool_use") break;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const input = block.input as ToolInput;
        callbacks.onToolStart(block.name, input);
        const result = executeTool(block.name, input);
        callbacks.onToolEnd(result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }

      history = [...history, { role: "user", content: toolResults }];
    }

    return finalText;
  }
}
