import type { EvalCase } from "../harness.js";

/**
 * Case: nlu-vocabulary
 * NLU test: user asks about the Cascade namespace for lab results.
 * Expected: no tool calls; answer mentions health: namespace or the full URI.
 *
 * Tests vocabulary knowledge baked into the system prompt.
 */
export const nluVocabulary: EvalCase = {
  name: "nlu-vocabulary",
  description: "NLU: vocabulary namespace question — no tool calls expected",

  prompt: "What RDF namespace does Cascade Protocol use for lab results like HbA1c and blood glucose?",

  evaluate(messages, toolCalls) {
    if (toolCalls.length > 0) {
      return {
        pass: false,
        score: 0.1,
        notes: `Made ${toolCalls.length} tool call(s) for a vocabulary question: ${toolCalls.map((tc) => tc.name).join(", ")}`,
      };
    }

    const response = messages[messages.length - 1]?.content ?? "";
    const lower = response.toLowerCase();

    const mentionsHealthNs   = lower.includes("health:") || lower.includes("health/v1");
    const mentionsFullUri    = lower.includes("ns.cascadeprotocol.org/health");
    const mentionsTestName   = lower.includes("testname") || lower.includes("test_name") || lower.includes("health:testname");
    const mentionsLabResult  = lower.includes("labresult") || lower.includes("lab result") || lower.includes("lab-result");

    const score =
      0.4 * (mentionsHealthNs ? 1 : 0) +
      0.3 * (mentionsFullUri ? 1 : 0) +
      0.15 * (mentionsTestName ? 1 : 0) +
      0.15 * (mentionsLabResult ? 1 : 0);

    const pass = mentionsHealthNs || mentionsFullUri;

    return {
      pass,
      score,
      notes: `health_ns=${mentionsHealthNs}, full_uri=${mentionsFullUri}, testName=${mentionsTestName}, labResult=${mentionsLabResult}`,
    };
  },
};
