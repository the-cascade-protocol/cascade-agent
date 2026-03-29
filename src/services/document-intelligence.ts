import { Ollama } from 'ollama';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

export class DocumentIntelligenceService {
  private modelId: string | null = null;
  private readonly preferredModels = [
    'qwen3.5:4b-instruct-q4_K_M',
    'qwen3.5:2b-instruct-q4_K_M',
    'qwen3:4b',
    'qwen3:2b',
  ];

  async initialize(): Promise<void> {
    // Try each preferred model in order
    for (const model of this.preferredModels) {
      try {
        const response = await fetch('http://localhost:11434/api/tags');
        if (!response.ok) break;
        const { models } = await response.json() as { models: { name: string }[] };
        if (models.some(m => m.name === model || m.name.startsWith(model.split(':')[0]))) {
          this.modelId = model;
          return;
        }
      } catch {
        // Ollama not running
        break;
      }
    }
    // No model available — operate in structured-only mode
    console.error('[cascade-agent] No Ollama model available. Run: ollama pull qwen3.5:4b-instruct-q4_K_M');
  }

  get isAvailable(): boolean {
    return this.modelId !== null;
  }

  get currentModelId(): string | null {
    return this.modelId;
  }

  async extractFromNarrative(text: string, section: CDASection): Promise<ExtractionResult> {
    if (!this.modelId) {
      throw new Error('No model available. Run: ollama pull qwen3.5:4b-instruct-q4_K_M');
    }

    const startMs = Date.now();
    const prompt = buildPrompt(section, text);

    const ollama = new Ollama();
    const response = await ollama.generate({
      model: this.modelId,
      prompt,
      options: { temperature: 0.1, num_predict: 4096 },
      // Suppress thinking mode
      system: 'You extract clinical data. Output compact JSON only. No explanation. No markdown. No <think> blocks.',
    });

    const rawOutput = response.response
      .replace(/<think>[\s\S]*?<\/think>/g, '')  // strip thinking blocks
      .trim();

    const latencyMs = Date.now() - startMs;

    let entities: ExtractedEntity[] = [];
    try {
      // Find JSON array in output
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
      modelId: this.modelId,
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
