/**
 * Unit tests for the trusted-endpoint wrapper + cloud-egress log and the
 * offline guards of the Vertex provider (P0-LLM-02).
 *
 * These tests make ZERO network calls and require NO credentials. They prove:
 *  - the egress summary is redacted by construction (counts/bytes, no content)
 *  - every cloud `runTurn` writes exactly one egress-log entry
 *  - local providers are NOT wrapped and write NO egress entry
 *  - the Vertex provider constructs without I/O and guards clearly when
 *    GOOGLE_CLOUD_PROJECT / ADC are absent
 *
 * Run with: npx tsx src/tests/trusted-endpoint.test.ts
 */
import assert from "assert";
import { mkdtempSync, existsSync, readFileSync, rmSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  designateTrustedEndpoint,
  TrustedEndpointProvider,
  isLocalProvider,
  summarizeEgress,
  writeEgressLog,
  readEgressLog,
  type EgressLogEntry,
} from "../providers/trusted-endpoint.js";
import { VertexProvider } from "../providers/vertex.js";
import type {
  Provider,
  ProviderName,
  SimpleMessage,
  AgentCallbacks,
} from "../providers/types.js";
import type { CanonicalTool } from "../tools.js";

// ── Test harness ──────────────────────────────────────────────────────────────

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

const noopCallbacks: AgentCallbacks = {
  onText: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
};

/**
 * A fake cloud provider that records what it received and returns canned text.
 * Stands in for a real network provider so tests never leave the machine.
 */
class FakeCloudProvider implements Provider {
  readonly providerName: ProviderName;
  readonly model: string;
  lastMessages: SimpleMessage[] = [];
  callCount = 0;

  constructor(providerName: ProviderName = "vertex", model = "gemini-flash-latest") {
    this.providerName = providerName;
    this.model = model;
  }
  endpointUrl(): string {
    return "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test/locations/us-central1/endpoints/openapi";
  }
  async runTurn(
    messages: SimpleMessage[],
    _tools: CanonicalTool[],
    callbacks: AgentCallbacks
  ): Promise<string> {
    this.callCount++;
    this.lastMessages = messages;
    callbacks.onText("ok");
    return "ok";
  }
  async listModels(): Promise<string[]> {
    return [this.model];
  }
}

const SAMPLE_MESSAGES: SimpleMessage[] = [
  { role: "user", content: "Patient John Doe, DOB 1990-01-01, has condition X." },
  { role: "assistant", content: "Acknowledged." },
];
const SAMPLE_TOOLS: CanonicalTool[] = [
  { name: "shell", description: "run", input_schema: { type: "object", properties: {} } },
];

