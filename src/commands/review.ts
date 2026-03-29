/**
 * Terminal interactive review mode for AI extraction queue (P5.3-F)
 *
 * Reads pending review items (confidence 0.50–0.84) from either:
 *   1. GET http://127.0.0.1:8765/api/review  (serve mode running)
 *   2. pod/analysis/review-queue.json        (file fallback)
 *
 * For each item the user can:
 *   a  Accept   — mark accepted
 *   r  Reject   — mark rejected
 *   e  Edit     — inline edit the displayName value
 *   s  Skip     — leave for later
 *
 * Results are written to pod/analysis/review-results.json
 */

import readline from 'readline';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import chalk from 'chalk';
import type { ExtractedEntity } from '../services/document-intelligence.js';

const DEFAULT_PORT = 8765;
const REVIEW_API_URL = `http://127.0.0.1:${DEFAULT_PORT}/api/review`;

// ── Data structures ────────────────────────────────────────────────────────────

export interface ReviewQueueItem extends ExtractedEntity {
  id: string;
  section: string;
  queuedAt: string;
}

export interface ReviewQueue {
  version: string;
  generatedAt: string;
  podPath: string;
  items: ReviewQueueItem[];
}

export type ReviewDecision = 'accepted' | 'rejected' | 'edited' | 'skipped';

export interface ReviewResultItem {
  id: string;
  decision: ReviewDecision;
  originalValue: string;
  finalValue: string;
  entityType: string;
  section: string;
  confidence: number;
  reviewedAt: string;
}

export interface ReviewResults {
  version: string;
  reviewedAt: string;
  podPath: string;
  summary: {
    total: number;
    accepted: number;
    rejected: number;
    edited: number;
    skipped: number;
  };
  items: ReviewResultItem[];
}

// ── Queue loading ──────────────────────────────────────────────────────────────

export async function loadReviewQueue(podPath?: string): Promise<ReviewQueue> {
  // 1. Try the running serve mode HTTP API
  try {
    const res = await fetch(REVIEW_API_URL, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json() as ReviewQueue;
      return data;
    }
  } catch {
    // Server not running — fall through to file fallback
  }

  // 2. Fall back to direct file read
  const filePath = podPath
    ? join(podPath, 'analysis', 'review-queue.json')
    : join(process.cwd(), 'pod', 'analysis', 'review-queue.json');

  try {
    await access(filePath);
  } catch {
    throw new Error(
      `Review queue not found.\n` +
      `  Tried HTTP: ${REVIEW_API_URL}\n` +
      `  Tried file: ${filePath}\n\n` +
      `Run 'cascade-agent serve' first to populate the queue, or supply --pod <path>.`
    );
  }

  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw) as ReviewQueue;
}

// ── Readline helpers ───────────────────────────────────────────────────────────

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function promptDecision(rl: readline.Interface): Promise<string> {
  while (true) {
    const raw = await ask(rl, chalk.bold('  Decision [a=accept, r=reject, e=edit, s=skip]: '));
    const choice = raw.trim().toLowerCase();
    if (['a', 'r', 'e', 's'].includes(choice)) return choice;
    console.log(chalk.red('  Invalid choice. Enter a, r, e, or s.'));
  }
}

async function promptEdit(rl: readline.Interface, currentValue: string): Promise<string> {
  const raw = await ask(rl, chalk.cyan(`  Edit value [current: ${currentValue}]: `));
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : currentValue;
}

// ── Display ────────────────────────────────────────────────────────────────────

function confidenceBar(confidence: number): string {
  const pct = Math.round(confidence * 100);
  const bars = Math.round(confidence * 10);
  const filled = '█'.repeat(bars);
  const empty = '░'.repeat(10 - bars);
  const color = confidence >= 0.75 ? chalk.green : confidence >= 0.60 ? chalk.yellow : chalk.red;
  return color(`${filled}${empty} ${pct}%`);
}

function displayItem(item: ReviewQueueItem, index: number, total: number): void {
  console.log();
  console.log(chalk.bold.cyan(`── Item ${index + 1} of ${total} ──────────────────────────────────`));
  console.log(`  ${chalk.bold('Field:')}      ${chalk.white(item.type)}`);
  console.log(`  ${chalk.bold('Value:')}      ${chalk.white(item.displayName)}`);
  if (item.normalizedCode) {
    console.log(`  ${chalk.bold('Code:')}       ${chalk.gray(item.normalizedCode)}`);
  }
  if (item.status && item.status !== 'unknown') {
    console.log(`  ${chalk.bold('Status:')}     ${chalk.gray(item.status)}`);
  }
  console.log(`  ${chalk.bold('Section:')}    ${chalk.gray(item.section)}`);
  console.log(`  ${chalk.bold('Confidence:')} ${confidenceBar(item.confidence)}`);
  if (item.sourceText) {
    const snippet = item.sourceText.length > 120
      ? item.sourceText.slice(0, 120) + '…'
      : item.sourceText;
    console.log(`  ${chalk.bold('Source:')}     ${chalk.dim('"' + snippet + '"')}`);
  }
  console.log();
}

