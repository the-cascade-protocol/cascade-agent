/**
 * Inference gateway v1 — the shared `complete` entry point the Cascade
 * Workbench (and any other client) calls over the `cascade-agent serve`
 * sidecar (Workbench platform plan §4.1/§4.7).
 *
 * This module is the RUNTIME OWNER of three things no caller re-implements:
 *
 *   1. Model-tier mapping (§4.1.1): callers pick a tier
 *      (flash-lite | flash | flash-max), never a raw model id.
 *   2. The BAA gate (G-3): a PHI-carrying payload may go only to the
 *      BAA-covered Vertex endpoint ON A GA MODEL. `assertBaaForPhi` gates
 *      BOTH axes — preview models are excluded from Google Cloud's BAA even
 *      on the covered endpoint.
 *   3. The single egress ledger (§4.7): one metadata-only entry appended to
 *      `<pod>/provenance/egress-log.jsonl` BEFORE every cloud call. The entry
 *      holds counts and destinations only — there is no field that can carry
 *      prompt content. When the caller names a Pod ledger, a failed append
 *      ABORTS the call: no egress without its audit line.
 *
 * The Workbench's TS contract twin lives in
 * `cascade-workbench/packages/contracts/src/gateway.ts`; if the tier table or
 * the gate rule changes here, change it there in the same commit.
 *
 * Everything is dependency-injectable so tests run with zero network, zero
 * credentials, and zero PHI.
 */

import { join } from "path";
import {
  VertexProvider,
  qualifyVertexModel,
} from "./providers/vertex.js";
import {
  writeEgressLogStrict,
  DEFAULT_EGRESS_LOG_PATH,
  type EgressLogEntry,
} from "./providers/trusted-endpoint.js";
import type { CompleteOptions } from "./providers/types.js";

// ── Model tiers (availability + launch stages verified live 2026-07-01) ──────

export type VertexModelTier = "flash-lite" | "flash" | "flash-max";
export type ModelLaunchStage = "GA" | "PREVIEW";

/**
 * Tier → concrete Vertex model. All three are served ONLY from
 * `location: global`.
 *
 *   flash-lite — cheapest, GA.       High-volume/PHI nodes. PHI-eligible.
 *   flash      — best mix, PREVIEW.  De-identified payloads ONLY (no BAA).
 *   flash-max  — best quality, GA.   Precision-critical nodes. PHI-eligible.
 */
export const VERTEX_TIER_MODELS: Record<
  VertexModelTier,
  { model: string; launchStage: ModelLaunchStage }
> = {
  "flash-lite": { model: "gemini-3.1-flash-lite", launchStage: "GA" },
  flash: { model: "gemini-3-flash-preview", launchStage: "PREVIEW" },
  "flash-max": { model: "gemini-3.5-flash", launchStage: "GA" },
};

export const DEFAULT_MODEL_TIER: VertexModelTier = "flash-lite";

// ── The BAA gate (G-3) ────────────────────────────────────────────────────────

/**
 * True when the endpoint is covered by the signed Google Cloud BAA: the
 * Vertex AI API surface (global or regional host). The public AI Studio
 * endpoint and third-party providers are NOT covered.
 */
export function isBaaCoveredEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return false;
  }
  return (
    host === "aiplatform.googleapis.com" ||
    host.endsWith("-aiplatform.googleapis.com")
  );
}

/** Thrown when a PHI-carrying call targets a non-BAA endpoint or non-GA model. */
export class BaaViolationError extends Error {
  readonly endpoint: string;
  readonly modelStage: ModelLaunchStage;

  constructor(endpoint: string, modelStage: ModelLaunchStage) {
    const why = !isBaaCoveredEndpoint(endpoint)
      ? `endpoint <${endpoint}> is not covered by the BAA`
      : `model launch stage "${modelStage}" is not GA (pre-GA offerings are excluded from the BAA)`;
    super(
      `PHI egress blocked: ${why}. Record-context calls may only run on the ` +
        `BAA Vertex endpoint with a GA model. Use a GA tier (flash-lite or ` +
        `flash-max), or de-identify the payload.`
    );
    this.name = "BaaViolationError";
    this.endpoint = endpoint;
    this.modelStage = modelStage;
  }
}

/**
 * Gate a PHI-carrying cloud call on BOTH axes: BAA endpoint AND GA launch
 * stage. Throws {@link BaaViolationError} on violation. Runs BEFORE the
 * ledger write and the network call — a blocked attempt never egresses and
 * never appears in the "what left the machine" ledger.
 */
export function assertBaaForPhi(
  endpoint: string,
  modelStage: ModelLaunchStage
): void {
  if (!isBaaCoveredEndpoint(endpoint) || modelStage !== "GA") {
    throw new BaaViolationError(endpoint, modelStage);
  }
}

// ── Request / response shapes (the sidecar's POST /complete body) ────────────

/** Caller-declared egress context: where to log and what the manifest counted. */
export interface GatewayEgressContext {
  /**
   * Pod directory whose provenance ledger receives the entry
   * (`<podDir>/provenance/egress-log.jsonl`). When absent, the entry goes to
   * the agent's default config-dir log.
   */
  podDir?: string;
  /** Which app surface initiated the call (e.g. "ledger", "cloud-agent"). */
  surface?: string;
  /** Pod records the pre-send context manifest enumerated. */
  manifestRecordCount?: number;
  /** Graded assertions the pre-send context manifest enumerated. */
  manifestAssertionCount?: number;
}

