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
import { tools as builtinTools, executeTool, type ToolInput } from "../tools.js";
import type { CanonicalTool } from "../tools.js";
import type { Provider, SimpleMessage, AgentCallbacks, ProviderName } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const MODELS_DIR = join(homedir(), ".config", "cascade-agent", "models");

/** Default model: Qwen3.5-2B Q4_K_M — best balance of size, speed, tool-call quality.
 *  Sourced from unsloth's public mirror of Qwen/Qwen3.5-2B (the instruct/chat variant).
 *  node-llama-cpp prefixes HuggingFace downloads with hf_<org>_ so the actual filename
 *  on disk is "hf_unsloth_Qwen3.5-2B-Q4_K_M.gguf". */
export const DEFAULT_LOCAL_MODEL_FILENAME = "hf_unsloth_Qwen3.5-2B-Q4_K_M.gguf";

/** Hugging Face repo + file for the default model (public, no auth required) */
export const DEFAULT_MODEL_REPO = "unsloth/Qwen3.5-2B-GGUF";
export const DEFAULT_MODEL_FILE = "Qwen3.5-2B-Q4_K_M.gguf";

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
    const simplifiedTools = allTools.map((t) => ({
      ...t,
      description: simplifyDescription(t.name, t.description),
    }));

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

    finalText = await session.prompt(lastMsg.content, {
      functions,
      temperature: 0.15,   // Low temp → more reliable tool call JSON
      maxTokens: 2048,
      onTextChunk(chunk: string) {
        callbacks.onText(chunk);
        finalText += chunk;
      },
    });

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
  return `You are Cascade Agent, a conversational assistant for the Cascade Protocol health data system.

## Cascade Protocol

Cascade Protocol is a privacy-first, local-only protocol for structured health data. It serializes clinical and wellness records as RDF/Turtle with SHACL validation, bridging clinical standards (FHIR R4, SNOMED CT, LOINC, ICD-10, RxNorm) to machine-readable knowledge graphs. All operations run locally with zero network calls.

Install: npm install -g @the-cascade-protocol/cli

CLI Command Structure (IMPORTANT — use these exact forms):
  cascade pod init <path>                                          # create a pod
  cascade pod info <path>                                          # view pod summary
  cascade pod query <path> --conditions --json                     # query conditions
  cascade pod query <path> --medications --json                    # query medications
  cascade pod query <path> --lab-results --json                    # query lab results
  cascade pod query <path> --medications --lab-results --json      # query multiple types
  cascade convert <file.json> --from fhir --to turtle              # convert FHIR → Turtle
  cascade validate <path>                                          # validate SHACL shapes

NOTE: "pod query" is a two-word subcommand. The format is ALWAYS:
  cascade pod query <pod-path> --<type-flag> [--json]
NOT: cascade <pod-path> (wrong)
NOT: cascade query <pod-path> (wrong)

Supported data types:
  Clinical: Medication, Condition, Allergy, LabResult, VitalSign, Immunization,
    Encounter, MedicationAdministration, ImplantedDevice, ImagingStudy, ClaimRecord, BenefitStatement
  Wellness: HeartRate, BloodPressure, Activity, Sleep, Supplements

Vocabulary namespaces:
  health:   https://ns.cascadeprotocol.org/health/v1#   (wellness metrics, lab results, vitals)
  clinical: https://ns.cascadeprotocol.org/clinical/v1# (EHR records: conditions, medications, encounters)
  coverage: https://ns.cascadeprotocol.org/coverage/v1# (insurance: claims, benefits)
  core:     https://ns.cascadeprotocol.org/core/v1#     (identity, provenance)

Key vocabulary fields by data type:
  LabResult:   health:testName, health:resultValue, health:resultUnit, health:referenceRange,
               health:performedDate, health:loincCode
  Condition:   clinical:conditionName, clinical:snomedCode, health:snomedSemanticTag,
               clinical:onsetDate, clinical:clinicalStatus ("active" | "resolved")
  Medication:  health:medicationName, health:rxNormCode, health:dosage, health:isActive ("true"/"false"),
               health:startDate
  VitalSign:   health:measurementType, health:value, health:unit, health:measuredAt
  HeartRate:   health:bpm, health:measuredAt
  BloodPressure: health:systolic, health:diastolic, health:measuredAt
  Activity:    health:activityType, health:duration, health:calories, health:startTime
  Sleep:       health:sleepDuration, health:sleepQuality, health:startTime

Pod query JSON shape: { dataTypes: { [type]: { count, records: [{id, type, properties}] } } }

## Tools

You have exactly two tools:

  shell      — run any bash command (cascade CLI, directory listing, jq filters, etc.)
  read_file  — read the text contents of a specific file (.ttl, .json, logs, etc.)

Tool selection rules — follow these exactly:
  • read_file: use this to read any file whose path you know. It is faster and cleaner than shell + cat.
    NEVER use shell("cat <path>") or shell("head <path>") to read a file. Use read_file instead.
  • shell: use this for cascade CLI commands, listing directories (ls), running jq, counting lines (wc), etc.
  • When a task requires BOTH reading a file AND running a command, call BOTH tools (one shell call AND one read_file call).

Example — if asked "list the files in /tmp and then read /tmp/data.ttl":
  Step 1: call shell with command "ls /tmp"
  Step 2: call read_file with path "/tmp/data.ttl"
  Do NOT call shell("cat /tmp/data.ttl") for step 2.

## Behaviour Rules

1. Use tools to complete tasks — do not fabricate results or pretend to run commands.
2. For Cascade CLI operations use the cascade CLI (cascade pod query, cascade convert, etc.).
3. When a tool returns an error, report it clearly. Do not retry the same command.
4. For factual questions about the Cascade Protocol (vocabulary, format, commands) answer
   from knowledge — do not call tools to answer conceptual questions.
5. Be concise. State the result first, then explain if needed.

## Pod Query Tips

  • Always pipe --json output to jq — raw output is very large.
  • Use bracket notation ["key"] in jq for colon-prefixed field names.
  • Conditions: filter .properties["health:snomedSemanticTag"] == "disorder" for clinical conditions.
  • Medications: field is health:medicationName; health:isActive is "true"/"false" (string).
  • Labs: health:testName, health:resultValue, health:resultUnit, health:performedDate.
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
 * Download the default Qwen3.5-2B model to MODELS_DIR.
 * Uses node-llama-cpp's built-in createModelDownloader which handles
 * HuggingFace URLs, resumable downloads, and checksum verification.
 *
 * @param onProgress  Optional callback for progress updates
 * @returns           Path to the downloaded model file
 */
export async function downloadDefaultModel(
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  let nodeLlamaCpp: typeof import("node-llama-cpp");
  try {
    nodeLlamaCpp = await import("node-llama-cpp");
  } catch {
    throw new Error("node-llama-cpp is not installed. Run: npm install node-llama-cpp");
  }

  mkdirSync(MODELS_DIR, { recursive: true });

  const destPath = join(MODELS_DIR, DEFAULT_LOCAL_MODEL_FILENAME);
  if (existsSync(destPath)) {
    return destPath;
  }

  const { createModelDownloader } = nodeLlamaCpp;
  const downloader = await createModelDownloader({
    modelUri: `hf:${DEFAULT_MODEL_REPO}/${DEFAULT_MODEL_FILE}`,
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
  // Use entrypointFilename which contains the actual on-disk name (includes hf_<org>_ prefix)
  const fileName = (downloader as unknown as { entrypointFilename?: string }).entrypointFilename ?? DEFAULT_LOCAL_MODEL_FILENAME;
  return join(MODELS_DIR, fileName);
}
