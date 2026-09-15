/**
 * The model tier table, read from a STAMPED SNAPSHOT.
 *
 * A model id is typed by a human in exactly one place in this ecosystem: the
 * relay's tier table. This file does not hold one. It holds a copy of the
 * document the relay publishes at `GET /v1/tiers`, wrapped in a stamp saying
 * where it came from and when, and every model id this package uses is read out
 * of that copy. `scripts/sync-tier-table.ts` is the only thing that writes it.
 *
 * Why a stamp and not just the document. A copy with no provenance is
 * indistinguishable from something a person typed, which is the failure this
 * whole arrangement exists to prevent: a model id edited in five places that
 * agree until one of them does not. A copy that says where it came from can be
 * checked against its source (`npm run sync:tier-table -- --check`) and a copy
 * with no stamp is REFUSED at load rather than trusted.
 *
 * Why it throws at load rather than degrading. The ids in this document decide
 * which endpoint a prompt is sent to and whether that destination is covered by
 * an agreement. A half-validated tier table would mean guessing at a coverage
 * fact, and a guess in that position is worse than a process that will not
 * start.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class TierTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierTableError";
  }
}

export const TIER_TABLE_SCHEMA = "cascade-tier-table/1";

/** Tiers the table must define. A future third tier is added in the relay. */
export const TIER_TABLE_REQUIRED_TIERS = ["standard", "advanced"] as const;

/**
 * The published document's field set, EXACT at every depth.
 *
 * It is a closed set in both directions on purpose. A missing key is a
 * truncated document. An UNKNOWN key is the more interesting failure: it means
 * the document was produced by a newer publisher than this reader, so the copy
 * may be carrying a fact this code does not know to honour. Refusing is how a
 * field addition becomes a deliberate change in every repository instead of
 * something one side silently ignores.
 */
const TABLE_KEYS = ["schema", "version", "tiers", "retired"] as const;
const TIER_KEYS = [
  "providerDisplay",
  "model",
  "region",
  "launchStage",
  "baaCovered",
  "baaProvenance",
] as const;
const TIER_REQUIRED_KEYS = [
  "providerDisplay",
  "model",
  "region",
  "launchStage",
  "baaCovered",
] as const;
const PROVENANCE_KEYS = ["agreement", "acceptedOn", "sourceUrl"] as const;
const RETIRED_KEYS = ["model", "launchStage", "baaCovered"] as const;
const STAMP_KEYS = ["source", "syncedAt", "etag"] as const;

export interface TierTableStamp {
  /** Where the document came from: a URL, or the file it was projected from. */
  source: string;
  /** ISO date the copy was taken. */
  syncedAt: string;
  /** The publisher's ETag, or its version when no header was returned. */
  etag: string;
}

export interface PublishedBaaProvenance {
  agreement: string;
  acceptedOn: string;
  sourceUrl: string;
}

export interface PublishedTier {
  providerDisplay: string;
  model: string;
  region: string;
  launchStage: string;
  /** THE GATE. Never defaulted; the publisher states it or the copy is refused. */
  baaCovered: boolean;
  baaProvenance?: PublishedBaaProvenance;
}

/**
 * A model id the relay has served and no longer serves, with the facts frozen
 * as they were on the day it served them. The egress ledger is append-only, so
 * a pod written before a repoint still names these ids; a reader that no longer
 * recognized one would report its coverage as unknown instead of the covered
 * (or uncovered) call it honestly was.
 */
export interface PublishedRetiredModel {
  model: string;
  launchStage: string;
  baaCovered: boolean;
}

export interface PublishedTierTable {
  schema: string;
  version: string;
  tiers: Record<string, PublishedTier>;
  retired: PublishedRetiredModel[];
}

export interface TierTableSnapshot {
  stamp: TierTableStamp;
  table: PublishedTierTable;
}

function fail(where: string, what: string): never {
  throw new TierTableError(`tier table snapshot (${where}): ${what}`);
}

