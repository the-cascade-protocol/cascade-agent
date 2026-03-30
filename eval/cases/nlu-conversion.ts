import type { EvalCase } from "../harness.js";

/**
 * Case: nlu-conversion
 * NLU test: user asks how to convert a FHIR file.
 * Expected: no tool calls; answer includes "cascade convert" and "fhir".
 *
 * Tests whether the model can answer a "how do I…" question from protocol
 * knowledge without reaching for a tool.
 */
export const nluConversion: EvalCase = {
  name: "nlu-conversion",
  description: "NLU: how to convert FHIR to Cascade — no tool calls expected",

  prompt: "What is the cascade CLI command syntax for converting a FHIR R4 JSON file to Cascade Turtle format? I just want to know the command — don't run anything.",

  evaluate(messages, toolCalls) {
    if (toolCalls.length > 0) {
      return {
        pass: false,
        score: 0.1,
        notes: `Made ${toolCalls.length} tool call(s) for a conceptual question: ${toolCalls.map((tc) => tc.name).join(", ")}`,
      };
    }

    const response = messages[messages.length - 1]?.content?.toLowerCase() ?? "";

    const mentionsConvert   = response.includes("cascade convert") || response.includes("convert");
    const mentionsFhir      = response.includes("fhir") || response.includes("--from fhir");
    const mentionsTurtle    = response.includes("turtle") || response.includes(".ttl") || response.includes("--to turtle");
    const mentionsFilename  = response.includes("patient-bundle") || response.includes("patient-bundle.json");

    const score =
      0.3 * (mentionsConvert ? 1 : 0) +
      0.3 * (mentionsFhir ? 1 : 0) +
      0.2 * (mentionsTurtle ? 1 : 0) +
      0.2 * (mentionsFilename ? 1 : 0);

    const pass = mentionsConvert && mentionsFhir;

    return {
      pass,
      score,
      notes: `convert=${mentionsConvert}, fhir=${mentionsFhir}, turtle=${mentionsTurtle}, filename=${mentionsFilename}`,
    };
  },
};
