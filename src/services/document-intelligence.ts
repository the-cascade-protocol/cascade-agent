import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  MODELS_DIR,
  DEFAULT_LOCAL_MODEL_FILENAME,
  downloadDefaultModel,
  type DownloadProgress,
} from '../providers/local.js';
import { loadConfig } from '../config.js';

export type CDASection =
  | 'medications' | 'conditions' | 'labResults' | 'allergies'
  | 'immunizations' | 'vitalSigns' | 'socialHistory' | 'procedures';

export interface ExtractedEntity {
  type: 'medication' | 'condition' | 'lab' | 'socialHistory' | 'vital' | 'allergy' | 'immunization' | 'procedure';
  displayName: string;
  confidence: number;       // 0.0–1.0
  sourceText: string;       // verbatim text span
  status?: string;          // active | inactive | unknown
  normalizedCode?: string;  // populated by terminology normalization
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  confidence: number;          // overall batch confidence (average)
  modelId: string;
  latencyMs: number;
  requiresReview: boolean;     // confidence < 0.85
  rawOutput?: string;          // debug only, never sent over HTTP
  schemaVersion: string;       // "1.0"
}

function loadTemplates(): Record<string, string> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const templatesPath = join(__dirname, '..', 'prompts', 'extraction', 'templates.json');
  return JSON.parse(readFileSync(templatesPath, 'utf-8')) as Record<string, string>;
}

/**
 * Document intelligence service for clinical narrative extraction.
 *
 * Uses node-llama-cpp (in-process, same runtime as LocalProvider) to run
 * Qwen3.5-4B locally. No Ollama required. The model file is shared with the
 * agent's conversational provider — one download covers both use cases.
 *
 * Model location: ~/.config/cascade-agent/models/ (configured via cascade agent login)
 *
 * If the model is not present, call ensureModel() before initialize(), or
 * run `cascade-agent serve` which prompts the user to download automatically.
 */
export class DocumentIntelligenceService {
  private readonly modelPath: string;
  private _llama: unknown = null;
  private _model: unknown = null;
  private _context: unknown = null;
  private _sequence: unknown = null;
  private _currentSession: unknown = null;
  private _evalLock: Promise<void> = Promise.resolve();

  constructor() {
    // Prefer the configured model path (baseUrl) over the default filename,
    // so the service uses whichever model the user actually downloaded.
    const config = loadConfig();
    const configuredPath = config.providers?.local?.baseUrl;
    this.modelPath = (configuredPath && existsSync(configuredPath))
      ? configuredPath
      : join(MODELS_DIR, DEFAULT_LOCAL_MODEL_FILENAME);
  }

  /**
   * Load the model into memory. Safe to call multiple times — no-op if already loaded.
   * Does not download the model; call ensureModel() first if the file may be absent.
   */
  async initialize(): Promise<void> {
    if (this._model !== null) return;

    if (!existsSync(this.modelPath)) {
      // Model not yet downloaded — operate in structured-only mode.
      // cascade-agent serve will prompt the user to download.
      return;
    }

    try {
      const { getLlama } = await import('node-llama-cpp');
      if (!this._llama) {
        this._llama = await getLlama();
      }
      const llama = this._llama as Awaited<ReturnType<typeof getLlama>>;
      this._model = await llama.loadModel({ modelPath: this.modelPath });

      // Create a single persistent context and sequence. Re-using these across
      // requests avoids repeated native KV-cache alloc/dealloc, which otherwise
      // accumulates outside the V8 heap and crashes the process after ~6 requests.
      type LoadedModel = Awaited<ReturnType<typeof llama.loadModel>>;
      const model = this._model as LoadedModel;
      this._context = await model.createContext();
      type LoadedContext = Awaited<ReturnType<LoadedModel['createContext']>>;
      this._sequence = (this._context as LoadedContext).getSequence();
    } catch (err) {
      console.error('[cascade-agent] Failed to load extraction model:', (err as Error).message);
    }
  }

  /**
   * Download the model if not already present, then initialize.
   * Used by `cascade-agent serve` when no model is found at startup.
   */
  async ensureModel(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (!existsSync(this.modelPath)) {
      await downloadDefaultModel(onProgress);
    }
    await this.initialize();
  }

  get isAvailable(): boolean {
    return this._model !== null && this._sequence !== null;
  }

