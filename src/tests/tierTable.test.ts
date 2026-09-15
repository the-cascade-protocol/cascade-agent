/**
 * The stamped tier table: the loader, the source scan, the sync script and the
 * ids the response reports.
 *
 * ZERO network calls (the sync script's fetch is injected), ZERO credentials,
 * ZERO PHI. Run with: npx tsx src/tests/tierTable.test.ts
 *
 * The invariant under test is one sentence: a model id is typed by a human in
 * exactly one place, and this package is not that place. Two of these tests are
 * the only thing standing between that sentence and a literal creeping back in.
 */
import assert from "assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

import {
  TIER_TABLE_SCHEMA,
  TIER_TABLE_VERSION,
  TierTableError,
  knownModelIds,
  loadTierTableSnapshot,
  retiredModelFacts,
  tierModel,
  tierRow,
  tierTableStamp,
  validatePublishedTierTable,
  validateTierTableSnapshot,
} from "../tierTable.js";
import { syncTierTable, unifiedDiff } from "../syncTierTable.js";
import { VERTEX_TIER_MODELS, MODEL_TIERS, completeViaGateway, type GatewayProvider } from "../gateway.js";
import { DEFAULT_VERTEX_MODEL } from "../providers/vertex.js";

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

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(SRC, "..");
const SNAPSHOT = join(SRC, "data", "tier-table.snapshot.json");

/** A structurally valid snapshot, as an object that tests can damage. */
function validSnapshot(): Record<string, unknown> {
  return JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, unknown>;
}

// ── The loader ───────────────────────────────────────────────────────────────

console.log("\nthe tier table loader\n");

await test("accepts the committed file and exposes its version, tiers and retired ids", () => {
  const snapshot = loadTierTableSnapshot();
  assert.strictEqual(snapshot.table.schema, TIER_TABLE_SCHEMA);
  assert.strictEqual(snapshot.table.version, TIER_TABLE_VERSION);
  assert.ok(TIER_TABLE_VERSION.length > 0);
  for (const tier of MODEL_TIERS) {
    assert.ok(tierModel(tier).length > 0, `tier ${tier} has no model`);
    assert.strictEqual(tierRow(tier).region, "global");
  }
  assert.ok(snapshot.table.retired.length >= 1);
});

