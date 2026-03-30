import type { EvalCase } from "../harness.js";

/**
 * Case: nlu-cli-help
 * NLU test: user asks what the cascade CLI can do.
 * Expected: answer covers the main commands (pod, convert, validate) from knowledge.
 * A shell call to `cascade --help` is acceptable (and good!) but not required.
 * Fails only if the model gives a wrong or empty answer.
 *
 * Tests general CLI knowledge and willingness to use the help tool when appropriate.
 */
export const nluCliHelp: EvalCase = {
  name: "nlu-cli-help",
  description: "NLU: what can the cascade CLI do — knowledge or shell --help both acceptable",

  prompt: "What can the cascade CLI do? Give me an overview of the main commands.",

  evaluate(messages, toolCalls) {
    const response = messages[messages.length - 1]?.content?.toLowerCase() ?? "";

    // If the model used shell, check it tried to get help (acceptable behaviour)
    const shellCalls = toolCalls.filter((tc) => tc.name === "shell");
    if (shellCalls.length > 0) {
      const cmds = shellCalls.map((tc) => tc.input.command as string ?? "").join(" ");
      const usedHelp = cmds.includes("--help") || cmds.includes("capabilities");
      if (!usedHelp) {
        return {
          pass: false,
          score: 0.3,
          notes: `Shell called but not for help: ${cmds.slice(0, 80)}`,
        };
      }
    }

    // Regardless of approach, final response should cover the main commands
    const mentionsPod       = response.includes("pod");
    const mentionsConvert   = response.includes("convert");
    const mentionsValidate  = response.includes("validate");
    const mentionsQuery     = response.includes("query");

    const score =
      0.25 * (mentionsPod ? 1 : 0) +
      0.25 * (mentionsConvert ? 1 : 0) +
      0.25 * (mentionsValidate ? 1 : 0) +
      0.25 * (mentionsQuery ? 1 : 0);

    const covered = [mentionsPod, mentionsConvert, mentionsValidate, mentionsQuery].filter(Boolean).length;
    const pass = covered >= 3;

    return {
      pass,
      score,
      notes: `${covered}/4 main commands mentioned (pod=${mentionsPod}, convert=${mentionsConvert}, validate=${mentionsValidate}, query=${mentionsQuery})`,
    };
  },
};
