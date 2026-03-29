import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import type { ExtractedEntity } from './document-intelligence.js';

interface LoincMatch {
  loincCode: string;
  loincDisplay: string;
  cascadePredicate?: string;
  unitUcum?: string;
}

interface ConditionMatch {
  icd10Code?: string;
  cascadeLabel: string;
}

export class TerminologyNormalizer {
  private db: Database.Database | null = null;

  constructor() {
    // Find clinical_knowledge.sqlite — prefer env var, then well-known path
    const candidates = [
      process.env.CLINICAL_KNOWLEDGE_DB,
      join(process.env.HOME ?? '~', 'Development', 'cascade-checkup', 'apple', 'CascadeCheckup', 'CascadeCheckup', 'Resources', 'clinical_knowledge.sqlite'),
    ].filter(Boolean) as string[];

    for (const path of candidates) {
      if (path && existsSync(path)) {
        try {
          this.db = new Database(path, { readonly: true });
          break;
        } catch { /* try next */ }
      }
    }

    if (!this.db) {
      console.error(
        '[terminology-normalizer] clinical_knowledge.sqlite not found. ' +
        'Set CLINICAL_KNOWLEDGE_DB env var. Normalization will be skipped.'
      );
    }
  }

  /** Normalize a single entity. Returns the entity unchanged if no DB is available. */
  normalizeEntity(entity: ExtractedEntity): ExtractedEntity {
    if (!this.db) return entity;

    if (entity.type === 'lab') {
      const match = this.normalizeLab(entity.displayName);
      if (match) {
        return { ...entity, normalizedCode: match.loincCode };
      }
    }

    if (entity.type === 'condition') {
      const match = this.normalizeCondition(entity.displayName);
      if (match) {
        return { ...entity, normalizedCode: match.icd10Code, displayName: match.cascadeLabel };
      }
    }

    return entity;
  }

  /** Normalize a batch of extracted entities. */
  normalizeEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
    return entities.map(e => this.normalizeEntity(e));
  }

  private normalizeLab(displayName: string): LoincMatch | null {
    if (!this.db) return null;
    const normalized = this.normalize(displayName);
    const expanded = this.expandAbbreviations(normalized);

    for (const name of [normalized, expanded]) {
      const row = this.db.prepare(
        'SELECT loinc_code, loinc_display, cascade_predicate, unit_ucum FROM loinc_map WHERE normalized_name = ? LIMIT 1'
      ).get(name) as { loinc_code: string; loinc_display: string; cascade_predicate?: string; unit_ucum?: string } | undefined;
      if (row) {
        return {
          loincCode: row.loinc_code,
          loincDisplay: row.loinc_display,
          cascadePredicate: row.cascade_predicate ?? undefined,
          unitUcum: row.unit_ucum ?? undefined,
        };
      }
    }
    return null;
  }

  private normalizeCondition(displayName: string): ConditionMatch | null {
    if (!this.db) return null;
    const normalized = this.normalize(displayName);

    const row = this.db.prepare(
      'SELECT icd10_code, cascade_label FROM condition_map WHERE normalized_name = ? LIMIT 1'
    ).get(normalized) as { icd10_code?: string; cascade_label: string } | undefined;

    if (row) {
      return { icd10Code: row.icd10_code ?? undefined, cascadeLabel: row.cascade_label };
    }
    return null;
  }

  private normalize(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  }

  private expandAbbreviations(text: string): string {
    const abbrevs: Record<string, string> = {
      'hba1c': 'hemoglobin a1c',
      'a1c': 'hemoglobin a1c',
      'tsh': 'thyroid stimulating hormone',
      'alt': 'alanine aminotransferase',
      'ast': 'aspartate aminotransferase',
      'bun': 'blood urea nitrogen',
      'wbc': 'white blood cell count',
      'rbc': 'red blood cell count',
      'ldl': 'ldl cholesterol',
      'hdl': 'hdl cholesterol',
      'dm2': 'type 2 diabetes',
      'htn': 'hypertension',
      'ckd': 'chronic kidney disease',
      'afib': 'atrial fibrillation',
    };
    return abbrevs[text] ?? text;
  }
}

export const terminologyNormalizer = new TerminologyNormalizer();
