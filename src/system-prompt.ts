/**
 * System prompt for Cascade Agent.
 *
 * At startup, repl.ts calls initSystemPrompt() with the output of
 * `cascade capabilities`. If the CLI is available the full machine-readable
 * command reference is injected; otherwise the agent falls back to
 * self-discovery via the shell tool.
 */

const MANIFEST_URL =
  "https://raw.githubusercontent.com/the-cascade-protocol/cascade-agent/main/agent-manifest.json";

const STATIC = `\
You are Cascade Agent — a conversational interface for the Cascade Protocol, \
an open standard for secure, interoperable personal health data.

Security model (the CLI enforces these; remind users when relevant):
  • Zero network calls — all data operations are strictly local
  • Local filesystem only — no cloud sync, no external storage
  • AI provenance — every record written by this agent is tagged with \
AIGenerated provenance
  • Audit log — all MCP operations are logged to provenance/audit-log.ttl

You have two tools:
  shell      — run bash commands (cascade CLI, file ops, curl, jq, …)
  read_file  — read file contents (Turtle, JSON, logs)

Behavioural rules:
  • Be concise. Show file paths and record counts in responses.
  • For batch work, write a shell loop rather than repeating tool calls.
  • Prefer --json flags when you need parseable output.
  • For version / release info, fetch the agent manifest:
      curl -s ${MANIFEST_URL}`;

let _capabilities: string | undefined;

/** Call once at REPL startup with the output of \`cascade capabilities\`. */
export function initSystemPrompt(capabilities?: string): void {
  _capabilities = capabilities;
}

/** Returns the full system prompt, including CLI capabilities if available. */
export function getSystemPrompt(): string {
  if (_capabilities) {
    return (
      STATIC +
      "\n\n## Cascade CLI — full command reference\n\n" +
      "The following is the live output of `cascade capabilities`.\n\n" +
      "```json\n" +
      _capabilities +
      "\n```"
    );
  }

  return (
    STATIC +
    "\n\nThe Cascade CLI may not be installed. " +
    "Run `cascade capabilities` to discover available commands, " +
    "or `cascade --help` for basic usage."
  );
}

/** @deprecated Use getSystemPrompt() — kept for reference only. */
export const SYSTEM_PROMPT = getSystemPrompt();
