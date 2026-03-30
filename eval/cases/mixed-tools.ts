import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { EvalCase } from "../harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures");

/**
 * Case: mixed-tools
 * Agent must use BOTH shell and read_file in the same turn.
 * Task: list files in the fixtures dir (shell) then read sample.ttl (read_file)
 * and report on both.
 * Checks: at least one shell + one read_file call.
 */
export const mixedTools: EvalCase = {
  name: "mixed-tools",
  description: "Uses shell + read_file in the same turn",

  prompt: `First, use the shell to list the files in the directory ${FIXTURE_DIR}. ` +
    `Then read the file sample.ttl from that directory and tell me ` +
    `how many RDF triples (lines starting with "ex:") it contains.`,

  evaluate(_messages, toolCalls) {
    const hasShell    = toolCalls.some((tc) => tc.name === "shell");
    const hasReadFile = toolCalls.some((tc) => tc.name === "read_file");

    if (!hasShell && !hasReadFile) {
      return { pass: false, score: 0, notes: "No tool calls at all" };
    }
    if (!hasShell) {
      return { pass: false, score: 0.4, notes: "read_file used but shell not called" };
    }
    if (!hasReadFile) {
      return { pass: false, score: 0.4, notes: "shell used but read_file not called" };
    }

    // Both tools used — full pass
    return {
      pass: true,
      score: 1.0,
      notes: `shell=${toolCalls.filter((tc) => tc.name === "shell").length} calls, read_file=${toolCalls.filter((tc) => tc.name === "read_file").length} calls`,
    };
  },
};
