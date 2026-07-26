/**
 * Inference gateway v1 — the shared `complete` entry point the Cascade
 * Workbench (and any other client) calls over the `cascade-agent serve`
 * sidecar (Workbench platform plan §4.1/§4.7).
 *
 * This module is the RUNTIME OWNER of four things no caller re-implements:
 *
 *   1. Model-tier mapping (§4.1.1): callers pick a tier
 *      (standard | advanced), never a raw model id.
 *   2. The BAA gate (G-3): a PHI-carrying payload may go only to a
 *      BAA-covered endpoint on a model the signed agreement ACTUALLY COVERS.
 *      `assertBaaForPhi` gates on an explicit per-model coverage fact
 *      (D-RMA-7), not on the model's launch stage.
 *   3. The routing seam (D-RMA-37): a device token means the Cascade relay;
 *      no device token means the local ADC/Vertex path, unchanged. A build
 *      with no token behaves exactly as it did before the relay existed.
 *   4. The single egress ledger (§4.7): one metadata-only entry appended to
 *      `<pod>/provenance/egress-log.jsonl` BEFORE every cloud call. The entry
 *      holds counts and destinations only — there is no field that can carry
 *      prompt content. When the caller names a Pod ledger, a failed append
 *      ABORTS the call: no egress without its audit line. On the relay path a
 *      SECOND line reconciles what the relay reported about the upstream
 *      (D-RMA-25/26), marked as testimony rather than proof.
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
import { CascadeRelayProvider } from "./providers/cascade-relay.js";
import {
  writeEgressLogStrict,
  DEFAULT_EGRESS_LOG_PATH,
  type EgressLogEntry,
} from "./providers/trusted-endpoint.js";
import type { CompleteOptions } from "./providers/types.js";
import {
  CASCADE_RELAY_HOST,
  hasUpstreamFacts,
  type RelayUpstreamAttestation,
} from "./relay/contract.js";

// ── Model tiers (D-RMA-6: neutral names, two of them) ────────────────────────

/**
 * The gateway's model tiers. Neutral by design: `flash-lite` was Google
 * vocabulary in the wire protocol of an architecture whose entire justification
 * is provider portability. Plainly ordinal, so the ranking needs no legend, and
 * still correct if a Pro-class model later fills the top slot.
 *
 * The middle `flash` PREVIEW tier is GONE, not renamed (D-RMA-6 as amended
 * 2026-07-26). A client enum naming a tier the relay refuses to serve is
 * exactly the drift the rename exists to prevent; the relay's tier table is
 * the only place a future third tier gets added.
 */
