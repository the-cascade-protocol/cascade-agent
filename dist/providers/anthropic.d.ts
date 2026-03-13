import type { Provider, SimpleMessage, AgentCallbacks } from "./types.js";
export declare class AnthropicProvider implements Provider {
    readonly providerName: "anthropic";
    readonly model: string;
    private client;
    constructor(apiKey: string, model: string);
    listModels(): Promise<string[]>;
    runTurn(messages: SimpleMessage[], callbacks: AgentCallbacks): Promise<string>;
}
