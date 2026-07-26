/**
 * The Cascade relay wire contract, frozen 2026-07-26.
 *
 * The relay ([ALPHA-MODEL-ACCESS], D-RMA-0/1/2) is a Cloud Run service that
 * speaks OpenAI-compatible Chat Completions to this client and to the upstream
 * provider. This module holds ONLY the frozen wire vocabulary: header names,
 * endpoint paths, refusal reason codes, and the status/notice shapes. It has no
 * behavior, so both the provider and the status client build against one copy
 * and a drift shows up as a type error rather than as a runtime 400.
 *
 * Deliberately NOT here: the tier table. The relay owns tier → provider/model/
 * endpoint/region resolution (D-RMA-6); the client names a tier and is told
 * what it got, in response headers, after the fact (D-RMA-26).
 */

// ── Host and paths (D-RMA-38) ────────────────────────────────────────────────

/**
 * The relay's canonical hostname. Chosen so a tester reading their own egress
 * ledger finds the same organization that published the privacy policy.
 * Explicitly NOT `cascadeprotocol.org`, which is the open protocol's identity.
 */
export const CASCADE_RELAY_HOST = "relay.cascadeagenticlabs.com";

/** The relay's OpenAI-compatible base URL (what the provider's baseURL is). */
export const DEFAULT_CASCADE_RELAY_BASE_URL = `https://${CASCADE_RELAY_HOST}/v1`;

/**
 * Resolve the relay base URL: an explicit value, then `CASCADE_RELAY_BASE_URL`
 * (used to point at a local stub in development and in this repo's tests),
 * then the canonical production URL.
 *
 * A non-canonical base URL is deliberately NOT BAA-covered by
 * `isBaaCoveredEndpoint`, so a dev override fails the PHI gate closed rather
 * than quietly routing records through an unverified host.
 */
export function resolveRelayBaseUrl(explicit?: string): string {
  const fromEnv = process.env.CASCADE_RELAY_BASE_URL;
  return explicit ?? (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_CASCADE_RELAY_BASE_URL);
}

/** Status poll path, relative to the relay origin (not the /v1 base URL). */
export const RELAY_STATUS_PATH = "/v1/status";

/** Feedback path, relative to the relay origin. */
export const RELAY_FEEDBACK_PATH = "/v1/feedback";

// ── Request headers ──────────────────────────────────────────────────────────

/** Tier the caller wants; the relay resolves it to a concrete model. */
export const HEADER_TIER = "x-cascade-tier";

/** Which part of Workbench asked. Validated against the closed purpose enum. */
export const HEADER_PURPOSE = "x-cascade-purpose";

// ── Response headers: the relay's account of the upstream (D-RMA-26) ─────────

/**
 * The upstream attestation headers. The ledger's reconciliation line is
 * written FROM these values and never inferred: an inference in an audit
 * record is a guess wearing a fact's clothes.
 */
export const UPSTREAM_HEADERS = {
  provider: "x-cascade-upstream-provider",
  model: "x-cascade-upstream-model",
  endpoint: "x-cascade-upstream-endpoint",
  region: "x-cascade-upstream-region",
  launchStage: "x-cascade-upstream-launch-stage",
} as const;

/**
 * What the relay reported about the upstream that actually served a request.
 * Every field is optional because this is TESTIMONY, not proof: the app
 * verified it dialed the relay and records the rest as quoted.
 *
 * `provider` is a DISPLAY string supplied by the relay's tier table
 * (D-RMA-41: "Google Gemini Enterprise Agent Platform"). The client never
 * hardcodes a provider display name.
 */
export interface RelayUpstreamAttestation {
  provider?: string;
  model?: string;
  endpoint?: string;
  region?: string;
  launchStage?: string;
}

/** True when the relay reported at least one upstream fact worth recording. */
export function hasUpstreamFacts(a: RelayUpstreamAttestation): boolean {
  return Boolean(a.provider || a.model || a.endpoint || a.region || a.launchStage);
}

/** Read the upstream attestation out of a fetch Response's headers. */
export function readUpstreamAttestation(headers: Headers): RelayUpstreamAttestation {
  const get = (name: string): string | undefined => {
    const v = headers.get(name);
    return v && v.trim().length > 0 ? v.trim() : undefined;
  };
  return {
    provider: get(UPSTREAM_HEADERS.provider),
    model: get(UPSTREAM_HEADERS.model),
    endpoint: get(UPSTREAM_HEADERS.endpoint),
    region: get(UPSTREAM_HEADERS.region),
    launchStage: get(UPSTREAM_HEADERS.launchStage),
  };
}

// ── Refusals (structured, with a reason code the app can render) ─────────────

/**
 * The relay's refusal reason codes. These are NOT outages (D-RMA-5): the relay
 * answered, and it said no for a stated reason. The app renders each one
 * distinctly and NEVER treats one as a transport failure to retry around.
 */
export const RELAY_REFUSAL_REASONS = [
  "revoked",
  "tier-off",
  "global-off",
  "daily-cap",
  "monthly-ceiling",
  "rate-limit",
  "unknown-purpose",
  "baa-uncovered",
] as const;

export type RelayRefusalReason = (typeof RELAY_REFUSAL_REASONS)[number];

export function isRelayRefusalReason(v: unknown): v is RelayRefusalReason {
  return (
    typeof v === "string" &&
    (RELAY_REFUSAL_REASONS as readonly string[]).includes(v)
  );
}

