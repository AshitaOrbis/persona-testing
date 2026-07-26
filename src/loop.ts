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
import type { ToolName } from "./schema.js";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LoopResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  iterations: number;
  /** Why the loop ended: "completed" | "max_iterations" | "deadline" | "token_budget" */
  stopReason: string;
}

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

  /** Returns a stop reason when a budget is exhausted, null otherwise. */
  exceeded(): string | null {
    if (Date.now() > this.deadline) return "deadline";
    if (this.inputTokens > this.maxInput || this.outputTokens > this.maxOutput) {
      return "token_budget";
    }
    return null;
  }
}

const WRAP_UP_MESSAGE = (reason: string) =>
  `The run ${reason} limit has been reached. Please produce the ## Structured Assessment block now with what you have observed so far.`;

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
    let stopReason = "max_iterations";

    while (iterations < this.maxIterations) {
      const exceeded = budget.exceeded();
      if (exceeded) {
        stopReason = exceeded;
        break;
      }
      iterations++;

      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: 16384,
          system: systemPrompt,
          tools,
          messages,
        });
      } catch (err: any) {
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
      }

      budget.inputTokens += response.usage?.input_tokens ?? 0;
      budget.outputTokens += response.usage?.output_tokens ?? 0;

      // Check for tool use blocks
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ContentBlock & { type: "tool_use" } => b.type === "tool_use",
      );
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );

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
            stopReason: "completed",
          };
        }
      }

      // Dispatch tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolBlocks) {
        const result = await bridge.dispatch(
          block.name as ToolName,
          (block.input ?? {}) as Record<string, unknown>,
        );
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
            stopReason: "completed",
          };
        }
      }

      // Add assistant message + tool results
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }

    // Budget or iteration limit hit — ask for final output
    messages.push({
      role: "user",
      content: WRAP_UP_MESSAGE(stopReason === "max_iterations" ? "iteration" : stopReason),
    });

    const finalResponse = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
    });

    budget.inputTokens += finalResponse.usage?.input_tokens ?? 0;
    budget.outputTokens += finalResponse.usage?.output_tokens ?? 0;

    const finalText = finalResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return {
      text: finalText,
      inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens,
      iterations,
      stopReason,
    };
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
    let stopReason = "max_iterations";

    while (iterations < this.maxIterations) {
      const exceeded = budget.exceeded();
      if (exceeded) {
        stopReason = exceeded;
        break;
      }
      iterations++;

      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 16384,
        tools,
        messages,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error("No response from OpenAI");

      budget.inputTokens += response.usage?.prompt_tokens ?? 0;
      budget.outputTokens += response.usage?.completion_tokens ?? 0;

      const assistantMsg = choice.message;
      messages.push(assistantMsg);

      // No tool calls — done
      if (!assistantMsg.tool_calls?.length || choice.finish_reason === "stop") {
        return {
          text: assistantMsg.content || "",
          inputTokens: budget.inputTokens,
          outputTokens: budget.outputTokens,
          iterations,
          stopReason: "completed",
        };
      }

      // Dispatch tool calls
      for (const toolCall of assistantMsg.tool_calls) {
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
          result =
            "Error: malformed tool arguments (not valid JSON object). " +
            "Retry the tool call with valid JSON arguments.";
        } else {
          result = await bridge.dispatch(toolCall.function.name as ToolName, input);
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    // Budget or iteration limit hit
    messages.push({
      role: "user",
      content: WRAP_UP_MESSAGE(stopReason === "max_iterations" ? "iteration" : stopReason),
    });

    const finalResponse = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 8192,
      messages,
    });

    budget.inputTokens += finalResponse.usage?.prompt_tokens ?? 0;
    budget.outputTokens += finalResponse.usage?.completion_tokens ?? 0;

    return {
      text: finalResponse.choices[0]?.message.content || "",
      inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens,
      iterations,
      stopReason,
    };
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
