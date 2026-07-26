/**
 * The relay entitlement status client (D-RMA-11, D-RMA-22).
 *
 * The app polls `GET /v1/status` on launch and every 15 minutes. That interval
 * is the kill switch's worst-case latency to the UI, and it exists because
 * entitlement is checked authoritatively on every request but a revoked tester
 * should not have to ASK a question to find out (D-RMA-11: no cached grant with
 * a TTL, because a TTL is precisely a window in which a revoked user still
 * works).
 *
 * The poll is cheap and content-free: no prompt, no pod, no records. It carries
 * the device token and nothing else.
 */

import {
  RelayOutageError,
  RELAY_STATUS_PATH,
  parseRelayRefusal,
  parseRelayStatus,
  resolveRelayBaseUrl,
  type RelayStatus,
} from "./contract.js";

/** How often the app re-polls. The kill switch's worst-case latency to the UI. */
export const RELAY_STATUS_POLL_INTERVAL_MS = 15 * 60 * 1000;

/** A short timeout: the poll is a background nicety and must never hang a launch. */
export const RELAY_STATUS_TIMEOUT_MS = 10_000;

export interface FetchRelayStatusOptions {
  deviceToken: string;
  /** Base URL override (dev/stub); defaults to the canonical relay. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Derive the status URL from the OpenAI-compatible base URL. The base URL ends
 * in `/v1`; the status path is `/v1/status` on the same origin, so we take the
 * origin and append rather than string-splicing a path that may or may not have
 * a trailing slash.
 */
export function relayStatusUrl(baseUrl: string): string {
  return new URL(RELAY_STATUS_PATH, baseUrl).toString();
}

/**
 * Poll the relay for this device's entitlement state and any operator notice.
 *
 * Throws {@link RelayOutageError} when the relay cannot be reached or answers
 * unusably; throws a `RelayRefusalError` when it answers with a structured
 * refusal. A refusal is NOT an outage: "you were revoked" is an answer, and the
 * app renders it as a state rather than as a connection problem.
 */
export async function fetchRelayStatus(
  options: FetchRelayStatusOptions,
): Promise<RelayStatus> {
  const baseUrl = resolveRelayBaseUrl(options.baseUrl);
  const url = relayStatusUrl(baseUrl);
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? RELAY_STATUS_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${options.deviceToken}` },
      signal: controller.signal,
    });
  } catch (err) {
    throw new RelayOutageError(
      `Could not reach Cascade cloud models at ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const refusal = parseRelayRefusal(
      res.status,
      body,
      res.headers.get("retry-after"),
    );
    if (refusal) throw refusal;
    throw new RelayOutageError(
      `Cascade cloud models returned HTTP ${res.status} from ${url}.`,
      { status: res.status },
    );
  }

  return parseRelayStatus(body);
}
