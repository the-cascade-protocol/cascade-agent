import { documentIntelligence, ExtractedEntity, ExtractionResult, CDASection } from './document-intelligence.js';
import { terminologyNormalizer } from './terminology-normalizer.js';
import { writeFile } from 'fs/promises';
import { join, dirname } from 'path';

export interface ConfidenceRoutedOutput {
  autoAccepted: ExtractedEntity[];     // confidence >= 0.85
  needsReview: ExtractedEntity[];      // confidence 0.50–0.84
  discarded: ExtractedEntity[];        // confidence < 0.50
  result: ExtractionResult;
}

export interface DiscardedExtraction {
  entityType: string;
  displayName: string;
  discardedFrom: string;
  discardedAt: string;
  discardConfidence: number;
  sourceText: string;
}

export async function runExtractionPipeline(
  narrativeBlocks: { section: string; narrativeText: string; requiresLLMExtraction: boolean }[],
  podPath: string
): Promise<{ routed: ConfidenceRoutedOutput[]; discardedLogPath: string }> {
  const routed: ConfidenceRoutedOutput[] = [];
  const allDiscarded: DiscardedExtraction[] = [];

  for (const block of narrativeBlocks) {
    if (!block.requiresLLMExtraction || !block.narrativeText.trim()) continue;

    const section = block.section as CDASection;
    const result = await documentIntelligence.extractFromNarrative(block.narrativeText, section);

    // Stage 2: Terminology normalization — map lab names to LOINC, conditions to ICD-10
    result.entities = terminologyNormalizer.normalizeEntities(result.entities);

    const autoAccepted: ExtractedEntity[] = [];
    const needsReview: ExtractedEntity[] = [];
    const discarded: ExtractedEntity[] = [];

    for (const entity of result.entities) {
      if (entity.confidence >= 0.85) {
        autoAccepted.push(entity);
      } else if (entity.confidence >= 0.50) {
        needsReview.push(entity);
      } else {
        discarded.push(entity);
        allDiscarded.push({
          entityType: entity.type,
          displayName: entity.displayName,
          discardedFrom: block.section,
          discardedAt: new Date().toISOString(),
          discardConfidence: entity.confidence,
          sourceText: entity.sourceText,
        });
      }
    }

    routed.push({ autoAccepted, needsReview, discarded, result });
  }

  // Write discarded extractions to pod/analysis/discarded-extractions.ttl
  const discardLogPath = join(podPath, 'analysis', 'discarded-extractions.ttl');
  await writeDiscardLog(allDiscarded, discardLogPath);

  return { routed, discardedLogPath: discardLogPath };
}

async function writeDiscardLog(discarded: DiscardedExtraction[], outputPath: string): Promise<void> {
  const { mkdir } = await import('fs/promises');
  await mkdir(dirname(outputPath), { recursive: true });

  let ttl = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
# Discarded AI extractions — patient-owned audit log
# Generated: ${new Date().toISOString()}

`;

  for (const d of discarded) {
    const id = `urn:cascade:discarded:${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ttl += `<${id}> a cascade:AIDiscardedExtraction ;
    cascade:discardedEntityType "${d.entityType}" ;
    cascade:discardedFrom "${d.discardedFrom}" ;
    cascade:discardedAt "${d.discardedAt}"^^xsd:dateTime ;
    cascade:discardConfidence "${d.discardConfidence}"^^xsd:decimal .

`;
  }

  await writeFile(outputPath, ttl, 'utf-8');
}
