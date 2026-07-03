/**
 * Managed / attached **llama-server** (llama.cpp) HTTP client for cascade-agent.
 *
 * The production local engine (2026-06-16 decision, 2026-07-03 consolidation).
 * We do NOT run node-llama-cpp in-process for extraction: llama-server tracks
 * upstream model architectures, exposes a stable OpenAI-compatible HTTP API,
 * supports GBNF grammar-constrained decoding, is crash-isolated, and lets ONE
 * copy of the weights be shared by every consumer.
 *
 * This is the TS analogue of the Workbench's Rust `LlamaManager`
 * (`src-tauri/src/llama.rs`) + client (`packages/claims/src/llama-server.ts`).
 * The Workbench owns the process in Rust; a standalone cascade-agent owns it here.
 *
 * Two backends, chosen by config (env → settings):
 *   - EXTERNAL (`CASCADE_LLAMA_URL` set): attach + proxy. NOT ours to manage or
 *     kill. This is the path a Workbench session uses so cascade-agent shares
 *     the Rust-managed server instead of spawning a second one.
 *   - MANAGED (no URL, a GGUF model path present): spawn + supervise
 *     `llama-server -m <gguf>` on a free loopback port, pidfile-record + reap
 *     orphans on start, SIGKILL on teardown (llama-server ignores SIGTERM).
 */

import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { basename } from 'path';
import * as sidecarPids from './sidecar-pids.js';

const SIDECAR_NAME = 'llama-server';

/**
 * GBNF grammar constraining extraction output to a syntactically valid JSON
 * **array of objects**. Mirrors the Workbench's proven `EXTRACTION_GRAMMAR`
 * (`packages/claims/src/llama-server.ts`): production extraction historically
 * recovered JSON with a `/\[[\s\S]*\]/` regex, so a model that emitted prose or
 * a truncated object silently yielded zero entities; the grammar closes that
 * failure mode (the bake-off measured 100% valid JSON across every model).
 */
export const EXTRACTION_GRAMMAR = `root   ::= ws "[" ws ( object ( ws "," ws object )* )? ws "]" ws
object ::= "{" ws ( member ( ws "," ws member )* )? ws "}"
member ::= string ws ":" ws value
value  ::= object | array | string | number | "true" | "false" | "null"
array  ::= "[" ws ( value ( ws "," ws value )* )? ws "]"
string ::= "\\"" ( [^"\\\\] | "\\\\" . )* "\\""
number ::= "-"? ( "0" | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?
ws     ::= [ \\t\\n]*`;

/** The JSON body for a llama-server `/v1/chat/completions` call. */
export interface ChatRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature: number;
  max_tokens: number;
  stream: false;
  /**
   * Disable the model's chain-of-thought. Qwen 3.x reasoning GGUFs route their
   * thinking into `reasoning_content` and leave `content` EMPTY until thinking
   * ends (the "model returns nothing" gotcha), which also fights the grammar.
   * Extraction always wants direct structured output, so thinking is off.
   */
  chat_template_kwargs: { enable_thinking: boolean };
  /** GBNF grammar (llama.cpp extension). */
  grammar?: string;
}

export interface BuildChatOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  grammar?: string;
}

/** Build a chat-completions body. Shared shape with the Workbench client. */
export function buildChatRequest(prompt: string, opts: BuildChatOptions = {}): ChatRequest {
  const messages: ChatRequest['messages'] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });
  const body: ChatRequest = {
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 512,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (opts.grammar) body.grammar = opts.grammar;
  return body;
}

/** Context window for the managed server. Env override: CASCADE_AGENT_EXTRACT_CONTEXT. */
const DEFAULT_CONTEXT_TOKENS = 16384;

function contextTokens(): number {
  const configured = Number.parseInt(process.env['CASCADE_AGENT_EXTRACT_CONTEXT'] ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CONTEXT_TOKENS;
}

/** Resolve the `llama-server` binary: env override → PATH. */
function llamaServerBin(): string {
  const override = process.env['CASCADE_LLAMA_SERVER_BIN'];
  if (override && override.trim().length > 0) return override.trim();
  return 'llama-server';
}

/** Allocate a free loopback port (bind :0, read it, release). */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('could not read allocated port')));
      }
    });
  });
}

export interface LlamaServerOptions {
  /** External server base URL. Default env CASCADE_LLAMA_URL. Attach, do not manage. */
  externalUrl?: string;
  /** GGUF model path for a managed spawn (ignored when externalUrl is set). */
  modelPath?: string;
  /** Injected fetch (tests). Default the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Model identifier recorded on results. Default the model file basename. */
  modelId?: string;
}

/**
 * Owns the local llama-server backend for cascade-agent: attaches to an external
 * server or lazily spawns + supervises a managed one, and proxies chat
 * completions to it.
 */
export class LlamaServerManager {
  private readonly externalUrl?: string;
  private readonly modelPath?: string;
  private readonly fetchImpl: typeof fetch;
  readonly modelId: string;

  private _child: ChildProcess | null = null;
  private _baseUrl: string | null = null;
  private _ensurePromise: Promise<string> | null = null;
  private _teardownRegistered = false;
  private _spawnError: Error | null = null;

  constructor(opts: LlamaServerOptions = {}) {
    this.externalUrl = (opts.externalUrl ?? process.env['CASCADE_LLAMA_URL'] ?? undefined)?.replace(/\/+$/, '') || undefined;
    this.modelPath = opts.modelPath;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.modelId = opts.modelId ?? (this.modelPath ? basename(this.modelPath) : 'llama-server');
  }

