/**
 * Session logger — writes a markdown log file for every agent run.
 * Location: ~/.config/cascade-agent/logs/YYYY-MM-DD_HH-MM-SS.md
 */
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".config", "cascade-agent", "logs");

export interface SessionLogger {
  logUserMessage(content: string): void;
  logAssistantText(content: string): void;
  logToolCall(name: string, input: unknown): void;
  logToolResult(name: string, result: string): void;
  logError(message: string): void;
  close(): void;
  readonly filePath: string;
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function slugTimestamp(): string {
  return new Date()
    .toISOString()
    .replace("T", "_")
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
}

export function createSessionLogger(provider: string, model: string): SessionLogger {
  mkdirSync(LOG_DIR, { recursive: true });

  const filename = `${slugTimestamp()}.md`;
  const filePath = join(LOG_DIR, filename);

  // Write header
  writeFileSync(
    filePath,
    `# Cascade Agent Session\n\n` +
    `- **Date:** ${timestamp()}\n` +
    `- **Provider:** ${provider}\n` +
    `- **Model:** ${model}\n\n` +
    `---\n\n`,
    "utf-8"
  );

  let assistantBuffer = "";

  function flush() {
    if (assistantBuffer.trim()) {
      appendFileSync(filePath, `${assistantBuffer.trimEnd()}\n\n`, "utf-8");
      assistantBuffer = "";
    }
  }

  return {
    filePath,

    logUserMessage(content: string) {
      flush();
      appendFileSync(filePath, `### You\n\n${content}\n\n`, "utf-8");
    },

    logAssistantText(content: string) {
      assistantBuffer += content;
    },

    logToolCall(name: string, input: unknown) {
      flush();
      const inputStr =
        name === "shell" && (input as { command?: string }).command
          ? (input as { command: string }).command
          : JSON.stringify(input, null, 2);
      appendFileSync(
        filePath,
        `#### Tool: \`${name}\`\n\n\`\`\`\n${inputStr}\n\`\`\`\n\n`,
        "utf-8"
      );
    },

    logToolResult(name: string, result: string) {
      // Write the full result — no truncation
      appendFileSync(
        filePath,
        `<details>\n<summary>Output (${result.split("\n").length} lines)</summary>\n\n\`\`\`\n${result}\n\`\`\`\n\n</details>\n\n`,
        "utf-8"
      );
    },

    logError(message: string) {
      flush();
      appendFileSync(filePath, `> **Error:** ${message}\n\n`, "utf-8");
    },

    close() {
      flush();
      appendFileSync(filePath, `---\n\n*Session ended ${timestamp()}*\n`, "utf-8");
    },
  };
}

// ── Log listing ─────────────────────────────────────────────────────────────

export interface LogEntry {
  filename: string;
  filePath: string;
  createdAt: Date;
}

export function listLogs(limit = 20): LogEntry[] {
  try {
    return readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const fp = join(LOG_DIR, f);
        return { filename: f, filePath: fp, createdAt: statSync(fp).birthtime };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}

export { LOG_DIR };
