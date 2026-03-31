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
 * Qwen3.5-2B locally. No Ollama required. The model file is shared with the
 * agent's conversational provider — one download covers both use cases.
 *
 * Model location: ~/.config/cascade-agent/models/hf_unsloth_Qwen3.5-2B-Q4_K_M.gguf
 *
 * If the model is not present, call ensureModel() before initialize(), or
 * run `cascade-agent serve` which prompts the user to download automatically.
 */
export class DocumentIntelligenceService {
  private readonly modelPath: string;
  private _llama: unknown = null;
  private _model: unknown = null;

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
    return this._model !== null;
  }

  /** Returns the model filename, or null if not loaded. */
  get currentModelId(): string | null {
    return this._model ? DEFAULT_LOCAL_MODEL_FILENAME : null;
  }

  async extractFromNarrative(text: string, section: CDASection): Promise<ExtractionResult> {
    if (!this._model) {
      throw new Error(
        'No extraction model loaded.\n' +
        'Run: cascade-agent serve   (will prompt to download ~1.5 GB model)\n' +
        'Or:  cascade-agent login --provider local'
      );
    }

    const startMs = Date.now();
    const prompt = buildPrompt(section, text);

    const { LlamaChatSession } = await import('node-llama-cpp') as typeof import('node-llama-cpp');

    // Cast via unknown — node-llama-cpp is an optional dep; types only available at runtime.
    type LoadedModel = Awaited<ReturnType<Awaited<ReturnType<typeof import('node-llama-cpp')['getLlama']>>['loadModel']>>;
    const model = this._model as LoadedModel;

    const context = await model.createContext();
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: 'You extract clinical data. Output compact JSON only. No explanation. No markdown. No <think> blocks.',
    });

    let rawOutput = '';
    await session.prompt(prompt, {
      temperature: 0.1,
      maxTokens: 4096,
      onTextChunk(chunk: string) { rawOutput += chunk; },
    });

    // Dispose context immediately — each extraction is independent
    await context.dispose();

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
