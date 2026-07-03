/**
 * Sidecar PID tracking + stale-orphan reaping.
 *
 * A TypeScript port of the Workbench's `src-tauri/src/sidecar_pids.rs` (deep-dive
 * finding D3), for cascade-agent's own managed sidecar: the `llama-server` it
 * spawns when no external `CASCADE_LLAMA_URL` is configured.
 *
 * llama-server ignores SIGTERM and cannot watch stdin, so the ONLY orphan story
 * is this reaper: every spawn records the child PID + a command-line signature +
 * the owning cascade-agent PID to a small pidfile, and every managed spawn first
 * reaps any llama-server a previous cascade-agent run left behind. A sidecar is
 * reaped only when (a) the owning cascade-agent is no longer alive (so a second
 * running instance is never disturbed) and (b) the live process still matches the
 * recorded signature (so a reused PID is never killed by mistake).
 *
 * Registry is keyed by the OWNER pid — `{name}.{owner}.pid` — not a single
 * `{name}.pid` slot, so successive/concurrent cascade-agent instances never
 * clobber each other's record (the reaper-correctness fix; see the Rust module
 * docs for the full rationale).
 *
 * The pid dir is cascade-agent-specific so this reaper NEVER scans the
 * Workbench's own `cascade-workbench-sidecars` entries (its llama-server has a
 * live Workbench owner anyway, but a separate dir avoids any cross-app churn).
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

/** Per-machine directory of cascade-agent sidecar pidfiles. */
function pidDir(): string {
  return join(tmpdir(), 'cascade-agent-sidecars');
}

/** Registry entry for one sidecar of `name` owned by cascade-agent `owner`. */
function entryFile(name: string, owner: number): string {
  return join(pidDir(), `${name}.${owner}.pid`);
}

/**
 * Record a freshly-spawned sidecar so a later run can reap it if this run dies
 * without cleanup. `signature` is a stable substring of the process command line
 * (e.g. "llama-server") used to confirm identity on reap. Filed under THIS
 * cascade-agent's pid so it never overwrites a previous instance's entry.
 */
export function record(name: string, pid: number, signature: string): void {
  const owner = process.pid;
  try {
    mkdirSync(pidDir(), { recursive: true });
    writeFileSync(entryFile(name, owner), `${pid}\n${signature}\n${owner}\n`);
  } catch {
    // Best-effort: a failed record just means we lean on the Drop-equivalent
    // teardown for this run; it does not affect correctness of extraction.
  }
}

/**
 * Forget a sidecar we tore down cleanly (so the next launch does not try to reap
 * a dead or reused PID). Removes only THIS instance's entry for the name.
 */
export function clear(name: string): void {
  try {
    rmSync(entryFile(name, process.pid), { force: true });
  } catch {
    // ignore
  }
}

/**
 * Kill every stale sidecar of `name` left running by a previous cascade-agent
 * run. Sweeps all `{name}.*.pid` entries: each entry whose owner is dead is
 * reaped (when its recorded PID is still alive and still matches the signature)
 * and its file removed; an entry whose owner is still alive (another running
 * instance) is left untouched, process and file both.
 */
export function reapStale(name: string): void {
  const dir = pidDir();
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `${name}.`;
  for (const fname of entries) {
    // Match exactly `{name}.{owner-digits}.pid`, so reaping "llama-server" never
    // touches an unrelated sidecar's entries.
    if (!fname.startsWith(prefix) || !fname.endsWith('.pid')) continue;
    const middle = fname.slice(prefix.length, fname.length - '.pid'.length);
    if (!/^\d+$/.test(middle)) continue;
    reapEntry(join(dir, fname));
  }
}

/**
 * Reap a single registry entry: spare it if its owner is still alive, otherwise
 * kill the recorded sidecar (signature-guarded) and remove the entry file.
 */
function reapEntry(path: string): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf-8');
  } catch {
    return;
  }
  const [pidLine, sigLine, ownerLine] = contents.split('\n');
  const pid = Number.parseInt((pidLine ?? '').trim(), 10);
  const signature = (sigLine ?? '').trim();
  const owner = Number.parseInt((ownerLine ?? '').trim(), 10);

  // A still-alive owner means another running instance manages this sidecar;
  // leave both the process and the entry alone.
  if (Number.isFinite(owner) && processAlive(owner)) return;

  if (Number.isFinite(pid) && isOurProcess(pid, signature)) {
    // llama-server ignores SIGTERM — go straight to SIGKILL.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // ignore
  }
}

/** True if the process exists (signal 0 sends nothing but throws ESRCH if dead). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it (still "alive").
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True only when PID is alive AND its command line still contains `signature`,
 * so we never kill an unrelated process that reused the PID.
 */
function isOurProcess(pid: number, signature: string): boolean {
  if (!signature || !processAlive(pid)) return false;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
    });
    return out.includes(signature);
  } catch {
    return false;
  }
}
