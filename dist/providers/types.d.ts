import type { ToolInput } from "../tools.js";
export type ProviderName = "anthropic" | "openai" | "google" | "ollama";
export interface SimpleMessage {
    role: "user" | "assistant";
    content: string;
}
export interface AgentCallbacks {
    onText: (delta: string) => void;
    onToolStart: (name: string, input: ToolInput) => void;
    onToolEnd: (result: string) => void;
}
/** A Provider handles one conversational turn, including any tool-use loops. */
export interface Provider {
    readonly providerName: ProviderName;
    readonly model: string;
    /**
     * Send the current conversation history to the model and stream the
     * response. Executes tool calls internally until the model stops.
     * Returns the final assistant text for the turn.
     */
    runTurn(messages: SimpleMessage[], callbacks: AgentCallbacks): Promise<string>;
    /** Fetch currently available model IDs from the provider's API. */
    listModels(): Promise<string[]>;
}
