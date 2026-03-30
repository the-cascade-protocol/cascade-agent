import type { EvalCase } from "../harness.js";

/**
 * Case: no-tool
 * A factual question about the Cascade Protocol that should be answered
 * from knowledge — no tool calls needed.
 *
 * Key check: model does NOT call any tools. Spurious tool calls on
 * factual questions are a sign of poor instruction-following.
 */
export const noTool: EvalCase = {
  name: "no-tool",
  description: "Factual Q&A — no tool calls should be made",

  prompt: "What is the Cascade Protocol and what file format does it use for health data storage?",

  evaluate(messages, toolCalls) {
    if (toolCalls.length > 0) {
      return {
        pass: false,
        score: 0,
        notes: `Made ${toolCalls.length} tool call(s) when none were needed: ${toolCalls.map((tc) => tc.name).join(", ")}`,
      };
    }

    const response = messages[messages.length - 1]?.content?.toLowerCase() ?? "";

    // Should mention RDF/Turtle or the protocol
    const mentionsCascade = response.includes("cascade");
    const mentionsFormat  = response.includes("turtle") || response.includes("ttl") ||
                            response.includes("rdf") || response.includes(".ttl");

    const score = (mentionsCascade ? 0.5 : 0) + (mentionsFormat ? 0.5 : 0);
    const pass  = mentionsCascade && mentionsFormat;

    return {
      pass,
      score,
      notes: pass
        ? "Correctly answered without tool use"
        : `Response lacks expected content (cascade=${mentionsCascade}, format=${mentionsFormat})`,
    };
  },
};
