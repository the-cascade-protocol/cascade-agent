import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomBytes } from 'crypto';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { documentIntelligence, CDASection } from '../services/document-intelligence.js';
import type { ExtractionResult } from '../services/document-intelligence.js';

const DEFAULT_PORT = 8765;

export async function runServeMode(port: number = DEFAULT_PORT): Promise<void> {
  await documentIntelligence.initialize();

  // Generate session token
  const sessionToken = randomBytes(32).toString('hex');
  const configDir = join(homedir(), '.config', 'cascade-agent');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'session-token'), sessionToken, { mode: 0o600 });

  const app = new Hono();

  // Health check
  app.get('/health', (c) => c.json({
    status: 'ok',
    modelAvailable: documentIntelligence.isAvailable,
    modelId: documentIntelligence.currentModelId,
    version: process.env['npm_package_version'] ?? '0.4.0',
  }));

  // Extract endpoint
  app.post('/extract', async (c) => {
    const body = await c.req.json() as { section: string; narrativeText: string; vendor?: string };
    if (!body.section || !body.narrativeText) {
      return c.json({ error: 'section and narrativeText are required' }, 400);
    }
    if (!documentIntelligence.isAvailable) {
      return c.json({ error: 'No model available. Run: ollama pull qwen3.5:4b-instruct-q4_K_M' }, 503);
    }
    try {
      const result = await documentIntelligence.extractFromNarrative(
        body.narrativeText,
        body.section as CDASection
      );
      // Remove rawOutput before sending over HTTP
      const { rawOutput: _rawOutput, ...safeResult } = result;
      return c.json(safeResult as Omit<ExtractionResult, 'rawOutput'>);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Models endpoint
  app.get('/models', (c) => c.json({
    available: documentIntelligence.isAvailable,
    currentModel: documentIntelligence.currentModelId,
    recommendedModels: [
      { id: 'qwen3.5:4b-instruct-q4_K_M', displayName: 'Qwen 3.5 4B (Recommended)', sizeGB: 2.7 },
      { id: 'qwen3.5:2b-instruct-q4_K_M', displayName: 'Qwen 3.5 2B (Compatible)', sizeGB: 1.5 },
    ],
  }));

  // Static review UI
  app.get('/review', async (c) => {
    const { readFile } = await import('fs/promises');
    const { join: pathJoin } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = pathJoin(fileURLToPath(import.meta.url), '..', '..', '..');
    try {
      const html = await readFile(pathJoin(__dirname, 'src', 'server', 'public', 'review', 'index.html'), 'utf-8');
      return c.html(html);
    } catch {
      return c.text('Review UI not yet built. Run with --web-review flag after building.', 503);
    }
  });

  // Advertise via Bonjour/mDNS if bonjour-service is available
  try {
    const { Bonjour } = await import('bonjour-service');
    const bonjour = new Bonjour();
    bonjour.publish({ name: 'Cascade Agent', type: 'cascade-agent', port });
    console.error(`[cascade-agent] Bonjour: advertising _cascade-agent._tcp on port ${port}`);
  } catch {
    console.error('[cascade-agent] Bonjour not available (install bonjour-service for LAN discovery)');
  }

  console.error(`[cascade-agent] serve mode: http://127.0.0.1:${port}`);
  console.error(`[cascade-agent] Session token written to ~/.config/cascade-agent/session-token`);

  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
}
