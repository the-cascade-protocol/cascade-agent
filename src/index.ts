/**
 * @the-cascade-protocol/agent — public library API
 *
 * This file is the package entry point when the agent is used as a library
 * (e.g., imported by cascade-appeal or other Cascade ecosystem tools).
 * The CLI entry point remains `src/cli.ts` / `dist/cli.js`.
 *
 * Usage:
 *   import { createProvider, runAgent } from '@the-cascade-protocol/agent';
 *   import type { Provider, ProviderName, SimpleMessage, AgentCallbacks, CanonicalTool } from '@the-cascade-protocol/agent';
 */

// Core agent function
export { runAgent } from "./agent.js";
export type { SimpleMessage, AgentCallbacks } from "./agent.js";

// Provider factory and types
export {
  createProvider,
  ALL_PROVIDERS,
  DEFAULT_MODELS,
  VALIDATION_MODELS,
} from "./providers/index.js";
export type { Provider, ProviderName } from "./providers/types.js";

// Tool definitions and executor (consumers can extend or replace)
export { tools, executeTool } from "./tools.js";
export type { CanonicalTool, ToolInput } from "./tools.js";

// Commander integration — mount `cascade agent` as a subcommand tree
export { registerAgentCommand } from "./commands/agent-command.js";

// Inference gateway v1 (Workbench platform plan §4.1/§4.7): tier mapping,
// the PHI/BAA gate, and the pre-call egress ledger. Served over
// `cascade-agent serve` as POST /complete; exported here for library use.
export {
  completeViaGateway,
  assertBaaForPhi,
  isBaaCoveredEndpoint,
  isModelTier,
  BaaViolationError,
  GatewayRequestError,
  MODEL_TIERS,
  VERTEX_TIER_MODELS,
  RETIRED_TIER_NAMES,
  DEFAULT_MODEL_TIER,
  podEgressLogPath,
} from "./gateway.js";
export type {
  ModelTier,
  ModelLaunchStage,
  TierModel,
  BaaCoverage,
  BaaViolationReason,
  GatewayCompleteRequest,
  GatewayCompleteResponse,
  GatewayEgressContext,
  GatewayProvider,
  GatewayDeps,
  ResolvedRoute,
} from "./gateway.js";
export type { CompleteOptions } from "./providers/types.js";

// The Cascade relay (remote model access, [ALPHA-MODEL-ACCESS]): the frozen
// wire contract, the thin provider, and the entitlement status poll.
export { CascadeRelayProvider } from "./providers/cascade-relay.js";
export type { CascadeRelayOptions } from "./providers/cascade-relay.js";
export {
  CASCADE_RELAY_HOST,
  DEFAULT_CASCADE_RELAY_BASE_URL,
  HEADER_PURPOSE,
  HEADER_TIER,
  UPSTREAM_HEADERS,
  RELAY_REFUSAL_REASONS,
  RELAY_ENTITLEMENT_STATES,
  RelayRefusalError,
  RelayOutageError,
  isRelayRefusalReason,
  isRelayEntitlementState,
  parseRelayRefusal,
  parseRelayStatus,
  readUpstreamAttestation,
  resolveRelayBaseUrl,
} from "./relay/contract.js";
export type {
  RelayRefusalReason,
  RelayEntitlementState,
  RelayNotice,
  RelayStatus,
  RelayUpstreamAttestation,
} from "./relay/contract.js";
export {
  fetchRelayStatus,
  relayStatusUrl,
  RELAY_STATUS_POLL_INTERVAL_MS,
} from "./relay/status.js";
export {
  CASCADE_PURPOSES,
  PURPOSE_ENUM_VERSION,
  isCascadePurpose,
} from "./relay/purposes.js";
export type { CascadePurpose } from "./relay/purposes.js";
