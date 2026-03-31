/**
 * Local provider — runs a GGUF model in-process via node-llama-cpp.
 *
 * node-llama-cpp is listed in optionalDependencies so the rest of the CLI
 * works fine without it. This module is only imported when the user
 * explicitly selects the "local" provider.
 *
 * Model file lives at:  ~/.config/cascade-agent/models/<filename>.gguf
 *
 * Gap-closing measures baked in:
 *  - temperature 0.15 for deterministic tool calls
 *  - maxTokens 2048 to prevent runaway generation
 *  - Qwen3 chat template selected automatically by node-llama-cpp
 *  - Tool params are grammar-constrained by node-llama-cpp's JSON Schema → GBNF
 */

import { homedir } from "os";
import { join, basename } from "path";
import { existsSync, mkdirSync } from "fs";
import chalk from "chalk";
import { tools as builtinTools, executeTool, type ToolInput } from "../tools.js";
import type { CanonicalTool } from "../tools.js";
import type { Provider, SimpleMessage, AgentCallbacks, ProviderName } from "./types.js";
import { getLaunchContext } from "../system-prompt.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const MODELS_DIR = join(homedir(), ".config", "cascade-agent", "models");

/**
 * Available local model variants.
 * Eval results (2026-03-28, C-CDA extraction on Epic MyChart export):
 *   4B Q4_K_M — 98% F1 overall (100% conditions, 95% lab results), ~2.5 GB, ~32s/turn
 *   2B Q4_K_M — 91% F1 overall (100% conditions, 82% lab results), ~1.5 GB, ~13s/turn
 */
export type LocalModelVariant = "4b" | "2b";

export interface LocalModelInfo {
  variant: LocalModelVariant;
  displayName: string;
  repo: string;
  file: string;
  /** Expected on-disk filename after node-llama-cpp downloader (adds hf_<org>_ prefix) */
  filename: string;
  sizeGb: string;
  accuracy: string;
  recommended: boolean;
}

export const LOCAL_MODELS: Record<LocalModelVariant, LocalModelInfo> = {
  "4b": {
    variant: "4b",
    displayName: "Qwen3.5-4B Q4_K_M",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    filename: "hf_unsloth_Qwen3.5-4B-Q4_K_M.gguf",
    sizeGb: "~2.5",
    accuracy: "98%",
    recommended: true,
  },
  "2b": {
    variant: "2b",
    displayName: "Qwen3.5-2B Q4_K_M",
    repo: "unsloth/Qwen3.5-2B-GGUF",
    file: "Qwen3.5-2B-Q4_K_M.gguf",
    filename: "hf_unsloth_Qwen3.5-2B-Q4_K_M.gguf",
    sizeGb: "~1.5",
    accuracy: "91%",
    recommended: false,
  },
};

/** Default model variant — 4B is recommended per eval results. */
export const DEFAULT_LOCAL_MODEL_VARIANT: LocalModelVariant = "4b";

/** Default on-disk filename (used as fallback when no config path is stored). */
export const DEFAULT_LOCAL_MODEL_FILENAME = LOCAL_MODELS["4b"].filename;

/** Kept for backwards compatibility — previously named the 2B model. */
export const DEFAULT_MODEL_REPO = LOCAL_MODELS["4b"].repo;
export const DEFAULT_MODEL_FILE = LOCAL_MODELS["4b"].file;

// ── Module-level cache (one Llama instance + one loaded model + one session) ─

// Using `unknown` here because node-llama-cpp is optional; we cast at use sites.
let _llama: unknown = null;
let _model: unknown = null;
let _modelPath: string | null = null;

// Session-level cache — reused across REPL turns to preserve KV-cache context.
// Avoids re-encoding all prior tokens on every user message.
let _context: unknown = null;
let _session: unknown = null;
let _sessionMsgCount = 0;   // number of history messages loaded into the session

/** True once the model has been loaded into memory at least once this process. */
export function isLocalModelLoaded(): boolean {
  return _model !== null;
}

/**
 * Explicitly dispose the cached Llama + model + session instances.
 * Call before process.exit() to avoid the Metal assertion crash in llama.cpp.
 */
export async function disposeLlamaInstances(): Promise<void> {
  // Dispose session first, then context, then model, then llama
  _session = null;
  _sessionMsgCount = 0;
  if (_context) {
    try { await (_context as { dispose(): Promise<void> }).dispose(); } catch { /* ignore */ }
    _context = null;
  }
  if (_model) {
    try { await (_model as { dispose(): Promise<void> }).dispose(); } catch { /* ignore */ }
    _model = null;
    _modelPath = null;
  }
  if (_llama) {
    try { await (_llama as { dispose(): Promise<void> }).dispose(); } catch { /* ignore */ }
    _llama = null;
  }
}

