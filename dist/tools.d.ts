export interface CanonicalTool {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: Record<string, {
            type: string;
            description?: string;
        }>;
        required?: string[];
    };
}
export declare const tools: CanonicalTool[];
export interface ToolInput {
    command?: string;
    cwd?: string;
    path?: string;
}
export declare function executeTool(name: string, input: ToolInput): string;
