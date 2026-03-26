# Cross-Platform Local Agent — Implementation Plan

> Draft: 2026-03-26
> Status: RFC / Design Document

## Goal

Ship a single `@the-cascade-protocol/agent` package that runs on **every major platform** — desktop, mobile, browser, and embedded — with meaningful agentic capability even when **completely offline** and using only local models.

The guiding principle: **one codebase, many runtimes**.

---

## 1. Platform Matrix

| Platform | Runtime | LLM Backend | Shell Access | Notes |
|----------|---------|-------------|--------------|-------|
| **macOS / Linux / Windows** | Node.js 18+ | llama.cpp server, Ollama, vLLM, cloud APIs | Full | Current target — already works |
| **iOS** | React Native / Capacitor | llama.cpp (via GGML), MLX | Sandbox only | App Store constraints |
| **Android** | React Native / Capacitor | llama.cpp (via GGML) | Termux or sandbox | Play Store constraints |
| **Browser (PWA)** | Service Worker + WASM | WebLLM (wasm llama.cpp) | None | Offline-first via cache |
| **Embedded / Raspberry Pi** | Node.js or Deno | Ollama, llama.cpp | Full | Low RAM target |

---

## 2. Recommended Local Models

### By Hardware Tier

**Tier 1 — Server / Desktop with GPU (16+ GB VRAM)**

| Model | Params | Quantization | RAM/VRAM | Strengths |
|-------|--------|-------------|----------|-----------|
| Qwen3.5 27B | 27B | Q4_K_M | ~16 GB | Agentic training, 262K context, multimodal |
| Qwen 2.5 72B | 72B | Q4_K_M | ~42 GB | Proven tool-calling reliability |
| Llama 3.3 70B | 70B | Q4_K_M | ~40 GB | Strong reasoning, broad training |

**Tier 2 — Laptop / Desktop CPU (8-16 GB RAM)**

| Model | Params | Quantization | RAM | Strengths |
|-------|--------|-------------|-----|-----------|
| Qwen3.5 9B | 9B | Q4_K_M | ~6 GB | Native agentic tool-calling, 262K context, vision |
| Qwen3.5 4B | 4B | Q4_K_M | ~3 GB | Best quality-per-GB at this tier |
| Qwen 2.5 7B | 7B | Q4_K_M | ~5 GB | Mature ecosystem, Ollama-compatible |
| Phi-4 14B | 14B | Q4_K_M | ~9 GB | Strong structured output |

**Tier 3 — Mobile / Embedded (2-4 GB RAM)** ⭐ _Qwen3.5-2B is the new sweet spot_

| Model | Params | Quantization | RAM | Strengths |
|-------|--------|-------------|-----|-----------|
| **Qwen3.5 2B** | **2B** | **Q4_K_M** | **~1.5 GB** | **Native agentic training, 262K context, multimodal, think/non-think modes** |
| Qwen3.5 0.8B | 0.8B | Q8_0 | ~1 GB | Ultra-constrained devices (Pi Zero, old phones) |
| Llama 3.2 3B | 3B | Q8_0 | ~3.5 GB | Fallback if Ollama required (Qwen3.5 not yet supported) |

**Tier 4 — Browser (WASM, limited memory)**

| Model | Params | Quantization | RAM | Notes |
|-------|--------|-------------|-----|-------|
| **Qwen3.5 2B** | **2B** | **Q4_0** | **~1.2 GB** | Best-in-class tool-calling for WASM target |
| Qwen3.5 0.8B | 0.8B | Q4_0 | ~0.5 GB | Minimum viable for very constrained browsers |

### Recommended Default per Platform

| Platform | Default Model | Rationale |
|----------|--------------|-----------|
| Desktop (llama.cpp server) | `qwen3.5:9b` | Best balance of quality and speed; agentic training |
| Desktop (Ollama fallback) | `qwen2.5:7b` | Ollama doesn't support Qwen3.5 yet (see §2a) |
| Mobile | `qwen3.5:2b` | 1.5 GB RAM, native tool-calling, 262K context |
| Browser | `qwen3.5:2b` | Same model across mobile/browser for consistency |
| Embedded (Pi 4+) | `qwen3.5:2b` | Fits in 2 GB with room to spare |
| Ultra-constrained | `qwen3.5:0.8b` | Pi Zero 2, budget phones, minimal browsers |

