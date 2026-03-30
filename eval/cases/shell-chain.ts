import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { EvalCase } from "../harness.js";

const TEST_DIR = join(tmpdir(), "cascade-eval-chain");

/**
 * Case: shell-chain
 * Multi-step shell sequence: create dir → write file → count lines.
 * Checks: ≥ 2 shell calls, each logical step attempted.
 * Dir is pre-cleaned before the test and removed after scoring.
 */
export const shellChain: EvalCase = {
  name: "shell-chain",
  description: "Create dir → write file → count lines (3-step chain)",

  prompt: `Do the following steps in order using shell commands:
1. Create a directory at ${TEST_DIR}
2. Write the text "hello\nworld\ncascade" into a file called test.txt inside that directory
3. Count the number of lines in that file and tell me the result.`,

  evaluate(_messages, toolCalls) {
    const shellCalls = toolCalls.filter((tc) => tc.name === "shell");

    // Clean up regardless
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

    if (shellCalls.length === 0) {
      return { pass: false, score: 0, notes: "No shell tool calls made" };
    }

    const allCmds = shellCalls.map((tc) => tc.input.command as string ?? "").join(" ");

    // Check each required step is represented
    const madeDir  = allCmds.includes("mkdir") || allCmds.includes(TEST_DIR);
    const wroteFile = allCmds.includes("echo") || allCmds.includes("printf") || allCmds.includes("cat") || allCmds.includes("test.txt");
    const counted  = allCmds.includes("wc") || allCmds.includes("count") || allCmds.includes("lines");

    const steps = [madeDir, wroteFile, counted].filter(Boolean).length;
    const score = steps / 3;

    if (steps < 2) {
      return { pass: false, score, notes: `Only ${steps}/3 steps attempted (mkdir=${madeDir}, write=${wroteFile}, count=${counted})` };
    }

    // Full pass: all 3 steps + at least 2 shell calls
    if (steps === 3 && shellCalls.length >= 2) {
      return { pass: true, score: 1.0, notes: `${shellCalls.length} shell calls, all 3 steps completed` };
    }

    return { pass: false, score, notes: `${steps}/3 steps (mkdir=${madeDir}, write=${wroteFile}, count=${counted}), ${shellCalls.length} calls` };
  },
};
