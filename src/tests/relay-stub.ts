/**
 * A local stub of the Cascade relay, speaking the wire contract frozen in
 * `2026-07-26-cascade-relay-v0-build-kickoff.md` on 2026-07-26.
 *
 * The real relay is a parallel build. This stub exists so the CLIENT half can
 * be proven against the contract with no network, no GCP, and no coordination:
 * if the two halves disagree, one of them disagrees with this file, and this
 * file is a transcription of the frozen section rather than an interpretation
 * of it.
 *
 * It implements only what the client exercises:
 *   POST /v1/chat/completions  (with the tier/purpose request headers and the
 *                               five upstream attestation response headers)
 *   GET  /v1/status            (entitlement state + optional notice)
 *
 * Deliberately NOT implemented: streaming, token accounting, spend control,
 * the tier table, persistence. Those are the relay's job and testing them here
 * would be testing a fake.
 */

import { createServer, type Server } from "http";
import { AddressInfo } from "net";

import type { RelayRefusalReason } from "../relay/contract.js";

export interface StubUpstream {
  provider: string;
  model: string;
  endpoint: string;
  region: string;
  launchStage: string;
}

/** What the stub should do with the next request. */
export interface StubBehavior {
  /** Refuse with this reason code (a stated answer, not an outage). */
  refuseWith?: RelayRefusalReason;
  /** Seconds for the Retry-After header on a rate-limit refusal. */
  retryAfterSeconds?: number;
  /** Return this HTTP status with a non-refusal body (an outage). */
  failWithStatus?: number;
  /** Drop the connection without answering (a transport outage). */
  hangUp?: boolean;
  /** Omit the attestation headers entirely (relay said nothing about upstream). */
  omitAttestation?: boolean;
  /** The assistant text to return. */
  reply?: string;
  /** The entitlement payload `GET /v1/status` answers with. */
  status?: Record<string, unknown>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface RelayStub {
  baseUrl: string;
  origin: string;
  requests: RecordedRequest[];
  behavior: StubBehavior;
  upstream: StubUpstream;
  close(): Promise<void>;
}

const DEFAULT_UPSTREAM: StubUpstream = {
  // D-RMA-41: the display string comes from the relay's tier table, so the
  // client renders the provider name from DATA and never hardcodes one.
  provider: "Google Gemini Enterprise Agent Platform",
  model: "gemini-3.1-flash-lite",
  endpoint:
    "https://aiplatform.googleapis.com/v1beta1/projects/cascade-relay/locations/global/endpoints/openapi",
  region: "global",
  launchStage: "GA",
};

export async function startRelayStub(
  initial: StubBehavior = {},
): Promise<RelayStub> {
  const requests: RecordedRequest[] = [];
  const behavior: StubBehavior = { ...initial };
  const upstream: StubUpstream = { ...DEFAULT_UPSTREAM };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf-8");
      let body: unknown = null;
      try {
        body = rawBody.length > 0 ? JSON.parse(rawBody) : null;
      } catch {
        body = rawBody;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      requests.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers,
        body,
      });

      if (behavior.hangUp) {
        req.socket.destroy();
        return;
      }

      // Auth is mandatory on every route (D-RMA-11: entitlement is checked on
      // every request, and there is no anonymous surface).
      const auth = headers["authorization"];
      if (!auth || !auth.startsWith("Bearer ")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ reason: "revoked", message: "no device token" }));
        return;
      }

      if ((req.url ?? "").startsWith("/v1/status")) {
        if (behavior.refuseWith) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ reason: behavior.refuseWith }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(behavior.status ?? { state: "active" }));
        return;
      }

      if (behavior.refuseWith) {
        const extra: Record<string, string> = {};
        if (behavior.retryAfterSeconds !== undefined) {
          extra["retry-after"] = String(behavior.retryAfterSeconds);
        }
        res.writeHead(429, { "content-type": "application/json", ...extra });
        res.end(
          JSON.stringify({
            reason: behavior.refuseWith,
            message: `refused: ${behavior.refuseWith}`,
          }),
        );
        return;
      }

      if (behavior.failWithStatus) {
        res.writeHead(behavior.failWithStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream exploded" }));
        return;
      }

      const attestation = behavior.omitAttestation
        ? {}
        : {
            "x-cascade-upstream-provider": upstream.provider,
            "x-cascade-upstream-model": upstream.model,
            "x-cascade-upstream-endpoint": upstream.endpoint,
            "x-cascade-upstream-region": upstream.region,
            "x-cascade-upstream-launch-stage": upstream.launchStage,
          };

      res.writeHead(200, { "content-type": "application/json", ...attestation });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: 1,
          model: upstream.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: behavior.reply ?? "stub-reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    baseUrl: `${origin}/v1`,
    requests,
    behavior,
    upstream,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
