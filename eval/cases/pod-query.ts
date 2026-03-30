import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { EvalCase } from "../harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "fixtures", "sample.ttl");

/**
 * Case: pod-query
 * Simulates the most common cascade-agent task: querying a pod with the CLI.
 * We can't assume a real pod exists, so we test that the agent correctly
 * formulates a `cascade pod query` command (even if it fails at runtime).
 *
 * Scoring:
 *  - Uses shell tool: required
 *  - Command contains "cascade" and "pod" and "query": required
 *  - Command includes a pod path or file argument: bonus
 *  - Command includes a type flag (--conditions, --medications, etc.): bonus
 */
export const podQuery: EvalCase = {
  name: "pod-query",
  description: "Formulates a cascade pod query shell command for conditions",

  prompt: `I have a Cascade health data pod at ~/my-health-pod. ` +
    `Use the Cascade CLI to query it for all conditions and show me the results. ` +
    `If the pod doesn't exist yet, tell me what command you would have run.`,

  evaluate(_messages, toolCalls) {
    const shellCalls = toolCalls.filter((tc) => tc.name === "shell");

    if (shellCalls.length === 0) {
      // Agent may have just described the command without running it — partial credit
      const lastContent = _messages[_messages.length - 1]?.content ?? "";
      const describedCmd = lastContent.includes("cascade") && lastContent.includes("query");
      if (describedCmd) {
        return { pass: false, score: 0.4, notes: "Described command but didn't call shell tool" };
      }
      return { pass: false, score: 0, notes: "No shell call and no command description" };
    }

    const allCmds = shellCalls.map((tc) => tc.input.command as string ?? "").join(" ");
    const hasCascade   = allCmds.includes("cascade");
    const hasPodQuery  = allCmds.includes("pod") && (allCmds.includes("query") || allCmds.includes("conditions"));
    const hasTypeFlag  = /--conditions|--medications|--all/.test(allCmds);
    const hasPodPath   = allCmds.includes("my-health-pod") || allCmds.includes("~/");

    if (!hasCascade) {
      return { pass: false, score: 0.3, notes: "Shell called but no cascade command" };
    }

    const score =
      0.4 * (hasCascade ? 1 : 0) +
      0.3 * (hasPodQuery ? 1 : 0) +
      0.15 * (hasTypeFlag ? 1 : 0) +
      0.15 * (hasPodPath ? 1 : 0);

    const pass = hasCascade && hasPodQuery;
    return {
      pass,
      score,
      notes: `cascade=${hasCascade}, pod+query=${hasPodQuery}, typeFlag=${hasTypeFlag}, podPath=${hasPodPath}`,
    };
  },
};