/**
 * The relay answered and refused. Carries the reason code so the app can render
 * the right notice ("your daily allowance is used up" is a different sentence
 * from "cloud access was turned off for this Mac").
 */
export class RelayRefusalError extends Error {
  readonly reason: RelayRefusalReason;
  readonly status: number;
  /** Seconds to wait, when the relay supplied a Retry-After (rate-limit). */
  readonly retryAfterSeconds?: number;

  constructor(details: {
    reason: RelayRefusalReason;
    status: number;
    message?: string;
    retryAfterSeconds?: number;
  }) {
    super(
      details.message ??
        `Cascade cloud models refused this request (${details.reason}).`,
    );
    this.name = "RelayRefusalError";
    this.reason = details.reason;
    this.status = details.status;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/**
 * The relay did not answer usefully: a timeout, a network error, or a 5xx.
 * THIS is the outage class D-RMA-5 lets the app fall back to local for. A
 * refusal is never wrapped in one of these.
 */
export class RelayOutageError extends Error {
  /** HTTP status when there was one; absent for a transport failure. */
  readonly status?: number;
  readonly cause?: unknown;

  constructor(message: string, details: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "RelayOutageError";
    this.status = details.status;
    this.cause = details.cause;
  }
}

// ── Entitlement status + notices (D-RMA-11, D-RMA-22) ───────────────────────

/**
 * Entitlement states, as TYPED states rather than server strings. A kill switch
 * that reaches the UI as free text is a kill switch the UI cannot reason about.
 */
export const RELAY_ENTITLEMENT_STATES = [
  /** Cloud models are available to this Mac right now. */
  "active",
  /** A person revoked this device (D-RMA-17: only a person revokes). */
  "revoked",
  /** This device used its daily allowance; resets at UTC midnight. */
  "daily-cap",
  /** The global monthly ceiling was reached; nobody is being served. */
  "global-paused",
  /** This tier is switched off; another tier may still work. */
  "tier-off",
  /** The relay answered but its state is not one this client knows. */
  "unknown",
] as const;

export type RelayEntitlementState = (typeof RELAY_ENTITLEMENT_STATES)[number];

export function isRelayEntitlementState(v: unknown): v is RelayEntitlementState {
  return (
    typeof v === "string" &&
    (RELAY_ENTITLEMENT_STATES as readonly string[]).includes(v)
  );
}

/**
 * The server-to-app notice channel (D-RMA-22). One mechanism serves both the
 * kill-switch explanation and the tester notice, because the kill switch needs
 * the channel anyway and making it general costs one field.
 *
 * `body` is Jed's own words (D-RMA-34) and is rendered as a quoted block, so
 * a person's name never has to live in a product string.
 */
export interface RelayNotice {
  title: string;
  body: string;
  link?: string;
}

/** Parsed `GET /v1/status` response. */
export interface RelayStatus {
  /** Typed entitlement state. Never a raw server string. */
  state: RelayEntitlementState;
  /** The raw state string, kept so an unknown state is still auditable. */
  rawState?: string;
  /** Cloud requests this device made this month, when the relay reports it. */
  requestsThisMonth?: number;
  /** Tokens this device used this month, when the relay reports it. */
  tokensThisMonth?: number;
  /** Optional operator notice to surface (D-RMA-22). */
  notice?: RelayNotice;
}

function asPositiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : undefined;
}

function asNotice(v: unknown): RelayNotice | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.title !== "string" || typeof o.body !== "string") return undefined;
  return {
    title: o.title,
    body: o.body,
    ...(typeof o.link === "string" && o.link.length > 0 ? { link: o.link } : {}),
  };
}

/**
 * Parse a `/v1/status` body into typed state. An unrecognized state maps to
 * "unknown" and keeps the raw string rather than being guessed at or dropped.
 */
export function parseRelayStatus(raw: unknown): RelayStatus {
  if (typeof raw !== "object" || raw === null) {
    return { state: "unknown" };
  }
  const o = raw as Record<string, unknown>;
  const rawState = typeof o.state === "string" ? o.state : undefined;
  return {
    state: isRelayEntitlementState(rawState) ? rawState : "unknown",
    ...(rawState !== undefined ? { rawState } : {}),
    ...(asPositiveInt(o.requestsThisMonth) !== undefined
      ? { requestsThisMonth: asPositiveInt(o.requestsThisMonth) }
      : {}),
    ...(asPositiveInt(o.tokensThisMonth) !== undefined
      ? { tokensThisMonth: asPositiveInt(o.tokensThisMonth) }
      : {}),
    ...(asNotice(o.notice) ? { notice: asNotice(o.notice) } : {}),
  };
}

/**
 * Read a structured refusal out of a non-2xx relay body, or null when the body
 * does not name a reason code we know. Anything not a known refusal is an
 * outage as far as the app is concerned, which is the fail-safe direction:
 * falling back to local is never a privacy downgrade (D-RMA-5).
 */
export function parseRelayRefusal(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): RelayRefusalError | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  const reason = o.reason ?? (o.error as Record<string, unknown> | undefined)?.reason;
  if (!isRelayRefusalReason(reason)) return null;
  const message =
    typeof o.message === "string"
      ? o.message
      : typeof o.error === "string"
        ? o.error
        : undefined;
  const retryAfterSeconds =
    retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim())
      ? Number(retryAfterHeader.trim())
      : undefined;
  return new RelayRefusalError({
    reason,
    status,
    ...(message !== undefined ? { message } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}
