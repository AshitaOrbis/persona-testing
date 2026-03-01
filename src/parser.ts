/**
 * Structured output parser — extracts ProbeResult from AI markdown.
 *
 * Uses regex to parse the ## Structured Assessment block.
 * Never throws — returns partial results on parse failure.
 */

import type {
  ProbeResult,
  CriteriaVerdict,
  ActionableItem,
  Verdict,
  Classification,
} from "./schema.js";

/**
 * Parse the AI's markdown output into a structured ProbeResult.
 */
export function parseAssessment(
  markdown: string,
  persona: string,
  url: string,
): ProbeResult {
  const result: ProbeResult = {
    persona,
    timestamp: new Date().toISOString(),
    url,
    readiness_pct: 0,
    critical_bugs: false,
    criteria: {},
    items: [],
    screenshots: [],
    report_markdown: markdown,
  };

  // --- Readiness Score ---
  const readinessMatch = markdown.match(
    /###\s*Readiness\s*Score[:\s]*(\d+)\s*%/i,
  );
  if (readinessMatch) {
    result.readiness_pct = parseInt(readinessMatch[1]);
  }

  // --- Criteria Verdicts ---
  result.criteria = parseCriteriaTable(markdown);

  // --- Actionable Items ---
  result.items = parseActionableItems(markdown);

  // --- Critical Bugs ---
  result.critical_bugs = detectCriticalBugs(markdown);

  return result;
}

/**
 * Parse the criteria verdicts table.
 *
 * Expected format:
 * | Criterion Name | GOOD | Brief explanation |
 */
function parseCriteriaTable(markdown: string): CriteriaVerdict {
  const criteria: CriteriaVerdict = {};

  // Find the Criteria Verdicts section
  const sectionMatch = markdown.match(
    /###\s*Criteria\s*Verdicts?\s*\n([\s\S]*?)(?=\n###|\n##|$)/i,
  );
  if (!sectionMatch) return criteria;

  const section = sectionMatch[1];

  // Parse table rows: | Name | VERDICT | Notes |
  const rowRegex = /\|\s*([^|]+?)\s*\|\s*(GOOD|FAIR|POOR|NOT_TESTED)\s*\|\s*([^|]*?)\s*\|/gi;
  let match;
  while ((match = rowRegex.exec(section)) !== null) {
    const name = match[1].trim();
    const verdict = match[2].toUpperCase() as Verdict;
    // Skip header separator rows
    if (name === "---" || name === "Criterion" || name.startsWith("-")) continue;
    // Normalize name to snake_case key
    const key = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    criteria[key] = verdict;
  }

  return criteria;
}

/**
 * Parse actionable items from numbered list.
 *
 * Expected format:
 * 1. **[fixable]** (priority: high) Description
 * 2. **[tradeoff]** (priority: medium) Description
 */
function parseActionableItems(markdown: string): ActionableItem[] {
  const items: ActionableItem[] = [];

  // Find the Actionable Items section
  const sectionMatch = markdown.match(
    /###\s*Actionable\s*Items?\s*\n([\s\S]*?)(?=\n###|\n##|$)/i,
  );
  if (!sectionMatch) return items;

  const section = sectionMatch[1];

  // Pattern: number. **[classification]** (priority: level) description
  const itemRegex =
    /\d+\.\s*\*?\*?\[?(fixable|tradeoff|false_positive)\]?\*?\*?\s*\(?\s*priority:\s*(critical|high|medium|low)\s*\)?\s*(.+)/gi;

  let match;
  while ((match = itemRegex.exec(section)) !== null) {
    items.push({
      classification: match[1].toLowerCase() as Classification,
      priority: match[2].toLowerCase() as ActionableItem["priority"],
      description: match[3].trim(),
    });
  }

  // Fallback: try simpler numbered list if structured format wasn't found
  if (items.length === 0) {
    const simpleRegex = /\d+\.\s*(.+)/g;
    let simpleMatch;
    while ((simpleMatch = simpleRegex.exec(section)) !== null) {
      const text = simpleMatch[1].trim();
      if (!text || text.startsWith("---") || text.toLowerCase() === "none") continue;
      items.push({
        classification: guessClassification(text),
        priority: guessPriority(text),
        description: text.replace(/\*\*/g, ""),
      });
    }
  }

  return items;
}

/**
 * Detect critical bugs in the output.
 */
function detectCriticalBugs(markdown: string): boolean {
  // Check explicit "CRITICAL BUG:" markers
  if (/CRITICAL\s*BUG:/i.test(markdown)) return true;

  // Check the Critical Bugs section
  const sectionMatch = markdown.match(
    /###\s*Critical\s*Bugs?\s*\n([\s\S]*?)(?=\n###|\n##|$)/i,
  );
  if (!sectionMatch) return false;

  const section = sectionMatch[1].trim().toLowerCase();
  return section !== "none" && section !== "none." && section.length > 5;
}

// --- Heuristic helpers for fallback parsing ---

function guessClassification(text: string): Classification {
  const lower = text.toLowerCase();
  if (
    lower.includes("css") ||
    lower.includes("label") ||
    lower.includes("navigation") ||
    lower.includes("link") ||
    lower.includes("button") ||
    lower.includes("text") ||
    lower.includes("color") ||
    lower.includes("spacing")
  ) {
    return "fixable";
  }
  if (
    lower.includes("feature") ||
    lower.includes("architecture") ||
    lower.includes("redesign") ||
    lower.includes("model")
  ) {
    return "tradeoff";
  }
  return "fixable";
}

function guessPriority(text: string): ActionableItem["priority"] {
  const lower = text.toLowerCase();
  if (lower.includes("critical") || lower.includes("broken") || lower.includes("crash")) {
    return "critical";
  }
  if (lower.includes("important") || lower.includes("missing") || lower.includes("cannot")) {
    return "high";
  }
  if (lower.includes("minor") || lower.includes("nice to") || lower.includes("could")) {
    return "low";
  }
  return "medium";
}
