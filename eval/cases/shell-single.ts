import type { EvalCase } from "../harness.js";

/**
 * Case: shell-single
 * Simplest possible tool call — list files in /tmp.
 * Checks: model calls `shell`, command field is present and non-empty.
 */
export const shellSingle: EvalCase = {
  name: "shell-single",
  description: "List files in /tmp → expects one shell tool call",

  prompt: "Run a shell command to list all files in the /tmp directory and tell me how many there are.",

  evaluate(_messages, toolCalls) {
    const shellCall = toolCalls.find((tc) => tc.name === "shell");
    if (!shellCall) {
      return { pass: false, score: 0, notes: "No shell tool call made" };
    }

    const cmd = shellCall.input.command as string | undefined;
    if (!cmd) {
      return { pass: false, score: 0.3, notes: "shell called but command field missing" };
    }

    // Must reference /tmp in the command
    if (!cmd.includes("/tmp") && !cmd.includes("tmp")) {
      return { pass: false, score: 0.5, notes: `command does not reference /tmp: ${cmd}` };
    }

    // Command must have executed (result is non-empty)
    if (!shellCall.result || shellCall.result.startsWith("Error")) {
      return { pass: false, score: 0.7, notes: `shell returned error: ${shellCall.result}` };
    }

    return { pass: true, score: 1.0, notes: `command: ${cmd.slice(0, 60)}` };
  },
};
