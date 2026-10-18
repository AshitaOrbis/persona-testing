/**
 * Hard run-budget regression tests.
 *
 * Provider clients are replaced with deterministic fakes because these tests
 * must prove request counts and request options without network access.
 */

import assert from "node:assert/strict";
import { AnthropicProvider, OpenAIProvider } from "./loop.js";
import { parseAssessment } from "./parser.js";
import type { PlaywrightBridge } from "./tools.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

const bridge = {
  dispatch: async () => "Observed page outline",
} as unknown as PlaywrightBridge;

const openAiToolResponse = (inputTokens: number, outputTokens: number) => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "get_outline", arguments: "{}" },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
});

console.log("\nLoop Budget Tests\n");

await test("deadline expiry during an iteration makes zero further model calls", async () => {
  let calls = 0;
  let firstRequestOptions: { signal?: AbortSignal; timeout?: number } | undefined;
  const provider = new OpenAIProvider({
    apiKey: "test-key",
    deadlineMs: 5,
    requestTimeoutMs: 1_000,
    maxIterations: 5,
    maxInputTokens: 10_000,
    maxOutputTokens: 100,
  });

  (provider as any).client = {
    chat: {
      completions: {
        create: async (_body: unknown, options?: { signal?: AbortSignal; timeout?: number }) => {
          calls++;
          firstRequestOptions ??= options;
          await new Promise((resolve) => setTimeout(resolve, 15));
          return openAiToolResponse(10, 1);
        },
      },
    },
  };

  const result = await provider.run("system", "user", bridge);

  assert.equal(calls, 1, "no wrap-up or subsequent request may run after the deadline");
  assert.equal(result.executionStatus, "BUDGET_EXHAUSTED");
  assert.equal(result.stopReason, "deadline");
  assert.ok(firstRequestOptions?.signal instanceof AbortSignal);
  assert.ok((firstRequestOptions?.timeout ?? Infinity) <= 5);
});

await test("output-token exhaustion makes zero further model calls", async () => {
  let calls = 0;
  let firstMaxTokens: number | undefined;
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 5,
    maxInputTokens: 10_000,
    maxOutputTokens: 4,
  });

  (provider as any).client = {
    messages: {
      create: async (body: { max_tokens: number }) => {
        calls++;
        firstMaxTokens ??= body.max_tokens;
        return {
          content: [
            { type: "tool_use", id: "tool-1", name: "get_outline", input: {} },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 4 },
        };
      },
    },
  };

  const result = await provider.run("system", "user", bridge);

  assert.equal(firstMaxTokens, 4, "request output allowance must be capped to remaining budget");
  assert.equal(calls, 1, "no wrap-up or subsequent request may run after token exhaustion");
  assert.equal(result.executionStatus, "BUDGET_EXHAUSTED");
  assert.equal(result.stopReason, "token_budget");
});

await test("a request is refused before spending when input budget cannot cover it", async () => {
  let calls = 0;
  const provider = new OpenAIProvider({
    apiKey: "test-key",
    maxIterations: 5,
    maxInputTokens: 1,
    maxOutputTokens: 100,
  });

  (provider as any).client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          return openAiToolResponse(1, 1);
        },
      },
    },
  };

  const result = await provider.run("system", "user", bridge);

  assert.equal(calls, 0);
  assert.equal(result.executionStatus, "BUDGET_EXHAUSTED");
  assert.equal(result.stopReason, "token_budget");
});

await test("iteration exhaustion produces a machine-generated non-passing report", async () => {
  let calls = 0;
  const provider = new OpenAIProvider({
    apiKey: "test-key",
    maxIterations: 1,
    maxInputTokens: 10_000,
    maxOutputTokens: 100,
  });

  (provider as any).client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          if (calls === 1) return openAiToolResponse(10, 1);
          return {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content:
                    "## Structured Assessment\n\n### Readiness Score: 100%\n\n### Critical Bugs\n\nNone",
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          };
        },
      },
    },
  };

  const result = await provider.run("system", "user", bridge);
  const report = parseAssessment(result.text, "Budget Test", "https://example.com");

  assert.equal(calls, 1, "iteration exhaustion must not trigger a wrap-up request");
  assert.equal(result.executionStatus, "BUDGET_EXHAUSTED");
  assert.equal(result.stopReason, "max_iterations");
  assert.equal(report.readiness_pct, 0);
  assert.equal(report.critical_bugs, true, "the current gate must fail regardless of threshold");
});

await test("malformed OpenAI tool calls are recorded as provider-side tool errors", async () => {
  const dispatched: Array<{ name: string; input: Record<string, unknown> }> = [];
  const recordingBridge = {
    dispatch: async (name: string, input: Record<string, unknown>) => {
      dispatched.push({ name, input });
      return "Error: recorded malformed provider tool call";
    },
  } as unknown as PlaywrightBridge;
  const provider = new OpenAIProvider({
    apiKey: "test-key",
    maxIterations: 2,
    maxInputTokens: 10_000,
    maxOutputTokens: 1_000,
  });
  let calls = 0;
  (provider as any).client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          if (calls === 1) {
            return {
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "malformed-1",
                        type: "function",
                        function: { name: "get_outline", arguments: "{" },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 1 },
            };
          }
          return {
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "incomplete" },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          };
        },
      },
    },
  };

  await provider.run("system", "user", recordingBridge);

  assert.deepEqual(dispatched, [
    { name: "__provider_malformed_tool_call__", input: {} },
  ]);
});

const COMPLETE_LOOKING_ASSESSMENT =
  "## Structured Assessment\n\n### Readiness Score: 95%\n\n### Critical Bugs\n\nNone.";

await test("an Anthropic max_tokens cut-off is truncated, never completed, and runs no tool", async () => {
  let calls = 0;
  let dispatches = 0;
  const countingBridge = {
    dispatch: async () => {
      dispatches++;
      return "Observed page outline";
    },
  } as unknown as PlaywrightBridge;
  const provider = new AnthropicProvider({ apiKey: "test-key", maxIterations: 5 });

  (provider as any).client = {
    messages: {
      create: async () => {
        calls++;
        return {
          content: [
            { type: "text", text: COMPLETE_LOOKING_ASSESSMENT },
            { type: "tool_use", id: "tool-1", name: "get_outline", input: {} },
          ],
          stop_reason: "max_tokens",
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    },
  };

  const result = await provider.run("system", "user", countingBridge);

  assert.equal(calls, 1);
  assert.equal(dispatches, 0, "a tool call cut off by the output cap must not run");
  assert.equal(result.executionStatus, "TRUNCATED");
  assert.equal(result.stopReason, "output_truncated");
});

await test("an OpenAI length cut-off is truncated, never completed", async () => {
  let calls = 0;
  const provider = new OpenAIProvider({ apiKey: "test-key", maxIterations: 5 });

  (provider as any).client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          return {
            choices: [
              {
                finish_reason: "length",
                message: { role: "assistant", content: COMPLETE_LOOKING_ASSESSMENT },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          };
        },
      },
    },
  };

  const result = await provider.run("system", "user", bridge);

  assert.equal(calls, 1);
  assert.equal(result.executionStatus, "TRUNCATED");
  assert.equal(result.stopReason, "output_truncated");
});

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.\n");
}