await test("the stamp says where the copy came from and when", () => {
  const stamp = tierTableStamp();
  assert.ok(stamp.source.length > 0);
  assert.match(stamp.syncedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(stamp.etag.length > 0);
});

await test("refuses a wrapper with no stamp.syncedAt", () => {
  const broken = validSnapshot();
  delete (broken.stamp as Record<string, unknown>).syncedAt;
  assert.throws(
    () => validateTierTableSnapshot(broken, "test"),
    (err: unknown) => err instanceof TierTableError && /syncedAt/.test(err.message),
  );
});

await test("refuses a wrapper with no stamp at all", () => {
  assert.throws(
    () => validateTierTableSnapshot({ table: validSnapshot().table }, "test"),
    (err: unknown) => err instanceof TierTableError && /stamp/.test(err.message),
  );
});

await test("refuses a syncedAt that is not a date", () => {
  const broken = validSnapshot();
  (broken.stamp as Record<string, unknown>).syncedAt = "today";
  assert.throws(() => validateTierTableSnapshot(broken, "test"), TierTableError);
});

await test("refuses an unknown key at EVERY depth", () => {
  // The field set is closed in both directions: an unknown key means the
  // document came from a newer publisher, so the copy may carry a fact this
  // reader does not know to honour. Refusing makes a field addition a
  // deliberate change in every repository.
  const cases: Array<[string, (doc: Record<string, unknown>) => void]> = [
    ["the wrapper", (d) => { d.extra = 1; }],
    ["the stamp", (d) => { (d.stamp as Record<string, unknown>).extra = 1; }],
    ["the table", (d) => { (d.table as Record<string, unknown>).extra = 1; }],
    ["a tier", (d) => {
      const tiers = (d.table as Record<string, unknown>).tiers as Record<string, Record<string, unknown>>;
      tiers.standard!.pricing = { inputPerMillionUsd: 1 };
    }],
    ["a provenance block", (d) => {
      const tiers = (d.table as Record<string, unknown>).tiers as Record<string, Record<string, unknown>>;
      (tiers.standard!.baaProvenance as Record<string, unknown>).verifiedBy = "a person";
    }],
    ["a retired row", (d) => {
      const retired = (d.table as Record<string, unknown>).retired as Array<Record<string, unknown>>;
      retired[0]!.retiredOn = "2026-09-15";
    }],
  ];
  for (const [where, damage] of cases) {
    const broken = validSnapshot();
    damage(broken);
    assert.throws(
      () => validateTierTableSnapshot(broken, "test"),
      (err: unknown) => err instanceof TierTableError && /unknown key/.test(err.message),
      `an unknown key in ${where} was accepted`,
    );
  }
});

await test("refuses a missing required tier, a wrong schema and a defaulted coverage boolean", () => {
  const noTier = validSnapshot();
  delete ((noTier.table as Record<string, unknown>).tiers as Record<string, unknown>).advanced;
  assert.throws(() => validateTierTableSnapshot(noTier, "test"), TierTableError);

  const wrongSchema = validSnapshot();
  (wrongSchema.table as Record<string, unknown>).schema = "cascade-tier-table/2";
  assert.throws(() => validateTierTableSnapshot(wrongSchema, "test"), TierTableError);

  const noBool = validSnapshot();
  const tiers = (noBool.table as Record<string, unknown>).tiers as Record<string, Record<string, unknown>>;
  delete tiers.standard!.baaCovered;
  assert.throws(() => validateTierTableSnapshot(noBool, "test"), TierTableError);
});

await test("refuses a coverage claim with no provenance", () => {
  const broken = validSnapshot();
  const tiers = (broken.table as Record<string, unknown>).tiers as Record<string, Record<string, unknown>>;
  delete tiers.standard!.baaProvenance;
  assert.throws(
    () => validateTierTableSnapshot(broken, "test"),
    (err: unknown) => err instanceof TierTableError && /no baaProvenance/.test(err.message),
  );
});

await test("retired lookup returns the frozen facts, and undefined for an id it never named", () => {
  const retired = loadTierTableSnapshot().table.retired;
  for (const row of retired) {
    assert.deepStrictEqual(retiredModelFacts(row.model), {
      launchStage: row.launchStage,
      baaCovered: row.baaCovered,
    });
  }
  // Undefined means "not in this table", which is NOT the same fact as "was
  // not covered" and must never be flattened into it.
  assert.strictEqual(retiredModelFacts("a-model-this-relay-never-served"), undefined);
  // A current tier model is not retired.
  assert.strictEqual(retiredModelFacts(tierModel("standard")), undefined);
});

await test("knownModelIds is the union of current and retired, with no id in both halves", () => {
  const known = knownModelIds();
  const { table } = loadTierTableSnapshot();
  for (const row of Object.values(table.tiers)) assert.ok(known.includes(row.model));
  for (const row of table.retired) assert.ok(known.includes(row.model));
  assert.strictEqual(new Set(known).size, known.length, "an id appears twice");
});

await test("tierRow throws for a tier the table does not define", () => {
  assert.throws(() => tierRow("flash"), TierTableError);
});

// ── Nothing types a model id but the snapshot ────────────────────────────────

console.log("\nthe source scan: no model id is typed in this package\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "data" || entry === "tests") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `src/config.ts`'s MODEL_ALIASES is the ONE named exception, and it is not a
 * tier table. It maps user-facing CLI shorthands (`--model flash25`) onto
 * arbitrary public Gemini ids that this package's tier table has never named and
 * the relay has never served. Deleting those shorthands to satisfy a scan would
 * break a working flag in a public CLI for no gain. The assertion that has no
 * exception is the one below it: no id the tier table names may be typed
 * anywhere, config.ts included.
 */
const SCAN_EXCEPTIONS = new Set(["config.ts"]);

await test("no literal gemini-N model id outside the snapshot (one named exception)", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (SCAN_EXCEPTIONS.has(relative(SRC, file))) continue;
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, index) => {
      if (/gemini-[0-9]/.test(line)) offenders.push(`${relative(REPO, file)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `a model id is typed in this package. Read it from the snapshot instead:\n${offenders.join("\n")}`,
  );
});

await test("NO exception: no id the tier table names is typed anywhere in src", () => {
  const ids = knownModelIds();
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, index) => {
      for (const id of ids) {
        if (line.includes(id)) offenders.push(`${relative(REPO, file)}:${index + 1} names ${id}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [], offenders.join("\n"));
});

await test("the Vertex default and the tier table are ONE fact, not two", () => {
  assert.strictEqual(DEFAULT_VERTEX_MODEL, tierModel("standard"));
  assert.strictEqual(DEFAULT_VERTEX_MODEL, VERTEX_TIER_MODELS.standard.model);
});

await test("VERTEX_TIER_MODELS reads the snapshot on access, and keeps its shape", () => {
  for (const tier of MODEL_TIERS) {
    const row = VERTEX_TIER_MODELS[tier];
    assert.strictEqual(row.model, tierRow(tier).model);
    assert.strictEqual(row.baaCovered, tierRow(tier).baaCovered);
    assert.ok(row.launchStage === "GA" || row.launchStage === "PREVIEW");
    assert.ok((row.baaProvenance ?? "").includes(TIER_TABLE_VERSION));
  }
  // Still enumerable, because callers iterate it.
  assert.deepStrictEqual(Object.keys(VERTEX_TIER_MODELS).sort(), [...MODEL_TIERS].sort());
});

await test("both discovery routes in serve.ts publish the tier table version", () => {
  // A source assertion, not a request: `serve.test.ts` exercises a COPY of
  // these routes rather than the real app (starting the real one needs a model,
  // a config dir and a port). The copy is tested there; this pins that the real
  // handlers carry the field the copy claims they do.
  const text = readFileSync(join(SRC, "commands", "serve.ts"), "utf8");
  const health = text.slice(text.indexOf("app.get('/health'"));
  assert.ok(
    health.slice(0, health.indexOf("}));")).includes("tierTableVersion: TIER_TABLE_VERSION"),
    "GET /health does not publish tierTableVersion",
  );
  const models = text.slice(text.indexOf("app.get('/models'"));
  assert.ok(
    models.slice(0, models.indexOf("}));")).includes("tierTableVersion: TIER_TABLE_VERSION"),
    "GET /models does not publish tierTableVersion",
  );
});

// ── The reported model is the one that was dialed ────────────────────────────

console.log("\nthe response reports the model the resolved route dialed\n");

function stubProvider(endpoint: string, seen: { model?: string }): (model: string) => GatewayProvider {
  return (model: string) => {
    seen.model = model;
    return {
      endpointUrl: () => endpoint,
      complete: async () => "synthetic answer",
    };
  };
}

await test("on the ADC path the reported model is the tier's resolved id, and the request cannot name one", async () => {
  const seen: { model?: string } = {};
  const dir = mkdtempSync(join(tmpdir(), "cascade-tier-table-test-"));
  try {
    const result = await completeViaGateway(
      {
        prompt: "synthetic prompt",
        purpose: "assertion-grounding",
        modelTier: "advanced",
        containsPhi: false,
        // A model the caller would LIKE. The request type has no such field, so
        // this is dropped, and the response must still name the resolved one.
        ...({ model: "a-model-the-caller-asked-for" } as Record<string, unknown>),
        egress: { podDir: dir },
      },
      {
        makeProvider: stubProvider("https://aiplatform.googleapis.com/v1beta1/x", seen),
        writeLedger: async () => {},
      },
    );
    assert.strictEqual(result.model, tierModel("advanced"));
    assert.strictEqual(seen.model, tierModel("advanced"));
    assert.notStrictEqual(result.model, "a-model-the-caller-asked-for");
    assert.strictEqual(result.modelTier, "advanced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The sync script ──────────────────────────────────────────────────────────

console.log("\nthe sync script\n");

function publishedFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const table = JSON.parse(JSON.stringify(validSnapshot().table)) as Record<string, unknown>;
  return { ...table, ...overrides };
}

function stubFetch(body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch;
}

await test("--check exits 0 (unchanged) when the committed table matches the fetched one", async () => {
  const result = await syncTierTable({
    snapshotPath: SNAPSHOT,
    check: true,
    today: "2026-12-01",
    fetchImpl: stubFetch(publishedFixture()),
  });
  assert.strictEqual(result.outcome, "unchanged");
  assert.strictEqual(result.diff, undefined);
});

await test("--check reports a DIFF and does not write when the tables differ", async () => {
  const before = readFileSync(SNAPSHOT, "utf8");
  const result = await syncTierTable({
    snapshotPath: SNAPSHOT,
    check: true,
    today: "2026-12-01",
    fetchImpl: stubFetch(publishedFixture({ version: "google-2027-01-01" })),
  });
  assert.strictEqual(result.outcome, "differs");
  assert.ok(result.diff?.includes("-  \"version\": \"google-2026-09-15\""));
  assert.ok(result.diff?.includes("+  \"version\": \"google-2027-01-01\""));
  assert.strictEqual(readFileSync(SNAPSHOT, "utf8"), before, "--check wrote to the snapshot");
});

await test("--check ignores the stamp: a different syncedAt is not drift", async () => {
  const result = await syncTierTable({
    snapshotPath: SNAPSHOT,
    check: true,
    today: "2029-01-01",
    fetchImpl: stubFetch(publishedFixture()),
  });
  assert.strictEqual(result.outcome, "unchanged");
});

await test("a write records the ETag from the response header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cascade-tier-table-sync-"));
  const path = join(dir, "snapshot.json");
  try {
    await syncTierTable({
      snapshotPath: path,
      today: "2026-12-01",
      url: "https://relay.invalid/v1/tiers",
      fetchImpl: stubFetch(publishedFixture(), { etag: 'W/"google-2026-09-15"' }),
    });
    const written = validateTierTableSnapshot(JSON.parse(readFileSync(path, "utf8")), path);
    assert.strictEqual(written.stamp.etag, "google-2026-09-15");
    assert.strictEqual(written.stamp.syncedAt, "2026-12-01");
    assert.strictEqual(written.stamp.source, "https://relay.invalid/v1/tiers");
    assert.strictEqual(written.table.version, "google-2026-09-15");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a write falls back to the table version when the hop stripped the ETag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cascade-tier-table-sync-"));
  const path = join(dir, "snapshot.json");
  try {
    await syncTierTable({
      snapshotPath: path,
      today: "2026-12-01",
      fetchImpl: stubFetch(publishedFixture({ version: "google-2027-05-05" })),
    });
    const written = JSON.parse(readFileSync(path, "utf8")) as { stamp: { etag: string } };
    assert.strictEqual(written.stamp.etag, "google-2027-05-05");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("--from reads a local document, and accepts a stamped wrapper as well as a bare table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cascade-tier-table-sync-"));
  try {
    const bare = join(dir, "bare.json");
    const wrapped = join(dir, "wrapped.json");
    writeFileSync(bare, JSON.stringify(publishedFixture()));
    writeFileSync(wrapped, readFileSync(SNAPSHOT, "utf8"));
    for (const from of [bare, wrapped]) {
      const out = join(dir, "out.json");
      const result = await syncTierTable({ snapshotPath: out, fromFile: from, today: "2026-12-01" });
      assert.strictEqual(result.version, TIER_TABLE_VERSION);
      assert.strictEqual(
        validateTierTableSnapshot(JSON.parse(readFileSync(out, "utf8")), out).stamp.source,
        from,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a fetched document that fails validation is never written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cascade-tier-table-sync-"));
  const path = join(dir, "snapshot.json");
  try {
    await assert.rejects(
      syncTierTable({
        snapshotPath: path,
        today: "2026-12-01",
        fetchImpl: stubFetch(publishedFixture({ surprise: true })),
      }),
      TierTableError,
    );
    assert.throws(() => readFileSync(path, "utf8"), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a non-200 response is an error, not a silently empty table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cascade-tier-table-sync-"));
  try {
    await assert.rejects(
      syncTierTable({
        snapshotPath: join(dir, "snapshot.json"),
        today: "2026-12-01",
        fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
      }),
      /503/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("validatePublishedTierTable refuses a bare document with an unknown key", () => {
  assert.throws(
    () => validatePublishedTierTable(publishedFixture({ pricing: {} }), "test"),
    (err: unknown) => err instanceof TierTableError && /unknown key/.test(err.message),
  );
});

await test("the unified diff marks removals and additions and keeps context", () => {
  const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "before", "after");
  assert.ok(diff.includes("--- before"));
  assert.ok(diff.includes("+++ after"));
  assert.ok(diff.includes("-b"));
  assert.ok(diff.includes("+B"));
  assert.ok(diff.includes(" a"));
  assert.ok(diff.includes(" c"));
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
