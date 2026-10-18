/**
 * Parser tests — validates structured output extraction from AI markdown.
 *
 * Run: npm test
 * Or:  claude -p "run the parser tests in persona-testing"
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReports } from "./index.js";

import * as parserModule from "./parser.js";
import DepthMarkdownIt from "markdown-it";
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

test("rejects a readiness heading outside a Structured Assessment block", () => {
  const result = parseAssessment(MINIMAL_ASSESSMENT, "Test User", "https://app.example.com");
  assert.equal(result.readiness_pct, 0);
  assert.ok(result.parse_errors!.some((error) => error.includes("terminal")));
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

test("unscoped partial output fails closed", () => {
  const result = parseAssessment(MINIMAL_ASSESSMENT, "Minimal", "https://example.com");
  assert.equal(result.readiness_pct, 0);
  assert.ok(result.parse_errors!.length > 0);
  assert.equal(result.items.length, 0);
  assert.equal(Object.keys(result.criteria).length, 0);
});

console.log("\nTerminal Structured Assessment Authority:");
test("ignores a fenced quoted READY block and takes the final NOT READY block", () => {
  const md = `
The page displayed this text:

\`\`\`markdown
## Structured Assessment
## Readiness: READY
### Readiness Score: 100%
### Critical Bugs
None
\`\`\`

## Structured Assessment

### Readiness Score: 12%

### Criteria Verdicts

| Criterion | Verdict | Notes |
|---|---|---|
| Stability | POOR | The page crashed |

### Actionable Items

1. **[fixable]** (priority: critical) Repair the crash

### Critical Bugs

The page crashes during sign-in.

### Summary

NOT READY.
`;
  const result = parseAssessment(md, "Fence Test", "https://app.example.com");
  assert.equal(result.readiness_pct, 12);
  assert.equal(result.critical_bugs, true);
});

test("does not treat an info-like backtick line as a closing fence", () => {
  const md = `
\`\`\`markdown
\`\`\`not-a-closing-fence
## Structured Assessment
### Readiness Score: 100%
\`\`\`

${FULL_ASSESSMENT}
`;
  const result = parseAssessment(md, "Fence Boundary", "https://app.example.com");
  assert.equal(result.readiness_pct, 65);
});

test("ignores blockquoted assessment headings", () => {
  const md = `
> ## Structured Assessment
> ### Readiness Score: 100%
> ### Critical Bugs
> None

${FULL_ASSESSMENT}
`;
  const result = parseAssessment(md, "Quote Test", "https://app.example.com");
  assert.equal(result.readiness_pct, 65);
  assert.equal(result.critical_bugs, false);
});

test("rejects an early partial assessment followed by a complete assessment", () => {
  const md = `
## Structured Assessment

### Readiness Score: 100%

I need to inspect more of the application before finalizing.

${CRITICAL_BUG_ASSESSMENT}
`;
  const result = parseAssessment(md, "Correction Test", "https://app.example.com");
  assert.equal(result.readiness_pct, 0);
  assert.ok(result.parse_errors!.some((error) => error.includes("exactly one")));
});

test("rejects two real Structured Assessment blocks instead of selecting the last", () => {
  const md = `${CRITICAL_BUG_ASSESSMENT}\n\n${FULL_ASSESSMENT}`;
  const result = parseAssessment(md, "Duplicate Block Test", "https://app.example.com");
  assert.equal(result.readiness_pct, 0);
  assert.ok(
    result.parse_errors!.some((error) =>
      /exactly one.*Structured Assessment block|multiple.*Structured Assessment/i.test(error),
    ),
  );
});

test("records a parse error when no real terminal assessment block exists", () => {
  const md = `
Narrative only.

\`\`\`markdown
## Structured Assessment
### Readiness Score: 100%
\`\`\`
`;
  const result = parseAssessment(md, "Missing Test", "https://app.example.com");
  assert.equal(result.readiness_pct, 0);
  assert.ok(result.parse_errors!.some((error) => error.includes("terminal")));
});

test("rejects multiple readiness fields inside the terminal block", () => {
  const md = FULL_ASSESSMENT.replace(
    "### Readiness Score: 65%",
    "### Readiness Score: 65%\n\n### Readiness Score: 100%",
  );
  const result = parseAssessment(md, "Duplicate Test", "https://app.example.com");
  assert.equal(result.readiness_pct, 0);
  assert.ok(result.parse_errors!.some((error) => error.includes("exactly one readiness")));
});

console.log("\nReadiness Score Bounds:");
test("rejects out-of-range readiness score (999%) and records parse error", () => {
  const md = FULL_ASSESSMENT.replace("Readiness Score: 65%", "Readiness Score: 999%");
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.equal(result.readiness_pct, 0);
  assert.ok(result.parse_errors && result.parse_errors.length > 0);
  assert.ok(result.parse_errors![0].includes("999"));
});

test("accepts boundary readiness scores 0 and 100", () => {
  const zero = parseAssessment(
    FULL_ASSESSMENT.replace("Readiness Score: 65%", "Readiness Score: 0%"),
    "T",
    "https://x.example",
  );
  assert.equal(zero.readiness_pct, 0);
  assert.equal(zero.parse_errors!.length, 0);
  const hundred = parseAssessment(
    FULL_ASSESSMENT.replace("Readiness Score: 65%", "Readiness Score: 100%"),
    "T",
    "https://x.example",
  );
  assert.equal(hundred.readiness_pct, 100);
  assert.equal(hundred.parse_errors!.length, 0);
});

console.log("\nCritical Bugs Negative Forms:");
const negativeForms = [
  "None",
  "None.",
  "none",
  "No critical bugs found.",
  "No critical bugs",
  "No critical bugs were found.",
  "None observed.",
  "None encountered",
  "- None",
  "* None",
  "**None**",
  "N/A",
  "Nothing critical",
  "No issues.",
  "No issues found",
  "No problems detected",
  "None to report",
  "No blocking bugs",
];
for (const form of negativeForms) {
  test(`treats "${form.replace(/\n/g, "\\n")}" as no critical bugs`, () => {
    const md = `## Structured Assessment\n\n### Critical Bugs\n\n${form}\n\n### Summary\n\nFine.`;
    const result = parseAssessment(md, "Test User", "https://app.example.com");
    assert.equal(result.critical_bugs, false);
  });
}

test("still detects real critical bug descriptions", () => {
  const md =
    "## Structured Assessment\n\n### Critical Bugs\n\nThe dashboard crashes on load with a blank screen.\n\n### Summary\n\nBroken.";
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.equal(result.critical_bugs, true);
});

test("detects bulleted real critical bug", () => {
  const md =
    "## Structured Assessment\n\n### Critical Bugs\n\n- Login form returns HTTP 500 on every submission\n\n### Summary\n\nBroken.";
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.equal(result.critical_bugs, true);
});

// ---------------------------------------------------------------------------
// One heading grammar: the sections the validator counts are the sections
// that are read. A heading the validator accepts but an extractor misses
// would let a critical bug pass the CI gate with no parse error.
// ---------------------------------------------------------------------------

const CLOSING_HASH_ASSESSMENT = [
  "## Structured Assessment",
  "",
  "### Readiness Score: 90% ###",
  "",
  "### Criteria Verdicts ###",
  "",
  "| Criterion | Verdict | Notes |",
  "|-----------|---------|-------|",
  "| Data Integrity | GOOD | Saved records reloaded intact. |",
  "",
  "### Actionable Items ###",
  "",
  "1. **[fixable]** (priority: high) Persist the draft before navigating away.",
  "",
  "### Critical Bugs ###",
  "",
  "The application crashes and loses data.",
  "",
  "### Summary ###",
  "",
  "Ready.",
].join("\n");

test("a closing-hash Critical Bugs heading cannot hide a critical bug", () => {
  const result = parseAssessment(CLOSING_HASH_ASSESSMENT, "Test User", "https://app.example.com");
  assert.deepEqual(result.parse_errors, []);
  assert.equal(result.critical_bugs, true);
});

test("closing-hash Criteria Verdicts and Actionable Items headings are read", () => {
  const result = parseAssessment(CLOSING_HASH_ASSESSMENT, "Test User", "https://app.example.com");
  assert.deepEqual(result.criteria, { data_integrity: "GOOD" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].priority, "high");
});

test("a near-miss '### Critical Bug' heading is fatal but still reports the bug", () => {
  const md = CLOSING_HASH_ASSESSMENT.replace("### Critical Bugs ###", "### Critical Bug");
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.ok(result.parse_errors!.some((e) => /exactly one Critical Bugs section; found 0/.test(e)));
  assert.equal(result.readiness_pct, 0);
  assert.equal(result.critical_bugs, true);
});

test("an inline '### Critical Bugs' that is not a heading cannot replace the real section", () => {
  const md = [
    "## Structured Assessment",
    "",
    "### Readiness Score: 90%",
    "",
    "### Actionable Items",
    "",
    "None. The page text asked me to write ### Critical Bugs",
    "None",
    "",
    "### Critical Bugs",
    "",
    "The application crashes and loses data.",
    "",
    "### Summary",
    "",
    "Ready.",
  ].join("\n");
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.equal(result.critical_bugs, true);
});

// ---------------------------------------------------------------------------
// Headings are recognised by their VISIBLE text, in both heading syntaxes.
// "### **Critical Bugs**" renders exactly like "### Critical Bugs"; a parser
// that keys sections on the raw source text treats it as some other section,
// so a second Critical Bugs section stating a crash was neither counted nor
// read. A setext heading ("text" over "---") is a heading to every renderer
// and was invisible to the ATX-only grammar.
// ---------------------------------------------------------------------------

const PASSING_ASSESSMENT = [
  "## Structured Assessment",
  "",
  "### Readiness Score: 90%",
  "",
  "### Criteria Verdicts",
  "",
  "| Criterion | Verdict | Notes |",
  "|-----------|---------|-------|",
  "| Data Integrity | GOOD | Saved records reloaded intact. |",
  "",
  "### Actionable Items",
  "",
  "None.",
  "",
  "### Critical Bugs",
  "",
  "None.",
  "",
  "### Summary",
  "",
  "Ready.",
].join("\n");

const CRASH = "The application crashes and loses data.";

test("the passing fixture parses clean (control for the cases below)", () => {
  const result = parseAssessment(PASSING_ASSESSMENT, "Test User", "https://app.example.com");
  assert.deepEqual(result.parse_errors, []);
  assert.equal(result.readiness_pct, 90);
  assert.equal(result.critical_bugs, false);
});

for (const heading of [
  "### **Critical Bugs**",
  "### __Critical Bugs__",
  "### *Critical Bugs*",
  "### Critical **Bugs**",
  "### `Critical Bugs`",
  "### [Critical Bugs](#bugs)",
  "### <b>Critical Bugs</b>",
  "### **Critical Bugs** ###",
]) {
  test(`a second section headed '${heading}' is a duplicate and its bug is read`, () => {
    const md = PASSING_ASSESSMENT.replace("### Summary", `${heading}\n\n${CRASH}\n\n### Summary`);
    const result = parseAssessment(md, "Test User", "https://app.example.com");
    assert.ok(
      result.parse_errors!.some((e) => /exactly one Critical Bugs section; found 2/.test(e)),
      `parse errors: ${JSON.stringify(result.parse_errors)}`,
    );
    assert.equal(result.readiness_pct, 0);
    assert.equal(result.critical_bugs, true);
  });
}

test("an emphasis-wrapped heading in place of the canonical one is read as that section", () => {
  const clean = PASSING_ASSESSMENT.replace("### Critical Bugs", "### **Critical Bugs**");
  const ok = parseAssessment(clean, "Test User", "https://app.example.com");
  assert.deepEqual(ok.parse_errors, []);
  assert.equal(ok.critical_bugs, false);
  const buggy = clean.replace("### **Critical Bugs**\n\nNone.", `### **Critical Bugs**\n\n${CRASH}`);
  assert.notEqual(buggy, clean);
  assert.equal(parseAssessment(buggy, "Test User", "https://app.example.com").critical_bugs, true);
});

// Visible-text normalisation covers the markup a model plausibly writes; it
// cannot enumerate every rendering trick (an entity, a zero-width character, a
// look-alike letter). So any level-three heading inside the assessment that is
// not one of the format's five sections is itself fatal.
for (const [label, heading] of [
  ["an entity space", "### Critical&#32;Bugs"],
  ["a zero-width space", "### Critical​Bugs"],
  ["a Cyrillic look-alike letter", "### Сritical Bugs"],
  ["an unrelated name", "### Critical Issues"],
] as const) {
  test(`a second section whose heading uses ${label} is fatal`, () => {
    const md = PASSING_ASSESSMENT.replace("### Summary", `${heading}\n\n${CRASH}\n\n### Summary`);
    const result = parseAssessment(md, "Test User", "https://app.example.com");
    assert.ok(
      result.parse_errors!.some((e) => /section the format does not define/.test(e)),
      `parse errors: ${JSON.stringify(result.parse_errors)}`,
    );
    assert.equal(result.readiness_pct, 0);
  });
}

test("an extra level-three section inside the assessment is fatal; deeper headings are not", () => {
  const extra = PASSING_ASSESSMENT.replace("### Summary", "### Notes\n\nNothing else.\n\n### Summary");
  const result = parseAssessment(extra, "Test User", "https://app.example.com");
  assert.ok(result.parse_errors!.some((e) => /section the format does not define: "notes"/.test(e)));
  assert.equal(result.readiness_pct, 0);
  const deeper = PASSING_ASSESSMENT.replace("Ready.", "Ready.\n\n#### Detail\n\nAll flows completed.");
  assert.deepEqual(parseAssessment(deeper, "Test User", "https://app.example.com").parse_errors, []);
});

test("an emphasis-wrapped duplicate of another required section is fatal", () => {
  const md = PASSING_ASSESSMENT.replace("### Summary", "### **Summary**\n\nAlso ready.\n\n### Summary");
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.ok(result.parse_errors!.some((e) => /exactly one Summary section; found 2/.test(e)));
  assert.equal(result.readiness_pct, 0);
});

test("an emphasis-wrapped second readiness score is a duplicate, not ignored", () => {
  const md = PASSING_ASSESSMENT.replace(
    "### Readiness Score: 90%",
    "### Readiness Score: 90%\n\n### **Readiness Score: 10%**",
  );
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.ok(result.parse_errors!.some((e) => /exactly one readiness score; found 2/.test(e)));
  assert.equal(result.readiness_pct, 0);
});

test("an emphasis-wrapped sole readiness score is read", () => {
  const md = PASSING_ASSESSMENT.replace("### Readiness Score: 90%", "### **Readiness Score: 90%**");
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.deepEqual(result.parse_errors, []);
  assert.equal(result.readiness_pct, 90);
});

test("an emphasis-wrapped earlier '## **Structured Assessment**' counts as a second block", () => {
  const early = PASSING_ASSESSMENT.replace("## Structured Assessment", "## **Structured Assessment**")
    .replace("### Critical Bugs\n\nNone.", `### Critical Bugs\n\n${CRASH}`);
  const md = `${early}\n\nI then re-checked.\n\n${PASSING_ASSESSMENT}`;
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.ok(result.parse_errors!.some((e) => /exactly one real terminal ## Structured Assessment block; found 2/.test(e)));
  assert.equal(result.readiness_pct, 0);
});

test("an earlier SETEXT 'Structured Assessment' block counts as a second block", () => {
  const setext = PASSING_ASSESSMENT.replace("## Structured Assessment", "Structured Assessment\n---------------------")
    .replace("### Critical Bugs\n\nNone.", `### Critical Bugs\n\n${CRASH}`);
  const md = `${setext}\n\nI then re-checked.\n\n${PASSING_ASSESSMENT}`;
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.ok(
    result.parse_errors!.some((e) => /exactly one real terminal ## Structured Assessment block; found 2/.test(e)),
    `parse errors: ${JSON.stringify(result.parse_errors)}`,
  );
  assert.equal(result.readiness_pct, 0);
});

test("a level-one setext or ATX 'Structured Assessment' also counts", () => {
  for (const early of ["Structured Assessment\n=====================", "# Structured Assessment"]) {
    const md = `${early}\n\n### Critical Bugs\n\n${CRASH}\n\n${PASSING_ASSESSMENT}`;
    const result = parseAssessment(md, "Test User", "https://app.example.com");
    assert.ok(
      result.parse_errors!.some((e) => /found 2/.test(e)),
      `${early}: ${JSON.stringify(result.parse_errors)}`,
    );
    assert.equal(result.readiness_pct, 0);
  }
});

test("a sole setext 'Structured Assessment' heading is rejected, not read", () => {
  const md = PASSING_ASSESSMENT.replace("## Structured Assessment", "Structured Assessment\n---------------------");
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.ok(result.parse_errors!.length > 0);
  assert.equal(result.readiness_pct, 0);
});

test("a setext heading after the assessment makes it non-terminal", () => {
  for (const later of [`Critical Bugs\n-------------\n\n${CRASH}`, "Appendix\n========\n\nMore notes."]) {
    const md = `${PASSING_ASSESSMENT}\n\n${later}`;
    const result = parseAssessment(md, "Test User", "https://app.example.com");
    assert.ok(result.parse_errors!.length > 0, `${later}: no parse error`);
    assert.equal(result.readiness_pct, 0);
  }
});

test("a multi-line setext heading's text is the whole paragraph", () => {
  const md = `Structured\nAssessment\n----------\n\n### Critical Bugs\n\n${CRASH}\n\n${PASSING_ASSESSMENT}`;
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.ok(result.parse_errors!.some((e) => /found 2/.test(e)), JSON.stringify(result.parse_errors));
});

test("thematic breaks, table rulers and fenced/quoted underlines are not headings", () => {
  const md = [
    "# Evaluation",
    "",
    "Some findings.",
    "",
    "---",
    "",
    "```",
    "Structured Assessment",
    "---------------------",
    "```",
    "",
    "> Structured Assessment",
    "> ---------------------",
    "",
    "***",
    "---",
    "",
    PASSING_ASSESSMENT,
    "",
    "---",
    "- - -",
  ].join("\n");
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.deepEqual(result.parse_errors, []);
  assert.equal(result.readiness_pct, 90);
  assert.deepEqual(result.criteria, { data_integrity: "GOOD" });
});

// ---------------------------------------------------------------------------
// Only a recognised negative declaration means "no critical bugs". The old
// rule also accepted any content of five characters or fewer, so a section
// reading just "Crash" passed; an empty section passed too.
// ---------------------------------------------------------------------------

for (const content of ["Crash", "Yes", "Bug", "Error", "TBD", "x", "-", ""]) {
  test(`a Critical Bugs section reading ${JSON.stringify(content)} is not a negative declaration`, () => {
    const md = PASSING_ASSESSMENT.replace("### Critical Bugs\n\nNone.", `### Critical Bugs\n\n${content}`);
    const result = parseAssessment(md, "Test User", "https://app.example.com");
    assert.equal(result.critical_bugs, true);
  });
}

// ---------------------------------------------------------------------------
// An assessment is counted wherever a reader would SEE one. Heading text was
// matched after removing the markup a model plausibly writes, so a heading that
// renders as "Structured Assessment" through an entity, a reference link, a
// zero-width or look-alike character, an HTML heading or a bare bold line was
// not counted: an earlier crash-bearing assessment beside the real one parsed
// as readiness 90 with no error. Every heading, line and paragraph of the report
// is now compared by its letters alone, and a look-alike letter still counts.
// ---------------------------------------------------------------------------

function earlierAssessment(heading: string): string {
  const early = PASSING_ASSESSMENT.replace("## Structured Assessment", heading)
    .replace("### Critical Bugs\n\nNone.", `### Critical Bugs\n\n${CRASH}`);
  return `${early}\n\n[sa]: #structured-assessment\n\nI then re-checked.\n\n${PASSING_ASSESSMENT}`;
}

for (const [label, heading] of [
  ["a decimal entity", "## Structured&#32;Assessment"],
  ["a hexadecimal entity", "## Structured&#x20;Assessment"],
  ["a named entity", "## Structured&nbsp;Assessment"],
  ["a named-entity look-alike letter", "## Structured &Alpha;ssessment"],
  ["mathematical bold letters", "## \u{1d412}\u{1d42d}\u{1d42b}\u{1d42e}\u{1d41c}\u{1d42d}\u{1d42e}\u{1d42b}\u{1d41e}\u{1d41d} Assessment"],
  ["an entity over a setext underline", "Structured&#32;Assessment\n---------------------"],
  ["a full reference link", "## [Structured Assessment][sa]"],
  ["a collapsed reference link", "## [Structured Assessment][]"],
  ["a shortcut reference link", "## [Structured Assessment]"],
  ["a reference link on a bold line", "**[Structured Assessment][sa]**"],
  ["a backslash hard break in a setext heading", "Structured\\\nAssessment\n----------"],
  ["a zero-width space", "## Structured\u200bAssessment"],
  ["a soft hyphen", "## Struc\u00adtured Assessment"],
  ["a blank-rendering Hangul filler", "## Structured\u3164Assessment"],
  ["a Cyrillic look-alike letter", "## Structured \u0410ssessment"],
  ["fullwidth letters", "## \uff33tructured Assessment"],
  ["an HTML heading", "<h2>Structured Assessment</h2>"],
  ["a bold line", "**Structured Assessment**"],
  ["a level-three heading", "### Structured Assessment"],
] as const) {
  test(`an earlier assessment headed with ${label} counts as a second block`, () => {
    const result = parseAssessment(earlierAssessment(heading), "Test User", "https://app.example.com");
    assert.ok(
      result.parse_errors!.some((e) => /Structured Assessment block; found 2/.test(e)),
      `parse errors: ${JSON.stringify(result.parse_errors)}`,
    );
    assert.equal(result.readiness_pct, 0);
  });
}

// A bidirectional override renders reversed source text the right way round,
// so no letter comparison can see it; outside code and quotes it is fatal.
for (const [label, md] of [
  ["an earlier assessment heading", earlierAssessment("## \u202etnemssessA derutcurtS\u202c")],
  ["a heading under Summary", PASSING_ASSESSMENT.replace("Ready.", `Ready.\n\n#### \u2067sguB lacitirC\u2069\n\n${CRASH}`)],
] as const) {
  test(`a bidirectional override in ${label} is fatal`, () => {
    const result = parseAssessment(md, "Test User", "https://app.example.com");
    assert.ok(
      result.parse_errors!.some((e) => /bidirectional control/.test(e)),
      `parse errors: ${JSON.stringify(result.parse_errors)}`,
    );
    assert.equal(result.readiness_pct, 0);
  });
}

test("an earlier heading that starts with 'Structured Assessment' counts as a second block", () => {
  const result = parseAssessment(
    earlierAssessment("## Structured Assessment (draft)"),
    "Test User",
    "https://app.example.com",
  );
  assert.ok(
    result.parse_errors!.some((e) => /Structured Assessment block; found 2/.test(e)),
    `parse errors: ${JSON.stringify(result.parse_errors)}`,
  );
  assert.equal(result.readiness_pct, 0);
});

test("prose that mentions the structured assessment is not an assessment (control)", () => {
  const md = [
    "# Evaluation",
    "",
    "I will finish with the structured assessment below.",
    "",
    "**Structured assessment notes:** nothing unusual so far.",
    "",
    "## Notes before the structured assessment",
    "",
    "Nothing unusual.",
    "",
    PASSING_ASSESSMENT,
  ].join("\n");
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.deepEqual(result.parse_errors, []);
  assert.equal(result.readiness_pct, 90);
});

// ---------------------------------------------------------------------------
// Inside the assessment, a format section's name is fatal anywhere but its own
// level-three heading. A "#### Critical Bugs" under Summary was outside every
// section the parser reads, so the crash under it passed the gate.
// ---------------------------------------------------------------------------

for (const [label, marker] of [
  ["a level-four heading", "#### Critical Bugs"],
  ["a level-five heading", "##### Critical Bugs"],
  ["a level-six heading", "###### Critical Bugs"],
  ["a level-four heading with more words", "#### Critical Bugs Found"],
  ["a level-four heading with an entity", "#### Critical&#32;Bugs"],
  ["an HTML heading", "<h4>Critical Bugs</h4>"],
  ["a bold line", "**Critical Bugs**"],
  ["a bold line with a colon", "**Critical Bugs:**"],
] as const) {
  test(`a Critical Bugs name as ${label} under Summary is fatal and its bug is read`, () => {
    const md = PASSING_ASSESSMENT.replace("Ready.", `Ready.\n\n${marker}\n\n${CRASH}`);
    assert.notEqual(md, PASSING_ASSESSMENT);
    const result = parseAssessment(md, "Test User", "https://app.example.com");
    assert.ok(
      result.parse_errors!.some((e) => /names a format section outside its own heading/.test(e)),
      `parse errors: ${JSON.stringify(result.parse_errors)}`,
    );
    assert.equal(result.readiness_pct, 0);
    assert.equal(result.critical_bugs, true);
  });
}

for (const marker of ["#### Readiness Score: 10%", "#### Summary", "#### Actionable Items", "#### Structured Assessment"]) {
  test(`'${marker}' inside the assessment is fatal`, () => {
    const md = PASSING_ASSESSMENT.replace("None.\n\n### Critical Bugs", `None.\n\n${marker}\n\nMore.\n\n### Critical Bugs`);
    assert.notEqual(md, PASSING_ASSESSMENT);
    const result = parseAssessment(md, "Test User", "https://app.example.com");
    assert.ok(result.parse_errors!.length > 0, `${marker}: no parse error`);
    assert.equal(result.readiness_pct, 0);
  });
}

test("ordinary nested headings and prose inside the assessment still parse clean (control)", () => {
  const md = PASSING_ASSESSMENT.replace(
    "Ready.",
    [
      "Ready.",
      "",
      "#### Critical path notes",
      "",
      "The critical bugs I feared did not appear; the summary above stands.",
      "",
      "##### Checkout",
      "",
      "Completed twice.",
    ].join("\n"),
  );
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.deepEqual(result.parse_errors, []);
  assert.equal(result.readiness_pct, 90);
  assert.equal(result.critical_bugs, false);
});

// ---------------------------------------------------------------------------
// Whole classes of input, not single renderings. The round-2 review still
// showed a reader an earlier crash-bearing assessment, or a Critical Bugs label
// with its content, through: character references decoded only after the bidi
// check; HTML the one-line heading grammar misread (a quoted ">" attribute, a
// heading over several lines); list items and table cells; lone CR line
// endings; a label followed by its content on the same line. So raw HTML,
// unknown named references and Unicode line separators are rejected outright,
// CR endings are read as LF, and every heading, line, paragraph and table cell
// is matched from its first letter. Look-alike letters come from an explicit
// table (Unicode confusables), so ordinary non-Latin text no longer matches.
// ---------------------------------------------------------------------------

function assertRejected(md: string, reason: RegExp, bug?: boolean): void {
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.ok(
    result.parse_errors!.some((e) => reason.test(e)),
    `expected ${reason}; parse errors: ${JSON.stringify(result.parse_errors)}`,
  );
  assert.equal(result.readiness_pct, 0);
  if (bug !== undefined) assert.equal(result.critical_bugs, bug);
}

function assertClean(md: string): void {
  const result = parseAssessment(md, "Test User", "https://app.example.com");
  assert.deepEqual(result.parse_errors, []);
  assert.equal(result.readiness_pct, 90);
  assert.equal(result.critical_bugs, false);
}

const CRASH_ASSESSMENT = PASSING_ASSESSMENT.replace("### Critical Bugs\n\nNone.", `### Critical Bugs\n\n${CRASH}`);

for (const [label, heading] of [
  ["a hexadecimal reference", "## &#x202e;tnemssessA derutcurtS&#x202c;"],
  ["a decimal reference", "## &#8238;tnemssessA derutcurtS&#8236;"],
  ["an isolate reference", "## &#x2067;tnemssessA derutcurtS&#x2069;"],
] as const) {
  test(`a bidirectional control written as ${label} is fatal`, () => {
    assertRejected(earlierAssessment(heading), /bidirectional control/);
  });
}

test("letters written as unknown named references are rejected and still counted", () => {
  const opf = "Structured Assessment"
    .split("")
    .map((ch) => (ch === " " ? " " : `&${ch}opf;`))
    .join("");
  const md = earlierAssessment(`## ${opf}`);
  assertRejected(md, /unsupported character reference/);
  assertRejected(md, /Structured Assessment block; found 2/);
});

test("common named references decode and parse clean (control)", () => {
  assertClean(
    PASSING_ASSESSMENT.replace("Ready.", "Ready &amp; stable &mdash; cart &rarr; receipt&nbsp;page &lt;OK&gt;."),
  );
});

for (const [label, heading] of [
  ["an HTML heading with a quoted '>' attribute", '<h2 title=">note">Structured Assessment</h2>'],
  ["a multi-line HTML heading", "<h2>\nStructured Assessment (draft)\n</h2>"],
  ["an HTML heading split by a comment", "<h2>Structured<!-- x --> Assessment</h2>"],
  ["an unclosed HTML heading tag", "<h2\n>Structured Assessment</h2>"],
] as const) {
  test(`raw HTML is rejected: an earlier assessment as ${label}`, () => {
    assertRejected(earlierAssessment(heading), /raw HTML/);
  });
}

for (const [label, heading] of [
  ["a list item holding a heading", "- ## Structured Assessment (draft)"],
  ["a numbered bold list item", "1. **Structured Assessment**"],
  ["a table row's first cell", "| **Structured Assessment** | **Result** |\n|---|---|"],
  ["a table row's later cell", "| Result | Structured Assessment |\n|---|---|"],
  ["Lisu look-alike letters", "## \u{a4e2}\u{a4d4}\u{a4e3}\u{a4f4}\u{a4da}\u{a4d4}\u{a4f4}\u{a4e3}\u{a4f0}\u{a4d3} \u{a4ee}\u{a4e2}\u{a4e2}\u{a4f0}\u{a4e2}\u{a4e2}\u{a4df}\u{a4f0}\u{a4e0}\u{a4d4}"],
  ["Armenian look-alike letters", "## Str\u{57d}ct\u{57d}red Assessment"],
  ["a Cherokee look-alike letter", "## \u{13da}tructured Assessment"],
  ["an 'rn' digraph for 'm'", "## Structured Assessrnent"],
  ["a two-line paragraph", "Structured\nAssessment"],
] as const) {
  test(`an earlier assessment headed as ${label} counts as a second block`, () => {
    assertRejected(earlierAssessment(heading), /Structured Assessment block; found 2/);
  });
}

test("tags inside code spans and autolinks are not raw HTML (control)", () => {
  assertClean(
    PASSING_ASSESSMENT.replace(
      "Ready.",
      "Ready. The `<select>` menu and `<h2>` titles render; help is at <https://app.example.com/help>.",
    ),
  );
});

test("a code span cannot hide a tag across table cells", () => {
  const md = PASSING_ASSESSMENT.replace("Ready.", "Ready.\n\n| `x | <h2>Note</h2> | y` |\n|---|---|---|");
  assertRejected(md, /raw HTML/);
});

test("an earlier assessment with lone CR line endings counts as a second block", () => {
  const md = `${CRASH_ASSESSMENT.split("\n").join("\r")}\n\n${PASSING_ASSESSMENT}`;
  assertRejected(md, /Structured Assessment block; found 2/);
});

test("CRLF and lone-CR line endings on a sole assessment read as LF (control)", () => {
  assertClean(PASSING_ASSESSMENT.split("\n").join("\r\n"));
  assertClean(PASSING_ASSESSMENT.split("\n").join("\r"));
});

test("a Unicode line or paragraph separator outside code is rejected", () => {
  for (const sep of ["\u{2028}", "\u{2029}", "\u{85}"]) {
    assertRejected(PASSING_ASSESSMENT.replace("Ready.", `Ready.${sep}Still ready.`), /line separator/);
  }
});

for (const [label, line] of [
  ["a bold label with its content", `**Critical Bugs:** ${CRASH}`],
  ["a plain label with its content", `Critical Bugs: ${CRASH}`],
  ["a list item", `- Critical Bugs: ${CRASH}`],
  ["a numbered bold label with more words", `1. **Critical Bugs found:** ${CRASH}`],
  ["a table cell", `| Critical Bugs | ${CRASH} |\n|---|---|`],
  ["a look-alike capital I", `**CriticaI Bugs:** ${CRASH}`],
] as const) {
  test(`a Critical Bugs label as ${label} under Summary is fatal and its bug is read`, () => {
    const md = PASSING_ASSESSMENT.replace("Ready.", `Ready.\n\n${line}`);
    assertRejected(md, /names a format section outside its own heading/, true);
  });
}

test("a multi-line HTML Critical Bugs heading is rejected and its bug is read", () => {
  const md = PASSING_ASSESSMENT.replace("Ready.", `Ready.\n\n<h4>\nCritical Bugs Found\n</h4>\n\n${CRASH}`);
  assertRejected(md, /raw HTML/, true);
});

test("a Critical Bugs label before the assessment is fatal and its bug is read", () => {
  assertRejected(`**Critical Bugs:** ${CRASH}\n\n${PASSING_ASSESSMENT}`, /names a format section outside its own heading/, true);
});

test("other format labels with content inside the assessment are fatal", () => {
  for (const line of ["**Readiness Score:** 10%", "Summary: not ready.", "- Actionable Items: fix sign-in"]) {
    assertRejected(PASSING_ASSESSMENT.replace("Ready.", `Ready.\n\n${line}`), /names a format section outside its own heading/);
  }
});

test("prose that mentions bugs or a summary without starting a label parses clean (control)", () => {
  assertClean(
    PASSING_ASSESSMENT.replace(
      "Ready.",
      "Ready. No critical bugs were found, and in summary the flows held.\n\n- All three critical paths completed.",
    ),
  );
});

test("ordinary Armenian and Georgian narrative is not an assessment (control)", () => {
  const armenian =
    "\u{531}\u{575}\u{57d} \u{570}\u{561}\u{57e}\u{565}\u{56c}\u{57e}\u{561}\u{56e}\u{568} \u{561}\u{577}\u{56d}\u{561}\u{57f}\u{578}\u{582}\u{574} \u{567} \u{561}\u{580}\u{561}\u{563} \u{587} \u{570}\u{578}\u{582}\u{57d}\u{561}\u{56c}\u{56b}\u{589}";
  const georgian =
    "\u{10d4}\u{10e1} \u{10d0}\u{10de}\u{10da}\u{10d8}\u{10d9}\u{10d0}\u{10ea}\u{10d8}\u{10d0} \u{10e1}\u{10ec}\u{10e0}\u{10d0}\u{10e4}\u{10d0}\u{10d3} \u{10d3}\u{10d0} \u{10e1}\u{10d0}\u{10d8}\u{10db}\u{10d4}\u{10d3}\u{10dd}\u{10d3} \u{10db}\u{10e3}\u{10e8}\u{10d0}\u{10dd}\u{10d1}\u{10e1}.";
  assertClean(`${armenian}\n\n${PASSING_ASSESSMENT}`);
  assertClean(`${georgian}\n\n${PASSING_ASSESSMENT}`);
  assertClean(`## ${armenian}\n\n${georgian}\n\n${PASSING_ASSESSMENT}`);
});

test("a narrative heading that continues past the name is not an assessment (control)", () => {
  assertClean(`## Structured assessment methodology\n\nI followed the persona's format.\n\n${PASSING_ASSESSMENT}`);
});

// Inside the assessment a blockquote is still on the reader's page, and a bold
// label can follow other text on its line.
for (const [label, block] of [
  ["a quoted bold label", `> **Critical Bugs:** ${CRASH}`],
  ["a quoted level-four heading", `> #### Critical Bugs\n>\n> ${CRASH}`],
  ["a quoted level-three heading", `> ### Critical Bugs\n>\n> ${CRASH}`],
  ["a bold label after a code span", `\`x\` **Critical Bugs:** ${CRASH}`],
] as const) {
  test(`${label} under Summary is fatal and its bug is read`, () => {
    const md = PASSING_ASSESSMENT.replace("Ready.", `Ready.\n\n${block}`);
    assertRejected(md, /names a format section outside its own heading/, true);
  });
}

test("a quoted second assessment under Summary is fatal", () => {
  const md = PASSING_ASSESSMENT.replace("Ready.", `Ready.\n\n> ## Structured Assessment\n>\n> ### Critical Bugs\n>\n> ${CRASH}`);
  assertRejected(md, /names a format section outside its own heading/);
});

test("an earlier assessment headed in small capitals counts as a second block", () => {
  const smallCaps = "\u{a731}\u{1d1b}\u{280}\u{1d1c}\u{1d04}\u{1d1b}\u{1d1c}\u{280}\u{1d07}\u{1d05} Assessment";
  assertRejected(earlierAssessment(`## ${smallCaps}`), /Structured Assessment block; found 2/);
});

test("a quoted error message and a bold mention of the assessment are prose (control)", () => {
  assertClean(
    `I wrote the **Structured Assessment** below.\n\n${PASSING_ASSESSMENT.replace("Ready.", "Ready.\n\n> Error message seen: none after the fix.")}`,
  );
});

// bq-5669 round-3 review regressions. Preserve the original assertions above.
const R3_INVALID_FENCE = "```bad`info\n## Structured Assessment\n\n#### Critical Bugs\n\n" + CRASH + "\n```";
const r3Append = (suffix: string) => `${PASSING_ASSESSMENT}\n\n${suffix}`;

test("r3 P1-1 invalid backtick fence cannot hide a second assessment", () => {
  assertRejected(r3Append(R3_INVALID_FENCE), /Structured Assessment block; found 2/);
});

for (const [label, content, reason] of [
  ["raw HTML", "<h4>Critical Bugs</h4>", /raw HTML/],
  ["unknown named reference", "&ZeroWidthSpace;", /unsupported character reference/],
] as const) {
  test(`r3 P1-2 backtick in link destination cannot hide ${label}`, () => {
    assertRejected(r3Append("See [help](https://example.com/`)" + content + "`\n\n" + CRASH), reason);
  });
}

for (const name of ["Critical\nBugs", "Readiness\nScore"]) {
  test(`r3 P1-3 multiline emphasized ${name.replace("\n", " ")} label is fatal`, () => {
    assertRejected(r3Append(`Note: **${name}:** ${CRASH}`), /names a format section outside its own heading/);
  });
}

test("r3 P1-4 paragraph beyond 32 lines cannot hide a bug label", () => {
  assertRejected(r3Append("Critical\n" + "\u200b\n".repeat(32) + "Bugs: " + CRASH), /names a format section outside its own heading/);
});

test("r3 P1-4 paragraph beyond 32 lines cannot hide an assessment", () => {
  assertRejected(r3Append("Structured\n" + "\u200b\n".repeat(32) + "Assessment"), /Structured Assessment block; found 2/);
});

for (const [label, suffix] of [
  ["pipe outside table", "The `<h2>|<div>` text was displayed literally."],
  ["multiline code span", "The `literal\n<select>` text was displayed literally."],
  ["character reference in code span", "The `&#x202e;` text was displayed literally."],
] as const) {
  test(`r3 P2-7 honest ${label} parses clean`, () => {
    assertClean(r3Append(suffix));
  });
}

for (const reference of ["&#x2028;", "&#x2029;"]) {
  test(`r3 P2-9 decoded separator ${reference} is fatal`, () => {
    assertRejected(r3Append(`Ready. ${reference} Still ready.`), /line separator/);
  });
}

test("r3 P1-2 NBSP is allowed in a URI autolink and its reference text is literal", () => {
  assertClean(r3Append("See <https://example.com/\u00a0&ZeroWidthSpace;>."));
});

test("r3 P1-2 forbidden ASCII control cannot make a URI autolink hide a reference", () => {
  assertRejected(r3Append("See <https://example.com/\u0001&ZeroWidthSpace;>."), /unsupported character reference/);
});

// Sizes cross the old paragraph cap; labels in inline code remain visible.
test("generated construct boundaries count exactly the displayed assessment labels", () => {
  type Construct = [string, (label: string, size: number) => string, boolean];
  const constructs: Construct[] = [
    ["fence", (label, size) => `${"`".repeat(size + 3)}md\n## ${label}\n${"sample\n".repeat(size)}${"`".repeat(size + 3)}`, false],
    ["indented code", (label, size) => `    ## ${label}\n${"    sample\n".repeat(size)}`, false],
    ["code span", (label, size) => `${"`".repeat(size)}${label}${"`".repeat(size)}`, true],
    ["link destination", (label, size) => `[help](https://example.com/${"x".repeat(size)}/${label.replaceAll(" ", "\u00a0")})`, false],
    ["link title", (label, size) => `[help](https://example.com/${"x".repeat(size)} "${label}")`, false],
    ["autolink", (label, size) => `<https://example.com/${"x".repeat(size)}/${label.replaceAll(" ", "\u00a0")}>`, false],
    ["emphasis", (label, size) => `**${label.replace(" ", "\n" + "\u200b\n".repeat(size))}**`, true],
    ["table cell", (label, size) => `| ${"x".repeat(size)} | ${label} |\n|---|---|`, true],
    ["paragraph", (label, size) => label.replace(" ", "\n" + "\u200b\n".repeat(size)), true],
    ["setext heading", (label, size) => `${label.replace(" ", "\n" + "\u200b\n".repeat(size))}\n---`, true],
  ];
  for (const size of [1, 3, 33, 65]) {
    for (const [name, wrap, visible] of constructs) {
      for (const outside of [false, true]) {
        const suffix = outside
          ? `${wrap("ordinary sample", size)}\n\nStructured Assessment`
          : wrap("Structured Assessment", size);
        const result = parseAssessment(r3Append(suffix), "Generator", "https://app.example.com");
        const expected = outside || visible ? 2 : 1;
        const countError = result.parse_errors!.find((error) => /Assessment block; found \d+/.test(error));
        const actual = countError ? Number(countError.match(/found (\d+)/)![1]) : 1;
        assert.equal(actual, expected, `${name} size=${size} outside=${outside}: ${JSON.stringify(result.parse_errors)}`);
        if (expected === 1) assert.deepEqual(result.parse_errors, [], `${name} size=${size}`);
      }
    }
  }
});

for (const control of ["\u2028", "\u2029", "\u202e"]) {
  test(`raw rendered control U+${control.codePointAt(0)!.toString(16)} is fatal inside code`, () => {
    const reason = control === "\u202e" ? /bidirectional control/ : /line separator/;
    for (const suffix of [`Text \`x${control}y\`.`, `\`\`\`\nx${control}y\n\`\`\``, `    x${control}y`]) {
      assertRejected(r3Append(suffix), reason);
    }
  });
}

test("code spans keep entity and HTML-looking label text literal", () => {
  assertClean(r3Append("`Structured&nbsp;Assessment`"));
  assertClean(r3Append("`<b>Structured Assessment</b>`"));
  assertClean(r3Append("```\n&#x202e; &ZeroWidthSpace; <h2>Structured Assessment</h2>\n```"));
});


// FOLD 2 START: production gate fixtures copied from index.test.ts, scoped here
// because this package may change parser.test.ts but not index.test.ts.
{
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED = "2026-08-23T16:00:00.000Z";
const REPORT_TIMESTAMP = "2026-08-23T16:00:01.000Z";
const TARGET_URL = "https://app.example.com/dashboard";
const CHECK_NOW = Date.parse("2026-08-23T16:00:03.000Z");
const INVOCATION_NONCE = "a".repeat(64);

const EXTERNAL_INVOCATION = {
  schema_version: 1,
  run_id: RUN_ID,
  created: CREATED,
  nonce: INVOCATION_NONCE,
};

function assessmentToken(persona = "New User", url = TARGET_URL): string {
  return createHmac("sha256", INVOCATION_NONCE)
    .update(`assessment\0${RUN_ID}\0${persona}\0${url}`)
    .digest("hex");
}

function bindAssessment(markdown: string, persona = "New User", url = TARGET_URL): string {
  const token = assessmentToken(persona, url);
  return (
    `<persona-testing-assessment token="${token}" boundary="begin">\n` +
    `${markdown}\n` +
    `<persona-testing-assessment token="${token}" boundary="end">`
  );
}

const TERMINAL_ASSESSMENT = `## Structured Assessment

### Readiness Score: 90%

### Criteria Verdicts

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| Onboarding Clarity | GOOD | The workflow is clear. |

### Actionable Items

None.

### Critical Bugs

None.

### Summary

The inspected workflow is ready for this persona.`;

const TERMINAL_NOT_READY_ASSESSMENT = `## Structured Assessment

### Readiness Score: 12%

### Criteria Verdicts

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| Onboarding Clarity | POOR | Sign-in crashes. |

### Actionable Items

1. **[fixable]** (priority: critical) Repair the sign-in crash.

### Critical Bugs

The sign-in flow crashes before the persona can continue.

### Summary

NOT READY.`;

interface FixtureOptions {
  report?: Record<string, unknown>;
  manifest?: Record<string, unknown> | false;
  evidence?: Record<string, unknown>;
  extraReports?: Record<string, Record<string, unknown>>;
}

function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    persona: "New User",
    timestamp: REPORT_TIMESTAMP,
    url: TARGET_URL,
    readiness_pct: 90,
    critical_bugs: false,
    criteria: { onboarding_clarity: "GOOD" },
    items: [],
    screenshots: ["new-user-first-view.png"],
    report_markdown: bindAssessment(TERMINAL_ASSESSMENT),
    parse_errors: [],
    run_id: RUN_ID,
    terminal_state: "PASSED",
    tool_stats: {
      total_calls: 2,
      errors: 0,
      policy_blocks: 0,
      navigation_failures: 0,
      successful_observations: 1,
      successful_interactions: 1,
    },
    ...overrides,
  };
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    invocation_created: CREATED,
    created: CREATED,
    completed: "2026-08-23T16:00:02.000Z",
    url: TARGET_URL,
    status: "COMPLETE",
    expected_personas: [
      {
        persona: "New User",
        criteria: ["onboarding_clarity"],
        report: "current.json",
        evidence: "current.tool-evidence.jsonl",
      },
    ],
    reports: ["current.json"],
    ...overrides,
  };
}

function validEvidence(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload = {
    schema_version: 1,
    run_id: RUN_ID,
    persona: "New User",
    url: TARGET_URL,
    started: CREATED,
    completed: "2026-08-23T16:00:02.000Z",
    calls: [
      { sequence: 1, tool: "get_outline", outcome: "SUCCESS" },
      { sequence: 2, tool: "click", outcome: "SUCCESS" },
    ],
    ...overrides,
  };
  return {
    ...payload,
    hmac_sha256: createHmac("sha256", INVOCATION_NONCE)
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
}

function makeFixture(options: FixtureOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "persona-check-"));
  writeFileSync(join(dir, "current.json"), JSON.stringify(options.report ?? validReport()));
  if (options.manifest !== false) {
    writeFileSync(
      join(dir, "run-manifest.json"),
      JSON.stringify(options.manifest ?? validManifest()),
    );
  }
  writeFileSync(
    join(dir, "current.tool-evidence.jsonl"),
    JSON.stringify(options.evidence ?? validEvidence()),
  );
  for (const [name, report] of Object.entries(options.extraReports ?? {})) {
    writeFileSync(join(dir, name), JSON.stringify(report));
  }
  return dir;
}

function runCheck(
  reportDir: string,
  invocation = EXTERNAL_INVOCATION,
  now = CHECK_NOW,
): { status: number | null; output: string } {
  const messages: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return {
      status: (
        checkReports as unknown as (
          dir: string,
          threshold: number,
          invocation: typeof EXTERNAL_INVOCATION,
          now: number,
        ) => boolean
      )(reportDir, 60, invocation, now)
        ? 0
        : 1,
      output: messages.join("\n"),
    };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function assertGateFailure(
  result: { status: number | null; output: string },
  reason: RegExp,
): void {
  assert.notEqual(result.status, 0, `gate unexpectedly passed:\n${result.output}`);
  assert.match(result.output, reason);
}

function withFixture(options: FixtureOptions, assertion: (dir: string) => void): void {
  const dir = makeFixture(options);
  try {
    assertion(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


  const append = (suffix: string) => `${TERMINAL_ASSESSMENT}\n\n${suffix}`;
  function parsed(markdown: string) {
    return parseAssessment(markdown, "New User", TARGET_URL);
  }
  function gate(markdown: string, items: ReturnType<typeof parsed>["items"] = []) {
    let checked!: ReturnType<typeof runCheck>;
    withFixture({ report: validReport({ report_markdown: bindAssessment(markdown), items }) }, (dir) => {
      checked = runCheck(dir);
    });
    return checked;
  }
  function rejected(name: string, markdown: string, reason: RegExp, bug = false) {
    test(`fold2 parser ${name}`, () => {
      const result = parsed(markdown);
      assert.equal(result.readiness_pct, 0);
      assert.match(result.parse_errors!.join("; "), reason);
      if (bug) assert.equal(result.critical_bugs, true);
    });
    test(`fold2 gate ${name}`, () => {
      assertGateFailure(gate(markdown), reason);
    });
  }
  for (const [syntax, hardbreak] of [["two spaces", "  \n"], ["backslash", "\\\n"]]) {
    rejected(`P1-1 ${syntax} exposes Critical Bugs`,
      append(`Ready.${hardbreak}Critical Bugs: The application crashes and loses data.`),
      /names a format section outside its own heading/, true);
    rejected(`P1-1 ${syntax} exposes Readiness Score`,
      append(`Ready.${hardbreak}Readiness Score: 10%`),
      /names a format section outside its own heading/);
    rejected(`P1-1 ${syntax} exposes duplicate Structured Assessment`,
      append(`Ready.${hardbreak}Structured Assessment`), /Structured Assessment block; found 2/);
    rejected(`P1-1 ${syntax} preserves a label across successive hard breaks`,
      append(`Ready.${hardbreak}Critical${hardbreak}Bugs: The application crashes and loses data.`),
      /names a format section outside its own heading/, true);
    rejected(`P1-1 ${syntax} reads a bug after another reserved label`,
      append(`Ready.${hardbreak}Readiness Score: 10%${hardbreak}Critical Bugs: The application crashes and loses data.`),
      /names a format section outside its own heading/, true);
  }
  for (const depth of [99, 100, 101]) {
    rejected(`P1-2 crash at quote depth ${depth}`,
      append("> ".repeat(depth) + "**Critical Bugs:** The application crashes and loses data."),
      depth < 100 ? /names a format section outside its own heading/ : /nesting limit/,
      depth < 100);
  }
  // An innocent boundary control proves fail-closed truncation, independently
  // of recognizing a crash. Depth 99 must still be fully accepted.
  for (const depth of [99, 100, 101]) {
    const markdown = append("> ".repeat(depth) + "Ordinary explanatory text.");
    if (depth >= 100) {
      rejected(`P1-2 innocent content at quote depth ${depth}`, markdown, /nesting limit/);
    } else {
      test(`fold2 parser P1-2 innocent content at quote depth ${depth}`, () => {
        assert.equal(parsed(markdown).readiness_pct, 90);
        assert.deepEqual(parsed(markdown).parse_errors, []);
      });
      test(`fold2 gate P1-2 innocent content at quote depth ${depth}`, () => {
        const result = gate(markdown);
        assert.equal(result.status, 0, result.output);
      });
    }
  }
  const quotedTable = TERMINAL_ASSESSMENT.split("\n")
    .map((line) => line.startsWith("|") ? `> ${line}` : line).join("\n");
  test("fold2 parser P1-3 quoted table supplies no authoritative criteria", () => {
    assert.deepEqual(parsed(quotedTable).criteria, {});
  });
  test("fold2 gate P1-3 quoted table supplies no authoritative criteria", () => {
    assertGateFailure(gate(quotedTable), /criterion onboarding_clarity does not match/);
  });
  const action = "1. **[false_positive]** (priority: low) Expected behavior\n" +
    "   - The button label reflects the selected language.";
  const withAction = TERMINAL_ASSESSMENT.replace("### Actionable Items\n\nNone.", `### Actionable Items\n\n${action}`);
  const expectedItem = {
    classification: "false_positive", priority: "low",
    description: "Expected behavior The button label reflects the selected language.",
  };
  test("fold2 parser P1-4 unordered child attaches to its ordered action", () => {
    assert.deepEqual(parsed(withAction).items, [expectedItem]);
  });
  test("fold2 gate P1-4 unordered child creates no separate fixable item", () => {
    const result = parsed(withAction);
    const checked = gate(withAction, result.items);
    assert.equal(checked.status, 0, checked.output);
    // checkReports intentionally does not compare items; verify the submitted
    // production parser output as well as the gate's acceptance of this report.
    assert.deepEqual(result.items, [expectedItem]);
  });
  // FOLD 3 START: quotations stay visible to label inspection, but never
  // supply actions or contribute quoted text to a real action's description.
  const quotedAction = "1. **[fixable]** (priority: high) Replace the design.";
  const realAction = "1. **[false_positive]** (priority: low) Expected behavior";
  const realItem = {
    classification: "false_positive" as const, priority: "low" as const,
    description: "Expected behavior",
  };
  const actionReport = (content: string) => TERMINAL_ASSESSMENT.replace(
    "### Actionable Items\n\nNone.", `### Actionable Items\n\n${content}`,
  );
  const quoteCases: { name: string; content: string; items: ReturnType<typeof parsed>["items"] }[] = [
    {
      name: "standalone quoted action verbatim",
      content: "None.\n\n> 1. **[fixable]** (priority: high) Replace the design.",
      items: [],
    },
    {
      name: "quoted numbered child beneath a real ordered action",
      content: `${realAction}\n\n   > ${quotedAction}`,
      items: [realItem],
    },
    {
      name: "depth-two quoted action inside a list item",
      content: `- Example.\n\n  > > ${quotedAction}`,
      items: [],
    },
  ];
  for (const { name, content, items } of quoteCases) {
    const markdown = actionReport(content);
    test(`fold3 parser ${name}`, () => {
      const result = parsed(markdown);
      assert.deepEqual(result.items, items);
      assert.equal(result.readiness_pct, 90);
      assert.equal(result.critical_bugs, false);
      assert.deepEqual(result.parse_errors, []);
    });
    test(`fold3 gate ${name}`, () => {
      const result = parsed(markdown);
      const checked = gate(markdown, result.items);
      assert.equal(checked.status, 0, checked.output);
      // The gate does not compare action lists: assert the submitted production
      // parser output as well as gate acceptance, as in fold2's action case.
      assert.deepEqual(result.items, items);
    });
  }
  const quotedConflict = actionReport(
    "None.\n\n> 1. **Critical Bugs:** The application crashes and loses data.",
  );
  test("fold3 parser quoted conflicting label inside Actionable Items still counts", () => {
    const result = parsed(quotedConflict);
    assert.equal(result.readiness_pct, 0);
    assert.equal(result.critical_bugs, true);
    assert.match(result.parse_errors!.join("; "), /names a format section outside its own heading/);
    assert.deepEqual(result.items, []);
  });
  test("fold3 gate quoted conflicting label inside Actionable Items still counts", () => {
    const result = parsed(quotedConflict);
    assertGateFailure(gate(quotedConflict, result.items), /names a format section outside its own heading/);
    assert.deepEqual(result.items, []);
  });

  for (const mode of ["parser", "gate"]) {
    test(`fold3 ${mode} generated quote depths and nested list ownership`, () => {
      for (const depth of [1, 2, 5]) {
        for (const listDepth of [0, 1, 3]) {
          const prefix = "> ".repeat(depth);
          let quote = `${prefix}${quotedAction}\n${prefix}\n` +
            `${prefix}- Quoted button detail.\n${prefix}\n${prefix}Quoted continuation.`;
          for (let nesting = 0; nesting < listDepth; nesting++) {
            quote = "- Context.\n\n" + quote.split("\n").map((line) => `  ${line}`).join("\n");
          }
          const markdown = actionReport(`${realAction}\n\n` +
            quote.split("\n").map((line) => `   ${line}`).join("\n") +
            "\n\n   Still expected.\n\n2. **[tradeoff]** (priority: medium) Keep the layout.");
          const result = parsed(markdown);
          const context = `quote depth=${depth}, list depth=${listDepth}`;
          if (mode === "gate") {
            const checked = gate(markdown, result.items);
            assert.equal(checked.status, 0, `${context}: ${checked.output}`);
          }
          assert.deepEqual(result.items, [
            { ...realItem, description: "Expected behavior" + " Context.".repeat(listDepth) + " Still expected." },
            { classification: "tradeoff", priority: "medium", description: "Keep the layout." },
          ], context);
          assert.equal(result.readiness_pct, 90, context);
          assert.deepEqual(result.parse_errors, [], context);
        }
      }
    });
  }
  // FOLD 3 END

  // bq-5696 START: rendered description breaks must not discard explicit metadata.
  const multilineCases: { name: string; content: string; items: ReturnType<typeof parsed>["items"] }[] = [
    {
      name: "review reproduction verbatim false_positive low",
      content: "1. **[false_positive]** (priority: low) Expected behavior\n   This is a continuation.",
      items: [{ classification: "false_positive", priority: "low",
        description: "Expected behavior\nThis is a continuation." }],
    },
    {
      name: "wrapped tradeoff high",
      content: "1. **[tradeoff]** (priority: high) Keep the design\n   This is a continuation.",
      items: [{ classification: "tradeoff", priority: "high",
        description: "Keep the design\nThis is a continuation." }],
    },
    {
      name: "soft break inside description",
      content: "1. **[false_positive]** (priority: low) Expected\n   behavior continues.",
      items: [{ classification: "false_positive", priority: "low",
        description: "Expected\nbehavior continues." }],
    },
    {
      name: "two trailing spaces hard break",
      content: "1. **[false_positive]** (priority: low) Expected behavior  \n   This is a continuation.",
      items: [{ classification: "false_positive", priority: "low",
        description: "Expected behavior\nThis is a continuation." }],
    },
    {
      name: "backslash hard break",
      content: "1. **[tradeoff]** (priority: high) Keep the design\\\n   This is a continuation.",
      items: [{ classification: "tradeoff", priority: "high",
        description: "Keep the design\nThis is a continuation." }],
    },
    {
      name: "several mixed breaks beside a single-line sibling",
      content: "1. **[false_positive]** (priority: low) Expected\n   behavior  \n   continues\\\n   here.\n" +
        "2. **[tradeoff]** (priority: high) Keep the design.",
      items: [
        { classification: "false_positive", priority: "low", description: "Expected\nbehavior\ncontinues\nhere." },
        { classification: "tradeoff", priority: "high", description: "Keep the design." },
      ],
    },
    // Control: preserves the existing single-line grammar, guarding against
    // metadata/description changes. Base passes because dot already spans this text.
    {
      name: "control single-line labelled action unchanged",
      content: "1. **[false_positive]** (priority: low) Expected behavior",
      items: [{ classification: "false_positive", priority: "low", description: "Expected behavior" }],
    },
    // Control: preserves fallback classification and priority, guarding against
    // forcing explicit metadata onto unlabelled text. Base already uses heuristics.
    {
      name: "control unlabelled multiline action uses heuristics",
      content: "1. A feature needs an architecture change\n   This is important.",
      items: [{ classification: "tradeoff", priority: "high",
        description: "A feature needs an architecture change\nThis is important." }],
    },
    // Control: fold3 excludes quoted actions and inherited quoted description
    // text. Base passes via its quote-depth guard; multiline support must keep it.
    {
      name: "control quoted blocks supply no action or description text",
      content: "1. **[false_positive]** (priority: low) Expected behavior\n\n" +
        "   > Quoted continuation.\n   >\n   > 1. **[fixable]** (priority: critical) Replace it.\n\n" +
        "2. **[tradeoff]** (priority: high) Keep the design.",
      items: [
        { classification: "false_positive", priority: "low", description: "Expected behavior" },
        { classification: "tradeoff", priority: "high", description: "Keep the design." },
      ],
    },
  ];
  function assertMultilineItems(mode: string, content: string, items: ReturnType<typeof parsed>["items"]) {
    const markdown = actionReport(content);
    const result = parsed(markdown);
    if (mode === "gate") {
      // checkReports does not compare items. Exercise its real fixture/validation
      // path and independently assert the submitted production parser's items.
      const checked = gate(markdown, result.items);
      assert.equal(checked.status, 0, checked.output);
    }
    assert.deepEqual(result.items, items);
    assert.deepEqual(result.parse_errors, []);
    assert.equal(result.readiness_pct, 90);
    assert.equal(result.critical_bugs, false);
  }
  for (const mode of ["parser", "gate"]) {
    for (const { name, content, items } of multilineCases) {
      test(`bq-5696 ${mode} ${name}`, () => assertMultilineItems(mode, content, items));
    }
    test(`bq-5696 ${mode} generated break positions and counts preserve explicit metadata`, () => {
      for (const classification of ["fixable", "tradeoff", "false_positive"] as const) {
        for (const priority of ["critical", "high", "medium", "low"] as const) {
          for (const breakText of ["\n", "  \n", "\\\n"]) {
            for (const position of [0, 1, 2, 3]) {
              for (const count of [1, 3]) {
                const words = ["Expected", "behavior", "continues", "here."];
                // Position zero with one break is a control: base already consumes
                // whitespace immediately after priority. Extra breaks and later
                // positions regress, guarding against fixes at only that boundary.
                const fragments = [words.slice(0, position).join(" "),
                  ...Array.from({ length: count - 1 }, () => "More detail."),
                  words.slice(position).join(" ")];
                const content = `1. **[${classification}]** (priority: ${priority}) ` +
                  fragments.join(`${breakText}   `);
                assertMultilineItems(mode, content, [{ classification, priority,
                  description: fragments.join("\n").trim() }]);
              }
            }
          }
        }
      }
    });
  }
  // bq-5696 END

  // bq-5670 START: symbols are letters when mapped; label continuations are closed.
  const labelReason = /names a format section outside its own heading/;
  const labelCases = [
    // confusables.txt:3134 2223 ; 006C ; MA -- DIVIDES -> LATIN SMALL LETTER L.
    { name: "U+2223 DIVIDES heading", markdown: append(`#### Critica\u2223 Bugs\n\n${CRASH}`), rejected: true },
    // confusables.txt:3132 007C ; 006C ; MA -- VERTICAL LINE -> LATIN SMALL LETTER L.
    { name: "ASCII pipe heading", markdown: append(`#### Critica| Bugs\n\n${CRASH}`), rejected: true },
    // confusables.txt:3135 23FD ; 006C ; MA -- POWER ON SYMBOL -> LATIN SMALL LETTER L.
    { name: "U+23FD POWER ON SYMBOL heading", markdown: append(`#### Critica\u23fd Bugs\n\n${CRASH}`), rejected: true },
    // confusables.txt:4383 22A4 ; 0054 ; MA -- DOWN TACK -> LATIN CAPITAL LETTER T.
    { name: "U+22A4 DOWN TACK heading", markdown: append(`#### Cri\u22a4ical Bugs\n\n${CRASH}`), rejected: true },
    { name: "Summary of the workflow sentence", markdown: append("Summary of the workflow: all checks succeeded."), rejected: false },
    { name: "Critical bug reporting methodology heading", markdown:
      "## Critical bug reporting methodology\n\nThe test checks data integrity.\n\n" + TERMINAL_ASSESSMENT, rejected: false },
    { name: "criterion begins with Summary", markdown:
      TERMINAL_ASSESSMENT.replace("Onboarding Clarity", "Summary comprehension"), rejected: false, criterion: "summary_comprehension" },
    { name: "plural Critical Bugs narrative", markdown: append("Critical Bugs reporting methodology checks integrity."), rejected: false },
    { name: "closed Found suffix cannot absorb narrative", markdown: append("Critical Bugs Found during training were examples."), rejected: false },
    // Control: protects round 3's explicit Found label against over-narrowing.
    // Base passes because its old prefix match already identifies this label.
    { name: "control Critical Bugs Found still labels", markdown: append(`Critical Bugs Found: ${CRASH}`), rejected: true },
    // Control: protects ordinary punctuation/prose and real table boundaries.
    // Base passes because neither em dash prose nor a table's pipe spells a name.
    { name: "control em dash and table pipe remain punctuation", markdown:
      append("Ready \u2014 all checks held.\n\n| Detail | Result |\n|---|---|\n| Saved | Intact |"), rejected: false },
    // Control: protects bq-5696 metadata and continuation text against label scanning.
    // Base contains its dot-all fix, so rendered breaks retain explicit metadata.
    { name: "control multiline descriptions unchanged", markdown: actionReport(
      "1. **[false_positive]** (priority: low) Expected behavior\n   This is a continuation."), rejected: false,
      items: [{ classification: "false_positive" as const, priority: "low" as const,
        description: "Expected behavior\nThis is a continuation." }] },
  ];
  function labelGate(markdown: string, criterion = "onboarding_clarity", items: ReturnType<typeof parsed>["items"] = []) {
    let checked!: ReturnType<typeof runCheck>;
    withFixture({
      report: validReport({ report_markdown: bindAssessment(markdown), criteria: { [criterion]: "GOOD" }, items }),
      manifest: validManifest({ expected_personas: [{ persona: "New User", criteria: [criterion],
        report: "current.json", evidence: "current.tool-evidence.jsonl" }] }),
    }, (dir) => { checked = runCheck(dir); });
    return checked;
  }
  for (const mode of ["parser", "gate"]) {
    for (const entry of labelCases) {
      test(`bq-5670 ${mode} ${entry.name}`, () => {
        if (mode === "gate") {
          const checked = labelGate(entry.markdown, entry.criterion, entry.items);
          if (entry.rejected) assertGateFailure(checked, labelReason);
          else assert.equal(checked.status, 0, checked.output);
        }
        const result = parsed(entry.markdown);
        if (entry.rejected) {
          assert.equal(result.readiness_pct, 0);
          assert.match(result.parse_errors!.join("; "), labelReason);
          assert.equal(result.critical_bugs, true);
        } else {
          assert.deepEqual(result.parse_errors, []);
          assert.equal(result.readiness_pct, 90);
          assert.equal(result.critical_bugs, false);
          if (entry.criterion) assert.deepEqual(result.criteria, { [entry.criterion]: "GOOD" });
          if (entry.items) assert.deepEqual(result.items, entry.items);
        }
      });
    }
    test(`bq-5670 ${mode} narrative continuations across every format name`, () => {
      for (const name of ["Structured Assessment", "Readiness Score", "Criteria Verdicts", "Actionable Items", "Critical Bug", "Summary"]) {
        for (const tail of [" of the workflow: all checks succeeded.", "ness is a criterion name."]) {
          const markdown = append(name + tail);
          if (mode === "gate") {
            const checked = labelGate(markdown);
            assert.equal(checked.status, 0, `${name}${tail}: ${checked.output}`);
          }
          const result = parsed(markdown);
          assert.deepEqual(result.parse_errors, [], name + tail);
          assert.equal(result.readiness_pct, 90, name + tail);
          assert.equal(result.critical_bugs, false, name + tail);
        }
      }
    });
  }
  const oldLookAlikes: Record<string, string> = {
  a: "\u{23a}\u{251}\u{391}\u{3b1}\u{410}\u{430}\u{13aa}\u{15c5}\u{1d00}\u{1d8f}\u{2c65}\u{2c6d}\u{a4ee}\u{ab64}\u{ab7a}\u{102a0}\u{16f40}",
  b: "\u{180}\u{181}\u{182}\u{183}\u{184}\u{185}\u{243}\u{253}\u{299}\u{392}\u{3b2}\u{412}\u{42c}\u{432}\u{44c}\u{7d5}\u{13cf}\u{13f4}\u{13fc}\u{1472}\u{15af}\u{15f7}\u{1c80}\u{1d6c}\u{1d80}\u{2c82}\u{2c83}\u{a4d0}\u{a557}\u{a796}\u{a797}\u{a7b4}\u{a7b5}\u{ab9f}\u{10282}\u{102a1}\u{10301}\u{1031c}\u{16eb6}\u{16ed1}",
  c: "\u{187}\u{188}\u{23b}\u{23c}\u{255}\u{421}\u{441}\u{1004}\u{105a}\u{13df}\u{1c83}\u{1d04}\u{2ca4}\u{2ca5}\u{a4da}\u{a792}\u{a793}\u{a794}\u{a7c4}\u{abaf}\u{102a2}\u{10302}\u{10415}\u{1043d}\u{1051b}\u{1df1d}",
  d: "\u{110}\u{111}\u{18a}\u{18b}\u{18c}\u{221}\u{256}\u{257}\u{500}\u{501}\u{13a0}\u{13e7}\u{146f}\u{15de}\u{15ea}\u{1d05}\u{1d6d}\u{1d81}\u{1d91}\u{a4d2}\u{a4d3}\u{a7c7}\u{a7c8}\u{ab70}\u{abb7}\u{1df25}",
  e: "\u{246}\u{247}\u{395}\u{3b5}\u{415}\u{435}\u{4bc}\u{4bd}\u{13ac}\u{1d07}\u{1d92}\u{2c78}\u{2d39}\u{a4f0}\u{a5cb}\u{ab32}\u{ab34}\u{ab7c}\u{10286}\u{118a6}\u{118ae}\u{118c6}\u{118ce}",
  g: "\u{18d}\u{193}\u{1e4}\u{1e5}\u{260}\u{261}\u{262}\u{29b}\u{50c}\u{50d}\u{551}\u{581}\u{13c0}\u{13f3}\u{13fb}\u{1d83}\u{a4d6}\u{a7a0}\u{a7a1}\u{a7ac}\u{ab90}",
  i: "\u{197}\u{268}\u{1d96}\u{1df1a}",
  il: "1ILil\u{131}\u{196}\u{1c0}\u{269}\u{26a}\u{399}\u{3b9}\u{406}\u{456}\u{4c0}\u{4cf}\u{552}\u{582}\u{5d5}\u{5df}\u{627}\u{7ca}\u{13a5}\u{13de}\u{14aa}\u{16c1}\u{16d0}\u{2c92}\u{2c93}\u{2cd0}\u{2cd1}\u{2d4a}\u{2d4f}\u{a4e1}\u{a4f2}\u{a56f}\u{a646}\u{a647}\u{a780}\u{a781}\u{a7ae}\u{a7fe}\u{ab75}\u{abae}\u{1028a}\u{10309}\u{1041b}\u{10443}\u{1050e}\u{10526}\u{10926}\u{10c3e}\u{10ca5}\u{10ce5}\u{118a3}\u{118b2}\u{118c3}\u{118d2}\u{11dda}\u{16d63}\u{16eaa}\u{16ec5}\u{16f16}\u{16f28}",
  l: "\u{141}\u{142}\u{19a}\u{234}\u{23d}\u{26b}\u{26c}\u{26d}\u{29f}\u{1d0c}\u{1d85}\u{2c60}\u{2c61}\u{2c62}\u{a748}\u{a749}\u{a78e}\u{a7ad}\u{ab37}\u{ab38}\u{ab39}\u{1df04}\u{1df11}\u{1df13}\u{1df26}",
  m: "\u{271}\u{39c}\u{3bc}\u{3fa}\u{3fb}\u{41c}\u{43c}\u{560}\u{13b7}\u{15f0}\u{16d6}\u{1d0d}\u{1d6f}\u{1d86}\u{2c6e}\u{2c98}\u{2c99}\u{a4df}\u{ab3a}\u{ab87}\u{102b0}\u{10311}\u{10c21}\u{11700}",
  n: "\u{19d}\u{19e}\u{220}\u{235}\u{272}\u{273}\u{274}\u{548}\u{54c}\u{578}\u{57c}\u{1260}\u{144e}\u{1d70}\u{1d87}\u{2c9a}\u{2c9b}\u{a4e0}\u{a4f5}\u{a790}\u{a791}\u{a7a4}\u{a7a5}\u{ab3b}\u{10513}\u{11abe}\u{16ad1}\u{1df27}",
  nv: "\u{39d}\u{3bd}",
  o: "0\u{d8}\u{f8}\u{19f}\u{39f}\u{3a3}\u{3bf}\u{3c2}\u{3c3}\u{3da}\u{3db}\u{3ec}\u{3ed}\u{41e}\u{43e}\u{555}\u{585}\u{5e1}\u{647}\u{6be}\u{6c1}\u{6d5}\u{7cb}\u{840}\u{b20}\u{d20}\u{101d}\u{10ff}\u{110b}\u{11bc}\u{12d0}\u{1a45}\u{1c82}\u{1cbf}\u{1d0f}\u{1d11}\u{2c7a}\u{2c8a}\u{2c8b}\u{2c9e}\u{2c9f}\u{2d54}\u{a4f3}\u{a74a}\u{a74b}\u{a74c}\u{a74d}\u{ab3d}\u{10292}\u{102ab}\u{1030f}\u{10404}\u{1042c}\u{104c2}\u{104ea}\u{10516}\u{1092c}\u{10c17}\u{10d07}\u{11124}\u{118a8}\u{118b5}\u{118b7}\u{118c8}\u{118d5}\u{118d7}\u{16ae9}\u{1df1b}",
  r: "\u{1a6}\u{24c}\u{24d}\u{27c}\u{27d}\u{27e}\u{280}\u{13a1}\u{13d2}\u{1587}\u{1d26}\u{1d72}\u{1d73}\u{1d89}\u{2c64}\u{a4e3}\u{a7a6}\u{a7a7}\u{ab46}\u{ab47}\u{ab48}\u{ab49}\u{ab71}\u{aba2}\u{104b4}\u{104dc}\u{16a19}\u{16f35}\u{1df16}\u{1df28}",
  ry: "\u{413}\u{433}\u{13b1}\u{2c84}\u{2c85}\u{ab81}",
  s: "\u{1bc}\u{1bd}\u{23f}\u{282}\u{405}\u{455}\u{54f}\u{57f}\u{d1f}\u{10bd}\u{10fd}\u{13d5}\u{13da}\u{1cbd}\u{1d74}\u{1d8a}\u{2c7e}\u{2d1d}\u{a4e2}\u{a576}\u{a731}\u{a7a8}\u{a7a9}\u{a7c5}\u{a7c9}\u{a7ca}\u{a7cc}\u{a7cd}\u{aba5}\u{abaa}\u{10296}\u{10420}\u{10448}\u{118a1}\u{118c1}\u{16ad6}\u{16f3a}\u{1df1e}\u{1df29}",
  t: "\u{166}\u{167}\u{1ab}\u{1ac}\u{1ad}\u{1ae}\u{236}\u{23e}\u{288}\u{3a4}\u{3c4}\u{422}\u{442}\u{7e0}\u{13a2}\u{1c84}\u{1c85}\u{1d1b}\u{1d75}\u{2c66}\u{2ca6}\u{2ca7}\u{3112}\u{4e05}\u{a4d4}\u{a50b}\u{ab72}\u{10297}\u{102b1}\u{10315}\u{16f0a}\u{1df09}\u{1df2a}",
  ty: "\u{118bc}\u{118dc}",
  u: "\u{54d}\u{57d}\u{1200}\u{144c}\u{1d1c}\u{1d99}\u{a4f4}\u{a79e}\u{a79f}\u{a7b8}\u{a7b9}\u{ab4e}\u{ab52}\u{104ce}\u{104f6}\u{118b8}\u{118d8}\u{16f42}",
  uv: "\u{1b2}\u{28b}",
  uy: "\u{3a5}\u{3c5}",
  v: "\u{474}\u{475}\u{5d8}\u{13d9}\u{142f}\u{1d20}\u{2c71}\u{2c74}\u{2d38}\u{a4e6}\u{a6df}\u{a75e}\u{a75f}\u{aba9}\u{1051d}\u{10c1f}\u{11706}\u{118a0}\u{118c0}\u{16f08}",
  vy: "\u{1d8c}",
  y: "\u{194}\u{1b3}\u{1b4}\u{24e}\u{24f}\u{263}\u{28f}\u{393}\u{3b3}\u{423}\u{443}\u{4ae}\u{4af}\u{7cc}\u{10e7}\u{13a9}\u{13bd}\u{14a5}\u{1ca7}\u{1efe}\u{1eff}\u{2ca8}\u{2ca9}\u{311a}\u{4e2b}\u{a4ec}\u{ab5a}\u{ab79}\u{ab8d}\u{102b2}\u{1050f}\u{10c20}\u{118a4}\u{118c4}\u{16f07}\u{16f43}",
  };
  const allLookAlikes: Record<string, string> = {
  a: "\u{23a}\u{251}\u{391}\u{3b1}\u{410}\u{430}\u{13aa}\u{15c5}\u{1d00}\u{1d8f}\u{237a}\u{2c65}\u{2c6d}\u{a4ee}\u{ab64}\u{ab7a}\u{102a0}\u{16f40}\u{1df5a}\u{1df6a}",
  b: "\u{180}\u{181}\u{182}\u{183}\u{184}\u{185}\u{243}\u{253}\u{299}\u{392}\u{3b2}\u{412}\u{42c}\u{432}\u{44c}\u{7d5}\u{13cf}\u{13f4}\u{13fc}\u{1472}\u{15af}\u{15f7}\u{1c80}\u{1d6c}\u{1d80}\u{2c82}\u{2c83}\u{a4d0}\u{a557}\u{a796}\u{a797}\u{a7b4}\u{a7b5}\u{ab9f}\u{10282}\u{102a1}\u{10301}\u{1031c}\u{16eb6}\u{16ed1}\u{1d207}",
  c: "\u{187}\u{188}\u{23b}\u{23c}\u{255}\u{421}\u{441}\u{1004}\u{105a}\u{13df}\u{1c83}\u{1d04}\u{2ca4}\u{2ca5}\u{a4da}\u{a792}\u{a793}\u{a794}\u{a7c4}\u{abaf}\u{102a2}\u{10302}\u{10415}\u{1043d}\u{1051b}\u{118e9}\u{118f2}\u{1d134}\u{1df1d}\u{1f74c}",
  d: "\u{110}\u{111}\u{18a}\u{18b}\u{18c}\u{221}\u{256}\u{257}\u{500}\u{501}\u{13a0}\u{13e7}\u{146f}\u{15de}\u{15ea}\u{1d05}\u{1d6d}\u{1d81}\u{1d91}\u{a4d2}\u{a4d3}\u{a7c7}\u{a7c8}\u{ab70}\u{abb7}\u{1018b}\u{1df25}",
  e: "\u{246}\u{247}\u{395}\u{3b5}\u{415}\u{435}\u{4bc}\u{4bd}\u{13ac}\u{1d07}\u{1d92}\u{212e}\u{22ff}\u{2c78}\u{2d39}\u{a4f0}\u{a5cb}\u{ab32}\u{ab34}\u{ab7c}\u{10286}\u{118a6}\u{118ae}\u{118c6}\u{118ce}\u{1df81}",
  g: "\u{18d}\u{193}\u{1e4}\u{1e5}\u{260}\u{261}\u{262}\u{29b}\u{50c}\u{50d}\u{551}\u{581}\u{13c0}\u{13f3}\u{13fb}\u{1d83}\u{a4d6}\u{a7a0}\u{a7a1}\u{a7ac}\u{ab90}",
  i: "\u{197}\u{268}\u{1d96}\u{1df1a}",
  il: "1ILil\u{7c}\u{a1}\u{131}\u{196}\u{1c0}\u{269}\u{26a}\u{345}\u{399}\u{3b9}\u{406}\u{456}\u{4c0}\u{4cf}\u{552}\u{582}\u{5c0}\u{5d5}\u{5df}\u{627}\u{661}\u{6f1}\u{7ca}\u{964}\u{104a}\u{13a5}\u{13de}\u{14aa}\u{16c1}\u{16d0}\u{21bf}\u{2223}\u{2373}\u{23fd}\u{2502}\u{2503}\u{2c92}\u{2c93}\u{2cd0}\u{2cd1}\u{2d4a}\u{2d4f}\u{a4e1}\u{a4f2}\u{a56f}\u{a646}\u{a647}\u{a780}\u{a781}\u{a7ae}\u{a7fe}\u{a830}\u{a8ce}\u{aa5d}\u{ab75}\u{abae}\u{1028a}\u{10309}\u{10320}\u{1041b}\u{10443}\u{1050e}\u{10526}\u{10926}\u{10c3e}\u{10ca5}\u{10ce5}\u{10cfa}\u{11047}\u{110c0}\u{11141}\u{111c5}\u{113d4}\u{1144b}\u{115c5}\u{11641}\u{118a3}\u{118b2}\u{118c3}\u{118d2}\u{11c41}\u{11dda}\u{11de1}\u{16d63}\u{16eaa}\u{16ec5}\u{16f16}\u{16f28}\u{1d100}\u{1d22a}\u{1d377}\u{1e141}\u{1e8c7}\u{1ed01}",
  l: "\u{141}\u{142}\u{19a}\u{234}\u{23d}\u{26b}\u{26c}\u{26d}\u{29f}\u{1d0c}\u{1d85}\u{2c60}\u{2c61}\u{2c62}\u{a748}\u{a749}\u{a78e}\u{a7ad}\u{ab37}\u{ab38}\u{ab39}\u{1df04}\u{1df11}\u{1df13}\u{1df26}",
  m: "\u{271}\u{39c}\u{3bc}\u{3fa}\u{3fb}\u{41c}\u{43c}\u{560}\u{13b7}\u{15f0}\u{16d6}\u{1d0d}\u{1d6f}\u{1d86}\u{2c6e}\u{2c98}\u{2c99}\u{a4df}\u{ab3a}\u{ab87}\u{102b0}\u{10311}\u{10c21}\u{11700}\u{118e3}",
  n: "\u{19d}\u{19e}\u{220}\u{235}\u{272}\u{273}\u{274}\u{548}\u{54c}\u{578}\u{57c}\u{1260}\u{144e}\u{1d70}\u{1d87}\u{2229}\u{22c2}\u{2c9a}\u{2c9b}\u{a4e0}\u{a4f5}\u{a790}\u{a791}\u{a7a4}\u{a7a5}\u{ab3b}\u{10513}\u{11abe}\u{16ad1}\u{1d245}\u{1df27}",
  nv: "\u{39d}\u{3bd}",
  o: "0\u{d8}\u{f8}\u{19f}\u{39f}\u{3a3}\u{3bf}\u{3c2}\u{3c3}\u{3da}\u{3db}\u{3ec}\u{3ed}\u{41e}\u{43e}\u{555}\u{585}\u{5e1}\u{647}\u{665}\u{6be}\u{6c1}\u{6d5}\u{6f5}\u{7c0}\u{7cb}\u{840}\u{966}\u{9e6}\u{a66}\u{ae6}\u{b20}\u{b66}\u{be6}\u{c02}\u{c66}\u{c82}\u{ce6}\u{d02}\u{d20}\u{d66}\u{d82}\u{e50}\u{ed0}\u{101d}\u{1040}\u{10ff}\u{110b}\u{11bc}\u{12d0}\u{17e0}\u{1a45}\u{1a80}\u{1a90}\u{1bea}\u{1c82}\u{1cbf}\u{1d0f}\u{1d11}\u{2c7a}\u{2c8a}\u{2c8b}\u{2c9e}\u{2c9f}\u{2d54}\u{3007}\u{a4f3}\u{a74a}\u{a74b}\u{a74c}\u{a74d}\u{ab3d}\u{10292}\u{102ab}\u{1030f}\u{10404}\u{1042c}\u{104c2}\u{104ea}\u{10516}\u{1092c}\u{10c17}\u{10d07}\u{11124}\u{11302}\u{114d0}\u{118a8}\u{118b5}\u{118b7}\u{118c8}\u{118d5}\u{118d7}\u{118e0}\u{11de0}\u{16ae9}\u{1df1b}\u{1e140}\u{1e2f0}",
  r: "\u{1a6}\u{24c}\u{24d}\u{27c}\u{27d}\u{27e}\u{280}\u{13a1}\u{13d2}\u{1587}\u{1d26}\u{1d72}\u{1d73}\u{1d89}\u{2c64}\u{a4e3}\u{a7a6}\u{a7a7}\u{ab46}\u{ab47}\u{ab48}\u{ab49}\u{ab71}\u{aba2}\u{104b4}\u{104dc}\u{16a19}\u{16f35}\u{1d216}\u{1df16}\u{1df28}",
  ry: "\u{413}\u{433}\u{13b1}\u{2c84}\u{2c85}\u{ab81}",
  s: "\u{1bc}\u{1bd}\u{23f}\u{282}\u{405}\u{455}\u{54f}\u{57f}\u{d1f}\u{10bd}\u{10fd}\u{13d5}\u{13da}\u{1cbd}\u{1d74}\u{1d8a}\u{2c7e}\u{2d1d}\u{a4e2}\u{a576}\u{a731}\u{a7a8}\u{a7a9}\u{a7c5}\u{a7c9}\u{a7ca}\u{a7cc}\u{a7cd}\u{aba5}\u{abaa}\u{10296}\u{10420}\u{10448}\u{118a1}\u{118c1}\u{16ad6}\u{16f3a}\u{1df1e}\u{1df29}",
  t: "\u{166}\u{167}\u{1ab}\u{1ac}\u{1ad}\u{1ae}\u{236}\u{23e}\u{288}\u{3a4}\u{3c4}\u{422}\u{442}\u{7e0}\u{13a2}\u{1c84}\u{1c85}\u{1d1b}\u{1d75}\u{22a4}\u{27d9}\u{2c66}\u{2ca6}\u{2ca7}\u{3112}\u{4e05}\u{a4d4}\u{a50b}\u{ab72}\u{10297}\u{102b1}\u{10315}\u{16f0a}\u{1d373}\u{1df09}\u{1df2a}\u{1f768}",
  ty: "\u{118bc}\u{118dc}",
  u: "\u{54d}\u{57d}\u{1200}\u{144c}\u{1d1c}\u{1d99}\u{222a}\u{22c3}\u{a4f4}\u{a79e}\u{a79f}\u{a7b8}\u{a7b9}\u{ab4e}\u{ab52}\u{104ce}\u{104f6}\u{118b8}\u{118d8}\u{16f42}",
  uv: "\u{1b2}\u{28b}",
  uy: "\u{3a5}\u{3c5}",
  v: "\u{474}\u{475}\u{5d8}\u{667}\u{6f7}\u{13d9}\u{142f}\u{1d20}\u{2228}\u{22c1}\u{2c71}\u{2c74}\u{2d38}\u{a4e6}\u{a6df}\u{a75e}\u{a75f}\u{aba9}\u{1051d}\u{10c1f}\u{11706}\u{118a0}\u{118c0}\u{16f08}\u{1cefc}\u{1d20d}\u{1e145}",
  vy: "\u{1d8c}",
  y: "\u{194}\u{1b3}\u{1b4}\u{24e}\u{24f}\u{263}\u{28f}\u{393}\u{3b3}\u{423}\u{443}\u{4ae}\u{4af}\u{7cc}\u{10e7}\u{13a9}\u{13bd}\u{14a5}\u{1ca7}\u{1efe}\u{1eff}\u{2ca8}\u{2ca9}\u{311a}\u{4e2b}\u{a4ec}\u{a7e2}\u{ab5a}\u{ab79}\u{ab8d}\u{102b2}\u{1050f}\u{10c20}\u{118a4}\u{118c4}\u{16f07}\u{16f43}",
  };
  for (const mode of ["parser", "gate"]) {
    // Control: every previously listed LETTER must still match in rendered text.
    // Base passes because these exact groups and letter-category handling already exist.
    // This guards against losing legacy coverage when adding non-letter categories.
    test(`bq-5670 ${mode} control every existing look-alike LETTER still matches`, () => {
      assertLookAlikes(mode, oldLookAlikes, true);
    });
    test(`bq-5670 ${mode} every generated non-letter look-alike matches`, () => {
      assertLookAlikes(mode, allLookAlikes, false);
    });
  }
  function assertLookAlikes(mode: string, groups: Record<string, string>, letters: boolean) {
    const names = ["Structured Assessment", "Readiness Score", "Criteria Verdicts", "Actionable Items", "Critical Bugs", "Summary"];
    for (const [readings, chars] of Object.entries(groups)) {
      for (const ch of chars) {
        if (/\p{L}/u.test(ch) !== letters) continue;
        const letter = readings[0];
        const name = names.find((candidate) => candidate.toLowerCase().includes(letter))!;
        const index = name.toLowerCase().indexOf(letter);
        const label = name.slice(0, index) + ch + name.slice(index + 1);
        // Escape a pipe in Markdown only where it could become table syntax;
        // these headings otherwise use each actual rendered character verbatim.
        const markdown = append(`#### ${label}\n\n${CRASH}`);
        const context = `${name} U+${ch.codePointAt(0)!.toString(16)}`;
        if (mode === "gate") assertGateFailure(labelGate(markdown), /fatal parse errors/);
        const result = parsed(markdown);
        assert.equal(result.readiness_pct, 0, context);
        assert.ok(result.parse_errors!.length > 0, context);
      }
    }
  }

  // bq-5670 FOLD1 START: dual nonletter readings, suffix alphabet and full emphasis context.
  function assertFoldLabel(mode: string, markdown: string, rejected: boolean, criterion?: string) {
    if (mode === "gate") {
      const checked = labelGate(markdown, criterion);
      if (rejected) assertGateFailure(checked, labelReason);
      else assert.equal(checked.status, 0, checked.output);
    }
    const result = parsed(markdown);
    if (rejected) {
      assert.equal(result.readiness_pct, 0);
      assert.equal(result.critical_bugs, true);
      assert.match(result.parse_errors!.join("; "), labelReason);
    } else {
      assert.deepEqual(result.parse_errors, []);
      assert.equal(result.readiness_pct, 90);
      assert.equal(result.critical_bugs, false);
      if (criterion) assert.deepEqual(result.criteria, { [criterion]: "GOOD" });
    }
  }
  const foldReproductions = [
    { name: "P1-1 Critica combining mark l Bugs verbatim", markdown:
      append("#### Critica\u0345l Bugs\n\nThe application crashes and loses data."), rejected: true },
    { name: "P1-1 Critical pipe Bugs verbatim", markdown:
      append("#### Critical | Bugs\n\nThe application crashes and loses data."), rejected: true },
    // confusables.txt:2685 maps U+0192 LATIN SMALL LETTER F WITH HOOK to f.
    { name: "P1-2 hooked f in found verbatim", markdown:
      append("#### Critical Bugs \u0192ound:\n\nThe application crashes and loses data."), rejected: true },
    { name: "P1-3 emphasized Summary comprehension verbatim", markdown:
      TERMINAL_ASSESSMENT.replace("Onboarding Clarity", "**Summary** comprehension"),
      rejected: false, criterion: "summary_comprehension" },
    { name: "P1-3 emphasized Critical bug methodology verbatim", markdown:
      "## **Critical bug** reporting methodology\n\nThe test checks data integrity.\n\n" + TERMINAL_ASSESSMENT,
      rejected: false },
  ];
  // One independent supplied-data substitution for every distinct suffix letter.
  // Includes symbols as well as letters, so neither reading can replace the other.
  const suffixLookAlikes: Record<string, string> = {
    s: "\u0455", f: "\u0192", o: "\u043e", u: "\u222a", n: "\u2229", d: "\u0501",
  };
  const supportedSuffixes = ["", "s", "found", "sfound"];
  for (const mode of ["parser", "gate"]) {
    for (const entry of foldReproductions) {
      test(`bq-5670 fold1 ${mode} ${entry.name}`, () =>
        assertFoldLabel(mode, entry.markdown, entry.rejected, entry.criterion));
    }
    for (const [category, ch] of [["combining mark", "\u0345"], ["pipe", "|"]]) {
      // Control: impl1 already reads a mapped nonletter as a substituted letter.
      // Protect this new reading while restoring the BASE separator/gap reading.
      test(`bq-5670 fold1 ${mode} P1-1 ${category} substitution control`, () =>
        assertFoldLabel(mode, append(`#### Critica${ch} Bugs\n\n${CRASH}`), true));
      test(`bq-5670 fold1 ${mode} P1-1 ${category} insertion`, () =>
        assertFoldLabel(mode, append(`#### Critica${ch}l Bugs\n\n${CRASH}`), true));
      test(`bq-5670 fold1 ${mode} P1-1 ${category} separator`, () =>
        assertFoldLabel(mode, append(`#### Critical ${ch} Bugs\n\n${CRASH}`), true));
    }
    test(`bq-5670 fold1 ${mode} P1-1 all mapped nonletters keep insertion and separator readings`, () => {
      for (const chars of Object.values(allLookAlikes)) {
        for (const ch of chars) {
          if (/\p{L}/u.test(ch)) continue;
          for (const label of [`Critica${ch}l Bugs:`, `Critical ${ch} Bugs:`]) {
            assertFoldLabel(mode, append(`#### ${label}\n\n${CRASH}`), true);
          }
        }
      }
    });
    test(`bq-5670 fold1 ${mode} P1-1 mapped combining gap after a complete label`, () =>
      assertFoldLabel(mode, append(`#### Critical Bugs\u0345\n\n${CRASH}`), true));
    for (const suffix of supportedSuffixes) {
      // Control: impl1 already recognizes every ASCII suffix, at a colon or end.
      // Protect all admitted forms while adding look-alikes to the suffix alphabet.
      test(`bq-5670 fold1 ${mode} P1-2 ASCII suffix ${suffix || "empty"} control`, () => {
        for (const delimiter of ["", ":"]) {
          assertFoldLabel(mode, append(`#### Critical Bug${suffix}${delimiter}\n\n${CRASH}`), true);
        }
      });
      for (const letter of new Set(suffix)) {
        test(`bq-5670 fold1 ${mode} P1-2 suffix ${suffix} letter ${letter}`, () => {
          const index = suffix.indexOf(letter);
          const decorated = suffix.slice(0, index) + suffixLookAlikes[letter] + suffix.slice(index + 1);
          for (const delimiter of ["", ":"]) {
            assertFoldLabel(mode, append(`#### Critical Bug${decorated}${delimiter}\n\n${CRASH}`), true);
          }
        });
      }
    }
    test(`bq-5670 fold1 ${mode} P1-2 look-alike suffix followed by narrative stays narrative`, () => {
      for (const suffix of supportedSuffixes.filter(Boolean)) {
        for (const letter of new Set(suffix)) {
          const index = suffix.indexOf(letter);
          const decorated = suffix.slice(0, index) + suffixLookAlikes[letter] + suffix.slice(index + 1);
          assertFoldLabel(mode, append(`#### Critical Bug${decorated} during training was an example.`), false);
        }
      }
    });
    const emphasisCases = [
      // Closing emphasis at the start, middle and end of the continuation must
      // retain the whole criterion/heading, never manufacture an isolated label.
      ["start", "**Summary** comprehension", "**Critical bug** reporting methodology"],
      ["middle", "**Summary compre**hension", "**Critical bug reporting** methodology"],
      ["end", "**Summary comprehension**", "**Critical bug reporting methodology**"],
      ["middle span", "Summary **compre**hension", "Critical bug **reporting** methodology"],
      ["end span", "Summary comprehen**sion**", "Critical bug reporting **methodology**"],
      ["adjacent spans", "**Summary** **comprehension**", "**Critical bug** **reporting methodology**"],
      ["nested spans", "***Summary*** comprehension", "***Critical bug*** reporting methodology"],
      ["italic", "*Summary* comprehension", "*Critical bug* reporting methodology"],
    ];
    for (const [position, criterion, heading] of emphasisCases) {
      test(`bq-5670 fold1 ${mode} P1-3 criterion emphasis ${position}`, () =>
        assertFoldLabel(mode, TERMINAL_ASSESSMENT.replace("Onboarding Clarity", criterion), false, "summary_comprehension"));
      test(`bq-5670 fold1 ${mode} P1-3 heading emphasis ${position}`, () =>
        assertFoldLabel(mode, `## ${heading}\n\nThe test checks data integrity.\n\n${TERMINAL_ASSESSMENT}`, false));
    }
    test(`bq-5670 fold1 ${mode} P1-3 item and internal span preserve continuation`, () => {
      for (const prefix of ["", "Note: ", "`literal` "]) {
        for (const narrative of ["**Summary** comprehension", "**Critical bug** reporting methodology"]) {
          for (const container of ["", "- ", "1. ", "> "]) {
            assertFoldLabel(mode, append(`${container}${prefix}${narrative}`), false);
          }
        }
      }
    });
    // Controls: impl1 detects whole emphasized labels, with colon inside or
    // after emphasis, and whole plain labels. Preserve those forms. A name
    // split by an emphasis close also regresses when preceded by prose/code:
    // its complete continuation must still supply the rest of the label.
    test(`bq-5670 fold1 ${mode} P1-3 real emphasized labels keep colon and end boundaries`, () => {
      for (const label of ["**Critical Bugs:**", "**Critical Bugs**:", "**Critical Bugs**",
        "***Critical Bugs***:", "Critical **Bugs**:", "**Critical** Bugs:", "**Critical Bugs Found**:"]) {
        for (const prefix of (label.startsWith("**Critical") ? ["", "Note: ", "`literal` "] : [""])) {
          assertFoldLabel(mode, append(`${prefix}${label}\n\n${CRASH}`), true);
        }
      }
    });
  }

  // bq-5670 FOLD2 START: hard-break alternatives and linear emphasis work.
  const hardBreaks = [["spaces", "  \n"], ["backslash", "\\\n"]];
  const emphasisLabels = ["**Critical Bugs**", "*Critical Bugs*", "_Critical Bugs_"];
  for (const mode of ["parser", "gate"]) {
    // Review reproduction verbatim, including its two spaces and crash wording.
    test(`bq-5670 fold2 ${mode} P1 review reproduction verbatim`, () =>
      assertFoldLabel(mode, append("Note: **Critical Bugs**  \nThe application crashes and loses data."), true));
    for (const [syntax, hardBreak] of hardBreaks) {
      for (const label of emphasisLabels) {
        test(`bq-5670 fold2 ${mode} P1 ${label} ${syntax} hard break`, () =>
          assertFoldLabel(mode, append(`Note: ${label}${hardBreak}The application crashes and loses data.`), true));
      }
      test(`bq-5670 fold2 ${mode} P1 generated hard-break context ${syntax}`, () => {
        for (const prefix of ["Note: ", "`literal` ", "- Note: ", "> Note: "]) {
          for (const label of ["***Critical Bugs***", "**Critical** Bugs", "**Critical\nBugs**",
            "**Critical**\nBugs", "**Critical Bugs** Found", "**Critical Bugs** *Found*"]) {
            assertFoldLabel(mode, append(`${prefix}${label}${hardBreak}${CRASH}`), true);
          }
        }
      });
      // Both alternatives matter: the name/suffix may cross the first hard
      // break, but a second break must not invent an extra emphasis endpoint.
      test(`bq-5670 fold2 ${mode} full continuation retained ${syntax}`, () => {
        assertFoldLabel(mode, append(`Note: **Critical**${hardBreak}Bugs:`), true);
        assertFoldLabel(mode, append(`Note: **Critical Bugs**${hardBreak}Found:`), true);
        assertFoldLabel(mode, append(`Note: **Critical**${hardBreak}Bugs${hardBreak}ordinary text`), false);
        assertFoldLabel(mode, append(`Note: **Critical${hardBreak}Bugs** comprehension${hardBreak}ordinary text`), false);
      });
    }
    // Controls pass fold1: soft breaks retain the whole continuation; closing
    // emphasis alone never completes a label in ordinary narrative.
    test(`bq-5670 fold2 ${mode} soft-break controls`, () => {
      for (const label of emphasisLabels) {
        assertFoldLabel(mode, append(`Note: ${label}\nThe application crashes and loses data.`), false);
      }
    });
    test(`bq-5670 fold2 ${mode} Summary comprehension control`, () =>
      assertFoldLabel(mode, TERMINAL_ASSESSMENT.replace("Onboarding Clarity", "**Summary** comprehension"), false, "summary_comprehension"));
    test(`bq-5670 fold2 ${mode} Critical bug methodology control`, () =>
      assertFoldLabel(mode, "## **Critical bug** reporting methodology\n\nThe test checks data integrity.\n\n" + TERMINAL_ASSESSMENT, false));
    test(`bq-5670 fold2 ${mode} P2 emphasis scaling median`, () => {
      const median = (n: number) => {
        const markdown = append("**ordinary** ".repeat(n));
        const times: number[] = [];
        for (let run = 0; run < 3; run++) {
          const start = performance.now();
          assertFoldLabel(mode, markdown, false);
          times.push(performance.now() - start);
        }
        return times.sort((a, b) => a - b)[1];
      };
      const small = median(800);
      const large = median(3200);
      console.log(`    fold2 ${mode} scaling: median800=${small.toFixed(3)}ms median3200=${large.toFixed(3)}ms ratio=${(large / small).toFixed(3)}`);
      assert.ok(large / small < 8, `emphasis scaling ratio ${large / small} must stay below 8`);
      assert.ok(large < 2000, `3200 emphasis spans took ${large}ms; limit 2000ms`);
    });
  }

  // bq-5712 START: resolved depth, refusal before ANY replay, and measured work.
  // Freeze the policy independently of the production constant, so raising it
  // or shifting either boundary cannot make the expectations move with it.
  const emphasisDepthLimit = 100;
  const depthParser = new DepthMarkdownIt({ html: true, typographer: false, linkify: true, maxNesting: 100 });
  function resolvedDepth(markdown: string): number {
    let maximum = 0;
    const visit = (tokens: ReturnType<typeof depthParser.parse>) => {
      let depth = 0;
      for (const token of tokens) {
        if (token.type === "strong_open" || token.type === "em_open") maximum = Math.max(maximum, ++depth);
        if (token.type === "strong_close" || token.type === "em_close") depth--;
        if (token.children) visit(token.children);
      }
    };
    visit(depthParser.parse(markdown, {}));
    return maximum;
  }
  const replayHook = parserModule as unknown as {
    setReplayWorkObserverForTests?: (observer?: (units: number) => void) => void;
  };
  function measuredDepthCase(mode: string, paragraph: string, depth: number, prefix = ""): number {
    assert.equal(resolvedDepth(paragraph), depth, "independently resolved generator depth");
    let work = 0;
    const hooked = typeof replayHook.setReplayWorkObserverForTests === "function";
    replayHook.setReplayWorkObserverForTests?.((units) => { work += units; });
    let result: ReturnType<typeof parsed> | undefined;
    let checked: ReturnType<typeof labelGate> | undefined;
    try {
      const markdown = append(prefix + paragraph);
      if (mode === "gate") checked = labelGate(markdown);
      else result = parsed(markdown);
    } finally {
      replayHook.setReplayWorkObserverForTests?.();
    }
    console.log(`    depth-work ${mode}: depth=${depth} length=${paragraph.length} work=${hooked ? work : "HOOK_ABSENT"}`);
    if (depth > emphasisDepthLimit) {
      if (checked) assertGateFailure(checked, /resolved emphasis depth/);
      if (result) {
        assert.equal(result.readiness_pct, 0, "over-depth report must be refused");
        assert.match(result.parse_errors!.join("; "),
          new RegExp(`resolved emphasis depth ${depth} exceeds limit ${emphasisDepthLimit}`));
      }
      assert.ok(hooked, "replay work hook must be available in tests");
      assert.equal(work, 0, "refusal must precede ALL replay work");
    } else {
      if (checked) assert.equal(checked.status, 0, checked.output);
      if (result) {
        assert.deepEqual(result.parse_errors, []);
        assert.equal(result.readiness_pct, 90);
        assert.equal(result.critical_bugs, false);
      }
      assert.ok(hooked, "replay work hook must be available in tests");
      // Counts every replay state update (including the terminal state).
      // 200 bounds the fixed sum of grammar widths across all label queries.
      assert.ok(work <= 200 * emphasisDepthLimit * paragraph.length,
        `replay work ${work} exceeds linear budget ${200 * emphasisDepthLimit * paragraph.length}`);
    }
    return work;
  }
  // Independent generator: underscore delimiter runs, with an odd run mixing
  // em and strong; ordinary content on both sides of the internal break.
  function depthParagraph(depth: number, syntax: string, mixed: boolean, size = 8): string {
    const marker = "_".repeat(2 * depth - (mixed ? 1 : 0));
    const separator = syntax === "plain" ? " " : syntax === "spaces" ? "  \n" : "\\\n";
    return `Note: ${marker}Critical${separator}Bugs ${"ordinary ".repeat(size)}tail${marker}${separator}ordinary text`;
  }
  for (const mode of ["parser", "gate"]) {
    for (const n of [200, 800]) {
      test(`bq-5712 ${mode} reviewer generator VERBATIM n=${n}`, () => {
        const suffix =
          "Note: " + "*".repeat(n) +
          "Critical  \nBugs " + "ordinary ".repeat(n) +
          "tail" + "*".repeat(n) + "  \nordinary text";
        const work = measuredDepthCase(mode, suffix, n / 2);
        if (n === 200) assert.ok(work > 0, "admitted reviewer case must exercise real replay");
      });
    }
    for (const depth of [emphasisDepthLimit - 1, emphasisDepthLimit, emphasisDepthLimit + 1, 2 * emphasisDepthLimit, 400]) {
      for (const syntax of ["plain", "spaces", "backslash"]) {
        for (const mixed of [false, true]) {
          test(`bq-5712 ${mode} own depth=${depth} ${syntax} ${mixed ? "em+strong" : "strong"}`, () => {
            const work = measuredDepthCase(mode, depthParagraph(depth, syntax, mixed), depth);
            if (depth <= emphasisDepthLimit && syntax !== "plain") {
              assert.ok(work > 0, "internal hard break must exercise real replay");
            }
          });
        }
      }
    }
    test(`bq-5712 ${mode} replay work grows with paragraph length within bound`, () => {
      for (const depth of [1, 50, emphasisDepthLimit - 1, emphasisDepthLimit]) {
        for (const syntax of ["spaces", "backslash"]) {
          let previous = 0;
          for (const size of [16, 64, 256]) {
            const work = measuredDepthCase(mode, depthParagraph(depth, syntax, true, size), depth);
            // For this ASCII generator every span covers 18 + 9*size tokens.
            // Only criticalbug (four suffix widths 12+13+17+18) and
            // criteriaverdicts (width 17) enter replay: exactly 77 state
            // updates per displayed token per span, independently of the hook.
            assert.equal(work, depth * (18 + 9 * size) * 77,
              "work hook must count the actual replay state updates");
            assert.ok(work > previous, "work hook must measure changing replay work, never a constant");
            previous = work;
          }
        }
      }
    });
    test(`bq-5712 ${mode} later refusal prevents earlier paragraph replay`, () => {
      measuredDepthCase(mode, depthParagraph(emphasisDepthLimit + 1, "backslash", true),
        emphasisDepthLimit + 1, depthParagraph(2, "spaces", true) + "\n\n");
    });
    test(`bq-5712 ${mode} literal delimiter runs do not create resolved depth`, () => {
      const literal = "`" + "*".repeat(800) + " ordinary " + "*".repeat(800) + "`";
      assert.equal(resolvedDepth(literal), 0);
      measuredDepthCase(mode, literal, 0);
    });
    test(`bq-5712 ${mode} link nesting is not emphasis depth at N`, () => {
      const marker = "*".repeat(2 * emphasisDepthLimit - 1);
      for (const hardBreak of ["  \n", "\\\n"]) {
        const paragraph = `Note: [${marker}Critical${hardBreak}Bugs ordinary tail${marker}](https://example.com)${hardBreak}ordinary text`;
        const work = measuredDepthCase(mode, paragraph, emphasisDepthLimit);
        assert.ok(work > 0, "linked emphasis at N must be admitted and replayed");
      }
    });
    test(`bq-5712 ${mode} nested label crossing internal hard breaks remains fatal at N`, () => {
      for (const hardBreak of ["  \n", "\\\n"]) {
        const marker = "*".repeat(2 * emphasisDepthLimit - 1);
        assertFoldLabel(mode, append(`Note: ${marker}Critical${hardBreak}Bugs${marker}${hardBreak}${CRASH}`), true);
      }
    });
  }
  // bq-5712 END

  // bq-5670 FOLD2 END
  // bq-5670 FOLD1 END
  // bq-5670 END
}
// FOLD 2 END

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
