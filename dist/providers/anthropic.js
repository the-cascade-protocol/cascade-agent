import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool } from "../tools.js";
import { SYSTEM_PROMPT } from "../system-prompt.js";
export class AnthropicProvider {
    providerName = "anthropic";
    model;
    client;
    constructor(apiKey, model) {
        this.client = new Anthropic({ apiKey });
        this.model = model;
    }
    async listModels() {
        const page = await this.client.models.list({ limit: 100 });
        return page.data.map((m) => m.id).sort();
    }
    async runTurn(messages, callbacks) {
        // Convert simple messages to Anthropic format
        let history = messages.map((m) => ({
            role: m.role,
            content: m.content,
        }));
        // Cast tools — CanonicalTool is structurally identical to Anthropic.Tool
        const anthropicTools = tools;
        let finalText = "";
        while (true) {
            const stream = this.client.messages.stream({
                model: this.model,
                max_tokens: 4096,
                system: SYSTEM_PROMPT,
                tools: anthropicTools,
                messages: history,
            });
            for await (const event of stream) {
                if (event.type === "content_block_delta" &&
                    event.delta.type === "text_delta") {
                    callbacks.onText(event.delta.text);
                    finalText += event.delta.text;
                }
            }
            const response = await stream.finalMessage();
            history = [...history, { role: "assistant", content: response.content }];
            if (response.stop_reason !== "tool_use")
                break;
            const toolResults = [];
            for (const block of response.content) {
                if (block.type !== "tool_use")
                    continue;
                const input = block.input;
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
