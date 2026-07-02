/**
 * Unit tests for the sidecar literature fetch (grounding G-3 / platform §4.4).
 *
 * ZERO real network, ZERO credentials, ZERO PHI. They prove the load-bearing
 * egress + safety behavior:
 *  - a metadata-only ledger entry is written BEFORE the dial (fail-closed:
 *    a failed audit write aborts, no fetch happens)
 *  - the ledger endpoint carries NO query string and NO api_key; contentBytes
 *    measures the caller's query, not content text
 *  - kind="http", containsPhi=false, provider derived from the host
 *  - SSRF guard: only Europe PMC + NCBI E-utilities hosts, https only
 *  - NCBI etiquette (api_key/tool/email) is injected AFTER logging; Europe PMC
 *    gets no api_key
 *  - a User-Agent identifying the tool is sent
 *  - 429 retries with backoff, then returns
 *  - same-host calls are rate-limited by the min interval
 *  - loadLocalEnv never overwrites an existing env value
 *
 * Run with: npx tsx src/tests/literature.test.ts
 */
import assert from "assert";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createLiteratureFetcher,
  literatureProviderForHost,
  loadLocalEnv,
  type HttpResponse,
} from "../literature.js";
import type { EgressLogEntry } from "../providers/trusted-endpoint.js";

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

const EPMC =
  "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=creatine&format=json";
const EUTILS =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=123";

function okResponse(body = "{}", status = 200): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

interface Recorder {
  urls: string[];
  headers: Record<string, string>[];
  entries: EgressLogEntry[];
  logPaths: string[];
}

function harness(
  responses: HttpResponse[] | ((url: string) => HttpResponse),
  opts: { ledgerThrows?: boolean } = {},
) {
  const rec: Recorder = { urls: [], headers: [], entries: [], logPaths: [] };
  let i = 0;
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    rec.urls.push(url);
    rec.headers.push(init?.headers ?? {});
    if (typeof responses === "function") return responses(url);
    return responses[Math.min(i++, responses.length - 1)];
  };
  const writeLedger = (entry: EgressLogEntry, logPath: string) => {
    if (opts.ledgerThrows) throw new Error("disk full");
    rec.entries.push(entry);
    rec.logPaths.push(logPath);
  };
  return { rec, fetchImpl, writeLedger };
}

const REQ = { url: EPMC, purpose: "literature-search", logPath: "/pod/provenance/egress-log.jsonl" };

