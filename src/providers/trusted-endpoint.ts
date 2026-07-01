/**
 * Trusted-endpoint wrapper + cloud-egress log.
 *
 * Implements the "trusted endpoint" contract from the Cascade Workbench
 * implementation plan (§4.4 / Glossary): a cloud LLM endpoint the user has
 * designated once as safe (ideally HIPAA/BAA-covered). It is used without
 * per-query nagging, but EVERY cloud call is recorded in a visible, append-only
 * egress log so the user can audit exactly what left the machine.
 *
 * North-Star / PHI discipline:
 *  - The egress log NEVER contains raw record content. It records a REDACTED
 *    summary only: timestamp, endpoint, model, byte count, and message/field
 *    counts. Trends and shapes, never values. (Plan §2.3 "No PHI in logs".)
 *  - LOCAL providers ("local", "ollama") do not leave the machine, so they are
 *    NOT wrapped and write NO egress entry. Wrapping a local provider is a
 *    no-op that returns it unchanged.
 *
 * This module is deliberately decoupled from any Pod: cascade-agent has no Pod
 * path in scope. The default log location is the agent config dir; callers that
 * own a Pod (e.g. the Workbench Tauri shell) pass an explicit path into the
 * Pod's `provenance/` directory (plan §4.1).
 */

import { homedir } from "os";
import { join, dirname } from "path";
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import type {
  Provider,
  ProviderName,
  SimpleMessage,
  AgentCallbacks,
} from "./types.js";
import type { CanonicalTool } from "../tools.js";

// ── Which providers are "local" (no egress) vs "cloud" (must be logged) ───────

/** Providers whose inference runs entirely on-device — never produce egress. */
const LOCAL_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>([
  "local",
  "ollama",
]);

/** True if this provider's inference stays on the user's machine. */
export function isLocalProvider(name: ProviderName): boolean {
  return LOCAL_PROVIDERS.has(name);
}

// ── Egress log location ───────────────────────────────────────────────────────

/**
 * Default egress-log path when no Pod is in scope.
 * The Workbench shell overrides this with `<pod>/provenance/egress-log.jsonl`.
 */
export const DEFAULT_EGRESS_LOG_PATH = join(
  homedir(),
  ".config",
  "cascade-agent",
  "egress-log.jsonl"
);

// ── Egress-log entry shape ────────────────────────────────────────────────────

/**
 * A single cloud-call record. JSON-Lines (one object per line) so it is
 * append-only, tail-able, and trivially diffable — and so a crash mid-write
 * never corrupts earlier entries.
 *
 * REDACTED BY CONSTRUCTION: there is no field here that can hold raw PHI. The
 * summary carries counts and byte totals only.
 */
export interface EgressLogEntry {
  /** ISO-8601 UTC timestamp of the call. */
  timestamp: string;
  /** Logical provider name (e.g. "vertex"). */
  provider: ProviderName;
  /** The concrete network endpoint the bytes were sent to. */
  endpoint: string;
  /** The model id requested. */
  model: string;
  /** Coarse direction marker — always "outbound" for a request. */
  direction: "outbound";
  /**
   * Redacted, PHI-free summary of the payload. Counts and sizes only —
   * NEVER message text, field values, or record content.
   */
  summary: EgressSummary;
  /** Why the call happened (e.g. "assertion-grounding"). Gateway calls set it. */
  purpose?: string;
  /** Whether the payload was declared to carry PHI (drives the BAA gate). */
  containsPhi?: boolean;
  /** Launch stage of the model used ("GA" | "PREVIEW") — the BAA gate's second axis. */
  launchStage?: string;
  /** The gateway model tier the caller asked for (e.g. "flash-lite"). */
  modelTier?: string;
  /** Which app surface initiated the call (e.g. "ledger", "cloud-agent"). */
  surface?: string;
}

/** PHI-free shape descriptor of an outbound payload. */
export interface EgressSummary {
  /** Number of chat messages in the request. */
  messageCount: number;
  /** Total bytes of message content sent (UTF-8). */
  contentBytes: number;
  /** Number of tools/functions exposed to the model on this call. */
  toolCount: number;
  /** Pod records the pre-send context manifest enumerated, when known. */
  manifestRecordCount?: number;
  /** Graded assertions the pre-send context manifest enumerated, when known. */
  manifestAssertionCount?: number;
}

/**
 * Build a redacted summary from the outbound conversation. This is the single
 * choke point that guarantees no raw content reaches the log: it reads
 * `.content.length` (a count), never the content itself.
 */
export function summarizeEgress(
  messages: SimpleMessage[],
  tools: CanonicalTool[]
): EgressSummary {
  let contentBytes = 0;
  for (const m of messages) {
    // Byte length, not character length — a true measure of what egressed.
    contentBytes += Buffer.byteLength(m.content ?? "", "utf-8");
  }
  return {
    messageCount: messages.length,
    contentBytes,
    toolCount: tools.length,
  };
}

/**
 * Append one egress entry to the JSON-Lines log, creating the directory if
 * needed. Logging is best-effort: a failure to write the audit line must never
 * take down the inference call, but it is surfaced on stderr so it is visible.
 */
