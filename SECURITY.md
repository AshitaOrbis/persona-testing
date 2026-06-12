# Security Model

persona-testing drives an AI agent with browser tools against a target web
application. That architecture has an irreducible property you should
understand before running it: **everything the agent reads on the tested page
becomes input to the model that controls the browser.** This document
describes what the tool enforces in code, what it merely mitigates, and what
remains inherent to the design.

## Enforced in code (not just in the prompt)

| Control | Where | What it does |
|---------|-------|--------------|
| Origin-restricted navigation | `src/policy.ts`, `src/tools.ts` | Model-requested navigation is only allowed to the target URL's origin (plus origins explicitly allowlisted via `--allow-origin` / `allowed_origins`). `file:`, `data:`, `javascript:`, `ftp:`, and all cross-origin URLs are refused. |
| Cross-origin escape recovery | `src/tools.ts` | The page origin is re-checked before **every** tool call (covering clicks, key presses, redirects, and page-initiated escapes like `<meta refresh>` or timed `location` changes). If the page left the allowed origins, the bridge navigates back, reports the violation to the model, and counts it in run stats — read-only tools never observe a foreign page. If the operator's initial URL itself redirects (http→https, apex→www), the landing origin is added to the allowlist and logged. |
| Private-origin allowlist refusal | `src/policy.ts` | `--allow-origin` refuses localhost/loopback/RFC1918/link-local/metadata addresses (the target URL itself may be localhost for local testing). |
| URL redaction | `src/policy.ts` | Credentials, query strings, and fragments are stripped from every URL that enters the model prompt, tool results, reports, or logs. The full URL is used only for the programmatic initial navigation. **URL paths are NOT redacted** — do not point the tool at path-embedded secrets (magic links, `/reset/<token>` URLs). |
| No credential echo | `src/tools.ts` | The `type` tool reports only the number of characters typed, never the text, so passwords/API keys cannot leak into the transcript or reports. |
| Tool input validation | `src/tools.ts` | Required string inputs are checked; wait timeouts are clamped to 30 s. |
| Tool result size cap | `src/tools.ts` | Every tool result is truncated to 20,000 characters before reaching the model (defeats accessibility-tree token bombs). |
| Run budgets | `src/loop.ts` | Iteration cap (hard max 100), wall-clock deadline (default 15 min/persona), cumulative input/output token budgets, and per-request API timeouts. |
| Runtime schema validation | `src/validate.ts` | Persona and config YAML are validated before any browser or model call. |
| Bounded CI gates | `src/parser.ts`, `src/index.ts` | Readiness scores outside 0–100 are rejected (a page that prompt-injects "Readiness Score: 999%" cannot pass a gate); `--min-readiness` must be an integer 0–100; unknown commands/flags are hard errors. |
| Run manifests | `src/reporter.ts` | `check` consumes the manifest written by the most recent `run`, so stale reports cannot satisfy a CI gate. |
| Tool-health gating | `src/index.ts` | A run where most tool calls failed is reported INCONCLUSIVE by `check` and fails the gate, regardless of the model's prose. |

## Mitigated, but not eliminated

**Prompt injection from the tested page.** Page text cannot make the agent
leave the target origin, read local files, or blow the budget — those are
enforced in code. But page text CAN still influence what the model *writes*:
a hostile page can try to talk the agent into a rosier (or harsher)
assessment, fabricated findings, or a malformed report. The out-of-range
score rejection and structured parsing reduce the blast radius, yet the
report content itself is model output influenced by page content. **Treat
reports from untrusted or compromised targets as untrusted.** Do not use
this tool as a security gate against adversarial sites; it is a UX evaluation
tool for sites you trust.

**Same-origin exfiltration.** The agent can type into forms and click buttons
on the target origin. A compromised target page could, in principle, get data
the agent has observed (page content from the same site) submitted back to
itself. Since everything the agent knows about the app came from the app,
the exposure is limited — but persona context (which you author) is also in
the model's context and could be coaxed into a form field. Don't put secrets
in persona files.

**Subresource requests.** The origin policy governs page navigation, not the
target page's own network activity (its scripts, images, XHR). A tested page
can always phone home to third parties — that is the tested app's behavior,
not the agent's.

## Trust assumptions

| Input | Trust level | Notes |
|-------|------------|-------|
| `--url` target | Trusted | The operator chooses what to test. Test only sites you trust or control. |
| Persona YAML | Trusted | Persona text is wrapped in data delimiters and schema-validated, but it is still prompt text. **In CI, load personas only from trusted branches/pinned paths** — a malicious persona file can skew results and waste budget (it cannot widen navigation or read local files). |
| Page content | Untrusted | Enforced controls above apply. Report content is still influenced by it. |
| Model output | Untrusted | Parsed with bounds checks; never executed; tool calls validated and policy-checked. |

## Secrets

- API keys are read from environment variables or the local config file and
  are never written to reports or sent anywhere except the chosen AI provider.
- URLs containing credentials/tokens (`https://user:pass@…`, `?token=…`) are
  redacted everywhere except the actual browser navigation.
- Anything visible **on pages** the agent visits (including secrets the app
  itself displays) can end up in model context, screenshots, and reports.
  Point this tool at staging environments with non-production data.

## CI/CD usage

- Run `persona-testing run` and `persona-testing check` in a job **without**
  publishing credentials or cloud OIDC privileges.
- Pin the personas directory to a trusted ref; do not run persona files from
  untrusted pull requests.
- The npm publish workflow separates an unprivileged build job from the
  OIDC-privileged publish job, which only publishes a prebuilt tarball and
  never runs dependency lifecycle scripts.

## Reporting a vulnerability

Open a GitHub issue (or a private security advisory on the repository) at
https://github.com/AshitaOrbis/persona-testing.
