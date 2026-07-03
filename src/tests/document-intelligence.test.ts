/**
 * Tests for the llama-server-backed DocumentIntelligenceService + POST /extract.
 *
 * The 2026-07-03 local-inference consolidation replaced the in-process
 * node-llama-cpp extraction stack with a llama-server HTTP client. These tests
 * mock llama-server at the HTTP seam (an injected `fetch` + an external URL), so
 * they run with NO GPU, NO model file, and NO network. They replace the stale
 * Ollama-era suite that predated the March node-llama-cpp rewrite.
 *
 * Run with: npx tsx src/tests/document-intelligence.test.ts
 */
import assert from 'assert';
import { Hono } from 'hono';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DocumentIntelligenceService,
  type CDASection,
  type ExtractionResult,
} from '../services/document-intelligence.js';
import {
  buildChatRequest,
  EXTRACTION_GRAMMAR,
  LlamaServerManager,
} from '../services/llama-server.js';

// ── Test harness ──────────────────────────────────────────────────────────────

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

const MOCK_URL = 'http://127.0.0.1:59999';

interface MockOptions {
  /** GET /health status. Default 200 (ready). */
  healthOk?: boolean;
  /** The assistant message content returned by /v1/chat/completions. */
  content?: string;
  /** Force a non-2xx completion response with this status. */
  completionStatus?: number;
  /** Records each completion request body for assertions. */
  onCompletion?: (body: unknown) => void;
}

