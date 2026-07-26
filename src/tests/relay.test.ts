/**
 * Contract tests for the Cascade relay client half ([ALPHA-MODEL-ACCESS]).
 *
 * These run against `relay-stub.ts`, a local transcription of the frozen wire
 * contract, over real HTTP on a loopback port. No GCP, no device token that
 * exists anywhere, no PHI, and no dependency on the parallel relay build.
 *
 * What is proven here:
 *   - the two Cascade request headers ride every call, and the device token
 *     goes in the Authorization bearer
 *   - the upstream attestation headers land in the ledger's reconciliation
 *     line, marked "relay-reported", written from headers only
 *   - no attestation headers means NO reconciliation line, never a guessed one
 *   - write-before-send holds on the relay path too
 *   - a structured refusal is a REFUSAL (typed, with a reason code), never an
 *     outage the app would fall back to local for
 *   - a 5xx / hang-up IS an outage
 *   - the entitlement poll parses typed state and the operator notice
 *
 * Run with: npx tsx src/tests/relay.test.ts
 */
import assert from "assert";

import { CascadeRelayProvider } from "../providers/cascade-relay.js";
import {
  completeViaGateway,
  type GatewayCompleteRequest,
  type GatewayProvider,
} from "../gateway.js";
import {
  CASCADE_RELAY_HOST,
  DEFAULT_CASCADE_RELAY_BASE_URL,
  HEADER_PURPOSE,
  HEADER_TIER,
  RelayOutageError,
  RelayRefusalError,
  RELAY_REFUSAL_REASONS,
  parseRelayStatus,
  resolveRelayBaseUrl,
} from "../relay/contract.js";
import { fetchRelayStatus, relayStatusUrl } from "../relay/status.js";
import { CASCADE_PURPOSES, isCascadePurpose } from "../relay/purposes.js";
import type { EgressLogEntry } from "../providers/trusted-endpoint.js";
import { startRelayStub, type RelayStub } from "./relay-stub.js";

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

const DEVICE_TOKEN = "stub-device-token-not-a-real-secret";
const SYNTHETIC_PROMPT = "SYNTHETIC-MARKER grade this synthetic claim.";

/**
 * The gateway request the app makes on the relay path. `relayBaseUrl` points at
 * the stub, which is deliberately NOT a BAA-covered host, so PHI calls in these
 * tests are marked de-identified: the gate's job is proven in gateway.test.ts,
 * and proving it again here would require punching a hole in it.
 */
