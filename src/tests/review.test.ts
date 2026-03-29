/**
 * Unit tests for terminal review mode (P5.3-F)
 * Run with: npx tsx src/tests/review.test.ts
 */
import assert from 'assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile, rm } from 'fs/promises';
import readline from 'readline';
import { EventEmitter } from 'events';

import type { ReviewQueue, ReviewQueueItem, ReviewResultItem } from '../commands/review.js';
import {
  runReviewLoop,
  writeReviewResults,
  printSummary,
  loadReviewQueue,
} from '../commands/review.js';

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

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeItem(
  id: string,
  displayName: string,
  confidence: number,
  section = 'medications'
): ReviewQueueItem {
  return {
    id,
    type: 'medication',
    displayName,
    confidence,
    sourceText: `Patient takes ${displayName}.`,
    status: 'active',
    section,
    queuedAt: new Date().toISOString(),
  };
}

function makeQueue(items: ReviewQueueItem[], podPath = '/tmp/test-pod'): ReviewQueue {
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    podPath,
    items,
  };
}

/**
 * Build a mock readline.Interface that feeds the given responses in order.
 * Each call to rl.question() consumes the next response from the array.
 */
function mockReadline(responses: string[]): readline.Interface {
  const emitter = new EventEmitter() as readline.Interface;
  let idx = 0;
  (emitter as unknown as Record<string, unknown>)['question'] = (
    _prompt: string,
    callback: (answer: string) => void
  ) => {
    const answer = responses[idx++] ?? '';
    // Defer to next tick so async flow works correctly
    setImmediate(() => callback(answer));
  };
  (emitter as unknown as Record<string, unknown>)['close'] = () => { /* no-op */ };
  return emitter;
}

// ── Tests: runReviewLoop ───────────────────────────────────────────────────────

console.log('\nrunReviewLoop\n');

await test('accepts an item when user enters "a"', async () => {
  const queue = makeQueue([makeItem('item-1', 'Aspirin', 0.70)]);
  const rl = mockReadline(['a']);
  const results = await runReviewLoop(queue, rl);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0]!.decision, 'accepted');
  assert.strictEqual(results[0]!.finalValue, 'Aspirin');
  assert.strictEqual(results[0]!.originalValue, 'Aspirin');
  assert.strictEqual(results[0]!.id, 'item-1');
});

await test('rejects an item when user enters "r"', async () => {
  const queue = makeQueue([makeItem('item-2', 'UnknownDrug', 0.55)]);
  const rl = mockReadline(['r']);
  const results = await runReviewLoop(queue, rl);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0]!.decision, 'rejected');
  assert.strictEqual(results[0]!.finalValue, 'UnknownDrug');
});

await test('skips an item when user enters "s"', async () => {
  const queue = makeQueue([makeItem('item-3', 'Metformin', 0.62)]);
  const rl = mockReadline(['s']);
  const results = await runReviewLoop(queue, rl);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0]!.decision, 'skipped');
});

await test('edits an item when user enters "e" then new value', async () => {
  const queue = makeQueue([makeItem('item-4', 'Lisinopril', 0.68)]);
  // 'e' → decision, then the new value
  const rl = mockReadline(['e', 'Lisinopril 10mg']);
  const results = await runReviewLoop(queue, rl);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0]!.decision, 'edited');
  assert.strictEqual(results[0]!.originalValue, 'Lisinopril');
  assert.strictEqual(results[0]!.finalValue, 'Lisinopril 10mg');
});

await test('retains original value when edit input is empty', async () => {
  const queue = makeQueue([makeItem('item-5', 'Warfarin', 0.71)]);
  // 'e' then empty string — should keep original
  const rl = mockReadline(['e', '']);
  const results = await runReviewLoop(queue, rl);

  assert.strictEqual(results[0]!.finalValue, 'Warfarin');
  assert.strictEqual(results[0]!.decision, 'edited');
});

await test('retries prompt on invalid input', async () => {
  const queue = makeQueue([makeItem('item-6', 'Aspirin', 0.70)]);
  // Two invalid inputs then a valid one
  const rl = mockReadline(['x', '?', 'a']);
  const results = await runReviewLoop(queue, rl);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0]!.decision, 'accepted');
});

