/**
 * Sync the stamped tier table snapshot from the relay's published document.
 *
 * The logic lives here rather than in `scripts/` so it is typechecked and
 * unit-testable with an injected fetch; `scripts/sync-tier-table.ts` is a thin
 * CLI wrapper that maps the result to an exit code.
 *
 * `--check` is the half that matters operationally. It answers "does the copy
 * this repository committed still match what the relay is serving" with an exit
 * code and a diff, which makes drift a build failure instead of something a
 * reader has to notice. It writes NOTHING, so it is safe in CI.
 */

import { readFile, writeFile } from "node:fs/promises";
import {
  TIER_TABLE_SCHEMA,
  validatePublishedTierTable,
  validateTierTableSnapshot,
  type PublishedTierTable,
  type TierTableSnapshot,
} from "./tierTable.js";

export const DEFAULT_TIER_TABLE_URL = "https://relay.cascadeagenticlabs.com/v1/tiers";

export interface SyncTierTableOptions {
  /** Where the snapshot lives. */
  snapshotPath: string;
  /** The published document's URL. Ignored when `fromFile` is set. */
  url?: string;
  /** Read a local JSON document instead of fetching. */
  fromFile?: string;
  /** Report drift and exit non-zero; never write. */
  check?: boolean;
  /** ISO date recorded in the stamp. */
  today: string;
  /** Injected for tests. Defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

export interface SyncTierTableResult {
  /** "written" | "unchanged" | "differs" ("differs" only under --check). */
  outcome: "written" | "unchanged" | "differs";
  version: string;
  /** Unified diff of the committed table against the fetched one. */
  diff?: string;
  /** Lines the caller should print. */
  messages: string[];
}

interface FetchedDocument {
  table: PublishedTierTable;
  source: string;
  etag: string;
}

async function fetchDocument(options: SyncTierTableOptions): Promise<FetchedDocument> {
  if (options.fromFile) {
    const raw = JSON.parse(await readFile(options.fromFile, "utf8")) as unknown;
    // A local file may be the published document OR a stamped wrapper, because
    // the obvious thing to point --from at is another repository's snapshot.
    const unwrapped =
      typeof raw === "object" && raw !== null && "table" in raw && "stamp" in raw
        ? validateTierTableSnapshot(raw, options.fromFile).table
        : validatePublishedTierTable(raw, options.fromFile);
    return { table: unwrapped, source: options.fromFile, etag: unwrapped.version };
  }

  const url = options.url ?? DEFAULT_TIER_TABLE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}; the tier table was not synced`);
  }
  const table = validatePublishedTierTable(await response.json(), url);
  // The ETag is the publisher's own identifier for the document. When the hop
  // in front of the relay strips it, the table's version is the honest
  // fallback: it is what the ETag is derived from.
  const etag = (response.headers.get("etag") ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
  return { table, source: url, etag: etag === "" ? table.version : etag };
}

/** Stable serialization. Both sides are written by this function, so a diff is
 *  a difference in content and never in formatting. */
function serialize(snapshot: TierTableSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export async function syncTierTable(options: SyncTierTableOptions): Promise<SyncTierTableResult> {
  const fetched = await fetchDocument(options);
  if (fetched.table.schema !== TIER_TABLE_SCHEMA) {
    throw new Error(
      `the published table declares schema "${fetched.table.schema}", this reader understands ` +
        `"${TIER_TABLE_SCHEMA}"`,
    );
  }

  const next: TierTableSnapshot = {
    stamp: { source: fetched.source, syncedAt: options.today, etag: fetched.etag },
    table: fetched.table,
  };
  const nextText = serialize(next);

  let committed: TierTableSnapshot | undefined;
  try {
    committed = validateTierTableSnapshot(
      JSON.parse(await readFile(options.snapshotPath, "utf8")) as unknown,
      options.snapshotPath,
    );
  } catch {
    committed = undefined;
  }

  // The STAMP is excluded from the comparison on purpose: `syncedAt` changes on
  // every run and `source` differs between a file sync and a URL sync, so
  // comparing it would report drift on every check. The TABLE is the fact.
  const committedTableText = committed ? `${JSON.stringify(committed.table, null, 2)}\n` : "";
  const nextTableText = `${JSON.stringify(next.table, null, 2)}\n`;
  const same = committedTableText === nextTableText;

  if (options.check) {
    if (same) {
      return {
        outcome: "unchanged",
        version: next.table.version,
        messages: [`tier table ${next.table.version} matches ${fetched.source}`],
      };
    }
    return {
      outcome: "differs",
      version: next.table.version,
      diff: unifiedDiff(committedTableText, nextTableText, options.snapshotPath, fetched.source),
      messages: [
        `the committed tier table does not match ${fetched.source}.`,
        "Run `npm run sync:tier-table` and commit the result.",
      ],
    };
  }

  await writeFile(options.snapshotPath, nextText, "utf8");
  return {
    outcome: same ? "unchanged" : "written",
    version: next.table.version,
    messages: [
      same
        ? `tier table ${next.table.version} was already current; the stamp was refreshed`
        : `wrote tier table ${next.table.version} from ${fetched.source}`,
    ],
  };
}

/** A unified diff over lines. The documents are tens of lines, so an LCS table
 *  is cheap and the output is easier to read than a whole-file replacement. */
export function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push(`-${a[i]}`);
      i += 1;
    } else {
      lines.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) lines.push(`-${a[i++]}`);
  while (j < b.length) lines.push(`+${b[j++]}`);
  return `${lines.join("\n")}\n`;
}