/** A fetch that emulates a llama-server at MOCK_URL. No real socket is opened. */
function mockLlamaFetch(opts: MockOptions = {}): typeof fetch {
  const healthOk = opts.healthOk ?? true;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({ status: healthOk ? 'ok' : 'loading model' }), {
        status: healthOk ? 200 : 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/chat/completions')) {
      if (opts.onCompletion) opts.onCompletion(JSON.parse(String(init?.body ?? '{}')));
      if (opts.completionStatus && opts.completionStatus >= 400) {
        return new Response('context size exceeded', { status: opts.completionStatus });
      }
      return new Response(
        JSON.stringify({
          model: 'mock-qwen',
          choices: [{ message: { content: opts.content ?? '[]' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

function svc(opts: MockOptions = {}): DocumentIntelligenceService {
  return new DocumentIntelligenceService({
    externalUrl: MOCK_URL,
    fetchImpl: mockLlamaFetch(opts),
  });
}

// A realistic grammar-constrained extraction reply.
const MED_ARRAY = JSON.stringify([
  { displayName: 'Aspirin 81mg', status: 'active', confidence: 0.95, sourceText: 'aspirin 81 mg daily' },
  { displayName: 'Metformin', status: 'active', confidence: 0.7, sourceText: 'metformin 500 mg' },
]);

// ── buildChatRequest + grammar (pure) ─────────────────────────────────────────

console.log('\nbuildChatRequest + EXTRACTION_GRAMMAR\n');

await test('grammar constrains output to a JSON array of objects', () => {
  assert.ok(EXTRACTION_GRAMMAR.includes('root'), 'grammar has a root rule');
  assert.ok(EXTRACTION_GRAMMAR.includes('object'), 'grammar defines objects');
  assert.ok(EXTRACTION_GRAMMAR.trimStart().startsWith('root'), 'root is first');
});

await test('disables thinking + carries system, sampling, and grammar', () => {
  const body = buildChatRequest('user text', {
    system: 'sys',
    temperature: 0.1,
    maxTokens: 4096,
    grammar: EXTRACTION_GRAMMAR,
  });
  assert.strictEqual(body.chat_template_kwargs.enable_thinking, false, 'thinking must be off (Qwen empty-content gotcha)');
  assert.strictEqual(body.stream, false);
  assert.strictEqual(body.temperature, 0.1);
  assert.strictEqual(body.max_tokens, 4096);
  assert.strictEqual(body.grammar, EXTRACTION_GRAMMAR);
  assert.strictEqual(body.messages[0]?.role, 'system');
  assert.strictEqual(body.messages[0]?.content, 'sys');
  assert.strictEqual(body.messages[1]?.role, 'user');
  assert.strictEqual(body.messages[1]?.content, 'user text');
});

// ── initialize() / availability ───────────────────────────────────────────────

console.log('\nDocumentIntelligenceService — availability\n');

await test('isAvailable=false before initialize', () => {
  const s = svc();
  assert.strictEqual(s.isAvailable, false);
  assert.strictEqual(s.currentModelId, null);
});

await test('initialize() attaches to a healthy external server → isAvailable=true', async () => {
  const s = svc({ healthOk: true });
  await s.initialize();
  assert.strictEqual(s.isAvailable, true);
  assert.strictEqual(typeof s.currentModelId, 'string');
});

await test('initialize() leaves isAvailable=false when the server is unhealthy', async () => {
  const s = svc({ healthOk: false });
  await s.initialize();
  assert.strictEqual(s.isAvailable, false);
  assert.strictEqual(s.currentModelId, null);
});

await test('modelFilePresent=true when an external URL is configured (nothing to download)', () => {
  assert.strictEqual(svc().modelFilePresent, true);
});

await test('modelFilePresent=false with no external URL and no model file on disk', () => {
  const s = new DocumentIntelligenceService({
    modelPath: join(tmpdir(), 'cascade-nonexistent-model.gguf'),
    fetchImpl: mockLlamaFetch(),
  });
  assert.strictEqual(s.modelFilePresent, false);
});

// ── extractFromNarrative() ────────────────────────────────────────────────────

console.log('\nDocumentIntelligenceService — extractFromNarrative\n');

await test('parses the grammar-constrained array into typed entities', async () => {
  const s = svc({ content: MED_ARRAY });
  const result = await s.extractFromNarrative('Patient takes aspirin 81 mg daily and metformin 500 mg.', 'medications');
  assert.strictEqual(result.entities.length, 2);
  assert.strictEqual(result.entities[0]!.displayName, 'Aspirin 81mg');
  assert.strictEqual(result.entities[0]!.type, 'medication'); // section default when absent
  assert.strictEqual(result.entities[0]!.confidence, 0.95);
  assert.strictEqual(result.schemaVersion, '1.0');
  assert.ok(result.latencyMs >= 0);
  assert.ok(Math.abs(result.confidence - 0.825) < 1e-9, `avg confidence ${result.confidence}`);
  assert.strictEqual(result.requiresReview, true); // avg < 0.85
});

await test('sends the extraction grammar, thinking-off, and the section template', async () => {
  let seen: any = null;
  const s = svc({ content: '[]', onCompletion: (b) => { seen = b; } });
  await s.extractFromNarrative('Patient denies smoking.', 'socialHistory');
  assert.ok(seen, 'a completion request was made');
  assert.strictEqual(seen.grammar, EXTRACTION_GRAMMAR, 'grammar attached');
  assert.strictEqual(seen.chat_template_kwargs.enable_thinking, false);
  assert.strictEqual(seen.messages[0].role, 'system');
  assert.ok(String(seen.messages[1].content).includes('Patient denies smoking.'), 'narrative interpolated into template');
  assert.ok(String(seen.messages[1].content).includes('social history') || String(seen.messages[1].content).toLowerCase().includes('social'), 'social-history template used');
});

await test('maps name/source aliases and drops entries with empty displayName', async () => {
  const content = JSON.stringify([
    { name: 'Penicillin', source: 'allergic to penicillin', confidence: 0.9 },
    { displayName: '', confidence: 0.8, sourceText: 'noise' },
  ]);
  const s = svc({ content });
  const result = await s.extractFromNarrative('Allergic to penicillin.', 'allergies');
  assert.strictEqual(result.entities.length, 1, 'empty-displayName entry filtered');
  assert.strictEqual(result.entities[0]!.displayName, 'Penicillin');
  assert.strictEqual(result.entities[0]!.sourceText, 'allergic to penicillin');
  assert.strictEqual(result.entities[0]!.type, 'allergy');
});

await test('malformed model output → empty entities, zero confidence (no throw)', async () => {
  const s = svc({ content: 'I could not find anything useful.' });
  const result = await s.extractFromNarrative('...', 'conditions');
  assert.deepStrictEqual(result.entities, []);
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.requiresReview, true);
});

await test('recovers a JSON array embedded in stray prose', async () => {
  const content = 'Here you go: [{"displayName":"Hypertension","confidence":0.88,"sourceText":"HTN"}] done';
  const s = svc({ content });
  const result = await s.extractFromNarrative('HTN', 'conditions');
  assert.strictEqual(result.entities.length, 1);
  assert.strictEqual(result.entities[0]!.displayName, 'Hypertension');
});

await test('extractFromNarrative rejects when no model and no external server', async () => {
  const s = new DocumentIntelligenceService({
    modelPath: join(tmpdir(), 'cascade-nonexistent-model.gguf'),
    fetchImpl: mockLlamaFetch(),
  });
  await assert.rejects(
    () => s.extractFromNarrative('Patient takes aspirin.', 'medications'),
    /No extraction model available/,
  );
});

// ── LlamaServerManager.complete error mapping ─────────────────────────────────

console.log('\nLlamaServerManager\n');

await test('complete() surfaces a non-2xx llama-server response as an error', async () => {
  const mgr = new LlamaServerManager({ externalUrl: MOCK_URL, fetchImpl: mockLlamaFetch({ completionStatus: 500 }) });
  await mgr.ensureRunning();
  await assert.rejects(() => mgr.complete(buildChatRequest('x')), /llama-server 500/);
});

await test('a completion HTTP error propagates so /extract can return 500', async () => {
  const s = svc({ completionStatus: 500 });
  await assert.rejects(() => s.extractFromNarrative('x', 'medications'), /llama-server 500/);
});

// ── POST /extract route contract (mirrors serve.ts, injected service) ─────────

console.log('\nPOST /extract — endpoint contract\n');

/** Mount the /extract + /health routes exactly as serve.ts wires them. */
function buildExtractApp(service: DocumentIntelligenceService): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({
    status: 'ok',
    modelAvailable: service.isAvailable,
    modelPresent: service.modelFilePresent,
    modelId: service.currentModelId,
    version: '0.4.0',
  }));
  app.post('/extract', async (c) => {
    const body = await c.req.json() as { section?: string; narrativeText?: string };
    if (!body.section || !body.narrativeText) {
      return c.json({ error: 'section and narrativeText are required' }, 400);
    }
    if (!service.isAvailable && service.modelFilePresent) {
      await service.initialize();
    }
    if (!service.isAvailable) {
      return c.json({ error: 'No extraction model available. Download it with `cascade-agent login --provider local`.' }, 503);
    }
    try {
      const result = await service.extractFromNarrative(body.narrativeText, body.section as CDASection);
      const { rawOutput: _rawOutput, ...safeResult } = result;
      return c.json(safeResult as Omit<ExtractionResult, 'rawOutput'>);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });
  return app;
}

await test('400 when section or narrativeText missing', async () => {
  const app = buildExtractApp(svc({ content: MED_ARRAY }));
  const res = await app.fetch(new Request('http://localhost/extract', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ narrativeText: 'x' }),
  }));
  assert.strictEqual(res.status, 400);
});

await test('503 when no model is available (no server, no file)', async () => {
  const service = new DocumentIntelligenceService({
    modelPath: join(tmpdir(), 'cascade-nonexistent-model.gguf'),
    fetchImpl: mockLlamaFetch(),
  });
  const app = buildExtractApp(service);
  const res = await app.fetch(new Request('http://localhost/extract', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ section: 'medications', narrativeText: 'aspirin' }),
  }));
  assert.strictEqual(res.status, 503);
});

await test('200 with ExtractionResult shape; rawOutput never leaves the process', async () => {
  const app = buildExtractApp(svc({ content: MED_ARRAY }));
  const res = await app.fetch(new Request('http://localhost/extract', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ section: 'medications', narrativeText: 'aspirin 81 mg' }),
  }));
  assert.strictEqual(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  for (const k of ['entities', 'confidence', 'modelId', 'latencyMs', 'requiresReview', 'schemaVersion']) {
    assert.ok(k in body, `missing ${k}`);
  }
  assert.strictEqual(body['schemaVersion'], '1.0');
  assert.ok(!('rawOutput' in body), 'rawOutput must NOT be exposed over HTTP');
});

await test('/health reports modelAvailable + modelPresent', async () => {
  const app = buildExtractApp(svc({ healthOk: true }));
  const res = await app.fetch(new Request('http://localhost/health'));
  const body = await res.json() as Record<string, unknown>;
  assert.strictEqual(body['status'], 'ok');
  assert.ok('modelAvailable' in body);
  assert.ok('modelPresent' in body);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