// ── Core review loop ───────────────────────────────────────────────────────────

export async function runReviewLoop(
  queue: ReviewQueue,
  rl: readline.Interface
): Promise<ReviewResultItem[]> {
  const pending = queue.items.filter((item) => {
    // Only present items in the review confidence band
    return item.confidence >= 0.50 && item.confidence < 0.85;
  });

  if (pending.length === 0) {
    console.log(chalk.green('\nNo items pending review. Queue is empty or all items are outside the review band.\n'));
    return [];
  }

  console.log(chalk.bold.cyan(`\nCascade Agent — Terminal Review Mode`));
  console.log(chalk.gray(`  Pod: ${queue.podPath}`));
  console.log(chalk.gray(`  Generated: ${queue.generatedAt}`));
  console.log(chalk.gray(`  Items to review: ${chalk.white(pending.length)}`));
  console.log(chalk.gray('\n  Each item has confidence 0.50–0.84 (AI was not confident enough to auto-accept).'));
  console.log(chalk.gray('  Review and decide: Accept, Reject, Edit, or Skip.\n'));

  const results: ReviewResultItem[] = [];

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    displayItem(item, i, pending.length);

    const choice = await promptDecision(rl);

    let decision: ReviewDecision;
    let finalValue = item.displayName;

    if (choice === 'a') {
      decision = 'accepted';
      console.log(chalk.green('  ✓ Accepted'));
    } else if (choice === 'r') {
      decision = 'rejected';
      console.log(chalk.red('  ✗ Rejected'));
    } else if (choice === 'e') {
      finalValue = await promptEdit(rl, item.displayName);
      decision = 'edited';
      console.log(chalk.cyan(`  ✎ Edited → "${finalValue}"`));
    } else {
      decision = 'skipped';
      console.log(chalk.gray('  → Skipped'));
    }

    results.push({
      id: item.id,
      decision,
      originalValue: item.displayName,
      finalValue,
      entityType: item.type,
      section: item.section,
      confidence: item.confidence,
      reviewedAt: new Date().toISOString(),
    });
  }

  return results;
}

// ── Results persistence ────────────────────────────────────────────────────────

export async function writeReviewResults(
  results: ReviewResultItem[],
  queue: ReviewQueue,
  outputPath: string
): Promise<void> {
  const accepted = results.filter((r) => r.decision === 'accepted').length;
  const rejected = results.filter((r) => r.decision === 'rejected').length;
  const edited = results.filter((r) => r.decision === 'edited').length;
  const skipped = results.filter((r) => r.decision === 'skipped').length;

  const output: ReviewResults = {
    version: '1.0',
    reviewedAt: new Date().toISOString(),
    podPath: queue.podPath,
    summary: {
      total: results.length,
      accepted,
      rejected,
      edited,
      skipped,
    },
    items: results,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
}

// ── Summary display ────────────────────────────────────────────────────────────

export function printSummary(results: ReviewResultItem[], outputPath: string): void {
  if (results.length === 0) return;

  const accepted = results.filter((r) => r.decision === 'accepted').length;
  const rejected = results.filter((r) => r.decision === 'rejected').length;
  const edited = results.filter((r) => r.decision === 'edited').length;
  const skipped = results.filter((r) => r.decision === 'skipped').length;

  console.log();
  console.log(chalk.bold.cyan('── Review Summary ───────────────────────────────────────'));
  console.log(`  ${chalk.green('Accepted:')} ${accepted}`);
  console.log(`  ${chalk.red('Rejected:')} ${rejected}`);
  console.log(`  ${chalk.cyan('Edited:')}   ${edited}`);
  console.log(`  ${chalk.gray('Skipped:')}  ${skipped}`);
  console.log(`  ${chalk.bold('Total:')}    ${results.length}`);
  console.log();
  console.log(chalk.gray(`  Results written to: ${outputPath}`));
  console.log();
}

// ── Command entry point ────────────────────────────────────────────────────────

export async function runReviewMode(opts: { pod?: string; output?: string }): Promise<void> {
  const podPath = opts.pod;

  let queue: ReviewQueue;
  try {
    queue = await loadReviewQueue(podPath);
  } catch (err) {
    console.error(chalk.red(`\nError: ${(err as Error).message}`));
    process.exit(1);
  }

  const resolvedPodPath = podPath ?? queue.podPath ?? join(process.cwd(), 'pod');
  const outputPath = opts.output ?? join(resolvedPodPath, 'analysis', 'review-results.json');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let results: ReviewResultItem[] = [];
  try {
    results = await runReviewLoop(queue, rl);
  } finally {
    rl.close();
  }

  if (results.length > 0) {
    await writeReviewResults(results, queue, outputPath);
    printSummary(results, outputPath);
  }
}
