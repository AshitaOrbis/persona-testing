/**
 * AI tool-call loop — provider-agnostic orchestration of the
 * model ↔ browser feedback cycle.
 *
 * Two implementations:
 *   - AnthropicProvider: @anthropic-ai/sdk
 *   - OpenAIProvider:    openai SDK
 *
 * Run-level guardrails enforced here:
 *   - iteration cap (clamped 1..100)
 *   - wall-clock deadline per run
 *   - cumulative input/output token budgets
 *   - per-request timeouts on every API call
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { TOOL_DEFINITIONS, type PlaywrightBridge } from "./tools.js";
import type { ExecutionStatus, StopReason, ToolName } from "./schema.js";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LoopResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  iterations: number;
  /** A limit stop is terminal and must never be treated as a completed gate run. */
  executionStatus: ExecutionStatus;
  /** Why the loop ended. */
  stopReason: StopReason;
}

export type LoopStopReason = StopReason;

export interface ProviderOptions {
  apiKey: string;
  model?: string;
  maxIterations?: number;
  /** Wall-clock deadline for the whole run, in ms. Default 900000 (15 min). */
  deadlineMs?: number;
  /** Per-API-request timeout in ms. Default 120000. */
  requestTimeoutMs?: number;
  /** Cumulative input-token budget. Default 1000000. */
  maxInputTokens?: number;
  /** Cumulative output-token budget. Default 64000. */
  maxOutputTokens?: number;
}

export interface AIProvider {
  run(
    systemPrompt: string,
    userMessage: string,
    bridge: PlaywrightBridge,
  ): Promise<LoopResult>;
}

const DEFAULT_MAX_ITERATIONS = 50;
const HARD_MAX_ITERATIONS = 100;
const DEFAULT_DEADLINE_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_INPUT_TOKENS = 1_000_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const NORMAL_RESPONSE_MAX_TOKENS = 16_384;

function clampIterations(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_MAX_ITERATIONS;
  return Math.min(Math.max(Math.floor(n), 1), HARD_MAX_ITERATIONS);
}

/** Shared budget tracker. */
class RunBudget {
  readonly deadline: number;
  readonly maxInput: number;
  readonly maxOutput: number;
  inputTokens = 0;
  outputTokens = 0;

  constructor(options: ProviderOptions) {
    this.deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    this.maxInput = options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    this.maxOutput = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  remainingTimeMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  remainingInputTokens(): number {
    return Math.max(0, this.maxInput - this.inputTokens);
  }

  remainingOutputTokens(): number {
    return Math.max(0, this.maxOutput - this.outputTokens);
  }

  recordUsage(inputTokens: number, outputTokens: number): void {
    this.inputTokens += Math.max(0, inputTokens);
    this.outputTokens += Math.max(0, outputTokens);
  }

  /** Returns a stop reason when a budget is exhausted, null otherwise. */
  exceeded(): "deadline" | "token_budget" | null {
    if (this.remainingTimeMs() <= 0) return "deadline";
    if (
      this.inputTokens >= this.maxInput ||
      this.outputTokens >= this.maxOutput
    ) {
      return "token_budget";
    }
    return null;
  }

  /**
   * Refuse a request unless its conservative input estimate and output cap fit
   * inside the remaining run budgets.
   */
  prepareRequest(
    payload: unknown,
    requestedOutputTokens: number,
    requestTimeoutMs: number,
  ):
    | { stopReason: "deadline" | "token_budget" }
    | { maxOutputTokens: number; timeoutMs: number } {
    const exceeded = this.exceeded();
    if (exceeded) return { stopReason: exceeded };

    // A token cannot encode less than one UTF-8 byte. The serialized request
    // byte length is therefore a deliberately conservative upper bound.
    const estimatedInputTokens = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (estimatedInputTokens > this.remainingInputTokens()) {
      return { stopReason: "token_budget" };
    }

    const maxOutputTokens = Math.min(
      requestedOutputTokens,
      this.remainingOutputTokens(),
    );
    if (maxOutputTokens < 1) return { stopReason: "token_budget" };

    const timeoutMs = Math.min(requestTimeoutMs, this.remainingTimeMs());
    if (timeoutMs < 1) return { stopReason: "deadline" };

    return { maxOutputTokens, timeoutMs };
  }
}

function exhaustedResult(
  budget: RunBudget,
  iterations: number,
  stopReason: Exclude<LoopStopReason, "completed" | "output_truncated">,
): LoopResult {
  return {
    text:
      "## Structured Assessment\n\n" +
      "### Readiness Score: 0%\n\n" +
      "### Critical Bugs\n\n" +
      `BUDGET_EXHAUSTED: evaluation is INCONCLUSIVE (${stopReason}). ` +
      "This is an execution guardrail state, not an application defect, and cannot pass the deployment gate.\n",
    inputTokens: budget.inputTokens,
    outputTokens: budget.outputTokens,
    iterations,
    executionStatus: "BUDGET_EXHAUSTED",
    stopReason,
  };
}

/**
 * The provider cut the response off at its output cap. Whatever text arrived is
 * kept for the report, but the run is not a finished evaluation: it is never
 * labelled completed, so it cannot pass the gate, and no cut-off tool call runs.
 */
function truncatedResult(budget: RunBudget, iterations: number, text: string): LoopResult {
  return {
    text,
    inputTokens: budget.inputTokens,
    outputTokens: budget.outputTokens,
    iterations,
    executionStatus: "TRUNCATED",
    stopReason: "output_truncated",
  };
}

function requestAbortOptions(timeoutMs: number): {
  options: { timeout: number; signal: AbortSignal };
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    options: { timeout: timeoutMs, signal: controller.signal },
    clear: () => clearTimeout(timer),
  };
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private maxIterations: number;
  private options: ProviderOptions;

