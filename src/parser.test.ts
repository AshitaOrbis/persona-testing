/**
 * Parser tests — validates structured output extraction from AI markdown.
 *
 * Run: npm test
 * Or:  claude -p "run the parser tests in persona-testing"
 */

import assert from "node:assert/strict";
import { parseAssessment } from "./parser.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Test data: realistic water-director style markdown output
// ---------------------------------------------------------------------------

const FULL_ASSESSMENT = `
# Evaluation Report: Sarah Martinez

I navigated to the application and began my evaluation as Sarah Martinez, a water utility director preparing for a rate increase proposal.

## First Impressions

The dashboard loaded quickly and showed a clean layout. I could see revenue projections immediately. The terminology was mostly clear, though "DSCR" confused me initially.

## What Worked

- Scenario creation was intuitive
- Charts rendered correctly
- The executive summary page was professional

## What Didn't Work

- Export to PDF was not discoverable
- The DSCR calculator was buried in a submenu
- No help tooltips on financial terms

---

## Structured Assessment

### Readiness Score: 65%

### Criteria Verdicts

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| Onboarding Clarity | GOOD | Dashboard guided me well |
| Terminology | FAIR | Some financial terms unexplained |
| Presentation Ready | POOR | Export options hard to find |
| Data Accuracy | NOT_TESTED | Could not verify calculations |

### Actionable Items

1. **[fixable]** (priority: high) Export button not discoverable from main dashboard
2. **[fixable]** (priority: medium) No tooltips on financial terms like DSCR, debt coverage ratio
3. **[tradeoff]** (priority: medium) No chart customization for council presentations
4. **[fixable]** (priority: low) Minor spacing issue in the sidebar navigation
5. **[false_positive]** (priority: low) Initially thought settings were missing but found them under profile menu

### Critical Bugs

None

### Summary

The application shows promise for utility directors like me. The core scenario creation workflow is solid, and the dashboard provides a good overview. However, I struggled to find the export functionality, which is critical for my council presentations. The financial terminology needs more explanation for someone who isn't a finance specialist. With some navigation improvements and help tooltips, this could replace my Excel workflow.
`;

const CRITICAL_BUG_ASSESSMENT = `
## Structured Assessment

### Readiness Score: 15%

### Criteria Verdicts

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| Onboarding Clarity | POOR | Page crashed on load |
| Data Loading | POOR | API returned 500 errors |

### Actionable Items

1. **[fixable]** (priority: critical) Dashboard fails to render when no scenarios exist
2. **[fixable]** (priority: critical) API returns 500 on /scenarios endpoint

### Critical Bugs

The dashboard completely fails to render when there are no scenarios. This is a blocking issue — new users will see a blank white screen with a JavaScript error in the console. The /scenarios API endpoint returns HTTP 500 intermittently.

### Summary

I cannot evaluate this application. Critical bugs prevent basic usage.
`;

const MINIMAL_ASSESSMENT = `
I looked at the app. It was okay I guess.

### Readiness Score: 50%

Some things worked, some didn't.
`;

const NO_STRUCTURED_BLOCK = `
I navigated the app and found it generally usable. The onboarding was clear,
but I had trouble with the export feature. Overall, I'd give it a B minus.
There were no major issues but several minor frustrations.
`;