export const MODEL_TIERS = ["standard", "advanced"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * A model's launch stage. DESCRIPTIVE LEDGER METADATA ONLY since D-RMA-7 as
 * amended: it is recorded on the egress line because it is useful context, and
 * it is NOT the BAA gate. GA-ness is Google's proxy for BAA coverage, not the
 * thing itself, and encoding the proxy hardcodes one vendor's coverage policy
 * into the architecture whose whole purpose is vendor neutrality.
 */
export type ModelLaunchStage = "GA" | "PREVIEW";

/**
 * One tier row. `baaCovered` is an explicit, human-set truth claim about a
 * signed agreement, so it DEFAULTS FALSE and must carry provenance or the gate
 * degrades into a checkbox (D-RMA-7's own stated risk and mitigation).
 */
export interface TierModel {
  model: string;
  /** Descriptive only. Never gates anything. */
  launchStage: ModelLaunchStage;
  /** The gate. Default false; true only with provenance recorded below. */
  baaCovered: boolean;
  /** Which agreement, dated, verified by whom. Required when baaCovered. */
  baaProvenance?: string;
}

/**
 * Tier → concrete model on the LOCAL ADC/Vertex path. Both are served only
 * from `location: global`.
 *
 * This table does NOT apply to the relay path: the relay holds its own tier
 * table (provider, model, endpoint, region, launch stage, coverage, pricing)
 * and that is what makes a provider swap a config change with zero app
 * releases (D-RMA-28).
 */
export const VERTEX_TIER_MODELS: Record<ModelTier, TierModel> = {
  standard: {
    model: "gemini-3.1-flash-lite",
    launchStage: "GA",
    baaCovered: true,
    baaProvenance:
      "Google Cloud HIPAA BAA (cloud.google.com/terms/hipaa-baa); Generative AI on " +
      "Gemini Enterprise Agent Platform is on the covered-services list; verified by " +
      "delegated research agent 2026-07-26 against cloud.google.com/security/compliance/hipaa",
  },
  advanced: {
    model: "gemini-3.5-flash",
    launchStage: "GA",
    baaCovered: true,
    baaProvenance:
      "Google Cloud HIPAA BAA (cloud.google.com/terms/hipaa-baa); Generative AI on " +
      "Gemini Enterprise Agent Platform is on the covered-services list; verified by " +
      "delegated research agent 2026-07-26 against cloud.google.com/security/compliance/hipaa",
  },
};

export const DEFAULT_MODEL_TIER: ModelTier = "standard";

/**
 * The pre-D-RMA-6 tier names, kept for ONE purpose: a clear error message when
 * a stale caller sends one. They are never accepted as an alias, because a
 * silent alias is how two repos drift apart while both look healthy.
 */
export const RETIRED_TIER_NAMES: Record<string, string> = {
  "flash-lite": "standard",
  "flash-max": "advanced",
  flash: "(removed: the preview tier is gone, not renamed)",
};

export function isModelTier(v: unknown): v is ModelTier {
  return typeof v === "string" && (MODEL_TIERS as readonly string[]).includes(v);
}

// ── The BAA gate (G-3, regated per D-RMA-7) ─────────────────────────────────

/**
 * True when the endpoint is a destination Cascade has an agreement covering:
 *
 *   1. the Vertex AI API surface (`aiplatform.googleapis.com`, global or
 *      regional), which is the local-ADC path under Jed's own Google BAA; or
 *   2. the canonical Cascade relay host, which is Cloud Run inside Cascade's
 *      own project under the same Google Cloud BAA, and which enforces the
 *      binding server-side gate on the hop beyond it (D-RMA-29).
 *
 * A relay base URL that is NOT the canonical host (a dev override, a stub) is
 * deliberately NOT covered, so pointing the app at a local relay fails the PHI
 * gate closed instead of quietly routing records through an unverified box.
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
    host.endsWith("-aiplatform.googleapis.com") ||
    host === CASCADE_RELAY_HOST
  );
}

/** Why a PHI-carrying call was blocked. */
export type BaaViolationReason = "endpoint-not-covered" | "model-not-covered";

/** Thrown when a PHI-carrying call targets a destination the BAA does not cover. */
export class BaaViolationError extends Error {
  readonly endpoint: string;
  readonly reason: BaaViolationReason;
  /** Descriptive launch stage of the model involved, when one is known. */
  readonly modelStage?: ModelLaunchStage;

  constructor(
    endpoint: string,
    reason: BaaViolationReason,
    modelStage?: ModelLaunchStage
  ) {
    const why =
      reason === "endpoint-not-covered"
        ? `endpoint <${endpoint}> is not covered by the BAA`
        : `the model this tier resolves to is not recorded as covered by a signed BAA`;
    super(
      `PHI egress blocked: ${why}. Record-context calls may only run on a ` +
        `BAA-covered endpoint with a model the signed agreement actually ` +
        `covers. Use a covered tier (standard or advanced), or de-identify ` +
        `the payload.`
    );
    this.name = "BaaViolationError";
    this.endpoint = endpoint;
    this.reason = reason;
    this.modelStage = modelStage;
  }
}

/** The coverage fact the gate runs on. Absent coverage reads as NOT covered. */
export interface BaaCoverage {
  baaCovered: boolean;
  launchStage?: ModelLaunchStage;
}

/**
 * Gate a PHI-carrying cloud call: the endpoint must be covered AND the model
 * must carry an explicit coverage fact (D-RMA-7). Throws
 * {@link BaaViolationError} on violation. Runs BEFORE the ledger write and the
 * network call — a blocked attempt never egresses and never appears in the
 * "what left the machine" ledger (D-RMA-29).
 *
 * Launch stage is accepted for the error message only. It does not gate.
 */
export function assertBaaForPhi(endpoint: string, coverage: BaaCoverage): void {
  if (!isBaaCoveredEndpoint(endpoint)) {
    throw new BaaViolationError(
      endpoint,
      "endpoint-not-covered",
      coverage.launchStage
    );
  }
  if (!coverage.baaCovered) {
    throw new BaaViolationError(
      endpoint,
      "model-not-covered",
      coverage.launchStage
    );
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
  /** Model tier; defaults to `standard` (cheapest covered). */
  modelTier?: ModelTier;
  /**
   * Provider selection. Accepts "vertex" (the local ADC path) and
   * "cascade-relay". Omitted means "let the routing seam decide", which is
   * what every caller should do: the seam picks the relay when a device token
   * is present and the ADC path when it is not.
   */
  provider?: string;
  /**
   * The tester's opaque device token (D-RMA-9). When present the call routes
   * through the Cascade relay; when absent it takes the local ADC/Vertex path
   * unchanged. Never logged, never written to the ledger, never returned.
   *
   * Set by the sidecar route from the `x-cascade-device-token` request header,
   * which the Tauri shell reads from the OS keychain. It does NOT come from
   * the renderer, and it is not persisted in the sidecar's environment.
   */
  deviceToken?: string;
  /** Relay base URL override (development against a local stub). */
  relayBaseUrl?: string;
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
  /** The route the call actually took. */
  provider: "vertex" | "cascade-relay";
  /**
   * On the ADC path: the concrete model the tier resolved to. On the relay
   * path: the tier, because the client does not choose the model. The
   * relay-reported concrete model, when the relay sent one, is in `upstream`.
   */
  model: string;
  modelTier: ModelTier;
  launchStage: ModelLaunchStage;
  /**
   * The exact endpoint the APP dialed, and can prove it dialed. On the relay
   * path this is the relay, not the upstream (D-RMA-25).
   */
  endpoint: string;
  /**
   * The relay's account of the upstream that served the call (D-RMA-26).
   * Present only on the relay path, only when the relay sent the headers, and
   * never inferred. Callers rendering it MUST mark it as reported rather than
   * verified.
   */
  upstream?: RelayUpstreamAttestation;
}

/** A malformed request (missing/invalid fields) — maps to HTTP 400. */
export class GatewayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

// ── Dependency seams (injected by tests; real defaults in production) ─────────

/**
 * The slice of a provider the gateway needs. Both `VertexProvider` and
 * `CascadeRelayProvider` satisfy it; the relay one additionally reports the
 * upstream attestation, which the gateway feature-detects.
 */
export interface GatewayProvider {
  endpointUrl(): string;
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
  /** Relay only: what the relay said served the last call (D-RMA-26). */
  lastUpstreamAttestation?(): RelayUpstreamAttestation | null;
}

/** Which path a call took, and everything the ledger needs to describe it. */
export interface ResolvedRoute {
  route: "vertex" | "cascade-relay";
  provider: GatewayProvider;
  /** What goes in the ledger's `model` field for the app-verified hop. */
  ledgerModel: string;
}

export interface GatewayDeps {
  /**
   * Build the provider for the LOCAL ADC/Vertex path, given a resolved
   * concrete model id. Injected by tests; unchanged from gateway v1 so every
   * existing no-token test keeps working byte for byte.
   */
  makeProvider?: (model: string, project?: string) => GatewayProvider;
  /**
   * Build the provider for the RELAY path. Injected by tests so the relay
   * contract can be exercised against a local stub with no network.
   */
  makeRelayProvider?: (args: {
    deviceToken: string;
    tier: ModelTier;
    purpose: string;
    baseUrl?: string;
  }) => GatewayProvider;
  /**
   * Where the device token comes from when the request does not carry one.
   * Production default: nowhere. The token is passed per request by the Tauri
   * shell (which owns the keychain), never read out of the sidecar's own
   * environment, so a long-lived secret never sits in the process env.
   */
  deviceToken?: () => string | undefined;
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
  if (
    req.provider !== undefined &&
    req.provider !== "vertex" &&
    req.provider !== "cascade-relay"
  ) {
    throw new GatewayRequestError(
      `provider "${req.provider}" is not supported (expected "vertex" or "cascade-relay")`
    );
  }
  const tier = req.modelTier ?? DEFAULT_MODEL_TIER;
  if (!isModelTier(tier)) {
    const retired = RETIRED_TIER_NAMES[String(req.modelTier)];
    throw new GatewayRequestError(
      `unknown modelTier "${String(req.modelTier)}" (expected ${MODEL_TIERS.join(" | ")})` +
        (retired ? `. That tier was retired: use ${retired}.` : "")
    );
  }
  const tierInfo = VERTEX_TIER_MODELS[tier];

  // 2. Fail closed on PHI: absent means true.
  const containsPhi = req.containsPhi ?? true;

  // 3. THE ROUTING SEAM (D-RMA-37). A device token means the tester path
  //    through the Cascade relay; no token means the local ADC/Vertex path,
  //    byte for byte as it behaved before the relay existed. A caller may pin
  //    a route explicitly, but a pinned relay route without a token is a
  //    request error rather than a silent downgrade to ADC.
  const deviceToken = req.deviceToken ?? deps.deviceToken?.();
  const wantsRelay =
    req.provider === "cascade-relay" ||
    (req.provider === undefined && Boolean(deviceToken));
  if (wantsRelay && !deviceToken) {
    throw new GatewayRequestError(
      'provider "cascade-relay" requires a device token'
    );
  }

  let route: ResolvedRoute;
  if (wantsRelay && deviceToken) {
    const makeRelayProvider =
      deps.makeRelayProvider ??
      ((args: {
        deviceToken: string;
        tier: ModelTier;
        purpose: string;
        baseUrl?: string;
      }): GatewayProvider =>
        new CascadeRelayProvider({
          deviceToken: args.deviceToken,
          tier: args.tier,
          purpose: args.purpose,
          ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
        }));
    const provider = makeRelayProvider({
      deviceToken,
      tier,
      purpose: req.purpose,
      ...(req.relayBaseUrl !== undefined ? { baseUrl: req.relayBaseUrl } : {}),
    });
    // The relay resolves the model, so the app-verified hop records the TIER,
    // not a model id the client did not choose. The concrete model arrives on
    // the reconciliation line, marked as the relay's account of it.
    route = { route: "cascade-relay", provider, ledgerModel: tier };
  } else {
    // The tier models (Gemini 3.x) exist ONLY at location "global"; pin it
    // explicitly so a stray VERTEX_LOCATION env override cannot 404 the call.
    const makeProvider =
      deps.makeProvider ??
      ((model: string, project?: string): GatewayProvider =>
        new VertexProvider(model, { project, location: "global" }));
    const provider = makeProvider(tierInfo.model, req.project);
    route = {
      route: "vertex",
      provider,
      ledgerModel: qualifyVertexModel(tierInfo.model),
    };
  }
  const provider = route.provider;
  const endpoint = provider.endpointUrl();

  // 4. The BAA gate — BEFORE ledger and network. G-3 / D-RMA-29. It gates on
  //    the endpoint plus the explicit per-model coverage FACT, never on the
  //    launch stage. A blocked attempt never reaches the network and never
  //    writes a ledger line.
  if (containsPhi) {
    assertBaaForPhi(endpoint, {
      baaCovered: tierInfo.baaCovered,
      launchStage: tierInfo.launchStage,
    });
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
    provider: route.route,
    endpoint,
    model: route.ledgerModel,
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
    // Optimistic pre-send outcome. Written BEFORE the call (write-before-send);
    // if the call then fails we append a failed-in-flight reconciliation line
    // below so the ledger never reads a failed attempt as a confirmed egress.
    outcome: "sent",
    // This hop is PROOF, not testimony: the app dialed this endpoint itself.
    // Only ever set on the relay path, where a second, quoted hop exists to
    // distinguish it from; a plain ADC line stays byte-identical to before.
    ...(route.route === "cascade-relay"
      ? { upstreamAttestation: "app-verified" as const }
      : {}),
  };
  writeLedger(entry, logPath);

  // 6. Dial the provider. On failure, reconcile the optimistic "sent" line with
  //    a metadata-only failure record (append-only JSONL) so a send that never
  //    completed is distinguishable from a real egress. The reconciliation line
  //    reuses the redacted entry (NO PHI or response content) and must never
  //    mask the provider error the caller needs to see.
  let text: string;
  try {
    text = await provider.complete(req.prompt, {
      system: req.system,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
    });
  } catch (err) {
    const failureEntry: EgressLogEntry = {
      ...entry,
      timestamp: now().toISOString(),
      outcome: "failed-in-flight",
    };
    try {
      writeLedger(failureEntry, logPath);
    } catch (reconErr) {
      // A lost reconciliation line must not replace the provider error; surface
      // it and re-throw the original failure.
      const m = reconErr instanceof Error ? reconErr.message : String(reconErr);
      process.stderr.write(
        `Warning: failed to append egress failure reconciliation at ${logPath}: ${m}\n`
      );
    }
    throw err;
  }

  // 7. Two-hop reconciliation (D-RMA-25/26). The pre-send line could not know
  //    the upstream: write-before-send happens before the relay has answered.
  //    Now that the relay HAS answered, append a second metadata-only line
  //    carrying what it reported, marked "relay-reported" so the ledger never
  //    blurs proof into testimony. Written from HEADERS ONLY — if the relay
  //    sent none, no line is written rather than an inferred one, because an
  //    inference in an audit record is a guess wearing a fact's clothes.
  let upstream: RelayUpstreamAttestation | undefined;
  if (route.route === "cascade-relay") {
    const reported = provider.lastUpstreamAttestation?.() ?? null;
    if (reported && hasUpstreamFacts(reported)) {
      upstream = reported;
      const attestationEntry: EgressLogEntry = {
        ...entry,
        timestamp: now().toISOString(),
        outcome: "relay-attested",
        upstreamAttestation: "relay-reported",
        upstream: reported,
      };
      try {
        writeLedger(attestationEntry, logPath);
      } catch (attErr) {
        // A lost attestation line must not fail a completed call: the bytes
        // already left, the app-verified line is already on disk, and the
        // caller needs its answer. Surface it loudly instead.
        const m = attErr instanceof Error ? attErr.message : String(attErr);
        process.stderr.write(
          `Warning: failed to append relay upstream attestation at ${logPath}: ${m}\n`
        );
      }
    }
  }

  return {
    text,
    provider: route.route,
    model: route.route === "cascade-relay" ? tier : tierInfo.model,
    modelTier: tier,
    launchStage: tierInfo.launchStage,
    endpoint,
    ...(upstream ? { upstream } : {}),
  };
}
