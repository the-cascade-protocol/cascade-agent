/**
 * Unit tests for the inference gateway v1 (Workbench platform plan §4.1/§4.7).
 *
 * ZERO network calls, ZERO credentials, ZERO PHI (all record-ish content is
 * synthetic). They prove the load-bearing G-3 behavior:
 *  - the egress ledger entry is appended BEFORE the provider is dialed
 *  - the ledger entry carries counts/metadata only — never prompt content
 *  - PHI on a model with no recorded BAA coverage throws (D-RMA-7), never dialed
 *  - PHI on a non-BAA endpoint throws, provider never dialed
 *  - containsPhi defaults to TRUE (fail closed)
 *  - a de-identified payload skips the gate entirely
 *  - a failed Pod-ledger append aborts the call (no egress without audit)
 *  - THE NO-TOKEN PATH IS BYTE-IDENTICAL to gateway v1 (D-RMA-37)
 *
 * Run with: npx tsx src/tests/gateway.test.ts
 */
import assert from "assert";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  completeViaGateway,
  assertBaaForPhi,
  isBaaCoveredEndpoint,
  BaaViolationError,
  GatewayRequestError,
  MODEL_TIERS,
  VERTEX_TIER_MODELS,
  RETIRED_TIER_NAMES,
  DEFAULT_MODEL_TIER,
  podEgressLogPath,
  type GatewayProvider,
  type GatewayCompleteRequest,
} from "../gateway.js";
import { CASCADE_RELAY_HOST } from "../relay/contract.js";
import { readEgressLog } from "../providers/trusted-endpoint.js";

// ── Test harness (mirrors trusted-endpoint.test.ts) ───────────────────────────

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

// ── Fakes ─────────────────────────────────────────────────────────────────────

const VERTEX_GLOBAL_ENDPOINT =
  "https://aiplatform.googleapis.com/v1beta1/projects/test-project/" +
  "locations/global/endpoints/openapi";

/** A provider fake that records when it was dialed, and with what. */
class FakeProvider implements GatewayProvider {
  calls: { prompt: string; system?: string }[] = [];
  constructor(
    private readonly endpoint: string = VERTEX_GLOBAL_ENDPOINT,
    private readonly reply: string = "fake-reply"
  ) {}
  endpointUrl(): string {
    return this.endpoint;
  }
  async complete(prompt: string, opts?: { system?: string }): Promise<string> {
    this.calls.push({ prompt, system: opts?.system });
    return this.reply;
  }
}

/** Synthetic record context — deliberately marked so tests can grep for leaks. */
const SYNTHETIC_PHI_PROMPT =
  "SYNTHETIC-PHI-MARKER patient records: potassium 4.1 mmol/L (2026-05-01); " +
  "atorvastatin 40mg daily. Claim: 'the patient's potassium is critically low'. Grade it.";
const SYNTHETIC_SYSTEM = "SYNTHETIC-SYSTEM-MARKER You are a grounding node.";

