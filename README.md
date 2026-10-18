# Persona Testing

AI persona testing framework. Define user personas, run automated UX testing with browser automation, get structured feedback from the perspective of real users.

## The Problem

You build software. You test it yourself. You think it works. Then a real user sits down and can't find the button you spent a week building.

User testing is expensive, slow, and usually happens too late. What if you could run it on every deploy?

## How It Works

1. **Define personas** in YAML: who they are, what they're trying to do, how they evaluate success
2. **Run probes**: each persona navigates your app via browser automation, evaluating it from their perspective
3. **Get structured reports**: pass/fail per criteria, actionable items classified as fixable or tradeoff, readiness scores

```
                    ┌──────────────┐
  persona.yml ─────>│              │──────> report.md
                    │ Persona      │
  app URL ─────────>│ Probe        │──────> structured.json
                    │              │
                    └──────────────┘
```

The persona doesn't know your codebase. It only knows its job title, goals, and success criteria. It navigates your app like a real user would.

## Quick Start

```bash
# 1. Install (the CLI plus the Playwright Chromium binaries)
npm install -g persona-testing
npx playwright install chromium

# 2. Create a persona
persona-testing init --name "New User" --output personas/new-user.yml

# 3. Create a fresh invocation file for this run, outside the reports directory
persona-testing prepare --output .persona-invocation.json

# 4. Run a probe into a fresh reports directory
persona-testing run --invocation .persona-invocation.json \
  --persona personas/new-user.yml --url https://your-app.com --output-dir reports/

# 5. Read the report (filenames embed a unique run ID)
cat reports/new-user-*.md
```

Every `run` and `check` needs `--invocation <file>` from `prepare`. `prepare`
refuses to overwrite an existing file, and an invocation expires six hours after
it was created, so make a new one (and a new reports directory) for each run.

## Persona Definition

Personas are YAML files that describe a user:

```yaml
name: Sarah Martinez
title: Water Utility Director
experience: 15 years in utility management
technical_comfort: moderate

context: |
  Sarah needs to prepare a rate increase proposal for her city council.
  She has 30 days to build a convincing financial case. She's used Excel
  for years but is evaluating new software.

goals:
  - Create a financial scenario for next fiscal year
  - Generate charts showing revenue projections
  - Export a presentation for council members

scenarios:
  - name: First Login
    description: Navigate the app for the first time
    success: Can orient within 5 minutes

  - name: Create Scenario
    description: Build a basic financial projection
    success: Scenario created with at least 3 line items

  - name: Export Report
    description: Generate something presentable for stakeholders
    success: PDF or presentation exported successfully

evaluation_criteria:
  - name: Onboarding Clarity
    weight: critical
    question: Did the app guide me without training?

  - name: Terminology
    weight: high
    question: Did the words make sense to me?

  - name: Presentation Ready
    weight: high
    question: Would I show this to my city council?

voice: |
  Speak as Sarah would: practical, time-pressured, not technical.
  "I don't have time to figure this out - show me the numbers."
  "If I can't explain this chart, the council won't approve anything."

known_routes:
  Dashboard: /dashboard
  Scenarios: /scenarios
  Settings: /settings

critical_bug_protocol:
  stop_on: page_fails_to_render, data_not_loading, auth_failure
  continue_on: minor_ui_issues, slow_loading
```

### Gate-capable and exploratory personas

The `run`/`check` CLI path is gate-capable and therefore validates personas
strictly. A gate-capable persona needs at least 20 characters of substantive
`context`/`goals` instructions, one scenario with non-empty `name`,
`description`, and `success` fields, and one evaluation criterion with a
non-empty `name`, valid `weight`, and non-empty `question`. Unknown keys are
rejected with a nearest-key suggestion; a name-only persona cannot produce CI
gate evidence.

The runtime validator also supports an explicit `exploratory` mode for non-gating
integrations that intentionally accept a name-only persona. Exploratory output
must remain advisory and must not be submitted to `persona-testing check`; the
CLI intentionally defaults to gate-capable validation.