  /** Returns the model filename, or null if not loaded. */
  get currentModelId(): string | null {
    return this._model ? DEFAULT_LOCAL_MODEL_FILENAME : null;
  }

  async extractFromNarrative(text: string, section: CDASection): Promise<ExtractionResult> {
    if (!this._model || !this._sequence) {
      throw new Error(
        'No extraction model loaded.\n' +
        'Run: cascade-agent serve   (will prompt to download ~1.5 GB model)\n' +
        'Or:  cascade-agent login --provider local'
      );
    }

    // Serialize access to the shared context sequence. Without this lock,
    // concurrent HTTP requests (or a new request arriving while a timed-out
    // request is still evaluating) would call llama_decode concurrently on
    // the same native context, causing "Eval has failed" errors.
    let releaseLock: () => void;
    const prevLock = this._evalLock;
    this._evalLock = new Promise<void>((resolve) => { releaseLock = resolve; });

    try {
      await prevLock;
    } catch {
      // Previous evaluation errored — that's fine, we still proceed
    }

    try {
      const startMs = Date.now();
      const prompt = buildPrompt(section, text);

      const { LlamaChatSession } = await import('node-llama-cpp') as typeof import('node-llama-cpp');

      // Dispose the previous session to stop any lingering evaluation and
      // cleanly release its hold on the context sequence.
      if (this._currentSession) {
        try {
          (this._currentSession as InstanceType<typeof LlamaChatSession>).dispose();
        } catch {
          // Disposal may fail if already disposed — safe to ignore
        }
        this._currentSession = null;
      }

      // Clear the sequence's KV-cache state so each extraction starts from a
      // clean slate. Without this, the sequence accumulates tokens from prior
      // conversations (system prompt + user prompt + model response) across
      // requests, eventually filling the 32K context window.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const seq = this._sequence as any;
      if (typeof seq.clearHistory === 'function') {
        await seq.clearHistory();
      }

      // Create a fresh session on the now-clean sequence.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = new LlamaChatSession({
        contextSequence: this._sequence as any,
        systemPrompt: 'You extract clinical data. Output compact JSON only. No explanation. No markdown. No <think> blocks.',
      });
      this._currentSession = session;

      let rawOutput = '';
      await session.prompt(prompt, {
        temperature: 0.1,
        maxTokens: 4096,
        onTextChunk(chunk: string) { rawOutput += chunk; },
      });

      // Strip thinking blocks (Qwen3 think/non-think mode)
      rawOutput = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      const latencyMs = Date.now() - startMs;

      let entities: ExtractedEntity[] = [];
      try {
        const match = rawOutput.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]) as Record<string, unknown>[];
          entities = parsed.map((e) => ({
            type: (e['type'] as ExtractedEntity['type']) ?? sectionToEntityType(section),
            displayName: (e['displayName'] as string) ?? (e['name'] as string) ?? '',
            confidence: typeof e['confidence'] === 'number' ? e['confidence'] : 0.7,
            sourceText: (e['sourceText'] as string) ?? (e['source'] as string) ?? '',
            status: (e['status'] as string) ?? 'unknown',
            normalizedCode: e['normalizedCode'] as string | undefined,
          })).filter((e: ExtractedEntity) => e.displayName.length > 0);
        }
      } catch {
        // JSON parse failed — return empty with low confidence
      }

      const overallConfidence = entities.length > 0
        ? entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length
        : 0;

      return {
        entities,
        confidence: overallConfidence,
        modelId: DEFAULT_LOCAL_MODEL_FILENAME,
        latencyMs,
        requiresReview: overallConfidence < 0.85,
        rawOutput,
        schemaVersion: '1.0',
      };
    } finally {
      releaseLock!();
    }
  }
}

function sectionToEntityType(section: CDASection): ExtractedEntity['type'] {
  const map: Record<CDASection, ExtractedEntity['type']> = {
    medications: 'medication',
    conditions: 'condition',
    labResults: 'lab',
    allergies: 'allergy',
    immunizations: 'immunization',
    vitalSigns: 'vital',
    socialHistory: 'socialHistory',
    procedures: 'procedure',
  };
  return map[section];
}

function buildPrompt(section: CDASection, text: string): string {
  const templates = loadTemplates();
  const template = templates[section];
  if (!template) {
    return `Extract clinical entities from this text. Output JSON array only.\n\nText:\n${text}`;
  }
  return template.replace('{{text}}', text);
}

export const documentIntelligence = new DocumentIntelligenceService();
