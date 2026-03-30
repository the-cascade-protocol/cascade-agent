/**
 * Eval harness — executes a single test case against any Provider and
 * returns a structured result.
 */
import type { Provider, SimpleMessage, AgentCallbacks } from "../src/providers/types.js";
import type { ToolInput } from "../src/tools.js";
import { runAgent } from "../src/agent.js";

export interface ToolCall {
  name: string;
  input: ToolInput;
  result: string;
}

export interface EvalResult {
  pass: boolean;
  /** 0–1 partial credit where applicable */
  score: number;
  notes: string;
  /** All tool calls made during the turn */
  toolCalls: ToolCall[];
  /** Final assistant text */
  response: string;
  /** Wall-clock ms for the full turn */
  latencyMs: number;
  /** Whether the turn errored out */
  error?: string;
}

export interface EvalCase {
  name: string;
  /** Short description shown in the table */
  description: string;
  /** User prompt sent to the agent */
  prompt: string;
  /**
   * Scoring function. Receives the final messages array and collected tool
   * calls, returns pass/score/notes.
   */
  evaluate(
    messages: SimpleMessage[],
    toolCalls: ToolCall[]
  ): { pass: boolean; score: number; notes: string };
}

/**
 * Run one eval case and return the result.
 * Prints nothing — the reporter handles all output.
 */
export async function runCase(
  evalCase: EvalCase,
  provider: Provider
): Promise<EvalResult> {
  const toolCalls: ToolCall[] = [];
  let response = "";

  const callbacks: AgentCallbacks = {
    onText: (delta) => { response += delta; },
    onToolStart: (name, input) => { toolCalls.push({ name, input, result: "" }); },
    onToolEnd: (name, result) => {
      const last = toolCalls.findLast((tc) => tc.name === name && tc.result === "");
      if (last) last.result = result;
    },
  };

  const start = Date.now();
  let messages: SimpleMessage[] = [{ role: "user", content: evalCase.prompt }];

  try {
    messages = await runAgent(provider, messages, [], callbacks);
    const latencyMs = Date.now() - start;
    const { pass, score, notes } = evalCase.evaluate(messages, toolCalls);
    return { pass, score, notes, toolCalls, response, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      pass: false,
      score: 0,
      notes: "Exception during turn",
      toolCalls,
      response,
      latencyMs,
      error: (err as Error).message,
    };
  }
}
