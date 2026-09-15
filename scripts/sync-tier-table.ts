#!/usr/bin/env tsx
/**
 * `npm run sync:tier-table` — rewrite the stamped tier table snapshot from the
 * relay's published document.
 *
 *   npm run sync:tier-table                       fetch the live endpoint
 *   npm run sync:tier-table -- --check            report drift, write nothing, exit 1
 *   npm run sync:tier-table -- --from <file>      read a local document instead
 *   npm run sync:tier-table -- --url <url>        a different publisher
 *
 * Thin wrapper: the logic is in `src/syncTierTable.ts` so it is typechecked and
 * unit-tested with an injected fetch.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncTierTable } from "../src/syncTierTable.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    process.stderr.write(`--${name} needs a value\n`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const fromFile = flag("from");
  const result = await syncTierTable({
    snapshotPath: join(root, "src", "data", "tier-table.snapshot.json"),
    ...(fromFile ? { fromFile: resolve(fromFile) } : {}),
    ...(flag("url") ? { url: flag("url")! } : {}),
    check: process.argv.includes("--check"),
    today: new Date().toISOString().slice(0, 10),
  });
  if (result.diff) process.stdout.write(result.diff);
  for (const message of result.messages) process.stdout.write(`${message}\n`);
  process.exit(result.outcome === "differs" ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`sync-tier-table failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
