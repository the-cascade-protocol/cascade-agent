import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { EvalCase } from "../harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "fixtures", "sample.ttl");

/**
 * Case: read-file
 * Agent must use read_file to inspect a .ttl fixture and answer a question
 * about its contents.
 * Checks: read_file called with correct path, answer mentions "Hypertension".
 */
export const readFile: EvalCase = {
  name: "read-file",
  description: "Read a .ttl fixture and answer a question about its contents",

  prompt: `Read the file at ${FIXTURE} and tell me what health conditions are listed in it.`,

  evaluate(messages, toolCalls) {
    const rfCall = toolCalls.find((tc) => tc.name === "read_file");

    if (!rfCall) {
      return { pass: false, score: 0, notes: "read_file not called" };
    }

    const path = rfCall.input.path as string | undefined;
    if (!path) {
      return { pass: false, score: 0.3, notes: "read_file called but path field missing" };
    }

    // Check the file was actually read (result contains TTL content)
    if (!rfCall.result || rfCall.result.startsWith("Error")) {
      return { pass: false, score: 0.5, notes: `read_file error: ${rfCall.result?.slice(0, 100)}` };
    }

    // Check the final response mentions the conditions from the file
    const lastMsg = messages[messages.length - 1];
    const response = lastMsg.role === "assistant" ? lastMsg.content.toLowerCase() : "";
    const mentionsHypertension = response.includes("hypertension");
    const mentionsDiabetes = response.includes("diabetes") || response.includes("type 2");

    if (!mentionsHypertension && !mentionsDiabetes) {
      return { pass: false, score: 0.7, notes: "File read but response doesn't mention conditions from file" };
    }

    const score = (mentionsHypertension ? 0.5 : 0) + (mentionsDiabetes ? 0.5 : 0);
    return {
      pass: mentionsHypertension || mentionsDiabetes,
      score,
      notes: `hypertension=${mentionsHypertension}, diabetes=${mentionsDiabetes}`,
    };
  },
};