### Why Qwen3.5-2B over previous picks

- **vs Qwen 2.5 3B**: Smaller (2B < 3B), yet trained specifically for agentic tool-calling. 262K context vs 32K. Adds vision.
- **vs Llama 3.2 3B**: Better tool-call fidelity from purpose-built agentic training. Think/non-think mode toggle saves battery on simple queries.
- **vs SmolLM2 1.7B**: Similar size but vastly better at structured output and function calling.

---

## 2a. Model Sourcing & Runtime Backends

**Ollama is NOT required.** It's one option for desktop, but Qwen3.5 models don't work in Ollama yet (due to separate mmproj vision files). Here are all the ways to source and run models:

### Where to download models

| Source | Format | How |
|--------|--------|-----|
| **Hugging Face (official)** | GGUF | `huggingface-cli download Qwen/Qwen3.5-2B-GGUF` |
| **Hugging Face (Unsloth)** | GGUF (optimized quants) | `huggingface-cli download unsloth/Qwen3.5-2B-GGUF` |
| **Ollama registry** | Ollama blob | `ollama pull qwen2.5:7b` (Qwen3.5 not yet available) |
| **llama.cpp -hf flag** | Auto-download GGUF | `llama-server -hf Qwen/Qwen3.5-2B-GGUF:Q4_K_M` |

### Runtime backends by platform

| Backend | Platforms | OpenAI-compat API | Notes |
|---------|-----------|-------------------|-------|
| **llama.cpp (server mode)** | Desktop, Linux, Pi | Yes (`/v1/chat/completions`) | **Recommended for Qwen3.5.** Run `llama-server -m model.gguf` and point the agent at `http://localhost:8080/v1` |
| **Ollama** | Desktop, Linux, Pi | Yes (`/v1/chat/completions`) | Easiest setup but **no Qwen3.5 support yet**. Good for Qwen 2.5, Llama 3.x |
| **llama.cpp (in-process)** | Mobile (via react-native-llama), embedded | N/A (native bindings) | No HTTP server needed; model runs in-app |
| **WebLLM / wasm llama.cpp** | Browser | N/A (JS API) | GGUF loaded into WASM runtime; ~2x slower than native |
| **vLLM / SGLang** | Server GPU | Yes | Production serving for multi-user deployments |
| **MLX** | macOS (Apple Silicon) | Community wrappers | Good Metal acceleration; alternative to llama.cpp on Mac |

### How the agent connects (no code changes needed for llama.cpp)

The existing `openai-compat` provider works with **any** backend that serves the OpenAI Chat Completions API. To use llama.cpp server instead of Ollama:

```bash
# 1. Start llama.cpp server (one-time)
llama-server -hf Qwen/Qwen3.5-2B-GGUF:Q4_K_M --port 8080

# 2. Configure the agent to point at it
cascade-agent provider ollama          # reuses the "ollama" provider type
cascade-agent model qwen3.5-2b        # any name — passed through to server
# Or set OLLAMA_HOST=http://localhost:8080 if using non-default port
```

Since llama.cpp's server speaks the same OpenAI-compatible API as Ollama (at `/v1/chat/completions`), the agent's existing `OpenAICompatProvider` works unmodified. The only change needed is the base URL, which the config already supports via `providers.ollama.baseUrl`.

### Recommended quantizations

| Device RAM | Quantization | Quality | File size (2B) |
|-----------|-------------|---------|----------------|
| ≥4 GB | Q8_0 | Best | ~2.2 GB |
| 2-4 GB | **Q4_K_M** | **Recommended** | **~1.3 GB** |
| 1-2 GB | Q4_0 | Good | ~1.1 GB |
| <1 GB | UD-Q2_K_XL | Minimum viable | ~0.7 GB |