// ── Tests ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\ntrusted-endpoint + vertex guard tests\n");

  await test("isLocalProvider classifies local vs cloud", () => {
    assert.equal(isLocalProvider("local"), true);
    assert.equal(isLocalProvider("ollama"), true);
    assert.equal(isLocalProvider("vertex"), false);
    assert.equal(isLocalProvider("anthropic"), false);
  });

  await test("summarizeEgress is redacted (counts/bytes only, no content)", () => {
    const summary = summarizeEgress(SAMPLE_MESSAGES, SAMPLE_TOOLS);
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.toolCount, 1);
    const expectedBytes =
      Buffer.byteLength(SAMPLE_MESSAGES[0].content, "utf-8") +
      Buffer.byteLength(SAMPLE_MESSAGES[1].content, "utf-8");
    assert.equal(summary.contentBytes, expectedBytes);
    // The summary must not carry any raw PHI string anywhere in it.
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes("John Doe"), "summary leaked patient name");
    assert.ok(!serialized.includes("1990-01-01"), "summary leaked DOB");
  });

  await test("designateTrustedEndpoint wraps cloud providers", () => {
    const wrapped = designateTrustedEndpoint(new FakeCloudProvider("vertex"));
    assert.ok(wrapped instanceof TrustedEndpointProvider);
    assert.equal(wrapped.providerName, "vertex");
  });

  await test("designateTrustedEndpoint does NOT wrap local providers", () => {
    const local = new FakeCloudProvider("local");
    const result = designateTrustedEndpoint(local);
    assert.strictEqual(result, local, "local provider should pass through unchanged");
    assert.ok(!(result instanceof TrustedEndpointProvider));
  });

  await test("wrapping a local provider directly throws (defensive)", () => {
    assert.throws(() => new TrustedEndpointProvider(new FakeCloudProvider("ollama")));
  });

  await test("cloud runTurn writes exactly one egress entry; no PHI in log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-"));
    const logPath = join(dir, "egress-log.jsonl");
    try {
      const inner = new FakeCloudProvider("vertex");
      const wrapped = designateTrustedEndpoint(inner, { egressLogPath: logPath });
      const out = await wrapped.runTurn(SAMPLE_MESSAGES, SAMPLE_TOOLS, noopCallbacks);

      assert.equal(out, "ok");
      assert.equal(inner.callCount, 1, "inner provider should run exactly once");
      assert.ok(existsSync(logPath), "egress log file should be created");

      const entries = readEgressLog(logPath);
      assert.equal(entries.length, 1, "exactly one egress entry expected");
      const entry = entries[0];
      assert.equal(entry.provider, "vertex");
      assert.equal(entry.model, "gemini-flash-latest");
      assert.equal(entry.direction, "outbound");
      assert.ok(entry.endpoint.includes("aiplatform.googleapis.com"));
      assert.equal(entry.summary.messageCount, 2);
      assert.ok(typeof entry.summary.contentBytes === "number" && entry.summary.contentBytes > 0);
      assert.ok(!Number.isNaN(Date.parse(entry.timestamp)), "timestamp must be ISO-8601");

      // The single most important property: the raw log must contain no PHI.
      const raw = readFileSync(logPath, "utf-8");
      assert.ok(!raw.includes("John Doe"), "egress log leaked patient name");
      assert.ok(!raw.includes("1990-01-01"), "egress log leaked DOB");
      assert.ok(!raw.includes("condition X"), "egress log leaked clinical detail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("a second cloud call appends (append-only log)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-"));
    const logPath = join(dir, "egress-log.jsonl");
    try {
      const wrapped = designateTrustedEndpoint(new FakeCloudProvider("vertex"), {
        egressLogPath: logPath,
      });
      await wrapped.runTurn(SAMPLE_MESSAGES, [], noopCallbacks);
      await wrapped.runTurn(SAMPLE_MESSAGES, [], noopCallbacks);
      assert.equal(readEgressLog(logPath).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("readEgressLog tolerates a corrupt line", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-"));
    const logPath = join(dir, "egress-log.jsonl");
    try {
      const good: EgressLogEntry = {
        timestamp: new Date().toISOString(),
        provider: "vertex",
        endpoint: "https://example/openapi",
        model: "gemini-flash-latest",
        direction: "outbound",
        summary: { messageCount: 1, contentBytes: 10, toolCount: 0 },
      };
      writeEgressLog(good, logPath);
      // Append a deliberately broken line, then a good one.
      appendFileSync(logPath, "{ not json\n");
      writeEgressLog(good, logPath);
      assert.equal(readEgressLog(logPath).length, 2, "corrupt line should be skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Vertex offline guards (no network, no credentials) ──────────────────────

  await test("VertexProvider constructor does no I/O and resolves config", () => {
    const p = new VertexProvider("gemini-flash-latest", {
      project: "my-proj",
      location: "us-east1",
    });
    assert.equal(p.providerName, "vertex");
    assert.equal(p.model, "gemini-flash-latest");
    assert.equal(p.project, "my-proj");
    assert.equal(p.location, "us-east1");
    assert.ok(p.endpointUrl().includes("us-east1-aiplatform.googleapis.com"));
    assert.ok(p.endpointUrl().includes("projects/my-proj"));
  });

  await test("validate() returns a clear error when project is unset", async () => {
    const saved = process.env.GOOGLE_CLOUD_PROJECT;
    const savedG = process.env.GCLOUD_PROJECT;
    const savedP = process.env.GCP_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GCP_PROJECT;
    try {
      const p = new VertexProvider();
      const result = await p.validate();
      assert.equal(result.ok, false);
      assert.ok(result.error && result.error.includes("GOOGLE_CLOUD_PROJECT"));
      assert.ok(result.error.includes("application-default login"));
    } finally {
      if (saved !== undefined) process.env.GOOGLE_CLOUD_PROJECT = saved;
      if (savedG !== undefined) process.env.GCLOUD_PROJECT = savedG;
      if (savedP !== undefined) process.env.GCP_PROJECT = savedP;
    }
  });

  await test("runTurn throws a clear config error when project is unset (no network)", async () => {
    const saved = process.env.GOOGLE_CLOUD_PROJECT;
    const savedG = process.env.GCLOUD_PROJECT;
    const savedP = process.env.GCP_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GCP_PROJECT;
    try {
      const p = new VertexProvider();
      await assert.rejects(
        () => p.runTurn(SAMPLE_MESSAGES, [], noopCallbacks),
        /GOOGLE_CLOUD_PROJECT/
      );
    } finally {
      if (saved !== undefined) process.env.GOOGLE_CLOUD_PROJECT = saved;
      if (savedG !== undefined) process.env.GCLOUD_PROJECT = savedG;
      if (savedP !== undefined) process.env.GCP_PROJECT = savedP;
    }
  });

  await test("listModels returns current-gen Flash set without a network call", async () => {
    const p = new VertexProvider("gemini-flash-latest", { project: "p" });
    const models = await p.listModels();
    assert.ok(models.includes("gemini-flash-latest"));
    assert.ok(models.length >= 1);
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
