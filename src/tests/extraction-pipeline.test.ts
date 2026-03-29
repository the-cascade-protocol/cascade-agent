/**
 * Unit tests for runExtractionPipeline
 * Run with: npx tsx src/tests/extraction-pipeline.test.ts
 */
import assert from 'assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile, rm } from 'fs/promises';

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

// ── Mock document intelligence ────────────────────────────────────────────────

import type { ExtractionResult, ExtractedEntity } from '../services/document-intelligence.js';

function makeEntity(displayName: string, confidence: number): ExtractedEntity {
  return {
    type: 'medication',
    displayName,
    confidence,
    sourceText: displayName,
    status: 'active',
  };
}

function makeResult(entities: ExtractedEntity[], modelId = 'test-model'): ExtractionResult {
  const avg = entities.length > 0
    ? entities.reduce((s, e) => s + e.confidence, 0) / entities.length
    : 0;
  return {
    entities,
    confidence: avg,
    modelId,
    latencyMs: 100,
    requiresReview: avg < 0.85,
    schemaVersion: '1.0',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nrunExtractionPipeline\n');

await test('routes entities by confidence thresholds', async () => {
  // Patch documentIntelligence singleton before importing pipeline
  const diModule = await import('../services/document-intelligence.js');
  const originalExtract = diModule.documentIntelligence.extractFromNarrative.bind(diModule.documentIntelligence);

  const entities = [
    makeEntity('Aspirin', 0.95),       // autoAccepted
    makeEntity('Metformin', 0.70),     // needsReview
    makeEntity('UnknownDrug', 0.30),   // discarded
  ];

  // Monkey-patch extractFromNarrative
  (diModule.documentIntelligence as unknown as Record<string, unknown>)['extractFromNarrative'] =
    async (_text: string, _section: unknown) => makeResult(entities);

  const { runExtractionPipeline } = await import('../services/extraction-pipeline.js');
  const podPath = join(tmpdir(), `cascade-test-${Date.now()}`);

  try {
    const { routed } = await runExtractionPipeline(
      [{ section: 'medications', narrativeText: 'Patient takes aspirin.', requiresLLMExtraction: true }],
      podPath
    );

    assert.strictEqual(routed.length, 1);
    assert.strictEqual(routed[0]!.autoAccepted.length, 1);
    assert.strictEqual(routed[0]!.autoAccepted[0]!.displayName, 'Aspirin');
    assert.strictEqual(routed[0]!.needsReview.length, 1);
    assert.strictEqual(routed[0]!.needsReview[0]!.displayName, 'Metformin');
    assert.strictEqual(routed[0]!.discarded.length, 1);
    assert.strictEqual(routed[0]!.discarded[0]!.displayName, 'UnknownDrug');
  } finally {
    // Restore
    (diModule.documentIntelligence as unknown as Record<string, unknown>)['extractFromNarrative'] = originalExtract;
    await rm(podPath, { recursive: true, force: true });
  }
});

await test('skips blocks with requiresLLMExtraction=false', async () => {
  const diModule = await import('../services/document-intelligence.js');
  let callCount = 0;
  const original = diModule.documentIntelligence.extractFromNarrative.bind(diModule.documentIntelligence);
  (diModule.documentIntelligence as unknown as Record<string, unknown>)['extractFromNarrative'] =
    async (_text: string, _section: unknown) => { callCount++; return makeResult([]); };

  const { runExtractionPipeline } = await import('../services/extraction-pipeline.js');
  const podPath = join(tmpdir(), `cascade-test-${Date.now()}`);

  try {
    await runExtractionPipeline(
      [
        { section: 'medications', narrativeText: 'Some text', requiresLLMExtraction: false },
        { section: 'conditions', narrativeText: '', requiresLLMExtraction: true },
      ],
      podPath
    );
    assert.strictEqual(callCount, 0, `expected 0 calls, got ${callCount}`);
  } finally {
    (diModule.documentIntelligence as unknown as Record<string, unknown>)['extractFromNarrative'] = original;
    await rm(podPath, { recursive: true, force: true });
  }
});

await test('writes discarded-extractions.ttl to pod/analysis/', async () => {
  const diModule = await import('../services/document-intelligence.js');
  const entities = [makeEntity('LowConfDrug', 0.20)];
  const original = diModule.documentIntelligence.extractFromNarrative.bind(diModule.documentIntelligence);
  (diModule.documentIntelligence as unknown as Record<string, unknown>)['extractFromNarrative'] =
    async (_text: string, _section: unknown) => makeResult(entities);

  const { runExtractionPipeline } = await import('../services/extraction-pipeline.js');
  const podPath = join(tmpdir(), `cascade-test-${Date.now()}`);

  try {
    const { discardedLogPath } = await runExtractionPipeline(
      [{ section: 'medications', narrativeText: 'Patient takes unknown drug.', requiresLLMExtraction: true }],
      podPath
    );

    const ttl = await readFile(discardedLogPath, 'utf-8');
    assert.ok(ttl.includes('cascade:AIDiscardedExtraction'), 'TTL missing AIDiscardedExtraction class');
    assert.ok(ttl.includes('cascade:discardedEntityType'), 'TTL missing discardedEntityType');
    assert.ok(ttl.includes('cascade:discardConfidence'), 'TTL missing discardConfidence');
  } finally {
    (diModule.documentIntelligence as unknown as Record<string, unknown>)['extractFromNarrative'] = original;
    await rm(podPath, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
