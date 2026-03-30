#!/usr/bin/env node
/**
 * Cascade Agent Eval Runner
 *
 * Usage:
 *   npx tsx eval/runner.ts [options]
 *
 * Options:
 *   --provider <name>    anthropic | openai | google | ollama | local  (default: anthropic)
 *   --model    <name>    override the default model for that provider
 *   --filter   <name>    run only the named case(s), comma-separated
 *   --json               save results to eval/results/<timestamp>.json
 *   --list               list available test cases and exit
 *   --subprocess         force subprocess-per-case isolation (default for local)
 *
 * Internal flags (used by child processes — do not use directly):
 *   --single-case        emit one JSON result line to stdout and exit
 */
import { parseArgs } from "util";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { loadConfig } from "../src/config.js";
import { createProvider } from "../src/providers/index.js";
import type { ProviderName } from "../src/providers/types.js";
import { runCase } from "./harness.js";
import type { EvalResult } from "./harness.js";
import { printResults, saveResults } from "./reporter.js";

// ── Import all cases ────────────────────────────────────────────────────────
import { shellSingle }    from "./cases/shell-single.js";
import { shellChain }     from "./cases/shell-chain.js";
import { readFile }       from "./cases/read-file.js";
import { mixedTools }     from "./cases/mixed-tools.js";
import { podQuery }       from "./cases/pod-query.js";
import { noTool }         from "./cases/no-tool.js";
import { errorRecovery }  from "./cases/error-recovery.js";
import { nluConversion }  from "./cases/nlu-conversion.js";
import { nluVocabulary }  from "./cases/nlu-vocabulary.js";
import { nluCliHelp }     from "./cases/nlu-cli-help.js";

const ALL_CASES = [
  // Tool-calling correctness
  shellSingle,
  shellChain,
  readFile,
  mixedTools,
  podQuery,
  errorRecovery,
  // NLU — knowledge & language understanding without tool use
  noTool,
  nluConversion,
  nluVocabulary,
  nluCliHelp,
];

// ── Parse CLI args ──────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    provider:     { type: "string",  default: "anthropic" },
    model:        { type: "string" },
    filter:       { type: "string" },
    json:         { type: "boolean", default: false },
    list:         { type: "boolean", default: false },
    subprocess:   { type: "boolean", default: false },
    "single-case":{ type: "boolean", default: false },
  },
  strict: false,
});

if (values.list) {
  console.log("\nAvailable eval cases:\n");
  for (const c of ALL_CASES) {
    console.log(`  ${c.name.padEnd(24)} ${c.description}`);
  }
  console.log();
  process.exit(0);
}

const providerName  = (values.provider ?? "anthropic") as ProviderName;
const modelOverride = values.model as string | undefined;
const singleCase    = values["single-case"] as boolean;

// Filter cases if --filter specified
const filters = values.filter
  ? (values.filter as string).split(",").map((s) => s.trim().toLowerCase())
  : null;

const cases = filters
  ? ALL_CASES.filter((c) => filters.includes(c.name.toLowerCase()))
  : ALL_CASES;

if (cases.length === 0) {
  console.error(`No cases matched filter: ${values.filter}`);
  process.exit(1);
}

// ── Build provider ──────────────────────────────────────────────────────────
const config  = loadConfig();
const provider = createProvider(config, providerName, modelOverride);

// ── Single-case mode (child process) ────────────────────────────────────────
// Invoked by the parent subprocess loop. Runs exactly one case, emits JSON to
// stdout, and exits cleanly — disposing Metal resources before exit so the
// child's llama.cpp doesn't crash on the assertion: [rsets->data count] == 0.
if (singleCase) {
  if (cases.length !== 1) {
    process.stderr.write(`--single-case requires exactly one case via --filter\n`);
    process.exit(1);
  }

  // Redirect all console.log to stderr so stdout is clean JSON
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

  const evalCase = cases[0];
  process.stderr.write(`  [child] running ${evalCase.name} …\n`);

  const result: EvalResult = await runCase(evalCase, provider);

  // Dispose llama before writing JSON — disposal can emit stderr noise but
  // must complete before the process exits.
  if (provider.providerName === "local") {
    try {
      const { disposeLlamaInstances } = await import("../src/providers/local.js");
      await disposeLlamaInstances();
    } catch { /* best-effort */ }
  }

  // Single JSON line to stdout — parent parses this
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = 0;

  // Restore console.log (not strictly needed but good practice)
  console.log = origLog;
  process.exit(0);
}