await test('processes multiple items in order', async () => {
  const queue = makeQueue([
    makeItem('item-a', 'DrugA', 0.60),
    makeItem('item-b', 'DrugB', 0.75),
    makeItem('item-c', 'DrugC', 0.52),
  ]);
  const rl = mockReadline(['a', 'r', 's']);
  const results = await runReviewLoop(queue, rl);

  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0]!.decision, 'accepted');
  assert.strictEqual(results[1]!.decision, 'rejected');
  assert.strictEqual(results[2]!.decision, 'skipped');
});

await test('filters out items outside the review confidence band', async () => {
  const queue = makeQueue([
    makeItem('high', 'AutoDrug', 0.90),    // >= 0.85 — should be skipped
    makeItem('mid', 'ReviewDrug', 0.70),   // in band — should appear
    makeItem('low', 'DiscardDrug', 0.40),  // < 0.50 — should be skipped
  ]);
  const rl = mockReadline(['a']); // only one prompt expected
  const results = await runReviewLoop(queue, rl);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0]!.id, 'mid');
});

await test('returns empty array when queue has no review-band items', async () => {
  const queue = makeQueue([
    makeItem('high', 'AutoDrug', 0.95),
  ]);
  const rl = mockReadline([]);
  const results = await runReviewLoop(queue, rl);

  assert.strictEqual(results.length, 0);
});

await test('records reviewedAt as a valid ISO timestamp', async () => {
  const queue = makeQueue([makeItem('item-ts', 'TimeDrug', 0.65)]);
  const rl = mockReadline(['a']);
  const before = Date.now();
  const results = await runReviewLoop(queue, rl);
  const after = Date.now();

  const ts = new Date(results[0]!.reviewedAt).getTime();
  assert.ok(ts >= before && ts <= after, `reviewedAt ${results[0]!.reviewedAt} not in expected range`);
});

// ── Tests: writeReviewResults ─────────────────────────────────────────────────

console.log('\nwriteReviewResults\n');

await test('writes review-results.json with correct structure', async () => {
  const podPath = join(tmpdir(), `cascade-review-test-${Date.now()}`);
  const outputPath = join(podPath, 'analysis', 'review-results.json');

  const queue = makeQueue([], podPath);
  const results: ReviewResultItem[] = [
    {
      id: 'r1',
      decision: 'accepted',
      originalValue: 'Aspirin',
      finalValue: 'Aspirin',
      entityType: 'medication',
      section: 'medications',
      confidence: 0.70,
      reviewedAt: new Date().toISOString(),
    },
    {
      id: 'r2',
      decision: 'rejected',
      originalValue: 'BadDrug',
      finalValue: 'BadDrug',
      entityType: 'medication',
      section: 'medications',
      confidence: 0.55,
      reviewedAt: new Date().toISOString(),
    },
    {
      id: 'r3',
      decision: 'skipped',
      originalValue: 'SomeDrug',
      finalValue: 'SomeDrug',
      entityType: 'medication',
      section: 'medications',
      confidence: 0.60,
      reviewedAt: new Date().toISOString(),
    },
  ];

  try {
    await writeReviewResults(results, queue, outputPath);

    const raw = await readFile(outputPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      version: string;
      summary: { total: number; accepted: number; rejected: number; skipped: number; edited: number };
      items: ReviewResultItem[];
    };

    assert.strictEqual(parsed.version, '1.0');
    assert.strictEqual(parsed.summary.total, 3);
    assert.strictEqual(parsed.summary.accepted, 1);
    assert.strictEqual(parsed.summary.rejected, 1);
    assert.strictEqual(parsed.summary.skipped, 1);
    assert.strictEqual(parsed.summary.edited, 0);
    assert.strictEqual(parsed.items.length, 3);
    assert.ok('reviewedAt' in parsed, 'missing top-level reviewedAt');
    assert.ok('podPath' in parsed, 'missing podPath');
  } finally {
    await rm(podPath, { recursive: true, force: true });
  }
});