## Report Output

Each probe produces:

### Markdown Report (`reports/{persona}-{run-id}.md`)

Human-readable narrative from the persona's perspective:
- Executive summary
- First impressions
- What worked, what didn't
- Confidence assessment
- Recommendations

### Structured JSON (`reports/{persona}-{run-id}.json`)

Machine-parseable results for CI/CD integration:

```json
{
  "persona": "sarah-martinez",
  "timestamp": "2026-02-16T10:30:00Z",
  "url": "https://your-app.com",
  "terminal_state": "PASSED",
  "readiness_pct": 65,
  "critical_bugs": false,
  "criteria": {
    "onboarding_clarity": "GOOD",
    "terminology": "FAIR",
    "presentation_ready": "POOR"
  },
  "items": [
    {
      "description": "Export button not discoverable from main dashboard",
      "priority": "high",
      "classification": "fixable"
    },
    {
      "description": "No chart customization for council presentations",
      "priority": "medium",
      "classification": "tradeoff"
    }
  ]
}
```

### Classification

Each finding is classified:
- **fixable**: CSS change, label update, navigation link, component tweak
- **tradeoff**: New feature, architectural change, significant design decision
- **false_positive**: Misunderstanding of existing feature

## Multiple Personas

Run multiple personas to test different user perspectives:

```bash
# Run all personas in a directory
persona-testing prepare --output .persona-invocation.json
persona-testing run --invocation .persona-invocation.json \
  --personas personas/ --url https://your-app.com --output-dir reports/

# Run specific personas (a new invocation file and reports directory per run)
persona-testing prepare --output .persona-invocation-2.json
persona-testing run \
  --invocation .persona-invocation-2.json \
  --persona personas/new-user.yml \
  --persona personas/power-user.yml \
  --persona personas/admin.yml \
  --url https://your-app.com \
  --output-dir reports-2/
```

## CI/CD Integration

Use the structured JSON output to gate deployments:

```yaml
# GitHub Actions example (a fresh job workspace: no earlier invocation file or reports)
- name: Prepare the gate invocation
  run: |
    # Outside the reports directory; check refuses one stored inside it
    persona-testing prepare --output "$RUNNER_TEMP/persona-invocation.json"

- name: Run persona tests
  run: |
    persona-testing run \
      --invocation "$RUNNER_TEMP/persona-invocation.json" \
      --personas personas/ \
      --url ${{ env.STAGING_URL }} \
      --output-dir reports/

- name: Check readiness
  run: |
    # Fail if any persona scores below 60%
    persona-testing check \
      --invocation "$RUNNER_TEMP/persona-invocation.json" \
      --reports reports/ --min-readiness 60
```

`run` writes a `run-manifest.json` alongside the reports, bound to the
invocation file; `check` verifies the manifest, the reports and their signed
tool evidence against that same file, so reports from an earlier run can never
satisfy the gate. They can break it: any report or evidence file in the
directory that the manifest does not name fails `check`, so give every
invocation its own fresh reports directory.
`check` exits non-zero on low readiness, critical bugs, or any terminal state
other than `PASSED`. Deadline/token exhaustion is `BUDGET_EXHAUSTED`;
iteration-limited or otherwise incomplete evidence is `INCOMPLETE`. Neither
can be converted into a pass by model prose or readiness score. Unknown
commands and flags are hard errors (exit code 2), so a typo can't silently
skip the gate.

**CI security note:** persona YAML is injected into the model prompt. Load
personas from a trusted branch or pinned artifact — never from untrusted
pull-request content. See [SECURITY.md](SECURITY.md).

## Examples

See `examples/` for ready-to-use persona definitions:

- `examples/new-user.yml` - First-time user with no training
- `examples/power-user.yml` - Experienced user evaluating advanced features
- `examples/accessibility.yml` - Accessibility-minded reviewer (heuristic only — see the caveat in the file; this is **not** real screen-reader or WCAG-contrast testing)

