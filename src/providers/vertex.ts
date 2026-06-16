/**
 * Vertex AI provider — Google Cloud, BAA-covered, PHI-safe cloud inference.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DISTINCT FROM THE EXISTING "google" PROVIDER — READ THIS.                 │
 * │                                                                           │
 * │  • "google"  →  public  generativelanguage.googleapis.com (AI Studio).    │
 * │                 Auth = a static API key. NOT BAA-covered. Do NOT send     │
 * │                 PHI to it. Fine for synthetic/eval traffic only.          │
 * │                                                                           │
 * │  • "vertex"  →  regional  {location}-aiplatform.googleapis.com (this).    │
 * │                 Auth = GCP IAM via Application Default Credentials.        │
 * │                 HIPAA-eligible UNDER A SIGNED BAA, no training on          │
 * │                 customer data, minimizable logging. THIS is the PHI-safe  │
 * │                 path the Workbench Assertions Ledger routes claim         │
 * │                 extraction/grounding through (plan §10 risk row +         │
 * │                 OQ#12). Always wrap it as a Trusted Endpoint so each       │
 * │                 call is egress-logged.                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Wire protocol: Vertex exposes an OpenAI-compatible Chat Completions surface
 * for Gemini, so once we hold a bearer token we reuse `OpenAICompatProvider`'s
 * battle-tested streaming + tool-loop verbatim (including its Gemini
 * thinking-token fallback) rather than reimplementing it. The only Vertex-
 * specific work here is (1) the regional base URL and (2) ADC auth.
 *
 * Auth (ADC, never a static key):
 *   - Preferred: `google-auth-library` (optional dep) → application-default creds.
 *   - Fallback: shell `gcloud auth application-default print-access-token`.
 *   Neither is invoked at construction time, and neither is invoked in tests.
 *
 * Network guard (offline-safe):
 *   - The constructor does NO network or auth I/O.
 *   - `validate()` checks GOOGLE_CLOUD_PROJECT + ADC presence and returns a
 *     clear, actionable error instead of letting a cryptic 401 surface later.
 *   - `runTurn()` re-checks config and fetches a token only when an actual
 *     inference call is made, so importing/constructing this provider is free.
 */

import { execFileSync } from "child_process";
import type { CanonicalTool } from "../tools.js";
import type { Provider, SimpleMessage, AgentCallbacks } from "./types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { DescribesEndpoint } from "./trusted-endpoint.js";

// ── Defaults ──────────────────────────────────────────────────────────────────

/**
 * Default region. Vertex is regional; us-central1 has the broadest model
 * availability. Override with VERTEX_LOCATION / the constructor.
 */
export const DEFAULT_VERTEX_LOCATION = "us-central1";

/**
 * Default model. A current-generation cost-efficient Gemini Flash — the model
 * class OQ#12 settled on for the PHI runtime (HIPAA-eligible under the BAA,
 * cheap). The exact tag is verified at build/deploy; "-latest"-style aliases
 * track the current generation automatically where Vertex supports them.
 */
export const DEFAULT_VERTEX_MODEL = "gemini-flash-latest";

/** Result of a pre-flight configuration check. */
export interface VertexValidation {
  ok: boolean;
  /** Actionable error message when `ok` is false. */
  error?: string;
  /** The resolved GCP project id, when configured. */
  project?: string;
  /** The resolved region. */
  location: string;
}

// ── Config resolution (pure, no I/O) ──────────────────────────────────────────

/** Resolve the GCP project id from explicit option then standard env vars. */
function resolveProject(explicit?: string): string | undefined {
  return (
    explicit ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCLOUD_PROJECT ??
    process.env.GCP_PROJECT ??
    undefined
  );
}

/** Resolve the region from explicit option then env, falling back to default. */
function resolveLocation(explicit?: string): string {
  return explicit ?? process.env.VERTEX_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? DEFAULT_VERTEX_LOCATION;
}

export interface VertexProviderOptions {
  /** GCP project id. Falls back to GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT. */
  project?: string;
  /** Region, e.g. "us-central1". Falls back to VERTEX_LOCATION. */
  location?: string;
}

// ── ADC token acquisition (guarded, lazy, never at import time) ───────────────

/**
 * Obtain a short-lived OAuth2 access token via Application Default Credentials.
 *
 * Strategy:
 *   1. If `google-auth-library` is installed (optional dep), use it — the
 *      supported, refreshable path.
 *   2. Otherwise shell `gcloud auth application-default print-access-token`.
 *
 * Throws an actionable error if neither path can produce a token. This is the
 * ONLY function that touches credentials, and it runs only inside `runTurn`.
 */
