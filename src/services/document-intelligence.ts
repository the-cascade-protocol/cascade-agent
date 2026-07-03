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
import {
  LlamaServerManager,
  buildChatRequest,
  EXTRACTION_GRAMMAR,
} from './llama-server.js';

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

/** Test/DI seams: inject an external URL + fetch to exercise the HTTP path without a model. */
export interface DocumentIntelligenceOptions {
  /** Attach to this llama-server instead of spawning one. Default env CASCADE_LLAMA_URL. */
  externalUrl?: string;
  /** GGUF model path for a managed spawn. Default: config local.baseUrl → MODELS_DIR default. */
  modelPath?: string;
  /** Injected fetch (tests mock llama-server at this seam). Default the global `fetch`. */
  fetchImpl?: typeof fetch;
}

function loadTemplates(): Record<string, string> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const templatesPath = join(__dirname, '..', 'prompts', 'extraction', 'templates.json');
  return JSON.parse(readFileSync(templatesPath, 'utf-8')) as Record<string, string>;
}

/** System directive for extraction. Belt-and-suspenders with the grammar. */
const EXTRACTION_SYSTEM =
  'You extract clinical data. Output compact JSON only. No explanation. No markdown. No <think> blocks.';

/**
 * Document intelligence service for clinical narrative extraction.
 *
 * Backs `POST /extract` in serve mode. As of the 2026-07-03 local-inference
 * consolidation this is a thin **llama-server** (llama.cpp) HTTP client — NOT an
 * in-process node-llama-cpp stack. It attaches to `CASCADE_LLAMA_URL` when set
 * (a Workbench session's shared server) or lazily spawns + supervises a managed
 * `llama-server` from the local GGUF. Output is constrained by the JSON-array
 * GBNF grammar shared with the Workbench extraction path.
 *
 * Model location (managed spawn): ~/.config/cascade-agent/models/ (configured
 * via `cascade agent login --provider local`). If neither a model file nor an
 * external URL is available, the service operates in structured-only mode and
 * `/extract` returns 503.
 */
export class DocumentIntelligenceService {
  private readonly modelPath: string;
  private readonly hasExternalUrl: boolean;
  private readonly server: LlamaServerManager;
  private _serverReady = false;
  private _initPromise: Promise<void> | null = null;

  constructor(opts: DocumentIntelligenceOptions = {}) {
    // Prefer the configured model path (baseUrl) over the default filename, so the
    // managed spawn uses whichever model the user actually downloaded.
    const config = loadConfig();
    const configuredPath = config.providers?.local?.baseUrl;
    this.modelPath = opts.modelPath
      ?? ((configuredPath && existsSync(configuredPath))
        ? configuredPath
        : join(MODELS_DIR, DEFAULT_LOCAL_MODEL_FILENAME));

    const externalUrl = opts.externalUrl ?? process.env['CASCADE_LLAMA_URL'] ?? undefined;
    this.hasExternalUrl = externalUrl !== undefined && externalUrl.trim().length > 0;

    this.server = new LlamaServerManager({
      externalUrl,
      modelPath: this.modelPath,
      fetchImpl: opts.fetchImpl,
    });
  }

  /**
   * Bring the llama-server backend up (attach or managed-spawn) and confirm it
   * is healthy. Safe to call repeatedly — single-flighted so concurrent
   * `/extract` requests share one spawn. Does not download the model; call
   * ensureModel() first if the managed model file may be absent.
   */
  async initialize(): Promise<void> {
    if (this._serverReady) return;
    if (!this._initPromise) {
      this._initPromise = this.bringUp().finally(() => {
        this._initPromise = null;
      });
    }
    return this._initPromise;
  }

  private async bringUp(): Promise<void> {
    // Nothing to attach to and no model on disk → structured-only mode.
    if (!this.hasExternalUrl && !existsSync(this.modelPath)) return;
    try {
      await this.server.ensureRunning();
      this._serverReady = await this.server.health();
    } catch (err) {
      console.error('[cascade-agent] Failed to start extraction llama-server:', (err as Error).message);
      this._serverReady = false;
    }
  }

  /**
   * Download the managed model if absent, then initialize. Used by
   * `cascade-agent serve` when no model is found at startup.
   */
  async ensureModel(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    await this.ensureModelDownloaded(onProgress);
    await this.initialize();
  }

  /**
   * Download the managed model file if absent, WITHOUT starting the server.
   * No-op when attaching to an external server (it owns its own model).
   */
  async ensureModelDownloaded(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (this.hasExternalUrl) return;
    if (!existsSync(this.modelPath)) {
      await downloadDefaultModel(onProgress);
    }
  }

  /** Server up + model loaded (last known). */
  get isAvailable(): boolean {
    return this._serverReady;
  }

  /**
   * True when extraction is serviceable on disk: an external server is
   * configured (nothing to download), or the managed GGUF exists.
   */
  get modelFilePresent(): boolean {
    return this.hasExternalUrl || existsSync(this.modelPath);
  }

  /** The model identifier, or null when the server is not ready. */
  get currentModelId(): string | null {
    return this._serverReady ? this.server.modelId : null;
  }

  async extractFromNarrative(text: string, section: CDASection): Promise<ExtractionResult> {
    // Ensure the backend is up (idempotent; makes direct callers work too).
    if (!this._serverReady) await this.initialize();
    if (!this._serverReady) {
      throw new Error(
        'No extraction model available.\n' +
        'Run: cascade-agent serve   (will prompt to download the model)\n' +
        'Or set CASCADE_LLAMA_URL to attach to a running llama-server.'
      );
    }

    const startMs = Date.now();
    const prompt = buildPrompt(section, text);
    const body = buildChatRequest(prompt, {
      system: EXTRACTION_SYSTEM,
      temperature: 0.1,
      maxTokens: 4096,
      grammar: EXTRACTION_GRAMMAR,
    });

    let rawOutput = await this.server.complete(body);
    // The grammar already forbids <think> blocks, but stay tolerant of a model
    // that ignores it under some template.
    rawOutput = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    const latencyMs = Date.now() - startMs;
    const entities = parseEntities(rawOutput, section);

    const overallConfidence = entities.length > 0
      ? entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length
      : 0;

    return {
      entities,
      confidence: overallConfidence,
      modelId: this.server.modelId,
      latencyMs,
      requiresReview: overallConfidence < 0.85,
      rawOutput,
      schemaVersion: '1.0',
    };
  }
}

/** Parse the grammar-constrained JSON array into typed entities (tolerant). */
function parseEntities(rawOutput: string, section: CDASection): ExtractedEntity[] {
  const jsonText = firstJsonArray(rawOutput);
  if (!jsonText) return [];
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e) => ({
      type: (e['type'] as ExtractedEntity['type']) ?? sectionToEntityType(section),
      displayName: (e['displayName'] as string) ?? (e['name'] as string) ?? '',
      confidence: typeof e['confidence'] === 'number' ? e['confidence'] : 0.7,
      sourceText: (e['sourceText'] as string) ?? (e['source'] as string) ?? '',
      status: (e['status'] as string) ?? 'unknown',
      normalizedCode: e['normalizedCode'] as string | undefined,
    })).filter((e: ExtractedEntity) => e.displayName.length > 0);
  } catch {
    return [];
  }
}

/** The grammar emits a bare array; fall back to the first [...] span otherwise. */
function firstJsonArray(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return trimmed;
  const match = trimmed.match(/\[[\s\S]*\]/);
  return match ? match[0] : null;
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
