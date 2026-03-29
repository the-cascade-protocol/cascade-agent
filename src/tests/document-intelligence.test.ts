/**
 * Unit tests for DocumentIntelligenceService
 * Run with: npx tsx src/tests/document-intelligence.test.ts
 */
import assert from 'assert';

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

// ── Mocks ─────────────────────────────────────────────────────────────────────

function mockOllamaWithModels(modelNames: string[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/tags')) {
      return new Response(
        JSON.stringify({ models: modelNames.map(name => ({ name })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return original(input);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function mockOllamaUnavailable(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nDocumentIntelligenceService\n');

await test('initialize() — selects first available preferred model (exact name match)', async () => {
  const { DocumentIntelligenceService } = await import('../services/document-intelligence.js');
  const svc = new DocumentIntelligenceService();
  const restore = mockOllamaWithModels(['qwen3.5:4b-instruct-q4_K_M']);
  try {
    await svc.initialize();
    assert.strictEqual(svc.isAvailable, true);
    assert.strictEqual(svc.currentModelId, 'qwen3.5:4b-instruct-q4_K_M');
  } finally {
    restore();
  }
});

await test('initialize() — falls back to qwen3 family when qwen3.5 unavailable', async () => {
  const { DocumentIntelligenceService } = await import('../services/document-intelligence.js');
  const svc = new DocumentIntelligenceService();
  // Only qwen3:4b available (third in preferredModels list), not qwen3.5 variants
  // The initialize loop checks startsWith(model.split(':')[0]) so qwen3.5 won't
  // match qwen3:4b since 'qwen3:4b'.startsWith('qwen3.5') === false.
  const restore = mockOllamaWithModels(['qwen3:4b']);
  try {
    await svc.initialize();
    assert.strictEqual(svc.isAvailable, true);
    assert.ok(
      svc.currentModelId === 'qwen3:4b' || svc.currentModelId?.startsWith('qwen3:'),
      `expected qwen3 model, got ${svc.currentModelId}`
    );
  } finally {
    restore();
  }
});

await test('initialize() — isAvailable=false when Ollama not running', async () => {
  const { DocumentIntelligenceService } = await import('../services/document-intelligence.js');
  const svc = new DocumentIntelligenceService();
  const restore = mockOllamaUnavailable();
  try {
    await svc.initialize();
    assert.strictEqual(svc.isAvailable, false);
    assert.strictEqual(svc.currentModelId, null);
  } finally {
    restore();
  }
});

await test('initialize() — isAvailable=false when no preferred model in Ollama', async () => {
  const { DocumentIntelligenceService } = await import('../services/document-intelligence.js');
  const svc = new DocumentIntelligenceService();
  // Models running but none are preferred
  const restore = mockOllamaWithModels(['llama3.2:3b', 'mistral:7b']);
  try {
    await svc.initialize();
    assert.strictEqual(svc.isAvailable, false);
    assert.strictEqual(svc.currentModelId, null);
  } finally {
    restore();
  }
});

await test('extractFromNarrative() — throws when no model available', async () => {
  const { DocumentIntelligenceService } = await import('../services/document-intelligence.js');
  const svc = new DocumentIntelligenceService();
  // Don't call initialize(), so modelId is null
  await assert.rejects(
    () => svc.extractFromNarrative('Patient takes aspirin.', 'medications'),
    /No model available/
  );
});

await test('isAvailable getter — false before initialize', async () => {
  const { DocumentIntelligenceService } = await import('../services/document-intelligence.js');
  const svc = new DocumentIntelligenceService();
  assert.strictEqual(svc.isAvailable, false);
  assert.strictEqual(svc.currentModelId, null);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
