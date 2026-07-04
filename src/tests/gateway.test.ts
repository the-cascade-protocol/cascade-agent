/**
 * Unit tests for the inference gateway v1 (Workbench platform plan §4.1/§4.7).
 *
 * ZERO network calls, ZERO credentials, ZERO PHI (all record-ish content is
 * synthetic). They prove the load-bearing G-3 behavior:
 *  - the egress ledger entry is appended BEFORE the provider is dialed
 *  - the ledger entry carries counts/metadata only — never prompt content
 *  - PHI on a PREVIEW model throws (BAA excludes pre-GA), provider never dialed
 *  - PHI on a non-BAA endpoint throws, provider never dialed
 *  - containsPhi defaults to TRUE (fail closed)
 *  - de-identified payloads may use the preview flash tier
 *  - a failed Pod-ledger append aborts the call (no egress without audit)
 *
 * Run with: npx tsx src/tests/gateway.test.ts
 */
import assert from "assert";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  completeViaGateway,
  BaaViolationError,
  GatewayRequestError,
  VERTEX_TIER_MODELS,
  podEgressLogPath,
  type GatewayProvider,
  type GatewayCompleteRequest,
} from "../gateway.js";
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
    modelTier: "flash-lite",
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
    assert.strictEqual(e.modelTier, "flash-lite");
    assert.strictEqual(e.surface, "ledger");
    assert.strictEqual(e.summary.messageCount, 2);
    assert.strictEqual(e.summary.toolCount, 0);
    assert.strictEqual(e.summary.manifestRecordCount, 2);
    assert.ok(
      e.summary.contentBytes >=
        Buffer.byteLength(SYNTHETIC_PHI_PROMPT, "utf-8"),
      "contentBytes accounts for the payload size"
    );
  });

  await test("PHI on the PREVIEW flash tier throws BaaViolationError; provider never dialed", async () => {
    const provider = new FakeProvider();
    let ledgerWrites = 0;
    await assert.rejects(
      completeViaGateway(baseRequest({ modelTier: "flash" }), {
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
      completeViaGateway(baseRequest({ modelTier: "flash-lite" }), {
        makeProvider: () => provider,
        writeLedger: () => {},
      }),
      (err: unknown) => err instanceof BaaViolationError
    );
    assert.strictEqual(provider.calls.length, 0);
  });

  await test("containsPhi defaults to TRUE (fail closed): omitted + preview tier throws", async () => {
    const provider = new FakeProvider();
    const req = baseRequest({ modelTier: "flash" });
    delete (req as { containsPhi?: boolean }).containsPhi;
    await assert.rejects(
      completeViaGateway(req, { makeProvider: () => provider, writeLedger: () => {} }),
      (err: unknown) => err instanceof BaaViolationError
    );
  });

  await test("a de-identified payload may use the preview flash tier", async () => {
    const provider = new FakeProvider();
    const loggedEntries: { containsPhi?: boolean; launchStage?: string }[] = [];
    const res = await completeViaGateway(
      baseRequest({
        prompt: "Does creatine supplementation interact with statin myopathy risk?",
        system: undefined,
        modelTier: "flash",
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
    assert.strictEqual(res.model, "gemini-3-flash-preview");
    assert.strictEqual(res.launchStage, "PREVIEW");
    assert.strictEqual(provider.calls.length, 1);
    assert.strictEqual(loggedEntries.length, 1, "the de-identified call is still ledgered");
    assert.strictEqual(loggedEntries[0]!.containsPhi, false);
    assert.strictEqual(loggedEntries[0]!.launchStage, "PREVIEW");
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
        baseRequest({ modelTier: "pro" as unknown as "flash" }),
        deps
      ),
      (e: unknown) => e instanceof GatewayRequestError
    );
  });

  await test("tier table matches the verified §4.1.1 model ids", () => {
    assert.strictEqual(VERTEX_TIER_MODELS["flash-lite"].model, "gemini-3.1-flash-lite");
    assert.strictEqual(VERTEX_TIER_MODELS["flash-lite"].launchStage, "GA");
    assert.strictEqual(VERTEX_TIER_MODELS["flash"].model, "gemini-3-flash-preview");
    assert.strictEqual(VERTEX_TIER_MODELS["flash"].launchStage, "PREVIEW");
    assert.strictEqual(VERTEX_TIER_MODELS["flash-max"].model, "gemini-3.5-flash");
    assert.strictEqual(VERTEX_TIER_MODELS["flash-max"].launchStage, "GA");
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