---

## 3. Architecture: Shared Core, Platform Adapters

```
@the-cascade-protocol/agent
├── core/                    ← SHARED (pure TypeScript, no Node.js APIs)
│   ├── agent.ts             ← Turn loop, tool dispatch
│   ├── system-prompt.ts     ← Prompt construction (already portable)
│   ├── providers/
│   │   ├── types.ts         ← Provider interface (already portable)
│   │   └── openai-compat.ts ← Works with any OpenAI-compatible API
│   ├── tools-registry.ts    ← Tool definitions (schemas only, no impl)
│   └── message-types.ts     ← SimpleMessage, AgentCallbacks
│
├── adapters/                ← PLATFORM-SPECIFIC
│   ├── node/
│   │   ├── tools.ts         ← Shell exec, file read (current tools.ts)
│   │   ├── config.ts        ← Filesystem config (~/.config/...)
│   │   └── repl.ts          ← Terminal REPL
│   ├── mobile/
│   │   ├── tools.ts         ← Sandboxed file access, no shell
│   │   ├── config.ts        ← AsyncStorage / SecureStore
│   │   └── inference.ts     ← llama.cpp bindings (react-native-llama)
│   ├── browser/
│   │   ├── tools.ts         ← IndexedDB file store, no shell
│   │   ├── config.ts        ← localStorage / IndexedDB
│   │   └── inference.ts     ← WebLLM / wasm llama.cpp
│   └── shared/
│       └── cascade-lite.ts  ← Offline Cascade CLI subset (see §4)
│
├── cli.ts                   ← Node CLI entry (imports node adapter)
└── index.ts                 ← Library API (exports core + adapter factory)
```

### Key Design Decisions

1. **Core is pure TypeScript** — no `child_process`, no `fs`, no `process.env`. Everything platform-specific goes through adapter interfaces.

2. **Provider interface stays the same** — `Provider.runTurn()` works identically whether backed by Anthropic's API, Ollama over HTTP, or an in-process WASM model.

3. **Tool implementations are injected** — the core defines tool schemas; adapters provide `executeTool()` implementations appropriate for their platform.

---

## 4. Offline Capability: `cascade-lite`

The agent currently wraps `cascade serve --mcp` / `cascade pod query` via shell. On platforms without a shell (mobile, browser) or without network, we need a lightweight built-in subset.

### What `cascade-lite` provides (no network, no CLI binary)

| Capability | How |
|------------|-----|
| **Read pods from local storage** | Parse `.pod` (JSON-LD) files from a local directory or IndexedDB |
| **Query by data type** | Filter records by `@type` — conditions, medications, lab-results, etc. |
| **Basic jq-like filtering** | Built-in JSONPath or a tiny jq subset (10 operators) |
| **Pod validation** | JSON Schema validation against bundled vocab schemas |
| **Export** | Serialize filtered results to JSON or Markdown |

### What `cascade-lite` does NOT provide

- Pod creation/signing (requires CLI + keys)
- Network sync / FHIR import
- MCP server mode
- Multi-pod merge operations

### Implementation

```typescript
// adapters/shared/cascade-lite.ts

export interface PodStore {
  /** List available pod IDs */
  listPods(): Promise<string[]>;
  /** Read a pod's raw JSON-LD content */
  readPod(podId: string): Promise<object>;
}

export function queryPod(
  pod: object,
  dataType: string,
  filter?: string       // mini jq expression
): Record<string, unknown>[] {
  // 1. Navigate to pod.dataTypes[dataType].records
  // 2. Apply filter expression
  // 3. Return matching records
}

export function validatePod(pod: object): ValidationResult {
  // JSON Schema validation against bundled schemas
}
```

Platform adapters implement `PodStore`:
- **Node**: reads `~/.cascade/pods/*.pod` files
- **Mobile**: reads from app sandbox / document picker imports
- **Browser**: reads from IndexedDB (pods imported via drag-and-drop or file picker)

