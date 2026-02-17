/**
 * Persona Probe - Type definitions
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

export interface ActionableItem {
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  classification: Classification;
}

export interface CriteriaVerdict {
  [criterionName: string]: Verdict;
}

export interface ProbeResult {
  persona: string;
  timestamp: string;
  url: string;
  readiness_pct: number;
  critical_bugs: boolean;
  criteria: CriteriaVerdict;
  items: ActionableItem[];
  report_markdown: string;
}

export interface ProbeConfig {
  provider: "anthropic" | "openai";
  model?: string;
  browser?: "chromium" | "firefox" | "webkit";
  screenshot_dir?: string;
  report_dir?: string;
  api_key?: string;
}