async function main() {
  await test("host allowlist maps only the two literature hosts", () => {
    assert.equal(literatureProviderForHost("www.ebi.ac.uk"), "europe-pmc");
    assert.equal(literatureProviderForHost("eutils.ncbi.nlm.nih.gov"), "ncbi-eutils");
    assert.equal(literatureProviderForHost("evil.example.com"), null);
    assert.equal(literatureProviderForHost("ebi.ac.uk"), null); // exact host only
  });

  await test("writes a metadata-only ledger entry BEFORE the dial", async () => {
    const { rec, fetchImpl, writeLedger } = harness([okResponse()]);
    let ledgerWrittenBeforeFetch = false;
    const fetchWrap = async (u: string, init?: { headers?: Record<string, string> }) => {
      ledgerWrittenBeforeFetch = rec.entries.length === 1;
      return fetchImpl(u, init);
    };
    const fetcher = createLiteratureFetcher({}, { fetchImpl: fetchWrap, writeLedger });
    await fetcher(REQ);
    assert.equal(ledgerWrittenBeforeFetch, true, "ledger must be written before fetch");
    assert.equal(rec.entries.length, 1);
    const e = rec.entries[0]!;
    assert.equal(e.kind, "http");
    assert.equal(e.provider, "europe-pmc");
    assert.equal(e.containsPhi, false);
    assert.equal(e.direction, "outbound");
    assert.equal(e.purpose, "literature-search");
    assert.equal(rec.logPaths[0], "/pod/provenance/egress-log.jsonl");
  });

  await test("ledger endpoint has NO query string and NO api_key", async () => {
    const { rec, fetchImpl, writeLedger } = harness([okResponse()]);
    const fetcher = createLiteratureFetcher(
      { ncbiApiKey: "SECRETKEY123" },
      { fetchImpl, writeLedger },
    );
    await fetcher({ ...REQ, url: EUTILS });
    const e = rec.entries[0]!;
    assert.ok(!e.endpoint.includes("?"), "endpoint must not carry a query string");
    assert.ok(!e.endpoint.includes("SECRETKEY123"), "api_key must never reach the ledger");
    assert.ok(!e.endpoint.includes("term=123"), "query text must not reach the ledger");
    // contentBytes = byte length of the caller's query, not the content text.
    assert.equal(e.summary.contentBytes, Buffer.byteLength("?db=pubmed&term=123", "utf-8"));
    assert.equal(e.summary.messageCount, 1);
    assert.equal(e.summary.toolCount, 0);
  });

  await test("fail-closed: a failed audit write aborts, NO fetch happens", async () => {
    const { rec, fetchImpl, writeLedger } = harness([okResponse()], { ledgerThrows: true });
    const fetcher = createLiteratureFetcher({}, { fetchImpl, writeLedger });
    await assert.rejects(() => fetcher(REQ), /disk full/);
    assert.equal(rec.urls.length, 0, "no network call may happen when the audit fails");
  });

  await test("SSRF guard: non-allowlisted host, non-https, and garbage all throw pre-dial", async () => {
    const { rec, fetchImpl, writeLedger } = harness([okResponse()]);
    const fetcher = createLiteratureFetcher({}, { fetchImpl, writeLedger });
    await assert.rejects(
      () => fetcher({ ...REQ, url: "https://evil.example.com/x?q=1" }),
      /allowlist/,
    );
    await assert.rejects(
      () => fetcher({ ...REQ, url: "http://www.ebi.ac.uk/x" }),
      /https/,
    );
    await assert.rejects(() => fetcher({ ...REQ, url: "not a url" }), /unparseable/);
    assert.equal(rec.urls.length, 0, "blocked requests never dial and never log");
    assert.equal(rec.entries.length, 0);
  });

  await test("NCBI etiquette injected AFTER logging; Europe PMC gets no api_key", async () => {
    const { rec, fetchImpl, writeLedger } = harness([okResponse(), okResponse()]);
    const fetcher = createLiteratureFetcher(
      { ncbiApiKey: "KEY", ncbiTool: "cascade-workbench", ncbiEmail: "a@b.co" },
      { fetchImpl, writeLedger },
    );
    await fetcher({ ...REQ, url: EUTILS });
    const eutilsUrl = new URL(rec.urls[0]!);
    assert.equal(eutilsUrl.searchParams.get("api_key"), "KEY");
    assert.equal(eutilsUrl.searchParams.get("tool"), "cascade-workbench");
    assert.equal(eutilsUrl.searchParams.get("email"), "a@b.co");

    await fetcher({ ...REQ, url: EPMC });
    const epmcUrl = new URL(rec.urls[1]!);
    assert.equal(epmcUrl.searchParams.get("api_key"), null, "no NCBI key on Europe PMC");
  });

  await test("sends a User-Agent identifying the tool", async () => {
    const { rec, fetchImpl, writeLedger } = harness([okResponse()]);
    const fetcher = createLiteratureFetcher(
      { ncbiTool: "cascade-workbench", ncbiEmail: "a@b.co" },
      { fetchImpl, writeLedger },
    );
    await fetcher(REQ);
    assert.match(rec.headers[0]!["User-Agent"] ?? "", /cascade-workbench/);
  });

  await test("retries a 429 with backoff, then returns the eventual success", async () => {
    const seq = [okResponse("busy", 429), okResponse('{"ok":1}', 200)];
    const { rec, fetchImpl, writeLedger } = harness(seq);
    const waits: number[] = [];
    const fetcher = createLiteratureFetcher(
      { maxRetries: 2 },
      { fetchImpl, writeLedger, sleep: async (ms) => void waits.push(ms), now: () => 0 },
    );
    const res = await fetcher(REQ);
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"ok":1}');
    assert.equal(rec.urls.length, 2, "one retry after the 429");
    assert.ok(waits.some((w) => w > 0), "backoff sleep happened");
    // Only ONE ledger entry for the logical call (retries do not re-log).
    assert.equal(rec.entries.length, 1);
  });

  await test("gives up after maxRetries and returns the last failing response", async () => {
    const { rec, fetchImpl, writeLedger } = harness(() => okResponse("still busy", 429));
    const fetcher = createLiteratureFetcher(
      { maxRetries: 2 },
      { fetchImpl, writeLedger, sleep: async () => {}, now: () => 0 },
    );
    const res = await fetcher(REQ);
    assert.equal(res.status, 429);
    assert.equal(rec.urls.length, 3, "initial + 2 retries");
  });

  await test("rate-limits same-host calls to the min interval", async () => {
    const { rec, fetchImpl, writeLedger } = harness([okResponse(), okResponse()]);
    let clock = 0;
    const waits: number[] = [];
    const fetcher = createLiteratureFetcher(
      { minIntervalMs: 100 },
      {
        fetchImpl,
        writeLedger,
        now: () => clock,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
      },
    );
    await fetcher(REQ); // first call: no wait
    await fetcher(REQ); // second immediate call: must wait ~100ms
    assert.ok(waits.includes(100), `expected a 100ms rate-limit wait, saw ${waits}`);
  });

  await test("loadLocalEnv parses KEY=value, respects comments/quotes, never overwrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "litenv-"));
    const file = join(dir, ".env.local");
    writeFileSync(
      file,
      "# a comment\nNCBI_API_KEY=abc123\nNCBI_EMAIL=\"x@y.co\"\nALREADY=fromfile\n",
    );
    const env: NodeJS.ProcessEnv = { ALREADY: "fromenv" };
    loadLocalEnv(file, env);
    assert.equal(env.NCBI_API_KEY, "abc123");
    assert.equal(env.NCBI_EMAIL, "x@y.co", "quotes stripped");
    assert.equal(env.ALREADY, "fromenv", "existing env value must win over the file");
    // missing file is a no-op
    loadLocalEnv(join(dir, "nope.env"), env);
    rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