  constructor(options: ProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      timeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    // Verified against Anthropic's published model list (2026-07-26): this is a
    // valid current API model ID. Note it is NOT evergreen — from the 4.6
    // generation on, dateless IDs are still pinned snapshots, not moving
    // pointers. So this default does need reviewing when model lines turn over;
    // it is correct today, not self-maintaining.
    this.model = options.model || "claude-sonnet-4-6";
    this.maxIterations = clampIterations(options.maxIterations);
    this.options = options;
  }

  async run(
    systemPrompt: string,
    userMessage: string,
    bridge: PlaywrightBridge,
  ): Promise<LoopResult> {
    const tools = TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool["input_schema"],
    }));

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userMessage },
    ];

    const budget = new RunBudget(this.options);
    let iterations = 0;

    while (iterations < this.maxIterations) {
      const exceeded = budget.exceeded();
      if (exceeded) return exhaustedResult(budget, iterations, exceeded);
      iterations++;

      const requestBody = {
        model: this.model,
        max_tokens: NORMAL_RESPONSE_MAX_TOKENS,
        system: systemPrompt,
        tools,
        messages,
      };
      const requestBudget = budget.prepareRequest(
        requestBody,
        NORMAL_RESPONSE_MAX_TOKENS,
        this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if ("stopReason" in requestBudget) {
        return exhaustedResult(budget, iterations - 1, requestBudget.stopReason);
      }
      requestBody.max_tokens = requestBudget.maxOutputTokens;
      const abort = requestAbortOptions(requestBudget.timeoutMs);

      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create(requestBody, abort.options);
      } catch (err: any) {
        if (budget.remainingTimeMs() <= 0) {
          return exhaustedResult(budget, iterations, "deadline");
        }
        // Token overflow recovery: ask for just the assessment
        if (err?.status === 400 && err?.message?.includes("token")) {
          messages.push({
            role: "user",
            content:
              "You are running out of context. Please produce ONLY the ## Structured Assessment block now. Skip any remaining scenarios.",
          });
          continue;
        }
        throw err;
      } finally {
        abort.clear();
      }

      budget.recordUsage(
        response.usage?.input_tokens ?? 0,
        response.usage?.output_tokens ?? 0,
      );
      const responseExceeded = budget.exceeded();
      if (responseExceeded) {
        return exhaustedResult(budget, iterations, responseExceeded);
      }

      // Check for tool use blocks
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ContentBlock & { type: "tool_use" } => b.type === "tool_use",
      );
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );

      if (response.stop_reason === "max_tokens") {
        return truncatedResult(budget, iterations, textBlocks.map((b) => b.text).join("\n"));
      }

      // If no tool calls, we're done
      if (toolBlocks.length === 0 || response.stop_reason === "end_turn") {
        const finalText = textBlocks.map((b) => b.text).join("\n");

        // Check for critical bug early exit
        if (finalText.includes("CRITICAL BUG:")) {
          return {
            text: finalText,
            inputTokens: budget.inputTokens,
            outputTokens: budget.outputTokens,
            iterations,
            executionStatus: "COMPLETED",
            stopReason: "completed",
          };
        }

        // If there are tool blocks but also an end_turn, we still grab the text
        if (finalText) {
          return {
            text: finalText,
            inputTokens: budget.inputTokens,
            outputTokens: budget.outputTokens,
            iterations,
            executionStatus: "COMPLETED",
            stopReason: "completed",
          };
        }
      }

      // Dispatch tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolBlocks) {
        const beforeTool = budget.exceeded();
        if (beforeTool) return exhaustedResult(budget, iterations, beforeTool);

        const result = await bridge.dispatch(
          block.name as ToolName,
          (block.input ?? {}) as Record<string, unknown>,
        );

        const afterTool = budget.exceeded();
        if (afterTool) return exhaustedResult(budget, iterations, afterTool);

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });

        // Critical bug check in tool results
        if (result.startsWith("CRITICAL BUG:")) {
          const text = textBlocks.map((b) => b.text).join("\n") + "\n\n" + result;
          return {
            text,
            inputTokens: budget.inputTokens,
            outputTokens: budget.outputTokens,
            iterations,
            executionStatus: "COMPLETED",
            stopReason: "completed",
          };
        }
      }

      // Add assistant message + tool results
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }

    return exhaustedResult(budget, iterations, "max_iterations");
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private maxIterations: number;
  private options: ProviderOptions;

  constructor(options: ProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      timeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    this.model = options.model || "gpt-4o";
    this.maxIterations = clampIterations(options.maxIterations);
    this.options = options;
  }

  async run(
    systemPrompt: string,
    userMessage: string,
    bridge: PlaywrightBridge,
  ): Promise<LoopResult> {
    const tools: OpenAI.ChatCompletionTool[] = TOOL_DEFINITIONS.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const budget = new RunBudget(this.options);
    let iterations = 0;

    while (iterations < this.maxIterations) {
      const exceeded = budget.exceeded();
      if (exceeded) return exhaustedResult(budget, iterations, exceeded);
      iterations++;

      const requestBody: OpenAI.ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        max_tokens: NORMAL_RESPONSE_MAX_TOKENS,
        tools,
        messages,
      };
      const requestBudget = budget.prepareRequest(
        requestBody,
        NORMAL_RESPONSE_MAX_TOKENS,
        this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if ("stopReason" in requestBudget) {
        return exhaustedResult(budget, iterations - 1, requestBudget.stopReason);
      }
      requestBody.max_tokens = requestBudget.maxOutputTokens;
      const abort = requestAbortOptions(requestBudget.timeoutMs);

      let response: OpenAI.ChatCompletion;
      try {
        response = await this.client.chat.completions.create(requestBody, abort.options);
      } catch (error) {
        if (budget.remainingTimeMs() <= 0) {
          return exhaustedResult(budget, iterations, "deadline");
        }
        throw error;
      } finally {
        abort.clear();
      }

      const choice = response.choices[0];
      if (!choice) throw new Error("No response from OpenAI");

      budget.recordUsage(
        response.usage?.prompt_tokens ?? 0,
        response.usage?.completion_tokens ?? 0,
      );
      const responseExceeded = budget.exceeded();
      if (responseExceeded) {
        return exhaustedResult(budget, iterations, responseExceeded);
      }

      const assistantMsg = choice.message;
      messages.push(assistantMsg);

      if (choice.finish_reason === "length") {
        return truncatedResult(budget, iterations, assistantMsg.content || "");
      }

      // No tool calls — done
      if (!assistantMsg.tool_calls?.length || choice.finish_reason === "stop") {
        return {
          text: assistantMsg.content || "",
          inputTokens: budget.inputTokens,
          outputTokens: budget.outputTokens,
          iterations,
          executionStatus: "COMPLETED",
          stopReason: "completed",
        };
      }

      // Dispatch tool calls
      for (const toolCall of assistantMsg.tool_calls) {
        const beforeTool = budget.exceeded();
        if (beforeTool) return exhaustedResult(budget, iterations, beforeTool);

        let input: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(toolCall.function.arguments || "{}");
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // malformed JSON from model — handled below
        }

        let result: string;
        if (input === null) {
          // Route malformed provider calls through the bridge so they enter
          // the same call-level evidence stream and health accounting as all
          // other attempted tools. The sentinel can never count as an
          // observation or interaction.
          result = await bridge.dispatch(
            "__provider_malformed_tool_call__" as ToolName,
            {},
          );
        } else {
          result = await bridge.dispatch(toolCall.function.name as ToolName, input);
        }

        const afterTool = budget.exceeded();
        if (afterTool) return exhaustedResult(budget, iterations, afterTool);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    return exhaustedResult(budget, iterations, "max_iterations");
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProvider(
  providerName: "anthropic" | "openai",
  options: ProviderOptions,
): AIProvider {
  switch (providerName) {
    case "anthropic":
      return new AnthropicProvider(options);
    case "openai":
      return new OpenAIProvider(options);
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}