---

## 5. Tool Capability Tiers

Not every platform gets every tool. The agent's system prompt adapts based on available capabilities.

| Tool | Node | Mobile | Browser | Description |
|------|------|--------|---------|-------------|
| `cascade_query` | Full CLI | cascade-lite | cascade-lite | Query pod data |
| `cascade_validate` | Full CLI | cascade-lite | cascade-lite | Validate pod structure |
| `shell` | Yes | No | No | Execute arbitrary commands |
| `read_file` | Yes | Sandbox | IndexedDB | Read file contents |
| `write_file` | Yes | Sandbox | IndexedDB | Write file contents |
| `web_fetch` | Yes | Yes | CORS-limited | HTTP requests |

### Adaptive System Prompt

```typescript
// core/system-prompt.ts

export function buildSystemPrompt(capabilities: PlatformCapabilities): string {
  const sections = [BASE_PROMPT];

  if (capabilities.hasShell) {
    sections.push(SHELL_INSTRUCTIONS);
    sections.push(JQ_EXAMPLES);
  }

  if (capabilities.hasCascadeCLI) {
    sections.push(FULL_CLI_PATTERNS);
  } else {
    sections.push(LITE_QUERY_PATTERNS);   // cascade-lite instructions
  }

  if (capabilities.isOffline) {
    sections.push(OFFLINE_GUIDANCE);       // "You cannot access the network..."
  }

  sections.push(VOCAB_REFERENCE);          // Always included
  return sections.join("\n\n");
}
```

---

## 6. Provider Adapter: In-Process Inference

For mobile and browser, we need providers that run the model in-process rather than over HTTP.

```typescript
// adapters/mobile/inference.ts
import { initLlama, type LlamaContext } from 'react-native-llama';

export class LocalLlamaProvider implements Provider {
  readonly providerName = "local" as ProviderName;
  readonly model: string;
  private context: LlamaContext;

  async init(modelPath: string) {
    this.context = await initLlama({ model: modelPath, n_ctx: 4096 });
  }

  async runTurn(messages, tools, callbacks): Promise<string> {
    // 1. Format messages + tool schemas into chat template
    // 2. Run completion with context
    // 3. Parse tool calls from output (Hermes/ChatML format)
    // 4. Execute tools via adapter's executeTool
    // 5. Loop until model returns text-only response
  }
}
```

```typescript
// adapters/browser/inference.ts
import { CreateMLCEngine } from '@anthropic-ai/webllm';

export class WebLLMProvider implements Provider {
  // Same Provider interface, backed by WebLLM WASM engine
  // Tool-calling via structured output / grammar constraints
}
```

---

## 7. Build & Package Strategy

```
npm run build:core       → dist/core/        (ESM, no platform deps)
npm run build:node       → dist/node/        (ESM + CJS, Node APIs)
npm run build:browser    → dist/browser/     (ESM bundle, tree-shaken)

# Mobile builds use core + mobile adapter via Metro/Webpack
```

### Package Exports

```jsonc
// package.json
{
  "exports": {
    ".": "./dist/core/index.js",           // Shared core
    "./node": "./dist/node/index.js",      // Node adapter (current behavior)
    "./browser": "./dist/browser/index.js", // Browser adapter
    "./tools": "./dist/core/tools-registry.js",
    "./providers": "./dist/core/providers/index.js",
    "./cascade-lite": "./dist/core/cascade-lite.js"
  }
}
```

---

## 8. Migration Path (Incremental)

### Phase 1 — Extract core (no new platforms)
- [ ] Split `src/tools.ts` into schema definitions (core) and execution (node adapter)
- [ ] Move `child_process`/`fs` imports behind adapter interface
- [ ] Move config I/O behind adapter interface
- [ ] Ensure all tests pass with the new structure
- **Result**: Same CLI behavior, cleaner separation