const INLINE_CRITICAL_BUG = `
## Structured Assessment

### Readiness Score: 30%

CRITICAL BUG: The entire application crashes when clicking the settings button.

### Criteria Verdicts

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| Stability | POOR | Crashes on settings |

### Critical Bugs

None

### Summary

Application is unstable.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\nParser Tests\n");

console.log("Readiness Score:");
test("extracts readiness percentage from full assessment", () => {
  const result = parseAssessment(FULL_ASSESSMENT, "Sarah Martinez", "https://app.example.com");
  assert.equal(result.readiness_pct, 65);
});

test("extracts low readiness from critical bug assessment", () => {
  const result = parseAssessment(CRITICAL_BUG_ASSESSMENT, "Test User", "https://app.example.com");
  assert.equal(result.readiness_pct, 15);
});

test("extracts readiness from minimal assessment", () => {
  const result = parseAssessment(MINIMAL_ASSESSMENT, "Test User", "https://app.example.com");
  assert.equal(result.readiness_pct, 50);
});

test("defaults to 0 when no readiness found", () => {
  const result = parseAssessment(NO_STRUCTURED_BLOCK, "Test User", "https://app.example.com");
  assert.equal(result.readiness_pct, 0);
});

console.log("\nCriteria Verdicts:");
test("extracts all four verdicts from full assessment", () => {
  const result = parseAssessment(FULL_ASSESSMENT, "Sarah Martinez", "https://app.example.com");
  assert.equal(Object.keys(result.criteria).length, 4);
  assert.equal(result.criteria["onboarding_clarity"], "GOOD");
  assert.equal(result.criteria["terminology"], "FAIR");
  assert.equal(result.criteria["presentation_ready"], "POOR");
  assert.equal(result.criteria["data_accuracy"], "NOT_TESTED");
});

test("extracts verdicts from critical bug assessment", () => {
  const result = parseAssessment(CRITICAL_BUG_ASSESSMENT, "Test User", "https://app.example.com");
  assert.equal(result.criteria["onboarding_clarity"], "POOR");
  assert.equal(result.criteria["data_loading"], "POOR");
});

test("returns empty criteria when no table found", () => {
  const result = parseAssessment(NO_STRUCTURED_BLOCK, "Test User", "https://app.example.com");
  assert.equal(Object.keys(result.criteria).length, 0);
});

console.log("\nActionable Items:");
test("extracts all five items with correct classifications", () => {
  const result = parseAssessment(FULL_ASSESSMENT, "Sarah Martinez", "https://app.example.com");
  assert.equal(result.items.length, 5);

  assert.equal(result.items[0].classification, "fixable");
  assert.equal(result.items[0].priority, "high");
  assert.ok(result.items[0].description.includes("Export button"));

  assert.equal(result.items[1].classification, "fixable");
  assert.equal(result.items[1].priority, "medium");

  assert.equal(result.items[2].classification, "tradeoff");
  assert.equal(result.items[2].priority, "medium");

  assert.equal(result.items[3].classification, "fixable");
  assert.equal(result.items[3].priority, "low");

  assert.equal(result.items[4].classification, "false_positive");
  assert.equal(result.items[4].priority, "low");
});

test("extracts critical priority items", () => {
  const result = parseAssessment(CRITICAL_BUG_ASSESSMENT, "Test User", "https://app.example.com");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].priority, "critical");
  assert.equal(result.items[1].priority, "critical");
});

test("returns empty items when no structured block", () => {
  const result = parseAssessment(NO_STRUCTURED_BLOCK, "Test User", "https://app.example.com");
  assert.equal(result.items.length, 0);
});

console.log("\nCritical Bugs:");
test("no critical bugs in full assessment", () => {
  const result = parseAssessment(FULL_ASSESSMENT, "Sarah Martinez", "https://app.example.com");
  assert.equal(result.critical_bugs, false);
});

test("detects critical bugs from section content", () => {
  const result = parseAssessment(CRITICAL_BUG_ASSESSMENT, "Test User", "https://app.example.com");
  assert.equal(result.critical_bugs, true);
});

test("detects inline CRITICAL BUG: marker", () => {
  const result = parseAssessment(INLINE_CRITICAL_BUG, "Test User", "https://app.example.com");
  assert.equal(result.critical_bugs, true);
});

test("no critical bugs from unstructured text", () => {
  const result = parseAssessment(NO_STRUCTURED_BLOCK, "Test User", "https://app.example.com");
  assert.equal(result.critical_bugs, false);
});

console.log("\nMetadata:");
test("sets persona name correctly", () => {
  const result = parseAssessment(FULL_ASSESSMENT, "Sarah Martinez", "https://app.example.com");
  assert.equal(result.persona, "Sarah Martinez");
});

test("sets URL correctly", () => {
  const result = parseAssessment(FULL_ASSESSMENT, "Sarah Martinez", "https://app.example.com");
  assert.equal(result.url, "https://app.example.com");
});

test("sets timestamp as ISO string", () => {
  const result = parseAssessment(FULL_ASSESSMENT, "Sarah Martinez", "https://app.example.com");
  assert.ok(result.timestamp.match(/^\d{4}-\d{2}-\d{2}T/));
});

test("preserves full markdown in report_markdown", () => {
  const result = parseAssessment(FULL_ASSESSMENT, "Sarah Martinez", "https://app.example.com");
  assert.ok(result.report_markdown.includes("Evaluation Report"));
  assert.ok(result.report_markdown.includes("Structured Assessment"));
});

test("initializes screenshots as empty array", () => {
  const result = parseAssessment(FULL_ASSESSMENT, "Sarah Martinez", "https://app.example.com");
  assert.deepEqual(result.screenshots, []);
});

console.log("\nGraceful Degradation:");
test("never throws on empty input", () => {
  const result = parseAssessment("", "Empty", "https://example.com");
  assert.equal(result.readiness_pct, 0);
  assert.equal(result.critical_bugs, false);
  assert.equal(result.items.length, 0);
  assert.equal(Object.keys(result.criteria).length, 0);
});

test("never throws on garbage input", () => {
  const result = parseAssessment("🗑️💥\n\n|||---|||", "Garbage", "https://example.com");
  assert.equal(result.readiness_pct, 0);
  assert.equal(result.critical_bugs, false);
});

test("partial parse returns what it can", () => {
  const result = parseAssessment(MINIMAL_ASSESSMENT, "Minimal", "https://example.com");
  assert.equal(result.readiness_pct, 50);
  assert.equal(result.items.length, 0);
  assert.equal(Object.keys(result.criteria).length, 0);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.\n");
}
