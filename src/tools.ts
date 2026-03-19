import { execSync } from "child_process";
import { readFileSync } from "fs";

/** JSON Schema property descriptor used in tool input_schema. */
export interface ToolPropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

// Provider-agnostic tool definition (Anthropic-compatible JSON Schema shape).
export interface CanonicalTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, ToolPropertySchema>;
    required?: string[];
  };
  run?(input: ToolInput): unknown | Promise<unknown>;
}

export const tools: CanonicalTool[] = [
  {
    name: "shell",
    description:
      "Run a shell (bash) command and return stdout + stderr. " +
      "Use for all Cascade Protocol CLI operations, file system work " +
      "(ls, find, mkdir, wc, etc.), and network fetches (curl). " +
      "For batch work, use a shell loop rather than repeated tool calls.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to run",
        },
        cwd: {
          type: "string",
          description: "Working directory (optional, defaults to current)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description:
      "Read and return the text contents of a file. Truncated at 20 KB. " +
      "Use this to inspect .ttl files, .json FHIR records, logs, etc.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file",
        },
      },
      required: ["path"],
    },
  },
];

/** Generic tool input — custom tools may have any string-keyed properties. */
export interface ToolInput {
  [key: string]: unknown;
  command?: string;
  cwd?: string;
  path?: string;
}

export function executeTool(name: string, input: ToolInput): string {
  switch (name) {
    case "shell": {
      const cmd = input.command;
      if (!cmd) return "Error: no command provided";
      try {
        const stdout = execSync(cmd, {
          cwd: input.cwd,
          timeout: 5 * 60 * 1000,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024 * 20,
          shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
        });
        return stdout.trim() || "(command succeeded with no output)";
      } catch (err) {
        const e = err as {
          message: string;
          stdout?: string;
          stderr?: string;
          status?: number;
        };
        return [
          `exit ${e.status ?? "?"}`,
          e.stderr?.trim(),
          e.stdout?.trim(),
          e.message,
        ]
          .filter(Boolean)
          .join("\n");
      }
    }

    case "read_file": {
      const filePath = input.path;
      if (!filePath) return "Error: no path provided";
      try {
        const content = readFileSync(filePath, "utf-8");
        const limit = 20 * 1024;
        return content.length > limit
          ? content.slice(0, limit) + `\n\n[truncated — ${content.length} bytes total]`
          : content;
      } catch (err) {
        return `Error reading file: ${(err as Error).message}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
