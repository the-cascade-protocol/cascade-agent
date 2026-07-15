/**
 * Local provider — the on-device conversational REPL, backed by a **llama-server**
 * (llama.cpp) the provider spawns or attaches to, spoken to over the OpenAI-compat
 * chat/completions API.
 *
 * As of the 2026-07-03 local-inference consolidation (Slice B) this is NOT an
 * in-process node-llama-cpp stack. Rationale, measured on this machine's Qwen3.5-4B:
 *  - node-llama-cpp 3.18.1's bundled llama.cpp could not compile its Metal shaders
 *    here ("tensor API is not supported") and fell back to CPU;
 *  - a 15-case REPL tool-calling bake-off scored llama-server `--jinja` (Qwen's
 *    native tool template) at 100% vs the node-llama-cpp JSON-schema→GBNF loop far
 *    lower (right tool, wrong command). The port is a quality WIN, not a regression.
 *
 * The server is resolved by the shared {@link LlamaServerManager}: `CASCADE_LLAMA_URL`
 * attaches to an existing server, otherwise a managed `llama-server` is spawned from
 * the local GGUF (one model load, reused across REPL turns).
 *
 * Model file lives at:  ~/.config/cascade-agent/models/<filename>.gguf
 *
 * Gap-closing measures baked in:
 *  - temperature 0.15 for deterministic tool calls
 *  - maxTokens 2048 to prevent runaway generation
 *  - chat_template_kwargs.enable_thinking=false (Qwen empty-`content` gotcha)
 *  - simplified tool descriptions + the shell `cwd` param stripped for the small model
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, createWriteStream } from "fs";
import { rename, unlink } from "fs/promises";
import { Readable, PassThrough } from "stream";
import { pipeline } from "stream/promises";
import OpenAI from "openai";
import { tools as builtinTools, executeTool, type ToolInput } from "../tools.js";
import type { CanonicalTool } from "../tools.js";
import type { Provider, SimpleMessage, AgentCallbacks, ProviderName } from "./types.js";
import { getLaunchContext } from "../system-prompt.js";
import { LlamaServerManager } from "../services/llama-server.js";

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
  /** On-disk filename the downloader writes (hf_<org>_ prefix, the historical layout) */
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

// ── Shared local llama-server (one per process, reused across REPL turns) ──────

let _serverManager: LlamaServerManager | null = null;
let _serverReady = false;

function localServer(modelPath: string): LlamaServerManager {
  if (!_serverManager) _serverManager = new LlamaServerManager({ modelPath });
  return _serverManager;
}

/** True once the local llama-server is up this process (drives the REPL "Loading model…" hint). */
export function isLocalModelLoaded(): boolean {
  return _serverReady;
}

/**
 * Tear down the managed local llama-server (SIGKILL; llama-server ignores SIGTERM).
 * Safe to call at process exit. Kept for API compatibility with the old in-process
 * dispose; the manager also SIGKILLs its child on process exit as a backstop.
 */
export async function disposeLlamaInstances(): Promise<void> {
  _serverManager?.shutdown();
  _serverManager = null;
  _serverReady = false;
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

/** Canonical tool definitions → OpenAI function-calling format. */
function toOpenAITools(allTools: CanonicalTool[]): OpenAI.ChatCompletionTool[] {
  return allTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as unknown as Record<string, unknown>,
    },
  }));
}

// ── LocalProvider ────────────────────────────────────────────────────────────

export class LocalProvider implements Provider {
  readonly providerName: ProviderName = "local" as ProviderName;
  readonly model: string;
  readonly modelPath: string;
  private readonly server: LlamaServerManager;

