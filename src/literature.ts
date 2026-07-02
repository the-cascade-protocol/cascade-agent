/**
 * Sidecar-side literature fetch: the single logged, allowlisted egress path for
 * the grounding literature tool (Europe PMC + PubMed E-utilities).
 *
 * Why this lives in the sidecar and not the renderer (platform §4.4 / §4.7 +
 * grounding G-3):
 *   1. Every outbound literature request writes a metadata-only entry to the
 *      single egress ledger BEFORE the network call (fail-closed: no egress
 *      without its audit line), so the egress report never under-reports.
 *   2. The NCBI API key + contact etiquette live here (an env secret), never in
 *      the renderer bundle.
 *   3. The host allowlist makes this a literature proxy, not a general SSRF
 *      surface: only Europe PMC and NCBI E-utilities are reachable.
 *
 * The de-identified query is built upstream (workbench `deid-question.ts`); this
 * path carries no PHI, so ledger entries are `containsPhi: false`. The ledger
 * endpoint is logged WITHOUT its query string, so neither the query text nor the
 * injected api_key can reach the log.
 */

import { readFileSync } from "node:fs";
import {
  writeEgressLogStrict,
  type EgressLogEntry,
  type HttpEgressProvider,
} from "./providers/trusted-endpoint.js";

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

const EUROPE_PMC_HOST = "www.ebi.ac.uk";
const NCBI_EUTILS_HOST = "eutils.ncbi.nlm.nih.gov";

/** Map an allowlisted host to its ledger provider name, or null if blocked. */
export function literatureProviderForHost(
  host: string,
): HttpEgressProvider | null {
  if (host === EUROPE_PMC_HOST) return "europe-pmc";
  if (host === NCBI_EUTILS_HOST) return "ncbi-eutils";
  return null;
}

// ---------------------------------------------------------------------------
// Config (env-sourced; injectable for tests)
// ---------------------------------------------------------------------------

export interface LiteratureConfig {
  /** NCBI E-utilities API key (raises rate limit 3->10 req/sec). Optional. */
  ncbiApiKey?: string;
  /** NCBI `tool` identifier (etiquette). */
  ncbiTool?: string;
  /** NCBI/Europe PMC `email` contact (etiquette). */
  ncbiEmail?: string;
  /** Min milliseconds between calls to the same host (rate-limit). */
  minIntervalMs?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Max retries on a 429/5xx before giving up. */
  maxRetries?: number;
}

export function literatureConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiteratureConfig {
  return {
    ncbiApiKey: env.NCBI_API_KEY?.trim() || undefined,
    ncbiTool: env.NCBI_TOOL?.trim() || "cascade-workbench",
    ncbiEmail: env.NCBI_EMAIL?.trim() || undefined,
  };
}

// ---------------------------------------------------------------------------
// The minimal fetch surface + injectable seams (for tests)
// ---------------------------------------------------------------------------

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchImpl = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "follow" | "manual" | "error";
  },
) => Promise<HttpResponse>;

export interface LiteratureFetchDeps {
  fetchImpl?: FetchImpl;
  writeLedger?: (entry: EgressLogEntry, logPath: string) => void;
  /** Monotonic clock (ms). Default Date.now. */
  now?: () => number;
  /** Sleep for ms. Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LiteratureFetchRequest {
  /** The URL to fetch. Built upstream by the reused EuropePmcTool URL logic. */
  url: string;
  /** Why the call happened (recorded on the ledger). */
  purpose: string;
  /** Absolute path to the Pod egress log (`<pod>/provenance/egress-log.jsonl`). */
  logPath: string;
}

export interface LiteratureFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

const DEFAULT_MIN_INTERVAL_MS = 120;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * A stateful literature fetcher (holds per-host rate-limit timestamps).
 * Construct once per sidecar process; reuse across requests.
 */
