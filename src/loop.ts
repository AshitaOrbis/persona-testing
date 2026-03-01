/**
 * AI tool-call loop — provider-agnostic orchestration of the
 * model ↔ browser feedback cycle.
 *
 * Two implementations:
 *   - AnthropicProvider: @anthropic-ai/sdk
 *   - OpenAIProvider:    openai SDK
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
}

export interface ProviderOptions {
  apiKey: string;
  model?: string;
  maxIterations?: number;
}

export interface AIProvider {
  run(
    systemPrompt: string,
    userMessage: string,
    bridge: PlaywrightBridge,
  ): Promise<LoopResult>;
}

const MAX_ITERATIONS = 50;

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private maxIterations: number;

  constructor(options: ProviderOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model || "claude-sonnet-4-5-20250514";
    this.maxIterations = options.maxIterations || MAX_ITERATIONS;
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

    let totalInput = 0;
    let totalOutput = 0;
    let iterations = 0;

    while (iterations < this.maxIterations) {
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

      totalInput += response.usage?.input_tokens ?? 0;
      totalOutput += response.usage?.output_tokens ?? 0;

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
          return { text: finalText, inputTokens: totalInput, outputTokens: totalOutput, iterations };
        }

        // If there are tool blocks but also an end_turn, we still grab the text
        if (finalText) {
          return { text: finalText, inputTokens: totalInput, outputTokens: totalOutput, iterations };
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
          return { text, inputTokens: totalInput, outputTokens: totalOutput, iterations };
        }
      }

      // Add assistant message + tool results
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }

    // Safety: hit max iterations — ask for final output
    messages.push({
      role: "user",
      content:
        "Maximum iteration limit reached. Please produce the ## Structured Assessment block now with what you have observed so far.",
    });

    const finalResponse = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
    });

    totalInput += finalResponse.usage?.input_tokens ?? 0;
    totalOutput += finalResponse.usage?.output_tokens ?? 0;

    const finalText = finalResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return { text: finalText, inputTokens: totalInput, outputTokens: totalOutput, iterations };
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private maxIterations: number;

  constructor(options: ProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model || "gpt-4o";
    this.maxIterations = options.maxIterations || MAX_ITERATIONS;
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

    let totalInput = 0;
    let totalOutput = 0;
    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations++;

      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 16384,
        tools,
        messages,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error("No response from OpenAI");

      totalInput += response.usage?.prompt_tokens ?? 0;
      totalOutput += response.usage?.completion_tokens ?? 0;

      const assistantMsg = choice.message;
      messages.push(assistantMsg);

      // No tool calls — done
      if (!assistantMsg.tool_calls?.length || choice.finish_reason === "stop") {
        return {
          text: assistantMsg.content || "",
          inputTokens: totalInput,
          outputTokens: totalOutput,
          iterations,
        };
      }

      // Dispatch tool calls
      for (const toolCall of assistantMsg.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          // malformed JSON from model
        }

        const result = await bridge.dispatch(
          toolCall.function.name as ToolName,
          input,
        );

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    // Safety: hit max iterations
    messages.push({
      role: "user",
      content:
        "Maximum iteration limit reached. Please produce the ## Structured Assessment block now with what you have observed so far.",
    });

    const finalResponse = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 8192,
      messages,
    });

    totalInput += finalResponse.usage?.prompt_tokens ?? 0;
    totalOutput += finalResponse.usage?.completion_tokens ?? 0;

    return {
      text: finalResponse.choices[0]?.message.content || "",
      inputTokens: totalInput,
      outputTokens: totalOutput,
      iterations,
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