  constructor(modelPath: string, model: string = DEFAULT_LOCAL_MODEL_FILENAME) {
    this.modelPath = modelPath;
    this.model = model;
    this.server = localServer(modelPath);
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
    // Bring up (attach or managed-spawn) the shared local llama-server.
    const base = await this.server.ensureRunning();
    _serverReady = await this.server.health();
    if (!_serverReady) {
      throw new Error(
        "Local llama-server is not ready.\n" +
        "Ensure `llama-server` is on PATH (or set CASCADE_LLAMA_SERVER_BIN), or set\n" +
        "CASCADE_LLAMA_URL to attach to a running server, and that a model is downloaded\n" +
        "(cascade-agent login --provider local)."
      );
    }

    // llama-server speaks the OpenAI chat/completions API.
    const client = new OpenAI({ baseURL: `${base}/v1`, apiKey: "sk-local-no-key" });

    // ── Build tool list (custom overrides builtins by name) ──────────────────
    const customNames = new Set(customTools.map((t) => t.name));
    const allTools: CanonicalTool[] = [
      ...customTools,
      ...builtinTools.filter((t) => !customNames.has(t.name)),
    ];

    // Simplified descriptions + strip the shell `cwd` param: the small model
    // reliably sets cwd to invalid paths (e.g. a zip filename), so all shell
    // commands should use absolute paths instead. This tool shape scored 100%
    // in the tool-calling bake-off that gated this port.
    const simplifiedTools = allTools.map((t) => {
      const simplified: CanonicalTool = { ...t, description: simplifyDescription(t.name, t.description) };
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
    const openAITools = toOpenAITools(simplifiedTools);

    // ── Build the OpenAI message list for this turn ──────────────────────────
    const history: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: buildLocalSystemPrompt() },
      ...messages.map((m): OpenAI.ChatCompletionMessageParam => ({ role: m.role, content: m.content })),
    ];

    let finalText = "";
    const MAX_TOOL_ITERATIONS = 20;
    let iterations = 0;

    while (true) {
      if (++iterations > MAX_TOOL_ITERATIONS) {
        finalText += "\n\n[Agent halted: exceeded maximum tool-call iterations. Please rephrase your request or break it into smaller steps.]";
        break;
      }

      const pending: Record<number, { id: string; name: string; arguments: string }> = {};
      let textChunk = "";
      let finishReason: string | null = null;

      const stream = await client.chat.completions.create(
        chatBody(this.model, history, openAITools, true)
      );

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;

        if (delta.content) {
          callbacks.onText(delta.content);
          textChunk += delta.content;
          finalText += delta.content;
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index === undefined || !tc.function) continue;
            const i = tc.index;
            if (!pending[i]) pending[i] = { id: "", name: "", arguments: "" };
            if (tc.id) pending[i].id = tc.id;
            if (tc.function.name) pending[i].name += tc.function.name;
            if (tc.function.arguments) pending[i].arguments += tc.function.arguments;
          }
        }
      }

      let calls = Object.values(pending);

      // If a turn streamed nothing (some templates leave `content` empty when the
      // reply routes through reasoning), retry once non-streaming for this turn.
      if (finishReason !== "tool_calls" && textChunk === "" && calls.length === 0) {
        const fallback = await client.chat.completions.create(
          chatBody(this.model, history, openAITools, false)
        );
        const msg = fallback.choices[0]?.message;
        if (msg?.content) {
          callbacks.onText(msg.content);
          finalText += msg.content;
        }
        if (fallback.choices[0]?.finish_reason === "tool_calls" && msg?.tool_calls) {
          calls = msg.tool_calls
            .map((tc) => tc as unknown as { id: string; function?: { name: string; arguments: string } })
            .filter((t) => t.function?.name)
            .map((t) => ({ id: t.id, name: t.function!.name, arguments: t.function!.arguments ?? "" }));
        }
        if (calls.length === 0) break;
      }

      if (finishReason !== "tool_calls" || calls.length === 0) break;

      // Append the assistant message carrying the tool_calls.
      history.push({
        role: "assistant",
        content: textChunk || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      // Execute each tool call and append its result.
      for (const c of calls) {
        let input: ToolInput;
        try { input = JSON.parse(c.arguments) as ToolInput; } catch { input = {}; }
        callbacks.onToolStart(c.name, input);
        const result = await runTool(c.name, input, customTools);
        callbacks.onToolEnd(c.name, result);
        history.push({ role: "tool", tool_call_id: c.id, content: result });
      }
    }

    return finalText;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a chat/completions request body for the local model. Carries the small-model
 * sampling (temp 0.15 + light repetition penalties) and, crucially,
 * `chat_template_kwargs.enable_thinking=false` — Qwen 3.x reasoning GGUFs route their
 * thinking into `reasoning_content` and leave `content` EMPTY unless thinking is off.
 * That llama.cpp extension is not in the OpenAI SDK types, so the body is cast; the
 * SDK forwards unknown fields verbatim.
 */
function chatBody(
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[],
  stream: true,
): OpenAI.ChatCompletionCreateParamsStreaming;
function chatBody(
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[],
  stream: false,
): OpenAI.ChatCompletionCreateParamsNonStreaming;
function chatBody(
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[],
  stream: boolean,
): OpenAI.ChatCompletionCreateParams {
  return {
    model,
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.15,
    max_tokens: 2048,
    frequency_penalty: 0.1,
    presence_penalty: 0.05,
    stream,
    chat_template_kwargs: { enable_thinking: false },
  } as unknown as OpenAI.ChatCompletionCreateParams;
}

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
  workbench: https://ns.cascadeprotocol.org/workbench/v1# (v1-draft: Workbench notes/ substrate, record overlays, filing labels)
  evidence:  https://ns.cascadeprotocol.org/evidence/v1#  (v1-draft: assertion grounding facets: direction/basis/strength/settled)

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

// ── Model download utility ───────────────────────────────────────────────────

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

/** Resolve the HuggingFace download URL for a model variant's GGUF. */
export function modelDownloadUrl(info: LocalModelInfo): string {
  return `https://huggingface.co/${info.repo}/resolve/main/${encodeURIComponent(info.file)}`;
}

/**
 * Download a local Qwen model to MODELS_DIR with a plain streaming fetch.
 *
 * Replaces node-llama-cpp's createModelDownloader (removed in the 2026-07-03
 * consolidation, Slice C): streams the GGUF from HuggingFace to a `.part` file,
 * reports progress, and atomically renames into place on success (so a partial
 * download is never mistaken for a complete model). No native dependency, so the
 * published npm package installs clean without a build step.
 *
 * @param variant     "4b" (recommended) or "2b" — defaults to DEFAULT_LOCAL_MODEL_VARIANT
 * @param onProgress  Optional callback for progress updates
 * @returns           Path to the downloaded model file
 */
export async function downloadLocalModel(
  variant: LocalModelVariant = DEFAULT_LOCAL_MODEL_VARIANT,
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  mkdirSync(MODELS_DIR, { recursive: true });

  const info = LOCAL_MODELS[variant];

  // Already present? Accept either the hf_-prefixed name (this downloader's
  // output) or the plain filename (a manual download).
  const prefixedPath = join(MODELS_DIR, info.filename);
  const plainPath    = join(MODELS_DIR, info.file);
  if (existsSync(prefixedPath)) return prefixedPath;
  if (existsSync(plainPath))    return plainPath;

  await downloadToFile(modelDownloadUrl(info), prefixedPath, onProgress);
  return prefixedPath;
}

/**
 * Stream a URL to `dest` via a temp `.part` file + atomic rename. Progress is
 * reported from Content-Length (0 when the server omits it). A partial file is
 * cleaned up on failure so it can never be mistaken for a finished model.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Model download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  const tmp = `${dest}.part`;

  // A PassThrough counts bytes as they flow; pipeline() owns backpressure + errors.
  let downloaded = 0;
  const counter = new PassThrough();
  counter.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    onProgress?.({
      downloaded,
      total,
      percent: total > 0 ? (downloaded / total) * 100 : 0,
    });
  });

  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => { /* best effort */ });
    throw err;
  }
}

/** @deprecated Use downloadLocalModel("4b") instead. Kept for backwards compatibility. */
export function downloadDefaultModel(
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  return downloadLocalModel(DEFAULT_LOCAL_MODEL_VARIANT, onProgress);
}
