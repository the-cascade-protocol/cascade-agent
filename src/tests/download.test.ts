/**
 * Tests for the fetch/stream model downloader that replaced node-llama-cpp's
 * createModelDownloader (2026-07-03 consolidation, Slice C). Mocks fetch at the
 * HTTP seam — no network, no native dependency — and writes only to a temp dir.
 *
 * Run with: npx tsx src/tests/download.test.ts
 */
import assert from 'assert';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { downloadToFile, modelDownloadUrl, LOCAL_MODELS, type DownloadProgress } from '../providers/local.js';

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

/** A fetch that serves `bytes` as a streamed body with a Content-Length header. */
function mockFetch(bytes: Uint8Array, opts: { status?: number; omitLength?: boolean } = {}): typeof fetch {
  return (async () => {
    const status = opts.status ?? 200;
    if (status >= 400) return new Response('not found', { status });
    const headers: Record<string, string> = {};
    if (!opts.omitLength) headers['content-length'] = String(bytes.length);
    // Pass an explicit ArrayBuffer body (a clean BodyInit) — a bare Uint8Array
    // trips a @types/node generic-union quirk under tsc.
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(body, { status, headers });
  }) as typeof fetch;
}

const workdir = mkdtempSync(join(tmpdir(), 'cascade-dl-'));
const origFetch = globalThis.fetch;

console.log('\nModel downloader (fetch/stream)\n');

await test('modelDownloadUrl points at the HuggingFace resolve endpoint', () => {
  const url = modelDownloadUrl(LOCAL_MODELS['4b']);
  assert.ok(url.startsWith('https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/'), url);
  assert.ok(url.endsWith('Qwen3.5-4B-Q4_K_M.gguf'), url);
});

await test('streams bytes to dest and reports progress to 100%', async () => {
  const bytes = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 256));
  globalThis.fetch = mockFetch(bytes);
  const dest = join(workdir, 'model-a.gguf');
  const progress: DownloadProgress[] = [];
  try {
    await downloadToFile('https://example/model', dest, (p) => progress.push(p));
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(existsSync(dest), 'dest written');
  assert.deepStrictEqual(new Uint8Array(readFileSync(dest)), bytes, 'bytes match exactly');
  assert.ok(progress.length > 0, 'progress reported');
  const last = progress[progress.length - 1]!;
  assert.strictEqual(last.downloaded, bytes.length);
  assert.strictEqual(last.total, bytes.length);
  assert.ok(Math.abs(last.percent - 100) < 1e-6, `final percent ${last.percent}`);
});

await test('atomic: no .part file remains after success', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  globalThis.fetch = mockFetch(bytes);
  const dest = join(workdir, 'model-b.gguf');
  try {
    await downloadToFile('https://example/model', dest);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(existsSync(dest), 'dest exists');
  assert.ok(!existsSync(`${dest}.part`), '.part cleaned up (renamed)');
});

await test('HTTP error throws and leaves no partial file', async () => {
  globalThis.fetch = mockFetch(new Uint8Array(), { status: 404 });
  const dest = join(workdir, 'model-c.gguf');
  try {
    await assert.rejects(() => downloadToFile('https://example/missing', dest), /HTTP 404/);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(!existsSync(dest), 'no dest on failure');
  assert.ok(!existsSync(`${dest}.part`), 'no leftover .part on failure');
});

await test('missing Content-Length: still downloads, percent stays 0', async () => {
  const bytes = new Uint8Array([9, 8, 7, 6]);
  globalThis.fetch = mockFetch(bytes, { omitLength: true });
  const dest = join(workdir, 'model-d.gguf');
  const progress: DownloadProgress[] = [];
  try {
    await downloadToFile('https://example/model', dest, (p) => progress.push(p));
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.deepStrictEqual(new Uint8Array(readFileSync(dest)), bytes);
  assert.ok(progress.every((p) => p.total === 0 && p.percent === 0), 'percent 0 without length');
  assert.strictEqual(progress[progress.length - 1]!.downloaded, bytes.length);
});

rmSync(workdir, { recursive: true, force: true });

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
