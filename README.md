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
# 1. Install
npm install -g persona-testing

# 2. Create a persona
persona-testing init --name "New User" --output personas/new-user.yml

# 3. Run a probe
persona-testing run --persona personas/new-user.yml --url https://your-app.com

# 4. Read the report
cat reports/new-user-2026-02-16.md
```

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

## Report Output

Each probe produces:

### Markdown Report (`reports/{persona}-{date}.md`)

Human-readable narrative from the persona's perspective:
- Executive summary
- First impressions
- What worked, what didn't
- Confidence assessment
- Recommendations

### Structured JSON (`reports/{persona}-{date}.json`)

Machine-parseable results for CI/CD integration:

```json
{
  "persona": "sarah-martinez",
  "timestamp": "2026-02-16T10:30:00Z",
  "url": "https://your-app.com",
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
persona-testing run --personas personas/ --url https://your-app.com

# Run specific personas
persona-testing run \
  --persona personas/new-user.yml \
  --persona personas/power-user.yml \
  --persona personas/admin.yml \
  --url https://your-app.com
```

## CI/CD Integration

Use the structured JSON output to gate deployments:

```yaml
# GitHub Actions example
- name: Run persona tests
  run: |
    persona-testing run \
      --personas personas/ \
      --url ${{ env.STAGING_URL }} \
      --output-dir reports/
      --json

- name: Check readiness
  run: |
    # Fail if any persona scores below 60%
    persona-testing check --reports reports/ --min-readiness 60
```

## Examples

See `examples/` for ready-to-use persona definitions:

- `examples/new-user.yml` - First-time user with no training
- `examples/power-user.yml` - Experienced user evaluating advanced features
- `examples/accessibility.yml` - User testing with screen reader and keyboard navigation

## How Probes Work

Under the hood, each probe:

1. Launches a browser via Playwright
2. Navigates to your app URL
3. The AI model (Claude, GPT, etc.) receives the persona definition and controls the browser
4. It evaluates the app from the persona's perspective, taking screenshots and notes
5. Produces a structured report

The persona definition constrains the AI's behavior: it doesn't know implementation details, only what a real user in that role would know and expect.

## Requirements

- Node.js 20+
- A Playwright-compatible browser
- An AI model API key (Claude, OpenAI, etc.)

## Configuration

```bash
# Set your AI provider
export PERSONA_TESTING_PROVIDER=anthropic  # or openai
export PERSONA_TESTING_API_KEY=your-key

# Or use a config file
cat > .persona-testing.yml << EOF
provider: anthropic
model: claude-sonnet-4-5-20250929
browser: chromium
screenshot_dir: ./screenshots
report_dir: ./reports
EOF
```

## Acknowledgements

Born from testing a financial SaaS application with AI personas at [Ashita Orbis](https://ashitaorbis.com). Three personas (a new director, a rate advocate, and a capital planner) found more UX issues in automated runs than months of manual testing.

## License

MIT
