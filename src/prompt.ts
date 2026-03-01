/**
 * System prompt builder — constructs the AI system prompt from a PersonaDefinition.
 *
 * The prompt tells the AI who it is, what it's evaluating, and what structured
 * output to produce. Mirrors the pattern from SourceCashflow's water-director agents.
 */

import type { PersonaDefinition } from "./schema.js";

export function buildSystemPrompt(persona: PersonaDefinition, url: string): string {
  const sections: string[] = [];

  // --- Identity ---
  sections.push(`# You are ${persona.name}

**Title:** ${persona.title}
**Experience:** ${persona.experience}
**Technical Comfort:** ${persona.technical_comfort}

You are testing a web application at ${url}. You will navigate it using browser tools, evaluating it entirely from your persona's perspective. You do NOT know the app's code or architecture — only what a real user in your role would know.`);

  // --- Context ---
  if (persona.context) {
    sections.push(`## Your Situation

${persona.context.trim()}`);
  }

  // --- Goals ---
  if (persona.goals?.length) {
    const goalsList = persona.goals.map((g, i) => `${i + 1}. ${g}`).join("\n");
    sections.push(`## Your Goals

${goalsList}`);
  }

  // --- Scenarios ---
  if (persona.scenarios?.length) {
    const scenarioBlocks = persona.scenarios
      .map(
        (s, i) => `### Scenario ${i + 1}: ${s.name}
**Task:** ${s.description}
**Success:** ${s.success}`,
      )
      .join("\n\n");
    sections.push(`## Scenarios to Evaluate

Work through each scenario in order. For each, describe what you tried, what happened, and whether the success criterion was met.

${scenarioBlocks}`);
  }

  // --- Evaluation Criteria ---
  if (persona.evaluation_criteria?.length) {
    const criteriaRows = persona.evaluation_criteria
      .map((c) => `| ${c.name} | ${c.weight} | ${c.question} |`)
      .join("\n");
    sections.push(`## Evaluation Criteria

Rate each criterion as GOOD, FAIR, POOR, or NOT_TESTED:

| Criterion | Weight | Question |
|-----------|--------|----------|
${criteriaRows}`);
  }

  // --- Voice ---
  if (persona.voice) {
    sections.push(`## Voice

${persona.voice.trim()}`);
  }

  // --- Known Routes ---
  if (persona.known_routes && Object.keys(persona.known_routes).length > 0) {
    const routeRows = Object.entries(persona.known_routes)
      .map(([label, path]) => `| ${label} | ${path} |`)
      .join("\n");
    sections.push(`## Known Routes

These routes are known to exist. Use them if relevant:

| Feature | Path |
|---------|------|
${routeRows}`);
  }

  // --- Critical Bug Protocol ---
  if (persona.critical_bug_protocol) {
    const stopOn = Array.isArray(persona.critical_bug_protocol.stop_on)
      ? persona.critical_bug_protocol.stop_on.join(", ")
      : persona.critical_bug_protocol.stop_on;
    const continueOn = Array.isArray(persona.critical_bug_protocol.continue_on)
      ? persona.critical_bug_protocol.continue_on.join(", ")
      : persona.critical_bug_protocol.continue_on;
    sections.push(`## Critical Bug Protocol

**STOP testing immediately if:** ${stopOn}
**Continue despite:** ${continueOn}

If you encounter a critical bug, say "CRITICAL BUG:" followed by the description, then stop.`);
  }

  // --- Structured Output ---
  sections.push(`## Required Output Format

After completing your evaluation, produce a structured assessment using EXACTLY this format:

## Structured Assessment

### Readiness Score: X%

Where X is 0-100 representing how ready this app is for your use case.

### Criteria Verdicts

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| Criterion Name | GOOD/FAIR/POOR/NOT_TESTED | Brief explanation |

### Actionable Items

List each finding as a numbered item:

1. **[fixable]** (priority: high) Description of the issue
2. **[tradeoff]** (priority: medium) Description requiring design decision
3. **[false_positive]** (priority: low) Misunderstanding that was resolved

### Critical Bugs

State "None" or describe each critical bug found.

### Summary

2-3 paragraph narrative from your persona's perspective.`);

  // --- Behavioral Instructions ---
  sections.push(`## Browser Interaction Guidelines

- Use **text=** and **role=** selectors when possible (more resilient than CSS)
- Use **get_outline** to understand page structure before clicking blindly
- Use **get_outline** sparingly — once per major page change is enough
- Take **screenshots** at key moments: first load, completed workflows, errors
- When a selector fails, try alternative selectors or use get_outline to find the right one
- Navigate naturally — don't skip ahead unless you've tried the normal flow first`);

  return sections.join("\n\n---\n\n");
}

/**
 * Build the initial user message that kicks off the probe.
 */
export function buildUserMessage(url: string): string {
  return `Please begin your evaluation. Start by navigating to ${url} and getting an overview of what you see. Then work through each scenario systematically. End with the Structured Assessment.`;
}
