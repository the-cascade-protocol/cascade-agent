/**
 * OpenAI-compatible provider.
 *
 * Handles three backends that all speak the OpenAI Chat Completions API:
 *   • openai  — api.openai.com         (GPT-4o, o3, …)
 *   • google  — generativelanguage.googleapis.com/v1beta/openai/  (Gemini)
 *   • ollama  — localhost:11434/v1      (local models, no key required)
 */
import OpenAI from "openai";
import { tools, executeTool } from "../tools.js";
import { SYSTEM_PROMPT } from "../system-prompt.js";
// Convert our canonical tool definitions to OpenAI function-calling format.
function toOpenAITools() {
    return tools.map((t) => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
        },
    }));
}
export class OpenAICompatProvider {
    providerName;
    model;
    client;
    apiKey;
    constructor(providerName, apiKey, model, baseURL) {
        this.providerName = providerName;
        this.model = model;
        this.apiKey = apiKey;
        this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    }
    async listModels() {
        if (this.providerName === "ollama") {
            // Ollama uses a different endpoint: GET /api/tags
            // The client's baseURL is http://localhost:11434/v1, so strip /v1
            const baseURL = this.client.baseURL ?? "http://localhost:11434/v1";
            const tagsURL = baseURL.replace(/\/v1\/?$/, "") + "/api/tags";
            try {
                const res = await fetch(tagsURL);
                const json = await res.json();
                return (json.models ?? []).map((m) => m.name).sort();
            }
            catch {
                return [];
            }
        }
        if (this.providerName === "google") {
            // Use Google's native REST endpoint — the OpenAI-compat /models doesn't return a usable list.
            // Returns models with names like "models/gemini-2.5-flash"; strip the prefix and
            // filter to generative (chat-capable) models only.
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}&pageSize=100`;
            const res = await fetch(url);
            if (!res.ok)
                throw new Error(`Google models API error: ${res.status} ${res.statusText}`);
            const json = await res.json();
            return (json.models ?? [])
                .filter((m) => m.supportedGenerationMethods?.includes("generateContent") &&
                m.name.includes("gemini"))
                .map((m) => m.name.replace(/^models\//, ""))
                .sort();
        }
        // OpenAI — filter to GPT/o-series chat models
        const page = await this.client.models.list();
        const ids = [];
        for await (const m of page) {
            const id = m.id;
            if (id.startsWith("gpt-") ||
                id.startsWith("o1") ||
                id.startsWith("o3") ||
                id.startsWith("o4")) {
                ids.push(id);
            }
        }
        return ids.sort();
    }
    async runTurn(messages, callbacks) {
        // Build the initial OpenAI message list for this turn
        const history = [
            { role: "system", content: SYSTEM_PROMPT },
            ...messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        ];
        const openAITools = toOpenAITools();
        let finalText = "";
        while (true) {
            // Accumulator for streamed tool-call chunks
            const pending = {};
            let textChunk = "";
            let finishReason = null;
            const stream = await this.client.chat.completions.create({
                model: this.model,
                messages: history,
                tools: openAITools,
                tool_choice: "auto",
                stream: true,
            });
            for await (const chunk of stream) {
                const choice = chunk.choices[0];
                if (!choice)
                    continue;
                if (choice.finish_reason)
                    finishReason = choice.finish_reason;
                const delta = choice.delta;
                if (delta.content) {
                    callbacks.onText(delta.content);
                    textChunk += delta.content;
                    finalText += delta.content;
                }
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const i = tc.index;
                        if (!pending[i])
                            pending[i] = { id: "", name: "", arguments: "" };
                        if (tc.id)
                            pending[i].id = tc.id;
                        if (tc.function?.name)
                            pending[i].name += tc.function.name;
                        if (tc.function?.arguments)
                            pending[i].arguments += tc.function.arguments;
                    }
                }
            }
            const calls = Object.values(pending);
            if (finishReason !== "tool_calls" || calls.length === 0)
                break;
            // Append assistant message that contains the tool_calls
            history.push({
                role: "assistant",
                content: textChunk || null,
                tool_calls: calls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: c.arguments },
                })),
            });
            // Execute each tool call and append a tool-role message
            for (const c of calls) {
                let input;
                try {
                    input = JSON.parse(c.arguments);
                }
                catch {
                    input = {};
                }
                callbacks.onToolStart(c.name, input);
                const result = executeTool(c.name, input);
                callbacks.onToolEnd(result);
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