export interface GatewayCompleteRequest {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Short label recorded on the ledger entry. Required — the audit needs it. */
  purpose: string;
  /** Model tier; defaults to flash-lite (cheapest GA). */
  modelTier?: VertexModelTier;
  /** Provider selection. v1 supports only "vertex" (the BAA path). */
  provider?: string;
  /**
   * Whether the payload embeds record context / pasted-conversation content.
   * ABSENT MEANS TRUE (fail closed): only a caller that has verifiably
   * de-identified the payload passes false.
   */
  containsPhi?: boolean;
  /** GCP project override; falls back to GOOGLE_CLOUD_PROJECT et al. */
  project?: string;
  egress?: GatewayEgressContext;
}

export interface GatewayCompleteResponse {
  text: string;
  provider: "vertex";
  /** The concrete model the tier resolved to. */
  model: string;
  modelTier: VertexModelTier;
  launchStage: ModelLaunchStage;
  /** The exact endpoint the call was sent to. */
  endpoint: string;
}

/** A malformed request (missing/invalid fields) — maps to HTTP 400. */
export class GatewayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

// ── Dependency seams (injected by tests; real defaults in production) ─────────

/** The slice of a provider the gateway needs. VertexProvider satisfies it. */
export interface GatewayProvider {
  endpointUrl(): string;
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
}

export interface GatewayDeps {
  /** Build the provider for a resolved concrete model id. */
  makeProvider?: (model: string, project?: string) => GatewayProvider;
  /** Append one ledger entry (throws on failure — no egress without audit). */
  writeLedger?: (entry: EgressLogEntry, logPath: string) => void;
  /** Clock, for deterministic tests. */
  now?: () => Date;
}

/** The Pod-relative ledger location (platform §4.7 storage decision, 1A). */
export function podEgressLogPath(podDir: string): string {
  return join(podDir, "provenance", "egress-log.jsonl");
}

// ── The gateway ───────────────────────────────────────────────────────────────

/**
 * Run one gateway completion: validate → resolve tier → BAA-gate (PHI) →
 * append the ledger entry → dial the provider. The ledger entry is written
 * BEFORE the network call so a record exists even if the call fails
 * mid-flight; a blocked (BAA) attempt is never dialed and never logged.
 */
export async function completeViaGateway(
  req: GatewayCompleteRequest,
  deps: GatewayDeps = {}
): Promise<GatewayCompleteResponse> {
  // 1. Validate.
  if (typeof req.prompt !== "string" || req.prompt.length === 0) {
    throw new GatewayRequestError("prompt is required");
  }
  if (typeof req.purpose !== "string" || req.purpose.trim().length === 0) {
    throw new GatewayRequestError(
      "purpose is required (it is recorded on the egress ledger entry)"
    );
  }
  if (req.provider !== undefined && req.provider !== "vertex") {
    throw new GatewayRequestError(
      `provider "${req.provider}" is not supported by gateway v1 (only "vertex")`
    );
  }
  const tier = req.modelTier ?? DEFAULT_MODEL_TIER;
  const tierInfo = VERTEX_TIER_MODELS[tier];
  if (!tierInfo) {
    throw new GatewayRequestError(
      `unknown modelTier "${String(req.modelTier)}" (expected flash-lite | flash | flash-max)`
    );
  }

  // 2. Fail closed on PHI: absent means true.
  const containsPhi = req.containsPhi ?? true;

  // 3. Resolve the provider + destination.
  // The tier models (Gemini 3.x) exist ONLY at location "global"; pin it
  // explicitly so a stray VERTEX_LOCATION env override cannot 404 the call.
  const makeProvider =
    deps.makeProvider ??
    ((model: string, project?: string): GatewayProvider =>
      new VertexProvider(model, { project, location: "global" }));
  const provider = makeProvider(tierInfo.model, req.project);
  const endpoint = provider.endpointUrl();

  // 4. The BAA gate — BEFORE ledger and network. G-3.
  if (containsPhi) {
    assertBaaForPhi(endpoint, tierInfo.launchStage);
  }

  // 5. Ledger entry, appended BEFORE the call (§4.7). Metadata only, by
  //    construction: counts, sizes, and destinations — never content.
  const now = deps.now ?? (() => new Date());
  const writeLedger = deps.writeLedger ?? writeEgressLogStrict;
  const logPath = req.egress?.podDir
    ? podEgressLogPath(req.egress.podDir)
    : DEFAULT_EGRESS_LOG_PATH;
  const entry: EgressLogEntry = {
    timestamp: now().toISOString(),
    provider: "vertex",
    endpoint,
    model: qualifyVertexModel(tierInfo.model),
    direction: "outbound",
    summary: {
      messageCount: req.system ? 2 : 1,
      contentBytes:
        Buffer.byteLength(req.prompt, "utf-8") +
        (req.system ? Buffer.byteLength(req.system, "utf-8") : 0),
      toolCount: 0,
      ...(req.egress?.manifestRecordCount !== undefined
        ? { manifestRecordCount: req.egress.manifestRecordCount }
        : {}),
      ...(req.egress?.manifestAssertionCount !== undefined
        ? { manifestAssertionCount: req.egress.manifestAssertionCount }
        : {}),
    },
    purpose: req.purpose,
    containsPhi,
    launchStage: tierInfo.launchStage,
    modelTier: tier,
    ...(req.egress?.surface ? { surface: req.egress.surface } : {}),
  };
  writeLedger(entry, logPath);

  // 6. Dial the provider.
  const text = await provider.complete(req.prompt, {
    system: req.system,
    temperature: req.temperature,
    maxTokens: req.maxTokens,
  });

  return {
    text,
    provider: "vertex",
    model: tierInfo.model,
    modelTier: tier,
    launchStage: tierInfo.launchStage,
    endpoint,
  };
}
