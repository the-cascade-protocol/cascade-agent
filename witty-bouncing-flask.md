# Plan: Qwen3.5 2B Local Provider — Eval, Gap-Closing, Integration

## Context

cascade-agent currently supports four cloud providers (Anthropic, OpenAI, Google, Ollama).
The goal is to add a self-contained local provider using `node-llama-cpp` that ships Qwen3.5-2B
out-of-the-box with no API key required. Before committing to the integration we need to know
whether a 2B model can reliably drive the agent's two tools (`shell`, `read_file`) — including
multi-step chains and structured argument extraction. The eval suite must be rerunnable against
any provider so future model upgrades can be benchmarked comparatively.

---

## Phase 1 — Eval Test Suite

### Files to create

```
eval/
  runner.ts          CLI entry: --provider --model --json --filter flags
  harness.ts         Executes cases, measures pass/fail/latency
  reporter.ts        Human-readable table + JSON output
  cases/
    shell-single.ts        "list files in /tmp" → expects shell tool call
    shell-chain.ts         "create a dir, write a file, read its line count" → 3-tool chain
    read-file.ts           "what is the first triple in <fixture.ttl>?" → read_file tool call
    mixed-tools.ts         "run ls and then read the output file" → shell + read_file
    pod-query.ts           "query this pod for conditions" → shell + jq pattern
    no-tool.ts             "what is the Cascade Protocol?" → no tool, factual answer
    error-recovery.ts      tool returns exit 1, check agent retries or reports cleanly
  fixtures/
    sample.ttl         minimal 5-triple Cascade RDF file (static, no live pod needed)
    sample.json        minimal FHIR Patient bundle
```

### Eval harness design

- Uses Node.js built-in `node:test` — no extra dependencies
- Each case exports `{ name, prompt, evaluate(messages, toolCalls): EvalResult }`
- `toolCalls` is collected by intercepting `onToolStart`/`onToolEnd` callbacks
- `EvalResult = { pass: boolean; score: number; notes: string }`
- Runner accepts `--provider anthropic|openai|google|ollama|local` and `--model <name>`

### Pass criteria (quality bar for local model)

| Metric | Pass threshold |
|---|---|
| Tool call accuracy (right tool, valid JSON args) | ≥ 80% |
| Arg schema conformance (no malformed JSON) | 100% (with repair fallback) |
| Multi-step chain completion (shell-chain) | ≥ 60% |
| No spurious tool calls on no-tool cases | 100% |
| Error recovery (graceful, not infinite loop) | 100% |

---

## Phase 2 — Gap-Closing Measures

Applied to `LocalProvider` regardless of eval results (preventive hardening):

1. **JSON repair** — wrap arg parsing in `jsonrepair` fallback before bailing
2. **Simplified tool descriptions** — shorter, more directive descriptions for small-model context
3. **Sequential tool calls only** — no parallel tool_calls for local models (reduces confusion)
4. **Local system prompt** — prepend explicit tool-call format examples tuned to Qwen3 chat template

If eval reveals specific failures, additional mitigations:
- Lower temperature (0.1–0.3) for tool-heavy tasks
- Max tokens cap to prevent runaway generation
- Retry once on malformed tool call before failing

---

## Phase 3 — LocalProvider Implementation

### New file: `src/providers/local.ts`

Implements the existing `Provider` interface. Key design:

```typescript
export class LocalProvider implements Provider {
  readonly providerName = "local" as const;
  readonly model: string;
  private modelPath: string;

  // Lazy-loads node-llama-cpp only when runTurn is called
  async runTurn(messages, customTools, callbacks): Promise<string>
  async listModels(): Promise<string[]>  // returns [modelFilename]
}
```

- Uses `node-llama-cpp` v3 `LlamaChatSession` with the model's built-in chat template
- Qwen3.5-2B-Instruct GGUF has tool-calling in its chat template — use natively
- `onToken` callback maps to `callbacks.onText` for streaming
- Tool calls parsed from session response; `jsonrepair` wraps arg parsing

### Model management

- Models stored at `~/.config/cascade-agent/models/<filename>.gguf`
- `ModelManager` utility: checks if model file exists, downloads from HuggingFace if not
- Download triggered during `cascade-agent login --provider local`
- Default model: `Qwen_Qwen3.5-2B-Instruct-Q4_K_M.gguf` (recommended quantisation for 2B)

---

## Phase 4 — Build Integration (conditional on eval pass)

### Files to modify

| File | Change |
|---|---|
| `src/providers/types.ts` | Add `"local"` to `ProviderName` union |
| `src/providers/index.ts` | Add `local` to `ALL_PROVIDERS`, `DEFAULT_MODELS`, factory switch |
| `src/config.ts` | No changes needed — existing `ProviderConfig` handles model path via `baseUrl` field repurposed, or add `modelPath` |
| `src/cli.ts` | Handle local in login flow: prompt model download, skip API key prompt |
| `src/onboarding.ts` | Add `local` as a no-key option in first-run flow |
| `package.json` | Add `node-llama-cpp` as `optionalDependencies` + `jsonrepair` as dependency |

### Optional dependency strategy

`node-llama-cpp` goes in `optionalDependencies` — npm installs it but won't fail if
native compilation breaks on an unsupported platform. `LocalProvider` does a runtime
`try { await import("node-llama-cpp") } catch { throw helpful error }` to give a clear
message if it's missing.

### Build: no bundler changes needed

`tsc` output is loose JS files in `dist/` — node-llama-cpp's native binaries in
`node_modules` are untouched. No esbuild/webpack external config required.

---

## Execution Order

1. Create eval fixtures and case files
2. Create eval runner/harness/reporter
3. Implement `LocalProvider` with gap-closing baked in
4. Add `node-llama-cpp` + `jsonrepair` to package.json
5. Run eval: `npx tsx eval/runner.ts --provider local --model qwen3.5-2b`
6. Report results; if pass → proceed to integration edits
7. If fail → apply additional mitigations, rerun
8. Integration: update types, config, cli, onboarding
9. Final build + smoke test

---

## Critical Files

- `src/providers/types.ts` — ProviderName union
- `src/providers/index.ts` — factory
- `src/providers/openai-compat.ts` — reference for runTurn pattern
- `src/tools.ts` — tool schemas (read for eval case design)
- `package.json` — dependency additions