// ── Decide whether to use subprocess isolation ───────────────────────────────
// Always isolate local provider to avoid Metal GPU memory exhaustion across
// consecutive inferences. Can be forced for any provider with --subprocess.
const useSubprocess = (values.subprocess as boolean) || providerName === "local";

console.log(`\nRunning ${cases.length} case(s) against ${provider.providerName} / ${provider.model}${useSubprocess ? " [subprocess mode]" : ""} …\n`);

// ── Subprocess runner ────────────────────────────────────────────────────────
async function runCaseSubprocess(caseName: string): Promise<EvalResult> {
  return new Promise((resolve) => {
    const scriptPath = fileURLToPath(import.meta.url);
    const args = [
      "tsx",
      scriptPath,
      "--provider",   providerName,
      "--filter",     caseName,
      "--single-case",
    ];
    if (modelOverride)  { args.push("--model", modelOverride); }

    const child = spawn("npx", args, {
      stdio: ["ignore", "pipe", "inherit"],  // capture stdout, pass stderr through
      env: process.env,
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on("close", (code) => {
      // Parse the last non-empty line as JSON
      const lines = stdout.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? "";
      try {
        resolve(JSON.parse(lastLine) as EvalResult);
      } catch {
        // Child crashed or emitted unexpected output
        resolve({
          pass: false,
          score: 0,
          notes: `Child process exited with code ${code}; failed to parse result`,
          toolCalls: [],
          response: "",
          latencyMs: 0,
          error: `exit code ${code} — stdout: ${stdout.slice(0, 200)}`,
        });
      }
    });

    child.on("error", (err) => {
      resolve({
        pass: false,
        score: 0,
        notes: "Failed to spawn child process",
        toolCalls: [],
        response: "",
        latencyMs: 0,
        error: err.message,
      });
    });
  });
}

// Delay between subprocess spawns (local only) to let Metal release GPU memory.
const SPAWN_DELAY_MS = providerName === "local" ? 2000 : 0;

// ── Run cases sequentially ───────────────────────────────────────────────────
const results: EvalResult[] = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  process.stdout.write(`  Running ${c.name} … `);
  let result: EvalResult;

  if (useSubprocess) {
    // Add delay between spawns (not before the first one)
    if (i > 0 && SPAWN_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, SPAWN_DELAY_MS));
    }
    result = await runCaseSubprocess(c.name);
    // Retry once on Metal crash (exit 139 / exit 134) — GPU memory may need
    // an extra moment to drain after the previous process.
    if (result.error?.startsWith("exit code 13") && result.latencyMs === 0) {
      process.stdout.write(`(retry after crash) `);
      await new Promise((r) => setTimeout(r, SPAWN_DELAY_MS));
      result = await runCaseSubprocess(c.name);
    }
  } else {
    result = await runCase(c, provider);
  }

  const status = result.pass ? "pass" : "fail";
  process.stdout.write(`${status} (${result.latencyMs}ms)\n`);
  results.push(result);
}

// ── Report ──────────────────────────────────────────────────────────────────
const summary = printResults(cases, results, provider.providerName, provider.model);

if (values.json) {
  const path = saveResults(summary);
  console.log(`  Results saved to: ${path}\n`);
}

// Dispose local provider resources in in-process mode (non-subprocess)
if (!useSubprocess && provider.providerName === "local") {
  try {
    const { disposeLlamaInstances } = await import("../src/providers/local.js");
    await disposeLlamaInstances();
  } catch { /* ignore — disposal is best-effort */ }
}

process.exitCode = summary.passed === summary.total ? 0 : 1;