function requireObject(value: unknown, where: string, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, where: string, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(where, `${what} must be a non-empty string`);
  }
  return value as string;
}

function requireBoolean(value: unknown, where: string, what: string): boolean {
  if (typeof value !== "boolean") {
    fail(where, `${what} must be an explicit boolean, never a default`);
  }
  return value as boolean;
}

function requireExactKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  where: string,
  what: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      fail(
        where,
        `${what} carries the unknown key "${key}". The field set is closed: a document ` +
          `with a field this reader does not know may be carrying a fact it should be ` +
          `honouring, so it is refused rather than partly understood. Add the field here ` +
          `and in every other consumer.`,
      );
    }
  }
  for (const key of required) {
    if (!(key in object)) fail(where, `${what} is missing the required key "${key}"`);
  }
}

function requireIsoDate(value: unknown, where: string, what: string): string {
  const text = requireString(value, where, what);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text) || Number.isNaN(Date.parse(text))) {
    fail(where, `${what} must be an ISO date`);
  }
  return text;
}

/** Validates the PUBLISHED DOCUMENT alone: what `GET /v1/tiers` returns. */
export function validatePublishedTierTable(raw: unknown, where: string): PublishedTierTable {
  const doc = requireObject(raw, where, "the table");
  requireExactKeys(doc, TABLE_KEYS, TABLE_KEYS, where, "the table");

  const schema = requireString(doc.schema, where, "table.schema");
  if (schema !== TIER_TABLE_SCHEMA) {
    fail(where, `table.schema is "${schema}", expected "${TIER_TABLE_SCHEMA}"`);
  }
  const version = requireString(doc.version, where, "table.version");

  const tiersRaw = requireObject(doc.tiers, where, "table.tiers");
  const tiers: Record<string, PublishedTier> = {};
  for (const [name, value] of Object.entries(tiersRaw)) {
    const row = requireObject(value, where, `tiers.${name}`);
    requireExactKeys(row, TIER_KEYS, TIER_REQUIRED_KEYS, where, `tiers.${name}`);
    const tier: PublishedTier = {
      providerDisplay: requireString(row.providerDisplay, where, `tiers.${name}.providerDisplay`),
      model: requireString(row.model, where, `tiers.${name}.model`),
      region: requireString(row.region, where, `tiers.${name}.region`),
      launchStage: requireString(row.launchStage, where, `tiers.${name}.launchStage`),
      baaCovered: requireBoolean(row.baaCovered, where, `tiers.${name}.baaCovered`),
    };
    if (row.baaProvenance !== undefined) {
      const prov = requireObject(row.baaProvenance, where, `tiers.${name}.baaProvenance`);
      requireExactKeys(
        prov,
        PROVENANCE_KEYS,
        PROVENANCE_KEYS,
        where,
        `tiers.${name}.baaProvenance`,
      );
      tier.baaProvenance = {
        agreement: requireString(prov.agreement, where, `tiers.${name}.baaProvenance.agreement`),
        acceptedOn: requireIsoDate(
          prov.acceptedOn,
          where,
          `tiers.${name}.baaProvenance.acceptedOn`,
        ),
        sourceUrl: requireString(prov.sourceUrl, where, `tiers.${name}.baaProvenance.sourceUrl`),
      };
    }
    // A coverage claim with no provenance is a checkbox, not a gate.
    if (tier.baaCovered && !tier.baaProvenance) {
      fail(where, `tiers.${name} claims baaCovered with no baaProvenance`);
    }
    tiers[name] = tier;
  }
  for (const required of TIER_TABLE_REQUIRED_TIERS) {
    if (!tiers[required]) fail(where, `the table does not define the "${required}" tier`);
  }

  if (!Array.isArray(doc.retired)) fail(where, "table.retired must be an array");
  const seen = new Set<string>();
  const retired: PublishedRetiredModel[] = doc.retired.map((entry, index) => {
    const row = requireObject(entry, where, `retired[${index}]`);
    requireExactKeys(row, RETIRED_KEYS, RETIRED_KEYS, where, `retired[${index}]`);
    const model = requireString(row.model, where, `retired[${index}].model`);
    if (seen.has(model)) fail(where, `retired lists "${model}" twice`);
    seen.add(model);
    return {
      model,
      launchStage: requireString(row.launchStage, where, `retired[${index}].launchStage`),
      baaCovered: requireBoolean(row.baaCovered, where, `retired[${index}].baaCovered`),
    };
  });

  return { schema, version, tiers, retired };
}