### Phase 2 — cascade-lite
- [ ] Implement `PodStore` interface and `queryPod()` for Node
- [ ] Implement mini-jq evaluator (subset: `.`, `[]`, `select()`, `sort_by()`, `map()`, pipes)
- [ ] Bundle vocabulary JSON Schemas for offline validation
- [ ] Test with real pod fixtures
- **Result**: Agent can query pods without shelling out to `cascade` CLI

### Phase 3 — Browser target
- [ ] Implement browser adapter (IndexedDB PodStore, WebLLM provider)
- [ ] Build PWA shell with chat UI
- [ ] Add pod import via file picker / drag-and-drop
- [ ] Offline-first with service worker caching
- **Result**: Agent runs entirely in-browser, offline

### Phase 4 — Mobile target
- [ ] React Native or Capacitor shell
- [ ] llama.cpp integration via native module
- [ ] Secure pod storage (Keychain / Android Keystore for sensitive data)
- [ ] Document picker for pod import
- **Result**: Agent on iOS and Android app stores

### Phase 5 — Model management
- [ ] Auto-detect available models on platform
- [ ] Download recommended model on first run (with progress UI)
- [ ] Quantization tier selection based on available RAM
- [ ] Model update mechanism
- **Result**: Zero-config model setup on any platform

---

## 9. ProviderName Type Update

```typescript
// Extended provider types
export type ProviderName =
  | "anthropic"     // Cloud: Anthropic API
  | "openai"        // Cloud: OpenAI API
  | "google"        // Cloud: Google Gemini API
  | "ollama"        // Local: Ollama HTTP server
  | "local-llama"   // Local: In-process llama.cpp (mobile/embedded)
  | "webllm";       // Local: In-browser WASM inference
```

---

## 10. Security Considerations

| Concern | Mitigation |
|---------|------------|
| Pod data stays local | cascade-lite never transmits data; cloud providers only see queries, not pod content (tool results are local) |
| Model downloads | Pin SHA256 hashes for recommended models; verify on download |
| Mobile sandbox escape | No shell tool on mobile; all file access through PodStore abstraction |
| Browser same-origin | No `eval()`, CSP headers, sandboxed iframes for pod rendering |
| API key storage | Node: `mode 0o600` config file; Mobile: Keychain/Keystore; Browser: none stored (cloud providers optional) |

---

## 11. Open Questions

1. **Should we vendor a jq WASM build** instead of writing a mini-jq? (Tradeoff: ~2 MB binary vs. limited but tiny implementation)
2. **Model distribution for mobile** — bundle a Q4 model in the app binary (~1.3 GB for Qwen3.5-2B) or download on first launch?
3. **Should browser target support cloud providers** or be local-only? (CORS makes direct API calls messy; a proxy adds complexity)
4. **React Native vs Capacitor** for mobile — RN has better llama.cpp bindings today, Capacitor shares more web code
5. **Minimum viable tool-calling** — Qwen3.5-2B has native agentic training, but should we still add grammar-constrained decoding as a safety net for smaller quants (Q2)?
6. **Ollama Qwen3.5 timeline** — Ollama doesn't support Qwen3.5 yet (mmproj issue). Do we wait, or make llama.cpp server the primary local backend now? (Recommendation: support both, default to llama.cpp)
7. **Think vs non-think mode switching** — Qwen3.5 supports toggling reasoning on/off. Should the agent auto-select based on query complexity, or expose a user toggle?

---

## Summary

The shared-core architecture lets us ship the Cascade agent on every platform with **one TypeScript codebase**. The key abstractions are:

- **Provider interface** — already exists, just needs `local-llama` and `webllm` implementations
- **Tool adapter interface** — new; splits tool schemas from platform-specific execution
- **PodStore interface** — new; abstracts pod storage across filesystem, sandbox, and IndexedDB
- **cascade-lite** — new; embedded pod query engine replacing CLI dependency for offline/mobile/browser
- **Adaptive system prompt** — extends existing `initSystemPrompt()` to vary instructions by platform capabilities

The migration is incremental: Phase 1 is a refactor of the existing codebase with no behavior changes, and each subsequent phase adds one new platform target.
