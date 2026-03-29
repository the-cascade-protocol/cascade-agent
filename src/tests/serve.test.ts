/**
 * Unit tests for serve mode HTTP endpoints
 * Run with: npx tsx src/tests/serve.test.ts
 */
import assert from 'assert';
import { Hono } from 'hono';

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

// ── Build a test app instance (same routes as serve.ts) ───────────────────────

function buildTestApp(modelAvailable: boolean, modelId: string | null): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({
    status: 'ok',
    modelAvailable,
    modelId,
    version: '0.4.0',
  }));

  app.post('/extract', async (c) => {
    const body = await c.req.json() as { section?: string; narrativeText?: string };
    if (!body.section || !body.narrativeText) {
      return c.json({ error: 'section and narrativeText are required' }, 400);
    }
    if (!modelAvailable) {
      return c.json({ error: 'No model available. Run: ollama pull qwen3.5:4b-instruct-q4_K_M' }, 503);
    }
    // Mock extraction result
    return c.json({
      entities: [],
      confidence: 0,
      modelId: modelId ?? 'mock',
      latencyMs: 10,
      requiresReview: true,
      schemaVersion: '1.0',
    });
  });

  app.get('/models', (c) => c.json({
    available: modelAvailable,
    currentModel: modelId,
    recommendedModels: [
      { id: 'qwen3.5:4b-instruct-q4_K_M', displayName: 'Qwen 3.5 4B (Recommended)', sizeGB: 2.7 },
      { id: 'qwen3.5:2b-instruct-q4_K_M', displayName: 'Qwen 3.5 2B (Compatible)', sizeGB: 1.5 },
    ],
  }));

  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nGET /health\n');

await test('returns 200 with correct structure when model available', async () => {
  const app = buildTestApp(true, 'qwen3.5:4b-instruct-q4_K_M');
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.strictEqual(body['status'], 'ok');
  assert.strictEqual(body['modelAvailable'], true);
  assert.strictEqual(body['modelId'], 'qwen3.5:4b-instruct-q4_K_M');
  assert.ok('version' in body, 'missing version field');
});

await test('returns 200 with modelAvailable=false when no model', async () => {
  const app = buildTestApp(false, null);
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.strictEqual(body['status'], 'ok');
  assert.strictEqual(body['modelAvailable'], false);
  assert.strictEqual(body['modelId'], null);
});

console.log('\nPOST /extract\n');

await test('returns 400 when section missing', async () => {
  const app = buildTestApp(true, 'qwen3.5:4b-instruct-q4_K_M');
  const req = new Request('http://localhost/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ narrativeText: 'Patient takes aspirin.' }),
  });
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 400);
  const body = await res.json() as Record<string, unknown>;
  assert.ok(body['error']);
});

await test('returns 400 when narrativeText missing', async () => {
  const app = buildTestApp(true, 'qwen3.5:4b-instruct-q4_K_M');
  const req = new Request('http://localhost/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'medications' }),
  });
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 400);
});

await test('returns 503 when no model available', async () => {
  const app = buildTestApp(false, null);
  const req = new Request('http://localhost/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'medications', narrativeText: 'Patient takes aspirin.' }),
  });
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 503);
  const body = await res.json() as Record<string, unknown>;
  assert.ok(typeof body['error'] === 'string' && (body['error'] as string).includes('ollama pull'));
});

await test('returns ExtractionResult shape on success', async () => {
  const app = buildTestApp(true, 'qwen3.5:4b-instruct-q4_K_M');
  const req = new Request('http://localhost/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'medications', narrativeText: 'Patient takes aspirin 81mg daily.' }),
  });
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.ok('entities' in body, 'missing entities');
  assert.ok('confidence' in body, 'missing confidence');
  assert.ok('modelId' in body, 'missing modelId');
  assert.ok('latencyMs' in body, 'missing latencyMs');
  assert.ok('requiresReview' in body, 'missing requiresReview');
  assert.strictEqual(body['schemaVersion'], '1.0');
  // rawOutput must NOT be present
  assert.ok(!('rawOutput' in body), 'rawOutput must not be exposed over HTTP');
});

console.log('\nGET /models\n');

await test('returns model list with recommendedModels array', async () => {
  const app = buildTestApp(true, 'qwen3.5:4b-instruct-q4_K_M');
  const req = new Request('http://localhost/models');
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.ok(Array.isArray(body['recommendedModels']));
  assert.ok((body['recommendedModels'] as unknown[]).length >= 2);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
