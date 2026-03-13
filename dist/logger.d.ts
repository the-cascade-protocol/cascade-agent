declare const LOG_DIR: string;
export interface SessionLogger {
    logUserMessage(content: string): void;
    logAssistantText(content: string): void;
    logToolCall(name: string, input: unknown): void;
    logToolResult(name: string, result: string): void;
    logError(message: string): void;
    close(): void;
    readonly filePath: string;
}
export declare function createSessionLogger(provider: string, model: string): SessionLogger;
export interface LogEntry {
    filename: string;
    filePath: string;
    createdAt: Date;
}
export declare function listLogs(limit?: number): LogEntry[];
export { LOG_DIR };
