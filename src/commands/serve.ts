import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomBytes } from 'crypto';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import readline from 'readline';
import chalk from 'chalk';
import { documentIntelligence, CDASection } from '../services/document-intelligence.js';
import type { ExtractionResult } from '../services/document-intelligence.js';
import type { ReviewQueueItem, ReviewDecision, ReviewResultItem } from './review.js';

const DEFAULT_PORT = 8765;

// ── In-memory review store ─────────────────────────────────────────────────────

interface ReviewStore {
  items: ReviewQueueItem[];
  results: ReviewResultItem[];
}

const reviewStore: ReviewStore = {
  items: [],
  results: [],
};

// ── Web Review UI HTML ─────────────────────────────────────────────────────────

function buildReviewHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cascade Agent — Review Queue</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2d3048;
    --text: #e8eaf6;
    --text-muted: #7b82a8;
    --teal: #00b4b4;
    --teal-dim: #006e6e;
    --green: #4caf87;
    --green-bg: #0d2e1e;
    --yellow: #f5c542;
    --yellow-bg: #2e2800;
    --red: #e05c5c;
    --red-bg: #2e0e0e;
    --accepted: #4caf87;
    --rejected: #e05c5c;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", "Fira Code", Consolas, monospace;
  }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    line-height: 1.5;
    min-height: 100vh;
  }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .logo {
    font-size: 15px;
    font-weight: 600;
    color: var(--teal);
    letter-spacing: 0.02em;
  }

  .logo span {
    color: var(--text-muted);
    font-weight: 400;
  }

  .summary-bar {
    display: flex;
    gap: 20px;
    font-size: 13px;
    color: var(--text-muted);
  }

  .summary-bar .count {
    color: var(--text);
    font-weight: 600;
  }

  .summary-bar .accepted { color: var(--accepted); }
  .summary-bar .rejected { color: var(--rejected); }
  .summary-bar .pending { color: var(--yellow); }

  .refresh-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--font);
    transition: color 0.15s, border-color 0.15s;
  }

  .refresh-btn:hover { color: var(--teal); border-color: var(--teal-dim); }

  main {
    max-width: 820px;
    margin: 0 auto;
    padding: 24px 16px;
  }

  .empty-state {
    text-align: center;
    padding: 80px 24px;
    color: var(--text-muted);
  }

  .empty-state h2 { font-size: 18px; margin-bottom: 8px; color: var(--text); }
  .empty-state p { font-size: 13px; max-width: 420px; margin: 0 auto; }

  .queue-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    transition: border-color 0.2s;
  }

  .card.decided { opacity: 0.55; }
  .card.accepted { border-color: var(--teal-dim); }
  .card.rejected { border-color: #5a2020; }

  .card-header {
    padding: 14px 18px;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid var(--border);
  }

  .entity-type {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    background: var(--bg);
    padding: 3px 8px;
    border-radius: 4px;
  }

  .field-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    flex: 1;
  }

  .confidence-badge {
    font-size: 12px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 12px;
  }

  .conf-green { background: var(--green-bg); color: var(--green); }
  .conf-yellow { background: var(--yellow-bg); color: var(--yellow); }
  .conf-red { background: var(--red-bg); color: var(--red); }

  .decision-badge {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 10px;
    border-radius: 12px;
  }

  .decision-accepted { background: var(--green-bg); color: var(--green); }
  .decision-rejected { background: var(--red-bg); color: var(--red); }

  .card-body {
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .field-row {
    display: flex;
    gap: 10px;
    align-items: baseline;
  }

  .field-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    min-width: 80px;
  }

  .field-value {
    font-size: 13px;
    color: var(--text);
  }

  .source-text {
    font-size: 12px;
    font-family: var(--mono);
    color: var(--text-muted);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    line-height: 1.6;
    word-break: break-word;
  }

  .edit-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .edit-input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    padding: 7px 12px;
    border-radius: 6px;
    outline: none;
    transition: border-color 0.15s;
  }

  .edit-input:focus { border-color: var(--teal); }

  .card-actions {
    padding: 12px 18px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .btn {
    padding: 7px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    font-family: var(--font);
    cursor: pointer;
    border: 1px solid transparent;
    transition: opacity 0.15s, filter 0.15s;
  }

  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-accept {
    background: var(--teal);
    color: #000;
    border-color: var(--teal);
  }

  .btn-accept:hover:not(:disabled) { filter: brightness(1.1); }

  .btn-reject {
    background: transparent;
    color: var(--red);
    border-color: var(--red);
  }

  .btn-reject:hover:not(:disabled) { background: var(--red-bg); }

  .btn-edit-toggle {
    background: transparent;
    color: var(--text-muted);
    border-color: var(--border);
    margin-left: auto;
  }

  .btn-edit-toggle:hover:not(:disabled) { color: var(--teal); border-color: var(--teal-dim); }

  .status-msg {
    font-size: 12px;
    color: var(--text-muted);
    margin-left: auto;
  }

  .status-msg.error { color: var(--red); }

  .refresh-timer {
    font-size: 11px;
    color: var(--text-muted);
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin: 28px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }

  .section-title:first-child { margin-top: 0; }
</style>
</head>
<body>

<header>
  <div class="logo">Cascade Agent <span>/ Review Queue</span></div>
  <div class="summary-bar" id="summaryBar">Loading…</div>
  <button class="refresh-btn" id="refreshBtn" onclick="loadQueue()">Refresh</button>
</header>

<main>
  <div id="root"></div>
</main>

<script>
const API = 'http://127.0.0.1:${port}';
let refreshTimer = null;
let countdown = 30;
let queueData = null;

function confidenceClass(c) {
  if (c >= 0.85) return 'conf-green';
  if (c >= 0.50) return 'conf-yellow';
  return 'conf-red';
}

function confidenceLabel(c) {
  return Math.round(c * 100) + '%';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCard(item, decided) {
  const confClass = confidenceClass(item.confidence);
  const confLabel = confidenceLabel(item.confidence);
  const isDecided = !!decided;
  const decidedClass = decided ? (decided.decision === 'accept' ? 'accepted' : 'rejected') : '';
  const statusSection = decided
    ? \`<span class="decision-badge decision-\${decided.decision === 'accept' ? 'accepted' : 'rejected'}">\${decided.decision === 'accept' ? 'Accepted' : 'Rejected'}</span>\`
    : '';

  const sourceBlock = item.sourceText
    ? \`<div class="source-text">\${escapeHtml(item.sourceText.length > 200 ? item.sourceText.slice(0, 200) + '\u2026' : item.sourceText)}</div>\`
    : '';

  const codeRow = item.normalizedCode
    ? \`<div class="field-row"><span class="field-label">Code</span><span class="field-value">\${escapeHtml(item.normalizedCode)}</span></div>\`
    : '';

  const statusRow = item.status && item.status !== 'unknown'
    ? \`<div class="field-row"><span class="field-label">Status</span><span class="field-value">\${escapeHtml(item.status)}</span></div>\`
    : '';

  const actions = isDecided
    ? ''
    : \`<div class="card-actions" id="actions-\${item.id}">
        <button class="btn btn-accept" onclick="decide('\${item.id}', 'accept')">Accept</button>
        <button class="btn btn-reject" onclick="decide('\${item.id}', 'reject')">Reject</button>
        <button class="btn btn-edit-toggle" onclick="toggleEdit('\${item.id}')">Edit value</button>
        <span class="status-msg" id="status-\${item.id}"></span>
      </div>
      <div id="editRow-\${item.id}" style="display:none; padding: 0 18px 14px;">
        <div class="edit-row">
          <input class="edit-input" id="editInput-\${item.id}" type="text" value="\${escapeHtml(item.displayName)}" placeholder="Corrected value">
          <button class="btn btn-accept" onclick="decideEdit('\${item.id}')">Save &amp; Accept</button>
        </div>
      </div>\`;

  return \`
    <div class="card \${decidedClass}" id="card-\${item.id}">
      <div class="card-header">
        <span class="entity-type">\${escapeHtml(item.type)}</span>
        <span class="field-name">\${escapeHtml(item.displayName)}</span>
        <span class="confidence-badge \${confClass}">\${confLabel}</span>
        \${statusSection}
      </div>
      <div class="card-body">
        <div class="field-row">
          <span class="field-label">Section</span>
          <span class="field-value">\${escapeHtml(item.section)}</span>
        </div>
        \${codeRow}
        \${statusRow}
        \${sourceBlock}
      </div>
      \${actions}
    </div>
  \`;
}

async function loadQueue() {
  resetTimer();
  const root = document.getElementById('root');
  const summaryBar = document.getElementById('summaryBar');

  try {
    const res = await fetch(API + '/api/review');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    queueData = await res.json();
  } catch (e) {
    summaryBar.textContent = 'Error loading queue';
    root.innerHTML = '<div class="empty-state"><h2>Cannot reach server</h2><p>Make sure cascade-agent serve is running on port ${port}.</p></div>';
    return;
  }

  const items = queueData.items || [];
  const pending = items.filter(i => i.confidence >= 0.50 && i.confidence < 0.85);
  const autoAccepted = items.filter(i => i.confidence >= 0.85);
  const autoRejected = items.filter(i => i.confidence < 0.50);

  // Load existing decisions
  let decisions = {};
  try {
    const dr = await fetch(API + '/api/review/decisions');
    if (dr.ok) decisions = await dr.json();
  } catch { /* ignore */ }

  const decidedIds = Object.keys(decisions);
  const pendingCount = pending.filter(i => !decidedIds.includes(i.id)).length;
  const acceptedCount = decidedIds.filter(id => decisions[id]?.decision === 'accept').length;
  const rejectedCount = decidedIds.filter(id => decisions[id]?.decision === 'reject').length;

  summaryBar.innerHTML = \`
    <span class="pending"><span class="count">\${pendingCount}</span> pending</span>
    <span class="accepted"><span class="count">\${acceptedCount}</span> accepted</span>
    <span class="rejected"><span class="count">\${rejectedCount}</span> rejected</span>
    <span class="refresh-timer" id="timerLabel">Auto-refresh in \${countdown}s</span>
  \`;

  if (items.length === 0) {
    root.innerHTML = '<div class="empty-state"><h2>Queue is empty</h2><p>No extraction results have been queued yet. Run an extraction to populate the review queue.</p></div>';
    return;
  }

  let html = '';

  if (pending.length > 0) {
    html += '<div class="section-title">Needs Review (confidence 50\u201384%)</div>';
    html += '<div class="queue-list">';
    for (const item of pending) {
      const dec = decisions[item.id] || null;
      html += renderCard(item, dec);
    }
    html += '</div>';
  }

  if (autoAccepted.length > 0) {
    html += '<div class="section-title">Auto-Accepted (\u226585%)</div>';
    html += '<div class="queue-list">';
    for (const item of autoAccepted) {
      html += renderCard(item, { decision: 'accept' });
    }
    html += '</div>';
  }

  if (autoRejected.length > 0) {
    html += '<div class="section-title">Auto-Rejected (<50%)</div>';
    html += '<div class="queue-list">';
    for (const item of autoRejected) {
      html += renderCard(item, { decision: 'reject' });
    }
    html += '</div>';
  }

  root.innerHTML = html;
}

function toggleEdit(id) {
  const row = document.getElementById('editRow-' + id);
  if (!row) return;
  row.style.display = row.style.display === 'none' ? 'block' : 'none';
  if (row.style.display !== 'none') {
    const input = document.getElementById('editInput-' + id);
    if (input) input.focus();
  }
}

async function decideEdit(id) {
  const input = document.getElementById('editInput-' + id);
  const value = input ? input.value.trim() : '';
  await decide(id, 'accept', value || undefined);
}

async function decide(id, decision, value) {
  const statusEl = document.getElementById('status-' + id);
  const actionsEl = document.getElementById('actions-' + id);
  const editRowEl = document.getElementById('editRow-' + id);
  if (statusEl) statusEl.textContent = 'Saving…';

  const body = { decision };
  if (value !== undefined) body.value = value;

  try {
    const res = await fetch(API + '/review/' + id + '/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      if (statusEl) { statusEl.textContent = err.error || 'Error'; statusEl.classList.add('error'); }
      return;
    }

    // Mark card as decided
    const card = document.getElementById('card-' + id);
    if (card) {
      card.classList.add('decided', decision === 'accept' ? 'accepted' : 'rejected');
    }
    if (actionsEl) actionsEl.remove();
    if (editRowEl) editRowEl.remove();

    // Insert decision badge into header
    if (card) {
      const header = card.querySelector('.card-header');
      if (header) {
        const badge = document.createElement('span');
        badge.className = 'decision-badge decision-' + (decision === 'accept' ? 'accepted' : 'rejected');
        badge.textContent = decision === 'accept' ? 'Accepted' : 'Rejected';
        header.appendChild(badge);
      }
    }

    // Refresh summary counts
    await refreshSummary();
  } catch (e) {
    if (statusEl) { statusEl.textContent = 'Network error'; statusEl.classList.add('error'); }
  }
}

async function refreshSummary() {
  const summaryBar = document.getElementById('summaryBar');
  if (!summaryBar || !queueData) return;

  const items = queueData.items || [];
  const pending = items.filter(i => i.confidence >= 0.50 && i.confidence < 0.85);

  let decisions = {};
  try {
    const dr = await fetch(API + '/api/review/decisions');
    if (dr.ok) decisions = await dr.json();
  } catch { /* ignore */ }

  const decidedIds = Object.keys(decisions);
  const pendingCount = pending.filter(i => !decidedIds.includes(i.id)).length;
  const acceptedCount = decidedIds.filter(id => decisions[id]?.decision === 'accept').length;
  const rejectedCount = decidedIds.filter(id => decisions[id]?.decision === 'reject').length;

  summaryBar.innerHTML = \`
    <span class="pending"><span class="count">\${pendingCount}</span> pending</span>
    <span class="accepted"><span class="count">\${acceptedCount}</span> accepted</span>
    <span class="rejected"><span class="count">\${rejectedCount}</span> rejected</span>
    <span class="refresh-timer" id="timerLabel">Auto-refresh in \${countdown}s</span>
  \`;
}

function resetTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  countdown = 30;
  refreshTimer = setInterval(() => {
    countdown--;
    const label = document.getElementById('timerLabel');
    if (label) label.textContent = 'Auto-refresh in ' + countdown + 's';
    if (countdown <= 0) loadQueue();
  }, 1000);
}

// Initial load
loadQueue();
</script>
</body>
</html>`;
}

// ── Serve command ──────────────────────────────────────────────────────────────

export async function runServeMode(port: number = DEFAULT_PORT, webReview = false): Promise<void> {
  await documentIntelligence.initialize();

  // If the extraction model is not present, prompt the user to download it
  if (!documentIntelligence.isAvailable) {
    console.log('');
    console.log(chalk.yellow('  No extraction model found.'));
    console.log(chalk.gray('  Clinical narrative extraction requires a local model (~1.5–2.5 GB).'));
    console.log(chalk.gray('  This is a one-time download — the same model powers the conversational agent.'));
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
      rl.question(chalk.green('  Download model now? [Y/n]: '), resolve)
    );
    rl.close();

    if (!answer.trim() || answer.trim().toLowerCase() === 'y') {
      let lastPct = -1;
      process.stdout.write(chalk.gray('\n  Downloading '));
      await documentIntelligence.ensureModel(({ percent }) => {
        const pct = Math.floor(percent);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stdout.write(chalk.gray(`${pct}%… `));
          lastPct = pct;
        }
      });
      console.log(chalk.green('\n  ✓ Model ready'));
      console.log('');
    } else {
      console.log(chalk.gray('\n  Skipping download. Extraction endpoints will return 503 until a model is available.'));
      console.log(chalk.gray('  Run `cascade-agent login --provider local` to download later.'));
      console.log('');
    }
  }

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
      return c.json({ error: 'No extraction model loaded. Restart cascade-agent serve to download.' }, 503);
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
      {
        id: 'hf_unsloth_Qwen3.5-2B-Q4_K_M.gguf',
        displayName: 'Qwen3.5-2B Q4_K_M (default, ~1.5 GB)',
        source: 'unsloth/Qwen3.5-2B-GGUF on Hugging Face',
        runtime: 'node-llama-cpp (in-process, no Ollama required)',
      },
    ],
  }));

  // ── Review API endpoints ─────────────────────────────────────────────────────

  // GET /api/review — return the in-memory queue (or fall back to the queue file)
  app.get('/api/review', async (c) => {
    if (reviewStore.items.length > 0) {
      return c.json({
        version: '1.0',
        generatedAt: new Date().toISOString(),
        podPath: process.cwd(),
        items: reviewStore.items,
      });
    }

    // Fall back to file
    try {
      const { readFile } = await import('fs/promises');
      const filePath = join(process.cwd(), 'pod', 'analysis', 'review-queue.json');
      const raw = await readFile(filePath, 'utf-8');
      return c.json(JSON.parse(raw));
    } catch {
      return c.json({ version: '1.0', generatedAt: new Date().toISOString(), podPath: process.cwd(), items: [] });
    }
  });

  // GET /api/review/decisions — return map of id -> decision
  app.get('/api/review/decisions', (c) => {
    const map: Record<string, { decision: string; value?: string }> = {};
    for (const r of reviewStore.results) {
      map[r.id] = { decision: r.decision === 'accepted' ? 'accept' : 'reject', value: r.finalValue };
    }
    return c.json(map);
  });

  // POST /review/:id/decide — record a decision for a review item
  app.post('/review/:id/decide', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json() as { decision: 'accept' | 'reject'; value?: string };

    if (!body.decision || !['accept', 'reject'].includes(body.decision)) {
      return c.json({ error: 'decision must be "accept" or "reject"' }, 400);
    }

    // Find the item in the store or the queue file
    let item: ReviewQueueItem | undefined = reviewStore.items.find((i) => i.id === id);

    if (!item) {
      try {
        const { readFile } = await import('fs/promises');
        const filePath = join(process.cwd(), 'pod', 'analysis', 'review-queue.json');
        const raw = await readFile(filePath, 'utf-8');
        const queue = JSON.parse(raw) as { items: ReviewQueueItem[] };
        item = queue.items.find((i) => i.id === id);
      } catch {
        // item stays undefined
      }
    }

    if (!item) {
      return c.json({ error: `Item ${id} not found in review queue` }, 404);
    }

    const decision: ReviewDecision = body.decision === 'accept' ? 'accepted' : 'rejected';
    const finalValue = body.value ?? item.displayName;

    // Remove any prior decision for this id
    const priorIdx = reviewStore.results.findIndex((r) => r.id === id);
    const result: ReviewResultItem = {
      id,
      decision,
      originalValue: item.displayName,
      finalValue,
      entityType: item.type,
      section: item.section,
      confidence: item.confidence,
      reviewedAt: new Date().toISOString(),
    };

    if (priorIdx >= 0) {
      reviewStore.results[priorIdx] = result;
    } else {
      reviewStore.results.push(result);
    }

    return c.json({ ok: true, id, decision, finalValue });
  });

  // ── Web Review UI ────────────────────────────────────────────────────────────

  // Always serve the UI at GET / and GET /ui
  const reviewHtml = buildReviewHtml(port);

  app.get('/', (c) => c.html(reviewHtml));
  app.get('/ui', (c) => c.html(reviewHtml));

  // Legacy route: replace old stub with live inline UI
  app.get('/review', (c) => c.html(reviewHtml));

  // ── Bonjour ──────────────────────────────────────────────────────────────────

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

  if (webReview) {
    console.log(`Review UI: http://127.0.0.1:${port}/`);
  }

  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
}
