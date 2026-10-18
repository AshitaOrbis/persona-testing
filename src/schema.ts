/**
 * Persona Testing - Type definitions
 *
 * Defines the structure of persona definitions, probe results,
 * and configuration.
 */

export interface Scenario {
  name: string;
  description: string;
  success: string;
}

export interface EvaluationCriterion {
  name: string;
  weight: "critical" | "high" | "medium" | "low";
  question: string;
}

export interface CriticalBugProtocol {
  stop_on: string[];
  continue_on: string[];
}

export interface KnownRoute {
  [label: string]: string;
}

export interface PersonaDefinition {
  name: string;
  title: string;
  experience: string;
  technical_comfort: string;
  context: string;
  goals: string[];
  scenarios: Scenario[];
  evaluation_criteria: EvaluationCriterion[];
  voice: string;
  known_routes?: KnownRoute;
  critical_bug_protocol?: CriticalBugProtocol;
}

export type Verdict = "GOOD" | "FAIR" | "POOR" | "NOT_TESTED";
export type Classification = "fixable" | "tradeoff" | "false_positive";
export type ExecutionStatus = "COMPLETED" | "BUDGET_EXHAUSTED" | "TRUNCATED";
export type StopReason =
  | "completed"
  | "max_iterations"
  | "deadline"
  | "token_budget"
  | "output_truncated";

export interface ActionableItem {
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  classification: Classification;
}

export interface CriteriaVerdict {
  [criterionName: string]: Verdict;
}

/** Machine-readable execution health for a probe run. */
export interface ToolStats {
  total_calls: number;
  errors: number;
  policy_blocks: number;
  navigation_failures: number;
}

export interface ProbeResult {
  persona: string;
  timestamp: string;
  /** Redacted URL (userinfo/query/hash stripped) — safe for reports. */
  url: string;
  readiness_pct: number;
  critical_bugs: boolean;
  criteria: CriteriaVerdict;
  items: ActionableItem[];
  screenshots: string[];
  report_markdown: string;
  report_path?: string;
  /** Parser warnings, e.g. out-of-range readiness score. */
  parse_errors?: string[];
  /** Browser tool execution health (used by `check` to flag inconclusive runs). */
  tool_stats?: ToolStats;
  /** Run ID linking this report to a run manifest. */
  run_id?: string;
  /** Provider-loop completion health; non-completed states are never gate-eligible. */
  execution_status?: ExecutionStatus;
  /** Exact completion or exhaustion cause from the provider loop. */
  stop_reason?: StopReason;
}

/** Manifest written by `run`, consumed by `check` to avoid stale reports. */
export interface RunManifest {
  run_id: string;
  created: string;
  url: string;
  reports: string[];
}

export interface ProbeConfig {
  provider: "anthropic" | "openai";
  model?: string;
  screenshot_dir?: string;
  report_dir?: string;
  api_key?: string;
  max_iterations?: number;
  /** Overall run deadline per persona, in ms (default 900000 = 15 min). */
  timeout_ms?: number;
  /** Per-API-request timeout in ms (default 120000). */
  request_timeout_ms?: number;
  /** Cumulative input-token budget per persona run (default 1000000). */
  max_input_tokens?: number;
  /** Cumulative output-token budget per persona run (default 64000). */
  max_output_tokens?: number;
  /** Extra origins the agent may navigate to (same-origin is always allowed). */
  allowed_origins?: string[];
}

export type ConfigFieldDefinition =
  | { kind: "enum"; values: readonly string[]; expected: string }
  | { kind: "non_empty_string"; expected: string }
  | { kind: "positive_integer"; expected: string }
  | { kind: "non_empty_string_array"; expected: string };

/** Runtime config shape used by validation and exhaustive schema-derived tests. */
export const CONFIG_FIELD_SCHEMA = {
  provider: {
    kind: "enum",
    values: ["anthropic", "openai"],
    expected: '"anthropic" or "openai"',
  },
  model: { kind: "non_empty_string", expected: "a non-empty string" },
  api_key: { kind: "non_empty_string", expected: "a non-empty string" },
  report_dir: { kind: "non_empty_string", expected: "a non-empty string" },
  screenshot_dir: { kind: "non_empty_string", expected: "a non-empty string" },
  max_iterations: { kind: "positive_integer", expected: "a positive integer" },
  timeout_ms: { kind: "positive_integer", expected: "a positive integer" },
  request_timeout_ms: { kind: "positive_integer", expected: "a positive integer" },
  max_input_tokens: { kind: "positive_integer", expected: "a positive integer" },
  max_output_tokens: { kind: "positive_integer", expected: "a positive integer" },
  allowed_origins: {
    kind: "non_empty_string_array",
    expected: "a list of non-empty strings",
  },
} as const satisfies Record<keyof ProbeConfig, ConfigFieldDefinition>;

/** Tool names that the AI can call for browser automation */
export type ToolName =
  | "navigate"
  | "click"
  | "type"
  | "hover"
  | "select_option"
  | "press_key"
  | "wait_for_selector"
  | "screenshot"
  | "get_outline"
  | "scroll_to_bottom"
  | "get_url";

/** A tool call from the AI model */
export interface ToolCall {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}

/** Result of executing a tool */
export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