  /** True when an external URL is configured (we attach; never spawn/manage). */
  get isExternal(): boolean {
    return this.externalUrl !== undefined;
  }

  /** The managed child is currently alive. */
  get isManagedRunning(): boolean {
    return this._child !== null && this._child.exitCode === null && !this._child.killed;
  }

  /**
   * Ensure a backend exists and return its base URL. Attaches to the external
   * URL, or spawns + health-waits a managed server on first call. Single-flight:
   * concurrent callers share one spawn.
   */
  async ensureRunning(): Promise<string> {
    // Reuse a live backend.
    if (this._baseUrl) {
      if (this.isExternal || this.isManagedRunning) return this._baseUrl;
      // Managed child died — drop it and re-spawn below.
      this._baseUrl = null;
      this._child = null;
    }
    if (!this._ensurePromise) {
      this._ensurePromise = this.startBackend().finally(() => {
        this._ensurePromise = null;
      });
    }
    return this._ensurePromise;
  }

  private async startBackend(): Promise<string> {
    // External server takes precedence: just proxy to it.
    if (this.externalUrl) {
      this._baseUrl = this.externalUrl;
      return this._baseUrl;
    }

    if (!this.modelPath) {
      throw new Error('No local model configured for a managed llama-server (set CASCADE_LLAMA_URL to attach to an external server).');
    }

    // Reap any llama-server a previous cascade-agent run orphaned before spawning
    // ours (llama-server ignores SIGTERM and cannot watch stdin — the reaper is
    // the only orphan story).
    sidecarPids.reapStale(SIDECAR_NAME);

    const ngl = process.env['CASCADE_LLAMA_NGL']?.trim() || '999';
    const np = process.env['CASCADE_LLAMA_NP']?.trim() || '1';
    const ctx = String(contextTokens());
    const port = await freeLoopbackPort();
    const bin = llamaServerBin();

    const child = spawn(
      bin,
      [
        '-m', this.modelPath,
        '--port', String(port),
        '-c', ctx,
        '-np', np,
        '-ngl', ngl,
        '--jinja',
        '--no-webui',
      ],
      // stdin ignored (llama-server does not read it); stdout muted; stderr
      // inherited so model-load failures surface in cascade-agent's console.
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );

    if (child.pid === undefined) {
      throw new Error(`Failed to spawn llama-server (${bin}). Ensure the binary is on PATH or set CASCADE_LLAMA_SERVER_BIN.`);
    }

    this._child = child;
    this._baseUrl = `http://127.0.0.1:${port}`;
    this._spawnError = null;
    sidecarPids.record(SIDECAR_NAME, child.pid, SIDECAR_NAME);
    this.registerTeardown();

    // Capture an exec failure (e.g. binary missing) so the health-wait fails fast
    // instead of polling a port that will never come up.
    child.once('error', (err) => { this._spawnError = err as Error; });

    try {
      await this.waitForHealth(this._baseUrl);
    } catch (err) {
      // A spawned-but-unhealthy child is dead weight (and RAM) — kill it.
      this.shutdown();
      throw err;
    }
    return this._baseUrl;
  }

  /** Poll GET /health until the server is ready (model load can be slow). */
  private async waitForHealth(base: string, timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._spawnError) {
        throw new Error(`Failed to start llama-server (${llamaServerBin()}): ${this._spawnError.message}. Ensure the binary is on PATH or set CASCADE_LLAMA_SERVER_BIN.`);
      }
      if (this._child && this._child.exitCode !== null) {
        throw new Error(`llama-server exited (code ${this._child.exitCode}) before becoming healthy.`);
      }
      if (await this.health(base)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`llama-server did not become healthy at ${base} within ${Math.round(timeoutMs / 1000)}s.`);
  }

  /** Liveness probe. 200 from /health means the model is loaded and ready. */
  async health(base?: string): Promise<boolean> {
    const url = base ?? this._baseUrl ?? this.externalUrl;
    if (!url) return false;
    try {
      const res = await this.fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * POST a chat-completions body to the backend, returning the assistant
   * message content. Assumes {@link ensureRunning} has resolved the base URL.
   */
  async complete(body: ChatRequest): Promise<string> {
    const base = this._baseUrl ?? await this.ensureRunning();
    const res = await this.fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`llama-server ${res.status}: ${detail.slice(0, 512)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Tear down the managed sidecar. Idempotent. SIGKILL, never SIGTERM
   * (llama-server ignores SIGTERM). External backends are not ours to kill.
   */
  shutdown(): void {
    const child = this._child;
    this._child = null;
    this._baseUrl = this.externalUrl ?? null;
    if (child && child.pid !== undefined) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    sidecarPids.clear(SIDECAR_NAME);
  }

  /**
   * Kill the managed child on cascade-agent's own exit paths (the Drop analogue).
   * The reaper is the backstop for uncatchable exits (self-SIGKILL under
   * `serve --exit-with-parent`, host crash).
   */
  private registerTeardown(): void {
    if (this._teardownRegistered) return;
    this._teardownRegistered = true;
    // Normal completion / process.exit(): synchronous kill.
    process.once('exit', () => {
      if (this._child && this._child.pid !== undefined) {
        try { this._child.kill('SIGKILL'); } catch { /* gone */ }
      }
    });
    // Signals do NOT emit 'exit' on their own — teardown then re-exit.
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => {
        this.shutdown();
        process.exit(sig === 'SIGINT' ? 130 : 143);
      });
    }
  }
}