// ── Tool execution helper ────────────────────────────────────────────────────

async function runTool(
  name: string,
  input: ToolInput,
  customTools: CanonicalTool[]
): Promise<string> {
  const custom = customTools.find((t) => t.name === name);
  if (custom?.run) {
    const result = await custom.run(input);
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  return executeTool(name, input);
}

// ── LocalProvider ────────────────────────────────────────────────────────────

export class LocalProvider implements Provider {
  readonly providerName: ProviderName = "local" as ProviderName;
  readonly model: string;
  readonly modelPath: string;

  constructor(modelPath: string, model: string = DEFAULT_LOCAL_MODEL_FILENAME) {
    this.modelPath = modelPath;
    this.model = model;
  }

  async listModels(): Promise<string[]> {
    // List .gguf files in the models dir
    if (!existsSync(MODELS_DIR)) return [];
    const { readdirSync } = await import("fs");
    return readdirSync(MODELS_DIR)
      .filter((f) => f.endsWith(".gguf"))
      .sort();
  }

  async runTurn(
    messages: SimpleMessage[],
    customTools: CanonicalTool[],
    callbacks: AgentCallbacks
  ): Promise<string> {
    // Dynamically import node-llama-cpp (optional dep)
    let nodeLlamaCpp: typeof import("node-llama-cpp");
    try {
      nodeLlamaCpp = await import("node-llama-cpp");
    } catch {
      throw new Error(
        'node-llama-cpp is not installed.\n' +
        'Run: npm install node-llama-cpp\n' +
        'Then re-run the agent with --provider local.'
      );
    }

    const { getLlama, LlamaChatSession, defineChatSessionFunction } = nodeLlamaCpp;

    // ── Initialize Llama (cached, auto-selects Metal/CUDA/CPU) ───────────────
    if (!_llama) {
      _llama = await getLlama();
    }
    const llama = _llama as Awaited<ReturnType<typeof getLlama>>;

    // ── Load model (cached by path) ──────────────────────────────────────────
    if (!_model || _modelPath !== this.modelPath) {
      if (!existsSync(this.modelPath)) {
        throw new Error(
          `Model file not found: ${this.modelPath}\n` +
          `Run: cascade-agent login --provider local\n` +
          `to download the model.`
        );
      }
      _model = await llama.loadModel({ modelPath: this.modelPath });
      _modelPath = this.modelPath;
    }
    const model = _model as Awaited<ReturnType<typeof llama.loadModel>>;

    // ── Build tool list (custom overrides builtins by name) ──────────────────
    const customNames = new Set(customTools.map((t) => t.name));
    const allTools: CanonicalTool[] = [
      ...customTools,
      ...builtinTools.filter((t) => !customNames.has(t.name)),
    ];

    // ── Create simplified tool descriptions for small-model context ──────────
    // Shorter descriptions reduce prompt length and improve compliance.
    // Also strip the optional `cwd` parameter from the shell tool — the 2B
    // model reliably sets it to invalid paths (e.g. treating a zip filename
    // as a directory). All shell commands should use absolute paths instead.
    const simplifiedTools = allTools.map((t) => {
      const simplified = { ...t, description: simplifyDescription(t.name, t.description) };
      if (t.name === "shell") {
        const { cwd: _cwd, ...restProps } = simplified.input_schema.properties;
        simplified.input_schema = {
          ...simplified.input_schema,
          properties: restProps,
          required: simplified.input_schema.required?.filter((r) => r !== "cwd"),
        };
      }
      return simplified;
    });

    // ── Build functions map for node-llama-cpp ───────────────────────────────
    const functions: Record<string, ReturnType<typeof defineChatSessionFunction>> = {};
    for (const tool of simplifiedTools) {
      const toolRef = tool;
      functions[tool.name] = defineChatSessionFunction({
        description: tool.description,
        params: tool.input_schema as Parameters<typeof defineChatSessionFunction>[0]["params"],
        async handler(params) {
          const input = (params as unknown ?? {}) as ToolInput;
          callbacks.onToolStart(toolRef.name, input);
          const result = await runTool(toolRef.name, input, customTools);
          callbacks.onToolEnd(toolRef.name, result);
          return result;
        },
      });
    }

    // ── Resolve context + session (reuse if history matches) ────────────────
    // Prior conversation: everything except the latest user message.
    const historyMessages = messages.slice(0, -1);
    const lastMsg         = messages[messages.length - 1];

    type LlamaContext = Awaited<ReturnType<typeof model.createContext>>;
    type LlamaSession = InstanceType<typeof LlamaChatSession>;

    let context: LlamaContext;
    let session: LlamaSession;

    if (_session && _context && _sessionMsgCount === historyMessages.length) {
      // Reuse cached session — KV cache already contains all prior tokens
      context = _context as LlamaContext;
      session = _session as LlamaSession;
    } else {
      // First turn or history diverged: create a fresh context + session
      if (_context) {
        try { await (_context as LlamaContext).dispose(); } catch { /* ignore */ }
        _context = null;
        _session = null;
        _sessionMsgCount = 0;
      }
      context = await model.createContext();
      session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: buildLocalSystemPrompt(),
      });
      if (historyMessages.length > 0) {
        session.setChatHistory(buildChatHistory(historyMessages, nodeLlamaCpp));
      }
      _context = context;
      _session = session;
      _sessionMsgCount = historyMessages.length;
    }

    // ── Prompt with the latest user message ──────────────────────────────────
    let finalText = "";

    const promptOptions = {
      functions,
      temperature: 0.15,   // Low temp → more reliable tool call JSON
      maxTokens: 2048,
      // Repetition penalty prevents the degenerate "word word word" looping
      // that small models exhibit when the context grows large.
      repeatPenalty: {
        penalty: 1.3,
        frequencyPenalty: 0.1,
        presencePenalty: 0.05,
        lastTokens: 64,
      },
      onTextChunk(chunk: string) {
        callbacks.onText(chunk);
        finalText += chunk;
      },
    };

    try {
      finalText = await session.prompt(lastMsg.content, promptOptions);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const isContextFull =
        msg.includes("context size") ||
        msg.includes("VRAM") ||
        msg.includes("too large") ||
        msg.includes("context length") ||
        msg.includes("sequence");

      if (!isContextFull) throw err;

      // Context window exhausted — dispose and start fresh, then retry once.
      console.error(
        chalk.yellow(
          "\n  ⚠ Context window full — resetting conversation context. Use /clear to free memory.\n"
        )
      );
      try { await (_context as LlamaContext).dispose(); } catch { /* ignore */ }
      _context = null;
      _session = null;
      _sessionMsgCount = 0;

      const freshContext = await model.createContext();
      const freshSession = new LlamaChatSession({
        contextSequence: freshContext.getSequence(),
        systemPrompt: buildLocalSystemPrompt(),
      });
      _context = freshContext;
      _session = freshSession;
      _sessionMsgCount = 0;

      finalText = await freshSession.prompt(lastMsg.content, {
        ...promptOptions,
        onTextChunk(chunk: string) {
          callbacks.onText(chunk);
          finalText += chunk;
        },
      });
    }

    // Advance the cached message count by 2 (user + assistant)
    _sessionMsgCount += 2;

    return finalText;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Shorter tool descriptions tuned for small models.
 * Full descriptions are designed for large models; 2B models benefit from
 * concise, imperative phrasing.
 */
function simplifyDescription(name: string, original: string): string {
  switch (name) {
    case "shell":
      return "Run a bash command and return its output. Use for all CLI and file-system operations.";
    case "read_file":
      return "Read a file and return its text contents. Use to inspect .ttl, .json, or any text file.";
    default:
      // Truncate to first sentence for unknown tools
      return original.split(". ")[0] + ".";
  }
}

/**
 * System prompt for the local (on-device) provider.
 *
 * Key differences from the cloud prompt:
 *  - No `cascade capabilities` injection (too expensive at startup for 2B model)
 *  - Explicit tool-selection examples (small models need more guidance)
 *  - llms.txt content embedded so the model can answer NLU questions about Cascade
 */
function buildLocalSystemPrompt(): string {
  const launchContext = getLaunchContext();
  const launchSection = launchContext
    ? `\n## Launch Context\n\n${launchContext}\n\nWhen no pod path is specified, use the pod in the Launch Context.\nDo NOT search home directories or guess pod paths.\nAlways tell the user which pod you are querying.\n`
    : "";

  return `You are Cascade Agent, a conversational assistant for the Cascade Protocol health data system.
${launchSection}

## Cascade Protocol

Cascade Protocol is a privacy-first, local-only protocol for structured health data. It serializes clinical and wellness records as RDF/Turtle, bridging clinical standards (FHIR R4, SNOMED CT, LOINC, ICD-10, RxNorm). All operations run locally.

Install: npm install -g @the-cascade-protocol/cli

## CLI Commands (use EXACTLY these forms)

  cascade pod init <path>                          # create a new pod
  cascade pod info <path>                          # summary + record counts (START HERE)
  cascade pod query <path> --conditions --json     # query conditions
  cascade pod query <path> --medications --json    # query medications
  cascade pod query <path> --lab-results --json    # query lab results
  cascade pod query <path> --vital-signs --json    # CORRECT: --vital-signs (not --vitalsigns)
  cascade pod query <path> --immunizations --json  # query immunizations
  cascade pod query <path> --allergies --json      # query allergies
  cascade pod query <path> --procedures --json     # query procedures
  cascade pod query <path> --encounters --json     # query encounters
  cascade pod query <path> --supplements --json    # query supplements
  cascade pod query <path> --social-history --json # query social history
  cascade pod query <path> --all --json            # ALL types — only use when explicitly asked
  cascade convert <file.json> --from fhir --to turtle   # convert FHIR → Turtle (NOT 'pod convert')
  cascade validate <path>                          # validate SHACL shapes

ALWAYS use the full absolute pod path in cascade commands:
  CORRECT: cascade pod query '/full/path/to/pod' --medications --json
  WRONG:   cd '/full/path/to/pod' && cascade pod query . --medications --json

## Query Efficiency

  • ALWAYS start with cascade pod info to see counts before querying records.
  • Use pod info for summaries; use pod query only for record-level data.
  • NEVER use --all as a first step — too large. Query specific types based on the task.
  • After pod info, query only the 1-2 types needed.

## Common Tasks

### Doctor visit preparation
  1. cascade pod info <pod>
  2. cascade pod query <pod> --conditions --json | jq '[.dataTypes.conditions.records[]
       | select(.properties["health:snomedSemanticTag"] == "disorder")
       | {name: .properties["health:conditionName"], onset: .properties["health:onsetDate"]}]'
  3. cascade pod query <pod> --medications --json | jq '[.dataTypes.medications.records[]
       | select(.properties["health:isActive"] == "true")
       | {name: .properties["health:medicationName"], dose: .properties["health:dosage"]}]'
  4. cascade pod query <pod> --lab-results --json | jq '[.dataTypes["lab-results"].records[]
       | {test: .properties["health:testName"], value: .properties["health:resultValue"],
          date: .properties["health:performedDate"]}] | sort_by(.date) | reverse | .[0:15]'
  Then give specific questions to raise with the doctor based on the findings.

### Convert EHR export to a pod
  1. cascade pod init /path/to/new-pod
  2. cascade convert <ehr-file> --from fhir --to turtle
  3. cascade pod info /path/to/new-pod

## Vocabulary Namespaces

  health:   https://ns.cascadeprotocol.org/health/v1#   (lab results, vitals, medications, conditions)
  clinical: https://ns.cascadeprotocol.org/clinical/v1# (EHR records, encounters, social history)
  coverage: https://ns.cascadeprotocol.org/coverage/v1# (insurance, claims)
  core:     https://ns.cascadeprotocol.org/core/v1#     (identity, provenance)

## Key Fields by Type

  LabResult:    health:testName, health:resultValue, health:resultUnit, health:performedDate
  Condition:    health:conditionName, health:snomedSemanticTag, health:onsetDate, health:clinicalStatus
  Medication:   health:medicationName, health:dosage, health:isActive ("true"/"false"), health:startDate
  VitalSign:    health:measurementType, health:value, health:unit, health:measuredAt

## Tools

  shell      — run bash commands (cascade CLI, ls, jq, wc, etc.)
  read_file  — read a file directly (faster than shell + cat for known paths)

Rules:
  • Use read_file for any file whose path you know — do NOT use shell("cat <path>").
  • Use shell for cascade CLI commands, directory listings, jq filters.
  • Do not fabricate results. Use tools to get real data.
  • When a command fails, do NOT retry the same command — diagnose and try differently.
  • Be concise. State the result first.

## CRITICAL jq Rule

Property names contain colons. Colons break jq dot notation. ALWAYS use bracket notation:
  WRONG:   .properties.health:testName          ← ALWAYS fails (jq syntax error)
  CORRECT: .properties["health:testName"]       ← ALWAYS use this form

Every property access must be .properties["namespace:propertyName"] — no exceptions.

If you see an EPIPE error (write EPIPE, Node.js stack trace), the jq filter had a syntax error.
Fix the jq filter, not the cascade command.

## Field Discovery

When a jq filter returns [] or all values are null, the expected fields may not exist in this pod.
ALWAYS run a field-discovery query first, then write filters using only keys that are present:
  cascade pod query <pod> --TYPE --json | jq '.dataTypes.TYPE.records[0].properties | keys'

## Medication Records — RxNorm-Only Pods

C-CDA/EHR-imported pods often have NO health:medicationName and NO health:isActive.
The only identifier is health:rxNormCode (a full URI — extract code: split("/") | last).
To get current medications when health:isActive is absent, deduplicate by most-recent start date:
  cascade pod query <pod> --medications --json | jq '
    [.dataTypes.medications.records[]
     | {rxnorm: (.properties["health:rxNormCode"] | split("/") | last),
        dose: .properties["health:doseQuantity"],
        unit: .properties["health:doseUnit"],
        start: .properties["health:startDate"]}]
    | group_by(.rxnorm) | map(sort_by(.start) | last)
    | sort_by(.start) | reverse'
Use your knowledge of RxNorm codes or drug classes to identify medication types from the codes.

## read_file vs shell

NEVER use shell("cat <path>") or shell("head <path>") to read a file.
Use the read_file tool instead — it is ALWAYS faster and cleaner for reading known file paths.
shell is ONLY for cascade CLI commands, ls, jq filters, wc, etc.

## PHI Note

Records contain patient health data. Summarize findings (counts, trends, key values) rather than
echoing raw records verbatim, unless the user explicitly asks for the raw data.
`;
}

/**
 * Convert SimpleMessage[] to node-llama-cpp ChatHistoryItem[] format.
 * Used to preload prior conversation turns before calling prompt().
 */
function buildChatHistory(
  messages: SimpleMessage[],
  llama: typeof import("node-llama-cpp")
): import("node-llama-cpp").ChatHistoryItem[] {
  const history: import("node-llama-cpp").ChatHistoryItem[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      history.push({ type: "user", text: msg.content });
    } else {
      history.push({ type: "model", response: [msg.content] });
    }
  }
  return history;
}

