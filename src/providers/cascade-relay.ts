/**
 * Cascade relay provider — the app's cloud path for testers (D-RMA-0/2).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE IS DELIBERATELY SMALL, AND THAT IS THE POINT.                   │
 * │                                                                           │
 * │ `VertexProvider` carries ADC acquisition (two paths, ~50 lines),          │
 * │ `x-goog-user-project` quota pinning, `google/` model qualification and     │
 * │ global-host special-casing. The relay provider needs NONE of it: the       │
 * │ relay holds the tier table, resolves the model, and authenticates          │
 * │ upstream itself. What is left is a base URL, a bearer token and two        │
 * │ headers. If this file starts growing toward vertex.ts, the abstraction     │
 * │ is wrong and D-RMA-28 (swap providers with zero app releases) is at risk.  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * What it adds over a bare `OpenAICompatProvider`:
 *
 *   1. `x-cascade-tier` and `x-cascade-purpose` on every request.
 *   2. Capture of the upstream attestation response headers (D-RMA-26), so the
 *      gateway can write the two-hop ledger's reconciliation line from DATA.
 *   3. Failure classification: a structured refusal (the relay answered and
 *      said no) is NOT an outage (the relay did not answer). Only the latter
 *      may trigger the fall back to local (D-RMA-5).
 *
 * It never sees a provider name, a model id, or a region until the relay tells
 * it one. That is what keeps a provider swap a relay config change.
 */

import type { CanonicalTool } from "../tools.js";
import type {
  Provider,
  SimpleMessage,
  AgentCallbacks,
  CompleteOptions,
} from "./types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { DescribesEndpoint } from "./trusted-endpoint.js";
import {
  HEADER_PURPOSE,
  HEADER_TIER,
  RelayOutageError,
  parseRelayRefusal,
  readUpstreamAttestation,
  resolveRelayBaseUrl,
  type RelayUpstreamAttestation,
} from "../relay/contract.js";

export interface CascadeRelayOptions {
  /** The opaque device token from the keychain. Sent as the bearer. */
  deviceToken: string;
  /** Tier the caller asked for; the RELAY resolves it to a model. */
  tier: string;
  /** Closed-enum purpose for this call. */
  purpose: string;
  /** Base URL override (dev/stub). Defaults to the canonical relay. */
  baseUrl?: string;
  /** Injected fetch, for tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

export class CascadeRelayProvider implements Provider, DescribesEndpoint {
  readonly providerName = "cascade-relay" as const;
  /**
   * The tier, in the field the OpenAI wire protocol calls `model`. The client
   * genuinely does not know which model it will get: the relay decides, and
   * says so afterward in the attestation headers. Sending the tier here keeps
   * the body honest rather than asserting a model id we did not choose.
   */
  readonly model: string;
  readonly baseUrl: string;
  private readonly options: CascadeRelayOptions;
  private attestation: RelayUpstreamAttestation | null = null;
  /**
   * The typed classification of the most recent transport failure. The OpenAI
   * SDK catches anything a custom `fetch` throws and re-wraps it as a generic
   * `APIConnectionError`, which would flatten "the relay refused because your
   * daily cap is used up" into "connection error" — the exact silent
   * degradation D-RMA-5 exists to prevent. So the wrapper parks its verdict
   * here and the call sites re-throw it in place of the SDK's wrapper.
   */
  private pendingFailure: Error | null = null;

  constructor(options: CascadeRelayOptions) {
    this.options = options;
    this.model = options.tier;
    this.baseUrl = resolveRelayBaseUrl(options.baseUrl);
  }

  /**
   * The destination the APP dialed and can prove it dialed (D-RMA-25). The
   * upstream beyond it is the relay's account, recorded separately.
   */
  endpointUrl(): string {
    return this.baseUrl;
  }

  /**
   * The relay's report of what actually served the most recent call, or null
   * when no call has completed or the relay sent no attestation headers.
   * NEVER inferred: absent headers mean an absent reconciliation line, not a
   * guessed one.
   */
  lastUpstreamAttestation(): RelayUpstreamAttestation | null {
    return this.attestation;
  }

  /**
   * A fetch wrapper that (a) captures the attestation headers off a successful
   * response and (b) converts a non-2xx into either a typed refusal or a typed
   * outage BEFORE the OpenAI SDK sees it, so the SDK's own retry logic never
   * re-sends a request the relay already refused.
   */
  private wrappedFetch(): typeof fetch {
    const base = this.options.fetchImpl ?? fetch;
    const fail = (err: Error): never => {
      this.pendingFailure = err;
      throw err;
    };
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      let res: Response;
      try {
        res = await base(input, init);
      } catch (err) {
        // Transport failure: DNS, connection refused, TLS, abort on timeout.
        // This is an outage, and the app may fall back to local for it.
        return fail(
          new RelayOutageError(
            `Could not reach Cascade cloud models at ${this.baseUrl}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
          ),
        );
      }
      if (res.ok) {
        this.attestation = readUpstreamAttestation(res.headers);
        return res;
      }
      // Non-2xx. Read the body ONCE (we are not passing it on), and decide
      // whether the relay refused (a stated policy answer) or failed (an
      // outage). Anything that does not name a known reason code is an outage:
      // falling back to local is never a privacy downgrade.
      let body: unknown = null;
      try {
        body = await res.clone().json();
      } catch {
        body = null;
      }
      const refusal = parseRelayRefusal(
        res.status,
        body,
        res.headers.get("retry-after"),
      );
      if (refusal) return fail(refusal);
      return fail(
        new RelayOutageError(
          `Cascade cloud models returned HTTP ${res.status} from ${this.baseUrl}.`,
          { status: res.status },
        ),
      );
    }) as typeof fetch;
  }

  private delegate(): OpenAICompatProvider {
    // The OpenAI SDK sends `apiKey` as `Authorization: Bearer <key>`, which is
    // exactly the relay's device-token scheme. Two Cascade headers ride along;
    // there is nothing else provider-specific to add.
    return new OpenAICompatProvider(
      "cascade-relay",
      this.options.deviceToken,
      this.model,
      this.baseUrl,
      {
        [HEADER_TIER]: this.options.tier,
        [HEADER_PURPOSE]: this.options.purpose,
      },
      { fetch: this.wrappedFetch(), maxRetries: 0 },
    );
  }

  /**
   * Run one delegated call, replacing the SDK's generic connection error with
   * the typed refusal/outage the transport wrapper already determined. Without
   * this, "your daily allowance is used up" reaches the app as "connection
   * error" and gets treated as an outage, which would silently spend a
   * tester's goodwill on a fall back they were never told about.
   */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingFailure = null;
    try {
      return await fn();
    } catch (err) {
      if (this.pendingFailure) throw this.pendingFailure;
      throw err;
    }
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const delegate = this.delegate();
    return this.run(() => delegate.complete(prompt, opts));
  }

  async runTurn(
    messages: SimpleMessage[],
    tools: CanonicalTool[],
    callbacks: AgentCallbacks,
  ): Promise<string> {
    const delegate = this.delegate();
    return this.run(() => delegate.runTurn(messages, tools, callbacks));
  }

  /**
   * The client does not enumerate models: it names tiers, and the relay owns
   * the tier table. Returning the tiers keeps any picker honest about what a
   * caller may actually ask for.
   */
  async listModels(): Promise<string[]> {
    return [this.model];
  }
}