function relayRequest(
  stub: RelayStub,
  overrides: Partial<GatewayCompleteRequest> = {},
): GatewayCompleteRequest {
  return {
    prompt: SYNTHETIC_PROMPT,
    purpose: "assertion-grounding",
    modelTier: "standard",
    containsPhi: false,
    deviceToken: DEVICE_TOKEN,
    relayBaseUrl: stub.baseUrl,
    egress: { surface: "ledger" },
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("\nrelay.test.ts — Cascade relay client against the frozen wire contract\n");

  await test("the canonical base URL is the ratified host (D-RMA-38)", () => {
    assert.strictEqual(CASCADE_RELAY_HOST, "relay.cascadeagenticlabs.com");
    assert.strictEqual(
      DEFAULT_CASCADE_RELAY_BASE_URL,
      "https://relay.cascadeagenticlabs.com/v1",
    );
    assert.strictEqual(resolveRelayBaseUrl(), DEFAULT_CASCADE_RELAY_BASE_URL);
    assert.strictEqual(resolveRelayBaseUrl("http://x/v1"), "http://x/v1");
    assert.strictEqual(
      relayStatusUrl("https://relay.cascadeagenticlabs.com/v1"),
      "https://relay.cascadeagenticlabs.com/v1/status",
    );
  });

  await test("every request carries the bearer token and both Cascade headers", async () => {
    const stub = await startRelayStub();
    try {
      const provider = new CascadeRelayProvider({
        deviceToken: DEVICE_TOKEN,
        tier: "advanced",
        purpose: "literature-synthesis",
        baseUrl: stub.baseUrl,
      });
      const text = await provider.complete("synthetic question");
      assert.strictEqual(text, "stub-reply");
      assert.strictEqual(stub.requests.length, 1);
      const req = stub.requests[0]!;
      assert.strictEqual(req.method, "POST");
      assert.strictEqual(req.path, "/v1/chat/completions");
      assert.strictEqual(req.headers["authorization"], `Bearer ${DEVICE_TOKEN}`);
      assert.strictEqual(req.headers[HEADER_TIER], "advanced");
      assert.strictEqual(req.headers[HEADER_PURPOSE], "literature-synthesis");
      // The client names a TIER, not a model: the relay owns the tier table,
      // which is what makes a provider swap a config change (D-RMA-28).
      assert.strictEqual((req.body as { model: string }).model, "advanced");
    } finally {
      await stub.close();
    }
  });

  await test("the relay provider stays smaller than VertexProvider", async () => {
    const { readFileSync } = await import("fs");
    const relay = readFileSync(
      new URL("../providers/cascade-relay.ts", import.meta.url),
      "utf-8",
    );
    const vertex = readFileSync(
      new URL("../providers/vertex.ts", import.meta.url),
      "utf-8",
    );
    // Code, not comments: the whole claim is about how much MACHINERY the relay
    // path needs, and the relay file is comment-heavy on purpose.
    const codeLines = (s: string): number =>
      s
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return (
            t.length > 0 &&
            !t.startsWith("//") &&
            !t.startsWith("*") &&
            !t.startsWith("/*")
          );
        }).length;
    const r = codeLines(relay);
    const v = codeLines(vertex);
    assert.ok(
      r < v,
      `the relay provider (${r} code lines) must stay smaller than VertexProvider (${v}); ` +
        "if it grows past it, the abstraction is wrong (kickoff item 3)",
    );
  });

  await test("write-before-send holds on the relay path, and the pre-send hop is app-verified", async () => {
    const stub = await startRelayStub();
    try {
      const order: string[] = [];
      const lines: EgressLogEntry[] = [];
      const res = await completeViaGateway(relayRequest(stub), {
        writeLedger: (entry) => {
          order.push(`ledger:${entry.outcome}`);
          lines.push(entry);
        },
        makeRelayProvider: (args) => {
          const p = new CascadeRelayProvider({ ...args, baseUrl: stub.baseUrl });
          const wrapped: GatewayProvider = {
            endpointUrl: () => p.endpointUrl(),
            complete: async (prompt, opts) => {
              order.push("network");
              return p.complete(prompt, opts);
            },
            lastUpstreamAttestation: () => p.lastUpstreamAttestation(),
          };
          return wrapped;
        },
      });
      assert.strictEqual(res.provider, "cascade-relay");
      assert.deepStrictEqual(order, [
        "ledger:sent",
        "network",
        "ledger:relay-attested",
      ]);
      assert.strictEqual(lines[0]!.upstreamAttestation, "app-verified");
      assert.strictEqual(lines[0]!.provider, "cascade-relay");
      assert.strictEqual(
        lines[0]!.endpoint,
        stub.baseUrl,
        "the app-verified hop names the destination the app actually dialed",
      );
      assert.strictEqual(lines[0]!.model, "standard", "the app-verified hop records the tier");
      assert.strictEqual(lines[0]!.upstream, undefined, "the pre-send line quotes nobody");
    } finally {
      await stub.close();
    }
  });

  await test("the reconciliation line records the relay-reported upstream from HEADERS", async () => {
    const stub = await startRelayStub();
    try {
      const lines: EgressLogEntry[] = [];
      const res = await completeViaGateway(relayRequest(stub), {
        writeLedger: (entry) => lines.push(entry),
        makeRelayProvider: (args) =>
          new CascadeRelayProvider({ ...args, baseUrl: stub.baseUrl }),
      });
      assert.strictEqual(lines.length, 2, "one app-verified hop, one quoted hop");
      const attested = lines[1]!;
      assert.strictEqual(attested.outcome, "relay-attested");
      assert.strictEqual(attested.upstreamAttestation, "relay-reported");
      // D-RMA-41: the provider DISPLAY string comes off the wire. The client
      // has no hardcoded provider name anywhere in this path.
      assert.strictEqual(
        attested.upstream?.provider,
        "Google Gemini Enterprise Agent Platform",
      );
      assert.strictEqual(attested.upstream?.model, "gemini-3.1-flash-lite");
      assert.strictEqual(attested.upstream?.region, "global");
      assert.strictEqual(attested.upstream?.launchStage, "GA");
      assert.strictEqual(attested.upstream?.endpoint, stub.upstream.endpoint);
      // The quoted hop restates the same attempt: same bytes, same purpose.
      assert.strictEqual(attested.summary.contentBytes, lines[0]!.summary.contentBytes);
      assert.strictEqual(attested.purpose, lines[0]!.purpose);
      // And the caller is handed the same facts, marked as reported.
      assert.strictEqual(res.upstream?.provider, "Google Gemini Enterprise Agent Platform");

      // No prompt content on either line, on any path.
      const raw = JSON.stringify(lines);
      assert.ok(!raw.includes("SYNTHETIC-MARKER"), "prompt content leaked into the ledger");
    } finally {
      await stub.close();
    }
  });

  await test("no attestation headers means NO reconciliation line, never an inferred one", async () => {
    const stub = await startRelayStub({ omitAttestation: true });
    try {
      const lines: EgressLogEntry[] = [];
      const res = await completeViaGateway(relayRequest(stub), {
        writeLedger: (entry) => lines.push(entry),
        makeRelayProvider: (args) =>
          new CascadeRelayProvider({ ...args, baseUrl: stub.baseUrl }),
      });
      assert.strictEqual(
        lines.length,
        1,
        "a silent relay leaves one honest app-verified line, not a guessed second one",
      );
      assert.strictEqual(res.upstream, undefined);
    } finally {
      await stub.close();
    }
  });

  await test("a structured refusal is a refusal, with its reason code, not an outage", async () => {
    for (const reason of RELAY_REFUSAL_REASONS) {
      const stub = await startRelayStub({
        refuseWith: reason,
        ...(reason === "rate-limit" ? { retryAfterSeconds: 42 } : {}),
      });
      try {
        const provider = new CascadeRelayProvider({
          deviceToken: DEVICE_TOKEN,
          tier: "standard",
          purpose: "assertion-grounding",
          baseUrl: stub.baseUrl,
        });
        await assert.rejects(
          provider.complete("synthetic question"),
          (err: unknown) => {
            assert.ok(
              err instanceof RelayRefusalError,
              `${reason} must surface as a refusal, not an outage`,
            );
            assert.ok(
              !(err instanceof RelayOutageError),
              "a refusal must never be classified as an outage",
            );
            assert.strictEqual((err as RelayRefusalError).reason, reason);
            if (reason === "rate-limit") {
              assert.strictEqual((err as RelayRefusalError).retryAfterSeconds, 42);
            }
            return true;
          },
        );
      } finally {
        await stub.close();
      }
    }
  });

  await test("a 5xx and a dropped connection are outages (D-RMA-5 fallback class)", async () => {
    for (const behavior of [{ failWithStatus: 502 }, { hangUp: true }]) {
      const stub = await startRelayStub(behavior);
      try {
        const provider = new CascadeRelayProvider({
          deviceToken: DEVICE_TOKEN,
          tier: "standard",
          purpose: "assertion-grounding",
          baseUrl: stub.baseUrl,
        });
        await assert.rejects(
          provider.complete("synthetic question"),
          (err: unknown) => err instanceof RelayOutageError,
        );
      } finally {
        await stub.close();
      }
    }
  });

  await test("a refusal mid-call still leaves the honest failed-in-flight ledger pair", async () => {
    const stub = await startRelayStub({ refuseWith: "daily-cap" });
    try {
      const lines: EgressLogEntry[] = [];
      await assert.rejects(
        completeViaGateway(relayRequest(stub), {
          writeLedger: (entry) => lines.push(entry),
          makeRelayProvider: (args) =>
            new CascadeRelayProvider({ ...args, baseUrl: stub.baseUrl }),
        }),
        (err: unknown) => err instanceof RelayRefusalError,
      );
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0]!.outcome, "sent");
      assert.strictEqual(lines[1]!.outcome, "failed-in-flight");
      assert.strictEqual(
        lines[1]!.upstream,
        undefined,
        "a refused call has no upstream to quote",
      );
    } finally {
      await stub.close();
    }
  });

  await test("the status poll returns typed state plus the operator notice", async () => {
    const stub = await startRelayStub({
      status: {
        state: "active",
        requestsThisMonth: 41,
        tokensThisMonth: 91_004,
        notice: {
          title: "A short note",
          body: "Turning cloud access off for a few days while I sort out a billing thing.",
          link: "https://cascadeagenticlabs.com/legal/privacy",
        },
      },
    });
    try {
      const status = await fetchRelayStatus({
        deviceToken: DEVICE_TOKEN,
        baseUrl: stub.baseUrl,
      });
      assert.strictEqual(status.state, "active");
      assert.strictEqual(status.requestsThisMonth, 41);
      assert.strictEqual(status.tokensThisMonth, 91_004);
      assert.strictEqual(status.notice?.title, "A short note");
      assert.ok(status.notice?.body.includes("billing thing"));
      assert.strictEqual(stub.requests[0]!.path, "/v1/status");
      assert.strictEqual(
        stub.requests[0]!.headers["authorization"],
        `Bearer ${DEVICE_TOKEN}`,
      );
      assert.strictEqual(
        stub.requests[0]!.body,
        null,
        "the poll is content-free by construction",
      );
    } finally {
      await stub.close();
    }
  });

  await test("kill-switch reason codes map to TYPED states, and an unknown one is kept, not guessed", () => {
    for (const state of ["active", "revoked", "daily-cap", "global-paused", "tier-off"]) {
      assert.strictEqual(parseRelayStatus({ state }).state, state);
    }
    const odd = parseRelayStatus({ state: "something-new-the-relay-added" });
    assert.strictEqual(odd.state, "unknown");
    assert.strictEqual(odd.rawState, "something-new-the-relay-added");
    assert.strictEqual(parseRelayStatus(null).state, "unknown");
    // A notice missing its required parts is dropped rather than half-rendered.
    assert.strictEqual(parseRelayStatus({ state: "active", notice: { title: "x" } }).notice, undefined);
  });

  await test("a status poll against an unreachable relay is an outage, not a silent 'inactive'", async () => {
    const stub = await startRelayStub();
    const base = stub.baseUrl;
    await stub.close();
    await assert.rejects(
      fetchRelayStatus({ deviceToken: DEVICE_TOKEN, baseUrl: base, timeoutMs: 2000 }),
      (err: unknown) => err instanceof RelayOutageError,
    );
  });

  await test("the purpose enum is closed, and every purpose the app sends is in it", () => {
    assert.ok(CASCADE_PURPOSES.length > 0);
    assert.ok(isCascadePurpose("assertion-grounding"));
    assert.ok(isCascadePurpose("literature-synthesis"));
    assert.ok(!isCascadePurpose("whatever the user typed"));
    assert.ok(!isCascadePurpose(""));
    assert.strictEqual(
      new Set(CASCADE_PURPOSES).size,
      CASCADE_PURPOSES.length,
      "the enum has no duplicates",
    );
  });

  await test("custody: the device token comes from the HEADER, and a body-supplied one is ignored", async () => {
    const { bindDeviceToken, DEVICE_TOKEN_HEADER, normalizeDeviceToken } =
      await import("../commands/serve.js");
    assert.strictEqual(DEVICE_TOKEN_HEADER, "x-cascade-device-token");
    const smuggled: GatewayCompleteRequest = {
      prompt: "p",
      purpose: "assertion-grounding",
      deviceToken: "TOKEN-THE-RENDERER-MADE-UP",
    };
    // No header: the body's token is discarded, so the call takes the ADC path.
    assert.strictEqual(bindDeviceToken(smuggled, undefined).deviceToken, undefined);
    assert.strictEqual(bindDeviceToken(smuggled, "   ").deviceToken, undefined);
    // Header present: the shell's token wins over the body's, always.
    assert.strictEqual(
      bindDeviceToken(smuggled, " real-token ").deviceToken,
      "real-token",
    );
    assert.strictEqual(normalizeDeviceToken(""), undefined);
    assert.strictEqual(normalizeDeviceToken(null), undefined);
  });

  await test("a pinned relay route with no device token is an error, not a downgrade to ADC", async () => {
    await assert.rejects(
      completeViaGateway(
        {
          prompt: "synthetic",
          purpose: "assertion-grounding",
          provider: "cascade-relay",
          containsPhi: false,
        },
        { writeLedger: () => {} },
      ),
      /requires a device token/,
    );
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
