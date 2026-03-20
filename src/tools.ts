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
      let cmd = input.command;
      if (!cmd) return "Error: no command provided";

      // When the agent runs `cascade pod query ... --json` without piping to jq,
      // auto-inject a per-type smart summary filter so the model never drowns in
      // raw JSON.  A pipe to jq (or jq -f) indicates the agent already has a
      // filter — leave those alone.
      const podQueryJsonRaw =
        /cascade\s+pod\s+query\b[^|]*--json/.test(cmd) && !/\|\s*jq\b/.test(cmd);
      if (podQueryJsonRaw) {
        // Detect which data type flag is present
        const typeMatch = cmd.match(
          /--(conditions|medications|lab-results|immunizations|vital-signs|allergies|supplements|procedures|encounters|medication-administrations|implanted-devices|imaging-studies|claims|benefit-statements|denial-notices|appeals|all)\b/,
        );
        const dataType = typeMatch ? typeMatch[1] : null;

        let jqFilter: string;
        if (dataType === "conditions") {
          jqFilter =
            '[.dataTypes.conditions.records[] | select(.properties["health:snomedSemanticTag"] == "disorder") | {name: .properties["health:conditionName"], status: .properties["health:status"]}]';
        } else if (dataType === "medications") {
          jqFilter =
            '[.dataTypes.medications.records[] | {name: .properties["health:medicationName"], active: .properties["health:isActive"]}]';
        } else if (dataType === "lab-results") {
          jqFilter =
            '[.dataTypes["lab-results"].records[] | {test: .properties["health:testName"], value: .properties["health:resultValue"], unit: .properties["health:resultUnit"], date: .properties["health:performedDate"]}] | sort_by(.date) | reverse | .[0:20]';
        } else {
          // Generic summary: counts + first 3 samples per type
          jqFilter =
            '{pod: .pod, types: (.dataTypes | to_entries | map({type: .key, count: .value.count, sample: [.value.records[:3][] | .properties]}))}';
        }
        cmd = cmd.replace(/--json\b/, `--json | jq '${jqFilter}'`);
      }

      // Fix a common LLM mistake: \" inside single-quoted jq filter strings.
      // Single quotes preserve backslashes literally, so jq sees \\" instead of ".
      // Strip the backslashes so the filter parses correctly.
      cmd = cmd.replace(
        /(jq\s+(?:-[a-zA-Z]+\s+)*)'([^']*)'/g,
        (_, prefix: string, filter: string) =>
          prefix + "'" + filter.replace(/\\"/g, '"') + "'",
      );

      try {
        const stdout = execSync(cmd, {
          cwd: input.cwd,
          timeout: 5 * 60 * 1000,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024 * 20,
          shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
        });
        const out = stdout.trim() || "(command succeeded with no output)";
        const MAX_CHARS = 40_000;
        if (out.length > MAX_CHARS) {
          return (
            out.slice(0, MAX_CHARS) +
            `\n\n[OUTPUT TRUNCATED — ${out.length.toLocaleString()} chars total. ` +
            `The output is too large to read directly. ` +
            `Pipe through jq to extract only the fields you need, e.g.: ` +
            `cascade pod query <pod> --TYPE --json | jq '[.dataTypes[\"TYPE\"].records[] | ...]']`
          );
        }
        return out;
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