## How Probes Work

Under the hood, each probe:

1. Launches a browser via Playwright
2. Navigates to your app URL
3. The AI model (Claude, GPT, etc.) receives the persona definition and controls the browser
4. It evaluates the app from the persona's perspective, taking screenshots and notes
5. Produces a structured report

The persona definition *guides* the AI's behavior: it doesn't know implementation details, only what a real user in that role would know and expect. Persona and page text are prompts, not a security boundary — the enforced boundaries (origin-restricted navigation, budgets, input validation) live in code. See [Security](#security).

## Security

The agent's navigation is **restricted to the target URL's origin**, enforced
in code: `file:`, `data:`, `javascript:`, and cross-origin URLs are refused,
and link-clicks or redirects that escape the origin are reverted. Each run is
bounded by an iteration cap, a wall-clock deadline, and token budgets.
Credentials, query strings, and fragments in URLs are redacted from prompts
and reports (URL *paths* are preserved — avoid magic-link or reset-token
paths like `/reset/<token>`), and typed text is never echoed into the model
transcript. Before every model request, the provider loop verifies that the
remaining deadline and token allowance can cover it, caps output tokens to
the remaining allowance, and aborts the request at the remaining deadline.
No post-limit wrap-up request is made.

What code cannot eliminate: text on the tested page is input to the model, so
a hostile page can still try to skew the *content* of the assessment. Do not
run this against sites you don't trust, and treat reports as advisory — full
threat model in [SECURITY.md](SECURITY.md).

```bash
# Allow an additional origin (e.g. a separate auth domain) when needed:
persona-testing run --invocation .persona-invocation.json --persona p.yml \
  --url https://app.example.com --allow-origin https://auth.example.com
```

## Requirements

- Node.js 20+
- Playwright Chromium binaries (`npx playwright install chromium`)
- An AI model API key (Claude, OpenAI, etc.)

## Configuration

```bash
# Set your AI provider
export PERSONA_TESTING_PROVIDER=anthropic  # or openai
export PERSONA_TESTING_API_KEY=your-key

# Or use a non-secret config file. Keep the API key in the environment.
cat > .persona-testing.yml << EOF
provider: anthropic
model: claude-sonnet-4-6
screenshot_dir: ./screenshots
report_dir: ./reports
# Optional guardrail tuning (defaults shown)
max_iterations: 50          # model loop cap, hard max 100
timeout_ms: 900000          # AI loop deadline, starting before its first request
request_timeout_ms: 120000  # per-API-request timeout
max_input_tokens: 1000000   # cumulative input-token budget per run
max_output_tokens: 64000    # cumulative output-token budget per run
# allowed_origins:          # extra origins the agent may navigate to
#   - https://auth.example.com
EOF
```

Configuration fails closed: unknown keys, misspellings, unsupported `browser`
selection, and correctly named keys with the wrong type are errors. The CLI
currently loads `.persona-testing.yml` or `.persona-testing.yaml`. Those files
can technically contain `api_key`, but environment variables are safer and
take precedence. Never commit a credential-bearing config; downstream
repositories should ignore dotted/undotted `.yml`/`.yaml` names and their
`.local` variants.

Run flags: `--invocation <file>` (required), `--persona` (repeatable),
`--personas <dir>`, `--url`, `--output-dir`, `--screenshot-dir`,
`--max-iterations`, `--timeout-ms`, `--allow-origin` (repeatable). Check flags:
`--invocation <file>` (required), `--reports <dir>`, `--min-readiness`. Run
`persona-testing --help` for details.

## Acknowledgements

Born from testing a financial SaaS application with AI personas at [Ashita Orbis](https://ashitaorbis.com). Three personas (a new director, a rate advocate, and a capital planner) found more UX issues in automated runs than months of manual testing.

## License

MIT
