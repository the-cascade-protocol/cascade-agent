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