export function createLiteratureFetcher(
  config: LiteratureConfig = literatureConfigFromEnv(),
  deps: LiteratureFetchDeps = {},
) {
  const fetchImpl: FetchImpl =
    deps.fetchImpl ??
    ((url, init) =>
      (globalThis.fetch as unknown as FetchImpl)(url, init));
  const writeLedger = deps.writeLedger ?? writeEgressLogStrict;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const minInterval = config.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

  const lastCallAt = new Map<string, number>();

  /** Append the api_key/tool/email etiquette params to an NCBI E-utilities URL. */
  function withEtiquette(parsed: URL, provider: HttpEgressProvider): URL {
    const out = new URL(parsed.toString());
    if (provider === "ncbi-eutils") {
      if (config.ncbiApiKey && !out.searchParams.has("api_key")) {
        out.searchParams.set("api_key", config.ncbiApiKey);
      }
      if (config.ncbiTool && !out.searchParams.has("tool")) {
        out.searchParams.set("tool", config.ncbiTool);
      }
      if (config.ncbiEmail && !out.searchParams.has("email")) {
        out.searchParams.set("email", config.ncbiEmail);
      }
    }
    return out;
  }

  function userAgent(): string {
    const tool = config.ncbiTool ?? "cascade-workbench";
    return config.ncbiEmail ? `${tool} (${config.ncbiEmail})` : tool;
  }

  async function rateLimit(host: string): Promise<void> {
    const last = lastCallAt.get(host);
    const current = now();
    if (last !== undefined) {
      const wait = last + minInterval - current;
      if (wait > 0) await sleep(wait);
    }
    lastCallAt.set(host, now());
  }

  return async function literatureFetch(
    req: LiteratureFetchRequest,
  ): Promise<LiteratureFetchResult> {
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      throw new Error(`literature fetch: unparseable URL`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`literature fetch: only https is allowed`);
    }
    const provider = literatureProviderForHost(parsed.host);
    if (!provider) {
      // SSRF guard: only the two literature hosts are reachable through here.
      throw new Error(
        `literature fetch: host not on the allowlist (${parsed.host})`,
      );
    }

    // 1. Write the ledger entry BEFORE the dial. Endpoint is logged WITHOUT the
    //    query string, so neither the query nor the injected api_key is stored.
    //    contentBytes measures the query the CALLER built (pre-etiquette).
    const entry: EgressLogEntry = {
      timestamp: new Date(now()).toISOString(),
      kind: "http",
      provider,
      endpoint: `${parsed.origin}${parsed.pathname}`,
      model:
        provider === "europe-pmc" ? "europe-pmc-rest" : "pubmed-eutils",
      direction: "outbound",
      summary: {
        messageCount: 1,
        contentBytes: Buffer.byteLength(parsed.search, "utf-8"),
        toolCount: 0,
      },
      purpose: req.purpose,
      containsPhi: false,
      launchStage: "GA",
    };
    // Fail-closed: a failed audit write throws and no fetch happens.
    writeLedger(entry, req.logPath);

    // 2. Inject etiquette (key/tool/email) AFTER logging, so they never appear
    //    in the ledger.
    const finalUrl = withEtiquette(parsed, provider);

    // 3. Rate-limit, then dial with a timeout and bounded 429/5xx retry.
    let attempt = 0;
    for (;;) {
      await rateLimit(parsed.host);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: HttpResponse;
      try {
        response = await fetchImpl(finalUrl.toString(), {
          headers: { "User-Agent": userAgent() },
          signal: controller.signal,
          // Do NOT auto-follow redirects: a 3xx to an off-allowlist host would
          // otherwise egress to an unvetted host under this call's ledger line.
          // These stable REST APIs do not legitimately redirect off-host, so we
          // fail closed (the allowlist is the security boundary, not advisory).
          redirect: "manual",
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        throw new Error(
          `literature fetch: refusing to follow a redirect off the allowlist ` +
            `(HTTP ${response.status})`,
        );
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        attempt += 1;
        const retryAfter = Number(response.headers.get("retry-after"));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : minInterval * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }

      const body = await response.text();
      return { ok: response.ok, status: response.status, body };
    }
  };
}

export type LiteratureFetcher = ReturnType<typeof createLiteratureFetcher>;

// ---------------------------------------------------------------------------
// Local secrets loader (dependency-free .env.local)
// ---------------------------------------------------------------------------

/**
 * Load `KEY=value` pairs from a gitignored `.env.local` into `process.env`,
 * without overwriting values already set in the environment (so a value the
 * host process injected — e.g. from the OS keychain in production — always
 * wins over the dev file). No external dependency; only the simple
 * `KEY=value` / `# comment` grammar this project uses. Missing file = no-op.
 */
export function loadLocalEnv(
  path: string = `${process.cwd()}/.env.local`,
  env: NodeJS.ProcessEnv = process.env,
): void {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return; // no file, no secrets to load
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}
