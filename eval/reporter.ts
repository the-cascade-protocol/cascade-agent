/**
 * Reporter — formats eval results as a human-readable table and optional JSON.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { EvalCase } from "./harness.js";
import type { EvalResult } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RunSummary {
  provider: string;
  model: string;
  timestamp: string;
  passed: number;
  total: number;
  overallScore: number;
  cases: Array<{
    name: string;
    description: string;
    pass: boolean;
    score: number;
    notes: string;
    latencyMs: number;
    toolCallCount: number;
    toolNames: string[];
    error?: string;
  }>;
}

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM  = (s: string) => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;

function bar(score: number, width = 20): string {
  const filled = Math.round(score * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

export function printResults(
  cases: EvalCase[],
  results: EvalResult[],
  provider: string,
  model: string
): RunSummary {
  const passed = results.filter((r) => r.pass).length;
  const total  = results.length;
  const overallScore = results.reduce((s, r) => s + r.score, 0) / total;

  console.log();
  console.log(BOLD(`Cascade Agent Eval — ${provider} / ${model}`));
  console.log(DIM(`${"─".repeat(70)}`));
  console.log(
    DIM("  " + "Case".padEnd(26) + "P/F".padEnd(5) + "Score".padEnd(10) + "Latency".padEnd(10) + "Tools")
  );
  console.log(DIM("  " + "─".repeat(68)));

  const summaryRows: RunSummary["cases"] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const r = results[i];
    const pf      = r.pass ? PASS : FAIL;
    const latency = `${r.latencyMs}ms`;
    const tools   = r.toolCalls.map((tc) => tc.name).join(", ") || DIM("(none)");
    const score   = `${(r.score * 100).toFixed(0)}%`;

    console.log(`  ${c.name.padEnd(26)}${pf}    ${score.padEnd(10)}${latency.padEnd(10)}${tools}`);
    if (!r.pass || r.error) {
      console.log(`  ${" ".repeat(26)}${DIM("→ " + (r.error ?? r.notes))}`);
    }

    summaryRows.push({
      name: c.name,
      description: c.description,
      pass: r.pass,
      score: r.score,
      notes: r.notes,
      latencyMs: r.latencyMs,
      toolCallCount: r.toolCalls.length,
      toolNames: r.toolCalls.map((tc) => tc.name),
      ...(r.error ? { error: r.error } : {}),
    });
  }

  console.log(DIM("  " + "─".repeat(68)));
  const scoreLabel = `${(overallScore * 100).toFixed(1)}%`;
  console.log(`  ${BOLD("Overall")}  ${passed}/${total} passed   ${CYAN(bar(overallScore))} ${scoreLabel}`);
  console.log();

  // Quality bar assessment
  // "Tool cases" = cases where tool calls are expected (excludes no-tool and nlu-* cases)
  const isNluCase = (_: unknown, i: number) =>
    cases[i].name === "no-tool" || cases[i].name.startsWith("nlu-");
  const toolCaseResults = results.filter((_, i) => !isNluCase(_, i));
  const toolAccuracy = toolCaseResults.filter((r) => r.pass).length /
    Math.max(1, toolCaseResults.length);
  const noToolClean  = results.find((_, i) => cases[i].name === "no-tool")?.pass ?? false;
  const chainPass    = results.find((_, i) => cases[i].name === "shell-chain")?.pass ?? false;
  const errorPass    = results.find((_, i) => cases[i].name === "error-recovery")?.pass ?? false;

  console.log(BOLD("  Quality Bar Assessment:"));
  console.log(`  Tool call accuracy          ${toolAccuracy >= 0.8 ? PASS : FAIL}  ${(toolAccuracy * 100).toFixed(0)}% (threshold: 80%)`);
  console.log(`  No spurious tool calls      ${noToolClean ? PASS : FAIL}`);
  console.log(`  Multi-step chain completion ${chainPass ? PASS : FAIL}`);
  console.log(`  Error recovery              ${errorPass ? PASS : FAIL}`);

  const qualityPass = toolAccuracy >= 0.8 && noToolClean && errorPass;
  console.log();
  if (qualityPass) {
    console.log(`  \x1b[32m${BOLD("RESULT: PASS")} — model meets the quality bar for local integration\x1b[0m`);
  } else {
    console.log(`  \x1b[31m${BOLD("RESULT: FAIL")} — see notes above; apply gap-closing mitigations before integrating\x1b[0m`);
  }
  console.log();

  return {
    provider,
    model,
    timestamp: new Date().toISOString(),
    passed,
    total,
    overallScore,
    cases: summaryRows,
  };
}

export function saveResults(summary: RunSummary): string {
  const dir = join(__dirname, "results");
  mkdirSync(dir, { recursive: true });
  const filename = `${summary.provider}-${summary.model.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}.json`;
  const outPath = join(dir, filename);
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  return outPath;
}