export function writeEgressLog(
  entry: EgressLogEntry,
  logPath: string = DEFAULT_EGRESS_LOG_PATH
): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, JSON.stringify(entry) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: failed to write egress log at ${logPath}: ${msg}\n`);
  }
}

/**
 * Strict variant of {@link writeEgressLog}: THROWS when the append fails.
 * The inference gateway uses this for its Pod-ledger writes so "log before
 * send" is load-bearing — if the audit line cannot be written, the cloud call
 * does not happen. The best-effort variant above remains for the wrapper's
 * default-config-dir log, where availability was chosen over strictness.
 */
export function writeEgressLogStrict(
  entry: EgressLogEntry,
  logPath: string = DEFAULT_EGRESS_LOG_PATH
): void {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  appendFileSync(logPath, JSON.stringify(entry) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Read back all egress entries (for the Workbench egress-log UI / audits). */
export function readEgressLog(
  logPath: string = DEFAULT_EGRESS_LOG_PATH
): EgressLogEntry[] {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf-8");
  const entries: EgressLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as EgressLogEntry);
    } catch {
      // Skip a corrupt line rather than fail the whole read.
    }
  }
  return entries;
}

// ── A cloud provider that can describe its own network endpoint ───────────────

/**
 * Optional capability a provider implements so the trusted-endpoint wrapper can
 * log the precise destination URL. Cloud providers added for the Workbench
 * (e.g. the Vertex provider) implement this; if a provider does not, the
 * wrapper falls back to a generic "<provider>:cloud" marker.
 */
export interface DescribesEndpoint {
  /** The concrete network endpoint outbound requests are sent to. */
  endpointUrl(): string;
}

function hasEndpointUrl(p: Provider): p is Provider & DescribesEndpoint {
  return typeof (p as Partial<DescribesEndpoint>).endpointUrl === "function";
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface TrustedEndpointOptions {
  /**
   * Where to write the egress log. Default: the agent config dir. The Workbench
   * passes `<pod>/provenance/egress-log.jsonl` so the audit trail lives with
   * the data it describes.
   */
  egressLogPath?: string;
}

// ── The wrapper ────────────────────────────────────────────────────────────────

/**
 * A Provider decorator that records an egress-log entry on every `runTurn`
 * call. It delegates all inference to the wrapped cloud provider unchanged; its
 * only added behavior is the audit write. `listModels` is pass-through and is
 * NOT logged (it carries no PHI and is a metadata call, not patient egress).
 */
export class TrustedEndpointProvider implements Provider {
  readonly providerName: ProviderName;
  readonly model: string;
  private readonly inner: Provider;
  private readonly egressLogPath: string;

  constructor(inner: Provider, options: TrustedEndpointOptions = {}) {
    if (isLocalProvider(inner.providerName)) {
      // Defensive: callers should use designateTrustedEndpoint(), which never
      // wraps a local provider. If one slips through, fail loudly — silently
      // logging a "cloud" egress for an on-device model would be misleading.
      throw new Error(
        `Provider "${inner.providerName}" runs locally and must not be wrapped as a trusted cloud endpoint. ` +
          `Local providers produce no egress and need no egress log.`
      );
    }
    this.inner = inner;
    this.providerName = inner.providerName;
    this.model = inner.model;
    this.egressLogPath = options.egressLogPath ?? DEFAULT_EGRESS_LOG_PATH;
  }

  /** The destination this trusted endpoint sends to (for UI display). */
  endpointUrl(): string {
    return hasEndpointUrl(this.inner)
      ? this.inner.endpointUrl()
      : `${this.inner.providerName}:cloud`;
  }

  async runTurn(
    messages: SimpleMessage[],
    tools: CanonicalTool[],
    callbacks: AgentCallbacks
  ): Promise<string> {
    // Write the audit entry BEFORE the network call so a record exists even if
    // the call throws partway. The summary is redacted by construction.
    const entry: EgressLogEntry = {
      timestamp: new Date().toISOString(),
      provider: this.inner.providerName,
      endpoint: this.endpointUrl(),
      model: this.inner.model,
      direction: "outbound",
      summary: summarizeEgress(messages, tools),
    };
    writeEgressLog(entry, this.egressLogPath);

    return this.inner.runTurn(messages, tools, callbacks);
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels();
  }
}

/**
 * Designate a provider as the trusted cloud endpoint.
 *
 * - Cloud providers are wrapped in `TrustedEndpointProvider` so every call is
 *   egress-logged.
 * - Local providers ("local"/"ollama") are returned UNCHANGED — they never
 *   leave the machine, so there is nothing to log and no endpoint to trust.
 *
 * This is the function the Workbench shell calls once the user has opted into a
 * cloud endpoint; the returned provider is then used everywhere inference runs.
 */
export function designateTrustedEndpoint(
  provider: Provider,
  options: TrustedEndpointOptions = {}
): Provider {
  if (isLocalProvider(provider.providerName)) return provider;
  return new TrustedEndpointProvider(provider, options);
}