async function getAccessToken(): Promise<string> {
  // 1) google-auth-library, if present.
  //
  // The package is NOT a (peer/optional) dependency of cascade-agent, so we must
  // not reference its types statically — that would break `tsc` when it is
  // absent. We import it dynamically through a runtime-computed specifier (so the
  // compiler does not try to resolve the module) and describe only the tiny slice
  // of its API we use via a local structural type.
  try {
    interface GoogleAuthLib {
      GoogleAuth: new (opts: { scopes: string[] }) => {
        getClient(): Promise<{
          getAccessToken(): Promise<string | { token?: string | null } | null>;
        }>;
      };
    }
    const specifier = "google-auth-library";
    const lib = (await import(/* @vite-ignore */ specifier)) as GoogleAuthLib;
    const auth = new lib.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token =
      typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
    if (token) return token;
    // fall through to gcloud if the library returned no token
  } catch {
    // Optional dep absent or ADC not resolvable via the library — try gcloud.
  }

  // 2) gcloud fallback.
  try {
    const token = execFileSync(
      "gcloud",
      ["auth", "application-default", "print-access-token"],
      { encoding: "utf-8", timeout: 30_000 }
    ).trim();
    if (token) return token;
  } catch {
    // fall through to the unified error below
  }

  throw new Error(
    "Could not obtain Google Cloud credentials for Vertex AI.\n" +
      "Run: gcloud auth application-default login\n" +
      "(or install google-auth-library and configure a service account)."
  );
}

// ── Provider ───────────────────────────────────────────────────────────────────

export class VertexProvider implements Provider, DescribesEndpoint {
  readonly providerName = "vertex" as const;
  readonly model: string;
  readonly project?: string;
  readonly location: string;

  constructor(model: string = DEFAULT_VERTEX_MODEL, options: VertexProviderOptions = {}) {
    // Resolve config only — NO network, NO auth, NO throwing here, so that
    // merely constructing the provider (e.g. for listing or in a test) is safe.
    this.model = model;
    this.project = resolveProject(options.project);
    this.location = resolveLocation(options.location);
  }

  /**
   * The regional OpenAI-compatible Chat Completions base URL for this project.
   * Used by the trusted-endpoint wrapper to log the precise egress destination.
   */
  endpointUrl(): string {
    const project = this.project ?? "<unset-project>";
    return (
      `https://${this.location}-aiplatform.googleapis.com/v1beta1/` +
      `projects/${project}/locations/${this.location}/endpoints/openapi`
    );
  }

  /**
   * Pre-flight configuration check. Does NOT call the Vertex API; it only
   * verifies that a project is configured and that ADC are obtainable, so the
   * caller (and the offline path) get a clear error instead of a runtime 401.
   * Safe to call in any environment — never sends patient data anywhere.
   */
  async validate(): Promise<VertexValidation> {
    if (!this.project) {
      return {
        ok: false,
        location: this.location,
        error:
          "Vertex AI is not configured: set GOOGLE_CLOUD_PROJECT (or pass { project }) " +
          "and run `gcloud auth application-default login`.",
      };
    }
    try {
      await getAccessToken();
    } catch (err) {
      return {
        ok: false,
        project: this.project,
        location: this.location,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: true, project: this.project, location: this.location };
  }

  /**
   * Build an OpenAI-compatible delegate bound to the Vertex regional endpoint
   * with a freshly-minted ADC bearer token. Guards on missing project FIRST so
   * no network call happens for an unconfigured provider.
   */
  private async buildDelegate(): Promise<OpenAICompatProvider> {
    if (!this.project) {
      throw new Error(
        "Vertex AI is not configured: set GOOGLE_CLOUD_PROJECT (or pass { project }) " +
          "and run `gcloud auth application-default login`."
      );
    }
    const token = await getAccessToken();
    const baseURL =
      `https://${this.location}-aiplatform.googleapis.com/v1beta1/` +
      `projects/${this.project}/locations/${this.location}/endpoints/openapi`;
    // The OpenAI SDK sends `apiKey` as `Authorization: Bearer <key>`, which is
    // exactly Vertex's auth scheme. We reuse OpenAICompatProvider's streaming +
    // tool loop (and its Gemini thinking-token fallback) wholesale; only the
    // transport (endpoint + bearer token) is Vertex-specific.
    return new OpenAICompatProvider("vertex", token, this.model, baseURL);
  }

  async runTurn(
    messages: SimpleMessage[],
    tools: CanonicalTool[],
    callbacks: AgentCallbacks
  ): Promise<string> {
    const delegate = await this.buildDelegate();
    return delegate.runTurn(messages, tools, callbacks);
  }

  async listModels(): Promise<string[]> {
    // Vertex does not expose a stable OpenAI-style /models list for Gemini, and
    // model availability is region-specific. Return the configured model plus a
    // small set of known current-generation Flash aliases so the picker is
    // useful without a metadata round-trip. (No PHI; no patient egress.)
    const known = [
      this.model,
      "gemini-flash-latest",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ];
    return Array.from(new Set(known)).sort();
  }
}