/** Validates the STAMPED WRAPPER: the stamp plus the document. */
export function validateTierTableSnapshot(raw: unknown, where: string): TierTableSnapshot {
  const wrapper = requireObject(raw, where, "the snapshot");
  requireExactKeys(wrapper, ["stamp", "table"], ["stamp", "table"], where, "the snapshot");

  const stampRaw = requireObject(wrapper.stamp, where, "stamp");
  requireExactKeys(stampRaw, STAMP_KEYS, STAMP_KEYS, where, "stamp");
  const stamp: TierTableStamp = {
    source: requireString(stampRaw.source, where, "stamp.source"),
    syncedAt: requireIsoDate(stampRaw.syncedAt, where, "stamp.syncedAt"),
    etag: requireString(stampRaw.etag, where, "stamp.etag"),
  };

  return { stamp, table: validatePublishedTierTable(wrapper.table, where) };
}

const SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "data", "tier-table.snapshot.json");

let cached: TierTableSnapshot | undefined;

/**
 * Reads and validates the committed snapshot. Cached, because the document is
 * immutable for the life of the process: it changes when a sync script rewrites
 * the file and the process restarts, never underneath a running request.
 */
export function loadTierTableSnapshot(): TierTableSnapshot {
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(SNAPSHOT_PATH, "utf8");
  } catch {
    throw new TierTableError(
      `the tier table snapshot is missing at ${SNAPSHOT_PATH}. Run ` +
        `\`npm run sync:tier-table\` to fetch it from the relay.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The message is dropped: a JSON parse error embeds a snippet of the input.
    throw new TierTableError(`the tier table snapshot at ${SNAPSHOT_PATH} is not valid JSON`);
  }
  cached = validateTierTableSnapshot(parsed, SNAPSHOT_PATH);
  return cached;
}

export const TIER_TABLE_VERSION: string = loadTierTableSnapshot().table.version;

/** The stamp on the committed copy: where it came from and when. */
export function tierTableStamp(): TierTableStamp {
  return loadTierTableSnapshot().stamp;
}

/** One tier's row. Throws for a tier the table does not define. */
export function tierRow(tier: string): PublishedTier {
  const row = loadTierTableSnapshot().table.tiers[tier];
  if (!row) {
    throw new TierTableError(
      `the tier table defines no "${tier}" tier (it defines ` +
        `${Object.keys(loadTierTableSnapshot().table.tiers).join(", ")})`,
    );
  }
  return row;
}

/** The model id for a tier. The ONLY way this package names a model. */
export function tierModel(tier: string): string {
  return tierRow(tier).model;
}

/**
 * What was true about a model id that is no longer served, or undefined for an
 * id the table has never named. Undefined means "not in this table", which is
 * different from "was not covered" and must never be flattened into it.
 */
export function retiredModelFacts(
  modelId: string,
): { launchStage: string; baaCovered: boolean } | undefined {
  const row = loadTierTableSnapshot().table.retired.find((entry) => entry.model === modelId);
  return row ? { launchStage: row.launchStage, baaCovered: row.baaCovered } : undefined;
}

/** Every id the table names, current tiers first, then the retired ledger. */
export function knownModelIds(): string[] {
  const { table } = loadTierTableSnapshot();
  return [
    ...Object.values(table.tiers).map((row) => row.model),
    ...table.retired.map((row) => row.model),
  ];
}
