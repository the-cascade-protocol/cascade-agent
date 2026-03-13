import type { Provider, SimpleMessage, AgentCallbacks, ProviderName } from "./types.js";
export declare class OpenAICompatProvider implements Provider {
    readonly providerName: ProviderName;
    readonly model: string;
    private client;
    private apiKey;
    constructor(providerName: ProviderName, apiKey: string, model: string, baseURL?: string);
    listModels(): Promise<string[]>;
    runTurn(messages: SimpleMessage[], callbacks: AgentCallbacks): Promise<string>;
}