// ── Model download utility ───────────────────────────────────────────────────

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

/**
 * Download a local Qwen model to MODELS_DIR.
 * Uses node-llama-cpp's built-in createModelDownloader which handles
 * HuggingFace URLs, resumable downloads, and checksum verification.
 *
 * @param variant     "4b" (recommended) or "2b" — defaults to DEFAULT_LOCAL_MODEL_VARIANT
 * @param onProgress  Optional callback for progress updates
 * @returns           Path to the downloaded model file
 */
export async function downloadLocalModel(
  variant: LocalModelVariant = DEFAULT_LOCAL_MODEL_VARIANT,
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  let nodeLlamaCpp: typeof import("node-llama-cpp");
  try {
    nodeLlamaCpp = await import("node-llama-cpp");
  } catch {
    throw new Error("node-llama-cpp is not installed. Run: npm install node-llama-cpp");
  }

  mkdirSync(MODELS_DIR, { recursive: true });

  const info = LOCAL_MODELS[variant];

  // Check for either the downloader-prefixed filename or the plain filename (manual downloads)
  const prefixedPath = join(MODELS_DIR, info.filename);
  const plainPath    = join(MODELS_DIR, info.file);
  if (existsSync(prefixedPath)) return prefixedPath;
  if (existsSync(plainPath))    return plainPath;

  const { createModelDownloader } = nodeLlamaCpp;
  const downloader = await createModelDownloader({
    modelUri: `hf:${info.repo}/${info.file}`,
    dirPath: MODELS_DIR,
    onProgress: onProgress
      ? ({ downloadedSize, totalSize }: { downloadedSize: number; totalSize: number }) => {
          onProgress({
            downloaded: downloadedSize,
            total: totalSize,
            percent: totalSize > 0 ? (downloadedSize / totalSize) * 100 : 0,
          });
        }
      : undefined,
  });

  await downloader.download();
  // entrypointFilename contains the actual on-disk name (includes hf_<org>_ prefix)
  const fileName = (downloader as unknown as { entrypointFilename?: string }).entrypointFilename ?? info.filename;
  return join(MODELS_DIR, fileName);
}

/** @deprecated Use downloadLocalModel("4b") instead. Kept for backwards compatibility. */
export function downloadDefaultModel(
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  return downloadLocalModel(DEFAULT_LOCAL_MODEL_VARIANT, onProgress);
}
