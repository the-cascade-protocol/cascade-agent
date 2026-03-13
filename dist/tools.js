import { execSync } from "child_process";
import { readFileSync } from "fs";
export const tools = [
    {
        name: "shell",
        description: [
            "Run a shell (bash) command and return stdout + stderr.",
            "Use this for all Cascade Protocol CLI operations:",
            "  cascade convert --from fhir --to cascade <file>",
            "  cascade convert --from fhir --to cascade <file> > output.ttl",
            "  cascade validate <file.ttl>",
            "  cascade pod init <path>",
            "  cascade capabilities",
            "Also use for file system operations: ls, find, mkdir, wc -l, etc.",
            "For batch work, construct a shell loop:",
            '  for f in dir/*.json; do cascade convert --from fhir --to cascade "$f" > "out/${f%.json}.ttl"; done',
        ].join("\n"),
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
        description: "Read and return the text contents of a file. Truncated at 20 KB. " +
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
export function executeTool(name, input) {
    switch (name) {
        case "shell": {
            const cmd = input.command;
            if (!cmd)
                return "Error: no command provided";
            try {
                const stdout = execSync(cmd, {
                    cwd: input.cwd,
                    timeout: 5 * 60 * 1000,
                    encoding: "utf-8",
                    maxBuffer: 1024 * 1024 * 20,
                    shell: "/bin/bash",
                });
                return stdout.trim() || "(command succeeded with no output)";
            }
            catch (err) {
                const e = err;
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
            if (!filePath)
                return "Error: no path provided";
            try {
                const content = readFileSync(filePath, "utf-8");
                const limit = 20 * 1024;
                return content.length > limit
                    ? content.slice(0, limit) + `\n\n[truncated — ${content.length} bytes total]`
                    : content;
            }
            catch (err) {
                return `Error reading file: ${err.message}`;
            }
        }
        default:
            return `Unknown tool: ${name}`;
    }
}
