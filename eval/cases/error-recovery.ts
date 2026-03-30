import type { EvalCase } from "../harness.js";

/**
 * Case: error-recovery
 * Agent runs a command that will fail (nonexistent cascade pod), then must:
 * - Not loop infinitely retrying
 * - Report the error clearly to the user
 * - Optionally suggest a fix
 *
 * Pass criteria:
 * - Shell was called (agent tried)
 * - Agent did NOT call shell more than 4 times (no infinite loop)
 * - Final response acknowledges the failure
 */
export const errorRecovery: EvalCase = {
  name: "error-recovery",
  description: "Tool returns error — agent reports cleanly without infinite loop",

  prompt: "Query the Cascade pod at /nonexistent/pod/path for all medications and show me the results.",

  evaluate(messages, toolCalls) {
    const shellCalls = toolCalls.filter((tc) => tc.name === "shell");

    if (shellCalls.length === 0) {
      // Acceptable: agent may refuse to run a clearly invalid path
      const response = messages[messages.length - 1]?.content?.toLowerCase() ?? "";
      const acknowledged = response.includes("not exist") || response.includes("invalid") ||
                           response.includes("error") || response.includes("doesn't exist");
      return {
        pass: acknowledged,
        score: acknowledged ? 0.7 : 0,
        notes: acknowledged ? "Refused invalid path without shell call (acceptable)" : "No shell call and no acknowledgement",
      };
    }

    // Check for infinite loop (>4 retries is a fail)
    if (shellCalls.length > 4) {
      return {
        pass: false,
        score: 0.1,
        notes: `Infinite retry loop — made ${shellCalls.length} shell calls`,
      };
    }

    // Check that at least one call actually got an error result
    const gotError = shellCalls.some(
      (tc) => tc.result && (
        tc.result.includes("exit") ||
        tc.result.includes("Error") ||
        tc.result.includes("error") ||
        tc.result.includes("not found") ||
        tc.result.includes("No such")
      )
    );

    // Check final response acknowledges failure
    const response = messages[messages.length - 1]?.content?.toLowerCase() ?? "";
    const acknowledged =
      response.includes("error") ||
      response.includes("not found") ||
      response.includes("doesn't exist") ||
      response.includes("does not exist") ||
      response.includes("failed") ||
      response.includes("couldn't") ||
      response.includes("unable");

    if (!acknowledged) {
      return {
        pass: false,
        score: 0.5,
        notes: `Shell called (${shellCalls.length}x), error=${gotError}, but final response doesn't acknowledge failure`,
      };
    }

    return {
      pass: true,
      score: 1.0,
      notes: `${shellCalls.length} shell call(s), error acknowledged cleanly`,
    };
  },
};