await test('creates output directory if it does not exist', async () => {
  const podPath = join(tmpdir(), `cascade-review-mkdir-${Date.now()}`);
  const outputPath = join(podPath, 'nested', 'deep', 'review-results.json');
  const queue = makeQueue([], podPath);

  try {
    await writeReviewResults([], queue, outputPath);
    const raw = await readFile(outputPath, 'utf-8');
    const parsed = JSON.parse(raw) as { summary: { total: number } };
    assert.strictEqual(parsed.summary.total, 0);
  } finally {
    await rm(podPath, { recursive: true, force: true });
  }
});

await test('edited items increment the edited count', async () => {
  const podPath = join(tmpdir(), `cascade-review-edited-${Date.now()}`);
  const outputPath = join(podPath, 'analysis', 'review-results.json');
  const queue = makeQueue([], podPath);

  const results: ReviewResultItem[] = [
    {
      id: 'e1',
      decision: 'edited',
      originalValue: 'OldDrug',
      finalValue: 'OldDrug 10mg',
      entityType: 'medication',
      section: 'medications',
      confidence: 0.65,
      reviewedAt: new Date().toISOString(),
    },
  ];

  try {
    await writeReviewResults(results, queue, outputPath);
    const parsed = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      summary: { edited: number };
    };
    assert.strictEqual(parsed.summary.edited, 1);
  } finally {
    await rm(podPath, { recursive: true, force: true });
  }
});

// ── Tests: loadReviewQueue ─────────────────────────────────────────────────────

console.log('\nloadReviewQueue\n');

await test('loads queue from file when server is not running', async () => {
  const podPath = join(tmpdir(), `cascade-queue-load-${Date.now()}`);
  const queuePath = join(podPath, 'analysis', 'review-queue.json');

  const sampleQueue: ReviewQueue = makeQueue(
    [makeItem('q1', 'TestDrug', 0.72)],
    podPath
  );

  const { mkdir: mkdirFn, writeFile: writeFn } = await import('fs/promises');
  await mkdirFn(join(podPath, 'analysis'), { recursive: true });
  await writeFn(queuePath, JSON.stringify(sampleQueue), 'utf-8');

  try {
    const loaded = await loadReviewQueue(podPath);
    assert.strictEqual(loaded.items.length, 1);
    assert.strictEqual(loaded.items[0]!.displayName, 'TestDrug');
    assert.strictEqual(loaded.podPath, podPath);
  } finally {
    await rm(podPath, { recursive: true, force: true });
  }
});

await test('throws descriptive error when queue not found', async () => {
  const podPath = join(tmpdir(), `cascade-queue-missing-${Date.now()}`);
  let didThrow = false;
  try {
    await loadReviewQueue(podPath);
  } catch (err) {
    didThrow = true;
    const msg = (err as Error).message;
    assert.ok(msg.includes('Review queue not found'), `unexpected message: ${msg}`);
    assert.ok(msg.includes('cascade-agent serve'), `message should mention serve: ${msg}`);
  }
  assert.ok(didThrow, 'expected loadReviewQueue to throw');
});

// ── Tests: printSummary ────────────────────────────────────────────────────────

console.log('\nprintSummary\n');

await test('does not throw with empty results', () => {
  // Should be a no-op — just ensure it does not throw
  printSummary([], '/tmp/test.json');
});

await test('does not throw with mixed decisions', () => {
  const results: ReviewResultItem[] = [
    { id: '1', decision: 'accepted', originalValue: 'A', finalValue: 'A', entityType: 'medication', section: 'medications', confidence: 0.70, reviewedAt: new Date().toISOString() },
    { id: '2', decision: 'rejected', originalValue: 'B', finalValue: 'B', entityType: 'medication', section: 'medications', confidence: 0.60, reviewedAt: new Date().toISOString() },
    { id: '3', decision: 'edited',   originalValue: 'C', finalValue: 'C2', entityType: 'medication', section: 'medications', confidence: 0.65, reviewedAt: new Date().toISOString() },
    { id: '4', decision: 'skipped',  originalValue: 'D', finalValue: 'D', entityType: 'medication', section: 'medications', confidence: 0.55, reviewedAt: new Date().toISOString() },
  ];
  printSummary(results, '/tmp/test.json');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