function baseRequest(overrides: Partial<GatewayCompleteRequest> = {}): GatewayCompleteRequest {
  return {
    prompt: SYNTHETIC_PHI_PROMPT,
    system: SYNTHETIC_SYSTEM,
    purpose: "assertion-grounding",
    modelTier: "standard",
    containsPhi: true,
    egress: { surface: "ledger", manifestRecordCount: 2, manifestAssertionCount: 1 },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\ngateway.test.ts — inference gateway v1 (no network, no PHI)\n");

  const tmp = mkdtempSync(join(tmpdir(), "cascade-gateway-test-"));
  const podDir = join(tmp, "pod");

  await test("ledger entry is appended BEFORE the provider is dialed", async () => {
    const order: string[] = [];
    const provider = new (class extends FakeProvider {
      override async complete(prompt: string, opts?: { system?: string }): Promise<string> {
        order.push("provider");
        return super.complete(prompt, opts);
      }
    })();
    const res = await completeViaGateway(
      baseRequest({ egress: { podDir, surface: "ledger" } }),
      {
        makeProvider: () => provider,
        writeLedger: (entry, path) => {
          order.push("ledger");
          // The real strict writer is exercised in the next test; here we only
          // care about ordering.
          void entry;
          void path;
        },
      }
    );
    assert.deepStrictEqual(order, ["ledger", "provider"]);
    assert.strictEqual(res.text, "fake-reply");
    assert.strictEqual(res.model, "gemini-3.1-flash-lite");
    assert.strictEqual(res.launchStage, "GA");
    assert.strictEqual(res.provider, "vertex", "no device token means the ADC path");
    assert.strictEqual(res.upstream, undefined, "the ADC path has no relay to quote");
  });

  await test("ledger entry holds metadata only — no prompt/system content leaks", async () => {
    const provider = new FakeProvider();
    await completeViaGateway(
      baseRequest({ egress: { podDir, surface: "ledger", manifestRecordCount: 2 } }),
      { makeProvider: () => provider }
    );
    const logPath = podEgressLogPath(podDir);
    assert.ok(existsSync(logPath), "ledger file exists under <pod>/provenance/");
    const raw = readFileSync(logPath, "utf-8");
    assert.ok(!raw.includes("SYNTHETIC-PHI-MARKER"), "prompt content leaked into ledger");
    assert.ok(!raw.includes("SYNTHETIC-SYSTEM-MARKER"), "system content leaked into ledger");
    assert.ok(!raw.includes("potassium"), "record values leaked into ledger");

    const entries = readEgressLog(logPath);
    assert.strictEqual(entries.length, 1);
    const e = entries[0]!;
    assert.strictEqual(e.provider, "vertex");
    assert.strictEqual(e.endpoint, VERTEX_GLOBAL_ENDPOINT);
    assert.strictEqual(e.model, "google/gemini-3.1-flash-lite");
    assert.strictEqual(e.purpose, "assertion-grounding");
    assert.strictEqual(e.containsPhi, true);
    assert.strictEqual(e.launchStage, "GA");
    assert.strictEqual(e.modelTier, "standard");
    assert.strictEqual(e.surface, "ledger");
    assert.strictEqual(e.summary.messageCount, 2);
    assert.strictEqual(e.summary.toolCount, 0);
    assert.strictEqual(e.summary.manifestRecordCount, 2);
    assert.ok(
      e.summary.contentBytes >=
        Buffer.byteLength(SYNTHETIC_PHI_PROMPT, "utf-8"),
      "contentBytes accounts for the payload size"
    );
    // D-RMA-37 / no-token byte identity: the ADC path's ledger line must carry
    // NONE of the relay-only fields. A build with no device token writes exactly
    // the line it wrote before the relay existed.
    const parsed = JSON.parse(raw.trim().split("\n")[0]!) as Record<string, unknown>;
    assert.ok(
      !("upstreamAttestation" in parsed),
      "the ADC line must not carry upstreamAttestation"
    );
    assert.ok(!("upstream" in parsed), "the ADC line must not carry upstream facts");
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      [
        "containsPhi",
        "direction",
        "endpoint",
        "launchStage",
        "model",
        "modelTier",
        "outcome",
        "provider",
        "purpose",
        "summary",
        "surface",
        "timestamp",
      ],
      "the no-token ledger line's field set is frozen"
    );
  });

  await test("D-RMA-7: the gate runs on the coverage FACT, not the launch stage", () => {
    // A GA model with no recorded coverage is blocked. GA-ness was only ever
    // Google's proxy for coverage, and the proxy is not the thing.
    assert.throws(
      () =>
        assertBaaForPhi(VERTEX_GLOBAL_ENDPOINT, {
          baaCovered: false,
          launchStage: "GA",
        }),
      (err: unknown) =>
        err instanceof BaaViolationError && err.reason === "model-not-covered"
    );
    // A PREVIEW model that a provider DID cover would pass. Nothing in the
    // shipped tier table is in that state today, and that is the point: the
    // rule is coverage, and GA is a fact about one vendor's current policy.
    assert.doesNotThrow(() =>
      assertBaaForPhi(VERTEX_GLOBAL_ENDPOINT, {
        baaCovered: true,
        launchStage: "PREVIEW",
      })
    );
    // Coverage cannot rescue an uncovered endpoint.
    assert.throws(
      () => assertBaaForPhi("https://api.openai.com/v1", { baaCovered: true }),
      (err: unknown) =>
        err instanceof BaaViolationError && err.reason === "endpoint-not-covered"
    );
  });

  await test("blocked BAA attempts never reach the network and never write a ledger line", async () => {
    const provider = new FakeProvider("https://api.openai.com/v1");
    let ledgerWrites = 0;
    await assert.rejects(
      completeViaGateway(baseRequest(), {
        makeProvider: () => provider,
        writeLedger: () => {
          ledgerWrites++;
        },
      }),
      (err: unknown) => err instanceof BaaViolationError
    );
    assert.strictEqual(provider.calls.length, 0, "provider must not be dialed");
    assert.strictEqual(ledgerWrites, 0, "a blocked attempt never egressed, so no ledger entry");
  });

  await test("PHI to a non-BAA endpoint throws, even on a GA model", async () => {
    const provider = new FakeProvider("https://api.openai.com/v1");
    await assert.rejects(
      completeViaGateway(baseRequest({ modelTier: "standard" }), {
        makeProvider: () => provider,
        writeLedger: () => {},
      }),
      (err: unknown) => err instanceof BaaViolationError
    );
    assert.strictEqual(provider.calls.length, 0);
  });

  await test("containsPhi defaults to TRUE (fail closed): omitted + uncovered endpoint throws", async () => {
    const provider = new FakeProvider("https://api.openai.com/v1");
    const req = baseRequest();
    delete (req as { containsPhi?: boolean }).containsPhi;
    await assert.rejects(
      completeViaGateway(req, { makeProvider: () => provider, writeLedger: () => {} }),
      (err: unknown) => err instanceof BaaViolationError
    );
    assert.strictEqual(provider.calls.length, 0);
  });

  await test("a de-identified payload skips the gate and is still ledgered", async () => {
    const provider = new FakeProvider("https://api.openai.com/v1");
    const loggedEntries: { containsPhi?: boolean; launchStage?: string }[] = [];
    const res = await completeViaGateway(
      baseRequest({
        prompt: "Does creatine supplementation interact with statin myopathy risk?",
        system: undefined,
        containsPhi: false,
        purpose: "literature-synthesis",
        egress: { surface: "ledger" },
      }),
      {
        makeProvider: () => provider,
        writeLedger: (entry) => {
          loggedEntries.push(entry);
        },
      }
    );
    assert.strictEqual(res.text, "fake-reply");
    assert.strictEqual(provider.calls.length, 1);
    assert.strictEqual(loggedEntries.length, 1, "the de-identified call is still ledgered");
    assert.strictEqual(loggedEntries[0]!.containsPhi, false);
  });

  await test("a failed ledger append aborts the call: no egress without audit", async () => {
    const provider = new FakeProvider();
    await assert.rejects(
      completeViaGateway(baseRequest(), {
        makeProvider: () => provider,
        writeLedger: () => {
          throw new Error("disk full");
        },
      }),
      /disk full/
    );
    assert.strictEqual(provider.calls.length, 0, "provider must not be dialed");
  });

  await test("validation: purpose and prompt are required; unknown provider/tier rejected", async () => {
    const deps = { makeProvider: () => new FakeProvider(), writeLedger: () => {} };
    await assert.rejects(
      completeViaGateway(baseRequest({ purpose: "  " }), deps),
      (e: unknown) => e instanceof GatewayRequestError
    );
    await assert.rejects(
      completeViaGateway(baseRequest({ prompt: "" }), deps),
      (e: unknown) => e instanceof GatewayRequestError
    );
    await assert.rejects(
      completeViaGateway(baseRequest({ provider: "openai" }), deps),
      (e: unknown) => e instanceof GatewayRequestError
    );
    await assert.rejects(
      completeViaGateway(
        baseRequest({ modelTier: "pro" as unknown as "standard" }),
        deps
      ),
      (e: unknown) => e instanceof GatewayRequestError
    );
    // A RETIRED tier name is rejected with its replacement named, never
    // silently aliased: a silent alias is how two repos drift apart while both
    // still look healthy.
    for (const [retired, replacement] of Object.entries(RETIRED_TIER_NAMES)) {
      await assert.rejects(
        completeViaGateway(
          baseRequest({ modelTier: retired as unknown as "standard" }),
          deps
        ),
        (e: unknown) =>
          e instanceof GatewayRequestError && e.message.includes(replacement)
      );
    }
  });

  await test("D-RMA-6: two neutral tiers, the preview tier is GONE, every row carries provenance", () => {
    assert.deepStrictEqual([...MODEL_TIERS], ["standard", "advanced"]);
    assert.strictEqual(DEFAULT_MODEL_TIER, "standard");
    assert.strictEqual(VERTEX_TIER_MODELS.standard.model, "gemini-3.1-flash-lite");
    assert.strictEqual(VERTEX_TIER_MODELS.standard.launchStage, "GA");
    assert.strictEqual(VERTEX_TIER_MODELS.advanced.model, "gemini-3.5-flash");
    assert.strictEqual(VERTEX_TIER_MODELS.advanced.launchStage, "GA");
    // gemini-3-flash-preview is unreachable through the client enum entirely.
    for (const tier of MODEL_TIERS) {
      assert.notStrictEqual(VERTEX_TIER_MODELS[tier].model, "gemini-3-flash-preview");
      // D-RMA-7's own stated mitigation: a coverage boolean a human sets is a
      // load-bearing truth claim, so it must carry provenance or the gate
      // degrades into a checkbox.
      assert.strictEqual(VERTEX_TIER_MODELS[tier].baaCovered, true);
      assert.ok(
        (VERTEX_TIER_MODELS[tier].baaProvenance ?? "").length > 0,
        `tier ${tier} claims BAA coverage with no provenance recorded`
      );
    }
  });

  await test("the canonical relay host is BAA-covered; a dev override is not", () => {
    assert.ok(isBaaCoveredEndpoint(`https://${CASCADE_RELAY_HOST}/v1`));
    assert.ok(isBaaCoveredEndpoint(VERTEX_GLOBAL_ENDPOINT));
    // Pointing the app at a local relay stub must FAIL the PHI gate closed
    // rather than quietly routing records through an unverified box.
    assert.ok(!isBaaCoveredEndpoint("http://127.0.0.1:8899/v1"));
    assert.ok(!isBaaCoveredEndpoint("https://relay.example.com/v1"));
    assert.ok(!isBaaCoveredEndpoint("not-a-url"));
  });

  await test("a successful call leaves a single ledger entry marked outcome=sent", async () => {
    const okPod = join(tmp, "pod-ok");
    const res = await completeViaGateway(
      baseRequest({ egress: { podDir: okPod, surface: "ledger" } }),
      { makeProvider: () => new FakeProvider() }
    );
    assert.strictEqual(res.text, "fake-reply");
    const entries = readEgressLog(podEgressLogPath(okPod));
    assert.strictEqual(entries.length, 1, "a successful call writes exactly one line");
    assert.strictEqual(entries[0]!.outcome, "sent");
  });

  await test("a failed provider call appends a distinguishable failed-in-flight record; no PHI leaks", async () => {
    const failPod = join(tmp, "pod-fail");
    class FailingProvider extends FakeProvider {
      override async complete(): Promise<string> {
        throw new Error("PROVIDER-502-MARKER simulated Vertex auth failure");
      }
    }
    await assert.rejects(
      completeViaGateway(
        baseRequest({ egress: { podDir: failPod, surface: "ledger" } }),
        { makeProvider: () => new FailingProvider() }
      ),
      /PROVIDER-502-MARKER/
    );

    const logPath = podEgressLogPath(failPod);
    const raw = readFileSync(logPath, "utf-8");
    // Neither the optimistic pre-send line nor the reconciliation line may carry
    // PHI, response content, or the provider error detail.
    assert.ok(!raw.includes("SYNTHETIC-PHI-MARKER"), "prompt content leaked into ledger");
    assert.ok(!raw.includes("SYNTHETIC-SYSTEM-MARKER"), "system content leaked into ledger");
    assert.ok(!raw.includes("potassium"), "record values leaked into ledger");
    assert.ok(!raw.includes("PROVIDER-502-MARKER"), "provider error detail leaked into ledger");

    const entries = readEgressLog(logPath);
    assert.strictEqual(entries.length, 2, "write-before-send line + failure reconciliation line");
    assert.strictEqual(entries[0]!.outcome, "sent", "pre-send line is optimistic sent");
    assert.strictEqual(
      entries[1]!.outcome,
      "failed-in-flight",
      "a dialed-then-thrown call is reconciled as failed-in-flight, not a confirmed egress"
    );
    // The reconciliation line preserves the redacted metadata so the two lines
    // correlate, and it stays metadata-only.
    assert.strictEqual(entries[1]!.endpoint, entries[0]!.endpoint);
    assert.strictEqual(entries[1]!.model, entries[0]!.model);
    assert.strictEqual(entries[1]!.summary.contentBytes, entries[0]!.summary.contentBytes);
  });

  await test("a failed audit write on the pre-send line still aborts the call (fail-closed preserved)", async () => {
    const provider = new FakeProvider();
    await assert.rejects(
      completeViaGateway(baseRequest(), {
        makeProvider: () => provider,
        writeLedger: () => {
          throw new Error("disk full");
        },
      }),
      /disk full/
    );
    assert.strictEqual(provider.calls.length, 0, "provider must not be dialed when the audit line fails");
  });

  rmSync(tmp, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
